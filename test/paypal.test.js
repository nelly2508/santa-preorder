"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { createServer } = require("../server");
const { quoteCart, sessionForPaidOrder } = require("../lib/quote");
const { summariseCheckout } = require("../lib/order-continue");
const { paypalCertUrl, FRIENDLY } = require("../lib/paypal");

const ORDER_ID = "5O190127TN364715T";
const CLIENT = "AWtestclientid1234";
const SECRET = "super-secret-value";
const WEBHOOK = "WH-test-webhook-id";

const prices = {
  magicBundleFull: "£19.99",
  magicBundleEarly: "£16.99",
  magicBundleLate: "£24.98",
  singleVideo: "£14.99",
  singleVideoLate: "£19.98",
  sibling: "£11.99",
  rush: "£4.99",
  namedSleigh: "£4.99",
};

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
    PAYMENT_PROVIDER: "paypal",
    PAYPAL_CLIENT_ID: CLIENT,
    PAYPAL_CLIENT_SECRET: SECRET,
    PAYPAL_ENV: "sandbox",
    PAYPAL_WEBHOOK_ID: WEBHOOK,
    SMTP_PASS: "mailbox-secret",
    VISITS_SECRET: "visits-secret",
    ...extra,
  };
}

function paidOrder(createdBody) {
  const unit = createdBody.purchase_units[0];
  return {
    id: ORDER_ID,
    status: "COMPLETED",
    payer: { email_address: "parent@example.com" },
    purchase_units: [{
      items: unit.items,
      payments: {
        captures: [{
          id: "CAP123456789012345",
          status: "COMPLETED",
          amount: { currency_code: unit.amount.currency_code, value: unit.amount.value },
        }],
      },
    }],
  };
}

function mockPaypal() {
  const state = { calls: [], created: null, order: null, verification: "SUCCESS" };
  const paypalFetch = async (url, options) => {
    state.calls.push({ url, method: options && options.method, body: options && options.body, headers: options && options.headers });
    const parsed = new URL(url);
    if (parsed.pathname === "/v1/oauth2/token") {
      return jsonResponse(200, { access_token: "tok_test", expires_in: 3200 });
    }
    if (parsed.pathname === "/v2/checkout/orders" && options.method === "POST") {
      state.created = JSON.parse(options.body);
      return jsonResponse(201, { id: ORDER_ID, status: "CREATED" });
    }
    if (parsed.pathname === `/v2/checkout/orders/${ORDER_ID}/capture`) {
      state.order = paidOrder(state.created);
      return jsonResponse(201, state.order);
    }
    if (parsed.pathname === `/v2/checkout/orders/${ORDER_ID}` && options.method === "GET") {
      return jsonResponse(200, state.order);
    }
    if (parsed.pathname === "/v1/notifications/verify-webhook-signature") {
      return jsonResponse(200, { verification_status: state.verification });
    }
    return jsonResponse(500, { name: "UNKNOWN" });
  };
  return { state, paypalFetch };
}

test("the server prices the cart and ignores a client amount", () => {
  const early = quoteCart({ packageKey: "magicBundle", siblings: 2, sleigh: true, phase: "early", prices, amount: "0.01" });
  assert.strictEqual(early.totalPence, 1699 + 1199 * 2);
  assert.strictEqual(early.currency, "GBP");
  assert.strictEqual(early.packageType, "bundle_early_bird");
  assert.strictEqual(early.sleigh, true);
  assert.strictEqual(early.lines.some((line) => line.sku === "addon_sleigh"), false);
  assert.strictEqual(early.lines.find((line) => line.sku === "addon_sibling").quantity, 2);

  const late = quoteCart({ packageKey: "singleVideo", siblings: 9, sleigh: true, phase: "late", prices });
  assert.strictEqual(late.siblings, 4);
  assert.strictEqual(late.rush, true);
  assert.strictEqual(late.totalPence, 1499 + 499 + 499 + 1199 * 4);
  assert.strictEqual(quoteCart({ packageKey: "magicBundle", phase: "late", prices }).totalPence, 2498);
  assert.strictEqual(quoteCart({ packageKey: "magicBundle", phase: "standard", prices }).totalPence, 1999);

  const session = sessionForPaidOrder({
    orderId: ORDER_ID,
    captureId: "CAP1",
    quote: early,
    email: "parent@example.com",
    createdSeconds: 1,
    utm: { utm_source: "meta" },
  });
  assert.deepStrictEqual(summariseCheckout(session), {
    children: 3,
    rush: false,
    sleigh: true,
    packageType: "bundle_early_bird",
  });
});

