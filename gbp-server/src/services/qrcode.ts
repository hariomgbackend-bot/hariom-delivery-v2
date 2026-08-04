import QRCode from "qrcode";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

const log = logger("qrcode");

/**
 * Build the "write a review" URL for a Google place.
 * Opens Google's review composer where the customer pastes the AI review.
 */
export function buildWriteReviewUrl(placeId: string): string {
  return `https://search.google.com/local/writereview?placeid=${encodeURIComponent(placeId)}`;
}

/**
 * Build the customer-facing curated review wizard URL for a location.
 * This is what QR codes point to.
 */
export function buildReviewWizardUrl(locationId: string): string {
  const base = (config.publicBaseUrl || "http://localhost:5001").replace(/\/+$/, "");
  return `${base}/review/${encodeURIComponent(locationId)}`;
}

export interface QrOptions {
  width?: number;
  margin?: number;
}

/**
 * Generate a QR code PNG buffer for a URL.
 */
export async function generateQr(url: string, options: QrOptions = {}): Promise<Buffer> {
  const width = options.width ?? 512;
  const margin = options.margin ?? 2;

  try {
    return await QRCode.toBuffer(url, {
      type: "png",
      width,
      margin,
      errorCorrectionLevel: "M",
    });
  } catch (e) {
    log.warn("QR generation failed", e);
    throw e;
  }
}

/**
 * Generate a QR code as a data URL (for preview in the dashboard).
 */
export async function generateQrDataUrl(url: string, options: QrOptions = {}): Promise<string> {
  const width = options.width ?? 256;
  const margin = options.margin ?? 2;

  try {
    return await QRCode.toDataURL(url, {
      type: "image/png",
      width,
      margin,
      errorCorrectionLevel: "M",
    });
  } catch (e) {
    log.warn("QR data URL generation failed", e);
    throw e;
  }
}
