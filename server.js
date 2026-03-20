import express from "express";
import cors from "cors";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import db from "./firestore.js";
import { storage } from "./storage.js";
import fetch from "node-fetch";
import multer from "multer";
import { ref, uploadBytes, getDownloadURL, deleteObject } from "firebase/storage";
import {
  collection, addDoc, getDocs, Timestamp,
  doc, getDoc, updateDoc, deleteDoc,
  query, where, setDoc
} from "firebase/firestore";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import dotenv from "dotenv";
import admin from "firebase-admin";
import { createRequire } from "module";
import rateLimit from "express-rate-limit";
import cron from "node-cron";

dotenv.config();

const require = createRequire(import.meta.url);
//const serviceAccount = require("./firebase-service-account.json");
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const JWT_SECRET       = process.env.JWT_SECRET;
const JWT_EXPIRY       = "8h";
const WHATSAPP_TOKEN   = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID  = process.env.PHONE_NUMBER_ID;
const FAST2SMS_API_KEY = process.env.FAST2SMS_API_KEY;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

const app = express();
app.set("trust proxy", 1); // Required on Render — sits behind a reverse proxy
app.use(cors({
  origin: [
    'https://hariom-delivery.onrender.com',
    'https://hariom-delivery-v2.onrender.com',
    'https://hariom-delivery.web.app'
  ],
  credentials: true
}));
app.use(express.json());
app.use(express.static("."));

app.get("/", (req, res) => {
  res.sendFile(process.cwd() + "/driver_interface.html");
});

/* ════════════════════════════════════════════════
   IST DATE HELPER
════════════════════════════════════════════════ */
function todayIST() {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().split("T")[0];
}

function statusForETA(etaString) {
  if (!etaString) return "pending";
  return etaString.slice(0, 10) > todayIST() ? "booked" : "pending";
}

/* ════════════════════════════════════════════════
   CRON — 6:00 AM IST daily
   Flips booked → pending when delivery date arrives
════════════════════════════════════════════════ */
cron.schedule("30 0 * * *", async () => {
  try {
    const today = todayIST();
    console.log(`[CRON] booked→pending flip for ${today}`);
    const snap = await getDocs(query(collection(db, "deliveries"), where("status", "==", "booked")));
    let flipped = 0;
    for (const d of snap.docs) {
      const eta = d.data().estimated_delivery_time;
      if (eta && eta.slice(0, 10) <= today) {
        await updateDoc(doc(db, "deliveries", d.id), { status: "pending" });
        flipped++;
      }
    }
    console.log(`[CRON] Flipped ${flipped} deliveries`);
  } catch (err) {
    console.error("[CRON] error:", err.message);
  }
}, { timezone: "Asia/Kolkata" });

/* ════════════════════════════════════════════════
   STARTUP MIGRATION — runs every deploy
   Flips any pending deliveries with future ETA → booked
   Safe to run repeatedly (only touches pending ones)
════════════════════════════════════════════════ */
async function runStartupMigration() {
  try {
    const today = todayIST();
    const snap = await getDocs(query(collection(db, "deliveries"), where("status", "==", "pending")));
    let migrated = 0;
    for (const d of snap.docs) {
      const eta = d.data().estimated_delivery_time;
      if (eta && eta.slice(0, 10) > today) {
        await updateDoc(doc(db, "deliveries", d.id), { status: "booked" });
        migrated++;
      }
    }
    if (migrated > 0) console.log(`[MIGRATION] Flipped ${migrated} pending → booked`);
  } catch (err) {
    console.error("[MIGRATION] error:", err.message);
  }
}

/* ════════════════════════════════════════════════
   RATE LIMITING
   - Global limiter: 200 req / 15 min per IP (generous for internal use)
   - Driver PIN limiter: 10 attempts / 15 min per IP (brute-force protection)
   - Admin login limiter: 10 attempts / 15 min per IP
════════════════════════════════════════════════ */

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false }, // Render proxy header — handled by trust proxy above
  message: { error: "Too many requests. Please wait a few minutes." }
});

const pinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  message: { error: "Too many PIN attempts. Please wait 15 minutes." }
});

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  message: { error: "Too many login attempts. Please wait 15 minutes." }
});

// Apply global limiter to all routes
app.use(globalLimiter);

/* ════════════════════════════════════════════════
   TRANSLITERATION — Google Input Tools
   POST /transliterate  { text }
   Proxies to Google's free Input Tools API (en→mr)
   No Python, no ML library — just a fetch call.
════════════════════════════════════════════════ */
app.post("/transliterate", async (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.json({ result: "" });

  try {
    const words = text.trim().split(/\s+/);
    const results = [];

    for (const word of words) {
      if (!word) continue;
      // Google Input Tools endpoint — same API used by Google Translate virtual keyboard
      const url = `https://inputtools.google.com/request?text=${encodeURIComponent(word)}&itc=mr-t-i0-und&num=1&cp=0&cs=1&ie=utf-8&oe=utf-8&app=test`;
      const r = await fetch(url, { headers: { "Accept": "application/json" } });
      const data = await r.json();
      // Response shape: ["SUCCESS", [["word", ["transliterated", ...], ...]]]
      const suggestion = data?.[1]?.[0]?.[1]?.[0];
      results.push(suggestion || word);
    }

    res.json({ result: results.join(" ") });
  } catch (err) {
    console.warn("[transliterate]", err.message);
    res.json({ result: text }); // graceful fallback — return original text
  }
});

