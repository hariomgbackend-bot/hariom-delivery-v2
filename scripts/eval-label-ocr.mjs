// Evaluation harness: pull real loaded/handover photos from Firestore,
// run the local OCR pipeline, and score it against the delivery's stored
// product_name (model ground truth) + product_serial_number (serial truth).
//
// Usage:
//   node scripts/eval-label-ocr.mjs                 # sample of 30
//   node scripts/eval-label-ocr.mjs --limit 100     # custom sample size
//   node scripts/eval-label-ocr.mjs --save <dir>    # also save downloaded photos
import { config } from "dotenv";
config();

import { createRequire } from "module";
const require = createRequire(import.meta.url);
let serviceAccount;
try { serviceAccount = require("../firebase-service-account.json"); }
catch { serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT); }

import admin from "firebase-admin";
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET || "hariom-delivery.firebasestorage.app"
});
const db = admin.firestore();
const bucket = admin.storage().bucket();

import { createWorker } from "tesseract.js";
import sharp from "sharp";
import { readBarcodes } from "zxing-wasm/reader";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

const LIMIT = (() => {
  const idx = process.argv.indexOf("--limit");
  return idx !== -1 && process.argv[idx+1] ? parseInt(process.argv[idx+1], 10) : 30;
})();
const SAVE_DIR = (() => {
  const idx = process.argv.indexOf("--save");
  return idx !== -1 && process.argv[idx+1] && !process.argv[idx+1].startsWith("--") ? process.argv[idx+1] : null;
})();
const CUTOFF = new Date("2026-07-23T00:00:00+05:30");

