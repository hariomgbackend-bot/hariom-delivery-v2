import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "./utils/logger.js";

import authRoutes from "./routes/auth.js";
import oauthRoutes from "./routes/oauth.js";
import locationRoutes from "./routes/locations.js";
import reviewRoutes from "./routes/reviews.js";
import qrcodeRoutes from "./routes/qrcode.js";
import publicReviewRoutes from "./routes/publicReview.js";
import keywordRoutes from "./routes/keywords.js";
import auditRoutes from "./routes/audit.js";
import reportRoutes from "./routes/reports.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = logger("gbp-server");

/**
 * Shared gbp Express app — routes only.
 * No cors / body-parser / root static / listen: those are added by the
 * embedding server (server.js) or by index.ts when running standalone.
 */
export function createApp(): express.Express {
  const app = express();

  // ── Request logging ──
  app.use((req, _res, next) => {
    log.info(`${req.method} ${req.path}`);
    next();
  });

  // ── Health check ──
  app.get("/api/gbp/health", (_req, res) => {
    res.json({ status: "ok", version: "1.0.0", timestamp: new Date().toISOString() });
  });

  // ── Public review wizard page (scanned from QR codes) ──
  app.get("/review/:locationId", (_req, res) => {
    res.sendFile(path.resolve(__dirname, "../public/review.html"));
  });

  // ── Routes ──
  app.use("/api/gbp", authRoutes);
  app.use("/api/gbp", oauthRoutes);
  app.use("/api/gbp", locationRoutes);
  app.use("/api/gbp", reviewRoutes);
  app.use("/api/gbp", qrcodeRoutes);
  app.use("/api/gbp", publicReviewRoutes);
  app.use("/api/gbp", keywordRoutes);
  app.use("/api/gbp", auditRoutes);
  app.use("/api/gbp", reportRoutes);

  return app;
}