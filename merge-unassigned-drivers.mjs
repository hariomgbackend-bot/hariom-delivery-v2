import admin from "firebase-admin";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const serviceAccount = require("./firebase-service-account.json");

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function main() {
  // 1. Find all unassigned driver docs (case-insensitive)
  const driversSnap = await db.collection("drivers").get();
  const unassignedDocs = driversSnap.docs.filter(d => {
    const name = d.data().driver_name || "";
    return name.trim().toLowerCase() === "unassigned";
  });

  if (unassignedDocs.length === 0) {
    console.log("No unassigned driver docs found.");
    return;
  }

  console.log(`Found ${unassignedDocs.length} unassigned driver(s):`);
  for (const d of unassignedDocs) {
    console.log(`  ID: ${d.id}  |  driver_name: "${d.data().driver_name}"`);
  }

  if (unassignedDocs.length === 1) {
    const doc = unassignedDocs[0];
    if (doc.data().driver_name === "UNASSIGNED") {
      console.log("Already UNASSIGNED — no change needed.");
    } else {
      await doc.ref.update({ driver_name: "UNASSIGNED" });
      console.log("Set canonical driver_name to UNASSIGNED.");
    }
    return;
  }

  // 2. Pick canonical: prefer the one named exactly "UNASSIGNED", or the one
  //    with the most deliveries referencing it.
  console.log("\nCounting delivery references per driver...");
  const deliveriesSnap = await db.collection("deliveries").get();

  const refCounts = {};
  for (const d of unassignedDocs) refCounts[d.id] = 0;
  let totalDeliveries = 0;
  for (const d of deliveriesSnap.docs) {
    const aid = d.data().assigned_driver_id;
    if (aid && refCounts[aid] !== undefined) {
      refCounts[aid]++;
    }
    totalDeliveries++;
  }

  for (const d of unassignedDocs) {
    console.log(`  ${d.id} ("${d.data().driver_name}"): ${refCounts[d.id]} deliveries`);
  }

  // Prefer existing UNASSIGNED, else most-referenced
  let canonical = unassignedDocs.find(d => d.data().driver_name === "UNASSIGNED");
  if (!canonical) {
    canonical = unassignedDocs.reduce((best, d) =>
      refCounts[d.id] > refCounts[best.id] ? d : best
    , unassignedDocs[0]);
  }

  const nonCanonical = unassignedDocs.filter(d => d.id !== canonical.id);
  console.log(`\nCanonical: ${canonical.id} ("${canonical.data().driver_name}")`);
  console.log(`Others to merge: ${nonCanonical.map(d => d.id).join(", ")}`);

  // 3. Update canonical name to UNASSIGNED
  if (canonical.data().driver_name !== "UNASSIGNED") {
    await canonical.ref.update({ driver_name: "UNASSIGNED" });
    console.log("Set canonical driver_name → UNASSIGNED");
  }

  // 4. Re-point deliveries from non-canonical IDs to canonical ID
  let updatedDeliveries = 0;
  const batch = db.batch();
  for (const d of deliveriesSnap.docs) {
    const aid = d.data().assigned_driver_id;
    if (aid && nonCanonical.some(nc => nc.id === aid)) {
      batch.update(d.ref, { assigned_driver_id: canonical.id });
      updatedDeliveries++;
    }
  }

  if (updatedDeliveries > 0) {
    await batch.commit();
    console.log(`Re-pointed ${updatedDeliveries} deliveries to canonical driver ID.`);
  } else {
    console.log("No deliveries need re-pointing.");
  }

  // 5. Delete non-canonical driver docs
  for (const d of nonCanonical) {
    await d.ref.delete();
    console.log(`Deleted duplicate driver: ${d.id} ("${d.data().driver_name}")`);
  }

  console.log("\nDone.");
}

main().catch(console.error);
