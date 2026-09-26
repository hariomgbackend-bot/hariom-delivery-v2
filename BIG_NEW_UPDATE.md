# BIG NEW UPDATE — Multi-Store + Firebase Auth + Forgot Password + Master Overview

> Saved: July 3, 2026
> Target rollout: ~13-17 days (within 15-day window)
> When asked, read this file and execute Phase 1 onwards.

---

## Overview

This update transforms the DMS from single-store to multi-store while simultaneously migrating admin/accountant authentication to Firebase Auth (with built-in forgot password) and adding a Master Overview Panel.

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Single Tally + GST (multi-user) | No Tally changes needed, one bridge |
| Shared inventory | `inventory_serials` / `inventory_products` — no storeId needed |
| Staff/drivers have primary store, admin can transfer | `storeId` in Firestore doc, admin UI |
| Admin is super-admin — sees everything | `isSuperAdmin: true` in JWT |
| Only admin + accountant migrate to Firebase Auth | Staff/driver/service stay PIN-based (unchanged) |
| `point_of_sale` on deliveries = store identifier | Already exists, reused |
| Existing stores: `Alandi` (store_a) and `Dhanore` (store_b) | Already in accountant.html dropdown |

### What Stays Unchanged

- Staff login (PIN) — `staff.html`, `POST /staff/login`
- Driver login (PIN) — `driver_interface.html`, `POST /driver/verify-pin`
- Service login (PIN) — `service.html`, `POST /service/login`
- bridge.js, watcher.js — no changes
- All PIN/login logic for non-admin roles
- Inventory models (shared across stores)

---

## Phase 1: Backend — Stores Collection + Auth Migration + Accountant CRUD

### 1.1 Create `stores` Firestore collection

**Documents:**

```
stores/store_a:  { code: "store_a", name: "Alandi",  isActive: true }
stores/store_b:  { code: "store_b", name: "Dhanore", isActive: true }
```

Doc ID = store code. `name` = display name matching existing `point_of_sale` values.

### 1.2 New endpoints in `server.js`

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/stores` | GET | Public | Returns active stores `[{ code, name }]` |
| `/api/verify-firebase-token` | POST | — | Accepts Firebase ID token, verifies with Admin SDK, looks up `staff_users`, issues our JWT with `storeId` + `isSuperAdmin` |
| `/admin/accountants` | GET | Admin | List all accountant users from `staff_users` |
| `/admin/create-accountant` | POST | Admin | Creates Firebase Auth user + `staff_users` doc `{ role: "accountant", name, email, storeId }` |
| `/admin/accountant/:id` | PUT | Admin | Update accountant (storeId, name, active) |
| `/admin/accountant/:id` | DELETE | Admin | Deactivate accountant |
| `/admin/transfer-user` | PUT | Admin | Change staff/driver/accountant storeId |

### 1.3 Modified endpoints in `server.js`

**`POST /admin/login`:**
- Was: bcrypt compare against env vars
- Now: frontend calls Firebase Auth `signInWithEmailAndPassword()` → gets ID token → POSTs to `/api/verify-firebase-token` → server verifies with Firebase Admin SDK → looks up `staff_users` where `role === "admin"` → issues JWT `{ role: "admin", isSuperAdmin: true }`

**`POST /accountant/login`:**
- Same flow, JWT includes `{ role: "accountant", storeId }`

**`POST /verify-token`:** Unchanged (still validates our JWT).

**All GET list endpoints** that need store filtering (~30):

Pattern:
```js
if (req.user.storeId && !req.user.isSuperAdmin) {
  const storeDoc = await getDoc(doc(db, "stores", req.user.storeId));
  const storeName = storeDoc.data().name;
  constraints.push(where("point_of_sale", "==", storeName));
}
```

Affected endpoints: `/deliveries`, `/delivery-counts`, `/service/tickets`, `/leads`, `/driverDeliveries`, `/driverDeliveriesRefresh`, `/driver-payout`, `/driver-outstanding`, `/cloud-invoices`, `/staff`, `/calendar-events`, `/driver-list-public`, `/staff-list-public`, etc.

**Note on unsorted queries:** Wherever a `where()` constraint is added, ensure `orderBy()` matches the composite index.

### 1.4 JWT payload changes

Current: `{ role: "admin" }` or `{ role: "accountant" }`

New:
```js
// Admin:
{ role: "admin", isSuperAdmin: true, email: "admin@..." }