test("a cert url has to be an https PayPal host", () => {
  assert.strictEqual(paypalCertUrl("https://api.paypal.com/v1/notifications/certs/CERT"), "https://api.paypal.com/v1/notifications/certs/CERT");
  assert.strictEqual(paypalCertUrl("https://api.sandbox.paypal.com/v1/notifications/certs/CERT"), "https://api.sandbox.paypal.com/v1/notifications/certs/CERT");
  assert.strictEqual(paypalCertUrl("http://api.paypal.com/cert"), "");
  assert.strictEqual(paypalCertUrl("https://evil.example/cert"), "");
  assert.strictEqual(paypalCertUrl("javascript:alert(1)"), "");
});

test("missing PayPal settings fail with a friendly message and do not crash", async () => {
  const logs = [];
  let fetched = false;
  const server = createServer({
    log: (message) => logs.push(message),
    now: "2026-10-24T12:00:00Z",
    visitsFile: null,
    funnelFile: null,
    paypalOrdersFile: null,
    env: { PAYPAL_CLIENT_SECRET: SECRET },
    paypalFetch: async () => {
      fetched = true;
      throw new Error(`leaked ${SECRET}`);
    },
  });
  const port = await listen(server);
  try {
    const first = await fetch(`http://127.0.0.1:${port}/api/paypal/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ package: "magicBundle", amount: "0.01" }),
    });
    assert.strictEqual(first.status, 503);
    const body = await first.json();
    assert.strictEqual(body.error, FRIENDLY);
    assert.doesNotMatch(JSON.stringify(body), new RegExp(SECRET));
    const second = await fetch(`http://127.0.0.1:${port}/api/paypal/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ package: "singleVideo" }),
    });
    assert.strictEqual(second.status, 503);
    const home = await fetch(`http://127.0.0.1:${port}/`);
    assert.strictEqual(home.status, 200);
    const html = await home.text();
    assert.match(html, />Pay with PayPal or card</);
    assert.match(html, /data-paypal-ready="0"/);
    assert.doesNotMatch(html, /Stripe/);
    assert.doesNotMatch(html, new RegExp(SECRET));
    assert.strictEqual(fetched, false);
    assert.doesNotMatch(logs.join("\n"), new RegExp(SECRET));
  } finally {
    await close(server);
  }
});

