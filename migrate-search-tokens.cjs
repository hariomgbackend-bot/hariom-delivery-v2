// Run: node migrate-search-tokens.cjs
// Backfills _search and _search_tokens on all existing service tickets

const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");

const serviceAccount = require("./firebase-service-account.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = getFirestore();

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
  const snap = await db.collection("service_tickets").orderBy("created_at", "desc").limit(2000).get();
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
    await db.collection("service_tickets").doc(t.id).update({ _search, _search_tokens });
    updated++;
    if (updated % 100 === 0) console.log(`  Migrated ${updated}...`);
  }

  console.log(`Done. Updated: ${updated}, Skipped (already have tokens): ${skipped}`);
  process.exit(0);
}

migrate().catch(err => { console.error(err); process.exit(1); });
