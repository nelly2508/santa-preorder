"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { createServer } = require("../server");
const { orderIdFromPaypalResource } = require("../lib/paypal");

const ORDER_ID = "5O190127TN364715T";
const IP_GB = "81.2.69.142";

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

function paypalEnv(extra) {
  return {
    VISITS_SECRET: "funnel-test-secret",
    PAYMENT_PROVIDER: "paypal",
    PAYPAL_CLIENT_ID: "AWtestclientid1234",
    PAYPAL_CLIENT_SECRET: "paypal-secret",
    PAYPAL_ENV: "sandbox",
    PAYPAL_WEBHOOK_ID: "WH-test-webhook",
    ...extra,
  };
}

function completedOrder() {
  return {
    id: ORDER_ID,
    status: "COMPLETED",
    payer: { email_address: "parent@example.com" },
    purchase_units: [{
      amount: { currency_code: "GBP", value: "14.99" },
    }],
  };
}

test("a card capture can find the PayPal order from the webhook link", () => {
  assert.strictEqual(orderIdFromPaypalResource({
    supplementary_data: { related_ids: { order_id: ORDER_ID } },
  }), ORDER_ID);
  assert.strictEqual(orderIdFromPaypalResource({
    links: [{ rel: "up", href: `https://api.paypal.com/v2/checkout/orders/${ORDER_ID}` }],
  }), ORDER_ID);
  assert.strictEqual(orderIdFromPaypalResource({
    links: [{ rel: "self", href: "https://api.paypal.com/v2/payments/captures/CAP123456789012345" }],
  }), "");
});

