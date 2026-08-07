import Groq from "groq-sdk";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { GbpReview, ReviewReplyRule } from "../types.js";

const log = logger("ai");

// llama-3.3-70b-versatile and llama-3.1-8b-instant were deprecated on Groq
// (shutdown 16 Aug 2026). gpt-oss-120b / gpt-oss-20b are the recommended
// replacements; qwen3.6-27b remains the best Devanagari (Hindi/Marathi) model.
const DEFAULT_MODEL = "openai/gpt-oss-120b";
const INDIC_MODEL = "qwen/qwen3.6-27b"; // far better Devanagari grammar for Hindi/Marathi
const HIGH_CAPACITY_FALLBACK = "openai/gpt-oss-20b"; // rarely queue-full

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RETRYABLE_STATUS = new Set([429, 500, 503]);

let _client: Groq | null = null;

function getClient(): Groq {
  if (_client) return _client;
  if (!config.groqApiKey) {
    throw new Error("GROQ_API_KEY not configured");
  }
  _client = new Groq({ apiKey: config.groqApiKey });
  return _client;
}

export interface ReplyGenerationParams {
  review: Pick<GbpReview, "author" | "rating" | "comment">;
  locationName: string;
  rules?: ReviewReplyRule[];
  tone?: string;
}

/**
 * Generate a review reply using Groq LLM.
 */
export async function generateReply({
  review,
  locationName,
  rules = [],
  tone = "professional and friendly",
}: ReplyGenerationParams): Promise<string> {
  const client = getClient();

  const activeRules = rules.filter((r) => r.enabled && r.prompt);

  const ratingBucket =
    review.rating >= 4 ? "positive" : review.rating === 3 ? "neutral" : "negative";

  const systemPrompt = [
    `You are a Google Business Profile reply assistant for "${locationName}", a business in India.`,
    `Write a concise, human-sounding reply to a customer's Google review (max 120 words, 2-4 sentences).`,
    `Tone: ${tone}.`,
    `Do NOT use placeholders like [Business Name].`,
    `Address the reviewer by name.`,
    `For positive reviews: thank the customer warmly and invite them back.`,
    `For neutral reviews: acknowledge feedback and offer help.`,
    `For negative reviews: apologize sincerely, address the specific issue mentioned, and invite the customer to contact the store to resolve it offline. Never argue.`,
  ].join(" ");

  let userPrompt = [
    `Customer name: ${review.author}`,
    `Rating: ${review.rating}/5 (${ratingBucket})`,
    `Review text: "${review.comment}"`,
  ].join("\n");

  if (activeRules.length > 0) {
    const ruleText = activeRules
      .filter((r) => review.rating >= r.minRating && review.rating <= r.maxRating)
      .map((r) => r.prompt)
      .join("\n");
    if (ruleText.trim()) {
      userPrompt += `\n\nFollow this instruction/rule from the business owner:\n${ruleText}`;
    }
  }

  try {
    let reply = "";
    for (const model of [DEFAULT_MODEL, HIGH_CAPACITY_FALLBACK]) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await client.chat.completions.create({
            model,
            temperature: 0.7,
            max_tokens: 220,
            reasoning_effort: "low",
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
          });
          const content = res.choices?.[0]?.message?.content?.trim() || "";
          if (content) reply = content;
          break;
        } catch (e) {
          if (RETRYABLE_STATUS.has((e as { status?: number })?.status as number)) {
            await sleep(600 * Math.pow(2, attempt));
            continue;
          }
          if (modelUnavailable(e)) break; // try next model in the order
          throw e;
        }
      }
      if (reply) break;
    }
    if (!reply) {
      throw new Error("Groq request failed after retries");
    }
    return reply;
  } catch (e) {
    log.warn("generateReply failed", e);
    throw e;
  }
}

export type Sentiment = "positive" | "neutral" | "negative";

export type ReviewVariation = "standard" | "short" | "casual" | "detailed";

