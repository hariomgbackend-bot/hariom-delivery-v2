import express from "express";
import fetch from "node-fetch";
import cors from "cors";

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

app.listen(5005, () => console.log("🌉 Tally Bridge (proxy + sync) running on port 5005"));