/* ════════════════════════════════════════════════
   ASSIGN DELIVERY (Unassigned dispatcher)
   POST /assignDelivery/:id
   Body: { driver_id, driver_name }
   Updates assigned driver + sends push to new driver
════════════════════════════════════════════════ */
app.post("/assignDelivery/:id", async (req, res) => {
  try {
    const { driver_id, driver_name } = req.body;
    if (!driver_id || !driver_name) return res.status(400).json({ error: "driver_id and driver_name required" });

    const deliveryRef = doc(db, "deliveries", req.params.id);
    const snap = await getDoc(deliveryRef);
    if (!snap.exists()) return res.status(404).json({ error: "Delivery not found" });

    await updateDoc(deliveryRef, {
      assigned_driver_id:   driver_id,
      assigned_driver_name: driver_name
    });

    res.json({ success: true });

    // Push notification to newly assigned driver — in background
    (async () => {
      try {
        const driverSnap = await getDoc(doc(db, "drivers", driver_id));
        if (!driverSnap.exists()) return;
        const { pushToken } = driverSnap.data();
        if (!pushToken) return;
        const d = snap.data();
        await sendPushToToken(
          pushToken,
          "🚚 New Delivery Assigned",
          `${d.customer_name || ""} — ${d.address || ""}`,
          doc(db, "drivers", driver_id),
          "pushToken"
        );
      } catch (bgErr) {
        console.warn("[assignDelivery] push error:", bgErr.message);
      }
    })();
  } catch (err) {
    console.error("/assignDelivery error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ════════════════════════════════════════════════
   CORRECT DELIVERY (admin — edit SR + photos)
   POST /correctDelivery/:id  (multipart/form-data)
   Fields: serial_number?, loaded_photo?, delivered_photo?
   Replaces old photos in Firebase Storage, updates Firestore
════════════════════════════════════════════════ */
app.post("/correctDelivery/:id", authenticate, authorize(["admin"]), upload.fields([
  { name: "loaded_photo", maxCount: 1 },
  { name: "delivered_photo", maxCount: 1 }
]), async (req, res) => {
  try {
    const deliveryRef = doc(db, "deliveries", req.params.id);
    const snap = await getDoc(deliveryRef);
    if (!snap.exists()) return res.status(404).json({ error: "Delivery not found" });

    const current = snap.data();
    const updates = {};

    // SR number
    if (req.body.serial_number !== undefined) {
      updates.product_serial_number = req.body.serial_number.trim();
    }

    // Loaded photo replacement
    if (req.files?.loaded_photo?.[0]) {
      // Delete old photo from storage
      if (current.photo_loaded_url) {
        try {
          const oldPath = decodeURIComponent(
            current.photo_loaded_url.split("/o/")[1].split("?")[0].replace(/%2F/g, "/")
          );
          await adminBucket.file(oldPath).delete().catch(() => {});
        } catch (_) {}
      }
      const storageRef = ref(storage, "delivery_proofs_loaded/" + Date.now() + "_corrected");
      await uploadBytes(storageRef, req.files.loaded_photo[0].buffer, { contentType: req.files.loaded_photo[0].mimetype });
      updates.photo_loaded_url = await getDownloadURL(storageRef);
    }

    // Delivered photo replacement
    if (req.files?.delivered_photo?.[0]) {
      if (current.photo_delivered_url) {
        try {
          const oldPath = decodeURIComponent(
            current.photo_delivered_url.split("/o/")[1].split("?")[0].replace(/%2F/g, "/")
          );
          await adminBucket.file(oldPath).delete().catch(() => {});
        } catch (_) {}
      }
      const storageRef = ref(storage, "delivery_proofs_delivered/" + Date.now() + "_corrected");
      await uploadBytes(storageRef, req.files.delivered_photo[0].buffer, { contentType: req.files.delivered_photo[0].mimetype });
      updates.photo_delivered_url = await getDownloadURL(storageRef);
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "Nothing to update" });
    }

    await updateDoc(deliveryRef, updates);
    res.json({ success: true, updated: Object.keys(updates) });
  } catch (err) {
    console.error("/correctDelivery error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ════════════════════════════════════════════════
   AUTH MIDDLEWARE
════════════════════════════════════════════════ */

function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "No token provided" });
  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

function authorize(allowedRoles) {
  return (req, res, next) => {
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    next();
  };
}

/* ════════════════════════════════════════════════
   WHATSAPP — disabled (not in use)
════════════════════════════════════════════════ */

// async function sendWhatsapp(phone, message) {
//   try {
//     await fetch(`https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`, {
//       method: "POST",
//       headers: {
//         Authorization: `Bearer ${WHATSAPP_TOKEN}`,
//         "Content-Type": "application/json"
//       },
//       body: JSON.stringify({
//         messaging_product: "whatsapp",
//         to: phone,
//         type: "text",
//         text: { body: message }
//       })
//     });
//   } catch (err) {
//     console.log("WhatsApp error:", err.message);
//   }
// }
async function sendWhatsapp(phone, message) { /* disabled */ }

/* ════════════════════════════════════════════════
   SMS — disabled (not in use)
════════════════════════════════════════════════ */

// async function sendSMS(phone, message) {
//   try {
//     const r = await fetch("https://www.fast2sms.com/dev/bulkV2", {
//       method: "POST",
//       headers: {
//         authorization: FAST2SMS_API_KEY,
//         "Content-Type": "application/json"
//       },
//       body: JSON.stringify({ route: "q", message, language: "english", numbers: phone })
//     });
//     const data = await r.json();
//     console.log("SMS response:", data);
//   } catch (err) {
//     console.log("SMS error:", err.message);
//   }
// }
async function sendSMS(phone, message) { /* disabled */ }

/* ════════════════════════════════════════════════
   PUSH HELPER — with automatic stale token cleanup
════════════════════════════════════════════════ */

async function sendPushToToken(token, title, body, docRef = null, tokenField = null) {
  try {
    const response = await admin.messaging().send({
      token,
      data: { title: String(title), body: String(body) }
    });
    console.log("Push sent:", response);
    return true;
  } catch (err) {
    console.warn("Push failed:", err.message);

    // Auto-cleanup stale/invalid tokens from Firestore
    const isStale =
      err.code === "messaging/registration-token-not-registered" ||
      err.code === "messaging/invalid-registration-token" ||
      err.message?.includes("Requested entity was not found") ||
      err.message?.includes("registration-token-not-registered") ||
      err.message?.includes("InvalidRegistration") ||
      err.message?.includes("NotRegistered");

    if (isStale && docRef && tokenField) {
      try {
        await updateDoc(docRef, { [tokenField]: null });
        console.log(`Cleaned up stale push token from ${tokenField}`);
      } catch (cleanupErr) {
        console.warn("Token cleanup failed:", cleanupErr.message);
      }
    }
    return false;
  }
}

async function sendAccountantPush(title, body) {
  try {
    const settingsRef  = doc(db, "settings", "accountant");
    const settingsSnap = await getDoc(settingsRef);
    if (!settingsSnap.exists()) return;

    const { pushToken } = settingsSnap.data();
    if (!pushToken) return;

    await sendPushToToken(pushToken, title, body, settingsRef, "pushToken");
  } catch (err) {
    console.warn("sendAccountantPush error:", err.message);
  }
}

/* ════════════════════════════════════════════════
   ADMIN LOGIN
════════════════════════════════════════════════ */

app.post("/admin/login", adminLoginLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password required" });
  if (email !== process.env.ADMIN_EMAIL || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  const token = jwt.sign({ role: "admin" }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
  res.json({ success: true, token });
});

/* ════════════════════════════════════════════════
   ACCOUNTANT LOGIN
════════════════════════════════════════════════ */

app.post("/accountant/login", adminLoginLimiter, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: "Password required" });
  if (password !== process.env.ACCOUNTANT_PASSWORD) {
    return res.status(401).json({ error: "Invalid password" });
  }
  const token = jwt.sign({ role: "accountant" }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
  res.json({ success: true, token });
});

/* ════════════════════════════════════════════════
   TAGPRINT — TOKEN VERIFICATION
════════════════════════════════════════════════ */
app.post("/verify-token", (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ valid: false, error: "No token" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!["admin", "accountant"].includes(decoded.role)) {
      return res.json({ valid: false, error: "Insufficient role" });
    }
    res.json({ valid: true, role: decoded.role });
  } catch (err) {
    res.json({ valid: false, error: "Invalid or expired token" });
  }
});

/* ════════════════════════════════════════════════
   PRODUCTS / MAKES / MODELS
════════════════════════════════════════════════ */

app.get("/products", async (req, res) => {
  const snapshot = await getDocs(collection(db, "products"));
  res.json(snapshot.docs.map(d => ({ id: d.id, ...d.data() })));
});

app.post("/products", async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "Name required" });
  const snapshot = await getDocs(query(collection(db, "products"), where("name", "==", name)));
  if (!snapshot.empty) return res.json({ exists: true });
  await addDoc(collection(db, "products"), { name });
  res.json({ success: true });
});

app.get("/makes", async (req, res) => {
  const snapshot = await getDocs(collection(db, "makes"));
  res.json(snapshot.docs.map(d => ({ id: d.id, ...d.data() })));
});

app.post("/makes", async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "Name required" });
  const snapshot = await getDocs(query(collection(db, "makes"), where("name", "==", name)));
  if (!snapshot.empty) return res.json({ exists: true });
  await addDoc(collection(db, "makes"), { name });
  res.json({ success: true });
});

app.get("/models", async (req, res) => {
  const snapshot = await getDocs(collection(db, "models"));
  res.json(snapshot.docs.map(d => ({ id: d.id, ...d.data() })));
});

app.post("/models", async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "Name required" });
  const snapshot = await getDocs(query(collection(db, "models"), where("name", "==", name)));
  if (!snapshot.empty) return res.json({ exists: true });
  await addDoc(collection(db, "models"), { name });
  res.json({ success: true });
});