export interface CuratedReviewParams {
  storeName: string;
  category?: string;
  brand?: string;
  experiences: string[];
  customText?: string;
  customerName?: string;
  language?: "english" | "hindi" | "marathi";
  variation?: ReviewVariation;
  /** When set, the review clearly mentions this sub-firm (e.g. a mobile shop inside the store). */
  subFirmName?: string;
  /** When set, the review mentions this salesman by name as the person who helped. */
  salesmanName?: string;
}

/* ════════════════════════════════════════════════════════════════════
   Prompt building
   ════════════════════════════════════════════════════════════════════ */

const VARIATION_MODIFIERS: Record<ReviewVariation, string> = {
  standard:
    "Length: 3-5 short sentences, about 40-60 words. Short and natural — like a quick honest Google review a busy person actually posts. Do not pad it.",
  short:
    "Length: STRICTLY 2-3 short sentences, no more than 35 words total. Cut every extra detail — one quick mention of what you bought and one good thing about the service is enough. Stop right after the key points.",
  casual:
    "Make it CASUAL and chatty, like a quick note to a friend on WhatsApp. Short sentences, relaxed everyday words. Length: about 50-70 words.",
  detailed:
    "Length: about 80-100 words, still in a few short sentences. Add concrete but generic specifics about the product, the guidance the staff gave, and the service after the sale.",
};

// Budgets include generous headroom for gpt-oss reasoning before content, so
// short/detailed outputs never truncate mid-sentence.
const VARIATION_MAX_TOKENS: Record<ReviewVariation, number> = {
  standard: 300,
  short: 300,
  casual: 340,
  detailed: 420,
};

const LANGUAGE_INSTRUCTION: Record<"english" | "hindi" | "marathi", string> = {
  english: "Write entirely in English.",
  hindi: `Write entirely in Hindi using Devanagari script (हिंदी), but make it SOUND CASUAL — like a person typing a quick message to a friend, not writing an essay:
- Use short, simple, everyday sentences. Keep the tone light and chatty — बहुत अच्छा लगा, सच में, बस, आख़िरकार जैसे स्वाभाविक शब्दों से लिखो.
- Colloquial markers that sound natural in spoken Hindi: सच में, यार (sparingly), बहुत, आराम से, ईमानदारी से, साफ़-साफ़, अच्छा लगा, बढ़िया, मज़ा आया.
- Never sound like Google Translate or a textbook. Awkward-but-natural beats perfect-but-stiff.
- Correct gendered verb/noun agreement and natural word order, but write the way a native speaker actually talks rather than strict textbook Hindi.
- Keep brand, firm, and person names in English/Latin script.
- No Roman-script Hindi and no English words except brand/firm/person names.
- Never invent words: if you are not fully sure a Hindi word exists, use a simpler everyday Hindi word you are certain is correct.`,
  marathi: `Write entirely in Marathi using Devanagari script (मराठी), but make it SOUND CASUAL — like a person typing a quick message to a friend, not writing an essay:
- Use short, simple, everyday sentences. Keep the tone light and chatty — छान, खरंच, बघा, म्हणजे, आता, जरा, हो, सगळं असं नैसर्गिक शब्द वापर.
- Colloquial markers that sound natural in spoken Marathi: खरंच, अगदी, बघा, आता, थोडं, जरा, सगळं ठीक, मस्त, आवडलं, म्हणजे.
- Never sound like Google Translate or a textbook. Awkward-but-natural beats perfect-but-stiff.
- Correct gendered verb/noun agreement and natural word order, but write the way a native speaker actually talks rather than strict textbook Marathi.
- Keep brand, firm, and person names in English/Latin script.
- No Roman-script Marathi and no English words except brand/firm/person names.
- Never invent words: if you are not fully sure a Marathi word exists, use a simpler everyday Marathi word you are certain is correct.`,
};

