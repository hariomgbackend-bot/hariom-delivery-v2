import { Router, Request, Response } from "express";
import { authenticate } from "../middleware/auth.js";
import { getDb } from "../utils/firestore.js";
import { logger } from "../utils/logger.js";
import { getReviewsFromPlace } from "../services/places.js";
import { generateReply, inferSentiment } from "../services/ai.js";
import { getLocationFromStore } from "../services/gbp.js";
import { ApiResponse, GbpReview, ReviewReplyRule } from "../types.js";

const router = Router();
const log = logger("reviews");

function pid(p: string | string[] | undefined): string {
  if (Array.isArray(p)) return p[0];
  return p || "";
}

function stableReviewId(locationId: string, author: string, publishedAt?: Date): string {
  const raw = `${locationId}_${author}_${publishedAt ? publishedAt.toISOString() : Date.now()}`;
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = (hash << 5) - hash + raw.charCodeAt(i);
    hash |= 0;
  }
  return `${locationId}_${Math.abs(hash)}`;
}

router.get(
  "/locations/:id/reviews",
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const db = getDb();
      const snap = await db
        .collection("gbp_reviews")
        .where("locationId", "==", pid(req.params.id))
        .get();

      const reviews = snap.docs
        .map((d) => ({ id: d.id, ...d.data() } as GbpReview & { id: string }))
        .sort((a, b) => (b.createdAt?.getTime?.() || 0) - (a.createdAt?.getTime?.() || 0));
      res.json({ success: true, data: reviews } satisfies ApiResponse);
    } catch (e) {
      res.status(500).json({ success: false, error: (e as Error).message } satisfies ApiResponse);
    }
  }
);

router.get(
  "/locations/:id/reviews/unreplied",
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const db = getDb();
      const locId = pid(req.params.id);
      const snap = await db
        .collection("gbp_reviews")
        .where("locationId", "==", locId)
        .get();

      const reviews = snap.docs
        .map((d) => ({ id: d.id, ...d.data() } as GbpReview & { id: string }))
        .filter((r) => !r.reply);
      res.json({ success: true, data: reviews } satisfies ApiResponse);
    } catch (e) {
      res.status(500).json({ success: false, error: (e as Error).message } satisfies ApiResponse);
    }
  }
);

router.post(
  "/locations/:id/reviews/:reviewId/reply",
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const { reply } = req.body;
      if (!reply || typeof reply !== "string") {
        res.status(400).json({ success: false, error: "Missing reply text" } satisfies ApiResponse);
        return;
      }

      const db = getDb();
      await db.collection("gbp_reviews").doc(pid(req.params.reviewId)).update({
        reply,
        repliedAt: new Date(),
        repliedBy: req.user!.uid,
      });

      log.info(`Reply saved for review ${pid(req.params.reviewId)}`);
      res.json({ success: true, message: "Reply saved" } satisfies ApiResponse);
    } catch (e) {
      res.status(500).json({ success: false, error: (e as Error).message } satisfies ApiResponse);
    }
  }
);

/**
 * POST /api/gbp/locations/:id/reviews/sync
 * Pull up to 5 reviews from the Places API and store them (deduped).
 */
router.post(
  "/locations/:id/reviews/sync",
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const db = getDb();
      const locId = pid(req.params.id);
      const location = await getLocationFromStore(locId);
      if (!location?.locationId) {
        res.status(404).json({ success: false, error: "Location not found" } satisfies ApiResponse);
        return;
      }

      const placeReviews = await getReviewsFromPlace(location.locationId);

      const col = db.collection("gbp_reviews");
      let added = 0;

      for (const pr of placeReviews) {
        const rid = stableReviewId(locId, pr.author, pr.publishedAt);
        const existing = await col.doc(rid).get();
        if (existing.exists) continue;

        const review: GbpReview = {
          reviewId: rid,
          locationId: locId,
          author: pr.author,
          authorPhotoUrl: pr.authorPhotoUrl,
          rating: pr.rating,
          comment: pr.comment,
          createdAt: pr.publishedAt || new Date(),
          sentiment: inferSentiment(pr.rating, pr.comment),
          source: "places-api",
        };
        await col.doc(rid).set(review);
        added++;
      }

      res.json({
        success: true,
        data: { fetched: placeReviews.length, added, total: placeReviews.length },
        message: `Synced ${added} new review(s) from Places API`,
      } satisfies ApiResponse);
    } catch (e) {
      res.status(500).json({ success: false, error: (e as Error).message } satisfies ApiResponse);
    }
  }
);