/* ════════════════════════════════════════════════
   CREATE DELIVERY — with duplicate prevention
   Blocks identical customer+phone+product within 60 seconds
════════════════════════════════════════════════ */

app.post("/createDelivery", async (req, res) => {
  try {
    const data = req.body;

    if (!data.estimated_delivery_time) return res.status(400).json({ error: "ETA is required" });
    if (new Date(data.estimated_delivery_time) < new Date()) {
      return res.status(400).json({ error: "ETA cannot be in the past" });
    }

    // Duplicate check — same customer + phone + product in last 60 seconds
    if (data.customer_name && data.phone && data.product_name) {
      const since = Timestamp.fromMillis(Date.now() - 60_000);
      const dupeSnap = await getDocs(query(
        collection(db, "deliveries"),
        where("phone", "==", data.phone),
        where("product_name", "==", data.product_name),
        where("status", "in", ["pending", "booked"])
      ));
      const isDuplicate = dupeSnap.docs.some(d => {
        const ts = d.data().created_timestamp;
        return ts && ts.seconds >= since.seconds;
      });
      if (isDuplicate) {
        return res.status(409).json({ error: "Duplicate delivery detected. This customer + product was just created. Please wait a moment." });
      }
    }

    const docRef = await addDoc(collection(db, "deliveries"), {
      ...data,
      priority: data.priority || "normal",
      estimated_delivery_time: data.estimated_delivery_time || null,
      created_timestamp: Timestamp.now(),
      status: statusForETA(data.estimated_delivery_time)
    });

    await sendWhatsapp(data.phone,
      `Hello ${data.customer_name}, your delivery is scheduled at ${data.estimated_delivery_time}`
    );
    await sendSMS(data.phone,
      `Hariom Delivery: Your delivery scheduled at ${data.estimated_delivery_time}`
    );

    // Push to assigned driver
    if (data.assigned_driver_id) {
      const driverSnap = await getDoc(doc(db, "drivers", data.assigned_driver_id));
      if (driverSnap.exists()) {
        const { pushToken } = driverSnap.data();
        if (pushToken) {
          await sendPushToToken(
            pushToken,
            "🚚 New Delivery Assigned",
            `${data.customer_name || ""} - ${data.address || ""}`,
            doc(db, "drivers", data.assigned_driver_id),
            "pushToken"
          );
        }
      }
    }

    res.json({ success: true, id: docRef.id });
  } catch (error) {
    console.error("/createDelivery error:", error);
    res.status(500).json({ error: error.message });
  }
});