// 2-3 varied style references per language so a random one is picked each time.
const NON_EN_EXAMPLES: Record<"hindi" | "marathi", string[]> = {
  hindi: [
    `Example (standard, casual):
"पहले तो दुकान देखकर ही अच्छा लगा, सब कुछ साफ़-सुथरा। स्टाफ ने बहुत धैर्य से समझाया कि कौन सा फ्रिज मेरे घर के लिए सही रहेगा। Samsung का मॉडल भी अच्छे दाम में मिल गया। डिलीवरी के समय लड़के ने फ्रिज लगाकर पूरा इस्तेमाल समझाया। कुल मिलाकर बढ़िया रहा, ज़रूरत पड़े तो फिर यहीं आऊँगा।"`,
    `Example (short, casual):
"दुकान में गया तो स्टाफ ने तुरंत ध्यान दिया। Samsung वाला phone चाहिए था, दो-तीन मॉडल दिखाकर फ़ायदा-नुकसान समझा दिया। कीमत भी ठीक रही। वापस ज़रूर आऊँगा।"`,
    `Example (weaving a firm and a salesman, casual):
"मुझे अपना phone Corner Mobile Shoppee से ही लेना था और वो यहाँ अंदर ही है। राहुल भाई ने बहुत अच्छे से समझाया कि कौन सा मॉडल लेना चाहिए। कीमत उचित थी और बिल भी साफ़-साफ़ मिला। अच्छा अनुभव रहा।"`,
  ],
  marathi: [
    `Example (standard, casual):
"दुकानात गेलो तेव्हा स्टाफने लगेच लक्ष दिलं. कितीही प्रश्न विचारले तरी अगदी शांतपणे समजावलं आणि घराला कोणता refrigerator चांगला पडेल हेही सांगितलं. Samsung चा model सुद्धा छान दामात मिळाला. डिलिव्हरीच्या वेळी बॉयने फ्रिज बसवून संपूर्ण माहिती दिली. एकूण अनुभव खूप छान होता, पुन्हा गरज पडली तर नक्की इथेच येईन."`,
    `Example (short, casual):
"दुकानात गेलो तेव्हा लगेच विचारलं काय हवंय. Samsung चा phone दाखवून चांगलं समजावलं. दाम देखील योग्य होता. पुन्हा नक्की येईन."`,
    `Example (weaving a firm and a salesman, casual):
"मला phone Corner Mobile Shoppee मधूनच घ्यायचा होता आणि ते इथेच दुकानात आहे. अभिजीतने कोणता मॉडल घ्यावा हे छान समजावलं. किंमत उचित होती आणि बिल सुद्धा स्पष्ट होतं. छान अनुभव होता."`,
  ],
};

const COMMON_ANTI_AI: string[] = [
  `Mix short and long sentences. Vary how you begin sentences — do NOT start every sentence with "I".`,
  `Avoid clichés and buzzwords like "Overall", "highly recommend", "seamless", "gem", "amazing experience".`,
  `Do NOT begin the review with "I recently...", "I recently bought/purchased...", or "I bought a ... for my home".`,
  `The first sentence must not mention the product or the brand — get to those later in the review.`,
  `Do NOT use emojis, hashtags, or placeholders like [Store Name].`,
  `Do NOT invent specific facts: prices, dates, staff names (other than the salesman given), or product faults.`,
  `Sound like a modest real person typing quickly — not a marketing ad. Occasional casual phrasing is fine.`,
  `Do not be uniformly glowing; one mild honest observation is okay as long as it does not invent facts.`,
  `Write like a normal Google review a customer would type in two minutes — imperfect flow is fine.`,
  `Do NOT sign the review or add your name at the end.`,
];

/* ════════════════════════════════════════════════════════════════════
   "X-factor" randomized pools — drawn fresh per request so consecutive
   reviews differ in opening, structure, and detail.
   ════════════════════════════════════════════════════════════════════ */

