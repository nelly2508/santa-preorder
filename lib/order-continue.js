"use strict";

const TALLY_ORDER_FORM = "https://tally.so/r/Dq25LE";

const PACKAGES = new Set(["bundle_early_bird", "bundle", "single"]);

function selectSecretKey(sessionId, env) {
  const source = env || {};
  if (String(sessionId).startsWith("cs_test_")) {
    return source.STRIPE_TEST_SECRET_KEY || source.STRIPE_SECRET_KEY || "";
  }
  return source.STRIPE_SECRET_KEY || "";
}

function fallbackLocation(sessionId) {
  const url = new URL(TALLY_ORDER_FORM);
  if (sessionId) url.searchParams.set("order", sessionId);
  return url.toString();
}

function buyerEmail(session) {
  const details = session && session.customer_details;
  if (!details || typeof details.email !== "string") return "";
  return details.email.trim();
}

function successLocation(sessionId, summary, email) {
  const url = new URL(TALLY_ORDER_FORM);
  url.searchParams.set("order", sessionId);
  url.searchParams.set("children", String(summary.children));
  url.searchParams.set("rush", summary.rush ? "1" : "0");
  url.searchParams.set("sleigh", summary.sleigh ? "1" : "0");
  if (summary.packageType) url.searchParams.set("package", summary.packageType);
  if (email) url.searchParams.set("email", email);
  return url.toString();
}

function normalisePackage(value) {
  const raw = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (raw === "bundle_early_bird" || raw === "early_bird" || raw === "magic_bundle_early_bird") {
    return "bundle_early_bird";
  }
  if (raw === "bundle" || raw === "magic_bundle") return "bundle";
  if (raw === "single" || raw === "single_video") return "single";
  return "";
}

function metadataValues(object) {
  const metadata = object && object.metadata;
  if (!metadata || typeof metadata !== "object") return [];
  return [metadata.sku, metadata.package].filter((value) => value != null && value !== "").map((value) => String(value).trim().toLowerCase());
}

function lineFacts(line) {
  const price = line && line.price && typeof line.price === "object" ? line.price : {};
  const product = price.product && typeof price.product === "object" ? price.product : {};
  const name = [line && line.description, price.nickname, product.name].filter(Boolean).join(" ").toLowerCase();
  return {
    price,
    skus: metadataValues(price).concat(metadataValues(product)),
    name,
  };
}

function packageFromLine(facts) {
  for (const value of facts.skus) {
    const normalised = normalisePackage(value);
    if (PACKAGES.has(normalised)) return normalised;
  }
  if (/early[\s_-]?bird/.test(facts.name)) return "bundle_early_bird";
  if (/\bbundle\b/.test(facts.name)) return "bundle";
  if (/\bsingle\b/.test(facts.name)) return "single";
  const amount = facts.price.unit_amount;
  const currency = String(facts.price.currency || "gbp").toLowerCase();
  if (currency === "gbp") {
    if (amount === 1699) return "bundle_early_bird";
    if (amount === 1999) return "bundle";
    if (amount === 1499) return "single";
  }
  return "";
}

function addonFromLine(facts) {
  const skus = new Set(facts.skus);
  if (skus.has("addon_sibling") || /\bsibling\b/.test(facts.name)) return "sibling";
  if (skus.has("addon_rush") || /\brush\b/.test(facts.name)) return "rush";
  if (skus.has("addon_sleigh") || skus.has("addon_named_sleigh") || /\bsleigh\b/.test(facts.name)) return "sleigh";
  return "";
}

function quantityOf(line) {
  if (!line || line.quantity == null || line.quantity === "") return 1;
  const quantity = Number(line.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) return 0;
  return Math.floor(quantity);
}

