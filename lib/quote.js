"use strict";

const { clampSiblings } = require("../public/js/checkout-choice");
const { normaliseCountry } = require("./funnel-counts");

// Server prices. The browser may say which package and add-ons, never the amount.
const SKU = {
  early: "bundle_early_bird",
  bundle: "bundle",
  single: "single",
  sibling: "addon_sibling",
  rush: "addon_rush",
  sleigh: "addon_sleigh",
};

function parsePoundsToPence(text) {
  const match = /(?:£|\$)?\s*(\d+)(?:\.(\d{1,2}))?/.exec(String(text || "").replace(/,/g, ""));
  if (!match) return null;
  const pounds = Number(match[1]);
  const frac = match[2] ? match[2].padEnd(2, "0") : "00";
  if (!Number.isInteger(pounds) || pounds < 0 || pounds > 100000) return null;
  const pence = Number(frac);
  if (!Number.isInteger(pence) || pence < 0 || pence > 99) return null;
  return pounds * 100 + pence;
}

function formatPence(pence) {
  const amount = Number(pence);
  if (!Number.isInteger(amount) || amount < 0) return "";
  const pounds = Math.floor(amount / 100);
  const rest = String(amount % 100).padStart(2, "0");
  return `${pounds}.${rest}`;
}

function moneyToPence(value) {
  const match = /^(\d+)\.(\d{2})$/.exec(String(value || "").trim());
  if (!match) return null;
  const pounds = Number(match[1]);
  const pence = Number(match[2]);
  if (!Number.isInteger(pounds) || !Number.isInteger(pence)) return null;
  return pounds * 100 + pence;
}

function catalogPrices(prices) {
  const source = prices || {};
  return {
    early: parsePoundsToPence(source.magicBundleEarly),
    bundle: parsePoundsToPence(source.magicBundleFull),
    single: parsePoundsToPence(source.singleVideo),
    sibling: parsePoundsToPence(source.sibling),
    rush: parsePoundsToPence(source.rush),
    sleigh: parsePoundsToPence(source.namedSleigh),
    lateBundle: parsePoundsToPence(source.magicBundleLate),
    lateSingle: parsePoundsToPence(source.singleVideoLate),
  };
}

function unitForSku(sku, pence) {
  if (sku === SKU.early) return pence.early;
  if (sku === SKU.bundle) return pence.bundle;
  if (sku === SKU.single) return pence.single;
  if (sku === SKU.sibling) return pence.sibling;
  if (sku === SKU.rush) return pence.rush;
  if (sku === SKU.sleigh) return pence.sleigh;
  return null;
}

function requireCatalog(pence) {
  for (const key of ["early", "bundle", "single", "sibling", "rush", "sleigh", "lateBundle", "lateSingle"]) {
    if (!Number.isInteger(pence[key])) throw new Error("a product price is not configured");
  }
}

function line(sku, name, quantity, unitPence, packageType) {
  const item = { sku, name, quantity, unitPence };
  if (packageType) item.packageType = packageType;
  return item;
}

function currencyCode(currency) {
  return String(currency || "GBP").trim().toUpperCase() === "USD" ? "USD" : "GBP";
}

function quoteCart({ packageKey, siblings, sleigh, phase, prices, currency }) {
  const code = currencyCode(currency);
  const pence = catalogPrices(prices);
  requireCatalog(pence);
  const key = packageKey === "singleVideo" ? "singleVideo" : "magicBundle";
  const late = phase === "late";
  const early = phase === "early" && !late;
  const count = clampSiblings(siblings);
  const wantSleigh = key === "singleVideo" && (sleigh === true || sleigh === 1 || sleigh === "1");
  const lines = [];

  if (key === "singleVideo") {
    lines.push(line(SKU.single, "Single video", 1, pence.single, "single"));
    if (late) lines.push(line(SKU.rush, "Christmas week price", 1, pence.rush));
    if (wantSleigh) lines.push(line(SKU.sleigh, "Named sleigh video", 1, pence.sleigh));
  } else if (early) {
    lines.push(line(SKU.early, "Magic bundle", 1, pence.early, "bundle_early_bird"));
  } else {
    lines.push(line(SKU.bundle, "Magic bundle", 1, pence.bundle, "bundle"));
    if (late) lines.push(line(SKU.rush, "Christmas week price", 1, pence.rush));
  }

  if (count > 0) lines.push(line(SKU.sibling, "Sibling", count, pence.sibling));

  const totalPence = lines.reduce((sum, item) => sum + item.unitPence * item.quantity, 0);
  if (late) {
    const expected = key === "singleVideo" ? pence.lateSingle : pence.lateBundle;
    const base = lines
      .filter((item) => item.sku !== SKU.sibling && item.sku !== SKU.sleigh)
      .reduce((sum, item) => sum + item.unitPence * item.quantity, 0);
    if (base !== expected) throw new Error("late price does not match the configured total");
  }

  const packageLine = lines.find((item) => item.packageType);
  return {
    packageKey: key,
    packageType: packageLine.packageType,
    siblings: count,
    sleigh: key !== "singleVideo" || wantSleigh,
    rush: late,
    lines,
    totalPence,
    currency: code,
    market: code === "USD" ? "us" : "uk",
  };
}

