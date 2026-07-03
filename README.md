# Hariom Delivery Management System (DMS)

> **Business**: Hariom Electronics (retail electronics store — TVs, ACs, refrigerators, washing machines, etc.)
> **Purpose**: End-to-end delivery lifecycle management with inventory/serial tracking, service ticket generation, Tally Prime accounting integration, role-based staff portals, invoice parsing via AI, and push notifications.
> **Scale**: ~1,100 deliveries and ~1,400 tickets processed since March 2026
> **Hosting**: Render (backend) + Firebase/Firestore (DB, Storage, FCM, Auth)

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                         DEPLOYMENT (Render)                          │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │              server.js (Port 5000) — 6393 lines              │    │
│  │  ┌──────────────────────────────────────────────────────┐   │    │
│  │  │  ALL BACKEND APIs (no routers, monolithic)           │   │    │
│  │  │  Express 5 + helmet + cors + compression + sanitize  │   │    │
│  │  │  Firebase Admin + JWT + bcrypt + rate-limit          │   │    │
│  │  │  AI: Groq SDK + Google Generative AI                 │   │    │
│  │  │  Cron: node-cron (booked→pending flip, stale tickets)│   │    │
│  │  └──────────────────────────────────────────────────────┘   │    │
│  │                                                              │    │
│  │  Serves static HTMLs (vanilla JS, Tailwind CDN, Chart.js)    │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                           │                                          │
└───────────────────────────┼──────────────────────────────────────────┘
                            │
          ┌─────────────────┼─────────────────┐
          ▼                  ▼                  ▼
