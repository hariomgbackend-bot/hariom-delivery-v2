# Technical Audit: driver_interface Offline-First Architecture

**Date:** 2026-09-03
**File audited:** `driver_interface.html` + `server.js`

---

## Implementation Status (2026-09-03)

Following this audit, the high-value offline gaps have been implemented:

| Item | Status |
|---|---|
| App-shell caching via the single service worker (`firebase-messaging-sw.js`, precache + network-first navigation + cache-first assets) | ✅ Done |
| Firebase scripts made non-blocking (lazy-loaded after online login) so a cleared-cache offline cold start can boot | ✅ Done |
| Offline delivery detail popup (renders from cached `allDeliveriesData`, no network fetch) | ✅ Done |
| Offline **mark failed** (reason + photo queued to IndexedDB, mirrors loaded/delivered) | ✅ Done |
| PIN-based offline sync fallback on server (`_offline_sync` + `driver_id` + `pin` accepted by mark* endpoints when JWT absent/expired) | ✅ Done |
| Idempotent retry handling (already-delivered/loaded/failed treated as success during offline sync) | ✅ Done |
| Client-supplied `action_timestamp` honored (clamped) so offline capture time is preserved | ✅ Done |
| Conflict guard — a queued `delivered` can no longer be silently overwritten by a queued `failed` (and vice-versa) | ✅ Done |
| Sync stops retrying forever on auth rejection (401/429 → clears action + prompts re-login) | ✅ Done |
| Dispatcher panel offline | ⏸️ Deferred (dispatcher works from office on strong network) |
| Push-triggered background DO caching | ⏸️ Deferred (loading happens at the store where network is strong) |
| Fuzzy/tokenized customer search | ⏸️ Deferred (search already works offline) |

---

## 1. PWA Setup

### Manifest
- `driver-manifest.json` exists at root.
- `start_url: /driver_interface.html`, `display: standalone`, portrait orientation, 2 icon sizes.
- `<link rel="manifest">` at `driver_interface.html:10` correctly points to `/driver-manifest.json`.
- A second generic `manifest.json` also exists (not referenced by driver_interface).
- **Installable on Android** ✅

### Service Worker
- **Only `firebase-messaging-sw.js` is registered** — purpose-built for push notifications (FCM background). Does nothing for offline caching.
- `initServiceWorker()` (line 1942) actively **unregisters** any non-FCM service worker on startup (line 1948).
- **No caching service worker exists.** The app is NOT usable offline via SW cache.

### Static Dependencies
- `/design-system.css?v=2` — required for rendering
- Google Fonts (Inter, JetBrains Mono, Material Symbols) — non-blocking via `media="print" onload`
- `firebase-messaging-sw.js` — push only
- html5-qrcode CDN script — lazy-loaded on first scan, v2.3.8
- `/decode-barcode` — server-side barcode decode endpoint

---

## 2. Firebase Setup

Firebase is used for **one thing: push notifications (FCM messaging)**.

```js
// driver_interface.html:1924-1925
firebase.initializeApp(firebaseConfig);
const messaging = firebase.messaging();
```

- SDK: imported via `firebase-messaging-sw.js` (`firebase 10.12.0`)
- **No Firestore SDK** — no Firestore reads/writes from the driver interface
- **No Firebase Auth** — driver auth handled by custom API server (`server.js`)
- **No Firebase Storage** — photo upload goes to `server.js` API endpoints

All driver data flows through the custom REST API (`server.js`).

---

## 3. All API Endpoints the Driver Interface Calls

| Endpoint | Method | Purpose | Auth |
|---|---|---|---|
| `/driver-list-public` | GET | Populate driver name dropdown | None |
| `/driverDeliveries` | POST | Login: validate PIN + get assigned deliveries | PIN |
| `/driverDeliveriesRefresh` | POST | Background refresh using JWT session token | JWT |
| `/delivery/:id` | GET | Load single delivery detail (detail popup) | JWT |
| `/markLoaded/:id` | POST | Mark delivery as loaded (photo, GPS, serial) | JWT |
| `/markDelivered/:id` | POST | Mark delivery as delivered (photo, GPS, freight) | JWT |
| `/markSelfPickup/:id` | POST | Confirm self-pickup (photo, serial) | JWT |
| `/markFailed/:id` | POST | Report failed delivery (reason, optional photo) | JWT |
| `/assignDelivery/:id` | POST | Dispatcher: assign delivery to a driver | JWT |
| `/saveDriverPushToken` | POST | Register FCM push token | JWT |
| `/decode-barcode` | POST | Server-side barcode decode (iOS fallback) | JWT |

