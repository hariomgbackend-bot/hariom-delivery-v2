import { Router } from "express";
import crypto from "crypto";
import admin from "firebase-admin";
import {
  sendText,
  sendReplyButtons,
  sendListMessage,
  markMessageRead,
} from "../services/whatsapp.js";
import menus from "../data/whatsappMenus.json" with { type: "json" };

const router = Router();
let _sessionDb = null;
function sessionsDb() {
  if (!_sessionDb) {
    try { _sessionDb = admin.firestore(); } catch {
      console.warn("[whatsapp] Admin SDK not yet initialized — sessions will be in-memory only");
      return null;
    }
  }
  return _sessionDb;
}
const SESSIONS_COLLECTION = "whatsapp_sessions";

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "hariom_whatsapp_verify_2026";
const APP_SECRET = process.env.WHATSAPP_APP_SECRET || "";

/* ─────────────── WEBHOOK VERIFICATION (GET) ─────────────── */
router.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("[whatsapp] Webhook verified");
    return res.status(200).send(challenge);
  }
  console.warn("[whatsapp] Webhook verification failed — mode:", mode, "token:", token);
  return res.status(403).send("Verification failed");
});

/* ─────────────── SIGNATURE VERIFICATION + HANDLER ─────────── */
router.post("/webhook", verifySignature, handleWebhook);

function verifySignature(req, res, next) {
  if (!APP_SECRET) {
    // No secret configured — skip verification (dev mode)
    return next();
  }
  const signature = req.headers["x-hub-signature-256"];
  if (!signature) {
    console.warn("[whatsapp] Missing signature header");
    return res.status(401).send("Missing signature");
  }
  const hmac = crypto.createHmac("sha256", APP_SECRET);
  hmac.update(req.rawBody || "");
  const expected = "sha256=" + hmac.digest("hex");
  try {
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      console.warn("[whatsapp] Invalid signature");
      return res.status(401).send("Invalid signature");
    }
  } catch {
    return res.status(401).send("Signature verification failed");
  }
  next();
}

/* ─────────────── MAIN WEBHOOK HANDLER ───────────────────── */
async function handleWebhook(req, res) {
  res.sendStatus(200);

  try {
    const entry = req.body?.entry;
    if (!entry) return;

    for (const e of entry) {
      for (const change of e.changes || []) {
        const value = change.value;
        if (!value || !value.messaging_product) continue;

        // Process status updates (ignore)
        if (value.statuses) {
          for (const s of value.statuses) {
            if (s.status === "read" || s.status === "delivered") continue;
          }
          continue;
        }

        // Process incoming messages
        for (const msg of value.messages || []) {
          const from = msg.from; // customer phone
          const msgId = msg.id;
          const msgType = msg.type;

          // Mark as read
          try { await markMessageRead(msgId); } catch {}

          // Get or create session
          let session = await getSession(from);
          const isNew = !session;
          if (!session) {
            session = {
              language: "en",
              state: "WELCOME",
              context: {},
              lastInteraction: admin.firestore.Timestamp.now(),
              customerName: value.contacts?.[0]?.profile?.name || "",
              createdAt: admin.firestore.Timestamp.now(),
            };
          }
          session.lastInteraction = admin.firestore.Timestamp.now();

          // Process message based on type
          let text = "";
          let interactionId = "";

          if (msgType === "text") {
            text = (msg.text?.body || "").trim();
          } else if (msgType === "interactive") {
            const ia = msg.interactive || {};
            if (ia.type === "button_reply") {
              interactionId = ia.button_reply?.id || "";
              text = ia.button_reply?.title || "";
            } else if (ia.type === "list_reply") {
              interactionId = ia.list_reply?.id || "";
              text = ia.list_reply?.title || "";
            }
          }

          // Route to state handler
          try {
            await routeMessage(from, session, isNew, text, interactionId, msgType);
          } catch (err) {
            console.error("[whatsapp] Route error:", err.message);
            const menuText = getMenuText("ERROR", session.language);
            if (menuText) await sendText(from, menuText.body);
          }
        }
      }
    }
  } catch (err) {
    console.error("[whatsapp] Webhook error:", err.message);
  }
}

/* ─────────────── STATE MACHINE ROUTER ───────────────────── */
async function routeMessage(from, session, isNew, text, interactionId, msgType) {
  const lang = session.language;

  if (isNew || session.state === "WELCOME") {
    return showWelcome(from, session);
  }

  // Handle language selection from any state
  if (interactionId === "lang_en" || interactionId === "lang_mr" || interactionId === "lang_hi") {
    session.language = interactionId.replace("lang_", "");
    session.state = "MAIN_MENU";
    await saveSession(from, session);
    return showMainMenu(from, session);
  }

  switch (session.state) {
    case "MAIN_MENU":
      return handleMainMenu(from, session, interactionId);

    case "PRODUCT_CATEGORY":
      return handleProductCategory(from, session, interactionId, text);

    case "SERVICE_REQUEST_PRODUCT":
      return handleServiceProduct(from, session, text);

    case "SERVICE_REQUEST_BRAND":
      return handleServiceBrand(from, session, text);

    case "SERVICE_REQUEST_PROBLEM":
      return handleServiceProblem(from, session, text);

    default:
      // Unknown state — reset to main menu
      session.state = "MAIN_MENU";
      await saveSession(from, session);
      return showMainMenu(from, session);
  }
}

/* ─────────────── STATE HANDLERS ─────────────────────────── */