┌─────────────────┐  ┌────────────────┐  ┌──────────────────────┐
│  Firebase        │  │  Tally Prime   │  │  Shop PC Watcher     │
│  Firestore (DB)  │  │  (Port 9000)   │  │  watcher.js (7788)   │
│  Storage (PDFs)  │  │  ↑↓ bridge.js  │  │  chokidar watches    │
│  FCM (Push)      │  │  (Port 5005)   │  │  InvoiceWatch/       │
│                  │  │  proxies XML   │  │  → Uploads PDFs to   │
│                  │  │  creates GST   │  │  Firebase Storage    │
│                  │  │  SALES vouchers│  │  + Firestore meta    │
└─────────────────┘  └────────────────┘  └──────────────────────┘
```

---

## File Inventory

### Backend

| File | Lines | Description |
|------|-------|-------------|
| `server.js` | 6393 | **Monolithic Express 5 backend.** All APIs: auth, deliveries CRUD, lifecycle (load/deliver/fail/return/reschedule/reverse), drivers, staff, inventory, serial numbers, service tickets, leads, invoice parsing (PDF + Groq AI), Tally sync, cloud invoices, price guide, slabs, categories, brands, calendar events, storage stats, weather, health check, self-ping keepalive. Cron jobs (booked→pending daily flip, stale ticket reminder). Firebase Admin + JWT + bcrypt auth. |
| `bridge.js` | 698 | **Tally Bridge proxy server** (port 5005). Tally XML proxy, live master sync (stock + creditors from Tally), ledgers API (from Firestore gzip cache or local XML file), sales voucher creation (builds GST SALES XML → pushes to Tally), fallback to "CUSTOMER NAME" placeholder ledger + "SALE ITEM" stock item when real ledger/product doesn't exist. |
| `watcher.js` | 258 | **Cloud Invoice watcher** (runs on shop PC). Chokidar watches `C:\HariomDMS\InvoiceWatch`, uploads new PDFs to Firebase Storage, writes Firestore metadata, local Express on port 7788 with DELETE /local-file for backend cron cleanup. |
| `firebase.js` | ~15 | Firebase client SDK init (public config). Used by frontend pages. |
| `firestore.js` | ~5 | `getFirestore(app)` — Firestore DB instance. Imported by server.js. |
| `storage.js` | ~15 | **Redundant** Firebase Storage init (duplicates firebase.js config). |
| `firebase-service-account.json` | — | Firebase Admin SDK private key (gitignored). Used by server.js, bridge.js, watcher.js. |

### Middleware

| File | Description |
|------|-------------|
| `middleware/sanitize.js` | Input sanitization: strips HTML tags/entities, recursively sanitizes objects. Used globally in server.js. |

### Frontend HTMLs (all vanilla JS, Tailwind CDN, inline CSS/JS)

| File | Lines | Role | Description |
|------|-------|------|-------------|
| `login.html` | 317 | Auth | Role-based login → routes to Admin/Accountant/Staff/Driver/Service panels. PIN login for drivers/staff, password for admin/accountant with brute-force lockout. |
| `admin.html` | 7094 | Admin | Full system admin: drivers, staff, price guides, slabs, product categories, brands, models, settings, delivery calendar, cloud invoices, storage admin, analytics, reports. Chart.js, Leaflet maps, XLSX export. |
| `accountant.html` | 6354 | Accountant | Invoice import (PDF/XML), DO creation, delivery tracking, driver payouts, freight reconciliation, cloud invoices, Tally integration, DO from TDL pushes. |
| `driver_interface.html` | 4616 | Driver | PIN login, assigned deliveries list, mark loaded (with photo), mark delivered/failed (with photo), delivery history, payout summary. PWA manifest. |
| `staff.html` | 3171 | Staff | Create deliveries, manage leads, view stock, create service tickets. Ledger picker with "Add New Customer" option. |
| `stock.html` | 3227 | Inventory | Serial number management, product categories, brands/models, location/status tracking, inventory search. |
| `service.html` | 2330 | Service | Service tickets (installations/complaints), assign technicians, track resolution, brand API integration. |
| `analytics.html` | 1888 | Analytics | Delivery metrics, service stats, driver performance, revenue charts, Leaflet maps. |
| `service_analytics.html` | 644 | Analytics | Service-specific analytics: ticket metrics, resolution times, technician performance. |
| `drivers.html` | 534 | Driver Mgmt | View drivers, assign deliveries, track performance. |
| `purchase-ingestion.html` | 1218 | Purchase | Upload/parse purchase invoices (PDF/XML) from suppliers, match products, create purchase vouchers. Fuse.js fuzzy search. |
| `ledger-picker.html` | 241 | Utility | Tally ledger picker widget with Fuse.js fuzzy search. |
| `legacy_import.html` | 435 | Legacy | One-time Excel-based data migration tool. |
| `tally_debug.html` | 631 | Debug | Tally XML payload inspector — send XML to bridge and view response. |
| `tally-test.html` | 337 | Debug | Quick Tally connection test. |
| `scanner_test.html` | 868 | Debug | Barcode/QR scanner test for mobile. |
| `scanner_test_zxing.html` | 754 | Debug | Alternative scanner test using ZXing. |
| `offline.html` | 45 | Offline | PWA offline fallback page. |

### Service Workers & Manifests (PWA)

| File | Description |
|------|-------------|
| `firebase-messaging-sw.js` | FCM service worker for background push notifications. |
| `service-worker.js` | App shell service worker (caches offline.html, manifest, icons). CACHE_NAME: `hariom-dms-v1`. |
| `manifest.json` | Main PWA manifest (driver_interface.html start URL, 8 icon sizes). |
| `driver-manifest.json` | Driver-specific PWA manifest (scoped to driver_interface.html). |
| `staff-manifest.json` | Staff-specific PWA manifest (scoped to staff.html). |

### Tally Integration Files

| File | Description |
|------|-------------|
| `Working TDLs/hariom_delivery_final.tdl` | Active TDL — delivery integration from Tally Gateway. Shortcut: `Ctrl+Alt+Del`. |
| `Working TDLs/SerialNumberTDL.tdl` | TDL for fetching serial numbers from Tally. |
| `Working TDLs/service_ticket.tdl` | TDL for service ticket integration. |
| `Working TDLs/todays_sale.tdl` | TDL for Today's Sales menu in Tally Gateway. |
| `Working TDLs/tally_gateway.tdl` | TDL for Tally Gateway menu customization. |
| `Working TDLs/TDL_Reference_Manual.pdf` | TDL syntax reference. |
| `Working TDLs/AGENTS.md` | Tally integration architecture + server.js 15-file refactor plan. |
| `DO+Ticket.tdl` | 373 lines — Delivery Order + Service Ticket TDL for Tally. |
| `tally_products.json` | 6703 lines — Product names exported from Tally (gitignored). |
| `tallysync/` | Tally XML exports: `Master.xml`, `Master1.xml`, `StkSum.xml`. |

### Shop PC Watcher Setup

| File | Description |
|------|-------------|
| `watcher-setup/watcher.js` | Same as root `watcher.js`, duplicate. |
| `watcher-setup/package.json` | Package config (chokidar, firebase-admin, express, dotenv). |
| `watcher-setup/SETUP.md` | Step-by-step setup guide for deploying watcher on shop PC. |
| `watcher-setup/start-watcher.bat` | Manual start batch file. |
| `watcher-setup/setup-startup.bat` | Adds watcher to Windows Startup. |
| `BridgePackage/Install.bat` | Install Tally Bridge Windows service. |
| `BridgePackage/Uninstall.bat` | Uninstall Tally Bridge Windows service. |
| `BridgePackage/TallyBridge.exe` | Compiled bridge executable. |
| `BridgePackage/TallyDMSService.exe` | Windows service executable. |
| `BridgePackage/TallyDMSService.xml` | Service config XML. |

### Scripts

| File | Description |
|------|-------------|
| `scripts/import-ledgers.mjs` | Extract ledgers from Tally XML, gzip, store in Firestore config. |
| `build.sh` | Build script for Render deployment (Python + npm install). |

### Test / Debug Artifacts (not production)

| Pattern | Description |
|---------|-------------|
| `test-*.mjs` / `test-*.js` | ~15 test scripts: bridge, proxy, gateway, parser, images, Tally connection, sales proxy, HTTP tests. |
| `_test_*.xml` / `_test_*.mjs` | ~50+ XML payloads and test scripts for Tally API features (GST, vouchers, stock, ledgers, proxy). Development artifacts. |
| `_create_masters.xml`, `_create_stock.xml`, `_export_vchtype.xml`, `_ledgers.xml`, `_ping.xml`, `_proxy_test.xml` | More XML test payloads. |

### Configuration & Data

| File | Description |
|------|-------------|
| `package.json` | ESM project. Dependencies: express 5, firebase(-admin), axios, bcrypt, jsonwebtoken, multer, pdf-parse, pdfjs-dist, groq-sdk, @google/generative-ai, node-cron, node-fetch, nodemailer, compression, helmet, cors, dotenv, express-rate-limit, jszip. |
| `.env` | **Gitignored**. Contains: JWT_SECRET, ADMIN_EMAIL/PASSWORD, ACCOUNTANT_PASSWORD, WATCH_FOLDER, WATCHER_PORT, FIREBASE_STORAGE_BUCKET, WATCHER_API_URL, OPENWEATHER_API_KEY, TALLY_PUSH_KEY, GROQ_API_KEY, FIREBASE_SERVICE_ACCOUNT (JSON string). |
| `.gitignore` | Ignores: node_modules/, firebase-service-account.json, .env, tally_products.json, audit.log, audit_results.txt, nul. |
| `invoices/` | Sample invoices: PDFs (Reliance/JioMart), XMLs (Tally exports: LEDGERS.XML, 1Master.xml, Sales_*.xml), WhatsApp images. |
| `icons/` | PWA icons (10 PNGs from 72x72 to 512x512), favicon, apple-touch-icon. |
| `Hariom_Electronics_Sheet.xlsx` | Product/master data spreadsheet. |
| `extraction-report.json` | Sample PDF invoice parse report. |
| `bridge_err.log`, `bridge_out.log` | Bridge runtime logs (not committed). |

---

## Firestore Collections & Schemas

### `deliveries` — Core collection (~1100+ docs)

| Field | Type | Description |
|-------|------|-------------|
| `customer_name` | string | Customer name |
| `phone` | string | Primary phone |
| `alternate_phone` | string | Secondary phone |
| `address` | string | Delivery address |
| `product_name` | string | Product name (UPPERCASE) |
| `product_serial_number` | string | Serial number assigned at load time |
| `invoice_number` | string | Invoice / voucher number |
| `batch_id` | string? | Shared batch ID for multi-item deliveries |
| `status` | string | `pending` / `booked` / `loaded` / `delivered` / `failed` / `returned` / `rescheduled` |
| `estimated_delivery_time` | string (ISO) | ETA datetime |
| `assigned_driver_id` | string | Driver doc ID |
| `assigned_driver_name` | string | Driver name for display |
| `driver_instructions` | string | Delivery notes |
| `freight_charged` | boolean | Whether freight was charged |
| `freight_amount` | string | Freight amount |
| `freight_set_by` | string | Who set freight |
| `is_self_pickup` | boolean | Self-pickup flag |
| `sold_by_id` | string | Staff who sold |
| `sold_by_name` | string | Staff name |
| `sale_price` | number | Product sale price |
| `source` | string | `manual` / `tally_tdl` |
| `point_of_sale` | string | Store branch |
| `pickup_from` | string | Godown name |
| `priority` | string | `normal` or `high` |
| `created_timestamp` | Timestamp | Firestore server timestamp |
| `updated_timestamp` | Timestamp? | Last update |
| `delivered_photo` | string? | Firebase Storage URL |
| `loaded_photo` | string? | Photo at load time |
| `failed_photo` | string? | Photo at fail time |
| `request_id` | string? | Idempotency UUID |
| `delivered_timestamp` | Timestamp? | When delivered |
| `loaded_timestamp` | Timestamp? | When loaded |

### `service_tickets` — Service tickets (~1400+ docs)

| Field | Type | Description |
|-------|------|-------------|
| `customer_name` | string | Customer name |
| `phone` | string | Contact phone |
| `address` | string | Service address |
| `product_name` | string | Product |
| `serial_number` | string | Serial number |
| `type` | string | `installation` / `complaint` |
| `status` | string | `new` / `open` / `in_progress` / `resolved` / `closed` |
| `priority` | string | `low` / `normal` / `high` / `urgent` |
| `description` | string | Issue description |
| `assigned_to` | string? | Technician name |
| `created_by` | string | Creator name |
| `created_at` | Timestamp | Created timestamp |
| `updated_at` | Timestamp | Last update timestamp |
| `brand` | string? | Brand for warranty tracking |
| `invoice_number` | string? | Related invoice |

### `drivers` — Driver profiles

| Field | Type | Description |
|-------|------|-------------|
| `driver_name` | string | Full name |
| `phone` | string | Phone number |
| `pin` | string | bcrypt-hashed 6-digit PIN |
| `pushToken` | string? | FCM push token |
| `is_active` | boolean | Active status |
| `created_timestamp` | Timestamp | Created |

### `staff_users` — Staff profiles

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Full name |
| `phone` | string | Phone |
| `pin` | string | bcrypt-hashed 6-digit PIN |
| `role` | string | `staff` / `service` |
| `pushToken` | string? | FCM token |
| `permissions` | map? | Feature flags |

### `inventory_serials` — Serial number tracking

| Field | Type | Description |
|-------|------|-------------|
| `serial` | string | Serial number |
| `product` | string | Product name |
| `location` | string | `Warehouse` / `Display` / custom |
| `status` | string | `available` / `assigned` / `delivered` |
| `deliveryId` | string? | Linked delivery doc ID |
| `customer` | string? | Customer name if assigned |
| `createdAt` | Timestamp | When added |
| `updatedAt` | Timestamp | Last update |

### `inventory_products` — Product inventory summary

| Field | Type | Description |
|-------|------|-------------|
| `product` | string | Product name |
| `originalName` | string | Original name from Tally XML |
| `normalizedKey` | string | Normalized for matching |
| `category` | string | Product category |
| `tallyQty` | number | Quantity in Tally |
| `systemQty` | number | Quantity in DMS (serials count) |
| `missing` | number | tallyQty - systemQty |
| `displayName` | string? | User-friendly name override |
| `lastImport` | Timestamp | Last XML import |

### `inventory_locations` — Location names

| Field | Type |
|-------|------|
| `name` | string |

### `leads` — Sales leads

| Field | Type |
|-------|------|
| `customer_name`, `phone`, `address` | strings |
| `product`, `notes` | strings |
| `status` | string (`new`/`contacted`/`converted`/`closed`) |
| `created_by`, `assigned_to` | strings |
| `created_timestamp`, `updated_timestamp` | Timestamps |

### Other collections

| Collection | Purpose |
|-----------|---------|
| `products` | Product name list |
| `makes` | Brand/manufacturer names |
| `models` | Product model names |
| `brands` | Brand tracking for service |
| `categories` | Product categories |
| `price_guide` | Pricing (MRP, MOP, MSP per product) |
| `slabs` | Incentive slabs |
| `calendar_events` | Staff leave/notes/agenda |
| `cloud_invoices` | Watcher-uploaded invoice metadata |
| `settings` | System settings (msp-global, etc.) |
| `system_config` | Sync settings (`system_config/sync`) |
| `tally_products` | Tally product index (`tally_products/index`) |
| `config` | Ledgers cache (`config/ledgers` — gzip-compressed) |

---

## API Endpoints

### Auth
| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/admin/login` | POST | — | Admin password login |
| `/accountant/login` | POST | — | Accountant password login |
| `/staff/login` | POST | — | Staff PIN login |
| `/service/login` | POST | — | Service team PIN login |
| `/driver/verify-pin` | POST | — | Driver PIN login |
| `/verify-token` | POST | token | Verify JWT validity |

