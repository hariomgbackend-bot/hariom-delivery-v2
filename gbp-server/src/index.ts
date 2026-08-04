import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "./config.js";
import { logger } from "./utils/logger.js";
import { getFirebaseAdmin } from "./utils/firestore.js";
import { createApp } from "./app.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = logger("gbp-server");

const app = createApp();

// ── Standalone-only middleware ──
app.use(cors());
app.use(express.json({ limit: "5mb" }));

// ── Static dashboard (standalone only) ──
app.use(express.static(path.resolve(__dirname, "../public")));

// ── 404 handler (standalone only) ──
app.use((_req, res) => {
  res.status(404).json({ success: false, error: "Not found" });
});

// ── Error handler (standalone only) ──
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