/* ════════════════════════════════════════════════
   CREATE MULTIPLE DELIVERIES (batch from one form)
════════════════════════════════════════════════ */
app.post("/createDeliveries", async (req, res) => {
  try {
    const { shared, products, requestId } = req.body;

    if (!shared || !products || !Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ error: "shared payload and products array required" });
    }
    if (!shared.estimated_delivery_time) {
      return res.status(400).json({ error: "ETA is required" });
    }
    if (new Date(shared.estimated_delivery_time) < new Date()) {
      return res.status(400).json({ error: "ETA cannot be in the past" });
    }

    // ── Idempotency check ──────────────────────────────────────────────────
    // If client sends a requestId (UUID generated before first submit),
    // check if we already created deliveries for this exact request.
    // Handles the case where: server wrote to Firestore, then timed out
    // waiting for WhatsApp/SMS — client saw "network error" and retried.
    if (requestId) {
      const existingSnap = await getDocs(query(
        collection(db, "deliveries"),
        where("request_id", "==", requestId)
      ));
      if (!existingSnap.empty) {
        const existingIds = existingSnap.docs.map(d => d.id);
        console.log(`[createDeliveries] Duplicate requestId ${requestId} — returning existing ${existingIds.length} docs`);
        return res.json({ success: true, created: existingIds.length, ids: existingIds, duplicate: true });
      }
    }
    // ──────────────────────────────────────────────────────────────────────

    // Generate one batch_id shared across all deliveries in this group
    const batchId = `batch_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;

    const createdIds = [];

    for (const item of products) {
      const docData = {
        ...shared,
        product_name:          item.product_name          || "",
        product_serial_number: item.product_serial_number || "",
        invoice_number:        item.invoice_number        || "",
        batch_id:              products.length > 1 ? batchId : null,
        priority:              shared.priority || "normal",
        created_timestamp:     Timestamp.now(),
        status:                statusForETA(shared.estimated_delivery_time),
        // Store requestId so retry attempts can detect this was already created
        ...(requestId ? { request_id: requestId } : {})
      };

      const docRef = await addDoc(collection(db, "deliveries"), docData);
      createdIds.push(docRef.id);
    }

    // ✅ Respond immediately — notifications run in background (non-blocking)
    // This is the key fix: previously we awaited WhatsApp/SMS before responding,
    // causing timeouts on slow APIs which made the client think it failed.
    res.json({ success: true, created: createdIds.length, ids: createdIds, batch_id: batchId });

    // Background notifications — failures here don't affect the client
    (async () => {
      try {
        await sendWhatsapp(shared.phone,
          `Hello ${shared.customer_name}, your ${products.length > 1 ? products.length + " deliveries are" : "delivery is"} scheduled at ${shared.estimated_delivery_time}`
        );
        await sendSMS(shared.phone,
          `Hariom Delivery: Your ${products.length > 1 ? products.length + " items are" : "delivery is"} scheduled at ${shared.estimated_delivery_time}`
        );

        if (shared.assigned_driver_id) {
          const driverSnap = await getDoc(doc(db, "drivers", shared.assigned_driver_id));
          if (driverSnap.exists()) {
            const { pushToken } = driverSnap.data();
            if (pushToken) {
              const summary = products.length > 1
                ? `${shared.customer_name} — ${products.length} items`
                : `${shared.customer_name} - ${products[0].product_name}`;
              await sendPushToToken(
                pushToken,
                products.length > 1 ? `🚚 ${products.length} New Deliveries Assigned` : "🚚 New Delivery Assigned",
                summary,
                doc(db, "drivers", shared.assigned_driver_id),
                "pushToken"
              );
            }
          }
        }
      } catch (bgErr) {
        console.warn("[createDeliveries] Background notification error:", bgErr.message);
      }
    })();

  } catch (error) {
    console.error("/createDeliveries error:", error);
    res.status(500).json({ error: error.message });
  }
});

/* ════════════════════════════════════════════════
   GET DELIVERIES
════════════════════════════════════════════════ */

app.get("/deliveries", async (req, res) => {
  try {
    const snapshot = await getDocs(collection(db, "deliveries"));
    let deliveries = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));

    const statusOrder = { pending: 0, loaded: 1, delivered: 2 };

    deliveries.sort((a, b) => {
      // Primary: status group order
      const statusDiff = (statusOrder[a.status] ?? 0) - (statusOrder[b.status] ?? 0);
      if (statusDiff !== 0) return statusDiff;

      // Within pending: urgent first, then newest created first
      if (a.status === "pending") {
        const urgentDiff = (b.priority === "urgent") - (a.priority === "urgent");
        if (urgentDiff !== 0) return urgentDiff;
        const aTs = a.created_timestamp?.seconds ?? 0;
        const bTs = b.created_timestamp?.seconds ?? 0;
        return bTs - aTs;
      }

      // Within loaded: newest loaded_timestamp first
      if (a.status === "loaded") {
        const aTs = a.loaded_timestamp?.seconds ?? 0;
        const bTs = b.loaded_timestamp?.seconds ?? 0;
        return bTs - aTs;
      }

      // Within delivered: newest delivered_timestamp first
      if (a.status === "delivered") {
        const aTs = a.delivered_timestamp?.seconds ?? 0;
        const bTs = b.delivered_timestamp?.seconds ?? 0;
        return bTs - aTs;
      }

      return 0;
    });

    res.json(deliveries);
  } catch (error) {
    console.error("/deliveries error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/delivery/:id", async (req, res) => {
  try {
    const snap = await getDoc(doc(db, "deliveries", req.params.id));
    if (!snap.exists()) return res.status(404).json({ error: "Delivery not found" });
    res.json({ id: snap.id, ...snap.data() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put("/delivery/:id", async (req, res) => {
  const refDoc = doc(db, "deliveries", req.params.id);
  const snap = await getDoc(refDoc);
  if (!snap.exists()) return res.status(404).json({ error: "Not found" });
  const delivery = snap.data();
  if (delivery.status !== "pending" && delivery.status !== "booked") {
    return res.status(400).json({ error: "Only pending or booked deliveries can be edited" });
  }
  if (req.body.estimated_delivery_time) {
    if (new Date(req.body.estimated_delivery_time) < new Date()) {
      return res.status(400).json({ error: "ETA cannot be in the past" });
    }
    // Re-evaluate booked/pending status based on new ETA
    req.body.status = statusForETA(req.body.estimated_delivery_time);
  }
  await updateDoc(refDoc, req.body);
  res.json({ success: true });
});

app.delete("/delivery/:id", authenticate, authorize(["admin"]), async (req, res) => {
  await deleteDoc(doc(db, "deliveries", req.params.id));
  res.json({ success: true });
});

/* ════════════════════════════════════════════════
   DELETE FAILED DELIVERY (accountant)
   Only allows deletion of failed-status deliveries.
   Requires a deletion reason for audit trail.
════════════════════════════════════════════════ */
app.post("/deleteFailedDelivery/:id", authenticate, authorize(["accountant", "admin"]), async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason || !reason.trim()) {
      return res.status(400).json({ error: "Deletion reason is required" });
    }

    const refDoc = doc(db, "deliveries", req.params.id);
    const snap   = await getDoc(refDoc);
    if (!snap.exists()) return res.status(404).json({ error: "Delivery not found" });

    const delivery = snap.data();
    if (delivery.status !== "failed") {
      return res.status(400).json({ error: "Only failed deliveries can be deleted by accountant" });
    }

    // Soft audit: log the deletion before deleting
    console.log(`[DELETE] Failed delivery ${req.params.id} deleted by accountant. Reason: ${reason.trim()}. Customer: ${delivery.customer_name}, Product: ${delivery.product_name}`);

    await deleteDoc(refDoc);
    res.json({ success: true });
  } catch (error) {
    console.error("/deleteFailedDelivery error:", error);
    res.status(500).json({ error: error.message });
  }
});

/* ════════════════════════════════════════════════
   MARK LOADED
════════════════════════════════════════════════ */

app.post("/markLoaded/:id", upload.single("photo"), async (req, res) => {
  try {
    const refDoc = doc(db, "deliveries", req.params.id);
    const snap   = await getDoc(refDoc);
    if (!snap.exists()) return res.status(404).json({ error: "Not found" });

    const delivery = snap.data();
    if (delivery.status !== "pending") return res.status(400).json({ error: "Invalid status" });

    let finalSerial = delivery.product_serial_number;
    if (!finalSerial) {
      if (!req.body.serial) return res.status(400).json({ error: "Serial required" });
      finalSerial = req.body.serial;
    }

    if (!req.file?.buffer) return res.status(400).json({ error: "Photo required" });

    const storageRef = ref(storage, "delivery_proofs_loaded/" + Date.now());
    await uploadBytes(storageRef, req.file.buffer);
    const url = await getDownloadURL(storageRef);

    await updateDoc(refDoc, {
      status: "loaded",
      product_serial_number: finalSerial,
      loaded_timestamp: Timestamp.now(),
      loaded_location: { lat: req.body.lat, lng: req.body.lng },
      photo_loaded_url: url
      // Freight is captured at delivery time (markDelivered), not here
    });

    // ✅ Respond immediately — push runs in background
    res.json({ success: true });

    sendAccountantPush("📦 Delivery Loaded", `${delivery.customer_name} - ${delivery.address}`)
      .catch(e => console.warn("Push error:", e.message));
  } catch (error) {
    console.error("/markLoaded error:", error);
    res.status(500).json({ error: error.message });
  }
});

/* ════════════════════════════════════════════════
   MARK DELIVERED
════════════════════════════════════════════════ */

app.post("/markDelivered/:id", upload.single("photo"), async (req, res) => {
  try {
    if (!req.file?.buffer) return res.status(400).json({ error: "Photo required" });

    const refDoc = doc(db, "deliveries", req.params.id);

    // Idempotency guard — prevent double-delivery
    const snapBefore = await getDoc(refDoc);
    if (!snapBefore.exists()) return res.status(404).json({ error: "Not found" });
    if (snapBefore.data().status === "delivered") {
      return res.status(409).json({ error: "Delivery already marked as delivered" });
    }

    const deliveryData = snapBefore.data();
    const delivLat = req.body.lat;
    const delivLng = req.body.lng;

    // Upload photo
    const storageRef = ref(storage, "delivery_proofs_delivered/" + Date.now());
    await uploadBytes(storageRef, req.file.buffer);
    const url = await getDownloadURL(storageRef);

    // ── Batch freight check ──────────────────────────────────────────────
    // If this delivery is part of a batch, check if a sibling already has
    // driver freight saved — if so, this item is a secondary (no freight saved)
    let batchFreightAlreadySet = false;
    if (deliveryData.batch_id) {
      const batchSnap = await getDocs(query(
        collection(db, "deliveries"),
        where("batch_id", "==", deliveryData.batch_id),
        where("freight_set_by", "==", "driver")
      ));
      batchFreightAlreadySet = !batchSnap.empty;
    }

    // Determine freight fields to save
    // Freight is always set at delivery time — ₹0 is valid (driver pays nothing but still logged)
    const freightFields = (() => {
      // Accountant already set freight at creation — don't touch it
      if (deliveryData.freight_charged) return {};
      // Batch secondary — freight already entered on primary item
      if (batchFreightAlreadySet) return { batch_freight_secondary: true };
      // Parse driver-entered amount (mandatory — ₹0 is valid)
      const freightNum = parseFloat(req.body.driver_freight_amount ?? 0);
      const amount = isNaN(freightNum) ? 0 : Math.max(0, freightNum);
      return {
        freight_charged: true,
        freight_amount: amount,
        freight_set_by: "driver",
        ...(deliveryData.batch_id ? { batch_freight_primary: true } : {})
      };
    })();

    // Write delivered status + freight
    await updateDoc(refDoc, {
      status: "delivered",
      delivered_timestamp: Timestamp.now(),
      delivered_location: { lat: delivLat, lng: delivLng },
      photo_delivered_url: url,
      ...freightFields
    });

    // ✅ Respond to driver immediately
    res.json({ success: true });

    // Run distance calculation + notifications in background (non-blocking)
    (async () => {
      try {
        let distance_km = null;
        const loadedLoc = deliveryData.loaded_location;
        if (loadedLoc?.lat && loadedLoc?.lng && delivLat && delivLng) {
          try {
            // OSRM — free, no API key needed
            const osrmUrl = `https://router.project-osrm.org/route/v1/driving/` +
              `${loadedLoc.lng},${loadedLoc.lat};${delivLng},${delivLat}` +
              `?overview=false`;
            const osrmRes  = await fetch(osrmUrl);
            const osrmData = await osrmRes.json();
            if (osrmData.code === "Ok" && osrmData.routes?.[0]) {
              distance_km = parseFloat((osrmData.routes[0].distance / 1000).toFixed(2));
              await updateDoc(refDoc, { distance_km });
            }
          } catch (osrmErr) {
            console.error("OSRM distance error:", osrmErr.message);
          }
        }

        const snap = await getDoc(refDoc);
        const d    = snap.data();
        await sendAccountantPush("✅ Delivery Delivered", `${d.customer_name} - ${d.address}`);
        await sendWhatsapp(d.phone, `Hello ${d.customer_name}, your order has been DELIVERED successfully.`);
        await sendSMS(d.phone, "Hariom Delivery: Your order has been delivered successfully.");
      } catch (bgErr) {
        console.error("Background post-delivery tasks error:", bgErr.message);
      }
    })();

  } catch (error) {
    console.error("/markDelivered error:", error);
    res.status(500).json({ error: error.message });
  }
});

