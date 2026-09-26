import { createRequire } from "module";
const require = createRequire(import.meta.url);
const admin = require("firebase-admin");
const serviceAccount = require("../firebase-service-account.json");

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const stores = [
  { id: "store_a", code: "store_a", name: "Alandi",  isActive: true },
  { id: "store_b", code: "store_b", name: "Dhanore", isActive: true }
];

for (const s of stores) {
  const ref = db.collection("stores").doc(s.id);
  const doc = await ref.get();
  if (doc.exists) {
    console.log(`✔ ${s.name} (${s.id}) already exists, skipping`);
  } else {
    await ref.set({ code: s.code, name: s.name, isActive: s.isActive });
    console.log(`✅ Created ${s.name} (${s.id})`);
  }
}

console.log("\nDone. Stores collection seeded.");
process.exit(0);