const OPENING_STYLES: string[] = [
  "Honestly, I was not sure where to start looking, but the staff here made it simple.",
  "This is one of those shops you end up recommending without being asked.",
  "Kept putting off the purchase until I finally visited this place.",
  "A friend told me to check this store out, and I'm glad I did.",
  "Between the prices and the service, this place really stands out.",
  "I usually compare online first, but this time the shop just made sense.",
  "Was a bit hesitant because it is a local shop, but that changed fast.",
  "Walked in with a rough idea and walked out with exactly what I needed.",
  "Three shops in one day — this was the only one where I felt comfortable.",
  "Did not expect to buy anything, but the deal was hard to say no to.",
  "The shop is easy to miss from the road, but it is worth finding.",
  "Been passing by this store for months and finally stepped in.",
  "I came for a small thing and ended up getting good advice too.",
  "If you are tired of pushy salesmen, this place is the opposite.",
  "Called ahead, reached quickly, and the whole thing was painless.",
  "My family has bought here before, so I trusted it from the start.",
  "For the price I paid, I did not expect this kind of attention.",
  "I went with a list of doubts; came out with everything answered.",
  "Not the flashiest shop in town, but the service is what counts.",
  "The shop was busy, yet nobody made me feel rushed.",
  "A relative in the area recommended it, and it held up.",
  "First time here, and honestly I was pleasantly surprised.",
  "The whole buying experience took less time than I expected.",
  "I have had mixed luck with electronics shops, so this was a relief.",
  "Started with just a quick look, ended up buying on the spot.",
  "Good thing I did not ignore the shop and go straight online.",
  "Small place, but they had everything I was searching for.",
  "I came in nervous about the price; I left feeling it was fair.",
  "After months of research, the final step here was the easiest.",
  "This is the kind of service that makes you come back for the next purchase.",
];

const SIGNATURE_MOMENTS: string[] = [
  "They had several models lined up side by side so I could compare them in person.",
  "The bill was clear and itemized — no hidden charges at the end.",
  "They let me take my time and check the model properly before deciding.",
  "The person who attended me even called a day later to ask if everything was working.",
  "They demoed the main features before I paid, so there were no surprises.",
  "They adjusted the price a bit to fit my budget, which I appreciated.",
  "Everything was packed properly and the warranty details were explained to me.",
  "They offered a free carry bag and a small gift with the purchase.",
  "The shop got the delivery done a day earlier than promised.",
  "They explained the maintenance and cleaning tips while billing.",
  "Even during a busy afternoon, they stopped to answer every question I had.",
  "They showed me the difference between the models instead of pushing the costliest one.",
  "After the delivery, they shared the service helpline number on WhatsApp.",
  "The serial number and invoice were checked in front of me before handing over.",
  "They called me once the stock arrived, exactly when they said they would.",
];

const HUMAN_TOUCHES: string[] = [
  "Honestly,",
  "Not gonna lie,",
  "In the end,",
  "To be fair,",
  "Truth be told,",
  "It might sound small, but",
  "I was honestly surprised that",
  "Looking back,",
  "All said and done,",
  "And honestly,",
];

const NARRATIVE_ARCS: string[] = [
  `Open by describing why you went to the store (a need, a price comparison, a referral), then describe what happened.`,
  `Open with the staff's helpfulness and how they treated you.`,
  `Open with your first impression of the shop, its range, or how it is laid out.`,
  `Open with a small concern you had (a tight budget, a confusing choice, a delivery worry) and how the store made it easy.`,
  `Open with a practical detail like the bill, the price, or the deal you got.`,
  `Open like a quick note to a friend: a casual verdict on the store first, then the specifics.`,
  `Open with the after-sales or delivery experience, then talk about the purchase itself.`,
  `Open by comparing this shop with the other places you checked.`,
];

const PRODUCT_POSITIONS: string[] = [
  "Mention the product and brand naturally in the middle of the review, not in the first sentence.",
  "You can name the product and brand fairly early, but do not open the review with it.",
  "Bring the product and brand in towards the end, after describing the service.",
  "Mention the category you bought first, and only name the exact brand later.",
];

