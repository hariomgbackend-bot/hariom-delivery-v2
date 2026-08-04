import { Router, Request, Response } from "express";
import { authenticate } from "../middleware/auth.js";
import { logger } from "../utils/logger.js";
import { getLocationFromStore } from "../services/gbp.js";
import {
  generateQr,
  generateQrDataUrl,
  buildReviewWizardUrl,
  buildWriteReviewUrl,
} from "../services/qrcode.js";
import { ApiResponse } from "../types.js";

const router = Router();
const log = logger("qrcode");

function pid(p: string | string[] | undefined): string {
  if (Array.isArray(p)) return p[0];
  return p || "";
}

/**
 * GET /api/gbp/public/qr?url=<absolute url>&width=<px>
 * Public — server-side QR PNG for any https URL. Used by the staff "Take Review"
 * tab so it does not depend on a client-side QR library (often blocked offline).
 */
router.get("/public/qr", async (req: Request, res: Response) => {
  try {
    const raw = Array.isArray(req.query.url) ? String(req.query.url[0] ?? "") : String(req.query.url ?? "");
    if (!/^https?:\/\//i.test(raw)) {
      res.status(400).json({ success: false, error: "url must be an absolute http(s) URL" } satisfies ApiResponse);
      return;
    }
    const width = parseInt(String(req.query.width || "512"), 10);
    const png = await generateQr(raw, { width: isNaN(width) || width <= 0 ? 512 : width });
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    res.send(png);
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message } satisfies ApiResponse);
  }
});

/**
 * GET /api/gbp/locations/:id/qrcode
 * Download a PNG QR code. Scans open the curated review wizard for the place.
 */
router.get("/locations/:id/qrcode", authenticate, async (req: Request, res: Response) => {
  try {
    const location = await getLocationFromStore(pid(req.params.id));
    if (!location?.locationId) {
      res.status(404).json({ success: false, error: "Location not found" } satisfies ApiResponse);
      return;
    }

    const width = parseInt(String(req.query.width || "512"), 10);
    const url = buildReviewWizardUrl(location.locationId);
    const png = await generateQr(url, {
      width: isNaN(width) ? 512 : width,
    });

    res.setHeader("Content-Type", "image/png");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="review-qr-${encodeURIComponent(location.name)}.png"`
    );
    res.send(png);
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message } satisfies ApiResponse);
  }
});

/**
 * GET /api/gbp/locations/:id/qrcode/preview
 * Return the wizard URL, Google write-review URL, and QR data URL.
 */
router.get(
  "/locations/:id/qrcode/preview",
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const location = await getLocationFromStore(pid(req.params.id));
      if (!location?.locationId) {
        res.status(404).json({ success: false, error: "Location not found" } satisfies ApiResponse);
        return;
      }

      const wizardUrl = buildReviewWizardUrl(location.locationId);
      const dataUrl = await generateQrDataUrl(wizardUrl);
      res.json({
        success: true,
        data: {
          placeId: location.locationId,
          wizardUrl,
          writeReviewUrl: buildWriteReviewUrl(location.locationId),
          qrDataUrl: dataUrl,
        },
      } satisfies ApiResponse);
    } catch (e) {
      res.status(500).json({ success: false, error: (e as Error).message } satisfies ApiResponse);
    }
  }
);

export default router;
