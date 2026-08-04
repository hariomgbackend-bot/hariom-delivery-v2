import { Router, Request, Response } from "express";
import { authenticate } from "../middleware/auth.js";
import { getDb } from "../utils/firestore.js";
import { logger } from "../utils/logger.js";
import { getLocationFromStore } from "../services/gbp.js";
import { runProfileAudit, loadCompetitors } from "../services/audit.js";
import { ApiResponse, ProfileAudit } from "../types.js";

const router = Router();
const log = logger("audit");

function pid(p: string | string[] | undefined): string {
  if (Array.isArray(p)) return p[0];
  return p || "";
}

/**
 * POST /api/gbp/locations/:id/audit
 * Run a fresh profile audit and store it.
 */
router.post("/locations/:id/audit", authenticate, async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const locId = pid(req.params.id);
    const location = await getLocationFromStore(locId);
    if (!location?.locationId) {
      res.status(404).json({ success: false, error: "Location not found" } satisfies ApiResponse);
      return;
    }

    const competitors = await loadCompetitors(locId);
    const audit = await runProfileAudit({ location, competitors });
    audit.auditId = `${locId}_${Date.now()}`;

    await db.collection("gbp_audits").doc(audit.auditId).set(audit);

    log.info(`Audit for ${locId} scored ${audit.score}/100`);
    res.json({ success: true, data: audit, message: `Audit score: ${audit.score}/100` } satisfies ApiResponse);
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message } satisfies ApiResponse);
  }
});

/**
 * GET /api/gbp/locations/:id/audit/latest
 * Get the most recent stored audit for a location.
 */
router.get("/locations/:id/audit/latest", authenticate, async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const snap = await db
      .collection("gbp_audits")
      .where("locationId", "==", pid(req.params.id))
      .get();

    const audits = snap.docs
      .map((d) => d.data() as ProfileAudit)
      .sort((a, b) => (b.ranAt?.getTime?.() || 0) - (a.ranAt?.getTime?.() || 0));
    const audit = audits[0];
    if (!audit) {
      res.json({ success: true, data: null, message: "No audit run yet" } satisfies ApiResponse);
      return;
    }
    res.json({ success: true, data: audit } satisfies ApiResponse);
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message } satisfies ApiResponse);
  }
});

export default router;
