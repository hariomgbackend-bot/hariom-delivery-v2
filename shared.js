/* ════════════════════════════════════════════════
   SHARED UTILITIES — loaded by all frontend pages
════════════════════════════════════════════════ */

/* ── Store ID → display name ── */
function storeDisplayName(id) {
  if (!id || id === "all") return "";
  try {
    if (typeof _stores !== "undefined" && _stores) {
      const found = _stores.find(s => s.id === id);
      if (found) return found.name;
    }
  } catch {}
  try {
    if (window._stores) {
      const found = window._stores.find(s => s.id === id);
      if (found) return found.name;
    }
  } catch {}
  const KNOWN = { store_a: "Alandi", store_b: "Dhanore" };
  return KNOWN[id] || id;
}

/* ── Store badge (colored circle with first letter) ── */
function mkStoreBadge(storeId, size = 22) {
  if (!storeId) return "";
  const name = storeDisplayName(storeId);
  if (!name) return `<span style="display:inline-flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;border-radius:50%;background:var(--surface-container-high);color:var(--outline);font-size:${Math.round(size*0.5)}px;font-weight:700;box-shadow:0 1px 3px rgba(0,0,0,0.08);vertical-align:middle;">?</span>`;
  const letter = name.charAt(0).toUpperCase();
  const fs = Math.round(size * 0.5);
  const GRADIENTS = {
    store_a: ["#4f46e5","#818cf8"],
    store_b: ["#059669","#34d399"],
  };
  let c1, c2;
  if (GRADIENTS[storeId]) {
    [c1,c2] = GRADIENTS[storeId];
  } else {
    const hash = [...storeId].reduce((h,c)=>((h<<5)-h+c.charCodeAt(0))|0,0);
    const hue = ((hash % 360) + 360) % 360;
    c1 = `hsl(${hue},70%,50%)`;
    c2 = `hsl(${(hue+40)%360},70%,65%)`;
  }
  return `<span style="display:inline-flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;border-radius:50%;background:linear-gradient(135deg,${c1},${c2});color:#fff;font-size:${fs}px;font-weight:800;box-shadow:0 2px 4px rgba(0,0,0,0.12);vertical-align:middle;">${letter}</span>`;
}

/* ── Skeleton loading placeholders ── */
function skeletons(n, type = "card") {
  if (type === "row") {
    return `<tr><td colspan="99" style="padding:0;border:none;"><div class="skeleton" style="height:40px;width:100%;margin:6px 0;"></div><div class="skeleton" style="height:40px;width:100%;margin:6px 0;"></div><div class="skeleton" style="height:40px;width:100%;margin:6px 0;"></div></td></tr>`;
  }
  return Array.from({length:n}, () => `
    <div class="skeleton-card">
      <div class="skeleton-line" style="height:18px;width:60%;"></div>
      <div class="skeleton-line" style="height:13px;width:40%;"></div>
      <div class="skeleton-line" style="height:13px;width:80%;margin-top:14px;"></div>
    </div>`).join("");
}