// Accountant:
{ role: "accountant", storeId: "store_a", email: "accountant@..." }
```

The `authorize(["admin"])` middleware checks `req.user.role` — unchanged.
The `authenticate` middleware checks JWT validity — unchanged.

For store filtering, add a new middleware:
```js
function requireStoreAccess(req, res, next) {
  if (req.user.isSuperAdmin) return next(); // admin sees all
  if (req.user.storeId) return next();      // accountant has store
  return res.status(403).json({ error: "No store access" });
}
```

### 1.5 Firestore composite indexes

Create in Firebase Console:

| Collection | Fields | Query use case |
|-----------|--------|----------------|
| `deliveries` | `point_of_sale` ASC, `status` ASC | Filter by store + status |
| `deliveries` | `point_of_sale` ASC, `created_timestamp` DESC | Filter by store + date |
| `deliveries` | `point_of_sale` ASC, `assigned_driver_id` ASC | Filter by store + driver |
| `service_tickets` | `point_of_sale` ASC, `status` ASC | Filter by store + ticket status |
| `leads` | `point_of_sale` ASC, `status` ASC | Filter by store + lead status |
| `cloud_invoices` | `point_of_sale` ASC, `imported` ASC | Filter by store + import status |

### 1.6 Auto-set point_of_sale when missing on create

In `POST /createDeliveries`, `POST /createDelivery`, `POST /service/ticket`, `POST /leads`:

```js
// If no point_of_sale in request body, set from authenticated user's store
if (!data.point_of_sale && req.user.storeId && !req.user.isSuperAdmin) {
  const storeDoc = await getDoc(doc(db, "stores", req.user.storeId));
  data.point_of_sale = storeDoc.data().name;
}
```

---

## Phase 2: Frontend — Login + Forgot Password

### 2.1 `login.html` changes

**Admin/Accountant login section:**
- Replace `fetch("/admin/login")` and `fetch("/accountant/login")` with Firebase Auth:
  1. Import Firebase Auth from firebase.js (or init in login.html)
  2. `signInWithEmailAndPassword(auth, email, password)`
  3. `const idToken = await user.getIdToken()`
  4. `fetch("/api/verify-firebase-token", { method: "POST", body: JSON.stringify({ idToken }) })`
  5. Receive our JWT → store in localStorage → redirect
- Add "Forgot Password?" link below the login button
  - On click: prompt for email → calls `sendPasswordResetEmail(auth, email)` → success toast

**Store selector for accountants:**
After login, if user role is "accountant" and they have a `storeId` in the response, show a store confirmation or auto-redirect. If no `storeId` set yet, show store selection dropdown before redirecting.

**Staff/Driver/Service login:** Unchanged.

### 2.2 `forgot-password.html` (NEW — ~120 lines)

Standalone page:
- Logo/header
- Email input field
- "Send Reset Link" button → calls `sendPasswordResetEmail(auth, email)`
- Success message: "Check your email for the password reset link"
- Link back to login.html
- Tailwind CDN, matches existing design, responsive

---

## Phase 3: Frontend — Panel Updates for Multi-Store

### 3.1 `admin.html`

| Change | Detail |
|--------|--------|
| **Store filter bar** | Top of page: tabs or dropdown "All Stores" / "Alandi" / "Dhanore". Adds `?store=` param to all API calls. Hidden fields for cross-store actions. |
| **Accountants management tab** | New sidebar entry "Accountants". Table: Name, Email, Store, Status, Created. "Add Accountant" button → modal (name, email, password, store). Row actions: "Transfer Store", "Reset Password" (triggers Firebase reset email), "Deactivate". |
| **Staff/Drivers views** | Add Store column (shows `point_of_sale` name). Add "Transfer to Store" action per row. |
| **Deliveries view** | Add Store column + store filter |
| **Service tickets view** | Add Store column + store filter |
| **Leads view** | Add Store column + store filter |

### 3.2 `accountant.html`

| Change | Detail |
|--------|--------|
| **Store indicator** | Badge in header showing current store name |
| **`point_of_sale` dropdown** | Replace `<option value="Alandi">` / `<option value="Dhanore">` with dynamic fetch from `GET /api/stores` |
| **Login flow** | Accountant logs in with email/password (Firebase Auth). Store comes from Firestore profile. |
| **Data scoping** | All list fetches pass `?point_of_sale=<storeName>` to filter results (server-side already enforces it, but defensive) |

### 3.3 `staff.html`

- No login changes (PIN stays the same)
- Staff's `storeId` is read from their `staff_users` doc at login time
- Can be passed in the JWT or fetched from Firestore after login
- Leads, tickets, deliveries auto-filtered to their store
- Inventory view: shows all (shared)

### 3.4 `driver_interface.html`

- No login changes (PIN stays the same)
- Deliveries auto-filtered to driver's store via JWT or lookup

### 3.5 `service.html`

- No login changes (PIN stays the same)
- Tickets auto-filtered to service staff's store

---

## Phase 4: TDL Updates

### 4.1 `Working TDLs/hariom_delivery_final.tdl`

- Same TDL file deployed on both stores' Tally instances
- Store A: ensure `HARIOMFSTOREBRANCH` value = `"Alandi"`
- Store B: ensure `HARIOMFSTOREBRANCH` value = `"Dhanore"`
- Can be hardcoded or set via TDL variable per installation

### 4.2 Tally sync scripts

- Each store's Tally bridge pushes data with correct store branch
- Server maps `point_of_sale` → `storeId` automatically

---

## Phase 5: Migration Script

### `scripts/migrate-multistore.mjs` (NEW)

One-time script:

```js
// 1. Seed stores collection
await setDoc(doc(db, "stores", "store_a"), { code: "store_a", name: "Alandi", isActive: true });
await setDoc(doc(db, "stores", "store_b"), { code: "store_b", name: "Dhanore", isActive: true });

