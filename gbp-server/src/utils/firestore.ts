import admin, { ServiceAccount } from "firebase-admin";
import { readFileSync } from "fs";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

const log = logger("firestore");
let _app: admin.app.App | null = null;
let _db: FirebaseFirestore.Firestore | null = null;

export function getFirebaseAdmin(): admin.app.App {
  if (_app) return _app;

  // Reuse an already-initialized default app (e.g. when mounted inside the
  // main server.js, which calls admin.initializeApp with the same project).
  if (admin.apps.length > 0 && admin.apps[0]) {
    _app = admin.apps[0];
    return _app;
  }

  try {
    const serviceAccount = JSON.parse(
      readFileSync(config.firebaseServiceAccount, "utf-8")
    ) as ServiceAccount;
    _app = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      storageBucket: config.firebaseStorageBucket,
    });
  } catch {
    // Mirror server.js: fall back to FIREBASE_SERVICE_ACCOUNT (JSON env var),
    // commonly set on Render where the gitignored service-account file is absent.
    const fromEnv = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (fromEnv) {
      try {
        const serviceAccount = JSON.parse(fromEnv) as ServiceAccount;
        _app = admin.initializeApp({
          credential: admin.credential.cert(serviceAccount),
          storageBucket: config.firebaseStorageBucket,
        });
        return _app;
      } catch (eEnv) {
        log.warn("Could not initialize Firebase from FIREBASE_SERVICE_ACCOUNT env", eEnv);
      }
    }

    try {
      _app = admin.initializeApp({
        credential: admin.credential.applicationDefault(),
        storageBucket: config.firebaseStorageBucket,
      });
    } catch (e2) {
      log.error("Failed to initialize Firebase Admin", e2);
      throw e2;
    }
  }

  return _app;
}

export function getDb(): FirebaseFirestore.Firestore {
  if (_db) return _db;
  _db = getFirebaseAdmin().firestore();
  _db.settings({ ignoreUndefinedProperties: true });
  return _db;
}
