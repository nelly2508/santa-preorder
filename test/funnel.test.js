"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { createServer } = require("../server");
const { resumeOrder } = require("../public/js/checkout-choice");
const { publicOrigin, orderCancelUrl, sessionParamsFromPaymentLink } = require("../lib/checkout-session");

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

function ukLink(currency) {
  return {
    id: "plink_uk",
    url: EARLY_BUNDLE,
    currency,
    metadata: { package: "bundle_early_bird" },
    allow_promotion_codes: false,
    line_items: {
      data: [{ price: { id: "price_bundle", currency, unit_amount: 1699 }, quantity: 1 }],
    },
    optional_items: [{
      price: "price_sibling",
      quantity: 1,
      adjustable_quantity: { enabled: true, minimum: 0, maximum: 4 },
    }],
  };
}

function fakeStripe(link) {
  const created = [];
  return {
    created,
    paymentLinks: {
      async list() {
        return { data: [{ id: link.id, url: link.url }], has_more: false };
      },
      async retrieve() {
        return link;
      },
    },
    checkout: {
      sessions: {
        async create(params) {
          created.push(params);
          return { id: "cs_test_created1", url: "https://checkout.stripe.com/c/pay/cs_test_created1" };
        },
      },
    },
  };
}

test("cancel url returns to the UK order page and keeps the form", () => {
  assert.strictEqual(publicOrigin({}, "evil.example"), "https://santasaysmyname.com");
  assert.strictEqual(publicOrigin({}, "127.0.0.1:3000"), "http://127.0.0.1:3000");
  assert.strictEqual(publicOrigin({ PUBLIC_ORIGIN: "javascript:alert(1)" }, "evil.example"), "https://santasaysmyname.com");

  const cancel = orderCancelUrl("https://santasaysmyname.com", {
    packageKey: "singleVideo",
    siblings: 9,
    utm: { utm_source: "meta", utm_campaign: "parent@example.com", utm_content: "sao" },
  });
  assert.strictEqual(
    cancel,
    "https://santasaysmyname.com/?package=singleVideo&siblings=4&agreed=1&utm_source=meta&utm_content=sao#checkout"
  );
  assert.deepStrictEqual(resumeOrder(cancel.split("?")[1]), {
    packageKey: "singleVideo",
    siblings: 4,
    agreed: true,
  });
});

