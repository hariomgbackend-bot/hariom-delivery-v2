import { chromium, Browser } from "playwright";
import { logger } from "../utils/logger.js";

const log = logger("rank");

let _browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (!_browserPromise) {
    _browserPromise = chromium
      .launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-blink-features=AutomationControlled",
          "--disable-dev-shm-usage",
        ],
      })
      .catch((e) => {
        _browserPromise = null;
        throw e;
      });
  }
  return _browserPromise;
}

export interface RankCheckResult {
  position: number;
  keyword: string;
  checkedAt: Date;
  competitorsOnPage: string[];
  query: string;
  error?: string;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchName(itemName: string, businessName: string): boolean {
  const a = normalize(itemName);
  const b = normalize(businessName);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) && b.length >= 4) return true;
  return false;
}

/**
 * Check where a business ranks for a keyword on Google Maps.
 * Returns position (1-based) or 0 if not found on the first page.
 */
export async function checkLocalRank(
  keyword: string,
  businessName: string,
  city?: string
): Promise<RankCheckResult> {
  const query = city ? `${keyword} ${city}` : keyword;
  const base: RankCheckResult = {
    position: 0,
    keyword,
    checkedAt: new Date(),
    competitorsOnPage: [],
    query,
  };

  let browser: Browser;
  try {
    browser = await getBrowser();
  } catch (e) {
    const err = (e as Error).message;
    const missing = /Executable doesn't exist|browserType\.launch/i.test(err);
    return {
      ...base,
      error: missing
        ? "Playwright browser not installed. Run: npx playwright install chromium"
        : `Failed to launch browser: ${err}`,
    };
  }

  const context = await browser.newContext({
    userAgent: UA,
    locale: "en-IN",
    viewport: { width: 1366, height: 900 },
  });
  const page = await context.newPage();

  try {
    await page.goto(
      `https://www.google.com/maps/search/${encodeURIComponent(query)}`,
      { waitUntil: "domcontentloaded", timeout: 45000 }
    );

    try {
      await page
        .locator('button:has-text("Accept all"), button:has-text("I agree"), button[aria-label*="Accept"]')
        .first()
        .click({ timeout: 4000 });
    } catch {
      // no consent dialog, ignore
    }

    await page.waitForSelector('[role="feed"], .Nv2PK', { timeout: 20000 });

    await page.waitForTimeout(1500);

    const items = await page.$$(".Nv2PK");
    const names: string[] = [];
    for (const item of items) {
      const nameEl = await item.$(".fontHeadlineSmall");
      if (nameEl) {
        const text = (await nameEl.textContent()) || "";
        names.push(text.trim());
      }
    }

    let position = 0;
    for (let i = 0; i < names.length; i++) {
      if (matchName(names[i], businessName)) {
        position = i + 1;
        break;
      }
    }

    base.position = position;
    base.competitorsOnPage = names.filter(
      (n) => n && !matchName(n, businessName)
    ).slice(0, 20);

    return base;
  } catch (e) {
    base.error = (e as Error).message;
    log.warn(`Rank check failed for "${query}"`, e);
    return base;
  } finally {
    await context.close();
  }
}
