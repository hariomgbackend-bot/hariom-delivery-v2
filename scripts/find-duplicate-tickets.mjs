// Read-only duplicate report for service tickets.
// Groups tickets by type + phone + customer + product and prints groups with
// more than one ticket. Nothing is deleted — review, then clean up by hand.
import admin from "firebase-admin";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const serviceAccount = require("../firebase-service-account.json");

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const normPhone = s => String(s || "").replace(/\D/g, "");
const normName  = s => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
const normProd  = s => String(s || "").toUpperCase().replace(/\s+/g, " ").trim();
const tsMs = t => (t?.toMillis ? t.toMillis() : (t?.seconds ? t.seconds * 1000 : (t?._seconds ? t._seconds * 1000 : 0)));

async function main() {
  const snap = await db.collection("service_tickets").get();
  console.log(`Total service tickets: ${snap.size}`);

  const groups = new Map();
  for (const d of snap.docs) {
    const t = d.data();
    const phone = normPhone(t.phone);
    if (!phone) continue;
    const key = [t.type || "", phone, normName(t.customer_name), normProd(t.product_name)].join("|");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ id: d.id, ...t });
  }

  let dupeGroups = 0;
  let excess = 0;
  for (const [key, list] of groups) {
    if (list.length < 2) continue;
    dupeGroups++;
    excess += list.length - 1;
    console.log(`\n${key} — ${list.length} tickets`);
    list.sort((a, b) => tsMs(a.created_at) - tsMs(b.created_at));
    for (const t of list) {
      const when = tsMs(t.created_at) ? new Date(tsMs(t.created_at)).toLocaleString("en-IN") : "—";
      console.log(`  ${t.id} | ${when} | ${t.status} | source=${t.source || "manual"}` +
        `${t.tally_voucher_number ? " | tally=" + t.tally_voucher_number : ""}` +
        `${t.created_by_name ? " | by=" + t.created_by_name : ""}`);
    }
  }

  console.log(`\n${dupeGroups} duplicate group(s), ${excess} excess ticket(s).`);
}

main().catch(err => { console.error(err); process.exit(1); });
