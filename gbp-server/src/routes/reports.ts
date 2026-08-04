import { Router, Request, Response } from "express";
import { authenticate } from "../middleware/auth.js";
import { getDb } from "../utils/firestore.js";
import { logger } from "../utils/logger.js";
import { generateReport } from "../services/report.js";
import { ApiResponse, GbpReport } from "../types.js";

const router = Router();
const log = logger("reports");

function pid(p: string | string[] | undefined): string {
  if (Array.isArray(p)) return p[0];
  return p || "";
}

/**
 * POST /api/gbp/locations/:id/reports/generate
 * Generate a weekly or monthly report. Body: { type: "weekly" | "monthly" }
 */
router.post(
  "/locations/:id/reports/generate",
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const type = req.body?.type === "monthly" ? "monthly" : "weekly";
      const report = await generateReport(pid(req.params.id), type);
      res.json({ success: true, data: report, message: "Report generated" } satisfies ApiResponse);
    } catch (e) {
      res.status(500).json({ success: false, error: (e as Error).message } satisfies ApiResponse);
    }
  }
);

/**
 * GET /api/gbp/locations/:id/reports
 * List reports for a location (newest first).
 */
router.get("/locations/:id/reports", authenticate, async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const snap = await db
      .collection("gbp_reports")
      .where("locationId", "==", pid(req.params.id))
      .get();

    const reports = snap.docs
      .map((d) => d.data() as GbpReport)
      .sort((a, b) => (b.generatedAt?.getTime?.() || 0) - (a.generatedAt?.getTime?.() || 0))
      .slice(0, 50);
    res.json({ success: true, data: reports } satisfies ApiResponse);
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message } satisfies ApiResponse);
  }
});

/**
 * GET /api/gbp/locations/:id/reports/:reportId
 * Get a single report.
 */
router.get(
  "/locations/:id/reports/:reportId",
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const db = getDb();
      const doc = await db.collection("gbp_reports").doc(pid(req.params.reportId)).get();
      if (!doc.exists) {
        res.status(404).json({ success: false, error: "Report not found" } satisfies ApiResponse);
        return;
      }
      res.json({ success: true, data: doc.data() as GbpReport } satisfies ApiResponse);
    } catch (e) {
      res.status(500).json({ success: false, error: (e as Error).message } satisfies ApiResponse);
    }
  }
);

export default router;
