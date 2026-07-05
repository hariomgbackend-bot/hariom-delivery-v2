import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import { exec } from "child_process";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import zlib from "zlib";
import admin from "firebase-admin";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const isPkg = typeof process.pkg !== "undefined";
const appDir = isPkg ? dirname(process.execPath) : __dirname;

const _serviceAccount = JSON.parse(readFileSync(join(appDir, "firebase-service-account.json"), "utf8"));
admin.initializeApp({ credential: admin.credential.cert(_serviceAccount) });
const firestoreDb = admin.firestore();

const app = express();
app.use(cors({ origin: "*", methods: ["GET", "POST"] }));

// ── Tally fetch with 60s timeout ──
const tallyFetch = async (xmlPayload) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await fetch("http://localhost:9000", {
      method: "POST",
      headers: { "Content-Type": "text/xml" },
      body: xmlPayload,
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    return res;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
};

// ==========================================
// 1. TALLY PRIME PROXY ROUTE
// ==========================================
app.post("/api/tally-proxy", express.text({ type: "text/xml" }), async (req, res) => {
  try {
    console.log("➡️ Forwarding XML payload to TallyPrime...");
    const response = await tallyFetch(req.body);
    const text = await response.text();
    console.log(`⬅️ Tally responded HTTP ${response.status}`);
    res.status(response.status).send(text);
  } catch (error) {
    console.error("❌ Bridge Error:", error.message);
    res.status(500).send(error.message);
  }
});

// ==========================================
// 2. LIVE SYNC ROUTE: Master Stock & Creditors
// ==========================================

let memCache = null;
let syncInProgress = false;
const CACHE_TTL_MS = 30 * 60 * 1000;

const extractNames = (xml) => {
  const names = [];
  const regex = /<(?:NAME|CAACCTYPENAME|DSPDISPNAME)>(.*?)<\/(?:NAME|CAACCTYPENAME|DSPDISPNAME)>|<(?:STOCKITEM|LEDGER)\s+NAME="([^"]+)"/gi;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    let rawName = match[1] || match[2];
    if (rawName) {
      let clean = rawName.replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").trim();
      if (clean && !clean.toLowerCase().includes("grand total")
          && !["sundry creditors","stock items","primary"].includes(clean.toLowerCase())) {
        names.push(clean);
      }
    }
  }
  return [...new Set(names)];
};

async function fetchFromTally() {
  let products = [];
  try {
    const stockXml = `<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY><EXPORTDATA><REQUESTDESC><REPORTNAME>Stock Summary</REPORTNAME><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`;
    const stockRes = await tallyFetch(stockXml);
    const rawStock = await stockRes.text();
    products = [...new Set(
      [...rawStock.matchAll(/<DSPDISPNAME>(.*?)<\/DSPDISPNAME>/gi)]
        .map(m => m[1].replace(/&amp;/g,"&").trim())
        .filter(n => n && !n.toLowerCase().includes("grand total"))
    )];
  } catch (e) {
    console.error("❌ Stock sync failed:", e.message);
  }

  let suppliers = [];
  try {
    await new Promise(r => setTimeout(r, 2000));
    const creditorXml = `<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY><EXPORTDATA><REQUESTDESC><REPORTNAME>List of Accounts</REPORTNAME><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`;
    const creditorRes = await tallyFetch(creditorXml);
    const rawCreditors = await creditorRes.text();
    suppliers = extractNames(rawCreditors);
    if (suppliers.length === 0 && rawCreditors.length > 500) {
      console.log("⚠️ 0 suppliers — raw snippet:", rawCreditors.slice(0, 400));
    }
  } catch (e) {
    console.error("❌ Creditor sync failed:", e.message);
  }

  return { products, suppliers };
}

