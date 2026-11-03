"use strict";

const { funnelFromSession, normaliseCountry, partsFromFields } = require("./funnel-counts");
const { quoteCart, quoteFromItems, sessionForPaidOrder, formatPence, moneyToPence } = require("./quote");
const { isPaypalOrderId } = require("./paypal-orders");
const { summariseCheckout, purchaseFromSession, fallbackLocation, successLocation } = require("./order-continue");
const { deliverPaidOrderEmails } = require("./order-email");

const LIVE = "https://api-m.paypal.com";
const SANDBOX = "https://api-m.sandbox.paypal.com";

const FRIENDLY = "Pay with PayPal or card is not available just now. Please email hello@santasaysmyname.com and we will help you order.";
const PAYMENT_FAILED = "The payment did not complete. Please try again, or email hello@santasaysmyname.com.";
const MISMATCH = "We could not confirm that payment. If money left your account, email hello@santasaysmyname.com and we will sort it out.";

function paymentProvider(env) {
  const raw = String((env && env.PAYMENT_PROVIDER) || "").trim().toLowerCase();
  return raw === "stripe" ? "stripe" : "paypal";
}

function paypalEnv(env) {
  const source = env || {};
  const clientId = String(source.PAYPAL_CLIENT_ID || "").trim();
  const secret = String(source.PAYPAL_CLIENT_SECRET || "").trim();
  const mode = String(source.PAYPAL_ENV || "").trim().toLowerCase();
  if (!clientId || !secret || (mode !== "sandbox" && mode !== "live")) return { ok: false };
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(clientId)) return { ok: false };
  return {
    ok: true,
    clientId,
    secret,
    mode,
    base: mode === "live" ? LIVE : SANDBOX,
    webhookId: String(source.PAYPAL_WEBHOOK_ID || "").trim(),
  };
}

function redact(message, env) {
  let text = String(message || "");
  const source = env || {};
  for (const secret of [source.PAYPAL_CLIENT_SECRET, source.PAYPAL_CLIENT_ID, source.PAYPAL_WEBHOOK_ID, source.SMTP_PASS, source.BREVO_API_KEY]) {
    if (secret) text = text.split(String(secret)).join("[redacted]");
  }
  return text.replace(/\s+/g, " ").slice(0, 300);
}

function logSafe(log, env, message) {
  if (typeof log === "function") log(redact(message, env));
}

function clipUtm(value) {
  return String(value || "").slice(0, 24);
}

function customId(quote, utm) {
  const code = quote.packageType === "bundle_early_bird" ? "e" : quote.packageType === "single" ? "s" : "b";
  const campaign = utm || {};
  const full = [
    "v1",
    code,
    String(quote.siblings),
    quote.lines.some((item) => item.sku === "addon_sleigh") ? "1" : "0",
    quote.rush ? "1" : "0",
    clipUtm(campaign.utm_source),
    clipUtm(campaign.utm_campaign),
    clipUtm(campaign.utm_content),
  ].join("|");
  if (full.length <= 127) return full;
  return full.split("|").slice(0, 5).join("|");
}

function paypalItems(quote) {
  const code = quote && quote.currency === "USD" ? "USD" : "GBP";
  return quote.lines.map((item) => ({
    name: item.name,
    sku: item.sku,
    quantity: String(item.quantity),
    category: "DIGITAL_GOODS",
    unit_amount: { currency_code: code, value: formatPence(item.unitPence) },
  }));
}