function summariseCheckout(session) {
  const lines = session && session.line_items && session.line_items.data;
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new Error("checkout session has no line items");
  }

  let siblingQuantity = 0;
  let rush = false;
  let sleighAddon = false;
  let packageType = normalisePackage(session.metadata && (session.metadata.package || session.metadata.sku));

  for (const line of lines) {
    const facts = lineFacts(line);
    const addon = addonFromLine(facts);
    const quantity = quantityOf(line);
    if (addon === "sibling") {
      siblingQuantity += quantity;
      continue;
    }
    if (addon === "rush") {
      if (quantity > 0) rush = true;
      continue;
    }
    if (addon === "sleigh") {
      if (quantity > 0) sleighAddon = true;
      continue;
    }
    if (!packageType) packageType = packageFromLine(facts);
  }

  const bundle = packageType === "bundle" || packageType === "bundle_early_bird";
  return {
    children: 1 + siblingQuantity,
    rush,
    sleigh: sleighAddon || bundle,
    packageType,
  };
}

function isExpandPermissionError(error) {
  if (!error) return false;
  const message = String(error.message || "");
  return error.statusCode === 403 || error.code === "more_permissions_required" || /permission/i.test(message);
}

function stripeClient(key, cache) {
  if (!cache.has(key)) {
    const Stripe = require("stripe");
    cache.set(key, new Stripe(key));
  }
  return cache.get(key);
}

function defaultRetrieve(sessionId, key, cache) {
  const client = stripeClient(key, cache);
  const full = { expand: ["line_items.data.price.product"] };
  return client.checkout.sessions.retrieve(sessionId, full).catch((error) => {
    if (!isExpandPermissionError(error)) throw error;
    return client.checkout.sessions.retrieve(sessionId, { expand: ["line_items"] });
  });
}

function purchaseFromSession(session) {
  if (!session || session.payment_status !== "paid") return null;
  if (session.amount_total == null || session.amount_total === "") return null;
  const amount = Number(session.amount_total);
  if (!Number.isFinite(amount) || amount < 0) return null;
  const rawCurrency = session.currency == null || session.currency === "" ? "gbp" : session.currency;
  const currency = String(rawCurrency).trim().toLowerCase();
  if (currency !== "gbp") return null;
  return { value: Math.round(amount) / 100, currency: "GBP" };
}

const stripeClients = new Map();

async function describeOrder({ sessionId, env, retrieveSession, log }) {
  const write = typeof log === "function" ? log : () => {};
  const report = (error) => {
    const message = error && error.message ? error.message : String(error);
    write(`order/continue ${sessionId || "(missing session)"}: ${message}`);
  };

  if (!/^cs_(live|test)_[A-Za-z0-9]+$/.test(sessionId || "")) {
    report(new Error("invalid session id"));
    return { location: fallbackLocation(""), purchase: null };
  }

  const key = selectSecretKey(sessionId, env);
  if (!key) {
    report(new Error("missing Stripe secret key"));
    return { location: fallbackLocation(sessionId), purchase: null };
  }

  try {
    const retrieve = retrieveSession || ((id, secret) => defaultRetrieve(id, secret, stripeClients));
    const session = await retrieve(sessionId, key);
    if (!session || session.payment_status !== "paid") {
      report(new Error(`session is not paid (${session && session.payment_status ? session.payment_status : "missing"})`));
      return { location: fallbackLocation(sessionId), purchase: null };
    }
    const purchase = purchaseFromSession(session);
    try {
      return {
        location: successLocation(sessionId, summariseCheckout(session), buyerEmail(session)),
        purchase,
      };
    } catch (error) {
      report(error);
      return { location: fallbackLocation(sessionId), purchase };
    }
  } catch (error) {
    report(error);
    return { location: fallbackLocation(sessionId), purchase: null };
  }
}

async function resolveOrderRedirect(options) {
  const described = await describeOrder(options || {});
  return described.location;
}

resolveOrderRedirect.clients = stripeClients;

module.exports = {
  TALLY_ORDER_FORM,
  selectSecretKey,
  summariseCheckout,
  purchaseFromSession,
  describeOrder,
  resolveOrderRedirect,
  fallbackLocation,
  successLocation,
};
