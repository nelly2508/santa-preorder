"use strict";

const assert = require("assert");
const test = require("node:test");
const { createServer } = require("../server");
const { resolveOrderRedirect, summariseCheckout } = require("../lib/order-continue");

function line({ quantity = 1, description = "", sku = "", packageName = "", productSku = "", productName = "", unitAmount, currency = "gbp" }) {
  const product = productSku || productName ? { name: productName, metadata: productSku ? { sku: productSku } : {} } : "prod_x";
  const metadata = {};
  if (sku) metadata.sku = sku;
  if (packageName) metadata.package = packageName;
  return {
    quantity,
    description,
    price: {
      currency,
      unit_amount: unitAmount,
      nickname: "",
      metadata,
      product,
    },
  };
}

function paid(lines, metadata) {
  return {
    payment_status: "paid",
    metadata: metadata || {},
    line_items: { data: lines },
  };
}

test("children is 1 when nobody buys the sibling add-on", () => {
  const summary = summariseCheckout(paid([line({ description: "Magic bundle", unitAmount: 1999 })]));
  assert.strictEqual(summary.children, 1);
});

test("children adds the sibling quantity from price metadata, product metadata, or the product name", () => {
  const byPrice = summariseCheckout(paid([
    line({ description: "Magic bundle", unitAmount: 1999 }),
    line({ description: "Extra child", sku: "addon_sibling", quantity: 2 }),
  ]));
  const byProduct = summariseCheckout(paid([
    line({ description: "Single video", unitAmount: 1499 }),
    line({ description: "Add-on", productSku: "addon_sibling", quantity: 4 }),
  ]));
  const byName = summariseCheckout(paid([
    line({ description: "Single video", unitAmount: 1499 }),
    line({ description: "Sibling", quantity: 1 }),
  ]));
  assert.strictEqual(byPrice.children, 3);
  assert.strictEqual(byProduct.children, 5);
  assert.strictEqual(byName.children, 2);
});

test("several sibling rows are added together, and a zero quantity does not count", () => {
  const summary = summariseCheckout(paid([
    line({ description: "Magic bundle early bird", unitAmount: 1699 }),
    line({ description: "Sibling", quantity: 1 }),
    line({ sku: "addon_sibling", description: "Sibling", quantity: 2 }),
    line({ sku: "addon_sibling", description: "Sibling", quantity: 0 }),
  ]));
  assert.strictEqual(summary.children, 4);
});

test("rush and sleigh come from sku or name, and both bundles include the sleigh", () => {
  const early = summariseCheckout(paid([
    line({ description: "Magic bundle early bird", unitAmount: 1699 }),
    line({ sku: "addon_rush", description: "Faster", quantity: 1 }),
  ]));
  const bundle = summariseCheckout(paid([
    line({ description: "Magic bundle", packageName: "bundle" }),
  ], { package: "bundle" }));
  const singleWithSleigh = summariseCheckout(paid([
    line({ description: "Single video", unitAmount: 1499 }),
    line({ description: "Named sleigh video", quantity: 1 }),
  ]));
  const singlePlain = summariseCheckout(paid([
    line({ description: "Single video", unitAmount: 1499 }),
    line({ description: "Rush", quantity: 1 }),
  ]));
  assert.deepStrictEqual(
    { rush: early.rush, sleigh: early.sleigh, packageType: early.packageType },
    { rush: true, sleigh: true, packageType: "bundle_early_bird" }
  );
  assert.strictEqual(bundle.sleigh, true);
  assert.strictEqual(bundle.packageType, "bundle");
  assert.deepStrictEqual(
    { rush: singleWithSleigh.rush, sleigh: singleWithSleigh.sleigh, packageType: singleWithSleigh.packageType },
    { rush: false, sleigh: true, packageType: "single" }
  );
  assert.deepStrictEqual(
    { rush: singlePlain.rush, sleigh: singlePlain.sleigh, packageType: singlePlain.packageType },
    { rush: true, sleigh: false, packageType: "single" }
  );
});

