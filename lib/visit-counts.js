"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const MAX_BUCKETS = 500;
const MAX_PART = 64;
const UNSAFE = /[^A-Za-z0-9 ._-]+/g;

// Campaign labels only. Anything that looks like an email, or that is not a
// short campaign token, is dropped so the count cannot hold personal data.
function normalisePart(value) {
  if (value == null) return "";
  const raw = String(value).trim();
  if (!raw || raw.includes("@")) return "";
  const cleaned = raw.replace(UNSAFE, "").trim().slice(0, MAX_PART);
  return cleaned;
}

function partsFromUrl(url) {
  const params = url && url.searchParams;
  return {
    utm_source: normalisePart(params ? params.get("utm_source") : ""),
    utm_campaign: normalisePart(params ? params.get("utm_campaign") : ""),
    utm_content: normalisePart(params ? params.get("utm_content") : ""),
  };
}

function bucketKey(parts) {
  return JSON.stringify([parts.utm_source, parts.utm_campaign, parts.utm_content]);
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

function createVisitCounter(options = {}) {
  const filePath = options.filePath || null;
  const buckets = new Map();

  if (filePath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const list = parsed && Array.isArray(parsed.visits) ? parsed.visits : [];
      for (const row of list) {
        if (!row || typeof row !== "object") continue;
        const parts = {
          utm_source: normalisePart(row.utm_source),
          utm_campaign: normalisePart(row.utm_campaign),
          utm_content: normalisePart(row.utm_content),
        };
        const count = Number(row.count);
        if (!Number.isFinite(count) || count <= 0) continue;
        buckets.set(bucketKey(parts), { ...parts, count: Math.min(Math.floor(count), 1e12) });
        if (buckets.size >= MAX_BUCKETS) break;
      }
    } catch {
      // A missing or unreadable file just means we start from zero.
    }
  }

  let chain = Promise.resolve();

  function snapshot() {
    const visits = [...buckets.values()].sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return bucketKey(a).localeCompare(bucketKey(b));
    });
    const total = visits.reduce((sum, row) => sum + row.count, 0);
    return { total, visits };
  }

  function flush() {
    if (!filePath) return Promise.resolve();
    const body = JSON.stringify(snapshot());
    chain = chain.then(() => writeAtomic(filePath, body)).catch(() => {});
    return chain;
  }

  function record(url) {
    const parts = partsFromUrl(url);
    const key = bucketKey(parts);
    const existing = buckets.get(key);
    if (existing) {
      if (existing.count < 1e12) existing.count += 1;
    } else if (buckets.size < MAX_BUCKETS) {
      buckets.set(key, { ...parts, count: 1 });
    } else {
      return parts;
    }
    flush();
    return parts;
  }

  return { record, snapshot, flush };
}

function secretsMatch(given, expected) {
  const a = crypto.createHash("sha256").update(String(given), "utf8").digest();
  const b = crypto.createHash("sha256").update(String(expected), "utf8").digest();
  return crypto.timingSafeEqual(a, b);
}

function presentedSecret(req) {
  const header = req && req.headers ? req.headers.authorization : "";
  if (typeof header === "string") {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
    if (match) return match[1];
  }
  const alt = req && req.headers ? req.headers["x-visits-secret"] : "";
  if (typeof alt === "string" && alt.trim()) return alt.trim();
  return "";
}

module.exports = {
  createVisitCounter,
  secretsMatch,
  presentedSecret,
  normalisePart,
  partsFromUrl,
};