### Deliveries
| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/createDelivery` | POST | — | Create single delivery |
| `/createDeliveries` | POST | — | Create batch deliveries (shared + products array) |
| `/deliveries` | GET | — | List deliveries (query params: status, phone, date, etc.) |
| `/delivery-counts` | GET | admin/accountant | Counts by status |
| `/delivery/:id` | GET | — | Get single delivery |
| `/delivery/:id` | PUT | — | Update delivery |
| `/delivery/:id` | DELETE | admin | Delete delivery |
| `/deleteFailedDelivery/:id` | POST | accountant/admin | Delete failed delivery |
| `/assignDelivery/:id` | POST | — | Assign driver |
| `/correctDelivery/:id` | POST | admin | Edit delivery details (with photo) |
| `/markLoaded/:id` | POST | — | Mark loaded (photo upload) |
| `/markDelivered/:id` | POST | — | Mark delivered (photo upload) |
| `/markFailed/:id` | POST | — | Mark failed (photo upload) |
| `/markReturned/:id` | POST | admin/accountant | Mark returned |
| `/markSelfPickup/:id` | POST | — | Mark self-pickup delivered (photo) |
| `/rescheduleDelivery/:id` | POST | admin/accountant | Reschedule ETA |
| `/reverseDelivery/:id` | POST | admin/accountant | Reverse to pending |
| `/markFreightPaid/:id` | POST | admin | Mark freight collected |

### Drivers
| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/addDriver` | POST | admin | Create driver |
| `/drivers` | GET | admin | List drivers |
| `/driver/:id` | PUT | admin | Update driver |
| `/driver/:id` | DELETE | admin | Delete driver |
| `/driver-list-public` | GET | — | Public driver list |
| `/driverDeliveries` | POST | — | Driver's assigned deliveries (PIN) |
| `/driverDeliveriesRefresh` | POST | driver | Refresh driver deliveries |
| `/driver-payout` | GET | admin | Payout report by date |
| `/driver-outstanding` | GET | admin | Outstanding freight |
| `/saveDriverPushToken` | POST | driver | Save FCM token |