test("package prefers the payment link metadata, then the price", () => {
  const fromLink = summariseCheckout(paid([
    line({ description: "Video", unitAmount: 1999 }),
  ], { package: "single" }));
  const fromPrice = summariseCheckout(paid([
    line({ description: "Video", packageName: "bundle_early_bird", unitAmount: 1999 }),
  ]));
  const fromAmount = summariseCheckout(paid([
    line({ description: "Video", unitAmount: 1699 }),
  ]));
  assert.strictEqual(fromLink.packageType, "single");
  assert.strictEqual(fromLink.sleigh, false);
  assert.strictEqual(fromPrice.packageType, "bundle_early_bird");
  assert.strictEqual(fromAmount.packageType, "bundle_early_bird");
});

test("a paid session redirects to Tally with children, rush, sleigh and package", async () => {
  const calls = [];
  const location = await resolveOrderRedirect({
    sessionId: "cs_live_abc123",
    env: { STRIPE_SECRET_KEY: "rk_live_secret", STRIPE_TEST_SECRET_KEY: "rk_test_secret" },
    log() {},
    retrieveSession(sessionId, key) {
      calls.push({ sessionId, key });
      return paid([
        line({ description: "Magic bundle", unitAmount: 1999 }),
        line({ sku: "addon_sibling", description: "Sibling", quantity: 2 }),
        line({ description: "Rush", quantity: 1 }),
      ]);
    },
  });
  assert.deepStrictEqual(calls, [{ sessionId: "cs_live_abc123", key: "rk_live_secret" }]);
  assert.strictEqual(
    location,
    "https://tally.so/r/Dq25LE?order=cs_live_abc123&children=3&rush=1&sleigh=1&package=bundle"
  );
});

test("a sandbox session uses the test key and the same children calculation", async () => {
  const keys = [];
  const location = await resolveOrderRedirect({
    sessionId: "cs_test_sandbox1",
    env: { STRIPE_SECRET_KEY: "rk_live_secret", STRIPE_TEST_SECRET_KEY: "rk_test_secret" },
    log() {},
    retrieveSession(sessionId, key) {
      keys.push(key);
      return paid([line({ description: "Single video" }), line({ productSku: "addon_sibling", quantity: 1 })]);
    },
  });
  assert.deepStrictEqual(keys, ["rk_test_secret"]);
  assert.strictEqual(
    location,
    "https://tally.so/r/Dq25LE?order=cs_test_sandbox1&children=2&rush=0&sleigh=0&package=single"
  );
});

test("without a test key, a sandbox session uses the main secret", async () => {
  let seen = "";
  await resolveOrderRedirect({
    sessionId: "cs_test_onlymain",
    env: { STRIPE_SECRET_KEY: "rk_test_only" },
    log() {},
    retrieveSession(_sessionId, key) {
      seen = key;
      return paid([line({ description: "Single video" })]);
    },
  });
  assert.strictEqual(seen, "rk_test_only");
});

test("a paid session adds the buyer email, and leaves it off when Stripe has none", async () => {
  const withEmail = await resolveOrderRedirect({
    sessionId: "cs_live_mail1",
    env: { STRIPE_SECRET_KEY: "rk_live_secret" },
    log() {},
    retrieveSession() {
      return {
        ...paid([line({ description: "Single video", unitAmount: 1499 })]),
        customer_details: { email: " parent+tag@example.com " },
      };
    },
  });
  assert.strictEqual(
    withEmail,
    "https://tally.so/r/Dq25LE?order=cs_live_mail1&children=1&rush=0&sleigh=0&package=single&email=parent%2Btag%40example.com"
  );

  const withoutEmail = await resolveOrderRedirect({
    sessionId: "cs_live_nomail",
    env: { STRIPE_SECRET_KEY: "rk_live_secret" },
    log() {},
    retrieveSession() {
      return paid([line({ description: "Single video", unitAmount: 1499 })]);
    },
  });
  assert.strictEqual(
    withoutEmail,
    "https://tally.so/r/Dq25LE?order=cs_live_nomail&children=1&rush=0&sleigh=0&package=single"
  );
  assert.strictEqual(new URL(withoutEmail).searchParams.has("email"), false);

  const blankEmail = await resolveOrderRedirect({
    sessionId: "cs_live_blankmail",
    env: { STRIPE_SECRET_KEY: "rk_live_secret" },
    log() {},
    retrieveSession() {
      return {
        ...paid([line({ description: "Single video", unitAmount: 1499 })]),
        customer_details: { email: "   " },
      };
    },
  });
  assert.strictEqual(new URL(blankEmail).searchParams.has("email"), false);
});

