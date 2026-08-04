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