app.get("/api/sync-tally", async (req, res) => {
  const force = req.query.force === "1";
  const cacheAge = memCache ? Date.now() - memCache.fetchedAt : Infinity;
  const cacheValid = memCache && cacheAge < CACHE_TTL_MS;

  if (!force && cacheValid) {
    const ageMin = Math.round(cacheAge / 60000);
    console.log(`⚡ Serving from memory cache (${ageMin}m old)`);
    res.json({ ...memCache, fromCache: true, cacheAgeMin: ageMin });
    if (cacheAge > 20 * 60 * 1000 && !syncInProgress) {
      syncInProgress = true;
      fetchFromTally()
        .then(data => { memCache = { ...data, fetchedAt: Date.now() }; console.log("✅ Background refresh done"); })
        .catch(e => console.error("❌ Background refresh failed:", e.message))
        .finally(() => { syncInProgress = false; });
    }
    return;
  }

  if (syncInProgress) {
    const deadline = Date.now() + 30000;
    while (syncInProgress && Date.now() < deadline) await new Promise(r => setTimeout(r, 200));
    if (memCache) return res.json({ ...memCache, fromCache: true, cacheAgeMin: 0 });
    return res.status(503).json({ error: "Sync timed out" });
  }

  syncInProgress = true;
  console.log(`➡️ Fetching live masters from Tally${force ? " (forced)" : ""}...`);
  try {
    const data = await fetchFromTally();
    memCache = { ...data, fetchedAt: Date.now() };
    console.log(`✅ Synced: ${data.products.length} products | ${data.suppliers.length} suppliers`);
    res.json({ ...data, fromCache: false, cacheAgeMin: 0 });
  } catch (error) {
    console.error("❌ Sync Error:", error.message);
    if (memCache) return res.json({ ...memCache, fromCache: true, stale: true });
    res.status(500).json({ error: error.message });
  } finally {
    syncInProgress = false;
  }
});

// ==========================================
// 3. LEDGERS (Sundry Debtors) API
// ==========================================

let ledgersCache = null;

async function loadLedgersFromFirestore() {
  try {
    const snap = await firestoreDb.collection("config").doc("ledgers").get();
    if (!snap.exists) return null;
    const { data: compressed } = snap.data();
    const buf = Buffer.from(compressed, "base64");
    const json = zlib.gunzipSync(buf).toString("utf8");
    const ledgers = JSON.parse(json);
    ledgersCache = { ledgers, fetchedAt: Date.now() };
    console.log(`📋 Loaded ${ledgers.length} ledgers from Firestore`);
    return ledgers;
  } catch (e) {
    console.error("❌ Firestore load error:", e.message);
    return null;
  }
}

async function loadLedgersFromLocalFile() {
  const path = join(appDir, "invoices", "LEDGERS.XML");
  if (!existsSync(path)) return null;
  try {
    const xml = readFileSync(path, "utf16le");
    const names = [];
    const re = /<CAACCTYPENAME>([^<]+)<\/CAACCTYPENAME>/g;
    let m;
    while ((m = re.exec(xml)) !== null) names.push(m[1].trim());
    if (names.length === 0) return null;
    ledgersCache = { ledgers: [...new Set(names)], fetchedAt: Date.now() };
    console.log(`📋 Loaded ${names.length} ledgers from LEDGERS.XML`);
    return ledgersCache.ledgers;
  } catch (e) {
    console.error("❌ Local file load error:", e.message);
    return null;
  }
}

app.get("/api/ledgers", async (req, res) => {
  const force = req.query.force === "1";
  if (force) ledgersCache = null;
  if (!ledgersCache) {
    await loadLedgersFromFirestore() || await loadLedgersFromLocalFile();
  }
  if (!ledgersCache) {
    return res.status(503).json({
      error: "No ledgers loaded. Run `node scripts/import-ledgers.mjs` first, or place LEDGERS.XML in invoices/.",
      ledgers: [], count: 0
    });
  }
  const ageMin = Math.round((Date.now() - ledgersCache.fetchedAt) / 60000);
  res.json({ ledgers: ledgersCache.ledgers, count: ledgersCache.ledgers.length, cacheAgeMin: ageMin });
});

app.post("/api/ledgers/refresh", async (req, res) => {
  const fromFile = req.query.source === "file";
  const ok = fromFile ? await loadLedgersFromLocalFile() : await loadLedgersFromFirestore();
  if (ok) {
    res.json({ success: true, count: ledgersCache.ledgers.length });
  } else {
    res.status(404).json({ success: false, error: "No ledgers found in source" });
  }
});