All API calls go to `BASE_URL = window.location.origin` — the Express server (`server.js`).

---

## 4. Driver Workflow / Data

### Delivery Document Fields (Firestore `deliveries` collection)
```
id                      — Firestore doc ID
customer_name           — full name string
phone                   — contact number
address, area           — delivery address
product_name            — product description
product_serial_number    — serial/sticker number
invoice_number          — invoice reference
assigned_driver_id      — driver Firestore doc ID
assigned_driver_name    — driver display name
status                 — pending / loaded / delivered / failed
priority               — "urgent" or null
estimated_delivery_time — ETA timestamp
sale_price             — sale amount
freight_charged        — boolean
freight_amount         — freight collected
is_self_pickup         — boolean
delivery_mode          — "porter" for porter deliveries
driver_instructions     — special instructions text
storeId                — store reference
created_timestamp      — Firestore Timestamp
photo_delivered_url     — delivered photo URL
failure_reason          — failure reason string
failure_photo_url       — failure photo URL
_tally_voucher_number   — Tally voucher reference
_tally_guid            — Tally GUID
```

### Write Flows
| Transition | Payload | Endpoint |
|---|---|---|
| pending → loaded | photo (Blob), GPS (lat/lng), serial number | POST `/markLoaded/:id` |
| loaded → delivered | photo (Blob), GPS (lat/lng), freight amount | POST `/markDelivered/:id` |
| pending/loaded → failed | reason string, optional damage photo | POST `/markFailed/:id` |
| porter confirmation | porter details + photo | POST `/markSelfPickup/:id` |

### Currently Cached
- Delivery list (full objects) → `localStorage["cachedDeliveries"]`
- Session (driver id + name + PIN) → `localStorage["hariom_driver_session"]`
- Photos → IndexedDB `hariom_offline` store as Blobs

---

## 5. Search

**Current implementation** (`filterDeliveryCards`, `driver_interface.html:2280`):

```js
const q = document.getElementById("deliverySearch").value.toLowerCase().trim();
const filtered = allDeliveriesData.filter(d =>
  (d.customer_name && d.customer_name.toLowerCase().includes(q)) ||
  (d.phone && d.phone.includes(q)) ||
  (d.address && d.address.toLowerCase().includes(q)) ||
  (d.product_name && d.product_name.toLowerCase().includes(q))
);
```

- ✅ **100% client-side** — no network request on search
- ✅ Works offline (uses cached `allDeliveriesData`)
- ✅ Phone exact substring match
- ❌ No name tokenization — "John Smith" won't find "Smith, John"
- ❌ No fuzzy matching / typo tolerance
- ❌ Customer data is a flat `customer_name` string — no first/last split fields

**Does it cause Firestore reads?** No. Reads from in-memory `allDeliveriesData` array.

---

## 6. Network Dependency

| Situation | Network Call | Offline Behavior |
|---|---|---|
| App load (driver select) | GET `/driver-list-public` | ✅ Fallback: rebuild select from cached session |
| Unlock (PIN login) | POST `/driverDeliveries` | ✅ Offline PIN validation against cached session |
| View assigned deliveries | POST `/driverDeliveries` | ✅ Shows cached deliveries from `localStorage["cachedDeliveries"]` |
| Open delivery detail | GET `/delivery/:id` | ❌ "Delivery not available offline" |
| Mark loaded / delivered | POST `/mark*` | ✅ Queued offline via `addOfflineAction()` + IndexedDB photos |
| Mark failed | POST `/markFailed` | ❌ **No offline path** — shows "Network error" |
| Silent refresh | POST `/driverDeliveriesRefresh` or `/driverDeliveries` | ✅ Falls back to cache on error |
| Dispatcher panel | GET `/deliveries?store=all` + `/driver-list-public` | ❌ **No offline path** |
| Driver list refresh | GET `/driver-list-public` | ❌ Not cached |
| Barcode scan (iOS) | POST `/decode-barcode` | ✅ Now works (endpoint added 2026-09-03) |

### Critical Offline Gaps
1. **Delivery detail popup** (`openDeliveryPopup`) — fetches via `GET /delivery/:id`; fails with "Delivery not available offline" (line 2460). Driver can see the list but can't open any delivery.
2. **Mark failed** — no offline action path; driver must be online.
3. **Dispatcher panel** — completely online-only.
4. **Driver list refresh** — not cached; offline fallback only works if session was previously saved.
5. **Session token expiry** — JWT expires every 12h. Offline driver can't refresh; after expiry `silentRefresh` forces re-login.

---

## 7. Existing Local Storage / Offline Mechanism

### Implemented

