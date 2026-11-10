"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const vm = require("vm");
const { createServer } = require("../server");
const { quoteCart, sessionForPaidOrder } = require("../lib/quote");
const { funnelFromSession } = require("../lib/funnel-counts");
const { offerPhase } = require("../public/js/checkout-choice");

const ORDER_ID = "5O190127TN364715T";

function loadConfig() {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../public/js/config.js"), "utf8"), sandbox, { filename: "config.js" });
  return sandbox.window.SANTA_CONFIG;
}

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

test("US prices follow the UK early-bird clock and the standard bundle is $24.99", () => {
  const config = loadConfig();
  assert.strictEqual(config.usd.magicBundleEarly, "$19.99");
  assert.strictEqual(config.usd.magicBundleFull, "$24.99");
  assert.strictEqual(config.earlyBirdEnds, "2026-11-15T23:59:59+00:00");
  const phaseOptions = {
    earlyBird: config.earlyBird,
    earlyBirdEnds: config.earlyBirdEnds,
    lateOrdersFrom: config.lateOrdersFrom,
  };
  assert.strictEqual(offerPhase({ ...phaseOptions, now: "2026-11-15T23:59:59Z" }), "early");
  assert.strictEqual(offerPhase({ ...phaseOptions, now: "2026-11-16T00:00:00Z" }), "standard");

  const early = quoteCart({ packageKey: "magicBundle", phase: "early", prices: config.usd, currency: "USD" });
  const standard = quoteCart({ packageKey: "magicBundle", phase: "standard", prices: config.usd, currency: "USD" });
  const late = quoteCart({ packageKey: "magicBundle", phase: "late", prices: config.usd, currency: "USD" });
  const single = quoteCart({ packageKey: "singleVideo", siblings: 1, sleigh: true, phase: "standard", prices: config.usd, currency: "USD" });
  assert.strictEqual(early.totalPence, 1999);
  assert.strictEqual(early.currency, "USD");
  assert.strictEqual(early.market, "us");
  assert.strictEqual(standard.totalPence, 2499);
  assert.strictEqual(late.totalPence, 2998);
  assert.strictEqual(single.totalPence, 1999 + 499 + 1499);
  assert.strictEqual(quoteCart({ packageKey: "magicBundle", phase: "early", prices: config.prices }).currency, "GBP");

  const session = sessionForPaidOrder({
    orderId: ORDER_ID,
    captureId: "CAP1",
    quote: standard,
    utm: { utm_source: "meta" },
  });
  assert.strictEqual(session.currency, "usd");
  assert.strictEqual(session.metadata.ssm_market, "us");
  assert.strictEqual(funnelFromSession(session).market, "us");
  assert.strictEqual(funnelFromSession({ ...session, id: "cs_test_usd123", metadata: {} }).market, "us");
  assert.strictEqual(funnelFromSession({ ...session, payment_status: "unpaid", metadata: {} }), null);
});