const SALESMAN_POSITIONS: string[] = [
  "Bring in the salesman by name in the first half, as the person who attended you.",
  "Mention the salesman by name near the end, crediting them for the help.",
  "Name the salesman in the middle, right where you describe being helped.",
];

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function modelUnavailable(e: unknown): boolean {
  const status = (e as { status?: number })?.status;
  const msg = (e as Error)?.message || "";
  return status === 404 || status === 400 || /model|not found/i.test(msg);
}

/* ════════════════════════════════════════════════════════════════════
   Post-generation quality checks
   ════════════════════════════════════════════════════════════════════ */

const AI_CLICHE_PATTERNS: RegExp[] = [
  /\boverall\b/i,
  /\bin conclusion\b/i,
  /\bseamless\b/i,
  /\bhighly recommend\b/i,
  /\bworth every penny\b/i,
  /\bamazing experience\b/i,
  /\b10\/10\b/i,
  /\bgame[- ]changer\b/i,
  /\bhidden gem\b/i,
  /\bexceeded my expectations\b/i,
  /\bdefinitely (recommend|go)\b/i,
  /\bfive out of five\b/i,
  /\bperfect (experience|service)\b/i,
];

function hasAiClichés(text: string): boolean {
  return AI_CLICHE_PATTERNS.some((re) => re.test(text));
}

// Currency amounts / dates are the classic invented facts the model sneaks in.
const INVENTED_FACT_PATTERNS: RegExp[] = [
  /\b(?:₹|Rs\.?|INR)\s?\d[\d,]*(?:\.\d+)?/i,
  /\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i,
  /\b(?:₹)\s?\d/i,
];

function hasInventedFacts(text: string): boolean {
  return INVENTED_FACT_PATTERNS.some((re) => re.test(text));
}

function sentenceStartsOk(text: string): boolean {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (sentences.length < 3) return true;
  const firstWord = (s: string) =>
    (s.split(/\s+/)[0] || "").replace(/[^A-Za-z\u0900-\u097F]/g, "").toLowerCase();
  const starts = sentences.map(firstWord);
  const iCount = starts.filter((w) => w === "i").length;
  if (iCount > Math.ceil(sentences.length / 2)) return false;
  const counts: Record<string, number> = {};
  for (const w of starts) {
    counts[w] = (counts[w] || 0) + 1;
    if (counts[w] >= 3) return false;
  }
  return true;
}

// Latin brand/firm/product words that are allowed to appear inside Devanagari text.
const KNOWN_LATIN_WORDS = new Set([
  "samsung", "lg", "sony", "haier", "voltas", "whirlpool", "godrej", "ifb", "hp", "dell",
  "lenovo", "apple", "oneplus", "vivo", "oppo", "xiaomi", "redmi", "realme", "mi", "nokia",
  "panasonic", "bosch", "tv", "led", "oled", "ac", "fridge", "refrigerator", "washing",
  "machine", "microwave", "geyser", "fan", "laptop", "mobile", "smartphone", "phone",
  "model", "models", "corner", "mobile", "shoppee", "shoppe", "shope", "store", "delivery",
  "service", "inverter", "window", "split", "2k", "4k", "inch", "wifi", "apps", "app",
  "online", "offline", "whatsapp", "instagram", "facebook", "sale", "offer", "emi", "gst",
  "webasto", "electrolux", "blue", "star", "cm", "kg", "ltr", "lt", "bhp", "wifi",
]);

function latinLeakRatio(text: string): number {
  const words = text.split(/[\s,.;:!?()]+/);
  let latin = 0;
  let dev = 0;
  for (let w of words) {
    const lower = w.toLowerCase();
    if (KNOWN_LATIN_WORDS.has(lower)) continue;
    for (const ch of w) {
      if (/[\u0900-\u097F]/.test(ch)) dev++;
      else if (/[a-zA-Z]/.test(ch)) latin++;
    }
  }
  if (latin + dev === 0) return latin > 0 ? 1 : 0;
  return latin / (latin + dev);
}

