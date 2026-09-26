// Download every delivered-proof photo from Firestore into ./delivered_photos/
// For each delivery doc with status === "delivered", downloads:
//   - photo_delivered_url        -> <date>_<customer>_<id>.jpg            (indoor / main)
//   - photo_delivered_outdoor_url -> <date>_<customer>_<id>_outdoor.jpg   (AC outdoor unit)
// Uses the firebase-admin Storage bucket directly (no public download URL needed).
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serviceAccount = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "firebase-service-account.json"), "utf8")
);

initializeApp({
  credential: cert(serviceAccount),
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET || "hariom-delivery.firebasestorage.app",
});
const db = getFirestore();
const bucket = getStorage().bucket();

const OUT_DIR = path.join(__dirname, "..", "delivered_photos");
fs.mkdirSync(OUT_DIR, { recursive: true });

function sanitize(s, fallback = "unknown") {
  const out = String(s || "").trim().replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, "_").slice(0, 60);
  return out || fallback;
}

function tsDate(v) {
  if (!v) return "";
  const ms = typeof v.toMillis === "function" ? v.toMillis() : (v.seconds ? v.seconds * 1000 : v);
  return new Date(ms).toISOString().slice(0, 10); // YYYY-MM-DD
}

async function downloadFile(url, destPath, label) {
  // Accept both firebase-admin File-like objects and https:// URL strings
  let file = url;
  if (typeof url === "string") {
    try {
      const storagePath = decodeURIComponent(url.split("/o/")[1].split("?")[0]);
      file = bucket.file(storagePath);
    } catch {
      console.warn(`  [skip] could not parse URL: ${label}`);
      return false;
    }
  }
  try {
    await file.download({ destination: destPath });
    return true;
  } catch (err) {
    console.warn(`  [skip] download failed for ${label}: ${err.message}`);
    return false;
  }
}

async function run() {
  const deliveriesRef = db.collection("deliveries");
  const snapshot = await deliveriesRef.where("status", "==", "delivered").get();
  console.log(`Found ${snapshot.size} delivered delivery docs`);

  let downloads = 0;
  let missed = 0;

  for (const doc of snapshot.docs) {
    const d = doc.data();
    const base = `${tsDate(d.delivered_timestamp)}_${sanitize(d.customer_name)}_${doc.id}`;
    const photoFields = [
      { field: "photo_delivered_url", suffix: "" },
      { field: "photo_delivered_outdoor_url", suffix: "_outdoor" },
    ];

    for (const { field, suffix } of photoFields) {
      const photo = d[field];
      if (!photo) continue;
      const dest = path.join(OUT_DIR, base + suffix + ".jpg");
      if (fs.existsSync(dest)) { console.log(`  exists: ${path.basename(dest)}`); continue; }
      if (await downloadFile(photo, dest, `${doc.id} ${field}`)) {
        downloads++;
        console.log(`  saved: ${path.basename(dest)}`);
      } else {
        missed++;
      }
    }
  }

  console.log(`\nDone. Downloaded ${downloads} photos to ${OUT_DIR}`);
  if (missed) console.log(`${missed} photos could not be downloaded (see warnings above).`);
  process.exit(0);
}

run().catch(err => {
  console.error("Script failed:", err);
  process.exit(1);
});