test("a checkout session copies the GBP payment link and leaves other currencies alone", () => {
  const built = sessionParamsFromPaymentLink(ukLink("gbp"), {
    origin: "https://santasaysmyname.com",
    packageKey: "magicBundle",
    siblings: 2,
    utm: { utm_source: "meta", utm_campaign: "xmas", utm_content: "video" },
  });
  assert.strictEqual(built.params.mode, "payment");
  assert.deepStrictEqual(built.params.line_items, [{ price: "price_bundle", quantity: 1 }]);
  assert.strictEqual(built.params.optional_items[0].price, "price_sibling");
  assert.strictEqual(built.params.optional_items[0].adjustable_quantity.maximum, 4);
  assert.strictEqual(built.params.success_url, "https://santasaysmyname.com/order/continue?session_id={CHECKOUT_SESSION_ID}");
  assert.match(built.params.cancel_url, /^https:\/\/santasaysmyname\.com\/\?/);
  assert.match(built.params.cancel_url, /package=magicBundle/);
  assert.match(built.params.cancel_url, /siblings=2/);
  assert.match(built.params.cancel_url, /agreed=1/);
  assert.match(built.params.cancel_url, /#checkout$/);
  assert.strictEqual(built.params.metadata.package, "bundle_early_bird");
  assert.strictEqual(built.params.metadata.utm_source, "meta");
  assert.strictEqual(built.params.line_items[0].price_data, undefined);
  assert.strictEqual(sessionParamsFromPaymentLink(ukLink("usd"), { origin: "https://santasaysmyname.com" }).skip, "not-gbp");
});

test("funnel counts are aggregate, and checkout cancel_url points at the order page", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "santa-funnel-"));
  const filePath = path.join(dir, "funnel-counts.json");
  const secret = "funnel-test-secret";
  const stripe = fakeStripe(ukLink("gbp"));
  const server = createServer({
    log() {},
    now: "2026-10-31T12:00:00Z",
    visitsFile: null,
    funnelFile: filePath,
    env: { VISITS_SECRET: secret },
    stripe,
  });
  const port = await listen(server);
  const origin = `http://127.0.0.1:${port}`;
  try {
    const home = await fetch(`${origin}/?utm_source=meta&utm_campaign=xmas&utm_content=video`);
    assert.strictEqual(home.status, 200);
    assert.strictEqual(home.headers.get("set-cookie"), null);
    const html = await home.text();
    assert.match(html, /data-price="bundle">£16\.99</);
    assert.ok(html.indexOf('id="hero-order"') < html.indexOf('id="hear-santa"'));
    assert.ok(html.indexOf('src="js/funnel-beacon.js"') < html.indexOf('src="js/main.js"'));

    const beacon = await fetch(`${origin}/api/funnel`, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8", Origin: origin },
      body: JSON.stringify({
        event: "order_tap",
        utm_source: "meta",
        utm_campaign: "xmas",
        utm_content: "video",
      }),
    });
    assert.strictEqual(beacon.status, 204);
    assert.strictEqual(beacon.headers.get("set-cookie"), null);

    const tap = await fetch(`${origin}/api/funnel`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({
        event: "order_tap",
        utm_source: "meta",
        utm_campaign: "xmas",
        utm_content: "video",
        email: "parent@example.com",
      }),
    });
    assert.strictEqual(tap.status, 204);
    assert.strictEqual(tap.headers.get("set-cookie"), null);

    const rejected = await fetch(`${origin}/api/funnel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "checkout_complete", utm_source: "meta" }),
    });
    assert.strictEqual(rejected.status, 400);

    const foreign = await fetch(`${origin}/api/funnel`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ event: "order_tap", utm_source: "meta" }),
    });
    assert.strictEqual(foreign.status, 400);

    const pay = await fetch(`${origin}/order/pay?package=magicBundle&siblings=2&utm_source=meta&utm_campaign=xmas&utm_content=video`, {
      redirect: "manual",
    });
    assert.strictEqual(pay.status, 302);
    assert.strictEqual(pay.headers.get("location"), "https://checkout.stripe.com/c/pay/cs_test_created1");
    const params = stripe.created[0];
    assert.strictEqual(params.cancel_url, `${origin}/?package=magicBundle&siblings=2&agreed=1&utm_source=meta&utm_campaign=xmas&utm_content=video#checkout`);
    assert.strictEqual(params.success_url, `${origin}/order/continue?session_id={CHECKOUT_SESSION_ID}`);
    assert.strictEqual(params.line_items[0].price, "price_bundle");

    const open = await fetch(`${origin}/admin/funnel`);
    assert.strictEqual(open.status, 401);
    const report = await fetch(`${origin}/admin/funnel`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    assert.strictEqual(report.status, 200);
    const body = await report.json();
    assert.deepStrictEqual(body.total, { view: 1, order_tap: 2, checkout_start: 1, checkout_complete: 0 });
    const row = body.buckets.find((item) => item.utm_content === "video");
    assert.strictEqual(row.utm_source, "meta");
    assert.strictEqual(row.view, 1);
    assert.strictEqual(row.order_tap, 2);
    assert.strictEqual(row.checkout_start, 1);
    assert.doesNotMatch(JSON.stringify(body), /parent@|ip|cookie|userAgent/i);
    assert.doesNotMatch(JSON.stringify(body), new RegExp(secret));
  } finally {
    await close(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a non-GBP payment link stays a payment link and is not counted as a checkout start", async () => {
  const stripe = fakeStripe(ukLink("usd"));
  const server = createServer({
    log() {},
    now: "2026-10-31T12:00:00Z",
    visitsFile: null,
    funnelFile: null,
    env: { VISITS_SECRET: "funnel-test-secret" },
    stripe,
  });
  const port = await listen(server);
  try {
    const pay = await fetch(`http://127.0.0.1:${port}/order/pay?package=magicBundle`, { redirect: "manual" });
    assert.strictEqual(pay.status, 302);
    assert.strictEqual(pay.headers.get("location"), EARLY_BUNDLE);
    assert.strictEqual(stripe.created.length, 0);
    const report = await fetch(`http://127.0.0.1:${port}/admin/funnel`, {
      headers: { "X-Visits-Secret": "funnel-test-secret" },
    });
    const body = await report.json();
    assert.strictEqual(body.total.checkout_start, 0);
  } finally {
    await close(server);
  }
});

test("a paid GBP checkout is counted once", async () => {
  const secret = "funnel-test-secret";
  const session = {
    id: "cs_test_paid123",
    payment_status: "paid",
    amount_total: 1699,
    currency: "gbp",
    metadata: { utm_source: "meta", utm_campaign: "xmas", utm_content: "video" },
    line_items: { data: [{ description: "Magic bundle", quantity: 1, price: { unit_amount: 1699, currency: "gbp" } }] },
  };
  const server = createServer({
    log() {},
    visitsFile: null,
    funnelFile: null,
    env: { VISITS_SECRET: secret, STRIPE_SECRET_KEY: "rk_test_secret" },
    retrieveSession: async (id) => {
      if (id === "cs_test_usd123") {
        return { ...session, id, currency: "usd" };
      }
      return session;
    },
  });
  const port = await listen(server);
  try {
    const first = await fetch(`http://127.0.0.1:${port}/order/continue?session_id=cs_test_paid123`);
    assert.strictEqual(first.status, 200);
    const second = await fetch(`http://127.0.0.1:${port}/order/continue?session_id=cs_test_paid123`);
    assert.strictEqual(second.status, 200);
    const foreign = await fetch(`http://127.0.0.1:${port}/order/continue?session_id=cs_test_usd123`);
    assert.strictEqual(foreign.status, 200);
    const report = await fetch(`http://127.0.0.1:${port}/admin/funnel`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    const body = await report.json();
    assert.strictEqual(body.total.checkout_complete, 1);
    assert.strictEqual(body.buckets[0].utm_source, "meta");
    assert.strictEqual(body.buckets[0].checkout_complete, 1);
  } finally {
    await close(server);
  }
});
