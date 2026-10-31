"use strict";

const { normalisePart } = require("./visit-counts");
const { orderQuery } = require("../public/js/checkout-choice");

const CANONICAL_ORIGIN = "https://santasaysmyname.com";
const UTM_KEYS = ["utm_source", "utm_campaign", "utm_content"];

function publicOrigin(env, hostHeader) {
  const configured = env && env.PUBLIC_ORIGIN ? String(env.PUBLIC_ORIGIN).trim() : "";
  if (/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?$/.test(configured)) return configured.replace(/\/$/, "");
  const host = String(hostHeader || "").split(",")[0].trim();
  if (/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host)) return `http://${host}`;
  return CANONICAL_ORIGIN;
}

function orderSuccessUrl(origin) {
  return `${String(origin).replace(/\/$/, "")}/order/continue?session_id={CHECKOUT_SESSION_ID}`;
}

function orderCancelUrl(origin, options) {
  const source = options || {};
  const utm = {};
  for (const key of UTM_KEYS) utm[key] = normalisePart(source.utm && source.utm[key]);
  const query = orderQuery({
    packageKey: source.packageKey,
    siblings: source.siblings,
    agreed: true,
    utm,
  });
  return `${String(origin).replace(/\/$/, "")}/?${query}#checkout`;
}

function listData(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (Array.isArray(value.data)) return value.data;
  return [];
}

function priceRef(item) {
  if (!item) return "";
  if (typeof item.price === "string") return item.price;
  if (item.price && typeof item.price.id === "string") return item.price.id;
  return "";
}

function adjustable(item) {
  const adj = item && item.adjustable_quantity;
  if (!adj || adj.enabled !== true) return null;
  const out = { enabled: true };
  if (adj.minimum != null && Number.isFinite(Number(adj.minimum))) out.minimum = Number(adj.minimum);
  if (adj.maximum != null && Number.isFinite(Number(adj.maximum))) out.maximum = Number(adj.maximum);
  return out;
}

function toSessionItem(item, allowZero) {
  const price = priceRef(item);
  if (!price) return null;
  let quantity = Number(item.quantity);
  if (!Number.isFinite(quantity) || quantity < 0) quantity = allowZero ? 0 : 1;
  quantity = Math.floor(quantity);
  if (!allowZero && quantity < 1) quantity = 1;
  const line = { price, quantity };
  const adj = adjustable(item);
  if (adj) line.adjustable_quantity = adj;
  return line;
}

function linkCurrency(link) {
  if (link && link.currency) return String(link.currency).trim().toLowerCase();
  for (const line of listData(link && link.line_items)) {
    if (line.price && line.price.currency) return String(line.price.currency).trim().toLowerCase();
  }
  return "";
}

function sessionMetadata(link, utm) {
  const metadata = {};
  const source = link && link.metadata && typeof link.metadata === "object" ? link.metadata : {};
  const packageName = normalisePart(source.package);
  const sku = normalisePart(source.sku);
  if (packageName) metadata.package = packageName;
  else if (sku) metadata.sku = sku;
  for (const key of UTM_KEYS) {
    const value = normalisePart(utm && utm[key]);
    if (value) metadata[key] = value;
  }
  return metadata;
}

// Copies the Payment Link's existing prices and optional items.
// A non-GBP link is left alone so a draft US checkout is not turned on.
function sessionParamsFromPaymentLink(link, options) {
  const source = options || {};
  if (!link || !Object.prototype.hasOwnProperty.call(link, "line_items")) {
    throw new Error("payment link is missing line items");
  }
  if (!Object.prototype.hasOwnProperty.call(link, "optional_items")) {
    throw new Error("payment link is missing optional items");
  }
  const currency = linkCurrency(link);
  if (currency && currency !== "gbp") return { skip: "not-gbp" };

  const lineItems = listData(link.line_items).map((item) => toSessionItem(item, false)).filter(Boolean);
  if (!lineItems.length) throw new Error("payment link has no prices");
  const optional = listData(link.optional_items).map((item) => toSessionItem(item, true)).filter(Boolean);

  const params = {
    mode: "payment",
    line_items: lineItems,
    success_url: orderSuccessUrl(source.origin),
    cancel_url: orderCancelUrl(source.origin, source),
    metadata: sessionMetadata(link, source.utm),
  };
  if (optional.length) params.optional_items = optional;
  if (link.allow_promotion_codes === true) params.allow_promotion_codes = true;
  if (link.billing_address_collection === "required") params.billing_address_collection = "required";
  if (link.phone_number_collection && link.phone_number_collection.enabled) {
    params.phone_number_collection = { enabled: true };
  }
  if (link.automatic_tax && link.automatic_tax.enabled) params.automatic_tax = { enabled: true };
  if (link.customer_creation === "always") params.customer_creation = "always";
  if (link.submit_type && link.submit_type !== "auto") params.submit_type = link.submit_type;
  return { params };
}

async function findPaymentLinkId(stripe, url) {
  let startingAfter = "";
  for (let page = 0; page < 5; page += 1) {
    const query = { limit: 100, active: true };
    if (startingAfter) query.starting_after = startingAfter;
    const list = await stripe.paymentLinks.list(query);
    const rows = list && Array.isArray(list.data) ? list.data : [];
    const match = rows.find((link) => link && link.url === url);
    if (match) return match.id;
    if (!list || !list.has_more || !rows.length) break;
    startingAfter = rows[rows.length - 1].id;
  }
  throw new Error("payment link was not found");
}

async function createCheckoutSession(options) {
  const source = options || {};
  const stripe = source.stripe;
  const cache = source.cache || new Map();
  const url = source.paymentLinkUrl;
  if (!stripe || !url) throw new Error("checkout session is not configured");

  let link = cache.get(url);
  if (!link) {
    const id = await findPaymentLinkId(stripe, url);
    link = await stripe.paymentLinks.retrieve(id, {
      expand: ["line_items.data.price", "optional_items"],
    });
    cache.set(url, link);
  }

  const built = sessionParamsFromPaymentLink(link, source);
  if (built.skip) return { created: false, skip: built.skip };
  const session = await stripe.checkout.sessions.create(built.params);
  if (!session || !session.url) throw new Error("checkout session has no url");
  return { created: true, url: session.url, id: session.id || "" };
}

module.exports = {
  CANONICAL_ORIGIN,
  publicOrigin,
  orderSuccessUrl,
  orderCancelUrl,
  sessionParamsFromPaymentLink,
  createCheckoutSession,
};
