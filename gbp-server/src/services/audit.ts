import { getDb } from "../utils/firestore.js";
import { logger } from "../utils/logger.js";
import { getPlaceDetails } from "./places.js";
import {
  ProfileAudit,
  AuditDimension,
  AuditSuggestion,
  CompetitorComparison,
  GbpLocation,
  Competitor,
} from "../types.js";

const log = logger("audit");

interface AuditInput {
  location: GbpLocation;
  competitors: Competitor[];
}

export async function runProfileAudit({ location, competitors }: AuditInput): Promise<ProfileAudit> {
  const place = await getPlaceDetails(location.locationId);

  const dimensions: AuditDimension[] = [];
  const suggestions: AuditSuggestion[] = [];

  // 1. Basic info (name + category)
  {
    let score = 0;
    if (place?.name) score += 8;
    if (location.name) score += 4;
    if (place?.category) score += 8;
    dimensions.push({
      name: "Basic Info & Category",
      score,
      maxScore: 20,
      details: place?.category
        ? `Category: ${place.category}`
        : "No category detected — add a category to your listing.",
    });
    if (score < 12) {
      suggestions.push({
        category: "Basic Info",
        description: "Ensure your business has a complete name and a specific category selected on Google.",
        priority: "high",
      });
    }
  }

  // 2. Contact info (phone + website)
  {
    let score = 0;
    const details: string[] = [];
    if (place?.phone) {
      score += 10;
      details.push(`Phone: ${place.phone}`);
    } else {
      details.push("No phone number on listing");
    }
    if (place?.website) {
      score += 10;
      details.push("Website present");
    } else {
      details.push("No website on listing");
    }
    dimensions.push({
      name: "Contact Info",
      score,
      maxScore: 20,
      details: details.join(" · "),
    });
    if (!place?.phone) {
      suggestions.push({
        category: "Contact",
        description: "Add your phone number to the Google Business Profile.",
        priority: "high",
      });
    }
    if (!place?.website) {
      suggestions.push({
        category: "Contact",
        description: "Add your official website URL to the profile — it boosts credibility and SEO.",
        priority: "medium",
      });
    }
  }

  // 3. Rating
  {
    const rating = place?.rating ?? location.rating ?? 0;
    const score = Math.min(20, Math.round(rating * 4));
    dimensions.push({
      name: "Overall Rating",
      score,
      maxScore: 20,
      details: rating ? `Current rating: ${rating} / 5` : "No rating available",
    });
    if (rating > 0 && rating < 4) {
      suggestions.push({
        category: "Rating",
        description: "Rating is below 4.0 — focus on collecting more positive reviews via QR codes.",
        priority: "high",
      });
    }
  }

  // 4. Review volume
  {
    const count = place?.totalReviews ?? location.totalReviews ?? 0;
    const score = Math.min(20, Math.round(count / 5));
    dimensions.push({
      name: "Review Volume",
      score,
      maxScore: 20,
      details: count ? `${count} total reviews` : "No reviews detected",
    });
    if (count < 50) {
      suggestions.push({
        category: "Reviews",
        description: "Review count is low. Promote the review QR code at the counter to grow reviews.",
        priority: "medium",
      });
    }
  }

  // 5. Competitor comparison
  {
    let score = 0;
    const details: string[] = [];
    if (competitors.length > 0) {
      const avgRating =
        competitors.reduce((s, c) => s + (c.rating || 0), 0) / competitors.length;
      const avgCount =
        competitors.reduce((s, c) => s + (c.reviewCount || 0), 0) / competitors.length;
      const ourRating = place?.rating ?? location.rating ?? 0;

      if (ourRating >= avgRating) {
        score += 10;
        details.push("Rating is at/above competitor average");
      } else {
        details.push(`Rating below competitor average (${avgRating.toFixed(1)})`);
      }
      if ((location.totalReviews ?? 0) >= avgCount) {
        score += 10;
        details.push("Review count at/above competitor average");
      } else {
        details.push(`Review count below competitor average (${Math.round(avgCount)})`);
      }
    } else {
      details.push("No competitor data — run auto-detect");
      suggestions.push({
        category: "Competitors",
        description: "Run competitor auto-detect to benchmark against nearby stores.",
        priority: "low",
      });
    }
    dimensions.push({
      name: "Competitive Standing",
      score,
      maxScore: 20,
      details: details.join(" · "),
    });
  }

  const totalScore = dimensions.reduce((s, d) => s + d.score, 0);

  const comparison: CompetitorComparison | undefined = competitors.length
    ? {
        totalCompetitors: competitors.length,
        avgRating:
          competitors.reduce((s, c) => s + (c.rating || 0), 0) / competitors.length,
        avgReviewCount:
          competitors.reduce((s, c) => s + (c.reviewCount || 0), 0) / competitors.length,
        topCompetitors: competitors
          .slice()
          .sort((a, b) => (b.reviewCount || 0) - (a.reviewCount || 0))
          .slice(0, 5)
          .map((c) => c.name),
      }
    : undefined;

  return {
    auditId: "",
    locationId: location.locationId,
    score: totalScore,
    dimensions,
    suggestions,
    competitorComparison: comparison,
    ranAt: new Date(),
  };
}

export async function loadCompetitors(locationId: string): Promise<Competitor[]> {
  const db = getDb();
  const snap = await db
    .collection("gbp_competitors")
    .where("locationId", "==", locationId)
    .get();
  return snap.docs.map((d) => d.data() as Competitor);
}
