import { Router, Request, Response } from "express";
import { logger } from "../utils/logger.js";
import { getDb } from "../utils/firestore.js";
import admin from "firebase-admin";
import { getLocationFromStore } from "../services/gbp.js";
import { buildWriteReviewUrl } from "../services/qrcode.js";
import { generateCuratedReview } from "../services/ai.js";
import { authenticate, authorize } from "../middleware/auth.js";
import { ApiResponse } from "../types.js";

const router = Router();
const log = logger("public-review");

const DEFAULT_CATEGORIES = [
  "LED TV",
  "Refrigerator",
  "Washing Machine",
  "Laptop",
  "Mobile",
  "Air Conditioner",
  "Microwave",
  "Fan",
  "Geyser",
  "Home Theatre",
];

const DEFAULT_BRANDS = [
  "Samsung",
  "LG",
  "Sony",
  "Haier",
  "Voltas",
  "Whirlpool",
  "Godrej",
  "IFB",
  "HP",
  "Dell",
  "Lenovo",
  "Apple",
  "OnePlus",
  "Vivo",
  "Oppo",
];

const DEFAULT_EXPERIENCES = [
  "Value for money",
  "Exceptional service",
  "Knowledgeable staff",
  "Helpful",
  "Professional",
  "Quality product",
  "Good communication",
  "Fast delivery",
  "After-sales support",
  "Would recommend",
];

interface ReviewWidgetOptions {
  categories?: string[];
  brands?: string[];
  experiences?: string[];
}

const COMMON_WIDGET_DOC = "_common_";

async function getWidgetOptions(): Promise<ReviewWidgetOptions> {
  try {
    const db = getDb();
    const doc = await db.collection("gbp_review_widgets").doc(COMMON_WIDGET_DOC).get();
    return (doc.exists ? (doc.data() as ReviewWidgetOptions) : {}) || {};
  } catch (e) {
    log.warn("Could not read review widget options", e);
    return {};
  }
}

function pid(p: string | string[] | undefined): string {
  if (Array.isArray(p)) return p[0];
  return p || "";
}

const STAFF_COUNTS_COLLECTION = "gbp_staff_review_counts";

async function incrementStaffReviewCount(staffId: string, staffName: string): Promise<void> {
  const db = getDb();
  const ref = db.collection(STAFF_COUNTS_COLLECTION).doc(staffId);
  const data: Record<string, unknown> = {
    staffId,
    count: 1,
    updatedAt: new Date(),
  };
  if (staffName) data.staffName = staffName;
  await ref.set(data, { merge: true });
  await ref.update({ count: admin.firestore.FieldValue.increment(1) });
}

/**
 * GET /api/gbp/review-stats
 * Admin — leaderboard of staff review counts, sorted descending.
 */
router.get("/review-stats", authenticate, authorize("admin", "accountant"), async (_req: Request, res: Response) => {
  try {
    const db = getDb();
    const snap = await db.collection(STAFF_COUNTS_COLLECTION).get();
    const rows = snap.docs.map((d) => {
      const x = d.data();
      return {
        staffId: x.staffId || d.id,
        staffName: x.staffName || "Staff",
        count: typeof x.count === "number" ? x.count : 0,
        updatedAt: x.updatedAt || null,
      };
    });
    rows.sort((a, b) => b.count - a.count);
    res.json({ success: true, data: rows } satisfies ApiResponse);
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message } satisfies ApiResponse);
  }
});

/**
 * GET /api/gbp/public/review-stats
 * Public (rate-limited) — full leaderboard of staff review counts, sorted desc.
 */
router.get("/public/review-stats", async (req: Request, res: Response) => {
  if (!rateLimit(clientIp(req))) {
    res.status(429).json({ success: false, error: "Too many requests. Try again in a minute." } satisfies ApiResponse);
    return;
  }
  try {
    const db = getDb();
    const snap = await db.collection(STAFF_COUNTS_COLLECTION).get();
    const rows = snap.docs.map((d) => {
      const x = d.data();
      return {
        staffId: x.staffId || d.id,
        staffName: x.staffName || "Staff",
        count: typeof x.count === "number" ? x.count : 0,
      };
    });
    rows.sort((a, b) => b.count - a.count);
    res.json({ success: true, data: rows } satisfies ApiResponse);
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message } satisfies ApiResponse);
  }
});

/**
 * GET /api/gbp/public/review-stats/:staffId
 * Public (rate-limited) — returns review count for one staff member.
 */
router.get("/public/review-stats/:staffId", async (req: Request, res: Response) => {
  if (!rateLimit(clientIp(req))) {
    res.status(429).json({ success: false, error: "Too many requests. Try again in a minute." } satisfies ApiResponse);
    return;
  }
  const staffId = pid(req.params.staffId);
  if (!staffId) {
    res.status(400).json({ success: false, error: "Missing staffId" } satisfies ApiResponse);
    return;
  }
  try {
    const db = getDb();
    const doc = await db.collection(STAFF_COUNTS_COLLECTION).doc(staffId).get();
    const x = doc.exists ? (doc.data() || {}) : {};
    res.json({
      success: true,
      data: {
        staffId,
        staffName: typeof x.staffName === "string" ? x.staffName : "",
        count: typeof x.count === "number" ? x.count : 0,
      },
    } satisfies ApiResponse);
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message } satisfies ApiResponse);
  }
});

