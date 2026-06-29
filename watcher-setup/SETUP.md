# Hariom DMS — Invoice Watcher Setup

Watches a folder on the shop PC for new Tally PDF invoices, uploads them to Firebase, and lists them in the accountant Cloud Invoices panel.

---

## Folder Contents

```
watcher-setup/
  watcher.js            — Main watcher script
  package.json          — Dependencies
  .env.example          — Config template (copy to .env)
  firebase-service-account.json  — Copy from server folder (see step 2)
  start-watcher.bat    — Run this to start manually
  setup-startup.bat    — Run this once to auto-start on boot
  SETUP.md             — This file
```

---

## Setup Steps

### 1. Copy Files to Shop PC

Copy the entire `watcher-setup` folder to the shop PC, e.g.:
```
C:\HariomDMS\InvoiceWatcher\
```

### 2. Copy Firebase Service Account

Copy `firebase-service-account.json` from the server folder into `watcher-setup/`.

### 3. Install Dependencies

Open cmd in the folder and run:

```cmd
npm install
```

### 4. Configure .env

Copy `.env.example` to `.env` and edit it:

```env
WATCH_FOLDER=C:\HariomDMS\InvoiceWatch
WATCHER_PORT=7788
FIREBASE_STORAGE_BUCKET=hariom-delivery.firebasestorage.app
WATCHER_API_URL=http://YOUR_PC_LOCAL_IP:7788
```

To find your PC's local IP, open cmd and run `ipconfig` → look for IPv4 Address.

> **Note:** `WATCHER_API_URL` lets the server delete local files after 8 hours. If the server can't reach your PC, local files won't be auto-deleted — the cloud copy still works fine.

### 5. Test It

```cmd
start-watcher.bat
```

You should see:
```
[watcher] Created watch folder: C:\HariomDMS\InvoiceWatch
[watcher] Watching: C:\HariomDMS\InvoiceWatch
[watcher-api] Local API on port 7788
```

Drop a Tally PDF (e.g. `Ramesh Kumar - INV001.pdf`) into `C:\HariomDMS\InvoiceWatch\`.
You should see:
```
[watcher] New PDF: Ramesh Kumar - INV001.pdf
[watcher] Uploaded: Ramesh Kumar - INV001.pdf
```

Open accountant.html → Create DO → ☁️ Cloud Invoices → the invoice should appear.

### 6. Auto-start on Boot (optional)

Double-click `setup-startup.bat`. The watcher will now start automatically every time you log in.

To undo: delete the shortcut at:
```
%USERPROFILE%\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\HariomWatcher.lnk
```

---

## How It Works

1. Tally saves a PDF to `C:\HariomDMS\InvoiceWatch\`
2. Watcher detects it, uploads to Firebase Storage, writes metadata to Firestore
3. Accountant opens ☁️ Cloud Invoices → sees the invoice with customer name + invoice no
4. Accountant clicks Import → fills DO → submits
5. After DO is created, the invoice is marked as "imported" in Firestore
6. Server cron runs every hour → deletes imported invoices older than 8 hours from:
   - Firebase Storage
   - Firestore
   - Local PC (via watcher's local API on port 7788)

---

## Tally Filename Format

The watcher extracts customer name and invoice number from the filename.

Supported formats:
- `Ramesh Kumar - INV001.pdf` → Customer: "Ramesh Kumar", Invoice: "INV001"
- `Ramesh Kumar_INV001.pdf` → Customer: "Ramesh Kumar", Invoice: "INV001"

Any other format: filename without `.pdf` is used as the customer name.

## Name Format Auto-Normalization

Tally sometimes exports names as `LASTNAME FIRSTNAME MIDDLENAME` (all caps), e.g. `CHAUHAN AMIT J`.

The parser automatically detects this and converts it to proper format: `Amit J Chauhan`.

This applies to both cloud invoice imports and regular PDF imports.

---

## Watch Folder Location

Default: `C:\HariomDMS\InvoiceWatch`

To change, edit `WATCH_FOLDER` in `.env`.

---

## Uninstall

1. Delete the startup shortcut: `%USERPROFILE%\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\HariomWatcher.lnk`
2. Close the running watcher window
3. Delete the folder
