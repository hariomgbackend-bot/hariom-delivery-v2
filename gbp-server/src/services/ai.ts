import Groq from "groq-sdk";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { GbpReview, ReviewReplyRule } from "../types.js";

const log = logger("ai");

const DEFAULT_MODEL = "llama-3.3-70b-versatile";

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
    const completion = await client.chat.completions.create({
      model: DEFAULT_MODEL,
      temperature: 0.7,
      max_tokens: 220,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    const reply = completion.choices[0]?.message?.content?.trim() || "";
    if (!reply) {
      throw new Error("Empty reply from LLM");
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
}

const VARIATION_MODIFIERS: Record<ReviewVariation, string> = {
  standard: "Length: AT LEAST 100 words (aim for 100-130 words). Do not stop early — a full, detailed review.",
  short: "Length: 40-60 words only — 2 to 4 short sentences. Skip minor detail, keep just the highlights.",
  casual: "Make it CASUAL and chatty, like a quick note to a friend on WhatsApp. Short sentences, relaxed tone, simple everyday words. Length: AT LEAST 90 words.",
  detailed: "Make it MORE DETAILED — 130-160 words. Add concrete but generic specifics about the product features, the guidance the staff gave you, and the service after the sale.",
};

const VARIATION_MAX_TOKENS: Record<ReviewVariation, number> = {
  standard: 340,
  short: 180,
  casual: 320,
  detailed: 420,
};

const LANGUAGE_INSTRUCTION: Record<"english" | "hindi" | "marathi", string> = {
  english: "Write entirely in English.",
  hindi: "Write entirely in Hindi using Devanagari script (हिंदी) — natural, everyday spoken Hindi.",
  marathi: "Write entirely in Marathi using Devanagari script (मराठी) — natural, everyday spoken Marathi.",
};

const COMMON_ANTI_AI: string[] = [
  `Mix short and long sentences. Vary how you begin sentences — do NOT start every sentence with "I".`,
  `Avoid clichés and buzzwords like "Overall", "highly recommend", "seamless", "gem", "amazing experience".`,
  `Do NOT begin the review with "I recently...", "I recently bought/purchased...", or "I bought a ... for my home".`,
  `The first sentence must not mention the product or the brand — get to those later in the review.`,
  `Do NOT use emojis, hashtags, or placeholders like [Store Name].`,
  `Do NOT invent specific facts: prices, dates, staff names, or product faults.`,
  `Sound like a modest real person typing quickly — not a marketing ad. Occasional casual phrasing is fine.`,
  `Do not be uniformly glowing; one mild honest observation is okay as long as it does not invent facts.`,
];

const OPENING_STYLES: string[] = [
  `Honestly, I was not sure where to start looking, but the staff here made it simple.`,
  `This is one of those shops you end up recommending without being asked.`,
  `Kept putting off the purchase until I finally visited this place.`,
  `A friend told me to check this store out, and I'm glad I did.`,
  `Between the prices and the service, this place really stands out.`,
];

function stylePresets(storeName: string): string[][] {
  return [
    [
      `You write a first-person customer review for "${storeName}", a store in India.`,
      `Open with the situation that made you visit the store, then describe the help you got, the product you chose, and how you feel now.`,
    ],
    [
      `You write a first-person customer review for "${storeName}", a store in India.`,
      `Open with the visit and how the staff treated you, mention the product and brand in the middle, and end with your overall feeling.`,
    ],
    [
      `You write a first-person customer review for "${storeName}", a store in India.`,
      `Open with what impressed you most about the service or the people, then describe what you bought and why it was worth it.`,
    ],
    [
      `You write a first-person customer review for "${storeName}", a store in India.`,
      `Write like a quick note to a friend: open with a casual verdict about the store, then what you got, what stood out, and whether you'd go back.`,
    ],
  ];
}

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Generate a customer-facing curated review from selected buzzwords.
 * The customer reads/edits it and posts it themselves on Google.
 * Prompt preset + temperature are randomized per request so repeats
 * don't look templated.
 */
export async function generateCuratedReview({
  storeName,
  category,
  brand,
  experiences,
  customText,
  customerName,
  language = "english",
  variation = "standard",
}: CuratedReviewParams): Promise<string> {
  const client = getClient();

  const presets = stylePresets(storeName);
  const preset = presets[Math.floor(Math.random() * presets.length)];
  const openings = shuffle(OPENING_STYLES)
    .slice(0, 3)
    .map((s) => `"${s}"`)
    .join(" | ");
  const systemPrompt = [
    ...preset,
    VARIATION_MODIFIERS[variation],
    `Start with ONE short, natural opening line in the spirit of these examples, in the language you are writing in (rephrase — never copy word-for-word): ${openings}.`,
    LANGUAGE_INSTRUCTION[language],
    ...COMMON_ANTI_AI,
  ].join(" ");

  const userPrompt = [
    `Things I want to highlight (pick the most relevant 2-4): ${shuffle(experiences).join(", ") || "none"}`,
    `What I bought / category: ${category || "not specified"}`,
    `Brand: ${brand || "not specified"}`,
    customText ? `My own words to include: ${customText}` : "",
    customerName ? `My name (only used to sign naturally if fitting): ${customerName}` : "",
    `IMPORTANT: Follow the requested length and style above exactly.`,
  ]
    .filter(Boolean)
    .join("\n");

  const temperature = 0.75 + Math.random() * 0.2;

  const completion = await client.chat.completions.create({
    model: DEFAULT_MODEL,
    temperature,
    max_tokens: VARIATION_MAX_TOKENS[variation],
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  const text = completion.choices[0]?.message?.content?.trim() || "";
  if (!text) {
    throw new Error("Empty review generated");
  }
  return text;
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
