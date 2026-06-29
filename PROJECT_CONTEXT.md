# Project Overview

Hariom Delivery is a Delivery Management System (DMS) for a retail electronicsstore (Hariom Electronics). It handles end-to-end delivery lifecycle management withinventory tracking, service ticket generation, and integrates with Tallyaccounting software. Built on Express.js backend with Firebase/Firestore for database/storage and vanilla JS HTML frontends for different user roles.

## Folder Structure

```
hariom-delivery/
├── server.js          # Main Express.js backend (4570 lines)
├── firebase.js       # Firebase client config
├── firestore.js      # Firestore DB instance
├── storage.js       # Firebase Storage instance
├── package.json    # Node.js dependencies
├── *.html          # Frontend UIs for different roles
├── watcher-setup/   # Folder watcher utility
├── icons/          # App icons
└── node_modules/   # Dependencies
```

## File Responsibilities

| File | Responsibility | System |
|------|-------------|--------|
| **server.js** | All backend APIs - auth, deliveries, drivers, staff, inventory, service tickets, leads, invoices, incentives | Backend |
| **driver_interface.html** | Driver login, PIN entry, delivery list, mark loaded/delivered/failed | Frontend (Driver) |
| **staff.html** | Staff login, create deliveries, leads management, stock view | Frontend (Staff) |
| **accountant.html** | Invoice import, DO creation, reports, driver payouts | Frontend (Accountant) |
| **admin.html** | Full system admin - drivers, staff, settings, reports | Frontend (Admin) |
| **service.html** | Service ticket management (installation/complaints) | Frontend (Service) |
| **stock.html** | Inventory management with serial numbers | Frontend (Inventory) |
| **drivers.html** | Driver management interface | Frontend (Driver Mgmt) |
| **analytics.html** | Delivery/service analytics dashboard | Frontend (Analytics) |
| **login.html** | Role-based login router | Frontend (Auth) |
| **firebase.js/firestore.js/storage.js** | Firebase SDK initialization | Config |
| **watcher-setup/watcher.js** | Local file watcher for invoice folder | Scripts |

## Data Flow

### 1. Delivery Creation Flow
```
Accountant uploads invoice (PDF/XML) → /parse-invoice → extracts data
  → accountant.html form → /createDeliveries → Firestore "deliveries" collection
  → Push notification to driver
```

### 2. Delivery Lifecycle
```
pending → driver marks "loaded" (/markLoaded) → status="loaded" + photo
  → driver marks "delivered" (/markDelivered) → status="delivered" + photo
  → auto-creates service ticket for eligible products (AC, WM, Refrigerator 32"+)
```

### 3. Inventory Sync Flow
```
Tally XML export → /parse-tally-xml → /import-xml-stock → "inventory_products" collection
  → staff scans serials → /add-serial → "inventory_serials" collection
  → serial assigned at delivery load time
```

### 4. Service Ticket Flow
```
Auto-created on delivery OR manually created by staff
  → Service team updates status/logs brand tracking
  → Resolved → notification to creator
```

## Key Features

- **Role-based Access Control**: Admin, Accountant, Staff, Driver, Service
- **PIN-based Authentication**: Drivers and Staff (6-digit PIN, brute-force lockout)
- **Delivery Workflow**: Pending → Booked → Loaded → Delivered/Failed with photos
- **Self-Pickup**: Skip loading step, mark directly as delivered
- **Batch Deliveries**: Multiple items per customer, shared freight
- **Driver Payout Tracking**: Freight reconciliation by date
- **Freight Management**: Driver-collected vs accountant-collected tracking
- **Serial Number Tracking**: Inventory with location/status per unit
- **Tally Integration**: XML import, product sync, invoice parsing
- **Cloud Invoices**: Watcher uploads PDFs, parse on server
- **Push Notifications**: Firebase FCM for real-time alerts
- **Service Tickets**: Installation/complaint tracking with brand API integration
- **Leads Management**: Staff-created sales leads with follow-up
- **Incentives**: Staff sales commission tracking
- **Auto-Migration**: Legacy status system upgrade
- **Rate Limiting**: API protection against abuse

## Redundancies / Duplicate Logic

- **Firebase config duplicated**: `firebase.js` and `storage.js` both define the same `firebaseConfig` object (lines 7-15 in firebase.js, lines 4-12 in storage.js)
- **PRODUCT_CATEGORIES list**: Hardcoded twice in `parseInvoiceText()` - once as a Set definition (server.js:2001-2034)
- **Status order sorting**: Similar logic in `/deliveries` and `/leads` endpoints (server.js:995-1026 vs 2597-2602)
- **Duplicate check logic**: `/createDeliveries` has redundant check after idempotency (server.js:789-805)
- **Push token cleanup**: Same stale token detection logic in `sendPushToToken()` (server.js:649-655)
- **Wholesale/retail config**: `validLocations` array duplicated in multiple inventory endpoints

## Unused / Dead Code

- **WhatsApp integration**: `sendWhatsapp()` function is disabled (server.js:609)
- **SMS integration**: `sendSMS()` function is disabled (server.js:631)
- **Legacy import endpoints**: `/service/legacy-import`, `/service/legacy-wipe` were one-time use
- **test files**: `scanner_test.html`, `tally-test.html` - likely debugging leftovers
- **Duplicate HTML in icons/**: `icons/admin.html`, `icons/accountant.html` appear duplicated
- **audit files**: `audit_script.js`, `audit_scripts.js`, `audit.log`, `audit_results.txt` - unused
- **tmp_script.js**, **check_ids.js**: Utility scripts of unclear purpose

## Issues / Weak Points

1. **No index on frequently queried fields**: `deliveries.status`, `deliveries.assigned_driver_id` lacking composite indexes cause slow queries
2. **Large single server.js**: 4570 lines - difficult to maintain, should be split into modules
3. **Hardcoded credentials in source**: ENV vars loaded but service account passed as JSON string (server.js:28)
4. **No input sanitization**: User input directly stored, XSS possible in admin views
5. **Rate limiter bypass potential**: Driver PIN limiter may not cover all endpoints
6. **No database transactions**: Multi-document operations lack atomicity (e.g., batch freight update)
7. **Missing error boundaries**: Frontend HTMLs have no try-catch for API failures
8. **No pagination**: All endpoints return full collections, memory issues at scale
9. **Image storage costs**: No cleanup of old delivery photos, storage grows unbounded
10. **Self-ping keepalive**: External URL environment variable expected but not always set

## Suggestions

### High Priority
1. **Add Firestore indexes**: Create composite indexes for `deliveries` queries (status + assigned_driver_id, status + created_timestamp)
2. **Implement pagination**: Add limit/offset to all list endpoints
3. **Split server.js**: Divide into route modules by domain (deliveries.js, inventory.js, service.js)
4. **Add input validation**: Sanitize all user inputs before storage

### Medium Priority
5. **Setup cron photo cleanup**: Delete photos older than 90 days automatically
6. **Add request logging**: Audit trail for API calls with timestamps
7. **Frontend error handling**: Add toast notifications for failed API calls
8. **Environment validation**: Fail fast if required ENV vars missing

### Low Priority
9. **Migrate to TypeScript**: Add type safety
10. **Database transactions**: Use batch writes for multi-document operations
11. **API versioning**: `/api/v1/` prefix for backward compatibility
12. **Remove dead code**: Clean up test files, legacy imports, unused scripts