import admin from "firebase-admin";
import { readFileSync } from "fs";
import { createRequire } from "module";
import zlib from "zlib";

const require = createRequire(import.meta.url);
const serviceAccount = require("../firebase-service-account.json");

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const xml = readFileSync("invoices/LEDGERS.XML", "utf16le");
const names = [];
const regex = /<CAACCTYPENAME>([^<]+)<\/CAACCTYPENAME>/g;
let m;
while ((m = regex.exec(xml)) !== null) {
  names.push(m[1].trim());
}

console.log(`Extracted ${names.length} ledger names`);

const json = JSON.stringify(names);
const compressed = zlib.gzipSync(Buffer.from(json, "utf8")).toString("base64");

await db.collection("config").doc("ledgers").set({
  data: compressed,
  count: names.length,
  updatedAt: admin.firestore.Timestamp.now()
});

console.log(`Uploaded ${names.length} ledgers to Firestore (${compressed.length} as base64)`);
process.exit(0);