// Any character that is not ASCII, Devanagari, or Latin-1/Latin-Extended means
// the model drifted into another script (Katakana, Hiragana, Hangul, CJK,
// Arabic, Cyrillic, Thai, etc.). Devanagari + Latin (brand names) is all a
// Hindi/Marathi review should ever contain.
function hasForeignScript(text: string): boolean {
  return /[^\u0000-\u007F\u0900-\u097F\u00A0-\u024F]/u.test(text);
}

// Some models echo the instruction back ("हिंदी लिखें") as a first line.
function cleanInstructionEcho(text: string, language: string): string {
  const lines = text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const echo =
    language === "hindi"
      ? /^(हिंदी|हिन्दी|हिंदी में|हिन्दी में)\s*(लिखें|लिखो|लिखिए|में)?$/i
      : language === "marathi"
        ? /^(मराठी|मराठीत)\s*(लिखा|लिहा|लिहायचे)?$/i
        : /^write (it )?in (hindi|marathi|english)$/i;
  if (lines.length > 1 && echo.test(lines[0])) {
    return lines.slice(1).join("\n").trim();
  }
  return text;
}

// Ring buffer of recently generated drafts (best-effort de-duplication).
const recentDrafts: string[] = [];
const RECENT_MAX = 30;
// Stopwords include common domain words (store name, brand, product) that
// would otherwise inflate similarity between any two electronics-store reviews.
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "else", "for", "to", "from", "of",
  "in", "on", "at", "by", "with", "about", "as", "is", "are", "was", "were", "be", "been",
  "it", "its", "this", "that", "these", "those", "i", "me", "my", "we", "our", "us", "you",
  "your", "he", "she", "his", "her", "they", "them", "their", "there", "here", "not", "no",
  "so", "too", "very", "just", "also", "really", "because", "had", "have", "has", "did",
  "do", "does", "will", "would", "can", "could", "should", "after", "before", "when",
  "while", "get", "got", "go", "went", "shop", "store", "day", "one", "two", "thing",
  "things", "time", "made", "make", "bought", "buy", "purchase", "took", "come", "came",
  "said", "say", "know", "even", "now", "still", "already", "since", "until", "up", "down",
  "out", "again", "then", "than", "all", "some", "any", "more", "most", "other", "every",
  "both", "each", "few", "own", "same", "only", "back", "well", "way", "place", "bit",
  "lot", "much", "many", "actually", "honestly", "honest", "overall", "end", "next",
  "first", "last", "good", "great", "nice", "really", "fair", "right", "okay", "also",
  "hariom", "electronics", "samsung", "lg", "sony", "haier", "voltas", "whirlpool",
  "godrej", "ifb", "hp", "dell", "lenovo", "apple", "oneplus", "vivo", "oppo", "mobile",
  "phone", "smartphone", "model", "models", "corner", "shoppee", "shoppe", "store",
  "shop", "service", "delivery", "price", "quality", "help", "helped", "helping",
  "staff", "explain", "explained", "explaining", "bought", "buy", "purchase", "purchased",
]);

function contentWordSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w && !STOPWORDS.has(w))
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function maxSimilarity(text: string): number {
  const set = contentWordSet(text);
  if (set.size === 0) return 0;
  let max = 0;
  for (const d of recentDrafts) {
    const s = jaccard(set, contentWordSet(d));
    if (s > max) max = s;
  }
  return max;
}

function pushRecent(text: string): void {
  recentDrafts.push(text);
  if (recentDrafts.length > RECENT_MAX) recentDrafts.shift();
}

/* ════════════════════════════════════════════════════════════════════
   Review generation
   ════════════════════════════════════════════════════════════════════ */