### Staff
| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/addStaff` | POST | admin | Create staff |
| `/staff` | GET | admin | List staff |
| `/staff/:id` | PUT | admin | Update staff |
| `/staff/:id` | DELETE | admin | Delete staff |
| `/staff-list-public` | GET | — | Public staff list |
| `/staff-weekly-off` | GET | — | Weekly off schedule |
| `/staff-permissions` | GET | admin/staff | Get permissions |
| `/staff-permissions` | PUT | admin | Update permissions |

### Leads
| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/leads` | GET | admin/accountant/staff/service | List leads |
| `/leads` | POST | admin/accountant/staff | Create lead |
| `/leads/:id` | PUT | admin/accountant/staff | Update lead |
| `/leads/:id` | DELETE | admin | Delete lead |

### Service Tickets
| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/service/tickets` | GET | all roles | List tickets |
| `/service/ticket` | POST | all roles | Create ticket |
| `/service/ticket/:id` | PUT | admin/service/accountant | Update ticket |
| `/service/ticket/:id` | DELETE | admin/service | Delete ticket |
| `/api/ticket-status` | GET | admin/staff/service | Ticket status summary |
| `/service/search` | GET | all roles | Search tickets |
| `/service/legacy-import` | POST | admin | One-time legacy import |
| `/service/legacy-wipe` | DELETE | admin | Wipe legacy data |
| `/service/legacy-import-cleanup` | DELETE | admin | Cleanup after import |

### Tally Integration
| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/tally/voucher` | POST | TALLY_PUSH_KEY | Accept TDL voucher push (XML or JSON) → auto-create DO |
| `/tally/ticket` | POST | TALLY_PUSH_KEY | Accept TDL ticket push → auto-create service ticket |
| `/tally/invoices` | POST | accountant/admin | Proxy to Tally Day Book |
| `/tally/pending` | POST | accountant/admin | Store bridge-pushed invoice in memory |
| `/tally/pending` | GET | accountant/admin | List pending invoices |
| `/tally/pending/:invoice_number` | DELETE | accountant/admin | Remove pending invoice |
| `/tally/debug` | GET | — | Latest Tally payload received |
| `/tally/debug/history` | GET | — | Last 20 Tally payloads |
| `/tally/debug/history` | DELETE | — | Clear debug history |
| `/tally/products` | GET | — | List Tally products from cache |
| `/tally/serials/:invoiceNumber` | GET | — | Get serials for invoice |
| `/tally/serials` | GET | — | All serials |
| `/tally/products/sync` | POST | accountant/admin | Sync products from Tally |
| `/tally/products/add` | POST | all roles | Add product to Tally |
| `/tally/test` | GET | — | Test Tally connection |
| `/api/sales/today` | GET | — | Today's sales (leads) with products + prices |
| `/api/sales/today-ui` | GET | — | Today's sales HTML page |
| `/api/tally-proxy` | POST | — | Proxy XML to Tally (CORS bypass) |
| `/sync-tally` | GET | admin/accountant | Trigger Tally XML → Firestore sync |

