/* ════════════════════════════════════════════════
   SHARED UTILITIES — loaded by all frontend pages
════════════════════════════════════════════════ */

/* ── HTML escape ── */
function escHtml(s) {
  return String(s||"").replace(/&#x2F;/g,"/").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
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

/* ── Toast notification ── */
function showToast(msg, type = "") {
  const t = document.getElementById("toast");
  if (!t) return;
  t.textContent = msg;
  t.className = "show " + type;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), 3000);
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
  const res = await fetch(url, opts);
  if (res.status === 401) {
    if (typeof window.authOnError === "function") window.authOnError();
    throw new Error("401");
  }
  return res;
}