test("the US page is reachable, quiet, and does not steal the UK homepage", async () => {
  const server = createServer({ log() {}, now: "2026-11-03T12:00:00Z", visitsFile: null, funnelFile: null });
  const port = await listen(server);
  try {
    const uk = await fetch(`http://127.0.0.1:${port}/`, { headers: { "Accept-Language": "en-US" } });
    assert.strictEqual(uk.status, 200);
    const ukHtml = await uk.text();
    assert.match(ukHtml, /lang="en-GB"/);
    assert.match(ukHtml, /£16\.99/);
    assert.doesNotMatch(ukHtml, /<a\b[^>]*href="[^"]*\/us"/);
    assert.doesNotMatch(ukHtml, /noindex/);
    assert.doesNotMatch(ukHtml, /data-market="us"/);
    assert.match(ukHtml, /hreflang="en-GB" href="https:\/\/santasaysmyname\.com\/"/);
    assert.match(ukHtml, /hreflang="en-US" href="https:\/\/santasaysmyname\.com\/us"/);
    assert.match(ukHtml, /hreflang="x-default" href="https:\/\/santasaysmyname\.com\/"/);
    assert.match(ukHtml, /Secure checkout with PayPal or card/);
    assert.doesNotMatch(ukHtml, /us-order-bar|Personalized with your child's name/);
    assert.match(ukHtml, /id="cookie-settings"/);
    assert.match(ukHtml, /id="us-do-not-sell"/);

    const us = await fetch(`http://127.0.0.1:${port}/us`);
    assert.strictEqual(us.status, 200);
    assert.strictEqual(us.headers.get("x-robots-tag"), null);
    const html = await us.text();
    assert.match(html, /lang="en-US"/);
    assert.doesNotMatch(html, /noindex/);
    assert.match(html, /hreflang="en-GB" href="https:\/\/santasaysmyname\.com\/"/);
    assert.match(html, /hreflang="en-US" href="https:\/\/santasaysmyname\.com\/us"/);
    assert.match(html, /hreflang="x-default" href="https:\/\/santasaysmyname\.com\/"/);
    const robots = await fetch(`http://127.0.0.1:${port}/robots.txt`);
    if (robots.status === 200) {
      const rules = await robots.text();
      assert.doesNotMatch(rules, /Disallow:\s*\/us\b/i);
      assert.doesNotMatch(rules, /Disallow:\s*\/\s*$/m);
    }
    assert.match(html, /data-market="us"/);
    assert.match(html, /data-currency="USD"/);
    assert.match(html, /\$19\.99/);
    assert.match(html, /\$24\.99/);
    assert.match(html, /personalized/);
    assert.match(html, /Delivered within 48 hours of your order, whatever the date/);
    assert.match(html, /Sun Nov 15/);
    assert.match(html, /Sun Dec 13/);
    assert.match(html, /Sat Dec 19/);
    assert.match(html, /6:59pm Eastern/);
    assert.match(html, /Christmas week price/);
    assert.match(html, /Order the Magic bundle/);
    assert.doesNotMatch(html, /Pre-order|December 15|December 12|December 1|rush/i);
    assert.match(html, /same British Santa/);
    assert.match(html, /santa-preview-v3\.mp4/);
    assert.match(html, /poster="\/assets\/santa-preview-poster-lite\.webp"/);
    assert.match(html, /class="us-order-bar"/);
    const bar = html.slice(html.indexOf('class="us-order-bar"'), html.indexOf("js/config.js"));
    assert.match(bar, /data-choice-open/);
    assert.match(bar, />Order now</);
    assert.doesNotMatch(bar, /data-pay/);
    assert.match(html, /id="hero-order"[^>]*data-choice-open[^>]*>Order now</);
    assert.match(html, /From/);
    assert.match(html, /id="choice-sheet"/);
    assert.match(html, /Most popular/);
    assert.match(html, /Delivered within 48 hours of your order\. Personalized with your child's name\. Secure checkout\./);
    assert.doesNotMatch(html, /id="hear-santa"[\s\S]*?\bmuted\b/);
    assert.match(html, /id="hero-film"[^>]*\bmuted\b/);
    assert.match(html, /us-explainer-4x5-v7\.mp4|exit-sales-v4\.mp4/);
    assert.match(html, /Do Not Sell or Share My Personal Information/);
    assert.match(html, /do not collect personal information from children/);
    assert.doesNotMatch(html, /£/);
    assert.doesNotMatch(html, /personalised|favourite|15 December/);
    assert.doesNotMatch(html, /Dec 15ember/);
  } finally {
    await close(server);
  }
});

test("US funnel counts stay out of the UK totals", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "santa-us-funnel-"));
  const filePath = path.join(dir, "funnel-counts.json");
  const secret = "funnel-test-secret";
  const state = { created: null };
  const paypalFetch = async (url, options) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/v1/oauth2/token") return jsonResponse(200, { access_token: "tok_test", expires_in: 3200 });
    if (parsed.pathname === "/v2/checkout/orders" && options.method === "POST") {
      state.created = JSON.parse(options.body);
      return jsonResponse(201, { id: ORDER_ID, status: "CREATED" });
    }
    if (parsed.pathname === `/v2/checkout/orders/${ORDER_ID}/capture`) {
      const unit = state.created.purchase_units[0];
      return jsonResponse(201, {
        id: ORDER_ID,
        status: "COMPLETED",
        payer: { email_address: "parent@example.com" },
        purchase_units: [{
          items: unit.items,
          payments: {
            captures: [{ id: "CAP123456789012345", status: "COMPLETED", amount: unit.amount }],
          },
        }],
      });
    }
    return jsonResponse(500, { name: "UNKNOWN" });
  };
  const server = createServer({
    log() {},
    now: "2026-11-03T12:00:00Z",
    visitsFile: null,
    funnelFile: filePath,
    paypalOrdersFile: null,
    env: {
      VISITS_SECRET: secret,
      PAYPAL_CLIENT_ID: "AWtestclientid1234",
      PAYPAL_CLIENT_SECRET: "super-secret-value",
      PAYPAL_ENV: "sandbox",
      PAYPAL_WEBHOOK_ID: "WH-test-webhook-id",
    },
    paypalFetch,
    sendMail: async () => {},
  });
  const port = await listen(server);
  const origin = `http://127.0.0.1:${port}`;
  try {
    assert.strictEqual((await fetch(`${origin}/?utm_source=meta&utm_campaign=xmas&utm_content=uk&variant=explainer`)).status, 200);
    assert.strictEqual((await fetch(`${origin}/us?utm_source=meta&utm_campaign=xmas&utm_content=usa&variant=parents`)).status, 200);
    const prefetch = await fetch(`${origin}/us?utm_source=pre`, { headers: { Purpose: "prefetch" } });
    assert.strictEqual(prefetch.status, 200);

    const ukTap = await fetch(`${origin}/api/funnel`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ event: "order_tap", utm_source: "meta", utm_content: "uk", market: "uk", variant: "explainer" }),
    });
    assert.strictEqual(ukTap.status, 204);
    const usTap = await fetch(`${origin}/api/funnel`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ event: "order_tap", utm_source: "meta", utm_content: "usa", market: "us", variant: "parents", email: "parent@example.com" }),
    });
    assert.strictEqual(usTap.status, 204);

    const created = await fetch(`${origin}/api/paypal/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ package: "magicBundle", market: "us", utm_source: "meta", utm_content: "usa", variant: "parents", amount: "0.01" }),
    });
    assert.strictEqual(created.status, 201);
    assert.strictEqual(state.created.purchase_units[0].amount.currency_code, "USD");
    assert.strictEqual(state.created.purchase_units[0].amount.value, "19.99");

    const captured = await fetch(`${origin}/api/paypal/orders/${ORDER_ID}/capture`, {
      method: "POST",
      headers: { Origin: origin },
    });
    assert.strictEqual(captured.status, 200);
    const page = await fetch(`${origin}/order/continue?session_id=${ORDER_ID}`);
    const orderHtml = await page.text();
    assert.match(orderHtml, /data-purchase-currency="USD"/);
    assert.match(orderHtml, /data-purchase-value="19\.99"/);

    const report = await fetch(`${origin}/admin/funnel`, { headers: { Authorization: `Bearer ${secret}` } });
    const body = await report.json();
    const none = { singleVideo: 0, magicBundle: 0 };
    const ukPage = { view: 1, choice_open: 0, order_tap: 1, pay_click: 0, example_tap: 0, checkout_start: 0, checkout_complete: 0, packages: none, pay_packages: none };
    const usPage = { view: 1, choice_open: 0, order_tap: 1, pay_click: 0, example_tap: 0, checkout_start: 1, checkout_complete: 1, packages: none, pay_packages: none };
    assert.deepStrictEqual(body.markets.uk, ukPage);
    assert.deepStrictEqual(body.markets.us, usPage);
    assert.deepStrictEqual(body.variants.parents, usPage);
    assert.deepStrictEqual(body.total, { view: 2, choice_open: 0, order_tap: 2, pay_click: 0, example_tap: 0, checkout_start: 1, checkout_complete: 1, packages: none, pay_packages: none });
    assert.deepStrictEqual(body.total_uk, { view: 0, choice_open: 0, order_tap: 0, pay_click: 0, example_tap: 0, checkout_start: 0, checkout_complete: 0, packages: none, pay_packages: none });
    assert.ok(Array.isArray(body.countries));
    assert.strictEqual(body.countries.find((row) => row.country === "GB"), undefined);
    const unknown = body.countries.find((row) => row.country === "XX");
    assert.deepStrictEqual(
      {
        view: unknown.view,
        choice_open: unknown.choice_open,
        order_tap: unknown.order_tap,
        pay_click: unknown.pay_click,
        example_tap: unknown.example_tap,
        checkout_start: unknown.checkout_start,
        checkout_complete: unknown.checkout_complete,
        packages: unknown.packages,
        pay_packages: unknown.pay_packages,
      },
      body.total
    );
    const usRow = body.buckets.find((item) => item.utm_content === "usa");
    assert.strictEqual(usRow.market, "us");
    assert.strictEqual(usRow.country, "XX");
    assert.strictEqual(usRow.checkout_complete, 1);
    assert.doesNotMatch(JSON.stringify(body), /parent@|cookie|userAgent/i);
  } finally {
    await close(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
