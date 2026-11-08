"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { createServer } = require("../server");
const { resumeOrder } = require("../public/js/checkout-choice");
const { publicOrigin, orderCancelUrl, sessionParamsFromPaymentLink } = require("../lib/checkout-session");
const { createFunnelCounter, funnelFromSession } = require("../lib/funnel-counts");
const { clientIp, countryFromIp } = require("../lib/client-country");
const { sessionForPaidOrder } = require("../lib/quote");

const IP_GB = "81.2.69.142";
const IP_US = "8.8.8.8";
const IP_GB6 = "2a00:1450:4009:815::200e";
const COUNTS = ["view", "order_tap", "example_tap", "checkout_start", "checkout_complete"];

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
    "https://santasaysmyname.com/?package=singleVideo&siblings=4&utm_source=meta&utm_content=sao#checkout"
  );
  assert.deepStrictEqual(resumeOrder(cancel.split("?")[1]), {
    packageKey: "singleVideo",
    siblings: 4,
  });
  assert.doesNotMatch(cancel, /agreed=/);
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
  assert.doesNotMatch(built.params.cancel_url, /agreed=/);
  assert.match(built.params.cancel_url, /#checkout$/);
  assert.strictEqual(built.params.metadata.package, "bundle_early_bird");
  assert.strictEqual(built.params.metadata.utm_source, "meta");
  assert.strictEqual(built.params.metadata.ssm_market, "uk");
  const fromUs = sessionParamsFromPaymentLink(ukLink("gbp"), {
    origin: "https://santasaysmyname.com",
    market: "us",
    utm: { utm_source: "meta" },
  });
  assert.strictEqual(fromUs.params.metadata.ssm_market, "us");
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
    env: { VISITS_SECRET: secret, PAYMENT_PROVIDER: "stripe" },
    stripe,
  });
  const port = await listen(server);
  const origin = `http://127.0.0.1:${port}`;
  try {
    const home = await fetch(`${origin}/?utm_source=meta&utm_campaign=xmas&utm_content=video&variant=explainer`);
    assert.strictEqual(home.status, 200);
    assert.match(home.headers.get("set-cookie") || "", /^ssmn_variant=explainer;/);
    assert.doesNotMatch(home.headers.get("set-cookie") || "", /parent@|utm_source/);
    const html = await home.text();
    assert.match(html, /data-price="bundle">£16\.99</);
    assert.ok(html.indexOf('id="hero-order"') < html.indexOf('id="hear-santa"'));

    const tap = await fetch(`${origin}/api/funnel`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({
        event: "order_tap",
        utm_source: "meta",
        utm_campaign: "xmas",
        utm_content: "video",
        variant: "explainer",
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

    const pay = await fetch(`${origin}/order/pay?package=magicBundle&siblings=2&utm_source=meta&utm_campaign=xmas&utm_content=video&variant=explainer`, {
      redirect: "manual",
    });
    assert.strictEqual(pay.status, 302);
    assert.strictEqual(pay.headers.get("location"), "https://checkout.stripe.com/c/pay/cs_test_created1");
    const params = stripe.created[0];
    assert.strictEqual(params.cancel_url, `${origin}/?package=magicBundle&siblings=2&utm_source=meta&utm_campaign=xmas&utm_content=video&variant=explainer#checkout`);
    assert.strictEqual(params.metadata.variant, "explainer");
    assert.strictEqual(params.success_url, `${origin}/order/continue?session_id={CHECKOUT_SESSION_ID}`);
    assert.strictEqual(params.line_items[0].price, "price_bundle");

    const open = await fetch(`${origin}/admin/funnel`);
    assert.strictEqual(open.status, 401);
    const report = await fetch(`${origin}/admin/funnel`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    assert.strictEqual(report.status, 200);
    const body = await report.json();
    assert.deepStrictEqual(body.total, { view: 1, order_tap: 1, example_tap: 0, checkout_start: 1, checkout_complete: 0 });
    assert.strictEqual(body.variants.explainer.view, 1);
    assert.strictEqual(body.variants.explainer.order_tap, 1);
    assert.strictEqual(body.variants.parents.view, 0);
    const row = body.buckets.find((item) => item.utm_content === "video");
    assert.strictEqual(row.utm_source, "meta");
    assert.strictEqual(row.view, 1);
    assert.strictEqual(row.order_tap, 1);
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
    env: { VISITS_SECRET: "funnel-test-secret", PAYMENT_PROVIDER: "stripe" },
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
    const foreignAgain = await fetch(`http://127.0.0.1:${port}/order/continue?session_id=cs_test_usd123`);
    assert.strictEqual(foreignAgain.status, 200);
    const report = await fetch(`http://127.0.0.1:${port}/admin/funnel`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    const body = await report.json();
    assert.strictEqual(body.total.checkout_complete, 2);
    assert.strictEqual(body.markets.uk.checkout_complete, 1);
    assert.strictEqual(body.markets.us.checkout_complete, 1);
    const uk = body.buckets.find((row) => row.market === "uk");
    const us = body.buckets.find((row) => row.market === "us");
    assert.strictEqual(uk.utm_source, "meta");
    assert.strictEqual(uk.checkout_complete, 1);
    assert.strictEqual(uk.country, "XX");
    assert.strictEqual(us.checkout_complete, 1);
    assert.deepStrictEqual(body.total_uk, { view: 0, order_tap: 0, example_tap: 0, checkout_start: 0, checkout_complete: 0 });
  } finally {
    await close(server);
  }
});

function forwarded(ip, extra) {
  return { "x-forwarded-for": ip, ...extra };
}

function sumCounts(rows) {
  const total = { view: 0, order_tap: 0, example_tap: 0, checkout_start: 0, checkout_complete: 0 };
  for (const row of rows) {
    for (const event of COUNTS) total[event] += row[event];
  }
  return total;
}

test("country is read from the visitor address with a local database", () => {
  assert.strictEqual(clientIp({ headers: { "x-forwarded-for": `${IP_GB}, 10.0.0.1` }, socket: { remoteAddress: "127.0.0.1" } }), IP_GB);
  assert.strictEqual(clientIp({ headers: { "x-forwarded-for": `unknown, ${IP_US}` } }), IP_US);
  assert.strictEqual(clientIp({ headers: { "x-forwarded-for": "not-an-ip", "x-real-ip": `${IP_GB}:443` } }), IP_GB);
  assert.strictEqual(clientIp({ headers: { "x-forwarded-for": `${IP_US}, ${IP_GB}`, "x-real-ip": IP_GB } }), IP_US);
  assert.strictEqual(clientIp({ headers: { "x-forwarded-for": [`nope`, `"${IP_GB}"`] } }), IP_GB);
  assert.strictEqual(clientIp({ headers: { "x-forwarded-for": `[${IP_GB6}]` } }), IP_GB6);
  assert.strictEqual(clientIp({ headers: {}, socket: { remoteAddress: "::ffff:127.0.0.1" } }), "127.0.0.1");
  assert.strictEqual(clientIp({ headers: {} }), "");

  assert.strictEqual(countryFromIp(IP_GB), "GB");
  assert.strictEqual(countryFromIp(IP_US), "US");
  assert.strictEqual(countryFromIp(`::ffff:${IP_GB}`), "GB");
  assert.strictEqual(countryFromIp(IP_GB6), "GB");
  assert.strictEqual(countryFromIp("127.0.0.1"), "XX");
  assert.strictEqual(countryFromIp("10.1.2.3"), "XX");
  assert.strictEqual(countryFromIp("not-an-ip"), "XX");
  assert.strictEqual(countryFromIp(""), "XX");
  assert.strictEqual(countryFromIp(IP_US, () => ""), "XX");
  assert.strictEqual(countryFromIp(IP_US, () => "nope"), "XX");
  assert.strictEqual(countryFromIp(IP_GB, () => " gb "), "GB");
  assert.strictEqual(countryFromIp(IP_US, () => {
    throw new Error(IP_US);
  }), "XX");
});

test("old funnel files stay in the total and count as country unknown", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "santa-funnel-legacy-"));
  const filePath = path.join(dir, "funnel-counts.json");
  fs.writeFileSync(filePath, JSON.stringify({
    total: { view: 999, order_tap: 999, checkout_start: 999, checkout_complete: 999 },
    buckets: [{
      utm_source: "meta",
      utm_campaign: "xmas",
      utm_content: "video",
      view: 4,
      order_tap: 1,
      checkout_start: 1,
      checkout_complete: 0,
    }],
  }));
  try {
    const funnel = createFunnelCounter({ filePath });
    funnel.record("view", { utm_source: "meta", utm_campaign: "xmas", utm_content: "video" });
    funnel.record("view", { utm_source: "meta", utm_campaign: "xmas", utm_content: "video", country: " gb " });
    funnel.record("order_tap", { utm_source: "meta", utm_campaign: "xmas", utm_content: "video", country: "UK" });
    const body = funnel.snapshot();
    assert.deepStrictEqual(body.total, { view: 6, order_tap: 2, example_tap: 0, checkout_start: 1, checkout_complete: 0 });
    assert.deepStrictEqual(body.total_uk, { view: 1, order_tap: 0, example_tap: 0, checkout_start: 0, checkout_complete: 0 });
    const legacy = body.buckets.find((row) => row.country === "XX" && row.utm_content === "video");
    assert.strictEqual(legacy.view, 5);
    assert.strictEqual(legacy.order_tap, 1);
    const uk = body.buckets.find((row) => row.country === "GB");
    assert.strictEqual(uk.view, 1);
    assert.strictEqual(uk.order_tap, 0);
    const notUk = body.buckets.find((row) => row.country === "UK");
    assert.strictEqual(notUk.order_tap, 1);
    assert.deepStrictEqual(body.total, sumCounts(body.buckets));
    assert.deepStrictEqual(body.total_uk, sumCounts(body.buckets.filter((row) => row.country === "GB")));
    await funnel.flush();
    const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
    assert.strictEqual(saved.buckets.find((row) => row.view === 5).country, "XX");
    assert.doesNotMatch(JSON.stringify(saved), /ip|cookie/i);
    const again = createFunnelCounter({ filePath }).snapshot();
    assert.deepStrictEqual(again.total, body.total);
    assert.deepStrictEqual(again.total_uk, body.total_uk);
    assert.strictEqual(again.buckets.length, body.buckets.length);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("checkout keeps the country from the start, and a missing country stays unknown", () => {
  const quote = { packageType: "bundle_early_bird", totalPence: 1699, lines: [] };
  const carried = sessionForPaidOrder({
    orderId: "5O190127TN364715T",
    captureId: "CAP1",
    quote,
    email: "",
    createdSeconds: 1,
    utm: { utm_source: "meta", utm_campaign: "xmas", utm_content: "video" },
    country: "GB",
  });
  assert.strictEqual(carried.amount_total, 1699);
  assert.strictEqual(carried.currency, "gbp");
  assert.strictEqual(carried.metadata.country, "GB");
  assert.strictEqual(funnelFromSession(carried).country, "GB");
  assert.strictEqual(funnelFromSession(carried).utm_source, "meta");

  const legacy = sessionForPaidOrder({
    orderId: "5O190127TN364715T",
    captureId: "CAP1",
    quote,
    email: "",
    createdSeconds: 1,
    utm: { utm_source: "meta" },
  });
  assert.strictEqual(legacy.metadata.country, undefined);
  assert.strictEqual(funnelFromSession(legacy).country, "XX");

  const priced = sessionParamsFromPaymentLink(ukLink("gbp"), {
    origin: "https://santasaysmyname.com",
    packageKey: "magicBundle",
    siblings: 2,
    utm: { utm_source: "meta", utm_campaign: "xmas", utm_content: "video" },
    country: "GB",
  });
  assert.strictEqual(priced.params.metadata.country, "GB");
  assert.strictEqual(priced.params.metadata.utm_source, "meta");
  assert.deepStrictEqual(priced.params.line_items, [{ price: "price_bundle", quantity: 1 }]);
  assert.strictEqual(priced.params.line_items[0].price_data, undefined);
  assert.doesNotMatch(priced.params.cancel_url, /country|81\.2\.69\.142/);
  assert.match(priced.params.cancel_url, /#checkout$/);
  const untouched = sessionParamsFromPaymentLink(ukLink("gbp"), {
    origin: "https://santasaysmyname.com",
    utm: { utm_source: "meta" },
  });
  assert.strictEqual(untouched.params.metadata.country, undefined);
});

test("the report shows UK totals beside the overall total and does not keep the IP", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "santa-funnel-country-"));
  const filePath = path.join(dir, "funnel-counts.json");
  fs.writeFileSync(filePath, JSON.stringify({
    buckets: [{
      utm_source: "meta",
      utm_campaign: "xmas",
      utm_content: "video",
      view: 4,
      order_tap: 0,
      checkout_start: 0,
      checkout_complete: 0,
    }],
  }));
  const logs = [];
  const secret = "funnel-test-secret";
  const server = createServer({
    log: (message) => logs.push(message),
    now: "2026-10-31T12:00:00Z",
    visitsFile: null,
    funnelFile: filePath,
    env: { VISITS_SECRET: secret, PAYMENT_PROVIDER: "stripe" },
  });
  const port = await listen(server);
  const origin = `http://127.0.0.1:${port}`;
  const page = `${origin}/?utm_source=meta&utm_campaign=xmas&utm_content=video&country=GB&variant=explainer`;
  try {
    const home = await fetch(page, { headers: forwarded(IP_GB) });
    assert.strictEqual(home.status, 200);
    const html = await home.text();
    assert.match(html, /data-price="bundle">£16\.99</);
    assert.ok(!html.includes(IP_GB));
    assert.ok(!html.includes("St Albans"));

    const abroad = await fetch(page, { headers: forwarded(`${IP_US}, ${IP_GB}`, { "x-real-ip": IP_GB }) });
    assert.strictEqual(abroad.status, 200);
    await abroad.text();
    await fetch(page);
    await fetch(`${origin}/?utm_source=meta&utm_campaign=xmas&utm_content=first`, {
      headers: forwarded(IP_GB, { "x-real-ip": IP_US }),
    });
    await fetch(`${origin}/?utm_source=meta&utm_campaign=xmas&utm_content=real`, {
      headers: { "x-real-ip": IP_GB },
    });
    await fetch(`${origin}/?utm_source=meta&utm_campaign=xmas&utm_content=fallback`, {
      headers: { "x-forwarded-for": "unknown", "x-real-ip": IP_US },
    });
    await fetch(`${origin}/?utm_source=meta&utm_campaign=xmas&utm_content=v6`, {
      headers: { "x-forwarded-for": `[${IP_GB6}]` },
    });
    await fetch(`${origin}/?utm_source=meta&utm_campaign=xmas&utm_content=mapped`, {
      headers: { "x-forwarded-for": `::ffff:${IP_US}` },
    });

    const tap = await fetch(`${origin}/api/funnel`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, ...forwarded(IP_GB) },
      body: JSON.stringify({
        event: "order_tap",
        utm_source: "meta",
        utm_campaign: "xmas",
        utm_content: "video",
        variant: "explainer",
        country: "US",
        email: "parent@example.com",
      }),
    });
    assert.strictEqual(tap.status, 204);

    const report = await fetch(`${origin}/admin/funnel`, { headers: { Authorization: `Bearer ${secret}` } });
    const body = await report.json();
    assert.deepStrictEqual(body.total, sumCounts(body.buckets));
    assert.deepStrictEqual(body.total_uk, sumCounts(body.buckets.filter((row) => row.country === "GB")));
    const gb = body.countries.find((row) => row.country === "GB");
    assert.deepStrictEqual(body.total_uk, {
      view: gb.view,
      order_tap: gb.order_tap,
      example_tap: gb.example_tap,
      checkout_start: gb.checkout_start,
      checkout_complete: gb.checkout_complete,
    });
    const videoGb = body.buckets.find((row) => row.utm_content === "video" && row.country === "GB");
    const videoUs = body.buckets.find((row) => row.utm_content === "video" && row.country === "US");
    const videoXxViews = body.buckets
      .filter((row) => row.utm_content === "video" && row.country === "XX")
      .reduce((sum, row) => sum + row.view, 0);
    assert.strictEqual(videoGb.view, 1);
    assert.strictEqual(videoGb.order_tap, 1);
    assert.strictEqual(videoGb.variant, "explainer");
    assert.strictEqual(videoUs.view, 1);
    assert.strictEqual(videoUs.order_tap, 0);
    assert.strictEqual(videoXxViews, 5);
    assert.strictEqual(body.buckets.find((row) => row.utm_content === "first").country, "GB");
    assert.strictEqual(body.buckets.find((row) => row.utm_content === "real").country, "GB");
    assert.strictEqual(body.buckets.find((row) => row.utm_content === "fallback").country, "US");
    assert.strictEqual(body.buckets.find((row) => row.utm_content === "v6").country, "GB");
    assert.strictEqual(body.buckets.find((row) => row.utm_content === "mapped").country, "US");
    assert.ok(body.total.view > body.total_uk.view);
    assert.ok(body.total_uk.view >= 1);
    const saved = JSON.stringify(body) + logs.join("\n");
    assert.ok(!saved.includes(IP_GB));
    assert.ok(!saved.includes(IP_US));
    assert.ok(!saved.includes(IP_GB6));
    assert.ok(!saved.includes("St Albans"));
    assert.doesNotMatch(saved, /parent@|cookie|userAgent/i);
  } finally {
    await close(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed country lookup still serves the page and counts the event as unknown", async () => {
  const logs = [];
  const server = createServer({
    log: (message) => logs.push(String(message)),
    visitsFile: null,
    funnelFile: null,
    env: { VISITS_SECRET: "funnel-test-secret", PAYMENT_PROVIDER: "stripe" },
    countryLookup() {
      throw new Error(`lookup failed for ${IP_GB}`);
    },
  });
  const port = await listen(server);
  try {
    const home = await fetch(`http://127.0.0.1:${port}/`, { headers: forwarded(IP_GB) });
    assert.strictEqual(home.status, 200);
    await home.text();
    const report = await fetch(`http://127.0.0.1:${port}/admin/funnel`, {
      headers: { "X-Visits-Secret": "funnel-test-secret" },
    });
    const body = await report.json();
    assert.strictEqual(body.total.view, 1);
    assert.strictEqual(body.total_uk.view, 0);
    assert.strictEqual(body.buckets[0].country, "XX");
    assert.ok(!logs.join("\n").includes(IP_GB));
  } finally {
    await close(server);
  }
});

test("stripe checkout stores the country, and completion keeps it", async () => {
  const logs = [];
  const stripe = fakeStripe(ukLink("gbp"));
  let n = 0;
  stripe.checkout.sessions.create = async (params) => {
    n += 1;
    const id = `cs_test_country${n}`;
    stripe.created.push({ id, params });
    return { id, url: `https://checkout.stripe.com/c/pay/${id}` };
  };
  stripe.checkout.sessions.update = async () => ({});
  const secret = "funnel-test-secret";
  const server = createServer({
    log: (message) => logs.push(String(message)),
    now: "2026-10-31T12:00:00Z",
    visitsFile: null,
    funnelFile: null,
    emailWaitMs: 0,
    webhookEmailWaitMs: 0,
    env: {
      VISITS_SECRET: secret,
      PAYMENT_PROVIDER: "stripe",
      STRIPE_SECRET_KEY: "rk_test_secret",
      STRIPE_WEBHOOK_SECRET: "whsec_test",
    },
    stripe,
    constructWebhookEvent: () => ({
      type: "checkout.session.completed",
      data: { object: { id: stripe.created[0].id } },
    }),
    retrieveSession: async (id) => {
      const found = stripe.created.find((row) => row.id === id);
      return {
        id,
        payment_status: "paid",
        amount_total: 1699,
        currency: "gbp",
        metadata: found ? found.params.metadata : {},
        line_items: { data: [{ description: "Magic bundle", quantity: 1, price: { unit_amount: 1699, currency: "gbp" } }] },
      };
    },
  });
  const port = await listen(server);
  const origin = `http://127.0.0.1:${port}`;
  const payUrl = `${origin}/order/pay?package=magicBundle&siblings=2&utm_source=meta&utm_campaign=xmas&utm_content=video`;
  try {
    const gb = await fetch(payUrl, { redirect: "manual", headers: forwarded(IP_GB) });
    assert.strictEqual(gb.status, 302);
    const gbAgain = await fetch(payUrl, { redirect: "manual", headers: forwarded(IP_GB) });
    assert.strictEqual(gbAgain.status, 302);
    const us = await fetch(payUrl, { redirect: "manual", headers: forwarded(IP_US) });
    assert.strictEqual(us.status, 302);

    assert.strictEqual(stripe.created.length, 3);
    assert.strictEqual(stripe.created[0].params.metadata.country, "GB");
    assert.strictEqual(stripe.created[1].params.metadata.country, "GB");
    assert.strictEqual(stripe.created[2].params.metadata.country, "US");
    for (const row of stripe.created) {
      assert.strictEqual(row.params.mode, "payment");
      assert.strictEqual(row.params.line_items[0].price, "price_bundle");
      assert.strictEqual(row.params.line_items[0].quantity, 1);
      assert.strictEqual(row.params.line_items[0].price_data, undefined);
      assert.strictEqual(row.params.metadata.utm_source, "meta");
      assert.strictEqual(row.params.success_url, `${origin}/order/continue?session_id={CHECKOUT_SESSION_ID}`);
      assert.strictEqual(row.params.cancel_url, `${origin}/?package=magicBundle&siblings=2&utm_source=meta&utm_campaign=xmas&utm_content=video#checkout`);
      assert.ok(!JSON.stringify(row.params).includes(IP_GB));
      assert.ok(!JSON.stringify(row.params).includes(IP_US));
      assert.ok(!JSON.stringify(row.params).includes("St Albans"));
    }

    const hook = await fetch(`${origin}/stripe/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "stripe-signature": "ok", ...forwarded(IP_US) },
      body: "{}",
    });
    assert.strictEqual(hook.status, 200);
    const again = await fetch(`${origin}/stripe/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "stripe-signature": "ok", ...forwarded(IP_US) },
      body: "{}",
    });
    assert.strictEqual(again.status, 200);

    const done = await fetch(`${origin}/order/continue?session_id=${stripe.created[1].id}`, { headers: forwarded(IP_US) });
    assert.strictEqual(done.status, 200);
    await done.text();
    const doneAgain = await fetch(`${origin}/order/continue?session_id=${stripe.created[1].id}`, { headers: forwarded(IP_GB) });
    assert.strictEqual(doneAgain.status, 200);
    await doneAgain.text();

    const report = await fetch(`${origin}/admin/funnel`, { headers: { Authorization: `Bearer ${secret}` } });
    const body = await report.json();
    const gbRow = body.buckets.find((row) => row.country === "GB" && row.utm_content === "video");
    const usRow = body.buckets.find((row) => row.country === "US" && row.utm_content === "video");
    assert.strictEqual(gbRow.checkout_start, 2);
    assert.strictEqual(gbRow.checkout_complete, 2);
    assert.strictEqual(usRow.checkout_start, 1);
    assert.strictEqual(usRow.checkout_complete, 0);
    assert.strictEqual(body.total.checkout_start, 3);
    assert.strictEqual(body.total.checkout_complete, 2);
    assert.strictEqual(body.total_uk.checkout_start, 2);
    assert.strictEqual(body.total_uk.checkout_complete, 2);
    assert.ok(!JSON.stringify(body).includes(IP_GB));
    assert.ok(!JSON.stringify(body).includes(IP_US));
    assert.ok(!logs.join("\n").includes(IP_GB));
    assert.ok(!logs.join("\n").includes(IP_US));
  } finally {
    await close(server);
  }
});