/* ════════════════════════════════════════════════
   DRIVERS
════════════════════════════════════════════════ */

app.post("/addDriver", authenticate, authorize(["admin"]), async (req, res) => {
  const { driver_name, phone, vehicle_number, vehicle_make, vehicle_model, pin } = req.body;
  if (!driver_name) return res.status(400).json({ error: "Driver name required" });
  if (!pin || !/^\d{6}$/.test(pin)) return res.status(400).json({ error: "PIN must be exactly 6 digits" });

  const pinHash = await bcrypt.hash(pin, 10);
  const docRef  = await addDoc(collection(db, "drivers"), {
    driver_name,
    phone: phone || "",
    vehicle_number: vehicle_number || "",
    vehicle_make: vehicle_make || "",
    vehicle_model: vehicle_model || "",
    pinHash,
    created_timestamp: Timestamp.now()
  });
  res.json({ success: true, id: docRef.id });
});

app.get("/drivers", authenticate, authorize(["admin"]), async (req, res) => {
  const snapshot = await getDocs(collection(db, "drivers"));
  res.json(snapshot.docs.map(d => ({ id: d.id, ...d.data() })));
});

app.put("/driver/:id", authenticate, authorize(["admin"]), async (req, res) => {
  const { pin, ...otherFields } = req.body;
  const refDoc = doc(db, "drivers", req.params.id);
  if (pin) {
    if (!/^\d{6}$/.test(pin)) return res.status(400).json({ error: "PIN must be exactly 6 digits" });
    const pinHash = await bcrypt.hash(pin, 10);
    await updateDoc(refDoc, { ...otherFields, pinHash });
  } else {
    await updateDoc(refDoc, otherFields);
  }
  res.json({ success: true });
});

