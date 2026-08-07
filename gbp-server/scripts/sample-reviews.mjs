// Smoke-test for the review generator (gbp-server).
// Prints English / Hindi / Marathi drafts across variations and confirms
// outputs differ on identical input (anti-lookalike "X-factor" proof).
//
// Usage:  node scripts/sample-reviews.mjs          (uses gbp-server/.env for GROQ_API_KEY)
//         GROQ_API_KEY=... node scripts/sample-reviews.mjs
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(__dirname, "..");

// Load gbp-server/.env if present (only GROQ_API_KEY is needed here).
const envPath = path.join(serverDir, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[1] === "GROQ_API_KEY" && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

if (!process.env.GROQ_API_KEY) {
  console.error("GROQ_API_KEY not found (checked env and gbp-server/.env). Aborting.");
  process.exit(1);
}

const { generateCuratedReview } = await import(
  pathToFileURL(path.join(serverDir, "dist", "services", "ai.js")).href
);

const BASE = {
  storeName: "Hariom Electronics",
  category: "Mobile",
  brand: "Samsung",
  experiences: ["Value for money", "Knowledgeable staff", "Fast delivery", "After-sales support"],
};

function words(s) {
  return s.trim().split(/\s+/).length;
}

function latinLeakRatio(text) {
  const known = new Set([
    "samsung", "lg", "sony", "haier", "voltas", "whirlpool", "godrej", "ifb", "hp", "dell",
    "lenovo", "apple", "oneplus", "vivo", "oppo", "xiaomi", "redmi", "realme", "mi", "nokia",
    "panasonic", "bosch", "tv", "led", "oled", "ac", "fridge", "refrigerator", "washing",
    "machine", "microwave", "geyser", "fan", "laptop", "mobile", "smartphone", "phone",
    "model", "models", "corner", "shoppee", "shoppe", "shope", "store", "delivery",
    "service", "inverter", "window", "split", "2k", "4k", "inch", "wifi", "apps", "app",
    "online", "offline", "whatsapp", "instagram", "facebook", "sale", "offer", "emi", "gst",
    "webasto", "electrolux", "blue", "star", "cm", "kg", "ltr", "lt", "bhp",
  ]);
  const wordsArr = text.split(/[\s,.;:!?()]+/);
  let latin = 0;
  let dev = 0;
  for (const w of wordsArr) {
    if (known.has(w.toLowerCase())) continue;
    for (const ch of w) {
      if (/[\u0900-\u097F]/.test(ch)) dev++;
      else if (/[a-zA-Z]/.test(ch)) latin++;
    }
  }
  return latin + dev === 0 ? (latin > 0 ? 1 : 0) : latin / (latin + dev);
}

function contentWords(s) {
  const stop = new Set([
    "the", "a", "an", "and", "or", "but", "if", "for", "to", "from", "of", "in", "on", "at",
    "by", "with", "as", "is", "are", "was", "were", "be", "it", "its", "this", "that", "i",
    "me", "my", "we", "our", "you", "your", "he", "she", "his", "her", "they", "them",
    "their", "there", "here", "not", "no", "so", "too", "very", "just", "also", "really",
    "had", "have", "has", "did", "do", "does", "will", "would", "can", "could", "get",
    "got", "go", "went", "shop", "store", "day", "time", "made", "make", "bought", "buy",
    "took", "come", "came", "said", "know", "even", "now", "still", "up", "down", "out",
    "again", "then", "than", "all", "some", "any", "more", "most", "other", "every", "few",
    "own", "same", "only", "back", "well", "way", "place", "bit", "lot", "much", "many",
    "actually", "honestly", "overall", "end", "next", "first", "last", "good", "great",
    "nice", "really", "fair", "right", "okay", "also",
  ]);
  return new Set(
    s
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w && !stop.has(w))
  );
}

function jaccard(a, b) {
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

async function run(label, params, extra = "") {
  const t0 = Date.now();
  try {
    const text = await generateCuratedReview({ ...BASE, ...params });
    const ms = Date.now() - t0;
    const leak = params.language && params.language !== "english" ? latinLeakRatio(text) : 0;
    console.log(`\n── ${label} (${words(text)} words, ${ms}ms)${extra}${params.language && params.language !== "english" ? `  latin-leak=${leak.toFixed(2)}` : ""}`);
    console.log(text);
  } catch (e) {
    console.log(`\n── ${label} ❌ ${e.message}`);
  }
}

const scenarios = [
  ["EN standard", { language: "english", variation: "standard" }],
  ["EN with sub-firm + salesman", { language: "english", variation: "standard", subFirmName: "Corner Mobile Shoppee", salesmanName: "Rahul" }],
  ["EN detailed", { language: "english", variation: "detailed" }],
  ["EN short", { language: "english", variation: "short" }],
  ["हिंदी standard", { language: "hindi", variation: "standard" }],
  ["हिंदी with sub-firm + salesman", { language: "hindi", variation: "standard", subFirmName: "Corner Mobile Shoppee", salesmanName: "Rahul" }],
  ["मराठी standard", { language: "marathi", variation: "standard" }],
  ["मराठी casual", { language: "marathi", variation: "casual" }],
];

for (const [label, params] of scenarios) {
  await run(label, params);
}

// Diversity check: identical input twice should produce visibly different reviews.
console.log("\n\n════ DIVERSITY CHECK (identical input, two runs) ════");
const [a, b] = [
  await generateCuratedReview({ ...BASE, language: "english", variation: "standard" }),
  await generateCuratedReview({ ...BASE, language: "english", variation: "standard" }),
];
const sim = jaccard(contentWords(a), contentWords(b));
console.log(`\nRun 1 (${words(a)} words):\n${a}`);
console.log(`\nRun 2 (${words(b)} words):\n${b}`);
console.log(`\nContent-word similarity (Jaccard) = ${sim.toFixed(2)}  (lower = more different; expect < ~0.5)`);
console.log(sim < 0.5 ? "✅ Reviews differ enough." : "⚠️ Similar — may need a different preset.");
