"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { createServer } = require("../server");

const ORDER_ID = "5O190127TN364715T";
const US_ORDER_ID = "8F148933YW342715K";
const EARLY_BUNDLE = "https://buy.stripe.com/5kQaEYfzNeFI4gq1fD1wY00";

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    },
  };
}

function paypalEnv() {
  return {
    VISITS_SECRET: "funnel-test-secret",
    PAYMENT_PROVIDER: "paypal",
    PAYPAL_CLIENT_ID: "AWtestclientid1234",
    PAYPAL_CLIENT_SECRET: "paypal-secret",
    PAYPAL_ENV: "sandbox",
    PAYPAL_WEBHOOK_ID: "WH-test-webhook",
  };
}

function completedOrder(orderId, currency, value) {
  return {
    id: orderId,
    status: "COMPLETED",
    payer: { email_address: "parent@example.com" },
    purchase_units: [{
      amount: { currency_code: currency, value },
      payments: {
        captures: [{ id: "CAP123456789012345", status: "COMPLETED", amount: { currency_code: currency, value } }],
      },
    }],
  };
}

function paypalFetchFor(orderId, currency, value) {
  return async (url, options) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/v1/oauth2/token") return jsonResponse(200, { access_token: "tok_test", expires_in: 3200 });
    if (parsed.pathname === "/v2/checkout/orders" && options.method === "POST") {
      return jsonResponse(201, { id: orderId, status: "CREATED" });
    }
    if (parsed.pathname === `/v2/checkout/orders/${orderId}/capture`) {
      return jsonResponse(201, completedOrder(orderId, currency, value));
    }
    if (parsed.pathname === `/v2/checkout/orders/${orderId}`) {
      return jsonResponse(200, completedOrder(orderId, currency, value));
    }
    return jsonResponse(500, { name: "UNKNOWN" });
  };
}

async function report(port) {
  const response = await fetch(`http://127.0.0.1:${port}/admin/funnel`, {
    headers: { Authorization: "Bearer funnel-test-secret" },
  });
  return response.json();
}

function webhookBody(orderId, currency, value) {
  return JSON.stringify({
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    resource: {
      id: "CAP123456789012345",
      status: "COMPLETED",
      amount: { currency_code: currency, value },
      supplementary_data: { related_ids: { order_id: orderId } },
    },
  });
}

test("a completed £14.99 UK PayPal payment counts once across capture and webhook", async () => {
  const server = createServer({
    log() {},
    now: "2026-11-02T12:00:00Z",
    visitsFile: null,
    funnelFile: null,
    paypalOrdersFile: null,
    emailWaitMs: 0,
    webhookEmailWaitMs: 0,
    paypalFetch: paypalFetchFor(ORDER_ID, "GBP", "14.99"),
    verifyPaypalWebhook: async () => true,
    env: paypalEnv(),
  });
  const port = await listen(server);
  const origin = `http://127.0.0.1:${port}`;
  try {
    const created = await fetch(`${origin}/api/paypal/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, "x-forwarded-for": "81.2.69.142" },
      body: JSON.stringify({
        package: "singleVideo",
        market: "uk",
        utm_source: "meta",
        utm_campaign: "nov",
        utm_content: "single",
        amount: "0.01",
      }),
    });
    assert.strictEqual(created.status, 201);

    const captured = await fetch(`${origin}/api/paypal/orders/${ORDER_ID}/capture`, {
      method: "POST",
      headers: { Origin: origin },
    });
    assert.strictEqual(captured.status, 200);
    let body = await report(port);
    assert.strictEqual(body.total.checkout_complete, 1);
    assert.strictEqual(body.total.checkout_start, 1);
    assert.strictEqual(body.markets.uk.checkout_complete, 1);
    assert.strictEqual(body.markets.us.checkout_complete, 0);
    const row = body.buckets.find((item) => item.utm_content === "single");
    assert.strictEqual(row.market, "uk");
    assert.strictEqual(row.country, "GB");
    assert.strictEqual(row.utm_source, "meta");
    assert.strictEqual(row.utm_campaign, "nov");
    assert.strictEqual(row.checkout_complete, 1);

    const webhook = await fetch(`${origin}/paypal/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: webhookBody(ORDER_ID, "GBP", "14.99"),
    });
    assert.strictEqual(webhook.status, 200);
    const again = await fetch(`${origin}/api/paypal/orders/${ORDER_ID}/capture`, {
      method: "POST",
      headers: { Origin: origin },
    });
    assert.strictEqual(again.status, 200);
    body = await report(port);
    assert.strictEqual(body.total.checkout_complete, 1);
    assert.strictEqual(body.markets.uk.checkout_complete, 1);
  } finally {
    await close(server);
  }
});