function quoteFromItems(items, prices, currency) {
  const code = currencyCode(currency);
  const pence = catalogPrices(prices);
  requireCatalog(pence);
  if (!Array.isArray(items) || items.length === 0 || items.length > 6) return null;
  const lines = [];
  let packageType = "";
  for (const item of items) {
    const sku = item && typeof item.sku === "string" ? item.sku : "";
    const expected = unitForSku(sku, pence);
    const quantity = Number(item && item.quantity);
    const unit = moneyToPence(item && item.unit_amount && item.unit_amount.value);
    const itemCurrency = item && item.unit_amount && item.unit_amount.currency_code;
    if (expected == null || unit !== expected) return null;
    if (itemCurrency && String(itemCurrency).toUpperCase() !== code) return null;
    if (sku === SKU.sibling) {
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 4) return null;
    } else if (quantity !== 1) {
      return null;
    }
    const named = {
      [SKU.early]: ["Magic bundle", "bundle_early_bird"],
      [SKU.bundle]: ["Magic bundle", "bundle"],
      [SKU.single]: ["Single video", "single"],
      [SKU.rush]: ["Christmas week price", ""],
      [SKU.sleigh]: ["Named sleigh video", ""],
      [SKU.sibling]: ["Sibling", ""],
    }[sku];
    if (named[1]) {
      if (packageType) return null;
      packageType = named[1];
    }
    lines.push(line(sku, named[0], quantity, expected, named[1] || undefined));
  }
  if (!packageType) return null;
  const rush = lines.some((item) => item.sku === SKU.rush);
  const sleighAddon = lines.some((item) => item.sku === SKU.sleigh);
  if (packageType === "bundle_early_bird" && (rush || sleighAddon)) return null;
  if (packageType === "bundle" && sleighAddon) return null;
  if (rush && packageType !== "bundle" && packageType !== "single") return null;
  const siblings = lines.filter((item) => item.sku === SKU.sibling).reduce((sum, item) => sum + item.quantity, 0);
  if (lines.filter((item) => item.sku === SKU.sibling).length > 1) return null;
  const totalPence = lines.reduce((sum, item) => sum + item.unitPence * item.quantity, 0);
  return {
    packageKey: packageType === "single" ? "singleVideo" : "magicBundle",
    packageType,
    siblings,
    sleigh: packageType !== "single" || sleighAddon,
    rush,
    lines,
    totalPence,
    currency: code,
    market: code === "USD" ? "us" : "uk",
  };
}

function sessionForPaidOrder({ orderId, captureId, quote, email, createdSeconds, utm, country, metadata }) {
  const marks = metadata && typeof metadata === "object" ? metadata : {};
  const campaign = utm && typeof utm === "object" ? utm : {};
  const lineItems = quote.lines.map((item) => {
    const meta = item.packageType ? { package: item.packageType } : { sku: item.sku };
    return {
      description: item.name,
      quantity: item.quantity,
      price: {
        unit_amount: item.unitPence,
        currency: String(quote.currency || "GBP").toLowerCase() === "usd" ? "usd" : "gbp",
        metadata: meta,
        product: { name: item.name, metadata: meta },
      },
    };
  });
  const sessionMeta = { package: quote.packageType };
  for (const key of ["utm_source", "utm_campaign", "utm_content"]) {
    if (campaign[key]) sessionMeta[key] = campaign[key];
  }
  if (country != null && String(country).trim() !== "") sessionMeta.country = normaliseCountry(country);
  if (marks.ssm_funnel) sessionMeta.ssm_funnel = String(marks.ssm_funnel);
  const paidCurrency = String(quote.currency || "GBP").toLowerCase() === "usd" ? "usd" : "gbp";
  const market = quote.market === "us" || paidCurrency === "usd" ? "us" : "uk";
  sessionMeta.ssm_market = market;
  return {
    id: orderId,
    payment_status: "paid",
    amount_total: quote.totalPence,
    currency: paidCurrency,
    created: createdSeconds,
    customer_details: email ? { email } : {},
    metadata: sessionMeta,
    line_items: { data: lineItems },
    payment_intent: captureId ? { id: captureId, metadata: marks.ssm_funnel ? { ssm_funnel: String(marks.ssm_funnel) } : {} } : "",
  };
}

module.exports = {
  SKU,
  parsePoundsToPence,
  formatPence,
  moneyToPence,
  quoteCart,
  quoteFromItems,
  sessionForPaidOrder,
};