async function generateOnce(
  params: CuratedReviewParams,
  attempt: number
): Promise<string> {
  const client = getClient();
  const {
    storeName,
    category,
    brand,
    experiences,
    customText,
    customerName,
    language = "english",
    variation = "standard",
    subFirmName,
    salesmanName,
  } = params;

  const arc = pickRandom(NARRATIVE_ARCS);
  const productPosition = pickRandom(PRODUCT_POSITIONS);
  const salesmanPosition = salesmanName ? pickRandom(SALESMAN_POSITIONS) : "";
  const paragraphs = Math.random() < 0.7 ? 1 : 2;
  const openingStyles = shuffle(OPENING_STYLES)
    .slice(0, 3)
    .map((s) => `"${s}"`)
    .join(" | ");
  const openingsInstruction =
    language === "english"
      ? `Start with ONE short, natural opening line in the spirit of these examples (rephrase — never copy word-for-word): ${openingStyles}.`
      : `Start with ONE short, natural opening line in the target language with the same friendly tone as these English examples — do NOT translate them literally, they are only tone references: ${openingStyles}.`;

  const signatureMoment =
    variation === "short"
      ? "" // short reviews shouldn't add extra detail — it inflates length
      : pickRandom(SIGNATURE_MOMENTS);
  const signatureMomentInstruction = signatureMoment
    ? `Weave in ONE small specific-sounding detail from this list (rephrase it in your own words, in the target language): "${signatureMoment}".`
    : "";

  const humanTouches = shuffle(HUMAN_TOUCHES).slice(0, Math.random() < 0.6 ? 1 : 2);
  const humanTouchInstruction =
    language === "english"
      ? `You may use ONE of these casual touches somewhere, only if it fits naturally: ${humanTouches.join(" / ")}.`
      : ""; // Hindi/Marathi casual markers come from LANGUAGE_INSTRUCTION instead

  const nonEnExamples = language !== "english" ? NON_EN_EXAMPLES[language] : [];
  const nonEnExample = nonEnExamples.length ? pickRandom(nonEnExamples) : "";

  const foreignInputsNote =
    language !== "english"
      ? `The customer's own words, category, brand, and highlights may be in English. Keep brand, firm, and person names in English (Latin script) and weave them into the ${language} sentences naturally. If there is a "My own words" field, TRANSLATE it into the ${language} (same meaning) — never paste English verbatim. Do not stop early — actually hit the requested word count.`
      : "";

  const subFirmInstruction = subFirmName
    ? `The purchase was made at "${subFirmName}", a mobile shop that operates inside "${storeName}". Mention clearly (once or twice) that you bought it from ${subFirmName} inside the store — e.g., "got my phone from ${subFirmName} inside the store". Keep "${subFirmName}" exactly as written (Latin script).`
    : "";

  const salesmanInstruction = salesmanName
    ? `The salesman "${salesmanName}" personally helped you. ${salesmanPosition} Mention ${salesmanName} by name once, naturally — e.g., "${salesmanName} explained the options patiently." Never imply any other specific staff member.`
    : "";

  const strictNote =
    attempt > 0
      ? `Previous attempt failed a quality check. Make this version clearly different in opening line and sentence structure, and keep it natural and casual. For Hindi/Marathi, use Devanagari script throughout — no Roman-script Hindi/Marathi and no English words except brand, firm, and person names.`
      : "";

  const systemPrompt = [
    `You write a first-person customer review for "${storeName}", a store in India.`,
    arc,
    VARIATION_MODIFIERS[variation],
    paragraphs === 1 ? "Keep it to ONE short paragraph." : "Use at most TWO short paragraphs.",
    productPosition,
    salesmanPosition,
    openingsInstruction,
    signatureMomentInstruction,
    humanTouchInstruction,
    subFirmInstruction,
    salesmanInstruction,
    LANGUAGE_INSTRUCTION[language],
    nonEnExample
      ? `A polished example of the desired style (this is a style reference — do not copy it):\n${nonEnExample}`
      : "",
    foreignInputsNote,
    strictNote,
    ...COMMON_ANTI_AI,
  ]
    .filter(Boolean)
    .join(" ");

  const userPrompt = [
    `Things I want to highlight (pick the most relevant 1-3): ${shuffle(experiences).join(", ") || "none"}`,
    `What I bought / category: ${category || "not specified"}`,
    `Brand: ${brand || "not specified"}`,
    customText ? `My own words to include: ${customText}` : "",
    customerName ? `My name (only used to sign naturally if fitting): ${customerName}` : "",
    `IMPORTANT: Follow the requested length and style above exactly.`,
  ]
    .filter(Boolean)
    .join("\n");

  const temperature = Math.min(0.75 + Math.random() * 0.2 + (attempt > 0 ? 0.08 : 0), 1);
  const modelOrder =
    language === "english"
      ? [DEFAULT_MODEL, HIGH_CAPACITY_FALLBACK]
      : [INDIC_MODEL, DEFAULT_MODEL, HIGH_CAPACITY_FALLBACK];

  let text = "";
  for (const model of modelOrder) {
    for (let retry = 0; retry < 3; retry++) {
      try {
        const res = await client.chat.completions.create({
          model,
          temperature,
          max_tokens: VARIATION_MAX_TOKENS[variation],
          // qwen accepts "none"; gpt-oss only accepts low/medium/high.
          ...(model === INDIC_MODEL
            ? { reasoning_effort: "none" as const }
            : { reasoning_effort: "low" as const }),
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        });
        const content = res.choices?.[0]?.message?.content?.trim() || "";
        if (content) text = content;
        break; // got a response (possibly empty) — try the next model if empty
      } catch (e) {
        if (RETRYABLE_STATUS.has((e as { status?: number })?.status as number)) {
          await sleep(600 * Math.pow(2, retry));
          continue;
        }
        if (modelUnavailable(e)) break; // try next model in the order
        throw e;
      }
    }
    if (text) break; // move on only when we have actual content
  }
  if (!text) {
    throw new Error("Groq request failed after retries");
  }
  return cleanInstructionEcho(text, language);
}