/* ── HTML escape ── */
function escHtml(s) {
  return String(s||"").replace(/&#x2F;/g,"/").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

/* ── Proof-stamp verdict badge ──
   Reads the per-stage verdict the server records on a delivery
   (proof_stamp_loaded / proof_stamp_delivered / proof_stamp_failed).
   Deliveries recorded before stamping existed have no verdict and render nothing. */
function proofStampBadge(delivery, stage) {
  const s = delivery && delivery["proof_stamp_" + stage];
  if (!s || !s.status) return "";

  const styles = {
    verified: ["rgba(22,163,74,0.15)",  "#16a34a", "rgba(22,163,74,0.35)",  "✓ Proof verified"],
    flagged:  ["rgba(245,158,11,0.15)", "#b45309", "rgba(245,158,11,0.40)", "⚠ Proof flagged"],
    missing:  ["rgba(148,163,184,0.18)","#64748b", "rgba(148,163,184,0.45)","– No proof stamp"]
  };
  const [bg, fg, border, label] = styles[s.status] || styles.missing;

  const bits = [];
  if (s.ts && s.ts.seconds) {
    bits.push("stamped " + new Date(s.ts.seconds * 1000).toLocaleString("en-IN", {
      day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit"
    }));
  }
  bits.push(s.lat != null && s.lng != null
    ? s.lat.toFixed(5) + ", " + s.lng.toFixed(5)
    : "no coordinates");
  if (s.accuracy_m != null) bits.push("±" + Math.round(s.accuracy_m) + "m");
  if (Array.isArray(s.reasons) && s.reasons.length) bits.push(s.reasons.join("; "));

  return `<div title="${escHtml(bits.join(" · "))}" style="display:inline-block;margin-top:6px;` +
         `padding:2px 10px;border-radius:10px;font-size:11px;font-weight:700;` +
         `background:${bg};color:${fg};border:1px solid ${border};">${label}</div>`;
}

/* ── XML tag extractor (multiline) ── */
function tagAll(name, t) {
  const re = new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, "gi");
  const results = [];
  let m;
  while ((m = re.exec(t)) !== null) results.push(m[1].trim());
  return results;
}

/* ── Brand extraction from product name ── */
function getBrand(name) {
  const n = (name || "").toUpperCase().trim();
  const stripped = n.replace(/^(WM|LED|REF|AC|A\/C|P-FAN|E-GEYSER|IC|TV|FAN|COOLER|GEYSER)\s+/,"").trim();
  const brandMap = [
    ["SAMSUNG"],["WHIRLPOOL"],["HAIER"],["LG"],["BOSCH"],["IFB"],
    ["VOLTAS"],["DAIKIN"],["HITACHI"],["CARRIER"],["BLUE STAR","BLUESTAR"],
    ["GODREJ"],["VIDEOCON"],["PANASONIC"],["SONY"],["PHILIPS"],
    ["BAJAJ"],["ORIENT"],["HAVELLS"],["USHA"],["CROMPTON"],
    ["LIVPURE"],["SYMPHONY"],["HINDWARE"],["RACOLD"],["AO SMITH","AOSMITH"],
    ["LLOYD"],["ONIDA"],["MICROMAX"],["TCL"],["HISENSE"],
    ["REALME"],["MI","XIAOMI"],["VU"],["MOTOROLA"],["ZEBRONICS"],
    ["KENT"],["PUREIT"],["EUREKA FORBES","EUREKAFORBES"],
  ];
  for (const aliases of brandMap) {
    for (const alias of aliases) {
      if (stripped.startsWith(alias) || n.includes(" "+alias+" ") || n.includes(" "+alias)) {
        return aliases[0];
      }
    }
  }
  const first = stripped.split(/\s+/)[0];
  return first && first.length > 1 ? first : "Other";
}

/* ── Delivery time rating badge ── */
function ratingBadge(d) {
  if (d.status !== "delivered" || !d.delivered_timestamp || !d.estimated_delivery_time) return "";
  const diff = (new Date(d.delivered_timestamp.seconds*1000) - new Date(d.estimated_delivery_time))/60000;
  if (diff<=-10) return `<span style="padding:2px 7px;border-radius:8px;font-size:10px;font-weight:700;background:#d1fae5;color:#065f46;">⚡ Early</span>`;
  if (diff<= 10) return `<span style="padding:2px 7px;border-radius:8px;font-size:10px;font-weight:700;background:#dbeafe;color:#1e40af;">✅ On Time</span>`;
  if (diff<= 30) return `<span style="padding:2px 7px;border-radius:8px;font-size:10px;font-weight:700;background:#fef3c7;color:#92400e;">🕐 Late</span>`;
  return `<span style="padding:2px 7px;border-radius:8px;font-size:10px;font-weight:700;background:rgba(255,180,171,0.15);color:var(--error);">🔴 VLate</span>`;
}

/* ── Toast notification (queued so rapid toasts don't clobber) ── */
const TOAST_ICONS = { success:"✅", error:"❌", warning:"⚠️", info:"ℹ️" };
let _toastQueue = [];
let _toastShowing = false;
function showToast(msg, type = "") {
  _toastQueue.push({ msg, type });
  if (!_toastShowing) _processToast();
}
function _processToast() {
  if (_toastQueue.length === 0) { _toastShowing = false; return; }
  _toastShowing = true;
  const { msg, type } = _toastQueue.shift();
  const t = document.getElementById("toast");
  if (!t) { _toastShowing = false; return; }
  const icon = TOAST_ICONS[type] || "";
  t.innerHTML = icon ? `<span style="margin-right:6px;">${icon}</span>${msg}` : msg;
  t.className = "show " + type;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => {
    t.classList.remove("show");
    setTimeout(_processToast, 250);
  }, 3000);
}