test("create charges the server price in GBP, and capture, webhook and the continue page record the order once", async () => {
  const logs = [];
  const sent = [];
  const { state, paypalFetch } = mockPaypal();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "santa-paypal-"));
  const server = createServer({
    log: (message) => logs.push(message),
    now: "2026-10-24T12:00:00Z",
    visitsFile: null,
    funnelFile: null,
    paypalOrdersFile: path.join(dir, "orders.json"),
    env: paypalEnv(),
    paypalFetch,
    sendMail: async (message) => {
      sent.push(message);
    },
  });
  const port = await listen(server);
  const origin = `http://127.0.0.1:${port}`;
  try {
    const home = await fetch(`${origin}/`);
    const html = await home.text();
    assert.match(html, new RegExp(`data-paypal-client-id="${CLIENT}"`));
    assert.match(html, /data-payment-provider="paypal"/);
    assert.doesNotMatch(html, /Stripe|buy\.stripe\.com/);
    assert.doesNotMatch(html, new RegExp(SECRET));
    assert.match(home.headers.get("content-security-policy"), /https:\/\/www\.paypal\.com/);

    const config = await fetch(`${origin}/api/paypal/config`);
    const configBody = await config.json();
    assert.deepStrictEqual(configBody, { provider: "paypal", currency: "GBP", ready: true, clientId: CLIENT });
    assert.doesNotMatch(JSON.stringify(configBody), new RegExp(SECRET));

    const created = await fetch(`${origin}/api/paypal/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({
        package: "magicBundle",
        siblings: 2,
        sleigh: true,
        amount: "0.01",
        currency: "USD",
        value: 1,
        utm_source: "meta",
        utm_campaign: "xmas",
        utm_content: "video",
      }),
    });
    assert.strictEqual(created.status, 201);
    const createdBody = await created.json();
    assert.strictEqual(createdBody.id, ORDER_ID);
    const unit = state.created.purchase_units[0];
    assert.strictEqual(unit.amount.currency_code, "GBP");
    assert.strictEqual(unit.amount.value, "40.97");
    assert.strictEqual(unit.amount.breakdown.item_total.value, "40.97");
    assert.deepStrictEqual(unit.items.map((item) => [item.sku, item.quantity, item.unit_amount.value]), [
      ["bundle_early_bird", "1", "16.99"],
      ["addon_sibling", "2", "11.99"],
    ]);
    assert.strictEqual(state.created.application_context.shipping_preference, "NO_SHIPPING");
    const auth = state.calls.find((call) => call.url.endsWith("/v1/oauth2/token")).headers.Authorization;
    assert.match(auth, /^Basic /);
    assert.doesNotMatch(JSON.stringify(createdBody), new RegExp(SECRET));

    const captured = await fetch(`${origin}/api/paypal/orders/${ORDER_ID}/capture`, {
      method: "POST",
      headers: { Origin: origin },
    });
    assert.strictEqual(captured.status, 200);
    const capturedBody = await captured.json();
    assert.strictEqual(capturedBody.continueUrl, `/order/continue?session_id=${ORDER_ID}`);

    const webhook = await fetch(`${origin}/paypal/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "paypal-auth-algo": "SHA256withRSA",
        "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT",
        "paypal-transmission-id": "trans-1",
        "paypal-transmission-sig": "sig",
        "paypal-transmission-time": "2026-10-24T12:00:00Z",
      },
      body: JSON.stringify({
        event_type: "PAYMENT.CAPTURE.COMPLETED",
        resource: { supplementary_data: { related_ids: { order_id: ORDER_ID } } },
      }),
    });
    assert.strictEqual(webhook.status, 200);
    assert.deepStrictEqual(await webhook.json(), { received: true });

    const again = await fetch(`${origin}/api/paypal/orders/${ORDER_ID}/capture`, {
      method: "POST",
      headers: { Origin: origin },
    });
    assert.strictEqual(again.status, 200);

    const page = await fetch(`${origin}/order/continue?session_id=${ORDER_ID}`);
    assert.strictEqual(page.status, 200);
    const orderHtml = await page.text();
    assert.match(orderHtml, /data-purchase-value="40\.97"/);
    assert.match(orderHtml, /data-purchase-currency="GBP"/);
    assert.match(orderHtml, /children=3/);
    assert.match(orderHtml, /rush=0/);
    assert.match(orderHtml, /sleigh=1/);
    assert.match(orderHtml, /package=bundle_early_bird/);
    assert.match(orderHtml, /email=parent%40example\.com/);
    assert.match(orderHtml, new RegExp(`order=${ORDER_ID}`));

    assert.strictEqual(sent.length, 2);
    assert.match(sent.map((message) => message.subject).join("\n"), /New Santa order/);
    assert.match(sent.map((message) => message.text).join("\n"), new RegExp(`PayPal order: ${ORDER_ID}`));
    assert.doesNotMatch(logs.join("\n"), new RegExp(`${SECRET}|tok_test`));

    const report = await fetch(`${origin}/admin/funnel`, { headers: { Authorization: "Bearer visits-secret" } });
    const funnel = await report.json();
    const row = funnel.buckets.find((item) => item.utm_source === "meta");
    assert.strictEqual(funnel.total.checkout_start, 1);
    assert.strictEqual(funnel.total.checkout_complete, 1);
    assert.strictEqual(row.checkout_start, 1);
    assert.strictEqual(row.checkout_complete, 1);
  } finally {
    await close(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a capture whose amount does not match the server price is not fulfilled", async () => {
  const sent = [];
  const { state, paypalFetch } = mockPaypal();
  const realPaid = paidOrder;
  state.order = null;
  const server = createServer({
    log() {},
    now: "2026-10-24T12:00:00Z",
    visitsFile: null,
    funnelFile: null,
    paypalOrdersFile: null,
    env: paypalEnv(),
    paypalFetch: async (url, options) => {
      if (String(url).endsWith("/capture")) {
        state.created = state.created || { purchase_units: [{ amount: { currency_code: "GBP", value: "16.99" }, items: [] }] };
        return jsonResponse(201, {
          id: ORDER_ID,
          status: "COMPLETED",
          payer: { email_address: "parent@example.com" },
          purchase_units: [{
            payments: {
              captures: [{ id: "CAP1", status: "COMPLETED", amount: { currency_code: "GBP", value: "0.01" } }],
            },
          }],
        });
      }
      return paypalFetch(url, options);
    },
    sendMail: async (message) => sent.push(message),
  });
  const port = await listen(server);
  try {
    const created = await fetch(`http://127.0.0.1:${port}/api/paypal/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ package: "magicBundle", amount: "0.01" }),
    });
    assert.strictEqual(created.status, 201);
    const captured = await fetch(`http://127.0.0.1:${port}/api/paypal/orders/${ORDER_ID}/capture`, { method: "POST" });
    assert.strictEqual(captured.status, 409);
    assert.strictEqual(sent.length, 0);
    assert.strictEqual(realPaid, paidOrder);
  } finally {
    await close(server);
  }
});

test("the webhook refuses a missing id or a bad signature, and a late order includes rush", async () => {
  const { paypalFetch } = mockPaypal();
  const logs = [];
  const server = createServer({
    log: (message) => logs.push(message),
    now: "2026-12-14T12:00:00Z",
    visitsFile: null,
    funnelFile: null,
    paypalOrdersFile: null,
    env: paypalEnv({ PAYPAL_WEBHOOK_ID: "" }),
    paypalFetch,
  });
  const port = await listen(server);
  const origin = `http://127.0.0.1:${port}`;
  try {
    const missing = await fetch(`${origin}/paypal/webhook`, { method: "POST", body: "{}" });
    assert.strictEqual(missing.status, 503);
    assert.doesNotMatch(logs.join("\n"), new RegExp(SECRET));

    const bad = createServer({
      log() {},
      now: "2026-12-14T12:00:00Z",
      visitsFile: null,
      funnelFile: null,
      paypalOrdersFile: null,
      env: paypalEnv(),
      paypalFetch,
      verifyPaypalWebhook: async () => false,
    });
    const badPort = await listen(bad);
    try {
      const refused = await fetch(`http://127.0.0.1:${badPort}/paypal/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event_type: "PAYMENT.CAPTURE.COMPLETED" }),
      });
      assert.strictEqual(refused.status, 400);
      assert.deepStrictEqual(await refused.json(), { error: "bad signature" });
    } finally {
      await close(bad);
    }

    const { state, paypalFetch: lateFetch } = mockPaypal();
    const late = createServer({
      log() {},
      now: "2026-12-14T12:00:00Z",
      visitsFile: null,
      funnelFile: null,
      paypalOrdersFile: null,
      env: paypalEnv(),
      paypalFetch: lateFetch,
    });
    const latePort = await listen(late);
    try {
      const created = await fetch(`http://127.0.0.1:${latePort}/api/paypal/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ package: "singleVideo", sleigh: true, siblings: 1, amount: "1.00" }),
      });
      assert.strictEqual(created.status, 201);
      const items = state.created.purchase_units[0].items;
      assert.deepStrictEqual(items.map((item) => item.sku), ["single", "addon_rush", "addon_sleigh", "addon_sibling"]);
      assert.strictEqual(state.created.purchase_units[0].amount.value, "36.96");
      assert.strictEqual(state.created.purchase_units[0].amount.currency_code, "GBP");
    } finally {
      await close(late);
    }

    const shut = createServer({
      log() {},
      now: "2026-12-20T00:00:00Z",
      visitsFile: null,
      funnelFile: null,
      paypalOrdersFile: null,
      env: paypalEnv(),
      paypalFetch,
    });
    const shutPort = await listen(shut);
    try {
      const refused = await fetch(`http://127.0.0.1:${shutPort}/api/paypal/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ package: "magicBundle" }),
      });
      assert.strictEqual(refused.status, 403);
      const pay = await fetch(`http://127.0.0.1:${shutPort}/order/pay?package=magicBundle`, { redirect: "manual" });
      assert.strictEqual(pay.status, 200);
      assert.doesNotMatch(await pay.text(), /buy\.stripe\.com/);
    } finally {
      await close(shut);
    }
  } finally {
    await close(server);
  }
});

test("PayPal keeps /order/pay on this site, and Stripe remains behind the flag", async () => {
  const paypal = createServer({
    log() {},
    now: "2026-10-24T12:00:00Z",
    visitsFile: null,
    funnelFile: null,
    paypalOrdersFile: null,
    env: { PAYMENT_PROVIDER: "paypal" },
  });
  const paypalPort = await listen(paypal);
  try {
    const pay = await fetch(`http://127.0.0.1:${paypalPort}/order/pay?package=singleVideo&siblings=9&utm_source=meta`, { redirect: "manual" });
    assert.strictEqual(pay.status, 302);
    assert.strictEqual(pay.headers.get("location"), "/?package=singleVideo&siblings=4&utm_source=meta#checkout");
    assert.doesNotMatch(pay.headers.get("location"), /stripe/i);
  } finally {
    await close(paypal);
  }

  const stripe = createServer({
    log() {},
    now: "2026-10-24T12:00:00Z",
    visitsFile: null,
    funnelFile: null,
    paypalOrdersFile: null,
    env: { PAYMENT_PROVIDER: "stripe" },
  });
  const stripePort = await listen(stripe);
  try {
    const pay = await fetch(`http://127.0.0.1:${stripePort}/order/pay?package=magicBundle`, { redirect: "manual" });
    assert.strictEqual(pay.status, 302);
    assert.strictEqual(pay.headers.get("location"), "https://buy.stripe.com/5kQaEYfzNeFI4gq1fD1wY00");
    const home = await fetch(`http://127.0.0.1:${stripePort}/`);
    const html = await home.text();
    assert.match(html, />Continue to secure payment</);
    assert.match(html, /data-payment-provider="stripe"/);
    const blocked = await fetch(`http://127.0.0.1:${stripePort}/api/paypal/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.strictEqual(blocked.status, 404);
  } finally {
    await close(stripe);
  }
});

function cspSources(csp, name) {
  const found = String(csp || "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name} `));
  assert.ok(found, `${name} missing`);
  return found.slice(name.length + 1).split(/\s+/);
}

test("the content security policy allows PayPal card styles, images, and hosts", async () => {
  const server = createServer({
    log() {},
    now: "2026-10-24T12:00:00Z",
    visitsFile: null,
    funnelFile: null,
    paypalOrdersFile: null,
    env: paypalEnv(),
  });
  const port = await listen(server);
  try {
    const home = await fetch(`http://127.0.0.1:${port}/`);
    const html = await home.text();
    const nonceMatch = /data-csp-nonce="([^"]+)"/.exec(html);
    assert.ok(nonceMatch, "sales page exposes the CSP nonce");
    const nonce = nonceMatch[1];
    assert.match(nonce, /^[A-Za-z0-9_-]{16,}$/);
    const csp = home.headers.get("content-security-policy");
    const style = cspSources(csp, "style-src");
    const script = cspSources(csp, "script-src");
    const img = cspSources(csp, "img-src");
    const connect = cspSources(csp, "connect-src");
    const frame = cspSources(csp, "frame-src");
    assert.ok(style.includes(`'nonce-${nonce}'`));
    assert.ok(script.includes(`'nonce-${nonce}'`));
    assert.ok(img.includes("data:"));
    for (const sources of [script, connect, frame, img]) {
      assert.ok(sources.includes("https://*.paypal.com"));
      assert.ok(sources.includes("https://*.paypalobjects.com"));
    }
    assert.doesNotMatch(csp, /unsafe-inline/);
    assert.match(html, /data-payment-provider="paypal"/);

    const again = await fetch(`http://127.0.0.1:${port}/`);
    const againNonce = /data-csp-nonce="([^"]+)"/.exec(await again.text())[1];
    assert.notStrictEqual(againNonce, nonce);
    assert.ok(cspSources(again.headers.get("content-security-policy"), "style-src").includes(`'nonce-${againNonce}'`));

    const mainJs = fs.readFileSync(path.join(__dirname, "../public/js/main.js"), "utf8");
    assert.match(mainJs, /"enable-funding": "card"/);
    assert.match(mainJs, /script\.setAttribute\("data-csp-nonce", nonce\)/);
    assert.doesNotMatch(mainJs, /unsafe-inline/);
  } finally {
    await close(server);
  }
});
