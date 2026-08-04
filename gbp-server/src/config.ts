import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

export const config = {
  port: parseInt(process.env.PORT || "5001", 10),
  nodeEnv: process.env.NODE_ENV || "development",

  // Google OAuth
  googleClientId: process.env.GOOGLE_CLIENT_ID || "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
  googleRedirectUri: process.env.GOOGLE_REDIRECT_URI || "",

  // Google Places API
  googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || "",

  // Groq AI
  groqApiKey: process.env.GROQ_API_KEY || "",

  // JWT
  jwtSecret: process.env.JWT_SECRET || "",

  // Admin login (mirrors main server env fallback)
  adminEmail: process.env.ADMIN_EMAIL || "",
  adminPassword: process.env.ADMIN_PASSWORD || "",

  // Public base URL used to build customer-facing links / QR targets
  publicBaseUrl: process.env.PUBLIC_BASE_URL || "http://localhost:5001",

  // Firebase
  firebaseStorageBucket: process.env.FIREBASE_STORAGE_BUCKET || "",
  firebaseDatabaseUrl: process.env.FIREBASE_DATABASE_URL || "",

  // Firebase Admin SDK path
  firebaseServiceAccount: path.resolve(__dirname, "../../firebase-service-account.json"),
};

function validateConfig(): void {
  const missing: string[] = [];
  if (!config.googleClientId) missing.push("GOOGLE_CLIENT_ID");
  if (!config.jwtSecret) missing.push("JWT_SECRET");
  if (missing.length > 0) {
    console.warn(`[config] Missing env vars: ${missing.join(", ")}`);
  }
}

validateConfig();