/* ── Stagger card fade-in ── */
function staggerCards(container) {
  if (!container) return;
  const children = container.children;
  for (let i = 0; i < children.length; i++) {
    children[i].style.animation = `cardIn 0.3s ${i * 0.03}s both`;
  }
}

/* ── Empty state SVGs ── */
function emptyStateSVG(type) {
  const m = {
    clipboard:'<svg width="80" height="80" viewBox="0 0 80 80" fill="none"><rect x="20" y="12" width="40" height="54" rx="5" stroke="currentColor" stroke-width="2.5" opacity=".35"/><path d="M32 8c0-3 4-3 8-3s8-3 8-0" stroke="currentColor" stroke-width="2.5" opacity=".35"/><rect x="28" y="24" width="24" height="3" rx="1.5" fill="currentColor" opacity=".35"/><rect x="28" y="33" width="24" height="3" rx="1.5" fill="currentColor" opacity=".35"/><rect x="28" y="42" width="18" height="3" rx="1.5" fill="currentColor" opacity=".35"/><rect x="28" y="51" width="20" height="3" rx="1.5" fill="currentColor" opacity=".35"/></svg>',
    box:'<svg width="80" height="80" viewBox="0 0 80 80" fill="none"><rect x="18" y="32" width="44" height="32" rx="4" stroke="currentColor" stroke-width="2.5" opacity=".35"/><path d="M18 42h44" stroke="currentColor" stroke-width="2.5" opacity=".35"/><path d="M40 32v32" stroke="currentColor" stroke-width="2.5" opacity=".35"/><path d="M26 24l14-8 14 8" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" opacity=".35"/></svg>',
    person:'<svg width="80" height="80" viewBox="0 0 80 80" fill="none"><circle cx="40" cy="28" r="14" stroke="currentColor" stroke-width="2.5" opacity=".35"/><path d="M12 68c0-16 12-28 28-28s28 12 28 28" stroke="currentColor" stroke-width="2.5" opacity=".35"/></svg>',
    check:'<svg width="80" height="80" viewBox="0 0 80 80" fill="none"><circle cx="40" cy="40" r="28" stroke="currentColor" stroke-width="2.5" opacity=".35"/><path d="M28 40l8 8 16-16" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" opacity=".35"/></svg>',
    receipt:'<svg width="80" height="80" viewBox="0 0 80 80" fill="none"><path d="M22 14v52l6-4 6 4 6-4 6 4 6-4 6 4V14l-6 4-6-4-6 4-6-4-6 4-6-4z" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" opacity=".35"/><rect x="30" y="28" width="20" height="3" rx="1.5" fill="currentColor" opacity=".35"/><rect x="30" y="36" width="20" height="3" rx="1.5" fill="currentColor" opacity=".35"/><rect x="30" y="44" width="14" height="3" rx="1.5" fill="currentColor" opacity=".35"/></svg>',
  };
  return m[type] || m.box;
}

/* ── Is this product an air conditioner? (split/window ACs are photographed as
      indoor + outdoor units; other products get a single unlabelled photo) ── */
function isACProductName(name) {
  if (!name) return false;
  const p = String(name).toUpperCase();
  return /\bAC\b|\bAIR\s*CONDITIONER\b|SPLIT\s+AC|WINDOW\s+AC|INVERTER\s+AC/i.test(p);
}

/* ── Downscale a captured photo before upload.
      Caps the long edge at 1280px and re-encodes as q0.75 JPEG, which is what
      makes a phone photo small enough to submit over mobile data. Never rejects:
      on any decode/encode failure (or after 10s) it resolves with the original
      file so a capture is never blocked by compression. ── */