| Mechanism | Key | Used For |
|---|---|---|
| `localStorage` | `hariom_driver_session` | Driver id + name + PIN (offline login) |
| `localStorage` | `hariom_last_driver` | Last selected driver name |
| `localStorage` | `hariom_theme` | Dark/light mode |
| `localStorage` | `cachedDeliveries` | Full delivery list (JSON) |
| `localStorage` | `offlineActions` | Queue of pending delivery actions (JSON) |
| **IndexedDB** `hariom_offline` | `photos` store | Photos as Blobs (keyed `${deliveryId}_${actionType}`) |
| `navigator.onLine` | — | Online/offline detection |
| `window.addEventListener("online")` | — | Triggers `syncPendingActions()` on reconnect |
| `window.addEventListener("offline")` | — | Loads from cache, shows offline indicator |

### Offline Action Sync (`syncPendingActions`, line 1733)
- Queued actions: `loaded`, `delivered`, `selfpickup`
- Photos: fetched from IndexedDB, sent as `multipart/form-data`
- GPS: captured at action time, stored in action record
- Freight/serial: captured at action time
- **Failed actions (`markFailed`): NOT queued** — just shows error
- Retry: `scheduleRetry()` fires every 15s when actions remain
- `isSyncing` flag prevents concurrent sync attempts
- Timestamp-safe removal: only removes entries matching both `id` AND `timestamp` from snapshot

---

## 8. Proposed Minimum Changes

The app already has ~60% of the infrastructure. Missing pieces:

### A. Service Worker for App Shell Caching
**New file:** `sw-driver.js`
**Modify:** `initServiceWorker()` in `driver_interface.html`

- Cache app shell: `driver_interface.html`, `design-system.css`, manifest, icons
- Cache-first for static assets; network-first for API calls
- **Why:** Without this, the app won't even load when offline

### B. Cache Driver List
**Modify:** `loadDrivers()` — save `/driver-list-public` response to `localStorage["cachedDriverList"]`
**Read from cache** when offline (driver select stays populated)

### C. Offline Delivery Detail Popup
**Modify:** `openDeliveryPopup()` — check `allDeliveriesData` first (offline path)
Currently at line 2460: if `!d` (not found locally), shows error. Should find from cached `allDeliveriesData` instead.

### D. Offline Mark Failed
**Modify:** `submitFailure()` — add offline action path (mirror loaded/delivered pattern)
- Store photo in IndexedDB
- Queue action type `"failed"` in `offlineActions`
- `syncPendingActions()` already handles unknown action types gracefully

### E. Dispatcher Panel Offline
**Modify:** `loadDispatcherDeliveries()` — save to cache, read from cache on offline
**Modify:** `syncPendingActions()` — also sync driver assignments (endpoint `/assignDelivery/:id`)

### F. Session Token Refresh When Offline
**Issue:** JWT expires every 12h. Offline driver can't refresh.
**Fix:** Add `/driverDeliveriesOffline` endpoint that accepts `driver_id + PIN` without rate limiting for offline re-entry.

### G. Conflict Resolution
**Problem:** A delivery could be modified by admin while driver is offline.
**Proposed strategy: Last-write-wins with timestamp:**
- Every delivery action stores `localTimestamp: Date.now()` in the queued action
- Server compares `localTimestamp` vs delivery's `updated_timestamp`
- If server is newer → **don't apply action**, return conflict to driver on next sync
- Driver sees: "Delivery was updated by admin while offline — please review and re-submit"

### H. Photo Upload for Offline Actions
**Status:** ✅ Already implemented via IndexedDB + `syncPendingActions()`

### I. Customer Search Enhancement
**Status:** ✅ Already 100% client-side.
**Optional enhancement:** Add name tokenization + fuzzy matching (Fuse.js, ~7KB gzipped):
```js
// "john smith" matches "Smith, John Doe" or "John M Smith"
const terms = q.split(/\s+/).filter(Boolean);
```

---

## Files / Functions That Need Modification

| File | Functions to Change | New Files |
|---|---|---|
| `driver_interface.html` | `initServiceWorker()` (register new SW), `loadDrivers()` (cache driver list), `openDeliveryPopup()` (offline detail), `submitFailure()` (queue offline action), `loadDispatcherDeliveries()` (cache + offline), `syncPendingActions()` (handle failed + assign) | `sw-driver.js` |
| `server.js` | Add `/driverDeliveriesOffline` endpoint (accept PIN for offline re-entry, no rate limit), update `/markFailed/:id` to accept `_offline_sync: true` flag | — |
| `server.js` | Optional: conflict resolution on `markLoaded/MarkDelivered` (compare timestamps) | — |