// ── OCR pipeline (mirrors server extractLabelLocal) ──
function cleanToken(s) {
  return String(s).replace(/[^A-Za-z0-9\-/.]/g, "").replace(/^[\-/.]+|[\-/.]+$/g, "").trim();
}
function findModelNumber(lines, tokens) {
  for (const l of lines) {
    const m = l.match(/(?:model\s*(?:no\.?|number)?\s*[:#]?\s*)([A-Z0-9][A-Z0-9\-]{4,})/i);
    if (m) return m[1].toUpperCase();
  }
  for (const t of tokens) {
    if (/^[A-Z]{2,}\d{2,}[A-Z0-9\-]*$/i.test(t) && t.length <= 24) return t.toUpperCase();
  }
  for (const t of tokens) {
    if (/[A-Za-z]/.test(t) && /\d/.test(t) && t.length >= 6) return t.toUpperCase();
  }
  return null;
}
function findSerialCandidates(lines, tokens, modelNumber) {
  const out = new Set();
  const modelNorm = modelNumber ? modelNumber.replace(/[^A-Z0-9]/g, "").toUpperCase() : null;
  const consider = (t) => {
    if (!t) return;
    const c = cleanToken(t).toUpperCase();
    if (c.length < 8 || c.length > 40) return;
    if (!(/\d/.test(c) && /[A-Za-z]/.test(c)) && !/^\d{8,}$/.test(c)) return;
    if (modelNorm && c.replace(/[^A-Z0-9]/g, "") === modelNorm.replace(/[^A-Z0-9]/g, "")) return;
    if (/^(WWW|HTTP|HTTPS|BEE|QR|INR|RS|GST|PAN|S\/N|SERIAL)$/i.test(c)) return;
    out.add(c);
  };
  for (const l of lines) {
    const m = l.match(/(?:s\.?n\.?|serial\s*(?:no\.?|number)?)\s*[:#]?\s*([A-Z0-9\-/.]{8,})/i);
    if (m) consider(m[1]);
  }
  for (const t of tokens) consider(t);
  return Array.from(out).slice(0, 10);
}

// Levenshtein distance for fuzzy match
function lev(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 5) return 99;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = Math.min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1] + (a[i-1]!==b[j-1]?1:0));
  return dp[m][n];
}

async function main() {
  console.log(`\n🔍 Fetching deliveries with photos since ${CUTOFF.toISOString()} (sample ${LIMIT})`);
  const snap = await db.collection("deliveries")
    .where("created_timestamp", ">=", admin.firestore.Timestamp.fromDate(CUTOFF))
    .limit(500)
    .get();

  const withPhoto = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(d => d.photo_loaded_url || d.photo_delivered_url)
    .filter(d => d.product_name); // need ground truth

  console.log(`Fetched ${snap.size} docs, ${withPhoto.length} have photos + product name`);
  const sample = withPhoto.slice(0, LIMIT);
  if (!sample.length) { console.log("No sample — exiting"); return; }

  if (SAVE_DIR) mkdirSync(SAVE_DIR, { recursive: true });

  const worker = await createWorker("eng");

  let modelCorrect = 0, modelHasTruth = 0, serialInCands = 0, serialHasTruth = 0;
  const failures = [];

  for (let i = 0; i < sample.length; i++) {
    const d = sample[i];
    const photoUrl = d.photo_loaded_url || d.photo_delivered_url;
    const truthProduct = (d.product_name || "").toUpperCase();
    const truthSerial = (d.product_serial_number || "").toUpperCase();
    process.stdout.write(`[${i+1}/${sample.length}] ${d.id} `);

    try {
      // Download photo
      const res = await fetch(photoUrl);
      const buf = Buffer.from(await res.arrayBuffer());
      if (SAVE_DIR) writeFileSync(join(SAVE_DIR, d.id + ".jpg"), buf);

      // Barcodes -> serials (deterministic, reliable). Drop EAN-13 product codes.
      let barcodes = [];
      try { barcodes = (await readBarcodes(buf)).map(r => r.text).filter(Boolean); } catch {}
      const serialCandidates = Array.from(new Set(
        barcodes.filter(b => {
          if (b.length < 8 || b.length > 40 || !/\d/.test(b)) return false;
          if (/^\d{13}$/.test(b)) return false; // EAN-13 / GTIN product code
          return true;
        })
      )).slice(0, 10);

      // Preprocessed OCR -> model (best-effort)
      let model = null, rawText = "";
      try {
        const pre = await sharp(buf).resize({ width: 2000, withoutEnlargement: true }).grayscale().normalize().jpeg({ quality: 85 }).toBuffer();
        const { data: { text } } = await worker.recognize(pre);
        rawText = text || "";
        const lines  = rawText.split("\n").map(l => l.trim()).filter(Boolean);
        const tokens = rawText.split(/[\s\n]+/).map(cleanToken).filter(Boolean);
        model = findModelNumber(lines, tokens);
      } catch (e) {}

      // Score model: does any token fuzzy-match the truth product's model-ish part?
      let modelHit = false;
      if (model) {
        const truthModels = truthProduct.match(/[A-Z0-9][A-Z0-9\-]{3,}/g) || [];
        for (const tm of truthModels) {
          if (tm.length < 4) continue;
          const dist = lev(model.replace(/[^A-Z0-9]/g,""), tm.replace(/[^A-Z0-9]/g,""));
          if (dist <= 3) { modelHit = true; break; }
          if (model.includes(tm) || tm.includes(model)) { modelHit = true; break; }
        }
      }
      if (truthProduct) modelHasTruth++;
      if (modelHit) modelCorrect++;

      // Score serial (barcode candidates vs truth serial)
      let serialHit = false;
      if (truthSerial && truthSerial.length >= 6) {
        serialHasTruth++;
        const ts = truthSerial.replace(/[^A-Z0-9]/g, "");
        for (const c of serialCandidates) {
          if (c.replace(/[^A-Z0-9]/g,"") === ts || c.includes(ts) || ts.includes(c)) { serialHit = true; break; }
          if (lev(c, ts) <= 3) { serialHit = true; break; }
        }
        if (serialHit) serialInCands++;
      }

      const flag = (modelHit && (!truthSerial || serialHit)) ? "✅" : "❌";
      process.stdout.write(`${flag}\n`);
      if (!modelHit || (truthSerial && !serialHit)) {
        failures.push({ id: d.id, product: truthProduct, serial: truthSerial, ocrModel: model, ocrSerials: serialCandidates.slice(0,5) });
      }
    } catch (e) {
      process.stdout.write(`⚠ ${e.message.slice(0,60)}\n`);
      failures.push({ id: d.id, product: truthProduct, error: e.message.slice(0,80) });
    }
  }
  await worker.terminate();

  console.log("\n══════════════════════════════════════");
  console.log(`Sample: ${sample.length}`);
  console.log(`Model accuracy: ${modelCorrect}/${modelHasTruth} (${Math.round(modelCorrect/modelHasTruth*100)}%)`);
  if (serialHasTruth) console.log(`Serial in candidates: ${serialInCands}/${serialHasTruth} (${Math.round(serialInCands/serialHasTruth*100)}%)`);
  console.log("══════════════════════════════════════\n");
  console.log("Failures:");
  for (const f of failures.slice(0, 25)) {
    console.log(` - ${f.id} | truth: ${f.product}${f.serial ? " / " + f.serial : ""} | ocrModel: ${f.ocrModel || "?"}${f.ocrSerials ? " | serials: " + f.ocrSerials.join(", ") : ""}${f.error ? " | " + f.error : ""}`);
  }
}

main().catch(e => { console.error("❌", e); process.exit(1); });
