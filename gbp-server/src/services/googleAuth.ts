import { OAuth2Client, Credentials } from "google-auth-library";
import { config } from "../config.js";
import { getDb } from "../utils/firestore.js";
import { logger } from "../utils/logger.js";
import { GoogleTokens } from "../types.js";

const log = logger("google-auth");

const SCOPES = ["https://www.googleapis.com/auth/business.manage"];
const COLLECTION = "gbp_accounts";

function getOAuth2Client(): OAuth2Client {
  return new OAuth2Client({
    clientId: config.googleClientId,
    clientSecret: config.googleClientSecret,
    redirectUri: config.googleRedirectUri,
  });
}

export function generateAuthUrl(uid: string): string {
  const oauth = getOAuth2Client();
  return oauth.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    state: uid,
    prompt: "consent",
  });
}

export async function exchangeCode(code: string): Promise<{ tokens: Credentials; email?: string }> {
  const oauth = getOAuth2Client();
  const { tokens } = await oauth.getToken(code);
  oauth.setCredentials(tokens);

  let email: string | undefined;
  try {
    const tokenInfo = await oauth.getTokenInfo(tokens.access_token!);
    email = tokenInfo.email;
  } catch {
    const response = await oauth.request({
      url: "https://www.googleapis.com/oauth2/v2/userinfo",
    });
    email = (response.data as { email?: string }).email;
  }

  return { tokens, email };
}

export async function storeTokens(
  uid: string,
  tokens: Credentials,
  email: string,
  googleAccountId?: string
): Promise<void> {
  const db = getDb();
  const tokenData: GoogleTokens = {
    accessToken: tokens.access_token ?? "",
    refreshToken: tokens.refresh_token ?? undefined,
    expiryDate: tokens.expiry_date ?? undefined,
    scope: tokens.scope ?? undefined,
    tokenType: tokens.token_type ?? undefined,
  };

  await db.collection(COLLECTION).doc(uid).set(
    {
      uid,
      email,
      googleAccountId: googleAccountId || "",
      tokens: tokenData,
      linkedAt: new Date(),
      linkedBy: uid,
      syncedAt: new Date(),
    },
    { merge: true }
  );

  log.info(`Tokens stored for ${email}`);
}

export async function getStoredTokens(uid: string): Promise<Credentials | null> {
  const db = getDb();
  const doc = await db.collection(COLLECTION).doc(uid).get();
  if (!doc.exists) return null;

  const data = doc.data()!;
  const t = data.tokens as GoogleTokens | undefined;
  if (!t?.accessToken) return null;

  return {
    access_token: t.accessToken,
    refresh_token: t.refreshToken,
    expiry_date: t.expiryDate,
    scope: t.scope,
    token_type: t.tokenType,
  };
}

export async function getAuthenticatedClient(uid: string): Promise<OAuth2Client | null> {
  const tokens = await getStoredTokens(uid);
  if (!tokens) return null;

  const oauth = getOAuth2Client();
  oauth.setCredentials(tokens);

  oauth.on("tokens", async (newTokens) => {
    const db = getDb();
    await db
      .collection(COLLECTION)
      .doc(uid)
      .update({
        "tokens.accessToken": newTokens.access_token ?? "",
        "tokens.expiryDate": newTokens.expiry_date ?? null,
        "tokens.refreshToken": newTokens.refresh_token ?? null,
      });
    log.info("Tokens refreshed for", uid);
  });

  return oauth;
}

export async function revokeTokens(uid: string): Promise<void> {
  const tokens = await getStoredTokens(uid);
  if (tokens?.access_token) {
    try {
      const oauth = getOAuth2Client();
      oauth.setCredentials(tokens);
      await oauth.revokeToken(tokens.access_token!);
    } catch (e) {
      log.warn("Token revocation failed", e);
    }
  }

  const db = getDb();
  await db.collection(COLLECTION).doc(uid).delete();
  log.info(`Tokens revoked for ${uid}`);
}

export async function listLinkedAccounts(): Promise<
  { uid: string; email: string; linkedAt: Date; accountId?: string }[]
> {
  const db = getDb();
  const snap = await db.collection(COLLECTION).get();
  return snap.docs.map((d) => {
    const data = d.data();
    return {
      uid: d.id,
      email: data.email || "",
      linkedAt: data.linkedAt?.toDate() || new Date(),
      accountId: data.accountId || undefined,
    };
  });
}

export async function getAccount(uid: string): Promise<Record<string, unknown> | null> {
  const db = getDb();
  const doc = await db.collection(COLLECTION).doc(uid).get();
  return doc.exists ? doc.data() || null : null;
}