// 2. Add storeId to existing staff_users (where role is staff/service)
//    Default: "store_a". If point_of_sale in their data, match to store code.

// 3. Add storeId to existing drivers (same logic)

// 4. Ensure deliveries all have point_of_sale set (default "Alandi" if missing)

// 5. Ensure service_tickets have point_of_sale (default "Alandi")

// 6. Ensure leads have point_of_sale (default "Alandi")

// 7. Create Firebase Auth user for admin
//    Prompt for email, or read from .env ADMIN_EMAIL
//    Creates: admin.initializeApp() → auth().createUser({ email, password })

// 8. Create Firebase Auth user for existing accountant(s)
//    Read from staff_users where role === "accountant", or prompt
//    If exists, create Firebase Auth account
```

---

## Phase 6: Master Overview Panel

### `overview.html` (NEW — ~600-800 lines)

Single-page dashboard, admin-only. Accessible from admin sidebar.

**Layout:** Responsive card grid (3-4 cols desktop, 1-2 mobile). Store filter dropdown at top.

**Widgets (top row — real-time counts):**

| Widget | Endpoint Used | Display |
|--------|---------------|---------|
| Deliveries Today | `/delivery-counts?store=X` | Total, Delivered, Failed, Pending, Loaded |
| Today's Sales | `/api/sales/today` | Sales count, total amount, products sold |
| Service Tickets | `/service/tickets?store=X` | Open, In Progress, Stale (>48h) |
| Inventory Alert | `/inventory/anomalies` | Products with missing serials, total stock |
| Active Drivers | `/drivers` | Active count, unassigned deliveries |
| Active Staff | `/staff` | Active count, today's leads created |
| Freight Outstanding | `/driver-outstanding` | Total unpaid freight amount |
| Storage | `/storage/stats` | Photo count, total size MB |
| Tally Status | `/tally/products` | Products count, last sync time |

**Bottom row — quick links:**
Buttons linking to: admin.html, accountant.html, staff.html, stock.html, service.html, analytics.html

**Auto-refresh:** Every 60 seconds via `setInterval`. Manual refresh button.

**Auth:** Only users with `isSuperAdmin: true` can access. Redirect others to their role panel.

---

## Implementation Order

```
Week 1 (Days 1-5):
├── Phase 1: Backend (stores + Firebase Auth + accountant CRUD)
│   ├── Day 1: /api/stores, stores collection, JWT changes
│   ├── Day 2: /api/verify-firebase-token, rewrite login endpoints
│   ├── Day 3: Store filtering on all GET endpoints (~30 files changed in server.js)
│   ├── Day 4: Accountant CRUD endpoints, Firestore indexes
│   └── Day 5: Auto-set point_of_sale on creates, testing
│
├── Phase 2: Login + Forgot Password
│   ├── Day 2 (parallel): forgot-password.html
│   └── Day 5 (parallel): login.html Firebase Auth rewrite