test("a completed US PayPal payment counts once on the US market", async () => {
  const server = createServer({
    log() {},
    now: "2026-11-02T12:00:00Z",
    visitsFile: null,
    funnelFile: null,
    paypalOrdersFile: null,
    emailWaitMs: 0,
    webhookEmailWaitMs: 0,
    paypalFetch: paypalFetchFor(US_ORDER_ID, "USD", "19.99"),
    verifyPaypalWebhook: async () => true,
    env: paypalEnv(),
  });
  const port = await listen(server);
  const origin = `http://127.0.0.1:${port}`;
  try {
    const created = await fetch(`${origin}/api/paypal/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({
        package: "singleVideo",
        market: "us",
        utm_source: "meta",
        utm_content: "usa",
      }),
    });
    assert.strictEqual(created.status, 201);
    const captured = await fetch(`${origin}/api/paypal/orders/${US_ORDER_ID}/capture`, {
      method: "POST",
      headers: { Origin: origin },
    });
    assert.strictEqual(captured.status, 200);
    let body = await report(port);
    assert.strictEqual(body.markets.us.checkout_start, 1);
    assert.strictEqual(body.markets.us.checkout_complete, 1);
    assert.strictEqual(body.markets.uk.checkout_complete, 0);
    assert.strictEqual(body.total.checkout_complete, 1);
    const row = body.buckets.find((item) => item.utm_content === "usa");
    assert.strictEqual(row.market, "us");
    assert.strictEqual(row.utm_source, "meta");

    const webhook = await fetch(`${origin}/paypal/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: webhookBody(US_ORDER_ID, "USD", "19.99"),
    });
    assert.strictEqual(webhook.status, 200);
    body = await report(port);
    assert.strictEqual(body.total.checkout_complete, 1);
    assert.strictEqual(body.markets.us.checkout_complete, 1);
  } finally {
    await close(server);
  }
});

test("Stripe checkout_start keeps a US visit off the UK market", async () => {
  const created = [];
  const stripe = {
    created,
    paymentLinks: {
      async list() {
        return { data: [{ id: "plink_uk", url: EARLY_BUNDLE }], has_more: false };
      },
      async retrieve() {
        return {
          id: "plink_uk",
          url: EARLY_BUNDLE,
          currency: "gbp",
          metadata: { package: "bundle_early_bird" },
          line_items: { data: [{ price: { id: "price_bundle", currency: "gbp", unit_amount: 1699 }, quantity: 1 }] },
          optional_items: [],
        };
      },
    },
    checkout: {
      sessions: {
        async create(params) {
          const id = `cs_test_market${created.length + 1}`;
          created.push({ id, params });
          return { id, url: `https://checkout.stripe.com/c/pay/${id}` };
        },
      },
    },
  };
  const server = createServer({
    log() {},
    now: "2026-11-02T12:00:00Z",
    visitsFile: null,
    funnelFile: null,
    env: {
      VISITS_SECRET: "funnel-test-secret",
      PAYMENT_PROVIDER: "stripe",
      STRIPE_SECRET_KEY: "rk_test_secret",
    },
    stripe,
  });
  const port = await listen(server);
  try {
    const us = await fetch(`http://127.0.0.1:${port}/order/pay?package=magicBundle&market=us&utm_source=meta&utm_content=usa`, {
      redirect: "manual",
    });
    assert.strictEqual(us.status, 302);
    const uk = await fetch(`http://127.0.0.1:${port}/order/pay?package=magicBundle&utm_source=meta&utm_content=uk`, {
      redirect: "manual",
    });
    assert.strictEqual(uk.status, 302);
    assert.strictEqual(created[0].params.metadata.ssm_market, "us");
    assert.strictEqual(created[0].params.metadata.utm_source, "meta");
    assert.strictEqual(created[1].params.metadata.ssm_market, "uk");
    const body = await report(port);
    assert.strictEqual(body.markets.us.checkout_start, 1);
    assert.strictEqual(body.markets.uk.checkout_start, 1);
    assert.strictEqual(body.markets.us.checkout_complete, 0);
    const usRow = body.buckets.find((item) => item.market === "us");
    assert.strictEqual(usRow.utm_content, "usa");
    assert.strictEqual(usRow.checkout_start, 1);
  } finally {
    await close(server);
  }
});

test("a paid Stripe USD session counts once as a US completion", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "santa-usd-complete-"));
  const funnelPath = path.join(dir, "funnel-counts.json");
  const session = {
    id: "cs_test_usdpaid1",
    payment_status: "paid",
    amount_total: 1999,
    currency: "usd",
    metadata: { utm_source: "meta", utm_content: "usd" },
    line_items: { data: [{ description: "Single video", quantity: 1, price: { unit_amount: 1999, currency: "usd" } }] },
  };
  const server = createServer({
    log() {},
    now: "2026-11-02T12:00:00Z",
    visitsFile: null,
    funnelFile: funnelPath,
    emailWaitMs: 0,
    webhookEmailWaitMs: 0,
    env: {
      VISITS_SECRET: "funnel-test-secret",
      STRIPE_SECRET_KEY: "rk_test_secret",
      STRIPE_WEBHOOK_SECRET: "whsec_test",
    },
    constructWebhookEvent: () => ({
      type: "checkout.session.completed",
      data: { object: { id: session.id } },
    }),
    retrieveSession: async () => session,
  });
  const port = await listen(server);
  const origin = `http://127.0.0.1:${port}`;
  try {
    const hook = await fetch(`${origin}/stripe/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "stripe-signature": "ok" },
      body: "{}",
    });
    assert.strictEqual(hook.status, 200);
    let body = await report(port);
    assert.strictEqual(body.total.checkout_complete, 1);
    assert.strictEqual(body.markets.us.checkout_complete, 1);
    assert.strictEqual(body.markets.uk.checkout_complete, 0);
    const row = body.buckets.find((item) => item.utm_content === "usd");
    assert.strictEqual(row.market, "us");
    assert.strictEqual(row.utm_source, "meta");

    const again = await fetch(`${origin}/stripe/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "stripe-signature": "ok" },
      body: "{}",
    });
    assert.strictEqual(again.status, 200);
    const page = await fetch(`${origin}/order/continue?session_id=${session.id}`);
    assert.strictEqual(page.status, 200);
    await page.text();
    body = await report(port);
    assert.strictEqual(body.total.checkout_complete, 1);
    assert.strictEqual(body.markets.us.checkout_complete, 1);
  } finally {
    await close(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