### Inventory
| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/add-serial` | POST | — | Add serial number |
| `/transfer-serial` | POST | — | Transfer serial between locations |
| `/assign-serial-to-delivery` | POST | — | Assign serial to delivery |
| `/update-serial-status` | POST | — | Update serial status/location |
| `/inventory` | GET | — | List all serials |
| `/inventory/stock-summary` | GET | — | Grouped stock by product |
| `/inventory/anomalies` | GET | — | Missing/extra serials |
| `/inventory/locations` | GET | — | List locations |
| `/inventory/locations` | POST | — | Create location |
| `/inventory/locations/:id` | DELETE | — | Delete location |
| `/inventory/products/:docId/rename` | PUT | — | Rename product display name |
| `/inventory/product-names` | GET | — | Product name mappings |
| `/inventory/sync-settings` | GET | — | Get auto-sync settings |
| `/inventory/sync-settings` | PUT | admin/accountant | Update auto-sync |
| `/parse-tally-xml` | POST | — | Parse Tally XML stock export |
| `/import-xml-stock` | POST | — | Import parsed XML into inventory_products |
| `/transfer-by-product` | POST | — | Bulk transfer by product + qty |
| `/products` | GET | — | Product names list |
| `/products` | POST | — | Add product name |
| `/product/normalize` | POST | admin | Normalize product names |
| `/makes` | GET/POST | — | Brand makes CRUD |
| `/models` | GET/POST | — | Product models CRUD |

### Invoice Parsing
| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/parse-invoice` | POST | accountant/admin | Upload + parse invoice PDF |
| `/api/extract-invoice` | POST | — | Extract invoice data (Groq AI) |
| `/transliterate` | POST | — | Transliterate text (Hindi→English) |
| `/cloud-invoices` | GET | accountant/admin | List unimported cloud invoices |
| `/cloud-invoices/check-duplicate/:invoiceNo` | GET | accountant/admin | Check if invoice number exists |
| `/cloud-invoices/parse` | POST | accountant/admin | Parse cloud invoice PDF |
| `/cloud-invoices/mark-imported` | POST | accountant/admin | Mark invoice as imported |
| `/cloud-invoices/file/:id` | GET | accountant/admin | Download cloud invoice PDF |

