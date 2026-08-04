import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "./config.js";
import { logger } from "./utils/logger.js";
import { getFirebaseAdmin } from "./utils/firestore.js";

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
const app = express();

// ── Middleware ──
app.use(cors());
app.use(express.json({ limit: "5mb" }));

// ── Static dashboard ──
app.use(express.static(path.resolve(__dirname, "../public")));

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

// ── 404 handler ──
app.use((_req, res) => {
  res.status(404).json({ success: false, error: "Not found" });
});

// ── Error handler ──
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  log.error("Unhandled error", err);
  res.status(500).json({ success: false, error: err.message || "Internal server error" });
});

// ── Start ──
async function start() {
  try {
    getFirebaseAdmin();
    log.info("Firebase Admin initialized");
  } catch (e) {
    log.error("Firebase Admin init failed — some features will be unavailable", e);
  }

  app.listen(config.port, () => {
    log.info(`GBP server running on http://localhost:${config.port}`);
    log.info(`Health check: http://localhost:${config.port}/api/gbp/health`);
  });
}

start();
