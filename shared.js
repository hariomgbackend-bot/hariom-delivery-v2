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
