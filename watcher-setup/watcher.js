/**
 * ════════════════════════════════════════════════════════════════
 *  HARIOM DMS — Cloud Invoice Watcher
 *  Runs on the Windows shop PC as a background service.
 *
 *  What it does:
 *   1. Watches a local folder for new PDF files
 *   2. Uploads each PDF to Firebase Storage (cloud_invoices/)
 *   3. Writes metadata to Firestore (cloud_invoices collection)
 *   4. Runs a tiny Express server on :7788 so the backend cron
 *      can call DELETE /local-file to purge files after 8 hours
 *
 *  Setup: see SETUP.md
 * ════════════════════════════════════════════════════════════════
 */

import chokidar from "chokidar";
import admin from "firebase-admin";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import dotenv from "dotenv";

dotenv.config();

const require      = createRequire(import.meta.url);
const __dirname    = path.dirname(fileURLToPath(import.meta.url));

// ── Config ───────────────────────────────────────────────────────
const WATCH_FOLDER    = process.env.WATCH_FOLDER    || "C:\\HariomDMS\\InvoiceWatch";
const STORAGE_BUCKET  = process.env.FIREBASE_STORAGE_BUCKET || "hariom-delivery.firebasestorage.app";
const LOCAL_API_PORT  = parseInt(process.env.WATCHER_PORT || "7788");
const SERVICE_ACCOUNT = process.env.FIREBASE_SA_PATH
  ? JSON.parse(fs.readFileSync(process.env.FIREBASE_SA_PATH, "utf8"))
  : require("./firebase-service-account.json");

// ── Firebase Admin init ──────────────────────────────────────────
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(SERVICE_ACCOUNT),
    storageBucket: STORAGE_BUCKET,
  });
}

const bucket = admin.storage().bucket();
const db     = admin.firestore();

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Best-effort customer name extraction from filename.
 * Tally exports PDFs as "CustomerName - InvoiceNo.pdf"
 * or "InvoiceNo_CustomerName.pdf" etc.
 * Falls back to filename without extension.
 */
function extractCustomerFromFilename(filename) {
  const base = path.basename(filename, ".pdf").trim();
  const dashMatch  = base.match(/^(.+?)\s*[-–]\s*[A-Z\/0-9]+$/i);
  const slashMatch = base.match(/^(.+?)[-_][A-Z]{2,}[\/\-]?\d+$/i);
  if (dashMatch)  return dashMatch[1].trim();
  if (slashMatch) return slashMatch[1].trim();
  return base;
}

/**
 * Extract invoice number from filename.
 * Tries common Tally patterns: INV/001, INV-001, INV001
 */
function extractInvoiceNoFromFilename(filename) {
  const base = path.basename(filename, ".pdf");
  const m = base.match(/([A-Z]{2,}[-\/]?\d{3,})/i);
  return m ? m[1].toUpperCase() : null;
}

const _uploading = new Set();

// ── Upload a single PDF ──────────────────────────────────────────
async function uploadInvoice(localFilePath) {
  const filename = path.basename(localFilePath);

  if (_uploading.has(localFilePath)) return;
  _uploading.add(localFilePath);

  try {
    await new Promise(r => setTimeout(r, 1500));

    if (!fs.existsSync(localFilePath)) {
      console.log(`[watcher] File gone before upload: ${filename}`);
      return;
    }

    const fileBuffer    = fs.readFileSync(localFilePath);
    const now           = Date.now();
    const storageName   = `cloud_invoices/${now}_${filename}`;
    const customerName  = extractCustomerFromFilename(filename);
    const invoiceNo     = extractInvoiceNoFromFilename(filename) || `UNK-${now}`;

    const dupSnap = await db.collection("cloud_invoices")
      .where("invoiceNo", "==", invoiceNo)
      .limit(1)
      .get();

    if (!dupSnap.empty) {
      console.log(`[watcher] Duplicate invoice skipped: ${invoiceNo} (${filename})`);
      return;
    }

    const fileRef = bucket.file(storageName);
    await fileRef.save(fileBuffer, { contentType: "application/pdf" });

    const [signedUrl] = await fileRef.getSignedUrl({
      action:  "read",
      expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });

    await db.collection("cloud_invoices").add({
      invoiceNo,
      customerName,
      filename,
      storagePath:  storageName,
      localPath:    localFilePath,
      downloadUrl:  signedUrl,
      uploadedAt:   admin.firestore.Timestamp.now(),
      imported:     false,
      importedAt:   null,
    });

    console.log(`[watcher] Uploaded: ${filename}`);
  } catch (err) {
    console.error(`[watcher] Upload failed for ${filename}:`, err.message);
  } finally {
    _uploading.delete(localFilePath);
  }
}

// ── Start folder watcher ─────────────────────────────────────────
function startWatcher() {
  if (!fs.existsSync(WATCH_FOLDER)) {
    fs.mkdirSync(WATCH_FOLDER, { recursive: true });
    console.log(`[watcher] Created watch folder: ${WATCH_FOLDER}`);
  }

  console.log(`[watcher] Watching: ${WATCH_FOLDER}`);

  chokidar.watch(WATCH_FOLDER, {
    persistent:        true,
    ignoreInitial:     false,
    awaitWriteFinish: {
      stabilityThreshold: 1000,
      pollInterval:       200,
    },
    depth: 0,
  }).on("add", (filePath) => {
    if (!filePath.toLowerCase().endsWith(".pdf")) return;
    console.log(`[watcher] New PDF: ${path.basename(filePath)}`);
    uploadInvoice(filePath);
  });
}

// ── Local API server ─────────────────────────────────────────────
function startLocalApi() {
  const app = express();
  app.use(express.json());

  app.delete("/local-file", (req, res) => {
    const { localPath } = req.body || {};
    if (!localPath) return res.status(400).json({ error: "localPath required" });

    const resolved = path.resolve(localPath);
    if (!resolved.startsWith(path.resolve(WATCH_FOLDER))) {
      return res.status(403).json({ error: "Path outside watch folder" });
    }

    if (!fs.existsSync(resolved)) return res.json({ ok: true, note: "File already gone" });

    try {
      fs.unlinkSync(resolved);
      console.log(`[watcher-api] Deleted: ${resolved}`);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/health", (req, res) => res.send("OK"));

  app.listen(LOCAL_API_PORT, "127.0.0.1", () => {
    console.log(`[watcher-api] Local API on port ${LOCAL_API_PORT}`);
  });
}

// ── Boot ─────────────────────────────────────────────────────────
startWatcher();
startLocalApi();

console.log(`\nHariom Invoice Watcher running\nWatch folder : ${WATCH_FOLDER}\nLocal API    : http://127.0.0.1:${LOCAL_API_PORT}\n`);