### Storage / Admin
| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/storage/stats` | GET | admin | Firebase Storage usage stats |
| `/storage/range-stats` | GET | admin | Storage stats by date range |
| `/storage/download-zip` | GET | admin | Download photos as ZIP |
| `/storage/cleanup` | POST | admin | Delete old photos |

### Pricing / Config
| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/price-guide` | GET/POST | — | Price guide CRUD |
| `/price-guide/bulk` | POST | admin/accountant | Bulk price import |
| `/price-guide/msp-global` | GET | — | Global MSP toggle |
| `/price-guide/msp-global` | PUT | admin/accountant | Set global MSP |
| `/price-guide/:id` | PUT/DELETE | — | Single price guide item |
| `/slabs` | GET/POST | — | Incentive slabs CRUD |
| `/slabs/:id` | PUT/DELETE | — | Single slab |
| `/categories` | GET/POST | — | Categories CRUD |
| `/categories/:id` | PUT/DELETE | — | Single category |
| `/brands` | GET/POST | — | Brands CRUD |
| `/brands/:id` | PUT/DELETE | — | Single brand |
| `/calendar-events` | GET/POST | — | Calendar events CRUD |
| `/calendar-events/:id` | PUT/DELETE | — | Single event |

### Utility
| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | — | Health check (plain text "OK") |
| `/weather` | GET | — | Current weather (Delhi, mock if no API key) |
| `/test-fetch` | GET | — | Connectivity test |

### Push Tokens
| Endpoint | Method | Auth |
|----------|--------|------|
| `/saveAccountantPushToken` | POST | driver |
| `/saveDriverPushToken` | POST | driver |
| `/saveServicePushToken` | POST | — |

---

## Data Flows

### Delivery Lifecycle

```
accountant.html → /createDeliveries → Firestore "deliveries" (status: "booked")
    ↓ (next day 6 AM IST, cron flips booked→pending)
status: "pending"
    ↓ driver scans, presses "Loaded"
/markLoaded/:id  → status: "loaded"  + photo → serial assigned → inventory update
    ↓ driver delivers
/markDelivered/:id → status: "delivered" + photo → auto-create service ticket
    (for ACs, washing machines, refrigerators 32"+)
    ↓ OR
/markFailed/:id → status: "failed" + photo
```

### Invoice Ingestion (two paths)

**Path 1 — Shop PC Watcher:**
```
watcher.js (chokidar) detects new PDF in C:\HariomDMS\InvoiceWatch\
    → uploads to Firebase Storage (cloud_invoices/)
    → writes Firestore metadata (cloud_invoices collection)
    → accountant sees in accountant.html → /cloud-invoices/parse
        → pdf-parse extracts text → Groq AI parses → form pre-filled
        → /createDeliveries
```

**Path 2 — Manual Upload:**
```
accountant.html → /parse-invoice (multer PDF upload)
    → pdf-parse + Groq AI → returns parsed data
    → accountant reviews → /createDeliveries
```

### Tally → DMS (Sync)

```
Tally XML Export (from Tally Prime)
    → bridge.js proxies to server.js
    → /parse-tally-xml (extract products + quantities)
    → /import-xml-stock (update inventory_products)
    → Ledgers via LEDGERS.XML → scripts/import-ledgers.mjs → Firestore config/ledgers
    → /sync-tally endpoint for manual trigger
```

### DMS → Tally (Voucher Push)

```
server.js /api/sales/today → bridge.js gets today's sales
    → buildSalesVoucherXML() generates GST SALES voucher XML
    → pushVoucherToTally() sends to Tally (port 9000)
    → If real ledger not found:
        → fallback: "CUSTOMER NAME" placeholder + "SALE ITEM" + details in narration
    → If grand total has paise → ROUNDING OFF ledger entry
```

### Tally TDL Push (direct auto-create from Tally)

```
Tally Gateway button → HTTP Post to server.js /tally/voucher
    → XML contains: voucher number, customer, items, prices
    → Idempotency check (by invoice_number + source=="tally_tdl")
    → Creates DO(s) directly in Firestore
    → Default ETA: now+3h (or next day 11:30 AM if past 7PM IST)
    → Default driver: "Unassigned"
    → Same flow for tickets via /tally/ticket
```

---

## Key Features

