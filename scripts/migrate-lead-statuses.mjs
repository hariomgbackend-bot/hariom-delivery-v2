/* ════════════════════════════════════════════════
   MIGRATION — lead status vocabulary (4 → 7 stages)

   Rewrites ONLY the `status` field on `leads` documents so the whole system
   speaks the unified pipeline vocabulary:

       open      → new
       sale      → won
       converted → won        (defensive — nothing writes it any more)
       followup  → (unchanged)
       lost      → (unchanged)

   Any status that is already one of the 7 pipeline stages is left alone.
   Anything unrecognised is REPORTED but NOT changed, so nothing is silently
   rewritten — decide on those by hand.

   Usage (run from the repo root):
       node scripts/migrate-lead-statuses.mjs            # dry run, writes nothing
       node scripts/migrate-lead-statuses.mjs --apply    # commit the changes
════════════════════════════════════════════════ */

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import fs from "fs";

const serviceAccount = JSON.parse(fs.readFileSync("./firebase-service-account.json", "utf8"));

initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const APPLY = process.argv.includes("--apply");

/* The unified pipeline — must match LEAD_STATUSES in server.js */
const LEAD_STATUSES = ["new", "quoted", "deposit", "followup", "visit", "won", "lost"];

const STATUS_MAP = {
  open: "new",
  sale: "won",
  converted: "won",
};

const BATCH_SIZE = 500;

async function main() {
  console.log(`\n=== Lead status migration ${APPLY ? "(APPLY)" : "(DRY RUN — nothing will be written)"} ===\n`);

  const snapshot = await db.collection("leads").get();
  console.log(`Scanned ${snapshot.size} lead documents.\n`);

  const counts = {};        // "open → new": 12
  const unknown = {};       // status value → count
  const pending = [];       // refs to update

  for (const docSnap of snapshot.docs) {
    const status = docSnap.data().status;

    // Already a valid pipeline stage?
    if (LEAD_STATUSES.includes(status)) continue;

    const mapped = STATUS_MAP[status];
    if (!mapped) {
      const key = status === undefined ? "(missing)" : String(status);
      unknown[key] = (unknown[key] || 0) + 1;
      continue;
    }

    const key = `${status} → ${mapped}`;
    counts[key] = (counts[key] || 0) + 1;
    pending.push({ ref: docSnap.ref, from: status, to: mapped });
  }

  console.log("--- Mappings ---");
  if (Object.keys(counts).length === 0) {
    console.log("  (nothing to migrate)");
  } else {
    Object.entries(counts).sort().forEach(([k, v]) => console.log(`  ${k}: ${v}`));
  }

  if (Object.keys(unknown).length > 0) {
    console.log("\n--- UNRECOGNISED statuses (left untouched — review manually) ---");
    Object.entries(unknown).sort().forEach(([k, v]) => console.log(`  "${k}": ${v}`));
  }

  console.log(`\nTotal to update: ${pending.length}`);

  if (!APPLY) {
    console.log("\nDry run complete. Re-run with --apply to write these changes.");
    process.exit(0);
  }

  if (pending.length === 0) {
    console.log("\nNothing to do.");
    process.exit(0);
  }

  let written = 0;
  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const slice = pending.slice(i, i + BATCH_SIZE);
    slice.forEach(({ ref, to }) => batch.update(ref, { status: to }));
    await batch.commit();
    written += slice.length;
    console.log(`  Committed ${written}/${pending.length}`);
  }

  // Verify: read back and confirm nothing invalid remains
  const after = await db.collection("leads").get();
  const invalid = {};
  after.docs.forEach(d => {
    const s = d.data().status;
    if (!LEAD_STATUSES.includes(s)) {
      const key = s === undefined ? "(missing)" : String(s);
      invalid[key] = (invalid[key] || 0) + 1;
    }
  });

  console.log("\n=== VERIFY ===");
  console.log(`Updated: ${written}`);
  if (Object.keys(invalid).length === 0) {
    console.log("All leads now carry a valid 7-stage status. ✅");
  } else {
    console.log("Remaining non-standard statuses (unchanged, by design):");
    Object.entries(invalid).sort().forEach(([k, v]) => console.log(`  "${k}": ${v}`));
  }
  process.exit(0);
}

main().catch(err => {
  console.error("\nMigration failed:", err);
  process.exit(1);
});
