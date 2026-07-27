import fetch from "node-fetch";

const WHATSAPP_API_BASE = "https://graph.facebook.com/v22.0";

let _config = null;
function getConfig() {
  if (!_config) {
    _config = {
      token: process.env.WHATSAPP_TOKEN,
      phoneNumberId: process.env.PHONE_NUMBER_ID,
    };
    if (!_config.token || !_config.phoneNumberId) {
      console.warn("[whatsapp] Missing WHATSAPP_TOKEN or PHONE_NUMBER_ID env vars");
    }
  }
  return _config;
}

async function api(method, payload) {
  const cfg = getConfig();
  if (!cfg.token || !cfg.phoneNumberId) {
    throw new Error("WhatsApp API not configured");
  }
  const url = `${WHATSAPP_API_BASE}/${cfg.phoneNumberId}/messages`;
  const res = await fetch(url, {
    method: method || "POST",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/json",
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const body = await res.json();
  if (!res.ok) {
    console.error("[whatsapp] API error:", res.status, JSON.stringify(body));
    throw new Error(`WhatsApp API error: ${res.status} ${body?.error?.message || ""}`);
  }
  return body;
}

export async function sendText(to, text) {
  return api("POST", {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text, preview_url: false },
  });
}

export async function sendReplyButtons(to, header, body, footer, buttons) {
  const interactive = {
    type: "button",
    header: header ? { type: "text", text: header } : undefined,
    body: { text },
    footer: footer ? { text: footer } : undefined,
    action: {
      buttons: buttons.map((b) => ({
        type: "reply",
        reply: { id: b.id, title: b.title.slice(0, 20) },
      })),
    },
  };
  return api("POST", {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive,
  });
}

export async function sendListMessage(to, header, body, footer, buttonText, sections) {
  const interactive = {
    type: "list",
    header: header ? { type: "text", text: header } : undefined,
    body: { text },
    footer: footer ? { text: footer } : undefined,
    action: {
      button: (buttonText || "Options").slice(0, 20),
      sections: sections.map((s) => ({
        title: s.title.slice(0, 24) || undefined,
        rows: s.rows.map((r) => ({
          id: r.id,
          title: r.title.slice(0, 24),
          description: r.description ? r.description.slice(0, 72) : undefined,
        })),
      })),
    },
  };
  return api("POST", {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive,
  });
}

export async function sendTemplate(to, templateName, langCode, params) {
  return api("POST", {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: langCode || "en" },
      components: params
        ? [{ type: "body", parameters: params.map((p) => ({ type: "text", text: p })) }]
        : undefined,
    },
  });
}

export async function markMessageRead(messageId) {
  return api("POST", {
    messaging_product: "whatsapp",
    status: "read",
    message_id: messageId,
  });
}