test("PayPal create counts a checkout start, and capture or webhook counts the completion once", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "santa-paypal-gap-"));
  const funnelPath = path.join(dir, "funnel-counts.json");
  const ordersPath = path.join(dir, "orders.json");
  let captures = 0;
  const paypalFetch = async (url, options) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/v1/oauth2/token") {
      return jsonResponse(200, { access_token: "tok_test", expires_in: 3200 });
    }
    if (parsed.pathname === "/v2/checkout/orders" && options.method === "POST") {
      return jsonResponse(201, { id: ORDER_ID, status: "CREATED" });
    }
    if (parsed.pathname === `/v2/checkout/orders/${ORDER_ID}/capture`) {
      captures += 1;
      if (captures === 1) {
        return jsonResponse(200, {
          id: ORDER_ID,
          status: "PAYER_ACTION_REQUIRED",
          links: [{ rel: "payer-action", href: "https://www.paypal.com/checkoutnow?token=3ds" }],
        });
      }
      return jsonResponse(201, completedOrder());
    }
    if (parsed.pathname === `/v2/checkout/orders/${ORDER_ID}`) {
      return jsonResponse(200, completedOrder());
    }
    return jsonResponse(500, { name: "UNKNOWN" });
  };

  function server() {
    return createServer({
      log() {},
      now: "2026-11-02T12:00:00Z",
      visitsFile: null,
      funnelFile: funnelPath,
      paypalOrdersFile: ordersPath,
      emailWaitMs: 0,
      webhookEmailWaitMs: 0,
      paypalFetch,
      verifyPaypalWebhook: async () => true,
      env: paypalEnv(),
    });
  }

  const webhookBody = JSON.stringify({
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    resource: {
      id: "CAP123456789012345",
      status: "COMPLETED",
      amount: { currency_code: "GBP", value: "14.99" },
      links: [{ rel: "up", href: `https://api.paypal.com/v2/checkout/orders/${ORDER_ID}` }],
    },
  });

  async function report(port) {
    const response = await fetch(`http://127.0.0.1:${port}/admin/funnel`, {
      headers: { Authorization: "Bearer funnel-test-secret" },
    });
    return response.json();
  }

  const first = server();
  const port = await listen(first);
  const origin = `http://127.0.0.1:${port}`;
  try {
    const created = await fetch(`${origin}/api/paypal/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        "x-forwarded-for": IP_GB,
      },
      body: JSON.stringify({
        package: "singleVideo",
        market: "uk",
        utm_source: "meta",
        utm_content: "single",
        amount: "0.01",
      }),
    });
    assert.strictEqual(created.status, 201);
    let body = await report(port);
    assert.strictEqual(body.total.checkout_start, 1);
    assert.strictEqual(body.total.checkout_complete, 0);
    assert.strictEqual(body.total_uk.checkout_start, 1);
    assert.strictEqual(body.markets.uk.checkout_start, 1);

    const pending = await fetch(`${origin}/api/paypal/orders/${ORDER_ID}/capture`, {
      method: "POST",
      headers: { Origin: origin },
    });
    assert.strictEqual(pending.status, 200);
    const pendingBody = await pending.json();
    assert.strictEqual(pendingBody.status, "PAYER_ACTION_REQUIRED");
    assert.match(pendingBody.payerAction, /^https:\/\/www\.paypal\.com\//);
    body = await report(port);
    assert.strictEqual(body.total.checkout_complete, 0);
    assert.strictEqual(body.total.checkout_start, 1);

    const webhook = await fetch(`${origin}/paypal/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: webhookBody,
    });
    assert.strictEqual(webhook.status, 200);
    body = await report(port);
    assert.strictEqual(body.total.checkout_start, 1);
    assert.strictEqual(body.total.checkout_complete, 1);
    assert.strictEqual(body.total_uk.checkout_complete, 1);
    assert.strictEqual(body.markets.uk.checkout_complete, 1);
    const row = body.buckets.find((item) => item.utm_content === "single");
    assert.strictEqual(row.country, "GB");
    assert.strictEqual(row.market, "uk");

    const again = await fetch(`${origin}/paypal/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: webhookBody,
    });
    assert.strictEqual(again.status, 200);
    body = await report(port);
    assert.strictEqual(body.total.checkout_complete, 1);
  } finally {
    await close(first);
  }

  const restarted = server();
  const port2 = await listen(restarted);
  try {
    const replay = await fetch(`http://127.0.0.1:${port2}/paypal/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: webhookBody,
    });
    assert.strictEqual(replay.status, 200);
    const body = await report(port2);
    assert.strictEqual(body.total.checkout_start, 1);
    assert.strictEqual(body.total.checkout_complete, 1);
    assert.strictEqual(body.total_uk.checkout_complete, 1);
    const saved = JSON.parse(fs.readFileSync(funnelPath, "utf8"));
    assert.ok(Array.isArray(saved.completed) && saved.completed.length === 1);
    assert.doesNotMatch(JSON.stringify(saved), new RegExp(ORDER_ID));
  } finally {
    await close(restarted);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a US PayPal order does not change the UK totals", async () => {
  const server = createServer({
    log() {},
    now: "2026-11-02T12:00:00Z",
    visitsFile: null,
    funnelFile: null,
    paypalOrdersFile: null,
    emailWaitMs: 0,
    paypalFetch: async (url, options) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/v1/oauth2/token") return jsonResponse(200, { access_token: "tok_test", expires_in: 3200 });
      if (parsed.pathname === "/v2/checkout/orders" && options.method === "POST") {
        return jsonResponse(201, { id: ORDER_ID, status: "CREATED" });
      }
      return jsonResponse(500, { name: "UNKNOWN" });
    },
    env: paypalEnv(),
  });
  const port = await listen(server);
  try {
    const created = await fetch(`http://127.0.0.1:${port}/api/paypal/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": "8.8.8.8",
      },
      body: JSON.stringify({ package: "magicBundle", market: "us", utm_source: "meta" }),
    });
    assert.strictEqual(created.status, 201);
    const body = await (await fetch(`http://127.0.0.1:${port}/admin/funnel`, {
      headers: { Authorization: "Bearer funnel-test-secret" },
    })).json();
    assert.strictEqual(body.total.checkout_start, 1);
    assert.strictEqual(body.total_uk.checkout_start, 0);
    assert.strictEqual(body.markets.us.checkout_start, 1);
    assert.strictEqual(body.markets.uk.checkout_start, 0);
  } finally {
    await close(server);
  }
});

test("funnel counts follow an existing volume path and survive a new process", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "santa-funnel-volume-"));
  const visits = path.join(dir, "visit-counts.json");
  const funnelPath = path.join(dir, "funnel-counts.json");
  const server = createServer({
    log() {},
    env: { VISITS_FILE: visits },
  });
  const port = await listen(server);
  try {
    assert.strictEqual((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
    let saved = null;
    for (let i = 0; i < 20 && !saved; i += 1) {
      if (fs.existsSync(funnelPath)) {
        saved = JSON.parse(fs.readFileSync(funnelPath, "utf8"));
        if (!saved.total || saved.total.view < 1) saved = null;
      }
      if (!saved) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(saved, "funnel file was not written beside VISITS_FILE");
    assert.strictEqual(saved.total.view, 1);
  } finally {
    await close(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
