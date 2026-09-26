import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import fs from "fs";

const serviceAccount = JSON.parse(fs.readFileSync("./firebase-service-account.json", "utf8"));

initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const STORE_MAP = {
  "Alandi": "store_a",
  "Dhanore": "store_b",
  "alandi": "store_a",
  "dhanore": "store_b",
  "STORE_A": "store_a",
  "STORE_B": "store_b",
};

function resolveStoreId(pos) {
  if (!pos) return "store_a";
  return STORE_MAP[pos.trim()] || "store_a";
}

async function migrateCollection(collectionName, batchSize = 500) {
  console.log(`\n=== Migrating ${collectionName} ===`);
  const collRef = db.collection(collectionName);
  let totalProcessed = 0;
  let totalUpdated = 0;

  while (true) {
    const snapshot = await collRef.limit(batchSize).get();
    if (snapshot.empty) break;

    const batch = db.batch();
    let batchUpdates = 0;

    for (const docSnap of snapshot.docs) {
      const data = docSnap.data();
      const pointOfSale = data.point_of_sale;
      const existingStoreId = data.storeId;

      // Determine storeId
      let storeId = existingStoreId;
      if (!storeId) {
        storeId = resolveStoreId(pointOfSale);
      }

      // Update if storeId is missing or different
      if (!existingStoreId || existingStoreId !== storeId) {
        batch.update(docSnap.ref, {
          storeId: storeId,
          // Remove point_of_sale field
          point_of_sale: FieldValue.delete()
        });
        batchUpdates++;
        totalUpdated++;
      }

      totalProcessed++;
    }

    if (batchUpdates > 0) {
      await batch.commit();
      console.log(`  Batch committed: ${batchUpdates} updated`);
    } else {
      console.log(`  No updates needed in this batch`);
    }

    if (snapshot.size < batchSize) break;
  }

  console.log(`  Total processed: ${totalProcessed}, Updated: ${totalUpdated}`);
  return { processed: totalProcessed, updated: totalUpdated };
}

async function migrateDrivers() {
  console.log(`\n=== Migrating drivers ===`);
  const collRef = db.collection("drivers");
  const snapshot = await collRef.get();

  let updated = 0;
  const batch = db.batch();

  for (const docSnap of snapshot.docs) {
    const data = docSnap.data();
    if (!data.storeId) {
      batch.update(docSnap.ref, { storeId: "store_a" });
      updated++;
    }
  }

  if (updated > 0) {
    await batch.commit();
  }
  console.log(`  Drivers updated: ${updated}`);
  return { processed: snapshot.size, updated };
}

async function cleanupDuplicateStores() {
  console.log(`\n=== Cleaning up duplicate store docs ===`);
  const collRef = db.collection("stores");
  const snapshot = await collRef.get();

  const toDelete = [];
  for (const docSnap of snapshot.docs) {
    const data = docSnap.data();
    // Keep only store_a and store_b (canonical docs with code field)
    if (!data.code) {
      toDelete.push(docSnap.ref);
    }
  }

  if (toDelete.length > 0) {
    const batch = db.batch();
    toDelete.forEach(ref => batch.delete(ref));
    await batch.commit();
    console.log(`  Deleted ${toDelete.length} duplicate store docs`);
  } else {
    console.log(`  No duplicate store docs found`);
  }
}

async function main() {
  console.log("Starting storeId migration...");
  console.log("Default store: store_a (Alandi)");

  await cleanupDuplicateStores();

  const results = {};
  results.deliveries = await migrateCollection("deliveries");
  results.service_tickets = await migrateCollection("service_tickets");
  results.leads = await migrateCollection("leads");
  results.drivers = await migrateDrivers();

  console.log("\n=== MIGRATION SUMMARY ===");
  console.log(JSON.stringify(results, null, 2));
  console.log("\nMigration complete!");
  process.exit(0);
}

main().catch(err => {
  console.error("Migration failed:", err);
  process.exit(1);
});