app.get("/api/ledgers/tdl-sync", async (req, res) => {
  console.log("📥 TDL sync triggered");
  const exportPath = join(appDir, "invoices", "ledgers_tdl_export.xml");
  if (!existsSync(exportPath)) {
    if (ledgersCache && ledgersCache.ledgers && ledgersCache.ledgers.length) {
      const entries = ledgersCache.ledgers.map(n => `  <CAACCTYPENAME>${n}</CAACCTYPENAME>`).join("\n");
      const xml = `<ENVELOPE>\n<BODY>\n<EXPORTDATA>\n<REQUESTDATA>\n${entries}\n</REQUESTDATA>\n</EXPORTDATA>\n</BODY>\n</ENVELOPE>`;
      mkdirSync(join(appDir, "invoices"), { recursive: true });
      const bom = Buffer.from([0xFF, 0xFE]);
      writeFileSync(exportPath, Buffer.concat([bom, Buffer.from(xml, "utf16le")]));
      console.log(`📝 Seeded export file from cache (${ledgersCache.ledgers.length} names)`);
    } else {
      return res.json({ success: false, error: `No ledgers loaded and no export file at invoices/ledgers_tdl_export.xml.` });
    }
  }
  try {
    const buf = readFileSync(exportPath);
    const isUtf16Le = buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE;
    const xml = isUtf16Le ? buf.toString("utf16le") : buf.toString("utf8");
    let names = [];
    let m;
    const re = /<CAACCTYPENAME>([^<]+)<\/CAACCTYPENAME>/g;
    while ((m = re.exec(xml)) !== null) names.push(m[1].trim());
    if (names.length === 0) {
      const re2 = /<LEDGER\s+NAME="([^"]+)"/gi;
      while ((m = re2.exec(xml)) !== null) names.push(m[1].trim());
    }
    const uniqueNames = [...new Set(names)];
    if (!ledgersCache) {
      await loadLedgersFromFirestore() || await loadLedgersFromLocalFile();
    }
    if (!ledgersCache) {
      return res.status(503).json({ success: false, error: "No ledgers in cache. Load ledgers first via /api/ledgers" });
    }
    const existingSet = new Set((ledgersCache.ledgers || []).map(n => n.toLowerCase().trim()));
    const newNames = uniqueNames.filter(n => !existingSet.has(n.toLowerCase().trim()));
    if (newNames.length === 0) {
      console.log(`✅ TDL sync: no new ledgers (total ${ledgersCache.ledgers.length})`);
      return res.json({ success: true, newCount: 0, prevCount: ledgersCache.ledgers.length, totalCount: ledgersCache.ledgers.length, message: "No new ledgers found" });
    }
    const merged = [...(ledgersCache.ledgers || []), ...newNames];
    const json = JSON.stringify(merged);
    const compressed = zlib.gzipSync(Buffer.from(json, "utf8")).toString("base64");
    await firestoreDb.collection("config").doc("ledgers").set({
      data: compressed,
      count: merged.length,
      updatedAt: admin.firestore.Timestamp.now()
    });
    ledgersCache = { ledgers: merged, fetchedAt: Date.now() };
    console.log(`🔄 TDL sync: ${newNames.length} new ledgers added (total ${merged.length})`);
    res.json({ success: true, newCount: newNames.length, prevCount: merged.length - newNames.length, totalCount: merged.length, newNames });
  } catch (e) {
    console.error("❌ TDL sync error:", e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Bootstrap on startup
(async () => {
  await loadLedgersFromFirestore() || await loadLedgersFromLocalFile();
})();

// ==========================================
// 4. LEDGER PICKER HTML PAGE
// ==========================================

app.get("/ledger-picker", (req, res) => {
  try {
    const html = readFileSync(join(appDir, "ledger-picker.html"), "utf8");
    res.type("html").send(html);
  } catch (err) {
    res.status(500).send("ledger-picker.html not found at " + join(appDir, "ledger-picker.html"));
  }
});

app.get("/status", (req, res) => {
  res.json({ status: "ok", uptime: parseInt(process.uptime()), port: 5005, timestamp: new Date().toISOString() });
});

app.listen(5005, () => console.log("🌉 Tally Bridge (proxy + sync + sales + ledgers) running on port 5005"));

const RENDER_SALES_URL = "https://hariom-delivery-v2.onrender.com/api/sales/today";

async function fetchTodaySales() {
  const res = await fetch(RENDER_SALES_URL, {
    headers: { "x-tally-key": "123456" }
  });
  if (!res.ok) throw new Error("Server returned " + res.status);
  return res.json();
}

function splitAddress(addr, phone) {
  const lines = [];
  if (addr) {
    const parts = addr.split(",").map(s => s.trim()).filter(Boolean);
    let current = "";
    for (const p of parts) {
      if ((current + " " + p).trim().length > 45) {
        if (current) lines.push(current.trim());
        current = p;
      } else {
        current = current ? current + " " + p : p;
      }
    }
    if (current) lines.push(current.trim());
  }
  if (phone) lines.push(phone);
  return lines.map(l => `       <ADDRESS>${xmlEsc(l)}</ADDRESS>`).join("\n");
}

function xmlEsc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function buildSalesVoucherXML(sale, opts = {}) {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const customerName = (sale.customer_name || "Customer").trim();
  const usePlaceholder = opts.usePlaceholderLedger === true;
  const partyLedger = usePlaceholder ? "CUSTOMER NAME" : xmlEsc(customerName);

  const products = sale.products || [];
  let sumTaxable = 0;
  let sumCGST = 0;
  let sumSGST = 0;
  let inventoryXml = "";

  for (const p of products) {
    const pname = (p.product_name || "Item").trim();
    const inclusivePrice = parseFloat(p.quoted_price) || 0;

    const taxable = round2(inclusivePrice / 1.18);
    const gstOnProduct = round2(inclusivePrice - taxable);
    const cgst = round2(gstOnProduct / 2);
    const sgst = round2(gstOnProduct - cgst);

    sumTaxable += taxable;
    sumCGST += cgst;
    sumSGST += sgst;

    const taxableAmt = taxable.toFixed(2);
    const godownName = "Showroom";

    inventoryXml += `
            <ALLINVENTORYENTRIES.LIST>
              <STOCKITEMNAME>${usePlaceholder ? "SALE ITEM" : xmlEsc(pname)}</STOCKITEMNAME>`;
    if (usePlaceholder) {
      inventoryXml += `
              <BASICUSERDESCRIPTION.LIST TYPE="String">
              <BASICUSERDESCRIPTION>${xmlEsc(pname)}</BASICUSERDESCRIPTION>
              </BASICUSERDESCRIPTION.LIST>`;
    }
    inventoryXml += `
              <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
              <ISLASTDEEMEDPOSITIVE>No</ISLASTDEEMEDPOSITIVE>
              <RATE>${taxableAmt}/NOS</RATE>
              <AMOUNT>${taxableAmt}</AMOUNT>
              <ACTUALQTY> 1 NOS</ACTUALQTY>
              <BILLEDQTY> 1 NOS</BILLEDQTY>
              <BATCHALLOCATIONS.LIST>
                <GODOWNNAME>${xmlEsc(godownName)}</GODOWNNAME>
                <BATCHNAME>Primary Batch</BATCHNAME>
                <AMOUNT>${taxableAmt}</AMOUNT>
                <ACTUALQTY> 1 NOS</ACTUALQTY>
                <BILLEDQTY> 1 NOS</BILLEDQTY>
              </BATCHALLOCATIONS.LIST>
              <ACCOUNTINGALLOCATIONS.LIST>
                <LEDGERNAME>GST SALES @ 18%</LEDGERNAME>
                <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
                <ISLASTDEEMEDPOSITIVE>No</ISLASTDEEMEDPOSITIVE>
                <AMOUNT>${taxableAmt}</AMOUNT>
              </ACCOUNTINGALLOCATIONS.LIST>
            </ALLINVENTORYENTRIES.LIST>`;
  }


  const narration = `Customer: ${customerName}, Phone: ${sale.phone || ""}, Alt Phone: ${sale.alternate_phone || ""}, Address: ${sale.address || ""}, Sold by: ${sale.created_by_name || "staff"}`;

  const grandTotal = round2(sumTaxable + sumCGST + sumSGST);
  const roundedParty = Math.round(grandTotal);
  const roundingDiff = round2(roundedParty - grandTotal);

  let ledgerXml = `<LEDGERENTRIES.LIST>
<LEDGERNAME>${partyLedger}</LEDGERNAME>
<ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
<ISLASTDEEMEDPOSITIVE>Yes</ISLASTDEEMEDPOSITIVE>
<ISPARTYLEDGER>Yes</ISPARTYLEDGER>
<AMOUNT>-${roundedParty.toFixed(2)}</AMOUNT>
</LEDGERENTRIES.LIST>
<LEDGERENTRIES.LIST>
<LEDGERNAME>OUTPUT CGST 9%</LEDGERNAME>
<ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
<ISLASTDEEMEDPOSITIVE>No</ISLASTDEEMEDPOSITIVE>
<AMOUNT>${sumCGST.toFixed(2)}</AMOUNT>
</LEDGERENTRIES.LIST>
<LEDGERENTRIES.LIST>
<LEDGERNAME>OUTPUT SGST 9%</LEDGERNAME>
<ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
<ISLASTDEEMEDPOSITIVE>No</ISLASTDEEMEDPOSITIVE>
<AMOUNT>${sumSGST.toFixed(2)}</AMOUNT>
</LEDGERENTRIES.LIST>`;

  if (roundingDiff !== 0) {
    ledgerXml += `
<LEDGERENTRIES.LIST>
<LEDGERNAME>ROUNDING OFF</LEDGERNAME>
<ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
<ISLASTDEEMEDPOSITIVE>No</ISLASTDEEMEDPOSITIVE>
<AMOUNT>${roundingDiff.toFixed(2)}</AMOUNT>
</LEDGERENTRIES.LIST>`;
  }

  return `<ENVELOPE>
<HEADER>
<TALLYREQUEST>Import Data</TALLYREQUEST>
</HEADER>
<BODY>
<IMPORTDATA>
<REQUESTDESC>
<REPORTNAME>Vouchers</REPORTNAME>
</REQUESTDESC>
<REQUESTDATA>
<TALLYMESSAGE xmlns:UDF="TallyUDF">
<VOUCHER VCHTYPE="Purchase" ACTION="Create" OBJVIEW="Invoice Voucher View">
<DATE>${dateStr}</DATE>
<VOUCHERTYPENAME>GST SALES</VOUCHERTYPENAME>
<VOUCHERNUMBER>DMSPUSH-${Date.now()}</VOUCHERNUMBER>
<PARTYLEDGERNAME>${partyLedger}</PARTYLEDGERNAME>
<NARRATION>${xmlEsc(narration)}</NARRATION>
<ISINVOICE>Yes</ISINVOICE>
${inventoryXml}
${ledgerXml}
</VOUCHER>
</TALLYMESSAGE>
</REQUESTDATA>
</IMPORTDATA>
</BODY>
</ENVELOPE>`;
}

async function pushVoucherToTally(sale) {
  let xml = buildSalesVoucherXML(sale);
  console.log("XML sent:", xml);
  let res = await tallyFetch(xml);
  let text = await res.text();
  let created = text.includes("<CREATED>1</CREATED>");
  let exceptions = text.includes("<EXCEPTIONS>0</EXCEPTIONS>");
  let errMatch = text.match(/<LINEERROR>([^<]*)<\/LINEERROR>/);
  let errMsg = errMatch ? errMatch[1].trim() : "";

  if (created && exceptions) {
    console.log("Voucher created successfully");
    return { success: true, error: null, raw: text, xml };
  }

  console.log("First attempt failed. LineError:", errMsg || "(none)");

  // Retry once with placeholder ledger "CUSTOMER NAME"
  console.log("Retrying with placeholder ledger CUSTOMER NAME...");
  xml = buildSalesVoucherXML(sale, { usePlaceholderLedger: true });
  res = await tallyFetch(xml);
  text = await res.text();
  created = text.includes("<CREATED>1</CREATED>");
  exceptions = text.includes("<EXCEPTIONS>0</EXCEPTIONS>");
  errMatch = text.match(/<LINEERROR>([^<]*)<\/LINEERROR>/);
  errMsg = errMatch ? errMatch[1].trim() : "";

  if (created && exceptions) {
    console.log("Fallback succeeded with placeholder ledger");
    return { success: true, error: null, raw: text, xml };
  }

  console.log("Fallback also failed. LineError:", errMsg || "(none)");
  return { success: false, error: errMsg || "Tally reported exceptions (EXCEPTIONS != 0). Check Tally for details.", raw: text, xml };
}

function findSale(sales, name) {
  const lower = name.toLowerCase();
  return sales.find(s => s.customer_name.toLowerCase().includes(lower));
}

app.get("/api/create-sales-voucher", async (req, res) => {
  try {
    const customerName = (req.query.customerName || "").trim();
    if (!customerName) return res.status(400).json({ error: "customerName required" });
    console.log(`GET create-sales-voucher for: "${customerName}"`);
    const serverData = await fetchTodaySales();
    const match = findSale(serverData.sales || [], customerName);
    if (!match) return res.status(404).json({ error: `No sale found for "${customerName}"`, todaySales: (serverData.sales || []).map(s => s.customer_name) });
    const result = await pushVoucherToTally(match);
    if (result.success) return res.json({ success: true, message: `Voucher created for ${match.customer_name}` });
    return res.status(500).json({ error: result.error || "Tally rejected the voucher" });
  } catch (err) {
    console.error("create-sales-voucher error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/tdl-trigger-voucher", async (req, res) => {
  try {
    const customerName = (req.query.customerName || "").trim();
    console.log("📥 GET /api/tdl-trigger-voucher customerName:", `"${customerName}"`);
    if (!customerName) return res.json({ success: false, error: "customerName required" });
    const serverData = await fetchTodaySales();
    const match = findSale(serverData.sales || [], customerName);
    if (!match) return res.json({ success: false, error: `No sale for "${customerName}"` });
    const result = await pushVoucherToTally(match);
    res.json({ success: result.success, error: result.error || null });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

function findSaleById(sales, id) {
  const idLower = id.toLowerCase();
  return sales.find(s => (s.id || s.firestore_id || "").toLowerCase() === idLower);
}

app.get("/api/tdl-create-by-id", async (req, res) => {
  const id = (req.query.id || "").trim();
  console.log("📥 GET /api/tdl-create-by-id id:", `"${id}"`);
  if (!id) return res.json({ success: false, error: "id required" });
  // Respond immediately so Tally doesn't deadlock
  res.json({ success: true, message: "Voucher creation started" });
  // Create voucher in background
  setImmediate(async () => {
    try {
      console.log("⏳ Background: fetching today's sales...");
      const serverData = await fetchTodaySales();
      const match = findSaleById(serverData.sales || [], id);
      if (!match) { console.error("⏳ Background: no match for id:", id); return; }
      console.log("⏳ Background: creating voucher for", match.customer_name);
      const result = await pushVoucherToTally(match);
      console.log("⏳ Background: voucher result:", result.success ? "SUCCESS" : "FAILED", result.error || "");
    } catch (err) {
      console.error("⏳ Background: error:", err.message);
    }
  });
});

app.post("/api/tdl-trigger-voucher", express.text({ type: () => true, limit: "1mb" }), async (req, res) => {
  try {
    const body = req.body || "";
    console.log("📥 POST /api/tdl-trigger-voucher body length:", body.length);
    console.log("📥 Body start:", body.substring(0, 300));
    let customerName = "";
    const m1 = body.match(/<CUSTOMERNAME>([^<]*)<\/CUSTOMERNAME>/i);
    if (m1) customerName = m1[1].trim();
    if (!customerName) {
      const m2 = body.match(/<FIELD[^>]*>([^<]*)<\/FIELD>/i);
      if (m2) customerName = m2[1].trim();
    }
    if (!customerName) {
      const m3 = body.match(/<SET[^>]*>([^<]*)<\/SET>/i);
      if (m3) customerName = m3[1].trim();
    }
    console.log("📥 Extracted customerName:", `"${customerName}"`);
    if (!customerName) return res.status(400).json({ success: false, error: "customerName required" });
    const serverData = await fetchTodaySales();
    const match = findSale(serverData.sales || [], customerName);
    if (!match) return res.status(404).json({ success: false, error: `No sale for "${customerName}"` });
    const result = await pushVoucherToTally(match);
    if (result.success) return res.json({ success: true, error: null });
    res.status(500).json({ success: false, error: result.error || "Tally rejected" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/create-sales-voucher", express.text({ type: () => true, limit: "1mb" }), async (req, res) => {
  try {
    let customerName = "";
    const body = req.body;
    if (typeof body === "string") {
      const trimmed = body.trim();
      if (trimmed.startsWith("<")) {
        const match = trimmed.match(/<CUSTOMERNAME>([^<]*)<\/CUSTOMERNAME>/i);
        customerName = match ? match[1].trim() : "";
      } else if (trimmed.startsWith("{")) {
        try { const j = JSON.parse(trimmed); customerName = j.customerName || ""; } catch (_) {}
      }
    }
    if (!customerName) return res.status(400).json({ error: "customerName required" });

    console.log(`POST create-sales-voucher for: "${customerName}"`);
    const serverData = await fetchTodaySales();
    const match = findSale(serverData.sales || [], customerName);
    if (!match) return res.status(404).json({ error: `No sale found for "${customerName}"`, todaySales: (serverData.sales || []).map(s => s.customer_name) });

    const result = await pushVoucherToTally(match);
    if (result.success) {
      console.log(`Sales voucher created for ${match.customer_name}`);
      return res.json({ success: true, message: `Voucher created for ${match.customer_name}`, customerName: match.customer_name, products: match.products?.length || 0, total: Math.round(match.products.reduce((s, p) => s + (parseFloat(p.quoted_price) || 0), 0) * 100) / 100 });
    }
    return res.status(500).json({ error: result.error || "Tally rejected the voucher" });
  } catch (err) {
    console.error("create-sales-voucher error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── TDL HTTP JSONEx Collection endpoint: today's sales for popup ──
app.get("/api/tally/todays-sales", async (req, res) => {
  try {
    const serverData = await fetchTodaySales();
    const sales = (serverData.sales || []).map(s => {
      const products = s.products || [];
      const total = products.reduce((sum, p) => sum + (parseFloat(p.quoted_price) || 0), 0);
      const gst = Math.round(total * 0.18 * 100) / 100;
      const itemsText = products.map(p => (p.product_name || "Item") + " x " + (parseFloat(p.quoted_price) || 0).toFixed(0)).join(", ");
      const firstProduct = products[0] || {};
      return {
        CustomerName: s.customer_name || "Unknown",
        DMSRefID: s.id || s.firestore_id || "",
        CustomerPhone: s.phone || "",
        TotalSaleAmount: (total + gst).toFixed(0),
        ProductDetails: itemsText,
        ProductName: firstProduct.product_name || "",
        ProductPrice: (parseFloat(firstProduct.quoted_price) || 0).toFixed(0),
        CreatedByName: s.created_by_name || ""
      };
    });
    res.json({ items: sales });
  } catch (err) {
    console.error("/api/tally/todays-sales error:", err.message);
    res.status(500).json({ items: [] });
  }
});

// ── TDL calls this to open browser with Today's Sales page ──
app.post("/api/open-browser", express.text({ type: () => true, limit: "1kb" }), (req, res) => {
  const url = "http://127.0.0.1:5000/api/sales/today-ui";
  exec(`start "" "${url}"`, error => {
    if (error) {
      console.error("open-browser error:", error.message);
      return res.status(500).send("<HTML><H1>ERROR: " + error.message + "</H1></HTML>");
    }
    console.log("Browser opened to", url);
    res.send("<HTML><H1>Today's Sales page opened in your browser.</H1></HTML>");
  });
});

// ── Test endpoint: create a test sales voucher with known party ──
app.post("/api/test-tally", express.text({ type: () => true, limit: "1kb" }), async (req, res) => {
  try {
    let body = req.body || "";
    let customerName = "CHAUHAN AMIT J.";
    if (typeof body === "string") {
      const t = body.trim();
      if (t.startsWith("<")) {
        const m = t.match(/<CUSTOMERNAME>([^<]*)<\/CUSTOMERNAME>/i);
        if (m) customerName = m[1].trim();
      } else if (t.startsWith("{")) {
        try { const j = JSON.parse(t); if (j.customerName) customerName = j.customerName; } catch (_) {}
      }
    }
    const fakeSale = {
      customer_name: customerName,
      phone: "9999999999",
      created_by_name: "Tally Test",
      products: [
        { product_name: "LED BPL 32H-A4300 (SMART)", quoted_price: "14500" }
      ]
    };
    const result = await pushVoucherToTally(fakeSale);
    console.log("RAW TALLY RESPONSE:", result.raw);
    if (result.success) {
      console.log(`Test voucher created for ${customerName}`);
      return res.send(`<HTML><H1>Test voucher created for ${customerName}</H1></HTML>`);
    }
    res.status(500).send(`<HTML><H1>Tally rejected: ${result.error || "Unknown"}</H1><pre>${result.error}</pre><hr><pre>${result.xml}</pre></HTML>`);
  } catch (err) {
    console.error("test-tally error:", err.message);
    res.status(500).send(`<HTML><H1>Error: ${err.message}</H1></HTML>`);
  }
});