/**
 * Generate a customer-facing curated review from selected buzzwords.
 * The customer reads/edits it and posts it themselves on Google.
 *
 * Each request draws fresh random opening/style/detail banks, then runs
 * quality checks (Devanagari purity, AI clichés, sentence-start variety,
 * similarity to recently generated drafts). If a check fails it retries
 * once or twice with a different prompt, so repeats don't look templated.
 */
export async function generateCuratedReview(
  params: CuratedReviewParams
): Promise<string> {
  const needsDevanagari = params.language && params.language !== "english";

  for (let attempt = 0; attempt < 3; attempt++) {
    const text = await generateOnce(params, attempt);

    const problems: string[] = [];
    if (needsDevanagari && (latinLeakRatio(text) > 0.25 || hasForeignScript(text))) {
      problems.push("script-mix");
    }
    if (hasAiClichés(text)) problems.push("cliche");
    if (hasInventedFacts(text)) problems.push("invented-facts");
    if (!sentenceStartsOk(text)) problems.push("sentence-starts");
    if (maxSimilarity(text) > 0.75) problems.push("similar-to-recent");
    const wordCount = text.trim().split(/\s+/).length;
    const minWords = params.variation === "short" ? 12 : 18;
    if (wordCount < minWords) problems.push("too-short");

    if (problems.length === 0) {
      pushRecent(text);
      return text;
    }

    log.info(
      `Generated review (attempt ${attempt + 1}) flagged: ${problems.join(", ")} — retrying`
    );
    if (attempt === 2) {
      pushRecent(text); // best effort on last attempt
      return text;
    }
  }

  throw new Error("Failed to generate review");
}

/**
 * Simple rule-based sentiment fallback (no extra LLM call).
 */
export function inferSentiment(rating: number, comment: string): Sentiment {
  if (rating >= 4) return "positive";
  if (rating === 3) return "neutral";
  const negativeWords = [
    "bad", "worst", "rude", "scam", "cheat", "fake", "waste", "terrible",
    "poor", "refund", "never", "avoid", "slow", "unhappy", "disappointed",
  ];
  const lower = comment.toLowerCase();
  if (negativeWords.some((w) => lower.includes(w))) return "negative";
  return rating <= 2 ? "negative" : "neutral";
}
