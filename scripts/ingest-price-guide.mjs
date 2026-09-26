// Ingest the banded Price Guide (from the official PDF) into the `price_guide` collection.
//
// Usage:
//   node scripts/ingest-price-guide.mjs                # parse PDF + upsert
//   node scripts/ingest-price-guide.mjs --dry-run      # report only, no writes
//   node scripts/ingest-price-guide.mjs --wipe         # delete all price_guide docs first, then reload
//   node scripts/ingest-price-guide.mjs --pdf <path>   # custom PDF path
//
// Each product gets: productName, category (LED|REF|WM), bands {minimum,low,target,good,excellent}
// where each band is a selling-price range {from,to} (₹), mspEnabled, updatedAt, updatedBy.

import { createRequire } from "module";
import fs from "fs";
import admin from "firebase-admin";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");
const serviceAccount = require("../firebase-service-account.json");

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const WIPE = argv.includes("--wipe");
const pdfArg = argv.find(a => a.startsWith("--pdf="));
const PDF_PATH = pdfArg ? pdfArg.slice(6) : "Price Guide/TV_WM-REF_Hariom_Price_Guide_AUG26.pdf";

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const BAND_KEYS = ["minimum", "low", "target", "good", "excellent"];
const SKIP_LINES = new Set([
  "PARTICULARS", "MINIMUM", "LOW", "TARGET", "GOOD", "EXCELLENT",
  "LED", "REFRIGERATOR", "WASHING MACHINE", "GRAND TOTAL", "EXC. GST", "INC. GST"
]);

function normalizeName(name) {
  return String(name || "").toUpperCase().replace(/\s+/g, " ").trim();
}

function deriveCategory(name) {
  const first = String(name || "").split(/\s+/)[0].toUpperCase();
  return /^(LED|REF|WM)$/.test(first) ? first : "";
}

async function parsePdf() {
  const data = await pdfParse(fs.readFileSync(PDF_PATH));
  const lines = data.text.split(/\r?\n/);
  const entries = [];
  let pending = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/₹/.test(line)) {
      const ranges = [...line.matchAll(/₹([\d,]+)\s*-\s*₹([\d,]+)/g)]
        .map(m => [+m[1].replace(/,/g, ""), +m[2].replace(/,/g, "")]);
      if (ranges.length === 5 && pending) {
        const name = normalizeName(pending);
        const bands = {};
        BAND_KEYS.forEach((k, i) => { bands[k] = { from: ranges[i][0], to: ranges[i][1] }; });
        entries.push({ productName: name, category: deriveCategory(name), bands });
        pending = null;
        continue;
      }
      pending = null;
      continue;
    }
    if (SKIP_LINES.has(line.toUpperCase())) { pending = null; continue; }
    pending = line;
  }
  return entries;
}

async function loadExisting() {
  const snap = await db.collection("price_guide").get();
  const docs = {};
  snap.docs.forEach(d => {
    const dta = d.data();
    docs[normalizeName(dta.productName)] = { id: d.id, ...dta };
  });
  return docs;
}

function bandsEqual(a, b) {
  if (!a || !b) return false;
  for (const k of BAND_KEYS) {
    if (!a[k] || !b[k]) return false;
    if (Number(a[k].from) !== Number(b[k].from)) return false;
    if (Number(a[k].to) !== Number(b[k].to)) return false;
  }
  return true;
}

async function main() {
  console.log(`[ingest-price-guide] source: ${PDF_PATH} (dry-run=${DRY_RUN}, wipe=${WIPE})`);
  const entries = await parsePdf();
  console.log(`[ingest-price-guide] parsed ${entries.length} products from PDF`);
  const byCat = {};
  entries.forEach(e => { byCat[e.category] = (byCat[e.category] || 0) + 1; });
  console.log("[ingest-price-guide] by category:", JSON.stringify(byCat));

  let existing = await loadExisting();
  if (WIPE && !DRY_RUN && Object.keys(existing).length) {
    console.log(`[ingest-price-guide] wiping ${Object.keys(existing).length} existing docs…`);
    const ids = Object.values(existing).map(d => d.id);
    for (let i = 0; i < ids.length; i += 450) {
      const batch = db.batch();
      ids.slice(i, i + 450).forEach(id => batch.delete(db.collection("price_guide").doc(id)));
      await batch.commit();
    }
    existing = {};
    console.log("[ingest-price-guide] wiped.");
  }

  const ts = admin.firestore.Timestamp.now();
  const batch = db.batch();
  let added = 0, updated = 0, unchanged = 0;

  for (const entry of entries) {
    const key = entry.productName;
    const cur = existing[key];
    if (!cur) {
      batch.set(db.collection("price_guide").doc(), {
        ...entry,
        mspEnabled: true,
        updatedAt: ts,
        updatedBy: "ingest"
      });
      added++;
    } else if (!bandsEqual(cur.bands, entry.bands)) {
      const patch = { bands: entry.bands, updatedAt: ts, updatedBy: "ingest" };
      if (!cur.category) patch.category = entry.category;
      batch.update(db.collection("price_guide").doc(cur.id), patch);
      updated++;
    } else {
      unchanged++;
    }
  }

  console.log(`[ingest-price-guide] results: ${added} new, ${updated} updated, ${unchanged} unchanged`);
  if (DRY_RUN) {
    console.log("[ingest-price-guide] DRY RUN — no writes performed.");
    return;
  }
  await batch.commit();
  console.log("[ingest-price-guide] committed to Firestore.");
}

main().catch(e => { console.error("[ingest-price-guide] ERROR:", e); process.exit(1); });
