import { Router, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { getDb } from "../utils/firestore.js";
import { logger } from "../utils/logger.js";
import { ApiResponse } from "../types.js";

const router = Router();
const log = logger("auth");

const JWT_EXPIRY = "7d";

interface LoginResponse {
  success: boolean;
  token: string;
  role: string;
  isSuperAdmin: boolean;
  error?: string;
}

/**
 * POST /api/gbp/auth/login
 * Mirrors the main DMS server /admin/login: checks staff_users collection
 * first, then falls back to ADMIN_EMAIL/ADMIN_PASSWORD env vars.
 */
router.post("/auth/login", async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      res.status(400).json({ success: false, error: "Email and password required" } satisfies ApiResponse);
      return;
    }
    const normalized = String(email).toLowerCase().trim();

    const db = getDb();
    const staffSnap = await db
      .collection("staff_users")
      .where("email", "==", normalized)
      .where("role", "==", "admin")
      .limit(1)
      .get();

    if (!staffSnap.empty) {
      const staffData = staffSnap.docs[0].data();
      if (staffData.active === false) {
        res.status(403).json({ success: false, error: "Account deactivated" } satisfies ApiResponse);
        return;
      }
      const token = jwt.sign(
        { role: "admin", isSuperAdmin: true, email: normalized, staffId: staffSnap.docs[0].id, name: staffData.name || "" },
        config.jwtSecret,
        { expiresIn: JWT_EXPIRY }
      );
      res.json({ success: true, token, role: "admin", isSuperAdmin: true } satisfies LoginResponse);
      return;
    }

    // Fallback: env-var auth (pre-migration / standalone)
    if (normalized === config.adminEmail.toLowerCase().trim() && password === config.adminPassword) {
      const token = jwt.sign(
        { role: "admin", isSuperAdmin: true, email: normalized },
        config.jwtSecret,
        { expiresIn: JWT_EXPIRY }
      );
      res.json({ success: true, token, role: "admin", isSuperAdmin: true } satisfies LoginResponse);
      return;
    }

    res.status(401).json({ success: false, error: "Invalid credentials" } satisfies ApiResponse);
  } catch (e) {
    log.warn("Login failed", e);
    res.status(500).json({ success: false, error: "Login failed" } satisfies ApiResponse);
  }
});

export default router;
