// Run: node migrate-search-tokens.cjs
// Backfills _search and _search_tokens on all existing service tickets

const { initializeApp } = require("firebase/app");
const { getFirestore, collection, getDocs, doc, updateDoc, query, orderBy, limit: fLimit } = require("firebase/firestore");
require("dotenv").config();

const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

function computeSearchField(ticket) {
  const parts = [
    ticket.customer_name,
    ticket.first_name,
    ticket.middle_name,
    ticket.last_name,
    ticket.phone,
    ticket.alternate_phone
  ];
  return parts
    .filter(Boolean)
    .map(s => String(s).toUpperCase().replace(/\s+/g, " ").trim())
    .join(" ");
}

function computeSearchTokens(ticket) {
  const parts = [
    ticket.customer_name,
    ticket.first_name,
    ticket.middle_name,
    ticket.last_name,
    ticket.phone,
    ticket.alternate_phone
  ];
  return [...new Set(
    parts
      .filter(Boolean)
      .flatMap(s => String(s).toUpperCase().split(/\s+/))
      .filter(Boolean)
  )];
}

async function migrate() {
  console.log("Reading all service tickets...");
  const snap = await getDocs(query(collection(db, "service_tickets"), orderBy("created_at", "desc"), fLimit(2000)));
  const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  console.log(`Total tickets: ${all.length}`);

  let updated = 0;
  let skipped = 0;

  for (const t of all) {
    if (t._search_tokens && t._search_tokens.length > 0) {
      skipped++;
      continue;
    }
    const _search = computeSearchField(t);
    const _search_tokens = computeSearchTokens(t);
    await updateDoc(doc(db, "service_tickets", t.id), { _search, _search_tokens });
    updated++;
    if (updated % 100 === 0) console.log(`  Migrated ${updated}...`);
  }

  console.log(`Done. Updated: ${updated}, Skipped (already have tokens): ${skipped}`);
  process.exit(0);
}

migrate().catch(err => { console.error(err); process.exit(1); });
