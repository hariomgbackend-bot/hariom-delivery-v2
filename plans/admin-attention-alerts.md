# Admin Attention Alerts — Implementation Plan

> Status: **PLANNED (not yet implemented)**. All decisions below are locked with the user.
> Context: extend the earlier UI/UX + loading-speed work with a proactive "attention" mechanism
> for the admin: stale pending/loaded deliveries, unlogged service tickets, expiring leads, etc.
> Surfaced as (1) an in-app admin bell, (2) phone push notifications (FCM), and (3) click-to-WhatsApp forward.

---

## Goal
Surface items needing admin action as alerts:
- Deliveries **pending/booked** too long
- Deliveries **loaded but not delivered** too long
- Service tickets **unlogged** (new/open)
- **Leads expiring** / stale open
- (+ recommended extras, see Thresholds)

Delivered to: **in-app admin bell + dropdown**, **phone push (FCM) to Admins**, and **click-to-WhatsApp forward** to the admin's configured number.

---

## Decisions (locked)
- **Recipients (push):** Admins (new `settings/admin` token channel). Also send to existing **Accountant** channel (`settings/accountant`) as a fallback for immediate coverage (can be dropped later). No driver/service pushes.
- **Web bell:** YES — build the in-app admin bell + dropdown (polling `GET /admin/attention`).
- **WhatsApp:** **Click-to-WhatsApp** (open `wa.me/<number>?text=<summary>`). NOT automated Cloud API send (requires `WHATSAPP_PHONE_NUMBER_ID` env + approved Meta template — deferred).
- **WhatsApp recipient:** Admin's WhatsApp number, configured via a new admin settings field.

---

## Backend — `server.js`

### 1. `computeAttention()` helper
Single source of truth. Returns structured items + counts. Store-scoped where relevant.
- Thresholds (tunable `const`s):
  - `PENDING_HOURS = 12` → deliveries `status` in (`booked`,`pending`) older than 12h
  - `LOADED_HOURS = 6` → deliveries `status === "loaded"` not delivered > 6h
  - `TICKET_HOURS = 2` → tickets `status` in (`new`,`open`) with `logged_at` null > 2h
  - `EXPIRE_SOON_DAYS = 2` → leads `expires_at` within 2 days
  - `LEAD_STALE_DAYS = 7` → leads `status` in (`open`,`followup`) older than 7d
- Recommended extras: failed deliveries, urgent/overdue deliveries, out-of-stock inventory, self-pickup awaiting confirmation too long, booked-too-long.
- Timestamps: deliveries use `created_timestamp`; tickets/leads use `created_at` (Firestore `Timestamp`, compare `.seconds`). Use `Timestamp.fromMillis(Date.now() - N*864e5)` for range queries (mirror existing stale-ticket CRON).

### 2. `GET /admin/attention`
- Auth + `authorize(["admin","accountant"])` + `addStoreFilter` (mirror `/delivery-counts`).
- Returns `{ summary:{...counts, total}, deliveries:[…≤10], tickets:[…≤10], leads:[…≤10] }`.

### 3. `sendAdminPush(title, body)`
- Mirror `sendAccountantPush` (server.js ~1516); read `pushToken` from `settings/admin`.

### 4. `POST /saveAdminPushToken`
- Mirror `/saveAccountantPushToken` (server.js ~2744); store token at `settings/admin` (`merge: true`).

### 5. `POST /saveAdminSettings` (or extend existing settings save)
- Persist `settings/admin.whatsappForwardNumber` (the WhatsApp forward target).

### 6. Scanner cron (replace line 215 stale-ticket CRON)
- `cron.schedule("*/30 * * * *", …, { timezone: "Asia/Kolkata" })`.
- Calls `computeAttention()`. For any **new** item (id not in `meta/alertedItems` Firestore doc), append to a grouped summary and mark it alerted.
- Sends one grouped `sendAdminPush` (+ `sendAccountantPush` fallback) per scan when there are new items.
- Per-item dedupe via `meta/alertedItems` (survives restarts, no spam).

---

## Frontend — `admin.html`

### 1. FCM registration
- Add Firebase messaging SDK + `firebaseConfig` + `firebase.initializeApp` + `firebase.messaging()` (mirror `accountant.html` ~1653–1714).
- On load: request `Notification.requestPermission()`, `messaging.getToken({ vapidKey: VAPID_KEY, serviceWorkerRegistration })`, `POST /saveAdminPushToken`.
- Handle `messaging.onMessage` (in-app toast when app open).

### 2. Notification bell + dropdown
- Add bell button + count badge + dropdown (`.attn-dropdown`) in `.topbar-right` (admin.html ~1570–1585).
- `loadAttention()`: `fetch GET /admin/attention?store=<adminStoreFilter>`; update badge + dropdown; toast summary when `total` increases (use queued `showToast`); skip when `document.hidden`.
- Poll `setInterval(loadAttention, 60000)` (guarded) + call once on load.
- Dropdown sections: Deliveries / Service Tickets / Leads, each with count + recent items (`.badge`); "View all" → `showView('deliveries'|'service-count'|'leads-admin')`.

### 3. WhatsApp forward
- **Settings field:** "WhatsApp Alert Forwarding" input (phone number) saved to `settings/admin.whatsappForwardNumber` (reuse settings save pattern; place in Links/Settings area).
- **Forward actions:** each alert item + a "Forward all" button → `window.open('https://wa.me/<configuredNumber>?text=' + encodeURIComponent(summary), '_blank')`.

---

## Styles — `design-system.css`
- `.attn-bell`, `.attn-badge`, `.attn-dropdown`, `.attn-section` (design tokens; reuse `.badge`).

---

## Files touched
- `server.js` — `computeAttention`, `GET /admin/attention`, `sendAdminPush`, `POST /saveAdminPushToken`, `POST /saveAdminSettings`, scanner cron + `meta/alertedItems` dedupe.
- `admin.html` — FCM registration, bell UI, `loadAttention()` poll + toast, WhatsApp settings field + forward actions.
- `design-system.css` — notification styles.

All additive (new route / cron / token doc). No Firestore schema changes.

---

## Verification
- Set admin WhatsApp number in settings; seed a pending delivery >12h, an unlogged ticket, an expiring lead.
- Within 30 min: grouped push arrives on admin phone; bell badge shows totals; dropdown lists items; 📲 opens WhatsApp pre-filled to configured number; "View all" jumps to correct view.
- Restart server → already-alerted items do not re-push (dedupe doc).
- Confirm old 9 AM ticket CRON removed (no duplicate alerts).

---

## Out of scope (possible follow-ups)
- Automated WhatsApp Cloud API send (needs `WHATSAPP_PHONE_NUMBER_ID` env + approved Meta template).
- Service-tech / driver push recipients.
- Additional alert categories beyond the recommended extras.