async function showWelcome(from, session) {
  session.state = "WELCOME";
  await saveSession(from, session);
  const m = getMenu("WELCOME", session.language);
  await sendReplyButtons(from, m.header, m.body, m.footer, m.buttons);
}

async function showMainMenu(from, session) {
  session.state = "MAIN_MENU";
  await saveSession(from, session);
  const m = getMenu("MAIN_MENU", session.language);
  await sendListMessage(from, m.header, m.body, m.footer, m.buttonText, m.sections);
}

async function handleMainMenu(from, session, id) {
  switch (id) {
    case "menu_product":
      session.state = "PRODUCT_CATEGORY";
      session.context = {};
      await saveSession(from, session);
      const pm = getMenu("PRODUCT_CATEGORY", session.language);
      return sendListMessage(from, pm.header, pm.body, pm.footer, pm.buttonText, pm.sections);

    case "menu_service":
      session.state = "SERVICE_REQUEST_PRODUCT";
      session.context = {};
      await saveSession(from, session);
      const sm = getMenu("SERVICE_REQUEST", session.language);
      return sendText(from, sm.askProduct);

    case "menu_store":
      const st = getMenu("STORE_LOCATION", session.language);
      await sendText(from, st.body);
      session.state = "MAIN_MENU";
      await saveSession(from, session);
      return showMainMenu(from, session);

    case "menu_staff":
      const tk = getMenu("TALK_TO_STAFF", session.language);
      await sendText(from, tk.body);
      session.state = "MAIN_MENU";
      await saveSession(from, session);
      return showMainMenu(from, session);

    default:
      // Unrecognized — send error and re-show menu
      const em = getMenu("ERROR", session.language);
      await sendText(from, em.body);
      return showMainMenu(from, session);
  }
}

async function handleProductCategory(from, session, id, text) {
  const productMap = {
    cat_tv: "TV",
    cat_refrigerator: "Refrigerator",
    cat_washing_machine: "Washing Machine",
    cat_ac: "Air Conditioner",
    cat_mobile: "Mobile",
    cat_kitchen: "Kitchen Appliances",
    cat_sofa: "Sofa",
    cat_bed: "Bed",
    cat_dining: "Dining Table",
    cat_wardrobe: "Wardrobe",
    cat_other: "Other",
  };

  const product = productMap[id] || text || "product";
  const m = getMenu("PRODUCT_INFO", session.language);
  const reply = m.body.replace("__PRODUCT__", product);

  await sendText(from, reply);
  session.state = "MAIN_MENU";
  await saveSession(from, session);
  return showMainMenu(from, session);
}

async function handleServiceProduct(from, session, text) {
  if (!text) {
    const m = getMenu("SERVICE_REQUEST", session.language);
    return sendText(from, m.askProduct);
  }
  session.context.product = text;
  session.state = "SERVICE_REQUEST_BRAND";
  await saveSession(from, session);
  const m = getMenu("SERVICE_REQUEST", session.language);
  return sendText(from, m.askBrand);
}

async function handleServiceBrand(from, session, text) {
  if (!text) {
    const m = getMenu("SERVICE_REQUEST", session.language);
    return sendText(from, m.askBrand);
  }
  session.context.brand = text;
  session.state = "SERVICE_REQUEST_PROBLEM";
  await saveSession(from, session);
  const m = getMenu("SERVICE_REQUEST", session.language);
  return sendText(from, m.askProblem);
}

async function handleServiceProblem(from, session, text) {
  if (!text) {
    const m = getMenu("SERVICE_REQUEST", session.language);
    return sendText(from, m.askProblem);
  }
  session.context.problem = text;
  const m = getMenu("SERVICE_REQUEST", session.language);
  const confirm = m.confirm
    .replace("__PRODUCT__", session.context.product || "")
    .replace("__BRAND__", session.context.brand || "")
    .replace("__PROBLEM__", session.context.problem || "");

  await sendText(from, confirm);
  session.state = "MAIN_MENU";
  await saveSession(from, session);
  return showMainMenu(from, session);
}

/* ─────────────── HELPERS ────────────────────────────────── */

function getMenu(state, lang) {
  const stateMenus = menus[state];
  if (!stateMenus) return null;
  return stateMenus[lang] || stateMenus.en || null;
}

function getMenuText(state, lang) {
  const m = getMenu(state, lang);
  if (!m) return null;
  if (typeof m === "string") return { body: m };
  if (m.body) return m;
  return null;
}

async function getSession(phone) {
  try {
    const snap = await sessionsDb().collection(SESSIONS_COLLECTION).doc(phone).get();
    if (!snap.exists) return null;
    const data = snap.data();
    return {
      language: data.language || "en",
      state: data.state || "WELCOME",
      context: data.context || {},
      lastInteraction: data.lastInteraction,
      customerName: data.customerName || "",
    };
  } catch (err) {
    console.error("[whatsapp] getSession error:", err.message);
    return null;
  }
}

async function saveSession(phone, session) {
  try {
    await sessionsDb().collection(SESSIONS_COLLECTION).doc(phone).set({
      language: session.language,
      state: session.state,
      context: session.context || {},
      lastInteraction: session.lastInteraction || admin.firestore.Timestamp.now(),
      customerName: session.customerName || "",
      createdAt: session.createdAt || admin.firestore.Timestamp.now(),
    });
  } catch (err) {
    console.error("[whatsapp] saveSession error:", err.message);
  }
}

export default router;