app.delete("/driver/:id", authenticate, authorize(["admin"]), async (req, res) => {
  try {
    const driverId = req.params.id;
    const snapshot = await getDocs(query(
      collection(db, "deliveries"),
      where("assigned_driver_id", "==", driverId)
    ));
    const hasActive = snapshot.docs.some(d => d.data().status !== "delivered");
    if (hasActive) return res.json({ error: "Driver has active deliveries. Cannot delete." });
    await deleteDoc(doc(db, "drivers", driverId));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/driver-list-public", async (req, res) => {
  const snapshot = await getDocs(collection(db, "drivers"));
  res.json(snapshot.docs.map(d => ({ id: d.id, driver_name: d.data().driver_name })));
});

/* ════════════════════════════════════════════════
   DRIVER DELIVERIES — server-side PIN lockout
   Tracks failed attempts in Firestore.
   After 7 fails: 15-minute lockout enforced server-side.
════════════════════════════════════════════════ */

app.post("/driverDeliveries", pinLimiter, async (req, res) => {
  const { driver_id, pin } = req.body;
  if (!driver_id || !pin) return res.status(400).json({ error: "Driver ID and PIN required" });

  const driverRef  = doc(db, "drivers", driver_id);
  const snap       = await getDoc(driverRef);
  if (!snap.exists()) return res.status(404).json({ error: "Driver not found" });

  const driverData = snap.data();

  // Server-side lockout check
  const failedAttempts  = driverData.failedPinAttempts || 0;
  const lockedUntil     = driverData.pinLockedUntil || null;

  if (lockedUntil) {
    const lockedUntilDate = new Date(lockedUntil);
    if (new Date() < lockedUntilDate) {
      const minutesLeft = Math.ceil((lockedUntilDate - new Date()) / 60000);
      return res.status(429).json({
        error: `Account locked. Try again in ${minutesLeft} minute${minutesLeft > 1 ? "s" : ""}.`
      });
    } else {
      // Lock expired — reset
      await updateDoc(driverRef, { failedPinAttempts: 0, pinLockedUntil: null });
    }
  }

  const match = await bcrypt.compare(pin, driverData.pinHash);
  if (!match) {
    const newAttempts = failedAttempts + 1;
    const updates     = { failedPinAttempts: newAttempts };

    if (newAttempts >= 7) {
      // Lock for 15 minutes
      updates.pinLockedUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      await updateDoc(driverRef, updates);
      return res.status(429).json({ error: "Too many incorrect attempts. Account locked for 15 minutes." });
    }

    await updateDoc(driverRef, updates);
    return res.status(401).json({ error: `Invalid PIN (${newAttempts}/7)` });
  }

  // Successful login — reset failure counters
  await updateDoc(driverRef, { failedPinAttempts: 0, pinLockedUntil: null });

  // Issue a short-lived session token so background refreshes don't need PIN
  const sessionToken = jwt.sign(
    { role: "driver", driver_id },
    JWT_SECRET,
    { expiresIn: "12h" }
  );

  const snapshot = await getDocs(query(
    collection(db, "deliveries"),
    where("assigned_driver_id", "==", driver_id)
  ));

  res.json({ deliveries: snapshot.docs.map(d => ({ id: d.id, ...d.data() })).filter(d => d.status !== "booked"), sessionToken });
});

/* ════════════════════════════════════════════════
   DRIVER DELIVERIES REFRESH — uses JWT session token
   Called by auto-refresh / history — does NOT count
   toward PIN lockout. PIN only needed on first login.
════════════════════════════════════════════════ */

app.post("/driverDeliveriesRefresh", authenticate, authorize(["driver"]), async (req, res) => {
  try {
    const { driver_id } = req.body;
    if (!driver_id || driver_id !== req.user.driver_id) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const snapshot = await getDocs(query(
      collection(db, "deliveries"),
      where("assigned_driver_id", "==", driver_id)
    ));
    res.json(snapshot.docs.map(d => ({ id: d.id, ...d.data() })).filter(d => d.status !== "booked"));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/driver/verify-pin", pinLimiter, async (req, res) => {
  try {
    const { driver_id, pin } = req.body;
    if (!driver_id || !pin) return res.status(400).json({ error: "Driver ID and PIN required" });
    const snap = await getDoc(doc(db, "drivers", driver_id));
    if (!snap.exists()) return res.status(404).json({ error: "Driver not found" });
    const match = await bcrypt.compare(pin, snap.data().pinHash);
    if (!match) return res.status(401).json({ error: "Invalid PIN" });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* ════════════════════════════════════════════════
   PUSH TOKENS
════════════════════════════════════════════════ */

app.post("/saveAccountantPushToken", async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "Token required" });
    await setDoc(doc(db, "settings", "accountant"), { pushToken: token }, { merge: true });
    console.log("Accountant push token stored");
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/saveDriverPushToken", async (req, res) => {
  try {
    const { driver_id, token } = req.body;
    if (!driver_id || !token) return res.status(400).json({ error: "Missing data" });
    await updateDoc(doc(db, "drivers", driver_id), { pushToken: token });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* ════════════════════════════════════════════════
   DRIVER PAYOUT
   GET /driver-payout?driver_id=X&date=YYYY-MM-DD
   Returns all delivered deliveries for that driver
   on that date, with freight totals + distance totals
════════════════════════════════════════════════ */

app.get("/driver-payout", authenticate, authorize(["admin"]), async (req, res) => {
  try {
    const { driver_id, date } = req.query;
    if (!driver_id || !date) return res.status(400).json({ error: "driver_id and date required" });

    // Build IST day boundaries (India = UTC+5:30)
    const dayStart = new Date(date + "T00:00:00.000+05:30");
    const dayEnd   = new Date(date + "T23:59:59.999+05:30");

    const snapshot = await getDocs(query(
      collection(db, "deliveries"),
      where("assigned_driver_id", "==", driver_id),
      where("status", "==", "delivered")
    ));

    const deliveries = snapshot.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(d => {
        if (!d.delivered_timestamp) return false;
        const ts = new Date(d.delivered_timestamp.seconds * 1000);
        return ts >= dayStart && ts <= dayEnd;
      });

    // Only count freight the DRIVER set at load time — meaning WE bear the cost
    // Freight set by accountant during delivery creation = customer pays = excluded
    const total_our_freight = deliveries.reduce((sum, d) => {
      if (d.freight_set_by === "driver" && d.freight_charged) {
        return sum + parseFloat(d.freight_amount || 0);
      }
      return sum;
    }, 0);

    const total_distance_km = deliveries.reduce((sum, d) => {
      return sum + (d.distance_km || 0);
    }, 0);

    res.json({
      deliveries,
      total_our_freight:  parseFloat(total_our_freight.toFixed(2)),
      total_distance_km:  parseFloat(total_distance_km.toFixed(2)),
      count: deliveries.length
    });
  } catch (error) {
    console.error("/driver-payout error:", error);
    res.status(500).json({ error: error.message });
  }
});

/* ════════════════════════════════════════════════
   MARK FAILED
   POST /markFailed/:id  (multipart/form-data)
   Fields: reason, photo (required for damage only)
════════════════════════════════════════════════ */

app.post("/markFailed/:id", upload.single("photo"), async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const VALID_REASONS = [
      "Customer Not Available",
      "Customer Not Responding",
      "Customer Asked to Reschedule",
      "Customer Cancelled / Not Accepting Product",
      "Product Damaged / Not Working"
    ];
    if (!reason || !VALID_REASONS.includes(reason)) {
      return res.status(400).json({ error: "Invalid or missing failure reason" });
    }
    const deliveryRef = doc(db, "deliveries", id);
    const snap = await getDoc(deliveryRef);
    if (!snap.exists()) return res.status(404).json({ error: "Delivery not found" });
    const delivery = snap.data();
    if (delivery.status !== "loaded") {
      return res.status(400).json({ error: "Only loaded deliveries can be marked as failed" });
    }
    const isDamage = reason === "Product Damaged / Not Working";
    if (isDamage && !req.file) {
      return res.status(400).json({ error: "Photo is required for damaged product" });
    }
    let failure_photo_url = null;
    if (req.file) {
      const storageRef = ref(storage, "delivery_failures/" + Date.now() + "_" + id);
      await uploadBytes(storageRef, req.file.buffer, { contentType: req.file.mimetype });
      failure_photo_url = await getDownloadURL(storageRef);
    }
    await updateDoc(deliveryRef, {
      status: "failed",
      failure_reason: reason,
      failed_timestamp: Timestamp.now(),
      product_returned: false,
      ...(failure_photo_url && { failure_photo_url })
    });
    // Respond immediately, push in background
    res.json({ success: true });
    const urgentPrefix = isDamage ? "🔴 URGENT — " : "";
    sendAccountantPush(
      urgentPrefix + "Delivery Failed",
      `${delivery.customer_name || "Customer"}: ${reason}`
    ).catch(e => console.warn("Push error:", e.message));
  } catch (error) {
    console.error("/markFailed error:", error);
    res.status(500).json({ error: error.message });
  }
});

/* ════════════════════════════════════════════════
   MARK RETURNED
   POST /markReturned/:id
════════════════════════════════════════════════ */

app.post("/markReturned/:id", authenticate, authorize(["admin", "accountant"]), async (req, res) => {
  try {
    const deliveryRef = doc(db, "deliveries", req.params.id);
    const snap = await getDoc(deliveryRef);
    if (!snap.exists()) return res.status(404).json({ error: "Delivery not found" });
    if (snap.data().status !== "failed") {
      return res.status(400).json({ error: "Only failed deliveries can be marked as returned" });
    }
    await updateDoc(deliveryRef, { product_returned: true, returned_timestamp: Timestamp.now() });
    res.json({ success: true });
  } catch (error) {
    console.error("/markReturned error:", error);
    res.status(500).json({ error: error.message });
  }
});

/* ════════════════════════════════════════════════
   RESCHEDULE DELIVERY — back to pending
   POST /rescheduleDelivery/:id
   Body: estimated_delivery_time, assigned_driver_id?, assigned_driver_name?
   Requires: status === "failed" AND product_returned === true
════════════════════════════════════════════════ */

app.post("/rescheduleDelivery/:id", authenticate, authorize(["admin", "accountant"]), async (req, res) => {
  try {
    const { estimated_delivery_time, assigned_driver_id, assigned_driver_name } = req.body;
    if (!estimated_delivery_time) {
      return res.status(400).json({ error: "New estimated delivery time is required" });
    }
    const newETA = new Date(estimated_delivery_time);
    if (isNaN(newETA.getTime()) || newETA < new Date()) {
      return res.status(400).json({ error: "ETA must be a valid future date/time" });
    }
    const deliveryRef = doc(db, "deliveries", req.params.id);
    const snap = await getDoc(deliveryRef);
    if (!snap.exists()) return res.status(404).json({ error: "Delivery not found" });
    const delivery = snap.data();
    if (delivery.status !== "failed") return res.status(400).json({ error: "Only failed deliveries can be rescheduled" });
    if (!delivery.product_returned) return res.status(400).json({ error: "Product must be marked as returned before rescheduling" });

    await updateDoc(deliveryRef, {
      status: statusForETA(estimated_delivery_time),
      estimated_delivery_time,
      previous_failures: (delivery.previous_failures || 0) + 1,
      previous_failure_reason: delivery.failure_reason || null,
      failure_reason: null,
      failed_timestamp: null,
      product_returned: null,
      returned_timestamp: null,
      failure_photo_url: null,
      rescheduled_timestamp: Timestamp.now(),
      ...(assigned_driver_id && { assigned_driver_id }),
      ...(assigned_driver_name && { assigned_driver_name })
    });

    res.json({ success: true });

    // Notify new driver in background
    const driverIdToNotify = assigned_driver_id || delivery.assigned_driver_id;
    if (driverIdToNotify) {
      getDoc(doc(db, "drivers", driverIdToNotify)).then(driverSnap => {
        if (!driverSnap.exists()) return;
        const { pushToken } = driverSnap.data();
        if (pushToken) {
          const note = (delivery.previous_failures || 0) > 0 ? ` (prev. attempt: ${delivery.failure_reason})` : "";
          sendPushToToken(pushToken, "Delivery Rescheduled",
            `${delivery.customer_name || "Customer"}${note}`,
            doc(db, "drivers", driverIdToNotify), "pushToken"
          ).catch(e => console.warn("Push error:", e.message));
        }
      }).catch(() => {});
    }
  } catch (error) {
    console.error("/rescheduleDelivery error:", error);
    res.status(500).json({ error: error.message });
  }
});

/* ════════════════════════════════════════════════
   REVERSE DELIVERY — delivered → failed
   POST /reverseDelivery/:id
   Body: { reason }
   Moves a delivered delivery back to failed so the
   normal returned → reschedule flow can handle it.
   Sets reversed_from_delivered: true for audit trail.
════════════════════════════════════════════════ */
app.post("/reverseDelivery/:id", authenticate, authorize(["admin", "accountant"]), async (req, res) => {
  try {
    const { reason } = req.body;
    const VALID_REASONS = [
      "Customer Rejected — Wrong Color",
      "Customer Rejected — Wrong Model / Variant",
      "Customer Changed Mind",
      "Customer Not Satisfied with Product",
      "Delivered to Wrong Address",
      "Other"
    ];
    if (!reason || !VALID_REASONS.includes(reason)) {
      return res.status(400).json({ error: "Valid reason is required" });
    }

    const deliveryRef = doc(db, "deliveries", req.params.id);
    const snap = await getDoc(deliveryRef);
    if (!snap.exists()) return res.status(404).json({ error: "Delivery not found" });

    const delivery = snap.data();
    if (delivery.status !== "delivered") {
      return res.status(400).json({ error: "Only delivered deliveries can be reversed" });
    }

    await updateDoc(deliveryRef, {
      status:                   "failed",
      failure_reason:           reason,
      failed_timestamp:         Timestamp.now(),
      product_returned:         false,
      reversed_from_delivered:  true,
      // Preserve original delivery timestamps for audit
      original_delivered_timestamp: delivery.delivered_timestamp || null
    });

    console.log(`[reverseDelivery] ${req.params.id} reversed. Reason: ${reason}. Customer: ${delivery.customer_name}`);
    res.json({ success: true });

    // Notify driver that delivery was reversed
    if (delivery.assigned_driver_id) {
      getDoc(doc(db, "drivers", delivery.assigned_driver_id)).then(driverSnap => {
        if (!driverSnap.exists()) return;
        const { pushToken } = driverSnap.data();
        if (pushToken) {
          sendPushToToken(
            pushToken,
            "↩ Delivery Reversed",
            `${delivery.customer_name || "Customer"} — please collect the product back`,
            doc(db, "drivers", delivery.assigned_driver_id),
            "pushToken"
          ).catch(() => {});
        }
      }).catch(() => {});
    }
  } catch (err) {
    console.error("/reverseDelivery error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ════════════════════════════════════════════════
   MARK FREIGHT PAID
   POST /markFreightPaid/:id  (admin only)
   Sets freight_paid: true + timestamp on delivery
════════════════════════════════════════════════ */
app.post("/markFreightPaid/:id", authenticate, authorize(["admin"]), async (req, res) => {
  try {
    const deliveryRef = doc(db, "deliveries", req.params.id);
    const snap = await getDoc(deliveryRef);
    if (!snap.exists()) return res.status(404).json({ error: "Delivery not found" });
    if (snap.data().freight_paid) return res.status(400).json({ error: "Already marked as paid" });

    const delivery = snap.data();
    const paidTimestamp = Timestamp.now();

    // Mark this delivery paid
    await updateDoc(deliveryRef, { freight_paid: true, freight_paid_timestamp: paidTimestamp });

    // If part of a batch — mark all siblings paid together in one go
    if (delivery.batch_id) {
      const batchSnap = await getDocs(query(
        collection(db, "deliveries"),
        where("batch_id", "==", delivery.batch_id)
      ));
      const siblings = batchSnap.docs.filter(d => d.id !== snap.id);
      await Promise.all(siblings.map(d =>
        updateDoc(doc(db, "deliveries", d.id), { freight_paid: true, freight_paid_timestamp: paidTimestamp })
      ));
      console.log(`[markFreightPaid] Batch ${delivery.batch_id} — marked ${siblings.length + 1} deliveries paid`);
    }

    res.json({ success: true });
  } catch (err) {
    console.error("/markFreightPaid error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ════════════════════════════════════════════════
   DRIVER OUTSTANDING BALANCE
   GET /driver-outstanding?driver_id=X&from=YYYY-MM-DD&to=YYYY-MM-DD
   Returns all unpaid delivered deliveries in range,
   grouped by date, with per-day and grand totals
════════════════════════════════════════════════ */
app.get("/driver-outstanding", authenticate, authorize(["admin"]), async (req, res) => {
  try {
    const { driver_id, from, to } = req.query;
    if (!driver_id) return res.status(400).json({ error: "driver_id required" });

    const fromDate = from || todayIST();
    const toDate   = to   || todayIST();

    const dayStart = new Date(fromDate + "T00:00:00.000+05:30");
    const dayEnd   = new Date(toDate   + "T23:59:59.999+05:30");

    const snap = await getDocs(query(
      collection(db, "deliveries"),
      where("assigned_driver_id", "==", driver_id),
      where("status", "==", "delivered")
    ));

    const allDelivered = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // ── Batch deduplication ───────────────────────────────────────────────
    // For batched deliveries, only the primary item (batch_freight_primary: true
    // OR the one with freight_charged: true) counts for payout.
    // Siblings are grouped under it in the UI — one row, one amount, one Mark Paid.
    const seenBatchIds = new Set();

    const unpaid = allDelivered.filter(d => {
      if (d.freight_paid) return false;
      if (!d.delivered_timestamp) return false;
      const ts = new Date(d.delivered_timestamp.seconds * 1000);
      if (ts < dayStart || ts > dayEnd) return false;

      // Batch secondary — skip (already counted under primary)
      if (d.batch_freight_secondary) return false;

      // Must be driver-set freight with an amount
      if (d.freight_set_by !== "driver" || !d.freight_charged) return false;

      // Batch primary — only count once
      if (d.batch_id) {
        if (seenBatchIds.has(d.batch_id)) return false;
        seenBatchIds.add(d.batch_id);
      }

      return true;
    }).map(d => {
      // Annotate batch primaries with sibling customer names for display
      if (d.batch_id) {
        const siblings = allDelivered.filter(x => x.batch_id === d.batch_id && x.id !== d.id);
        return { ...d, _batch_siblings: siblings, _batch_size: siblings.length + 1 };
      }
      return d;
    });
    // ─────────────────────────────────────────────────────────────────────

    // Group by date
    const byDate = {};
    unpaid.forEach(d => {
      const dateKey = new Date(d.delivered_timestamp.seconds * 1000)
        .toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" })
        .split("/").reverse().join("-"); // YYYY-MM-DD
      if (!byDate[dateKey]) byDate[dateKey] = { deliveries: [], total: 0 };
      byDate[dateKey].deliveries.push(d);
      byDate[dateKey].total += parseFloat(d.freight_amount || 0);
    });

    const grandTotal = unpaid.reduce((s, d) => s + parseFloat(d.freight_amount || 0), 0);

    res.json({
      byDate,
      grandTotal: parseFloat(grandTotal.toFixed(2)),
      count: unpaid.length,
      from: fromDate,
      to: toDate
    });
  } catch (err) {
    console.error("/driver-outstanding error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ════════════════════════════════════════════════
   TALLY PRODUCTS
   GET /tally/products — reads from Firestore
════════════════════════════════════════════════ */
app.get("/tally/products", async (req, res) => {
  try {
    const snap = await getDoc(doc(db, "tally_products", "index"));
    if (!snap.exists()) return res.json({ names: [], count: 0 });
    const data = snap.data();
    res.json({ names: data.names || [], count: data.count || 0 });
  } catch (err) {
    console.error("/tally/products error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ════════════════════════════════════════════════
   PARSE INVOICE PDF
   POST /parse-invoice
   Accepts a Tally GST invoice PDF, extracts:
   customer_name, phone, address, invoice_number,
   products[{ product_name, serial_number }]
════════════════════════════════════════════════ */
app.post("/parse-invoice", authenticate, authorize(["accountant", "admin"]), upload.single("invoice"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const data = await pdfParse(req.file.buffer);
    const text = data.text;
    const lines = text.split("\n").map(l => l.trim()).filter(l => l);

    const result = {};

    // ── Invoice Number ──
    const invMatch = text.match(/(\d{4}-\d{2}\/\d+)/);
    result.invoice_number = invMatch ? invMatch[1] : "";

    // ── Customer Name — line after "Buyer" ──
    const buyerIdx = lines.findIndex(l => l === "Buyer");
    if (buyerIdx !== -1) {
      result.customer_name = lines[buyerIdx + 1] || "";
    }

    // ── Phone — 10 digit Indian mobile ──
    const phones = text.match(/\b[6-9]\d{9}\b/g) || [];
    result.phone = phones[0] || "";

    // ── Address — lines between customer name and phone ──
    const NOISE = /^(State Name|Despatch|Despatched|Terms|Buyer|GST|E-Mail|GSTIN|Invoice|Delivery|Mode|Supplier|Other|Dated|Buyer's Order)/i;
    if (buyerIdx !== -1) {
      const nameLine = buyerIdx + 1;
      const phoneLine = lines.findIndex((l, i) => i > nameLine && /^[6-9]\d{9}$/.test(l));
      if (phoneLine !== -1) {
        const addrLines = lines.slice(nameLine + 1, phoneLine).filter(l => l && !NOISE.test(l));
        result.address = addrLines.map(l => l.replace(/^,|,$/g, "").trim()).filter(Boolean).join(", ");
      }
    }

    // ── Products + Serial Numbers ──
    const products = [];
    for (let i = 0; i < lines.length; i++) {
      // Match product row: starts with number, contains 8-digit HSN code
      const m = lines[i].match(/^\d+\s+(.+?)\s+\d{8}\s+\d+\s+NOS/);
      if (m) {
        let productName = m[1].trim();
        // Continuation line (e.g. "-Z")
        if (i + 1 < lines.length && /^-\w/.test(lines[i + 1])) {
          productName += lines[i + 1];
          i++;
        }
        // Find serial number in next few lines — long digit string
        let serial = "";
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
          if (/^\d{10,}$/.test(lines[j])) {
            serial = lines[j];
            break;
          }
        }
        products.push({ product_name: productName, serial_number: serial });
      }
    }
    result.products = products;

    console.log(`[parse-invoice] Extracted: ${result.customer_name}, ${result.phone}, ${products.length} product(s)`);
    res.json(result);

  } catch (err) {
    console.error("/parse-invoice error:", err.message);
    res.status(500).json({ error: "Failed to parse invoice: " + err.message });
  }
});

/* ════════════════════════════════════════════════
   FIREBASE STORAGE MANAGEMENT
   GET  /storage/stats         — total size + per-folder breakdown
   GET  /storage/download-zip  — download photos in date range as ZIP
   POST /storage/cleanup       — delete photos in date range (triple confirmed client side)
════════════════════════════════════════════════ */

const adminBucket    = admin.storage().bucket(process.env.FIREBASE_STORAGE_BUCKET || "hariom-delivery.firebasestorage.app");
const PHOTO_FOLDERS  = ["delivery_proofs_loaded", "delivery_proofs_delivered", "delivery_failures"];

// Files are named <timestamp>_<suffix> — parse upload date from filename
function fileDate(name) {
  const base = name.split("/").pop();
  const ts   = parseInt(base.split("_")[0]);
  return isNaN(ts) ? null : new Date(ts);
}

async function listPhotos(fromDate, toDate) {
  const files = [];
  for (const folder of PHOTO_FOLDERS) {
    try {
      const [list] = await adminBucket.getFiles({ prefix: folder + "/" });
      for (const f of list) {
        const d = fileDate(f.name);
        if (fromDate && d && d < fromDate) continue;
        if (toDate   && d && d > toDate)   continue;
        files.push({ file: f, folder, sizeBytes: parseInt(f.metadata.size || 0), date: d });
      }
    } catch (e) { console.warn(`[storage] list ${folder}:`, e.message); }
  }
  return files;
}

function fmtBytes(b) {
  return b >= 1073741824 ? (b / 1073741824).toFixed(2) + " GB" : (b / 1048576).toFixed(2) + " MB";
}

// GET /storage/stats
app.get("/storage/stats", authenticate, authorize(["admin"]), async (req, res) => {
  try {
    const all = await listPhotos();
    let totalBytes = 0;
    const byFolder = Object.fromEntries(PHOTO_FOLDERS.map(f => [f, { count: 0, bytes: 0 }]));
    for (const f of all) {
      totalBytes += f.sizeBytes;
      if (byFolder[f.folder]) { byFolder[f.folder].count++; byFolder[f.folder].bytes += f.sizeBytes; }
    }
    res.json({
      totalFiles: all.length,
      totalBytes,
      totalFormatted: fmtBytes(totalBytes),
      byFolder: Object.fromEntries(Object.entries(byFolder).map(([k, v]) => [k, { ...v, formatted: fmtBytes(v.bytes) }]))
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /storage/download-zip?from=YYYY-MM-DD&to=YYYY-MM-DD
app.get("/storage/download-zip", authenticate, authorize(["admin"]), async (req, res) => {
  try {
    const fromDate = req.query.from ? new Date(req.query.from + "T00:00:00.000+05:30") : null;
    const toDate   = req.query.to   ? new Date(req.query.to   + "T23:59:59.999+05:30") : null;
    const files    = await listPhotos(fromDate, toDate);
    if (!files.length) return res.status(404).json({ error: "No photos found in that date range" });

    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    const CHUNK = 20;
    for (let i = 0; i < files.length; i += CHUNK) {
      await Promise.all(files.slice(i, i + CHUNK).map(async ({ file }) => {
        try {
          const [buf] = await file.download();
          zip.file(file.name.replace(/\//g, "_"), buf);
        } catch (e) { console.warn(`[zip] skip ${file.name}`); }
      }));
    }
    const buf   = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
    const label = req.query.from && req.query.to ? `${req.query.from}_to_${req.query.to}` : "all";
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="hariom_photos_${label}.zip"`);
    res.send(buf);
  } catch (e) { console.error("/storage/download-zip:", e.message); res.status(500).json({ error: e.message }); }
});

// POST /storage/cleanup  { from, to, confirm_phrase }
app.post("/storage/cleanup", authenticate, authorize(["admin"]), async (req, res) => {
  try {
    const { from, to, confirm_phrase } = req.body;
    if (confirm_phrase !== "DELETE ALL PHOTOS") return res.status(400).json({ error: "Invalid confirmation" });
    const fromDate = from ? new Date(from + "T00:00:00.000+05:30") : null;
    const toDate   = to   ? new Date(to   + "T23:59:59.999+05:30") : null;
    const files    = await listPhotos(fromDate, toDate);
    if (!files.length) return res.json({ deleted: 0, failed: 0, message: "No photos found in that range" });
    let deleted = 0, failed = 0;
    const CHUNK = 20;
    for (let i = 0; i < files.length; i += CHUNK) {
      await Promise.all(files.slice(i, i + CHUNK).map(async ({ file }) => {
        try { await file.delete(); deleted++; }
        catch (e) { console.warn(`[cleanup] ${file.name}:`, e.message); failed++; }
      }));
    }
    console.log(`[storage/cleanup] deleted=${deleted} failed=${failed}`);
    res.json({ deleted, failed, message: `Deleted ${deleted} photo(s)` });
  } catch (e) { console.error("/storage/cleanup:", e.message); res.status(500).json({ error: e.message }); }
});



// Express async error handler
app.use((err, req, res, next) => {
  console.error("Unhandled Express error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// Unhandled promise rejections — log but don't crash
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Promise Rejection:", reason);
});

// Uncaught exceptions — log and gracefully exit (Render will restart)
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
  process.exit(1);
});

/* ════════════════════════════════════════════════
   START
════════════════════════════════════════════════ */

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
  runStartupMigration();
});
