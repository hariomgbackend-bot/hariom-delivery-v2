import express from "express";
import cors from "cors";
import db from "./firestore.js";
import { storage } from "./storage.js";
import fetch from "node-fetch";
import multer from "multer";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
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
const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_KEY;

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
app.use(cors());
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
      photo_loaded_url: url,
      // Save freight charge if driver set it (only when not already set by admin)
      ...((!delivery.freight_charged && req.body.driver_freight_amount)
        ? { freight_charged: true, freight_amount: req.body.driver_freight_amount, freight_set_by: "driver" }
        : {})
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

    // Write delivered status immediately
    await updateDoc(refDoc, {
      status: "delivered",
      delivered_timestamp: Timestamp.now(),
      delivered_location: { lat: delivLat, lng: delivLng },
      photo_delivered_url: url,
    });

    // ✅ Respond to driver RIGHT NOW — don't make them wait for distance/notifications
    res.json({ success: true });

    // Run distance calculation + notifications in background (non-blocking)
    (async () => {
      try {
        let distance_km = null;
        const loadedLoc = deliveryData.loaded_location;
        if (loadedLoc?.lat && loadedLoc?.lng && delivLat && delivLng && GOOGLE_MAPS_KEY) {
          const mapsUrl = `https://maps.googleapis.com/maps/api/distancematrix/json` +
            `?origins=${loadedLoc.lat},${loadedLoc.lng}` +
            `&destinations=${delivLat},${delivLng}` +
            `&key=${GOOGLE_MAPS_KEY}`;
          const mapsRes  = await fetch(mapsUrl);
          const mapsData = await mapsRes.json();
          const element  = mapsData?.rows?.[0]?.elements?.[0];
          if (element?.status === "OK") {
            distance_km = parseFloat((element.distance.value / 1000).toFixed(2));
            await updateDoc(refDoc, { distance_km });
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
    await updateDoc(deliveryRef, {
      freight_paid: true,
      freight_paid_timestamp: Timestamp.now()
    });
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

    const unpaid = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(d => {
        if (d.freight_paid) return false;
        if (d.freight_set_by !== "driver" || !d.freight_charged) return false;
        if (!d.delivered_timestamp) return false;
        const ts = new Date(d.delivered_timestamp.seconds * 1000);
        return ts >= dayStart && ts <= dayEnd;
      });

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
   GLOBAL ERROR HANDLERS
   Catches unhandled errors so the server never crashes
════════════════════════════════════════════════ */

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
