import { getDb } from "../utils/firestore.js";
import { logger } from "../utils/logger.js";
import {
  GbpReport,
  ReportData,
  GbpReview,
  Competitor,
  TrackedKeyword,
  ProfileAudit,
} from "../types.js";

const log = logger("report");

function periodKey(type: "weekly" | "monthly", ref: Date = new Date()): string {
  if (type === "weekly") {
    const d = new Date(ref);
    const iso = new Date(d.getTime() - d.getDay() * 86400000);
    return `${iso.toISOString().slice(0, 10)}`;
  }
  return ref.toISOString().slice(0, 7);
}

export async function generateReport(
  locationId: string,
  type: "weekly" | "monthly"
): Promise<GbpReport> {
  const db = getDb();
  const period = periodKey(type);
  const since = new Date();
  since.setDate(since.getDate() - (type === "weekly" ? 7 : 30));

  const reviewSnap = await db
    .collection("gbp_reviews")
    .where("locationId", "==", locationId)
    .get();
  const reviews = reviewSnap.docs.map((d) => d.data() as GbpReview);

  const newReviews = reviews.filter((r) => r.createdAt && r.createdAt >= since);
  const total = reviews.length;
  const avgRating = total
    ? reviews.reduce((s, r) => s + r.rating, 0) / total
    : 0;
  const responded = reviews.filter((r) => r.reply).length;

  const compSnap = await db
    .collection("gbp_competitors")
    .where("locationId", "==", locationId)
    .get();
  const competitors = compSnap.docs.map((d) => d.data() as Competitor);

  const kwSnap = await db
    .collection("gbp_keywords")
    .where("locationId", "==", locationId)
    .get();
  const keywords = kwSnap.docs.map((d) => d.data() as TrackedKeyword);

  const ranked = keywords.filter((k) => typeof k.currentRank === "number");
  const avgPosition = ranked.length
    ? ranked.reduce((s, k) => s + (k.currentRank || 0), 0) / ranked.length
    : 0;

  let improved = 0;
  let declined = 0;
  for (const k of keywords) {
    const h = Array.isArray(k.rankHistory) ? k.rankHistory : [];
    if (h.length < 2) continue;
    const prev = h[h.length - 2].position;
    const curr = h[h.length - 1].position;
    if (prev === 0 || curr === 0) continue;
    if (curr < prev) improved++;
    if (curr > prev) declined++;
  }

  const auditSnap = await db
    .collection("gbp_audits")
    .where("locationId", "==", locationId)
    .get();
  const latestAudit = auditSnap.docs
    .map((d) => d.data() as ProfileAudit)
    .sort((a, b) => (b.ranAt?.getTime?.() || 0) - (a.ranAt?.getTime?.() || 0))[0];

  const data: ReportData = {
    reviewStats: {
      total,
      avgRating: Math.round(avgRating * 100) / 100,
      response: total ? Math.round((responded / total) * 100) : 0,
      newReviews: newReviews.length,
    },
    competitorData:
      competitors.length > 0
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
        : undefined,
    keywordData:
      keywords.length > 0
        ? {
            tracked: keywords.length,
            avgPosition: Math.round(avgPosition * 100) / 100,
            improved,
            declined,
          }
        : undefined,
    auditScore: latestAudit?.score,
  };

  const report: GbpReport = {
    reportId: "",
    locationId,
    type,
    period,
    data,
    generatedAt: new Date(),
    status: "ready",
  };

  const ref = await db.collection("gbp_reports").add(report);
  report.reportId = ref.id;
  await ref.update({ reportId: ref.id });

  log.info(`Report ${report.reportId} (${type} ${period}) generated for ${locationId}`);
  return report;
}
