import { createRequire } from "module";
const require = createRequire(import.meta.url);
const admin = require("firebase-admin");
const serviceAccount = require("../firebase-service-account.json");

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const ALANDI = "store_a";
const DHANORE = "store_b";

async function migrate() {
  const snap = await db.collection("staff_users").get();
  console.log(`Found ${snap.size} staff_users docs\n`);

  let updated = 0;
  let skipped = 0;

  for (const doc of snap.docs) {
    const data = doc.data();
    const current = data.storeId || "(unset)";

    // Keep Dhanore accountant as-is
    if (data.role === "accountant" && data.storeId === DHANORE) {
      console.log(`⏭ SKIP  ${data.role.padEnd(12)} ${(data.name || doc.id).padEnd(20)} store=${current}  (Dhanore accountant)`);
      skipped++;
      continue;
    }

    // Everyone else gets Alandi
    await doc.ref.update({ storeId: ALANDI });
    console.log(`✅ SET   ${data.role.padEnd(12)} ${(data.name || doc.id).padEnd(20)} store=${current.padEnd(8)} → ${ALANDI}`);
    updated++;
  }

  console.log(`\nDone. ${updated} updated, ${skipped} skipped.`);
  process.exit(0);
}

migrate().catch(err => { console.error(err); process.exit(1); });
