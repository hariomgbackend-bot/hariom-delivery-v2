/**
 * ocr-extract.js
 * -----------------------------------------------------------------------
 * Client-side, non-AI replacement for POST /api/extract-models.
 * Runs entirely in the browser using Tesseract.js. No server round-trip,
 * no API keys, no recurring cost.
 *
 * Usage (from listmaker.html), replacing your old fetch('/api/extract-models'):
 *
 *   const { modelNumbers } = await extractModelsFromImage(file);
 *   // modelNumbers => ["SAMSUNG UA75U8300HULXL", ...]
 *
 * Include Tesseract.js before this file:
 *   <script src="https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js"></script>
 *   <script src="ocr-extract.js"></script>
 *
 * Depends on: window.KNOWN_BRANDS (array) — merge with your shared.js list.
 * If shared.js isn't loaded, a fallback list below is used.
 * -----------------------------------------------------------------------
 */

(function (global) {
  'use strict';

  // -----------------------------------------------------------------------
  // 1. BRAND LIST
  // -----------------------------------------------------------------------
  // Prefer the list already defined in shared.js (window.KNOWN_BRANDS).
  // Paste your real ~30+ brand list there; this is just a safety fallback
  // so the module still works standalone.
  const FALLBACK_BRANDS = [
    'SAMSUNG', 'SONY', 'LG', 'PANASONIC', 'HAIER', 'WHIRLPOOL', 'GODREJ',
    'VOLTAS', 'BLUE STAR', 'DAIKIN', 'HITACHI', 'CARRIER', 'ONIDA',
    'MI', 'XIAOMI', 'REALME', 'ONEPLUS', 'TCL', 'VU', 'THOMSON',
    'KODAK', 'IFFALCON', 'BOSCH', 'SIEMENS', 'IFB', 'AKAI', 'INTEX',
    'MICROMAX', 'BPL', 'SANSUI', 'KELVINATOR', 'LLOYD', 'CROMA', 'HISENSE'
  ];

  function getBrandList() {
    if (Array.isArray(global.KNOWN_BRANDS) && global.KNOWN_BRANDS.length) {
      return global.KNOWN_BRANDS.map(b => String(b).toUpperCase());
    }
    return FALLBACK_BRANDS;
  }

  // -----------------------------------------------------------------------
  // 2. IMAGE PREPROCESSING (grayscale + contrast boost)
  // -----------------------------------------------------------------------
  // Runs on a <canvas> — no server, no extra library needed.
  // Improves Tesseract accuracy on glossy/glare-y sticker photos.
  async function preprocessImage(file, opts = {}) {
    const {
      maxDimension = 1600,   // downscale huge phone photos for speed
      contrastBoost = 1.35,  // >1 increases contrast
      brightness = 10,       // small brightness lift helps dark carton stickers
      threshold = null,      // set e.g. 150 to binarize (optional, can hurt on uneven lighting)
    } = opts;

    const imgBitmap = await loadImageBitmap(file);

    // Downscale to keep OCR fast on mobile
    let { width, height } = imgBitmap;
    if (width > maxDimension || height > maxDimension) {
      const scale = maxDimension / Math.max(width, height);
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(imgBitmap, 0, 0, width, height);

    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;

    for (let i = 0; i < data.length; i += 4) {
      // Grayscale (luminosity method)
      let gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];

      // Brightness
      gray += brightness;

      // Contrast (around midpoint 128)
      gray = (gray - 128) * contrastBoost + 128;

      // Optional binarization
      if (threshold !== null) {
        gray = gray >= threshold ? 255 : 0;
      }

      gray = Math.max(0, Math.min(255, gray));

      data[i] = data[i + 1] = data[i + 2] = gray;
      // alpha (data[i+3]) untouched
    }

    ctx.putImageData(imageData, 0, 0);
    return canvas; // Tesseract.js accepts a canvas directly
  }

  function loadImageBitmap(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = (e) => {
        URL.revokeObjectURL(url);
        reject(e);
      };
      img.src = url;
    });
  }

  // -----------------------------------------------------------------------
  // 3. TESSERACT WORKER (lazily created, reused across calls)
  // -----------------------------------------------------------------------
  let workerPromise = null;

  function getWorker() {
    if (!workerPromise) {
      if (typeof Tesseract === 'undefined') {
        return Promise.reject(new Error(
          'Tesseract.js not found. Include the CDN script before ocr-extract.js.'
        ));
      }
      workerPromise = Tesseract.createWorker('eng', 1, {
        // logger: m => console.log(m), // uncomment for progress debugging
      });
    }
    return workerPromise;
  }

  // Call this once on page load / first "Take Photo" tap to warm up the
  // worker in the background, so the user's first extraction isn't slow.
  async function warmUpOCR() {
    try {
      await getWorker();
    } catch (e) {
      console.warn('OCR warm-up failed:', e.message);
    }
  }

  // -----------------------------------------------------------------------
  // 4. TEXT CLEANING
  // -----------------------------------------------------------------------
  function cleanOcrText(raw) {
    return raw
      .replace(/\r/g, '')
      // common OCR confusions on these labels
      .replace(/[|]/g, 'I')
      .replace(/[“”]/g, '"')
      .replace(/\u00A0/g, ' ')
      .split('\n')
      .map(line => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  }

  // -----------------------------------------------------------------------
  // 5. BRAND DETECTION
  // -----------------------------------------------------------------------
  function detectBrand(lines, fullText, brandList) {
    const upperFull = fullText.toUpperCase();

    // Preferred: "Brand : SONY" / "Brand: SAMSUNG" style line
    const brandLineMatch = fullText.match(/Brand\s*[:\-]?\s*([A-Za-z][A-Za-z\s]{1,20})/i);
    if (brandLineMatch) {
      const candidate = brandLineMatch[1].trim().toUpperCase();
      // Prefer exact known-brand match within the captured text
      const match = brandList.find(b => candidate.startsWith(b) || candidate === b);
      if (match) return match;
      // Even if not in our known list, trust the explicit "Brand:" label,
      // but trim to first word to avoid trailing OCR noise.
      const firstWord = candidate.split(/\s+/)[0];
      if (firstWord.length >= 2) return firstWord;
    }

    // Fallback: standalone known-brand word anywhere in the label
    // (handles Samsung-TV-style stickers with no "Brand:" prefix)
    for (const brand of brandList) {
      const pattern = new RegExp(`\\b${escapeRegex(brand)}\\b`, 'i');
      if (pattern.test(upperFull)) return brand;
    }

    return null;
  }

  function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // -----------------------------------------------------------------------
  // 6. MODEL NUMBER DETECTION
  // -----------------------------------------------------------------------
  function detectModel(fullText) {
    // Priority 1: explicit "Model No: XXX" / "Model No. / Year : XXX / YYYY" / "Model: XXX"
    const labeledMatch = fullText.match(
      /Model\s*(?:No\.?)?\s*(?:\/\s*Year)?\s*[:\-]?\s*([A-Z0-9][A-Z0-9\-\/]{4,25})/i
    );
    if (labeledMatch) {
      let val = labeledMatch[1].toUpperCase();
      // Strip a trailing "/YYYY" year suffix if present (e.g. "RR20H2823RZ/NL/2026")
      const parts = val.split('/');
      if (parts.length > 1 && /^\d{4}$/.test(parts[parts.length - 1])) {
        parts.pop();
        val = parts.join('/');
      }
      if (isPlausibleModel(val)) return val;
    }

    // Priority 2: standalone alphanumeric token, 6-20 chars, mixes letters+digits
    // (catches cases where "Model No:" wasn't OCR'd cleanly)
    const tokens = fullText.match(/\b[A-Z0-9][A-Z0-9\-]{5,19}\b/g) || [];
    const candidates = tokens
      .map(t => t.toUpperCase())
      .filter(isPlausibleModel)
      // de-prioritize pure numbers (likely QR/serial noise, dates, etc.)
      .filter(t => /[A-Z]/.test(t));

    if (candidates.length) {
      // Prefer the longest plausible candidate — model numbers tend to be
      // the longest structured alphanumeric string on the label.
      candidates.sort((a, b) => b.length - a.length);
      return candidates[0];
    }

    return null;
  }

  function isPlausibleModel(str) {
    if (!str) return false;
    if (str.length < 6 || str.length > 20) return false;
    // must contain at least one digit (model numbers on these labels always do)
    if (!/\d/.test(str)) return false;
    // reject obvious non-models
    const REJECT = /^(UNITS|GOVERNMENT|ELECTRICITY|CONSUMPTION|BUREAU|EFFICIENCY|WARRANTY|INVERTER)/i;
    if (REJECT.test(str)) return false;
    return true;
  }

  // -----------------------------------------------------------------------
  // 7. MAIN ENTRY POINT
  // -----------------------------------------------------------------------
  /**
   * Extract "BRAND MODEL" strings from a single image file.
   * Mirrors the old API's per-image behavior; call once per captured photo.
   *
   * @param {File|Blob} file - image file from <input type="file" capture="camera">
   * @param {object} [opts] - passed through to preprocessImage()
   * @returns {Promise<{ modelNumbers: string[], rawText: string, brand: string|null, model: string|null }>}
   */
  async function extractModelsFromImage(file, opts = {}) {
    let rawText = '';
    try {
      const canvas = await preprocessImage(file, opts);
      const worker = await getWorker();
      const { data } = await worker.recognize(canvas);
      rawText = data.text || '';
    } catch (err) {
      console.error('OCR extraction failed:', err);
      // Graceful fallback: return empty result, UI falls back to manual entry
      return { modelNumbers: [], rawText: '', brand: null, model: null, error: err.message };
    }

    const lines = cleanOcrText(rawText);
    const fullText = lines.join('\n');
    const brandList = getBrandList();

    const brand = detectBrand(lines, fullText, brandList);
    const model = detectModel(fullText);

    const modelNumbers = [];
    if (brand && model) {
      modelNumbers.push(`${brand} ${model}`);
    } else if (model) {
      // Model found but brand unclear — still useful, staff can edit brand manually
      modelNumbers.push(model);
    } else if (brand) {
      modelNumbers.push(brand);
    }
    // If neither found, modelNumbers stays [] — UI should fall back to manual entry.

    return { modelNumbers, rawText: fullText, brand, model };
  }

  /**
   * Batch version — matches the old API's ability to handle multiple images
   * in one call if your UI ever queues several photos at once.
   */
  async function extractModelsFromImages(files, opts = {}) {
    const results = [];
    for (const file of files) {
      const r = await extractModelsFromImage(file, opts);
      results.push(...r.modelNumbers);
    }
    return { modelNumbers: results };
  }

  // Call this when the page unloads or the tool is done, to free memory.
  async function terminateOCR() {
    if (workerPromise) {
      const worker = await workerPromise;
      await worker.terminate();
      workerPromise = null;
    }
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------
  global.extractModelsFromImage = extractModelsFromImage;
  global.extractModelsFromImages = extractModelsFromImages;
  global.warmUpOCR = warmUpOCR;
  global.terminateOCR = terminateOCR;

})(window);