function clientIp(req: Request): string {
  return (
    (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

// Simple in-memory per-IP rate limiter.
const hits = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;

function rateLimit(ip: string): boolean {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || rec.resetAt <= now) {
    hits.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  rec.count++;
  return rec.count <= RATE_LIMIT;
}

/**
 * GET /api/gbp/public/review-options/:locationId
 * Public — returns store info + tag lists for the review wizard.
 */
router.get("/public/review-options/:locationId", async (req: Request, res: Response) => {
  try {
    if (!rateLimit(clientIp(req))) {
      res.status(429).json({ success: false, error: "Too many requests. Try again in a minute." } satisfies ApiResponse);
      return;
    }

    const location = await getLocationFromStore(pid(req.params.locationId));
    if (!location?.locationId) {
      res.status(404).json({ success: false, error: "Store not found" } satisfies ApiResponse);
      return;
    }

    const widget = await getWidgetOptions();

    res.json({
      success: true,
      data: {
        storeName: location.name,
        placeId: location.locationId,
        writeReviewUrl: buildWriteReviewUrl(location.locationId),
        categories: widget.categories?.length ? widget.categories : DEFAULT_CATEGORIES,
        brands: widget.brands?.length ? widget.brands : DEFAULT_BRANDS,
        experiences: widget.experiences?.length ? widget.experiences : DEFAULT_EXPERIENCES,
      },
    } satisfies ApiResponse);
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message } satisfies ApiResponse);
  }
});

/**
 * POST /api/gbp/public/review/generate
 * Public — generates an editable curated review from selected tags.
 */
router.post("/public/review/generate", async (req: Request, res: Response) => {
  try {
    if (!rateLimit(clientIp(req))) {
      res.status(429).json({ success: false, error: "Too many requests. Try again in a minute." } satisfies ApiResponse);
      return;
    }

    const { locationId, category, brand, experiences, customText, customerName, language, variation } = req.body || {};
    if (!locationId || typeof locationId !== "string") {
      res.status(400).json({ success: false, error: "Missing locationId" } satisfies ApiResponse);
      return;
    }

    const location = await getLocationFromStore(locationId);
    if (!location?.locationId) {
      res.status(404).json({ success: false, error: "Store not found" } satisfies ApiResponse);
      return;
    }

    const expList = Array.isArray(experiences)
      ? experiences.filter((e: unknown): e is string => typeof e === "string").slice(0, 5)
      : [];

    if (expList.length === 0 && !category && !brand && !customText) {
      res.status(400).json({ success: false, error: "Pick at least one tag or add your own words" } satisfies ApiResponse);
      return;
    }

    const validLanguages = ["english", "hindi", "marathi"] as const;
    const lang = validLanguages.includes(language) ? language : "english";

    const validVariations = ["standard", "short", "casual", "detailed"] as const;
    const variationValue = validVariations.includes(variation) ? variation : "standard";

    const review = await generateCuratedReview({
      storeName: location.name,
      category: typeof category === "string" ? category : undefined,
      brand: typeof brand === "string" ? brand : undefined,
      experiences: expList,
      customText: typeof customText === "string" && customText.trim() ? customText.trim() : undefined,
      customerName: typeof customerName === "string" && customerName.trim() ? customerName.trim() : undefined,
      language: lang,
      variation: variationValue,
    });

    const staffId =
      typeof req.body?.staffId === "string" && req.body.staffId.trim() ? req.body.staffId.trim() : "";
    if (staffId) {
      await incrementStaffReviewCount(
        staffId,
        typeof req.body?.staffName === "string" && req.body.staffName.trim()
          ? req.body.staffName.trim().slice(0, 80)
          : ""
      );
    }

    log.info(`Curated review generated for ${locationId}`);
    res.json({
      success: true,
      data: {
        review,
        storeName: location.name,
        writeReviewUrl: buildWriteReviewUrl(location.locationId),
      },
    } satisfies ApiResponse);
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message } satisfies ApiResponse);
  }
});

function cleanTags(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string" && Boolean(x.trim()))
    .map((x) => x.trim());
}

/**
 * GET /api/gbp/review-options
 * Admin — returns the common review wizard tag lists (with defaults).
 * The lists are shared by all stores; only the store name / QR / review
 * link stay per-store.
 */
router.get("/review-options", authenticate, async (_req: Request, res: Response) => {
  try {
    const widget = await getWidgetOptions();
    res.json({
      success: true,
      data: {
        categories: widget.categories?.length ? widget.categories : DEFAULT_CATEGORIES,
        brands: widget.brands?.length ? widget.brands : DEFAULT_BRANDS,
        experiences: widget.experiences?.length ? widget.experiences : DEFAULT_EXPERIENCES,
      },
    } satisfies ApiResponse);
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message } satisfies ApiResponse);
  }
});

/**
 * PUT /api/gbp/review-options
 * Admin — saves the common review wizard tag lists (shared by all stores).
 */
router.put("/review-options", authenticate, async (req: Request, res: Response) => {
  try {
    const { categories, brands, experiences } = req.body || {};
    const data = {
      categories: cleanTags(categories),
      brands: cleanTags(brands),
      experiences: cleanTags(experiences),
      updatedAt: new Date(),
    };
    await getDb().collection("gbp_review_widgets").doc(COMMON_WIDGET_DOC).set(data, { merge: true });
    log.info("Common review options saved");
    res.json({ success: true, data, message: "Review options saved" } satisfies ApiResponse);
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message } satisfies ApiResponse);
  }
});

/**
 * DELETE /api/gbp/review-options
 * Admin — clears the common tag lists so the code defaults apply again.
 */
router.delete("/review-options", authenticate, async (_req: Request, res: Response) => {
  try {
    await getDb().collection("gbp_review_widgets").doc(COMMON_WIDGET_DOC).delete();
    log.info("Common review options reset");
    res.json({
      success: true,
      data: {
        categories: DEFAULT_CATEGORIES,
        brands: DEFAULT_BRANDS,
        experiences: DEFAULT_EXPERIENCES,
      },
      message: "Reset to defaults",
    } satisfies ApiResponse);
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message } satisfies ApiResponse);
  }
});

export default router;