test("an unpaid, invalid, or failed session still reaches Tally with only the order id", async () => {
  const logs = [];
  const unpaid = await resolveOrderRedirect({
    sessionId: "cs_live_unpaid1",
    env: { STRIPE_SECRET_KEY: "rk_live_secret" },
    log(message) { logs.push(message); },
    retrieveSession() {
      return {
        payment_status: "unpaid",
        customer_details: { email: "unpaid@example.com" },
        line_items: { data: [line({ description: "Single video" })] },
      };
    },
  });
  const broken = await resolveOrderRedirect({
    sessionId: "cs_test_broken1",
    env: { STRIPE_SECRET_KEY: "rk_test_secret" },
    log(message) { logs.push(message); },
    retrieveSession() {
      throw new Error("stripe unavailable");
    },
  });
  const invalid = await resolveOrderRedirect({
    sessionId: "not-a-session",
    env: { STRIPE_SECRET_KEY: "rk_live_secret" },
    log(message) { logs.push(message); },
    retrieveSession() {
      throw new Error("should not be called");
    },
  });
  assert.strictEqual(unpaid, "https://tally.so/r/Dq25LE?order=cs_live_unpaid1");
  assert.strictEqual(broken, "https://tally.so/r/Dq25LE?order=cs_test_broken1");
  assert.strictEqual(invalid, "https://tally.so/r/Dq25LE");
  assert.strictEqual(logs.length, 3);
});

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

test("GET /order/continue redirects, and the homepage still loads", async () => {
  const server = createServer({
    env: { STRIPE_SECRET_KEY: "rk_live_secret" },
    log() {},
    retrieveSession() {
      return {
        ...paid([
          line({ description: "Single video", unitAmount: 1499 }),
          line({ description: "Sibling", quantity: 3 }),
        ]),
        customer_details: { email: "buyer@example.com" },
      };
    },
  });
  const port = await listen(server);
  try {
    const redirect = await fetch(`http://127.0.0.1:${port}/order/continue?session_id=cs_live_route1`, { redirect: "manual" });
    assert.strictEqual(redirect.status, 302);
    assert.strictEqual(
      redirect.headers.get("location"),
      "https://tally.so/r/Dq25LE?order=cs_live_route1&children=4&rush=0&sleigh=0&package=single&email=buyer%40example.com"
    );
    const home = await fetch(`http://127.0.0.1:${port}/`);
    assert.strictEqual(home.status, 200);
    const html = await home.text();
    assert.match(html, /Santa Says My Name/);
    assert.match(html, /href="\/privacy"/);
    assert.match(html, /href="\/terms"/);
    assert.doesNotMatch(html, /Father Christmas|Dunholme|Wakefield|geographic address/);

    const privacy = await fetch(`http://127.0.0.1:${port}/privacy`);
    assert.strictEqual(privacy.status, 200);
    const privacyHtml = await privacy.text();
    assert.match(privacyHtml, /Neil Carroll trading as Santa Says My Name, Dunholme, Thornes Road, Wakefield WF2 8QN/);
    assert.match(privacyHtml, /hello@santasaysmyname.com/);
    assert.match(privacyHtml, /href="\/terms"/);
    assert.doesNotMatch(privacyHtml, /Father Christmas/);

    const terms = await fetch(`http://127.0.0.1:${port}/terms/`);
    assert.strictEqual(terms.status, 200);
    const termsHtml = await terms.text();
    assert.match(termsHtml, /Neil Carroll trading as Santa Says My Name, Dunholme, Thornes Road, Wakefield WF2 8QN/);
    assert.match(termsHtml, /href="\/privacy"/);
    assert.doesNotMatch(termsHtml, /Father Christmas/);
  } finally {
    server.close();
  }
});