- **Role-based Access**: Admin, Accountant, Staff, Driver, Service — each with distinct UI
- **PIN Authentication**: 6-digit PIN with brute-force lockout, bcrypt hashed
- **Delivery Workflow**: Booked → Pending → Loaded → Delivered/Failed/Returned/Rescheduled
- **Self-Pickup**: Skip loading, mark directly as delivered
- **Batch Deliveries**: Multiple items per customer, shared freight
- **Serial Number Tracking**: Add/transfer/assign serials per product per location
- **Tally Integration**: Bidirectional — XML import for stock, HTTP push for voucher creation
- **Invoice Parsing**: PDF upload → pdf-parse + Groq AI/Google Gemini → auto-filled form
- **Cloud Invoices**: Shop PC watcher auto-uploads PDFs to cloud
- **Push Notifications**: Firebase FCM for delivery assignments, ticket updates
- **Service Tickets**: Auto-created for eligible products, manual creation, brand tracking
- **Leads Management**: Sales leads with follow-up tracking
- **Price Guide**: MRP/MOP/MSP per product with slab-based incentives
- **Driver Payout**: Freight reconciliation with outstanding tracking
- **Calendar**: Staff leave, notes, agendas with role-based visibility
- **Rate Limiting**: Per-endpoint rate limits (writeLimiter, readLimiter, pinLimiter, adminLoginLimiter)
- **Self-Ping Keepalive**: Prevents Render free tier from sleeping (9 AM - 10 PM, 5 min interval)
- **Cron Jobs**: Booked→pending daily flip (6 AM IST), stale ticket reminders (9 AM IST, 48h threshold)

---

## Deployment & Environment

### Production (Render)
- **URL**: `https://hariom-delivery.onrender.com`
- **Deploy**: `git push origin dev` (auto-deploy from dev branch)
- **Server**: `server.js`, port 5000, Express 5
- **Keepalive**: Self-pings `/health` every 5 min via `RENDER_EXTERNAL_URL`

### Local Development
- **server.js**: port 5000
- **bridge.js**: port 5005 (must be running for Tally features)
- **Tally Prime**: port 9000
- **watcher.js**: port 7788

### Environment Variables (`.env`)
```
JWT_SECRET=...
ADMIN_EMAIL=...
ADMIN_PASSWORD=...
ACCOUNTANT_PASSWORD=...
WATCH_FOLDER=C:\HariomDMS\InvoiceWatch
WATCHER_PORT=7788
FIREBASE_STORAGE_BUCKET=hariom-delivery.firebasestorage.app
WATCHER_API_URL=http://localhost:7788
OPENWEATHER_API_KEY=...
TALLY_PUSH_KEY=...
GROQ_API_KEY=...
FIREBASE_SERVICE_ACCOUNT={...}      # JSON string of service account
```

### Bridge Endpoints (port 5005)
| Endpoint | Description |
|----------|-------------|
| `GET /api/sync-tally` | Live sync products + suppliers from Tally (30-min cache) |
| `GET /api/ledgers` | List ledgers from Firestore gzip cache or local XML |
| `POST /api/ledgers/refresh` | Reload ledgers from source |
| `GET /api/ledgers/tdl-sync` | Sync new ledgers from export file |
| `GET /api/create-sales-voucher?customerName=X` | Create GST SALES voucher |
| `POST /api/create-sales-voucher` | Same, POST with XML/JSON body |
| `GET/POST /api/tdl-trigger-voucher` | TDL-triggered voucher creation |
| `GET /api/tdl-create-by-id?id=X` | Background voucher creation by DMS ID |
| `GET /api/tally/todays-sales` | Today's sales for TDL popup |
| `POST /api/test-tally` | Test voucher with hardcoded data |
| `POST /api/open-browser` | Opens /api/sales/today-ui in browser |
| `POST /api/tally-proxy` | XML proxy to Tally |

---

## Known Technical Debt & Issues

1. **Monolithic server.js** (6393 lines) — should be split into ~15 modules (plan in `Working TDLs/AGENTS.md`)
2. **No pagination** — all list endpoints return full collections, memory issues at scale
3. **No Firestore composite indexes** — frequent queries (status + driver_id, status + date) are slow
4. **Firebase config duplicated** — `firebase.js` vs `storage.js` both define identical `firebaseConfig`
5. **~50+ test artifact files** cluttering root (`_test_*.xml`, `_test_*.mjs`, etc.)
6. **WhatsApp disabled** — `sendWhatsapp()` is called but returns early (no API key)
7. **SMS disabled** — `sendSMS()` uses Fast2SMS but is effectively disabled
8. **Service account in env var** — `process.env.FIREBASE_SERVICE_ACCOUNT` as JSON string (security concern)
9. **No input validation on all endpoints** — sanitization exists but partial
10. **No database transactions** — multi-document operations lack atomicity
11. **Missing error boundaries in frontends** — HTML pages lack try-catch for API failures
12. **Photo storage unbounded** — no cleanup of old delivery photos
13. **Duplicate code** — PRODUCT_CATEGORIES list hardcoded twice, push token cleanup logic repeated
14. **Legacy endpoints** — `/service/legacy-import`, `/service/legacy-wipe` were one-time use

---

## Tally Integration Details

