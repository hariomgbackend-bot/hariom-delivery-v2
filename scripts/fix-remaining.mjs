import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import fs from "fs";

const serviceAccount = JSON.parse(fs.readFileSync("./firebase-service-account.json", "utf8"));

initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

async function fixCollection(name) {
  console.log('Fixing', name);
  const snap = await db.collection(name).get();
  const batch = db.batch();
  let count = 0;
  snap.docs.forEach(doc => {
    const data = doc.data();
    if (!data.storeId) {
      batch.update(doc.ref, { storeId: 'store_a', point_of_sale: FieldValue.delete() });
      count++;
    }
  });
  if (count > 0) {
    await batch.commit();
    console.log('  Updated', count, 'docs in', name);
  } else {
    console.log('  No updates needed in', name);
  }
}

async function fixDrivers() {
  console.log('Fixing drivers');
  const snap = await db.collection('drivers').get();
  const batch = db.batch();
  let count = 0;
  snap.docs.forEach(doc => {
    const data = doc.data();
    if (!data.storeId) {
      batch.update(doc.ref, { storeId: 'store_a' });
      count++;
    }
  });
  if (count > 0) {
    await batch.commit();
    console.log('  Updated', count, 'drivers');
  } else {
    console.log('  No updates needed');
  }
}

async function main() {
  await fixCollection('service_tickets');
  await fixCollection('leads');
  await fixDrivers();
  console.log('Done');
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });