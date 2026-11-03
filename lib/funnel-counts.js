"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { normalisePart } = require("./visit-counts");

const MAX_BUCKETS = 500;
const MAX_SEEN = 5000;
const EVENTS = ["view", "order_tap", "checkout_start", "checkout_complete"];
const UTM_KEYS = ["utm_source", "utm_campaign", "utm_content"];
const UNKNOWN_COUNTRY = "XX";
const UK_COUNTRY = "GB";

function emptyCounts() {
  return { view: 0, order_tap: 0, checkout_start: 0, checkout_complete: 0 };
}

function addCounts(target, row) {
  for (const event of EVENTS) target[event] += row[event];
}

// A two-letter code, or XX when the country was not known. Rows saved before
// country was recorded have no code and land here too.
function normaliseCountry(value) {
  const code = String(value == null ? "" : value).trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(code)) return code;
  return UNKNOWN_COUNTRY;
}

function partsFromFields(source) {
  const input = source || {};
  const parts = {};
  for (const key of UTM_KEYS) parts[key] = normalisePart(input[key]);
  parts.country = normaliseCountry(input.country);
  return parts;
}

function marketOf(source) {
  return String((source && source.market) || "").trim().toLowerCase() === "us" ? "us" : "uk";
}

function bucketKey(parts) {
  return JSON.stringify([
    ...UTM_KEYS.map((key) => parts[key] || ""),
    parts.country || UNKNOWN_COUNTRY,
    marketOf(parts),
  ]);
}

function writeAtomic(filePath, body) {
  return new Promise((resolve) => {
    fs.mkdir(path.dirname(filePath), { recursive: true }, (mkdirErr) => {
      if (mkdirErr) {
        resolve();
        return;
      }
      const tmp = `${filePath}.${process.pid}.tmp`;
      fs.writeFile(tmp, body, (writeErr) => {
        if (writeErr) {
          resolve();
          return;
        }
        fs.rename(tmp, filePath, () => resolve());
      });
    });
  });
}

function createFunnelCounter(options = {}) {
  const filePath = options.filePath || null;
  const buckets = new Map();
  const seen = new Set();
  const seenOrder = [];

  if (filePath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const list = parsed && Array.isArray(parsed.buckets) ? parsed.buckets : [];
      for (const row of list) {
        if (!row || typeof row !== "object") continue;
        const parts = { ...partsFromFields(row), market: marketOf(row) };
        const counts = emptyCounts();
        for (const event of EVENTS) {
          const count = Number(row[event]);
          if (!Number.isFinite(count) || count <= 0) continue;
          counts[event] = Math.min(Math.floor(count), 1e12);
        }
        const total = EVENTS.reduce((sum, event) => sum + counts[event], 0);
        if (total <= 0) continue;
        buckets.set(bucketKey(parts), { ...parts, ...counts });
        if (buckets.size >= MAX_BUCKETS) break;
      }
      const completed = parsed && Array.isArray(parsed.completed) ? parsed.completed : [];
      for (const hash of completed) {
        if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) continue;
        if (seen.has(hash)) continue;
        seen.add(hash);
        seenOrder.push(hash);
        if (seenOrder.length > MAX_SEEN) seen.delete(seenOrder.shift());
      }
    } catch {
      // A missing or unreadable file just means we start from zero.
    }
  }

  let chain = Promise.resolve();

  function snapshot() {
    const bucketsOut = [...buckets.values()].sort((a, b) => {
      const aTotal = EVENTS.reduce((sum, event) => sum + a[event], 0);
      const bTotal = EVENTS.reduce((sum, event) => sum + b[event], 0);
      if (bTotal !== aTotal) return bTotal - aTotal;
      return bucketKey(a).localeCompare(bucketKey(b));
    });
    const total = emptyCounts();
    const totalUk = emptyCounts();
    const markets = { uk: emptyCounts(), us: emptyCounts() };
    const byCountry = new Map();
    for (const row of bucketsOut) {
      addCounts(total, row);
      if (row.country === UK_COUNTRY) addCounts(totalUk, row);
      addCounts(markets[marketOf(row)], row);
      let rollup = byCountry.get(row.country);
      if (!rollup) {
        rollup = { country: row.country, ...emptyCounts() };
        byCountry.set(row.country, rollup);
      }
      addCounts(rollup, row);
    }
    const countries = [...byCountry.values()].sort((a, b) => {
      const aTotal = EVENTS.reduce((sum, event) => sum + a[event], 0);
      const bTotal = EVENTS.reduce((sum, event) => sum + b[event], 0);
      if (bTotal !== aTotal) return bTotal - aTotal;
      return a.country.localeCompare(b.country);
    });
    return { total, total_uk: totalUk, countries, markets, buckets: bucketsOut };
  }

  function persistBody() {
    // Hashes only. The admin report does not include them, and the file
    // still has no order id, IP address, or email.
    return { ...snapshot(), completed: seenOrder.slice() };
  }

  function flush() {
    if (!filePath) return Promise.resolve();
    const body = JSON.stringify(persistBody());
    chain = chain.then(() => writeAtomic(filePath, body)).catch(() => {});
    return chain;
  }

  function record(event, parts) {
    if (!EVENTS.includes(event)) return null;
    const clean = { ...partsFromFields(parts), market: marketOf(parts) };
    const key = bucketKey(clean);
    let row = buckets.get(key);
    if (!row) {
      if (buckets.size >= MAX_BUCKETS) return clean;
      row = { ...clean, ...emptyCounts() };
      buckets.set(key, row);
    }
    if (row[event] < 1e12) row[event] += 1;
    flush();
    return clean;
  }

  // In-memory only. The file stores campaign totals and country codes, never session ids or IP addresses.
  function claimCompletion(sessionId) {
    const id = String(sessionId || "");
    if (!/^cs_(live|test)_[A-Za-z0-9]+$/.test(id) && !/^[A-Z0-9]{17}$/.test(id)) return false;
    const key = crypto.createHash("sha256").update(String(sessionId), "utf8").digest("hex");
    if (seen.has(key)) return false;
    seen.add(key);
    seenOrder.push(key);
    if (seenOrder.length > MAX_SEEN) seen.delete(seenOrder.shift());
    return true;
  }

  return { record, snapshot, flush, claimCompletion };
}

function funnelFromSession(session) {
  if (!session || session.payment_status !== "paid") return null;
  const currency = String(session.currency || "gbp").trim().toLowerCase();
  const metadata = session.metadata && typeof session.metadata === "object" ? session.metadata : {};
  const marketMeta = String(metadata.ssm_market || "").trim().toLowerCase();
  // Pounds count as before, including the country saved at checkout start.
  // Dollars count only for a PayPal order this server marked as the US page.
  // A Stripe session in USD is still ignored.
  let market = "";
  if (currency === "gbp") market = "uk";
  else if (currency === "usd" && marketMeta === "us") market = "us";
  else return null;
  const paymentIntent = session.payment_intent && typeof session.payment_intent === "object" ? session.payment_intent : {};
  const intentMeta = paymentIntent.metadata && typeof paymentIntent.metadata === "object" ? paymentIntent.metadata : {};
  return {
    ...partsFromFields(metadata),
    market,
    alreadyCounted: String(metadata.ssm_funnel || intentMeta.ssm_funnel || "") === "1",
    paymentIntentId: typeof session.payment_intent === "string"
      ? session.payment_intent
      : (paymentIntent.id || ""),
  };
}

module.exports = {
  EVENTS,
  UNKNOWN_COUNTRY,
  UK_COUNTRY,
  createFunnelCounter,
  funnelFromSession,
  marketOf,
  normaliseCountry,
  partsFromFields,
};
