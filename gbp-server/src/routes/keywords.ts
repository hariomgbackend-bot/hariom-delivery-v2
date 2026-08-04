import { Router, Request, Response } from "express";
import { authenticate } from "../middleware/auth.js";
import { getDb } from "../utils/firestore.js";
import { logger } from "../utils/logger.js";
import { getLocationFromStore } from "../services/gbp.js";
import { checkLocalRank } from "../services/rank.js";
import { ApiResponse, TrackedKeyword, RankEntry } from "../types.js";

const router = Router();
const log = logger("keywords");

function pid(p: string | string[] | undefined): string {
  if (Array.isArray(p)) return p[0];
  return p || "";
}

/**
 * GET /api/gbp/locations/:id/keywords
 * List tracked keywords with their latest rank.
 */
router.get("/locations/:id/keywords", authenticate, async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const snap = await db
      .collection("gbp_keywords")
      .where("locationId", "==", pid(req.params.id))
      .get();

    const keywords = snap.docs
      .map((d) => ({ id: d.id, ...d.data() } as TrackedKeyword & { id: string }))
      .sort((a, b) => (b.createdAt?.getTime?.() || 0) - (a.createdAt?.getTime?.() || 0));
    res.json({ success: true, data: keywords } satisfies ApiResponse);
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message } satisfies ApiResponse);
  }
});

/**
 * POST /api/gbp/locations/:id/keywords
 * Add a keyword to track. Body: { keyword, city? }
 */
router.post("/locations/:id/keywords", authenticate, async (req: Request, res: Response) => {
  try {
    const { keyword, city } = req.body;
    if (!keyword || typeof keyword !== "string" || keyword.trim() === "") {
      res.status(400).json({ success: false, error: "Missing keyword" } satisfies ApiResponse);
      return;
    }

    const db = getDb();
    const locId = pid(req.params.id);
    const location = await getLocationFromStore(locId);
    if (!location?.locationId) {
      res.status(404).json({ success: false, error: "Location not found" } satisfies ApiResponse);
      return;
    }

    const data: TrackedKeyword = {
      keywordId: "",
      locationId: locId,
      keyword: keyword.trim(),
      rankHistory: [],
      competitorRanks: {},
      city: typeof city === "string" ? city : undefined,
      createdAt: new Date(),
    };

    const ref = await db.collection("gbp_keywords").add(data);
    data.keywordId = ref.id;
    await ref.update({ keywordId: ref.id });

    res.json({ success: true, data, message: "Keyword added" } satisfies ApiResponse);
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message } satisfies ApiResponse);
  }
});

/**
 * POST /api/gbp/locations/:id/keywords/:keywordId/check
 * Run a live rank check for the keyword using Playwright.
 */
router.post(
  "/locations/:id/keywords/:keywordId/check",
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const db = getDb();
      const kwId = pid(req.params.keywordId);
      const ref = db.collection("gbp_keywords").doc(kwId);
      const doc = await ref.get();
      if (!doc.exists) {
        res.status(404).json({ success: false, error: "Keyword not found" } satisfies ApiResponse);
        return;
      }

      const kw = doc.data() as TrackedKeyword;
      const location = await getLocationFromStore(kw.locationId);
      if (!location?.locationId) {
        res.status(404).json({ success: false, error: "Location not found" } satisfies ApiResponse);
        return;
      }

      const result = await checkLocalRank(kw.keyword, location.name, kw.city);

      if (!result.error) {
        const entry: RankEntry = {
          position: result.position,
          keyword: kw.keyword,
          checkedAt: result.checkedAt,
          competitorsOnPage: result.competitorsOnPage,
        };

        const history = Array.isArray(kw.rankHistory) ? kw.rankHistory : [];
        const nextHistory = [...history, entry].slice(-60);

        const nextRank =
          result.position > 0 ? result.position : kw.currentRank ?? undefined;

        await ref.update({
          currentRank: nextRank ?? null,
          rankHistory: nextHistory,
          lastChecked: result.checkedAt,
        });
      }

      res.json({ success: true, data: result } satisfies ApiResponse);
    } catch (e) {
      res.status(500).json({ success: false, error: (e as Error).message } satisfies ApiResponse);
    }
  }
);

/**
 * GET /api/gbp/locations/:id/keywords/:keywordId/history
 * Rank history for a keyword.
 */
router.get(
  "/locations/:id/keywords/:keywordId/history",
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const db = getDb();
      const doc = await db.collection("gbp_keywords").doc(pid(req.params.keywordId)).get();
      if (!doc.exists) {
        res.status(404).json({ success: false, error: "Keyword not found" } satisfies ApiResponse);
        return;
      }
      const kw = doc.data() as TrackedKeyword;
      res.json({
        success: true,
        data: {
          keyword: kw.keyword,
          currentRank: kw.currentRank ?? null,
          lastChecked: kw.lastChecked ?? null,
          history: Array.isArray(kw.rankHistory) ? kw.rankHistory : [],
        },
      } satisfies ApiResponse);
    } catch (e) {
      res.status(500).json({ success: false, error: (e as Error).message } satisfies ApiResponse);
    }
  }
);

export default router;
