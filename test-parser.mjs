import { readFileSync, readdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import Groq from "groq-sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INVOICES_DIR = join(__dirname, "invoices");

const groq = process.env.GROQ_API_KEY
  ? new Groq({ apiKey: process.env.GROQ_API_KEY })
  : null;

// ═══════════════════════════════════════════════════
// Copy of parseRelianceInvoice from server.js:4143
// ═══════════════════════════════════════════════════
function parseRelianceInvoice(text) {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  let invNo = "", invDate = "", vendor = "RELIANCE RETAIL LIMITED";
  for (const l of lines) {
    let m = l.match(/Tax Invoice No\s*:\s*(\S+?)(?:\s*Date|\s|$)/);
    if (m) invNo = m[1];
    m = l.match(/Date\s*:\s*(\d{2})-(\d{2})-(\d{4})/);
    if (m) invDate = `${m[3]}-${m[2]}-${m[1]}`;
  }

  const srIdx = lines.findIndex(l => l.includes("Sr.No."));
  if (srIdx === -1) return null;
  const discIdx = lines.findIndex((l, i) => i >= srIdx && l.includes("DiscountAmount"));
  if (discIdx === -1) return null;
  const totalIdx = lines.findIndex((l, i) => i > discIdx &&
    (l.includes("Total Amount") || l.includes("Tax Summary")));
  const dataEnd = totalIdx !== -1 ? totalIdx : lines.length;
  const dataLines = lines.slice(discIdx + 1, dataEnd);

  const slashIdxArr = [];
  for (let i = 0; i < dataLines.length; i++) {
    if (dataLines[i].includes("/")) slashIdxArr.push(i);
  }
  if (slashIdxArr.length === 0) return null;

  const skuMatch = text.match(/Total no\. of SKUs\s*:\s*(\d+)/);
  const expectedN = skuMatch ? parseInt(skuMatch[1], 10) : 0;

  function extractDescFromSlashLine(line) {
    const m = line.match(/\d+\s*\/\s*\d+([A-Za-z].*)/);
    return m ? m[1].trim() : "";
  }

  const IS_SERIAL = l => /^[A-Za-z0-9][A-Za-z0-9\-]{5,}$/.test(l) && !l.includes(" ") &&
    /[A-Za-z]/.test(l) && /\d/.test(l);

  const items = [];
  for (let s = 0; s < slashIdxArr.length; s++) {
    const slashIdx = slashIdxArr[s];
    const nextSlash = s + 1 < slashIdxArr.length ? slashIdxArr[s + 1] : dataLines.length;

    let blockStart = slashIdx;
    if (slashIdx > 0 && /^\d+$/.test(dataLines[slashIdx - 1])) {
      blockStart = slashIdx - 1;
    }
    let blockEnd = nextSlash;
    if (nextSlash > 0 && /^\d+$/.test(dataLines[nextSlash - 1])) {
      const pn = parseInt(dataLines[nextSlash - 1], 10);
      if (pn >= 1 && pn <= expectedN) blockEnd = nextSlash - 1;
    }
    if (items.length > 0) {
      const prevEnd = items[items.length - 1]._endIdx;
      if (prevEnd > blockStart) blockStart = prevEnd;
    }

    const chunk = dataLines.slice(blockStart, blockEnd);
    const rawSrParts = [];
    for (const l of chunk) {
      if (/^\d+$/.test(l) || l.includes("/") || /^\d{8,}$/.test(l)) {
        rawSrParts.push(l);
      } else break;
    }
    const srNoRaw = rawSrParts.join(" ");

    let descFromSlash = "";
    const slashLine = chunk.find(l => l.includes("/"));
    if (slashLine) descFromSlash = extractDescFromSlashLine(slashLine);

    let di = 0;
    while (di < chunk.length &&
           (/^\d+$/.test(chunk[di]) || chunk[di].includes("/") || /^\d{8,}$/.test(chunk[di]))) {
      di++;
    }

    const descLines = descFromSlash ? [descFromSlash] : [];
    let serialStr = "";
    let tailStr = "";
    let stage = descFromSlash ? "serial" : "desc";
    let inlineDesc = "";

    for (let scanIdx = di; scanIdx < chunk.length; scanIdx++) {
      let l = chunk[scanIdx];
      // Find the tail line.
      // Pure digits+commas: HSN is always at position 0 (no serial prefix).
      // With letters: scan backwards for HSN(8)+qty(1), rejecting any where
      //   the qty exceeds Total SKUs count (serial suffix bleeds into HSN).
      const commaVals = [...l.matchAll(/\d{1,3},\d{3}/g)];
      if (commaVals.length >= 1 || l.includes(",")) {
        if (/^[\d,]+$/.test(l)) {
          tailStr = l;
        } else {
          for (let i = l.length - 9; i >= 0; i--) {
            if (!/^\d{9}$/.test(l.slice(i, i + 9))) continue;
            if (l[i + 9] === ",") continue;
            if (expectedN > 0) {
              const qtyDigit = parseInt(l[i + 8], 10);
              if (qtyDigit > expectedN) continue;
            }
            inlineDesc = l.slice(0, i).trim();
            tailStr = l.slice(i);
            break;
          }
          if (!tailStr) tailStr = l;
        }
        break;
      }

      if (stage === "desc") {
        if (descLines.length > 0 && descLines[descLines.length - 1].endsWith("-")) {
          descLines[descLines.length - 1] = descLines[descLines.length - 1].replace(/-$/, "").trimEnd() + " " + l.trimStart();
          continue;
        }
        if (IS_SERIAL(l)) { serialStr = l; stage = "skip"; continue; }
        if (/^\d{4,}$/.test(l) && l.length < 12) { serialStr = l; stage = "skip"; continue; }
        descLines.push(l);
      } else if (stage === "serial") {
        if (IS_SERIAL(l)) { serialStr = l; stage = "skip"; continue; }
        if (!/^\d+$/.test(l) && !/^\d{8,}$/.test(l)) { descLines.push(l); }
      } else if (stage === "skip") {
        serialStr += l; continue;
      }
    }

    if (inlineDesc) {
      if (!serialStr) {
        serialStr = inlineDesc;
      } else {
        descLines.push(inlineDesc);
      }
    }
    if (!tailStr) {
      for (let i = chunk.length - 1; i >= 0; i--) {
        if (chunk[i].includes(",")) { tailStr = chunk[i]; break; }
      }
    }

    const description = descLines.join(" ").trim().replace(/\s+/g, " ");
    let qty = 1, unitPrice = 0, amount = 0, discount = 0;
    if (tailStr) {
      const hm = tailStr.match(/^(\d{8})(\d)/);
      if (hm) {
        qty = parseInt(hm[2], 10) || 1;
        const rest = tailStr.slice(hm[0].length);
        const commaVals = Array.from(rest.matchAll(/\d{1,3},\d{3}/g));
        if (commaVals.length >= 1) {
          const last = commaVals[commaVals.length - 1];
          amount = parseInt(last[0].replace(/,/g, ""), 10);
        }
        if (commaVals.length >= 2) {
          const slm = commaVals[commaVals.length - 2];
          unitPrice = parseInt(slm[0].replace(/,/g, ""), 10);
          const btwn = rest.slice(slm.index + slm[0].length,
            commaVals[commaVals.length - 1].index);
          discount = parseInt(btwn, 10) || 0;
        } else if (commaVals.length === 1) {
          unitPrice = amount;
        }
      }
    }

    items.push({
      description,
      serialNumbers: serialStr ? [serialStr] : [],
      qty,
      rate: Math.round((unitPrice / 1.18) * 100) / 100,
      amount, discount, gstRate: 18, srNoRaw, _endIdx: blockEnd
    });
  }

  const taxMatch = text.match(/Total Taxable Amount\s*:\s*([\d,]+\.?\d*)/);
  const totalTaxable = taxMatch ? parseFloat(taxMatch[1].replace(/,/g, "")) : null;
  const sameAmt = items.length > 0 && items.every(it => it.amount === items[0].amount);
  if (totalTaxable && sameAmt && items.length > 0) {
    const perItem = Math.round((totalTaxable / items.length) * 100) / 100;
    items.forEach(it => { it.rate = perItem; });
  }

  for (const it of items) { delete it._endIdx; delete it.amount; delete it.discount; }
  return { invoiceNumber: invNo, invoiceDate: invDate, vendorName: vendor, items };
}

// ═══════════════════════════════════════════════════
// Copy of GROQ_EXTRACT_PROMPT + extractWithGroqText
// ═══════════════════════════════════════════════════
const GROQ_EXTRACT_PROMPT = `You are a professional GST invoice data extractor for an Indian electronics retailer.
Output ONLY valid JSON — no markdown, no explanation.

EXTRACTION RULES:
1. invoiceNumber: the supplier's own invoice/bill number (e.g. KM/1576, H26-27/1126, SLS2700497)
2. invoiceDate: YYYY-MM-DD format
3. vendorName: the seller/supplier company name (NOT "Hariom Electronics" — that is the buyer)
4. items[]: one entry per LINE ITEM in the invoice table. Each item:
   - description: full product name/model as printed (e.g. "SURYA ACC 3B TRIO SS DT", "Samsung Refrigerator DC RR21H2H25BB/HL")
   - qty: numeric quantity (e.g. 4, 10, 2) — "nos", "pcs", "pc" are units not quantities
   - rate: base price per unit EXCLUDING GST. If only taxable amount shown, divide by qty.
           If discount applied, use the post-discount taxable rate.
           Taxable Amount / qty = rate.
   - gstRate: total GST % as integer (5, 12, 18, or 28). CGST 9% + SGST 9% = 18%.
   - serialNumbers: array of serial/IMEI numbers for this item. Can be listed below description,
     as bullet points, or handwritten. Each S/N is a separate string. Empty array if none.

COMMON MISTAKES TO AVOID:
- "rate" must be TAXABLE (ex-GST) value per unit, never the total row amount
- If invoice shows "Taxable Amount" column, that is qty×rate — divide by qty to get rate
- Discount % is already applied in taxable amount — do not re-apply it
- S/Nos on Novel/Samsung invoices are listed as "06274PAL400887" style codes under description
- Handwritten S/Nos (like on Nayan Electronics invoices) must also be captured
- GST rate 9%+9% = 18%, never "9"`;

async function extractWithGroqText(rawText) {
  if (!groq) return null;
  const completion = await groq.chat.completions.create({
    messages: [
      { role: "system", content: GROQ_EXTRACT_PROMPT },
      { role: "user",   content: `Extract invoice data from this text and return JSON with keys: invoiceNumber, invoiceDate, vendorName, items[].

<INVOICE_TEXT>
${rawText}
</INVOICE_TEXT>` }
    ],
    model: "llama-3.3-70b-versatile",
    temperature: 0,
    response_format: { type: "json_object" }
  });
  const raw = completion.choices[0].message.content.replace(/```json/gi,"").replace(/```/g,"").trim();
  return JSON.parse(raw);
}

// ═══════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════
function fmt(x) { return JSON.stringify(x, null, 2); }

function truncate(s, n = 2000) {
  if (!s) return "(empty)";
  if (s.length <= n) return s;
  return s.slice(0, n) + `\n… (truncated, ${s.length} total chars)`;
}

function divider(title) {
  const w = 78;
  const side = Math.max(1, Math.floor((w - title.length - 2) / 2));
  console.log("\n" + "═".repeat(side) + " " + title + " " + "═".repeat(side));
}

function shortLine(s, max = 60) {
  if (!s) return "—";
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + "...";
}

// ═══════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════
async function main() {
  const files = readdirSync(INVOICES_DIR).filter(f => f.endsWith(".pdf")).sort();
  if (!files.length) {
    console.log("No PDF files found in", INVOICES_DIR);
    process.exit(0);
  }
  console.log(`Found ${files.length} invoice PDF(s)\n`);
  if (!groq) console.warn("⚠️  GROQ_API_KEY not set — Groq text extraction will be SKIPPED.\n");

  const report = [];

  for (const file of files) {
    divider(file);
    const filePath = join(INVOICES_DIR, file);
    const buf = readFileSync(filePath);

    let rawText, pdfMeta;
    try {
      const parsed = await pdfParse(buf);
      rawText = parsed.text;
      pdfMeta = { pages: parsed.numpages, version: parsed.pdfVersion };
    } catch (e) {
      console.log(`❌ PDF parse error: ${e.message}`);
      report.push({ file, error: `PDF parse: ${e.message}` });
      continue;
    }

    console.log(`Pages: ${pdfMeta.pages}, Text length: ${rawText.length} chars`);
    console.log(`\n── Raw text (first 2000 chars) ──`);
    console.log(truncate(rawText, 2000));
    console.log(`────────────────────────────────`);

    const isReliance = rawText.includes("RELIANCE RETAIL LIMITED") && rawText.includes("Tax Invoice No");
    let result = null;
    let parserUsed = "";

    // Try deterministic parser
    if (isReliance) {
      console.log("\n🏷️  Detected Reliance invoice — trying deterministic parser...");
      result = parseRelianceInvoice(rawText);
      if (result && result.items?.length) {
        parserUsed = "deterministic";
        console.log(`✅ Parsed: ${result.items.length} items, inv# ${result.invoiceNumber || "—"}`);
      } else {
        console.log("⚠️  Deterministic parser returned null/empty — will try Groq");
      }
    } else {
      console.log("\n🧠 Non-Reliance invoice — deterministic parser not applicable");
    }

    // Fallback to Groq text extraction
    if (!result && groq) {
      console.log("🤖 Trying Groq text extraction (llama-3.3-70b)...");
      try {
        result = await extractWithGroqText(rawText);
        parserUsed = "groq-text";
        console.log(`✅ Groq parsed: ${result?.items?.length || 0} items, vendor: ${result?.vendorName || "?"}`);
      } catch (e) {
        console.log(`❌ Groq extraction failed: ${e.message}`);
      }
    } else if (!result && !groq) {
      console.log("⏭️  Groq skipped (no API key)");
    }

    // Output item details
    if (result?.items?.length) {
      console.log(`\n── Items (${result.items.length}) ──`);
      result.items.forEach((it, i) => {
        const sers = it.serialNumbers?.length ? it.serialNumbers.join(", ") : "—";
        console.log(`  #${i+1}: ${shortLine(it.description, 50)}`);
        console.log(`       qty:${it.qty}  rate:${it.rate}  gst:${it.gstRate}%  s/n:[${sers}]`);
      });
      console.log(`────────────────`);
    } else if (!result) {
      console.log("❌ No result from any parser");
    }

    report.push({
      file,
      pages: pdfMeta.pages,
      textLength: rawText.length,
      isReliance,
      parserUsed: parserUsed || "none",
      parsed: !!result,
      ...(result ? {
        invoiceNumber: result.invoiceNumber,
        invoiceDate: result.invoiceDate,
        vendorName: result.vendorName,
        itemCount: result.items?.length || 0,
        items: result.items?.map(it => ({
          description: it.description,
          qty: it.qty,
          rate: it.rate,
          gstRate: it.gstRate,
          serialNumbers: it.serialNumbers || []
        }))
      } : {})
    });
  }

  // ── Summary table ──
  divider("SUMMARY");
  console.log("  File".padEnd(42) + "Parser".padEnd(16) + "Items  Vendor");
  console.log("  " + "—".repeat(76));
  for (const r of report) {
    const file = r.file.padEnd(40);
    const parser = r.parserUsed.padEnd(14);
    const items = (r.itemCount ?? "—").toString().padEnd(5);
    const vendor = r.vendorName ? shortLine(r.vendorName, 20) : (r.error ? "ERROR" : "—");
    const icon = r.parsed ? "✅" : "❌";
    console.log(`  ${icon} ${file} ${parser} ${items} ${vendor}`);
  }

  // Write JSON report
  const reportPath = join(__dirname, "extraction-report.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n📄 Full report written to extraction-report.json`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