function orderBody(quote, utm) {
  const value = formatPence(quote.totalPence);
  const code = quote && quote.currency === "USD" ? "USD" : "GBP";
  return {
    intent: "CAPTURE",
    purchase_units: [{
      custom_id: customId(quote, utm),
      description: "Santa Says My Name",
      amount: {
        currency_code: code,
        value,
        breakdown: { item_total: { currency_code: code, value } },
      },
      items: paypalItems(quote),
    }],
    application_context: {
      brand_name: "Santa Says My Name",
      shipping_preference: "NO_SHIPPING",
      user_action: "PAY_NOW",
      landing_page: "NO_PREFERENCE",
    },
  };
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function accessToken(config, fetchImpl, cache) {
  const key = `${config.mode}:${config.clientId}`;
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.token;
  let response;
  try {
    response = await fetchImpl(`${config.base}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.secret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error("paypal request failed");
  }
  const parsed = await readJson(response);
  if (!response.ok || !parsed || typeof parsed.access_token !== "string" || !parsed.access_token) {
    throw new Error(`paypal request failed (${response.status})`);
  }
  const expires = Number(parsed.expires_in);
  const seconds = Number.isFinite(expires) && expires > 120 ? expires - 60 : 120;
  cache.set(key, { token: parsed.access_token, until: Date.now() + seconds * 1000 });
  return parsed.access_token;
}

async function paypalRequest(config, fetchImpl, cache, path, options) {
  const token = await accessToken(config, fetchImpl, cache);
  const source = options || {};
  let response;
  try {
    response = await fetchImpl(`${config.base}${path}`, {
      method: source.method || "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(source.headers || {}),
      },
      body: source.body == null ? undefined : source.body,
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error("paypal request failed");
  }
  const parsed = await readJson(response);
  if (!response.ok) {
    const issue = parsed && Array.isArray(parsed.details) && parsed.details[0] && parsed.details[0].issue;
    const error = new Error(`paypal request failed (${response.status})`);
    error.status = response.status;
    error.issue = issue || (parsed && parsed.name) || "";
    throw error;
  }
  return parsed;
}

function orderIdFromPaypalResource(resource) {
  const source = resource && typeof resource === "object" ? resource : {};
  const related = source.supplementary_data && source.supplementary_data.related_ids;
  const relatedId = related && (related.order_id || related.orderId);
  if (isPaypalOrderId(relatedId)) return String(relatedId);
  const links = Array.isArray(source.links) ? source.links : [];
  for (const link of links) {
    const href = String(link && link.href || "");
    const match = /\/v2\/checkout\/orders\/([A-Z0-9]{17})(?:[/?#]|$)/.exec(href);
    if (match && isPaypalOrderId(match[1])) return match[1];
  }
  return "";
}

function payerActionUrl(order) {
  const links = order && Array.isArray(order.links) ? order.links : [];
  const link = links.find((item) => item && (item.rel === "payer-action" || item.rel === "payer_action"));
  const href = String(link && link.href || "");
  try {
    const url = new URL(href);
    if (url.protocol !== "https:") return "";
    const host = url.hostname.toLowerCase();
    if (host !== "paypal.com" && !host.endsWith(".paypal.com")) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function captureOf(order) {
  const unit = order && Array.isArray(order.purchase_units) ? order.purchase_units[0] : null;
  const captures = unit && unit.payments && Array.isArray(unit.payments.captures) ? unit.payments.captures : [];
  const capture = captures.find((item) => item && item.status === "COMPLETED") || null;
  return { unit, capture };
}

function buyerEmail(order) {
  const payer = order && order.payer;
  if (payer && typeof payer.email_address === "string") return payer.email_address.trim();
  const source = order && order.payment_source && order.payment_source.paypal;
  if (source && typeof source.email_address === "string") return source.email_address.trim();
  return "";
}

function paidAmount(order) {
  const { capture } = captureOf(order);
  if (capture && capture.amount) return { amount: capture.amount, captureId: typeof capture.id === "string" ? capture.id : "" };
  // Card and 3DS responses sometimes mark the order COMPLETED and put the
  // amount on the purchase unit without a payments.captures entry.
  if (!order || order.status !== "COMPLETED") return null;
  const unit = Array.isArray(order.purchase_units) ? order.purchase_units[0] : null;
  if (!unit || !unit.amount) return null;
  return { amount: unit.amount, captureId: "" };
}

async function confirmCaptured({ order, store, prices, usdPrices, orderId }) {
  if (!order || !isPaypalOrderId(orderId)) return { ok: false, reason: "missing" };
  const paidSource = paidAmount(order);
  if (!paidSource) return { ok: false, reason: "not-completed" };
  const currency = String(paidSource.amount.currency_code || "").toUpperCase();
  const paid = moneyToPence(paidSource.amount.value);
  if ((currency !== "GBP" && currency !== "USD") || paid == null) return { ok: false, reason: "amount" };
  const book = currency === "USD" ? usdPrices : prices;
  const { unit } = captureOf(order);
  const fromItems = book && unit && Array.isArray(unit.items) ? quoteFromItems(unit.items, book, currency) : null;
  const existing = await store.get(orderId);
  const stored = existing && existing.quote;
  if (stored && String(stored.currency || "GBP").toUpperCase() !== currency) return { ok: false, reason: "amount" };
  if (stored && stored.totalPence !== paid) return { ok: false, reason: "amount" };
  if (fromItems && fromItems.totalPence !== paid) return { ok: false, reason: "amount" };
  if (stored && fromItems && fromItems.totalPence !== stored.totalPence) return { ok: false, reason: "amount" };
  const quote = stored || fromItems;
  if (!quote) return { ok: false, reason: "amount" };
  const email = buyerEmail(order);
  const createdMs = existing && existing.createdMs ? existing.createdMs : Date.now();
  const saved = {
    ...(existing || {}),
    id: orderId,
    status: "COMPLETED",
    captureId: paidSource.captureId || (existing && existing.captureId) || "",
    quote,
    utm: (existing && existing.utm) || {},
    country: normaliseCountry(existing && existing.country),
    email: email || (existing && existing.email) || "",
    createdMs,
    metadata: (existing && existing.metadata) || {},
  };
  await store.save(orderId, saved);
  return { ok: true, row: saved };
}

function waitAtMost(promise, ms) {
  if (ms == null || ms < 0) return promise;
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === "function") timer.unref();
    promise.finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function fulfilStoredOrder(deps) {
  const source = deps || {};
  const orderId = source.orderId;
  const env = source.env || {};
  const log = source.log;
  const store = source.store;
  if (!isPaypalOrderId(orderId) || !store) {
    return { location: fallbackLocation(""), purchase: null, funnel: null };
  }

  let row = await store.get(orderId);
  if (!row || row.status !== "COMPLETED" || !row.quote) {
    const config = paypalEnv(env);
    if (config.ok && typeof source.fetchImpl === "function") {
      try {
        const remote = await paypalRequest(config, source.fetchImpl, source.cache, `/v2/checkout/orders/${orderId}`, { method: "GET" });
        const confirmed = await confirmCaptured({
          order: remote,
          store,
          prices: source.prices,
          usdPrices: source.usdPrices,
          orderId,
        });
        if (confirmed.ok) row = confirmed.row;
      } catch (error) {
        logSafe(log, env, `paypal order ${orderId}: ${error && error.message ? error.message : "lookup failed"}`);
      }
    }
  }

  if (!row || row.status !== "COMPLETED" || !row.quote) {
    return { location: fallbackLocation(orderId), purchase: null, funnel: null };
  }

  const createdSeconds = Math.floor(Number(row.createdMs || Date.now()) / 1000);
  const session = sessionForPaidOrder({
    orderId,
    captureId: row.captureId,
    quote: row.quote,
    email: row.email,
    createdSeconds,
    utm: row.utm,
    country: row.country,
    metadata: row.metadata,
  });
  const purchase = purchaseFromSession(session);
  const funnel = funnelFromSession(session);
  let summary = null;
  let location = fallbackLocation(orderId);
  try {
    summary = summariseCheckout(session);
    location = successLocation(orderId, summary, row.email || "");
  } catch (error) {
    logSafe(log, env, `paypal order ${orderId}: ${error && error.message ? error.message : "summary failed"}`);
  }

  const meta = store.metadataApi(orderId);
  const emailPromise = deliverPaidOrderEmails({
    session,
    sessionId: orderId,
    summary,
    env,
    log: (message) => logSafe(log, env, message),
    sendMail: source.sendMail,
    readMetadata: meta.read,
    writeMetadata: meta.write,
    claimId: source.claimId,
    now: source.now,
    claimTtlMs: source.claimTtlMs,
    flights: source.flights,
  }).catch((error) => {
    logSafe(log, env, `paypal order ${orderId}: ${error && error.message ? error.message : "email failed"}`);
  });
  await waitAtMost(emailPromise, source.emailWaitMs == null ? 8000 : source.emailWaitMs);
  const fresh = await store.get(orderId);
  const refreshed = sessionForPaidOrder({
    orderId,
    captureId: row.captureId,
    quote: row.quote,
    email: row.email,
    createdSeconds,
    utm: row.utm,
    country: row.country,
    metadata: (fresh && fresh.metadata) || row.metadata,
  });
  return { location, purchase, funnel: funnelFromSession(refreshed) || funnel };
}

async function createPaypalOrder(deps) {
  const source = deps || {};
  const env = source.env || {};
  const config = paypalEnv(env);
  if (!config.ok || typeof source.fetchImpl !== "function") {
    return { status: 503, body: { error: FRIENDLY } };
  }
  if (source.open === false) {
    return { status: 403, body: { error: source.closedMessage || "Orders are closed." } };
  }
  let body = source.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { status: 400, body: { error: "Choose a video, then try again." } };
  }
  const market = body.market === "us" ? "us" : "uk";
  const book = market === "us" ? source.usdPrices : source.prices;
  if (!book) {
    logSafe(source.log, env, "paypal create: price list is not configured");
    return { status: 503, body: { error: FRIENDLY } };
  }
  let quote;
  try {
    quote = quoteCart({
      packageKey: body.package,
      siblings: body.siblings,
      sleigh: body.sleigh,
      phase: source.phase,
      prices: book,
      currency: market === "us" ? "USD" : "GBP",
    });
  } catch (error) {
    logSafe(source.log, env, `paypal create: ${error && error.message ? error.message : "price failed"}`);
    return { status: 503, body: { error: FRIENDLY } };
  }
  const parsed = partsFromFields(body);
  const utm = {
    utm_source: parsed.utm_source,
    utm_campaign: parsed.utm_campaign,
    utm_content: parsed.utm_content,
  };
  const country = normaliseCountry(source.country);
  let created;
  try {
    created = await paypalRequest(config, source.fetchImpl, source.cache, "/v2/checkout/orders", {
      method: "POST",
      headers: { "PayPal-Request-Id": `ssm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}` },
      body: JSON.stringify(orderBody(quote, utm)),
    });
  } catch (error) {
    logSafe(source.log, env, `paypal create: ${error && error.message ? error.message : "create failed"}`);
    return { status: 502, body: { error: PAYMENT_FAILED } };
  }
  const orderId = created && created.id;
  if (!isPaypalOrderId(orderId)) {
    logSafe(source.log, env, "paypal create: order id was not accepted");
    return { status: 502, body: { error: PAYMENT_FAILED } };
  }
  await source.store.save(orderId, {
    id: orderId,
    status: "CREATED",
    captureId: "",
    quote,
    utm,
    country,
    email: "",
    createdMs: source.nowMs || Date.now(),
    metadata: {},
  });
  return {
    status: 201,
    body: { id: orderId },
    utm: { ...utm, market: quote.market || market },
    country,
  };
}

async function capturePaypalOrder(deps) {
  const source = deps || {};
  const env = source.env || {};
  const orderId = source.orderId;
  const config = paypalEnv(env);
  if (!config.ok || typeof source.fetchImpl !== "function") {
    return { status: 503, body: { error: FRIENDLY } };
  }
  if (!isPaypalOrderId(orderId)) {
    return { status: 400, body: { error: PAYMENT_FAILED } };
  }
  const existing = source.store ? await source.store.get(orderId) : null;
  if (existing && existing.status === "COMPLETED" && existing.quote) {
    const result = await fulfilStoredOrder(source);
    return {
      status: 200,
      body: { id: orderId, continueUrl: `/order/continue?session_id=${orderId}` },
      result,
    };
  }
  let order;
  try {
    order = await paypalRequest(config, source.fetchImpl, source.cache, `/v2/checkout/orders/${orderId}/capture`, {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: "{}",
    });
  } catch (error) {
    if (error && error.issue === "ORDER_ALREADY_CAPTURED") {
      try {
        order = await paypalRequest(config, source.fetchImpl, source.cache, `/v2/checkout/orders/${orderId}`, { method: "GET" });
      } catch (lookupError) {
        logSafe(source.log, env, `paypal capture ${orderId}: ${lookupError && lookupError.message ? lookupError.message : "lookup failed"}`);
        return { status: 502, body: { error: PAYMENT_FAILED } };
      }
    } else {
      logSafe(source.log, env, `paypal capture ${orderId}: ${error && error.message ? error.message : "capture failed"}`);
      return { status: 502, body: { error: PAYMENT_FAILED } };
    }
  }
  if (order && order.status === "PAYER_ACTION_REQUIRED") {
    // Card payments can stop here for the bank check. Completion is counted
    // when a later capture or the webhook reports the payment as paid.
    return {
      status: 200,
      body: {
        id: orderId,
        status: "PAYER_ACTION_REQUIRED",
        payerAction: payerActionUrl(order),
      },
      result: null,
    };
  }
  const confirmed = await confirmCaptured({
    order,
    store: source.store,
    prices: source.prices,
    usdPrices: source.usdPrices,
    orderId,
  });
  if (!confirmed.ok) {
    logSafe(source.log, env, `paypal capture ${orderId}: ${confirmed.reason || "not confirmed"}`);
    return { status: 409, body: { error: MISMATCH } };
  }
  const result = await fulfilStoredOrder(source);
  return {
    status: 200,
    body: { id: orderId, continueUrl: `/order/continue?session_id=${orderId}` },
    result,
  };
}

function paypalCertUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:") return "";
    const host = url.hostname.toLowerCase();
    if (host !== "paypal.com" && !host.endsWith(".paypal.com")) return "";
    return url.toString();
  } catch {
    return "";
  }
}

async function verifyWebhook(config, fetchImpl, cache, headers, event) {
  const source = headers || {};
  const cert = paypalCertUrl(source["paypal-cert-url"]);
  const transmissionId = String(source["paypal-transmission-id"] || "");
  const transmissionSig = String(source["paypal-transmission-sig"] || "");
  const transmissionTime = String(source["paypal-transmission-time"] || "");
  const authAlgo = String(source["paypal-auth-algo"] || "");
  if (!cert || !transmissionId || !transmissionSig || !transmissionTime || !authAlgo || !config.webhookId) return false;
  let parsed;
  try {
    parsed = await paypalRequest(config, fetchImpl, cache, "/v1/notifications/verify-webhook-signature", {
      method: "POST",
      body: JSON.stringify({
        auth_algo: authAlgo,
        cert_url: cert,
        transmission_id: transmissionId,
        transmission_sig: transmissionSig,
        transmission_time: transmissionTime,
        webhook_id: config.webhookId,
        webhook_event: event,
      }),
    });
  } catch (error) {
    return false;
  }
  return !!(parsed && parsed.verification_status === "SUCCESS");
}

async function handlePaypalWebhook(deps) {
  const source = deps || {};
  const env = source.env || {};
  const config = paypalEnv(env);
  if (!config.ok || !config.webhookId) {
    logSafe(source.log, env, "paypal/webhook: PAYPAL_WEBHOOK_ID is not set, refusing");
    return { status: 503, body: { error: "webhook not configured" } };
  }
  let event;
  try {
    event = JSON.parse(source.raw || "");
  } catch {
    return { status: 400, body: { error: "bad signature" } };
  }
  const verified = source.verify
    ? await source.verify(source.headers, event)
    : await verifyWebhook(config, source.fetchImpl, source.cache, source.headers, event);
  if (!verified) {
    logSafe(source.log, env, "paypal/webhook: signature verification failed");
    return { status: 400, body: { error: "bad signature" } };
  }
  if (!event || event.event_type !== "PAYMENT.CAPTURE.COMPLETED") {
    return { status: 200, body: { received: true, ignored: true } };
  }
  const resource = event.resource || {};
  const orderId = orderIdFromPaypalResource(resource);
  if (!isPaypalOrderId(orderId)) {
    logSafe(source.log, env, "paypal/webhook: capture had no order id");
    return { status: 200, body: { received: true, ignored: true } };
  }
  let result = null;
  try {
    const existing = source.store ? await source.store.get(orderId) : null;
      if (existing && existing.status === "COMPLETED") {
        result = await fulfilStoredOrder({ ...source, orderId });
      } else {
        const outcome = await capturePaypalOrder({ ...source, orderId });
        if (outcome.status === 200) result = outcome.result;
        else if (outcome.status === 409) logSafe(source.log, env, `paypal/webhook ${orderId}: amount was not confirmed`);
        else return { status: 500, body: { error: "order handling failed" }, orderId };
      }
  } catch (error) {
    logSafe(source.log, env, `paypal/webhook ${orderId}: ${error && error.message ? error.message : "order handling failed"}`);
  }
  return { status: 200, body: { received: true }, result, orderId };
}

module.exports = {
  FRIENDLY,
  PAYMENT_FAILED,
  MISMATCH,
  paymentProvider,
  paypalEnv,
  redact,
  orderBody,
  createPaypalOrder,
  capturePaypalOrder,
  fulfilStoredOrder,
  handlePaypalWebhook,
  orderIdFromPaypalResource,
  verifyWebhook,
  paypalCertUrl,
  confirmCaptured,
};
