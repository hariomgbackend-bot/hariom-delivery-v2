import { Router, Request, Response } from "express";
import { authenticate } from "../middleware/auth.js";
import {
  generateAuthUrl,
  exchangeCode,
  storeTokens,
  revokeTokens,
  getAccount,
  listLinkedAccounts,
} from "../services/googleAuth.js";
import { logger } from "../utils/logger.js";
import { ApiResponse } from "../types.js";

const router = Router();
const log = logger("oauth");

/**
 * GET /api/gbp/auth
 * Redirect user to Google OAuth consent screen.
 */
router.get("/auth", authenticate, (req: Request, res: Response) => {
  try {
    const uid = req.user!.uid;
    const url = generateAuthUrl(uid);
    res.redirect(url);
  } catch (e) {
    const msg = (e as Error).message;
    log.error("Auth URL generation failed", e);
    res.status(500).json({ success: false, error: msg } satisfies ApiResponse);
  }
});

/**
 * GET /api/gbp/auth/callback
 * OAuth callback — exchange code for tokens, store in Firestore.
 */
router.get("/auth/callback", async (req: Request, res: Response) => {
  try {
    const { code, state: uid } = req.query;

    if (!code || typeof code !== "string" || !uid || typeof uid !== "string") {
      res.status(400).json({ success: false, error: "Missing code or state" } satisfies ApiResponse);
      return;
    }

    const { tokens, email } = await exchangeCode(code);
    await storeTokens(uid, tokens, email || "unknown@google.com");

    log.info(`Account linked: ${email}`);
    res.redirect(`/google-business.html?linked=true&email=${encodeURIComponent(email || "")}`);
  } catch (e) {
    log.error("OAuth callback failed", e);
    const msg = (e as Error).message;
    res.redirect(`/google-business.html?linked=false&error=${encodeURIComponent(msg)}`);
  }
});

/**
 * GET /api/gbp/auth/status
 * Check if the current user has a linked Google account.
 */
router.get("/auth/status", authenticate, async (req: Request, res: Response) => {
  try {
    const uid = req.user!.uid;
    const account = await getAccount(uid);
    res.json({
      success: true,
      data: {
        linked: !!account,
        email: account?.email || null,
        linkedAt: account?.linkedAt || null,
        accountId: account?.accountId || null,
      },
    } satisfies ApiResponse);
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message } satisfies ApiResponse);
  }
});

/**
 * DELETE /api/gbp/auth
 * Revoke Google OAuth tokens and unlink account.
 */
router.delete("/auth", authenticate, async (req: Request, res: Response) => {
  try {
    const uid = req.user!.uid;
    await revokeTokens(uid);
    res.json({ success: true, message: "Account unlinked" } satisfies ApiResponse);
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message } satisfies ApiResponse);
  }
});

/**
 * GET /api/gbp/auth/accounts
 * List all linked Google accounts (admin only).
 */
router.get("/auth/accounts", authenticate, async (_req: Request, res: Response) => {
  try {
    const accounts = await listLinkedAccounts();
    res.json({ success: true, data: accounts } satisfies ApiResponse);
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message } satisfies ApiResponse);
  }
});

export default router;