### Fallback Strategy (voucher creation)
```
1. Try real customer ledger + real stock item + "Showroom" godown
2. If fails → retry with "CUSTOMER NAME" placeholder ledger + "SALE ITEM" + real name in description
3. If still fails → report error (ledger probably doesn't exist in Tally)
```

### Voucher XML Structure
```xml
<ENVELOPE>
  <VOUCHER VCHTYPE="Purchase" ACTION="Create">
    <VOUCHERTYPENAME>GST SALES</VOUCHERTYPENAME>
    <VOUCHERNUMBER>DMSPUSH-{timestamp}</VOUCHERNUMBER>
    <PARTYLEDGERNAME>{customer or "CUSTOMER NAME"}</PARTYLEDGERNAME>
    <ALLINVENTORYENTRIES.LIST>  <!-- per product -->
      <STOCKITEMNAME>{real or "SALE ITEM"}</STOCKITEMNAME>
      <RATE>{taxablePrice}/NOS</RATE>
      <GODOWNNAME>Showroom</GODOWNNAME>
    </ALLINVENTORYENTRIES.LIST>
    <LEDGERENTRIES.LIST>  <!-- Party -->
      <LEDGERNAME>{customer}</LEDGERNAME>
      <AMOUNT>-{roundedGrandTotal}</AMOUNT>
    </LEDGERENTRIES.LIST>
    <LEDGERENTRIES.LIST>  <!-- CGST 9% -->
      <LEDGERNAME>OUTPUT CGST 9%</LEDGERNAME>
    </LEDGERENTRIES.LIST>
    <LEDGERENTRIES.LIST>  <!-- SGST 9% -->
      <LEDGERNAME>OUTPUT SGST 9%</LEDGERNAME>
    </LEDGERENTRIES.LIST>
    <!-- ROUNDING OFF ledger if grandTotal has paise -->
    <NARRATION>Customer, Phone, Alt Phone, Address, Sold by</NARRATION>
  </VOUCHER>
</ENVELOPE>
```

### Prerequisites in Tally
- Ledger: `CUSTOMER NAME` (placeholder for unknown customers)
- Stock Item: `SALE ITEM` (placeholder for unrecognized products)
- Godown: `Showroom` (must exist)
- Ledgers: `OUTPUT CGST 9%`, `OUTPUT SGST 9%`, `GST SALES @ 18%`, `ROUNDING OFF`
- Voucher Type: `GST SALES`

---

## Recent Work Completed

| Date | Change | Files |
|------|--------|-------|
| Jul 2026 | Voucher fallback: retry with "CUSTOMER NAME" placeholder when ledger missing | `bridge.js` |
| Jul 2026 | Unique voucher numbers: `DMSPUSH-{Date.now()}` instead of hardcoded | `bridge.js` |
| Jul 2026 | GST calc fix: per-product taxable = round(inclusivePrice/1.18), CGST+SGST split | `bridge.js` |
| Jul 2026 | ROUNDING OFF ledger when grand total has paise | `bridge.js` |
| Jul 2026 | Narration: Customer, Phone, Alt Phone, Address, Sold by (items removed) | `bridge.js` |
| Jul 2026 | Stock item fallback: "SALE ITEM" with real name in BASICUSERDESCRIPTION | `bridge.js` |
| Jul 2026 | Godown: always "Showroom" (removed non-existent "Main Location") | `bridge.js` |
| Jul 2026 | staff.html: ledger picker "Add as new customer" option | `staff.html` |
| Jul 2026 | staff.html: product input em dash fix | `staff.html` |
| Jul 2026 | `/api/sales/today`: added `alternate_phone` to response | `server.js` |
| Jul 2026 | TDL shortcut: changed to `Ctrl+Alt+Del` | `hariom_delivery_final.tdl` |
| Jul 2026 | Refactor plan: 15-file modularization documented | `Working TDLs/AGENTS.md` |

---

## Relevant Files Quick Reference

| Need | File |
|------|------|
| Core backend APIs | `server.js` |
| Tally voucher creation | `bridge.js` |
| Invoice watcher (shop PC) | `watcher.js` (or `watcher-setup/watcher.js`) |
| Tally TDL files | `Working TDLs/` |
| Tally architecture + refactor plan | `Working TDLs/AGENTS.md` |
| Input sanitization | `middleware/sanitize.js` |
| Firebase client config | `firebase.js` |
| Firestore instance | `firestore.js` |
| Firebase Storage | `storage.js` |
| Admin panel | `admin.html` |
| Accountant panel | `accountant.html` |
| Driver mobile UI | `driver_interface.html` |
| Staff panel | `staff.html` |
| Stock/inventory UI | `stock.html` |
| Service ticket UI | `service.html` |
| Ledger picker widget | `ledger-picker.html` |
| Tally debug tool | `tally_debug.html` |
| Firebase service worker | `firebase-messaging-sw.js` |
| App shell service worker | `service-worker.js` |
| Purchase ingestion | `purchase-ingestion.html` |
| Watcher setup guide | `watcher-setup/SETUP.md` |
