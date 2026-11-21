import admin from "firebase-admin";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const serviceAccount = require("../firebase-service-account.json");

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

function matchBrandKeyword(productName, brandName) {
  const n = String(productName || "").toUpperCase();
  const b = String(brandName || "").toUpperCase().trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!b) return false;
  return new RegExp(`\\b${b}\\b`).test(n);
}

async function main() {
  const brandsSnap = await db.collection("brands").get();
  const brandNames = brandsSnap.docs
    .map(d => String(d.data().name || "").trim())
    .filter(Boolean);
  console.log(`Loaded ${brandNames.length} brand(s):`, brandNames.join(", "));

  const ticketsSnap = await db.collection("service_tickets").get();
  console.log(`Total service tickets: ${ticketsSnap.size}`);

  let updated = 0;
  let skipped = 0;
  let unreadable = 0;
  let batch = db.batch();
  let inBatch = 0;

  for (const d of ticketsSnap.docs) {
    const t = d.data();
    if (t.brand) { skipped++; continue; }

    const brand = brandNames.find(n => matchBrandKeyword(t.product_name, n));
    if (!brand) { unreadable++; continue; }

    batch.update(d.ref, { brand: brand.toUpperCase() });
    updated++;
    inBatch++;

    if (inBatch >= 400) {
      await batch.commit();
      batch = db.batch();
      inBatch = 0;
    }
  }

  if (inBatch > 0) await batch.commit();

  console.log(`Updated ${updated} ticket(s); already branded: ${skipped}; no brand match: ${unreadable}.`);
}

main().catch(err => { console.error(err); process.exit(1); });