test("paypal checkout stores the country on the order and completion reuses it", async () => {
  const logs = [];
  const ORDER_ID = "5O190127TN364715T";
  const state = { created: null };
  const paypalFetch = async (url, options) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/v1/oauth2/token") {
      return { ok: true, status: 200, async text() { return JSON.stringify({ access_token: "tok_test", expires_in: 3200 }); } };
    }
    if (parsed.pathname === "/v2/checkout/orders" && options.method === "POST") {
      state.created = JSON.parse(options.body);
      return { ok: true, status: 201, async text() { return JSON.stringify({ id: ORDER_ID, status: "CREATED" }); } };
    }
    if (parsed.pathname === `/v2/checkout/orders/${ORDER_ID}/capture`) {
      return {
        ok: true,
        status: 201,
        async text() {
          return JSON.stringify({
            id: ORDER_ID,
            status: "COMPLETED",
            payer: { email_address: "parent@example.com" },
            purchase_units: [{
              payments: {
                captures: [{ id: "CAP123456789012345", status: "COMPLETED", amount: { currency_code: "GBP", value: "16.99" } }],
              },
            }],
          });
        },
      };
    }
    if (parsed.pathname === `/v2/checkout/orders/${ORDER_ID}`) {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ id: ORDER_ID, status: "COMPLETED", payer: { email_address: "parent@example.com" } });
        },
      };
    }
    throw new Error(`unexpected ${url}`);
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "santa-funnel-paypal-"));
  const ordersPath = path.join(dir, "orders.json");
  const secret = "funnel-test-secret";
  const server = createServer({
    log: (message) => logs.push(String(message)),
    now: "2026-10-31T12:00:00Z",
    visitsFile: null,
    funnelFile: null,
    paypalOrdersFile: ordersPath,
    emailWaitMs: 0,
    webhookEmailWaitMs: 0,
    paypalFetch,
    verifyPaypalWebhook: async () => true,
    env: {
      VISITS_SECRET: secret,
      PAYMENT_PROVIDER: "paypal",
      PAYPAL_CLIENT_ID: "AWtestclientid1234",
      PAYPAL_CLIENT_SECRET: "paypal-secret",
      PAYPAL_ENV: "sandbox",
      PAYPAL_WEBHOOK_ID: "WH-test-webhook",
    },
  });
  const port = await listen(server);
  const origin = `http://127.0.0.1:${port}`;
  try {
    const created = await fetch(`${origin}/api/paypal/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, ...forwarded(IP_GB) },
      body: JSON.stringify({
        package: "magicBundle",
        amount: "0.01",
        currency: "USD",
        country: "US",
        email: "parent@example.com",
        utm_source: "meta",
        utm_campaign: "xmas",
        utm_content: "video",
      }),
    });
    assert.strictEqual(created.status, 201);
    const createdBody = await created.json();
    assert.strictEqual(createdBody.id, ORDER_ID);
    assert.strictEqual(state.created.purchase_units[0].amount.currency_code, "GBP");
    assert.strictEqual(state.created.purchase_units[0].amount.value, "16.99");
    assert.strictEqual(state.created.purchase_units[0].custom_id, "v1|e|0|0|0|meta|xmas|video");
    const paypalBody = JSON.stringify(state.created);
    assert.ok(!paypalBody.includes(IP_GB));
    assert.ok(!paypalBody.includes("St Albans"));
    assert.doesNotMatch(paypalBody, /"country"/);

    const stored = JSON.parse(fs.readFileSync(ordersPath, "utf8"));
    assert.strictEqual(stored[ORDER_ID].country, "GB");
    assert.deepStrictEqual(stored[ORDER_ID].utm, {
      utm_source: "meta",
      utm_campaign: "xmas",
      utm_content: "video",
    });
    assert.strictEqual(stored[ORDER_ID].quote.totalPence, 1699);
    assert.ok(!JSON.stringify(stored).includes(IP_GB));
    assert.ok(!JSON.stringify(stored).includes("parent@example.com"));

    const captured = await fetch(`${origin}/api/paypal/orders/${ORDER_ID}/capture`, {
      method: "POST",
      headers: { Origin: origin, ...forwarded(IP_US) },
    });
    assert.strictEqual(captured.status, 200);
    const hook = await fetch(`${origin}/paypal/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "paypal-transmission-id": "trans-1",
        ...forwarded(IP_US),
      },
      body: JSON.stringify({
        event_type: "PAYMENT.CAPTURE.COMPLETED",
        resource: { supplementary_data: { related_ids: { order_id: ORDER_ID } } },
      }),
    });
    assert.strictEqual(hook.status, 200);
    const page = await fetch(`${origin}/order/continue?session_id=${ORDER_ID}`, { headers: forwarded(IP_US) });
    assert.strictEqual(page.status, 200);
    const orderHtml = await page.text();
    assert.match(orderHtml, /data-purchase-value="16\.99"/);
    assert.ok(!orderHtml.includes(IP_GB));
    assert.ok(!orderHtml.includes(IP_US));

    const after = JSON.parse(fs.readFileSync(ordersPath, "utf8"));
    assert.strictEqual(after[ORDER_ID].country, "GB");
    assert.strictEqual(after[ORDER_ID].status, "COMPLETED");
    assert.ok(!JSON.stringify(after).includes(IP_US));

    const report = await fetch(`${origin}/admin/funnel`, { headers: { Authorization: `Bearer ${secret}` } });
    const body = await report.json();
    const row = body.buckets.find((item) => item.utm_content === "video" && item.country === "GB");
    assert.strictEqual(row.checkout_start, 1);
    assert.strictEqual(row.checkout_complete, 1);
    assert.strictEqual(body.total.checkout_complete, 1);
    assert.strictEqual(body.total_uk.checkout_start, 1);
    assert.strictEqual(body.total_uk.checkout_complete, 1);
    assert.ok(!body.buckets.some((item) => item.country === "US" && item.checkout_complete > 0));
    assert.ok(!JSON.stringify(body).includes(IP_GB));
    assert.ok(!JSON.stringify(body).includes(IP_US));
    assert.ok(!logs.join("\n").includes(IP_GB));
    assert.ok(!logs.join("\n").includes(IP_US));
    assert.ok(!logs.join("\n").includes("paypal-secret"));
  } finally {
    await close(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
