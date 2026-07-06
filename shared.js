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