function compressImage(file) {
  return new Promise(resolve => {
    let settled = false;
    const finish = blob => { if (!settled) { settled = true; resolve(blob || file); } };
    const fail  = () => finish(file);

    const timer = setTimeout(fail, 10000);   // hard cap — never hang the caller

    const reader = new FileReader();
    reader.onerror = fail;
    reader.onload = e => {
      const img = new Image();
      img.onerror = fail;
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          const max = 1280;
          let w = img.width, h = img.height;
          if (!w || !h) return fail();
          if (w > max) { h = Math.round(h * max / w); w = max; }
          canvas.width = w; canvas.height = h;
          canvas.getContext("2d").drawImage(img, 0, 0, w, h);
          canvas.toBlob(b => { clearTimeout(timer); finish(b); }, "image/jpeg", 0.75);
          if (!canvas.toBlob) fail();   // very old engines
        } catch (err) { fail(); }
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

/* ════════════════════════════════════════════════
   PUBLIC ENQUIRY FORM — default catalogue

   The live form reads settings/enquiry_form (editable in admin.html).
   Until an admin saves a config, enquiry.html uses this catalogue, and
   admin.html uses it as the "Reset to defaults" baseline.
════════════════════════════════════════════════ */
const ENQUIRY_DEFAULT_CONFIG = {
  version: 2,
  exchange: { enabled: true, max_photos: 3, photo_required: false },
  categories: [
    {
      key: "LED", label_en: "TV / LED", label_mr: "टीव्ही / एलईडी", icon: "tv", enabled: true,
      brands: ["SAMSUNG","LG","SONY","HAIER","TCL","PANASONIC","LLOYD","VIDEOCON","ONIDA"],
      variants: [
        { value: "24",     label_en: '24"',                label_mr: '२४"' },
        { value: "32",     label_en: '32"',                label_mr: '३२"' },
        { value: "40",     label_en: '40"',                label_mr: '४०"' },
        { value: "43",     label_en: '43"',                label_mr: '४३"' },
        { value: "50",     label_en: '50"',                label_mr: '५०"' },
        { value: "55",     label_en: '55"',                label_mr: '५५"' },
        { value: "65",     label_en: '65"',                label_mr: '६५"' },
        { value: "65plus", label_en: '65" or bigger',      label_mr: '६५" किंवा मोठा' }
      ]
    },
    {
      key: "WM", label_en: "Washing Machine", label_mr: "वॉशिंग मशीन", icon: "local_laundry_service", enabled: true,
      brands: ["SAMSUNG","LG","WHIRLPOOL","HAIER","IFB","BOSCH","GODREJ","VOLTAS"],
      variants: [
        { value: "TL", label_en: "Top Load (TL)",      label_mr: "टॉप लोड (TL)" },
        { value: "FL", label_en: "Front Load (FL)",    label_mr: "फ्रंट लोड (FL)" },
        { value: "SA", label_en: "Semi-Automatic (SA)", label_mr: "सेमी ऑटोमॅटिक (SA)" }
      ]
    },
    {
      key: "REF", label_en: "Refrigerator", label_mr: "रेफ्रिजरेटर", icon: "kitchen", enabled: true,
      brands: ["SAMSUNG","LG","WHIRLPOOL","HAIER","GODREJ","HISENSE","PANASONIC"],
      variants: [
        { value: "DC",  label_en: "Direct Cool (DC)",  label_mr: "डायरेक्ट कूल (DC)" },
        { value: "FF",  label_en: "Frost Free (FF)",   label_mr: "फ्रॉस्ट फ्री (FF)" },
        { value: "SBS", label_en: "Side-by-Side",      label_mr: "साइड-बाय-साइड" }
      ]
    },
    {
      key: "AC", label_en: "Air Conditioner", label_mr: "एअर कंडिशनर", icon: "ac_unit", enabled: true,
      brands: ["SAMSUNG","LG","VOLTAS","DAIKIN","BLUE STAR","HITACHI","LLOYD","PANASONIC","CROMPTON"],
      variants: [
        { value: "1.0T", label_en: "1.0 Ton", label_mr: "१ टन" },
        { value: "1.5T", label_en: "1.5 Ton", label_mr: "१.५ टन" },
        { value: "2.0T", label_en: "2.0 Ton", label_mr: "२ टन" },
        { value: "3.0T", label_en: "3.0 Ton", label_mr: "३ टन" },
        { value: "INV",  label_en: "Inverter", label_mr: "इनव्हर्टर" }
      ]
    },
    { key: "COOLER", label_en: "Air Cooler", label_mr: "एअर कूलर", icon: "air", enabled: true,
      brands: [], variants: [] },
    { key: "FAN", label_en: "Fan", label_mr: "फॅन", icon: "mode_fan", enabled: true,
      brands: [], variants: [] },
    { key: "MIXER", label_en: "Mixer / Grinder", label_mr: "मिक्सर / ग्राइंडर", icon: "blender", enabled: true,
      brands: [], variants: [] },
    { key: "COOKTOP", label_en: "Cooktop", label_mr: "कुकटॉप", icon: "local_fire_department", enabled: true,
      brands: [], variants: [] },
    { key: "E-GEYSER", label_en: "Geyser", label_mr: "गिझर", icon: "water_heater", enabled: true,
      brands: [], variants: [] },
    { key: "CHIMNEY", label_en: "Chimney", label_mr: "चिमणी", icon: "air_purifier", enabled: true,
      brands: [], variants: [] },
    { key: "LAPTOP", label_en: "Laptop", label_mr: "लॅपटॉप", icon: "laptop_mac", enabled: true,
      brands: [], variants: [] }
  ]
};

function enquiryDefaultConfig() {
  return JSON.parse(JSON.stringify(ENQUIRY_DEFAULT_CONFIG));
}

/* ── Unified auth fetch ── */
async function authFetch(url, options = {}) {
  const token = typeof window.authGetToken === "function" ? window.authGetToken() : null;
  if (!token) {
    if (typeof window.authOnError === "function") window.authOnError();
    throw new Error("No auth token");
  }
  const opts = {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: "Bearer " + token
    }
  };
  let res;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    console.error("authFetch network error:", url, e);
    throw e;
  }
  if (res.status === 401) {
    console.warn("authFetch 401:", url);
    if (typeof window.authOnError === "function") window.authOnError();
    throw new Error("401");
  }
  return res;
}

/* ════════════════════════════════════════════════
   LEAD PIPELINE VOCABULARY — single browser-side source

   Every panel renders leads from these, so the status set and the loss reasons
   can never drift apart again (a duplicated copy is what let the staff panel
   send a status the server would reject).

   server.js holds the matching LEAD_STATUSES / LEAD_LOSS_REASONS — keep the two
   in step when a stage is added.
════════════════════════════════════════════════ */

/* Stage order here is the Kanban column order. `accent` colours the column. */
const LEAD_STAGES = [
  { key: "new",      label: "New",             accent: "var(--primary)"  },
  { key: "quoted",   label: "Quoted",          accent: "#818cf8"         },
  { key: "deposit",  label: "Deposit",         accent: "#38bdf8"         },
  { key: "followup", label: "Follow-Up",       accent: "var(--amber)"    },
  { key: "visit",    label: "Visit Follow-Up", accent: "#c084fc"         },
  { key: "won",      label: "Won",             accent: "var(--tertiary)" },
  { key: "lost",     label: "Lost",            accent: "var(--error)"    },
];

/* Required when a lead is marked lost */
const LEAD_LOSS_REASONS = [
  { key: "price",         label: "Price"         },
  { key: "timing",        label: "Timing"        },
  { key: "competitor",    label: "Competitor"    },
  { key: "ghosted",       label: "Ghosted"       },
  { key: "not_qualified", label: "Not Qualified" },
];

/* How the customer came in */
const LEAD_SOURCES = [
  { key: "walk_in",  label: "Walk-in"  },
  { key: "phone",    label: "Phone"    },
  { key: "whatsapp", label: "WhatsApp" },
  { key: "referral", label: "Referral" },
  { key: "repeat",   label: "Repeat"   },
  { key: "web",      label: "Online / Website" },
  { key: "other",    label: "Other"    },
];

/* Raw status key → display label ("followup" reads badly on a badge) */
function leadStageLabel(key) {
  return (LEAD_STAGES.find(s => s.key === key) || {}).label || key || "";
}

/* Raw status key → full { key, label, accent } record */
function leadStageMeta(key) {
  return LEAD_STAGES.find(s => s.key === key) || { key, label: key, accent: "var(--outline)" };
}