Week 2 (Days 6-10):
├── Phase 3: Frontend Panel Updates
│   ├── Day 6-7: admin.html (store filter, accountants tab, staff/driver transfer)
│   ├── Day 8: accountant.html (dynamic store dropdown, store indicator)
│   ├── Day 9: staff.html, driver_interface.html, service.html (store scoping)
│   └── Day 10: Testing across all panels

Week 2-3 (Days 10-17):
├── Phase 4: TDL updates (Day 10, 0.5 day)
├── Phase 5: Migration script + deploy (Day 11)
├── Phase 6: Master Overview Panel (Days 12-13)
├── Buffer: Store B integration + testing (Days 14-17)
```

---

## Files Changed/Summary

| File | Action | Description |
|------|--------|-------------|
| `server.js` | Modify | ~100+ line additions across: login rewrites, store filtering, accountant CRUD, verify-firebase-token, api/stores |
| `login.html` | Modify | Firebase Auth integration, forgot password link |
| `forgot-password.html` | **NEW** | Firebase Auth sendPasswordResetEmail |
| `admin.html` | Modify | Store filter, accountants tab, transfer actions, store columns |
| `accountant.html` | Modify | Dynamic point_of_sale dropdown, store indicator header |
| `staff.html` | Modify | Store-scoped data fetching |
| `driver_interface.html` | Modify | Store-scoped deliveries |
| `service.html` | Modify | Store-scoped tickets |
| `overview.html` | **NEW** | Master Overview Panel (admin) |
| `scripts/migrate-multistore.mjs` | **NEW** | Migration script |
| `Working TDLs/hariom_delivery_final.tdl` | Modify | Store-specific HARIOMFSTOREBRANCH per installation |
| `firebase.js` | Possibly | Ensure Firebase Auth is initialized (may already be) |

**Files with NO changes:** `bridge.js`, `watcher.js`, `watcher-setup/`, `firestore.js`, `storage.js`, `middleware/sanitize.js`, `package.json`

---

## Rollback Plan

If anything goes wrong during rollout:

1. **Auth revert**: Revert login.html and the two login endpoints in server.js. Admin/accountant go back to env-var bcrypt auth. Firebase Auth users remain valid but unused.
2. **Store filter revert**: Remove `where("point_of_sale", ...)` constraints from GET endpoints. All data shows unfiltered (pre-multi-store behavior).
3. **Git revert**: `git revert <commit-hash>` for the merge commit.
4. **Firestore data**: The `storeId` and `point_of_sale` fields on existing docs are backwards-compatible (values exist, all queries still work without filtering by them).

---

## Context for Future AI Sessions

When you read this file, you have full context for the "BIG NEW UPDATE". Start implementing Phase 1 in order. Key reference points:

- Existing `point_of_sale` field on deliveries already stores "Alandi" or "Dhanore"
- Accountant.html already has hardcoded `<select id="point_of_sale">` with both stores
- Staff/driver/service auth stays PIN-based (no changes)
- Admin/accountant login moves to Firebase Auth
- Forgot password uses Firebase's built-in `sendPasswordResetEmail()` — free on Blaze
- Master Overview Panel is admin-only, built after multi-store is working
- Inventory is shared between stores (no storeId on inventory collections)
