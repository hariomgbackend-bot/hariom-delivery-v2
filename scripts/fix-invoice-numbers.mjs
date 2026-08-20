// One-off migration: strip <Auto>/&lt;Auto&gt; markers from delivery
// invoice numbers from 23/07/2026 onwards — WITHOUT the previous +1.
//   "2026-27/2000188<Auto>" → "2026-27/2000188"
//
// Dry-run by default. Pass --apply to actually write to Firestore.
//
// Usage:
//   node scripts/fix-invoice-numbers.mjs            # dry run
//   node scripts/fix-invoice-numbers.mjs --apply    # write
import { config } from "dotenv";
config();

import db from "../firestore.js";
import { collection, getDocs, query, where, doc, updateDoc, Timestamp } from "firebase/firestore";

const CUTOFF_IST = "2026-07-23T00:00:00+05:30";

function stripAutoMarker(inv) {
  if (!inv) return null; // no invoice number — skip
  const s = String(inv).trim();
  if (!/<Auto>|&lt;Auto&gt;/i.test(s)) return null; // no marker — leave untouched
  const clean = s.replace(/<Auto>|&lt;Auto&gt;/gi, "").trim();
  return clean || null; // stripping to empty is a no-op (nothing meaningful to fix)
}

const APPLY = process.argv.includes("--apply");

async function main() {
  const cutoff = new Date(CUTOFF_IST);
  const cutoffTs = Timestamp.fromMillis(cutoff.getTime());

  console.log(`\n🔍 Scanning deliveries with created_timestamp >= ${CUTOFF_IST} (${APPLY ? "APPLY" : "DRY RUN"})`);

  const snap = await getDocs(query(
    collection(db, "deliveries"),
    where("created_timestamp", ">=", cutoffTs)
  ));

  let scanned = 0, rewritten = 0, skipped = 0;
  for (const d of snap.docs) {
    const data = d.data();
    const inv = data.invoice_number;
    const clean = stripAutoMarker(inv);
    scanned++;
    if (clean === null) { skipped++; continue; }

    rewritten++;
    if (APPLY) {
      await updateDoc(doc(db, "deliveries", d.id), { invoice_number: clean });
    }
    console.log(`  ✏️  ${d.id}  ${inv}  →  ${clean}`);
  }

  console.log(`\n📊 Scanned: ${scanned} | With <Auto>: ${rewritten} | Untouched: ${skipped}`);
  if (!APPLY && rewritten) console.log("ℹ️  Dry run — no writes. Re-run with --apply to fix.");
}

main().catch(e => { console.error("❌", e.message); process.exit(1); });