/**
 * POST /api/gbp/locations/:id/reviews
 * Manually add a review (e.g. pasted from Google when Places API omits it).
 */
router.post(
  "/locations/:id/reviews",
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const { author, rating, comment, publishedAt, authorPhotoUrl } = req.body;
      if (!author || typeof author !== "string" || author.trim() === "") {
        res.status(400).json({ success: false, error: "Missing author" } satisfies ApiResponse);
        return;
      }
      const parsedRating = parseInt(rating, 10);
      if (isNaN(parsedRating) || parsedRating < 1 || parsedRating > 5) {
        res.status(400).json({ success: false, error: "Rating must be 1-5" } satisfies ApiResponse);
        return;
      }
      if (!comment || typeof comment !== "string" || comment.trim() === "") {
        res.status(400).json({ success: false, error: "Missing comment" } satisfies ApiResponse);
        return;
      }

      const db = getDb();
      const locId = pid(req.params.id);
      const rid = stableReviewId(locId, author.trim(), publishedAt ? new Date(publishedAt) : undefined);

      const review: GbpReview = {
        reviewId: rid,
        locationId: locId,
        author: author.trim(),
        authorPhotoUrl: authorPhotoUrl || undefined,
        rating: parsedRating,
        comment: comment.trim(),
        createdAt: publishedAt ? new Date(publishedAt) : new Date(),
        sentiment: inferSentiment(parsedRating, comment),
        source: "manual",
      };

      await db.collection("gbp_reviews").doc(rid).set(review, { merge: true });
      res.json({ success: true, data: review, message: "Review added" } satisfies ApiResponse);
    } catch (e) {
      res.status(500).json({ success: false, error: (e as Error).message } satisfies ApiResponse);
    }
  }
);

/**
 * POST /api/gbp/locations/:id/reviews/:reviewId/generate-reply
 * Generate an AI draft reply for a review (copy-paste into Google manually).
 */
router.post(
  "/locations/:id/reviews/:reviewId/generate-reply",
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const db = getDb();
      const locId = pid(req.params.id);
      const rid = pid(req.params.reviewId);

      const reviewDoc = await db.collection("gbp_reviews").doc(rid).get();
      if (!reviewDoc.exists) {
        res.status(404).json({ success: false, error: "Review not found" } satisfies ApiResponse);
        return;
      }

      const location = await getLocationFromStore(locId);
      const review = reviewDoc.data() as GbpReview;
      const { tone } = req.body || {};

      const rulesSnap = await db
        .collection("gbp_review_rules")
        .where("locationId", "==", locId)
        .get();
      const rules = rulesSnap.docs.map((d) => d.data() as ReviewReplyRule);

      const draft = await generateReply({
        review,
        locationName: location?.name || "our store",
        rules,
        tone: typeof tone === "string" && tone ? tone : undefined,
      });

      res.json({ success: true, data: { reviewId: rid, draft } } satisfies ApiResponse);
    } catch (e) {
      res.status(500).json({ success: false, error: (e as Error).message } satisfies ApiResponse);
    }
  }
);

router.get(
  "/locations/:id/reviews/auto-reply/rules",
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const db = getDb();
      const snap = await db
        .collection("gbp_review_rules")
        .where("locationId", "==", pid(req.params.id))
        .get();
      const rules = snap.docs.map((d) => d.data() as ReviewReplyRule);
      res.json({ success: true, data: rules } satisfies ApiResponse);
    } catch (e) {
      res.status(500).json({ success: false, error: (e as Error).message } satisfies ApiResponse);
    }
  }
);

router.post(
  "/locations/:id/reviews/auto-reply/rules",
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const { name, prompt, minRating, maxRating, enabled } = req.body;
      const db = getDb();
      const col = db.collection("gbp_review_rules");
      const rule: ReviewReplyRule = {
        ruleId: "",
        locationId: pid(req.params.id),
        name: name || "Default Rule",
        prompt: prompt || "",
        minRating: minRating ?? 1,
        maxRating: maxRating ?? 5,
        enabled: enabled ?? true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const docRef = await col.add(rule);
      rule.ruleId = docRef.id;
      await docRef.update({ ruleId: docRef.id });

      res.json({ success: true, data: rule, message: "Rule created" } satisfies ApiResponse);
    } catch (e) {
      res.status(500).json({ success: false, error: (e as Error).message } satisfies ApiResponse);
    }
  }
);

export default router;
