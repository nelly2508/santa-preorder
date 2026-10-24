"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const { createServer } = require("../server");
const { siblingRate, twoChildrenFor, packageChoice, offerPhase, ordersOpen, LATE_ORDERS_FROM, ORDERS_CLOSE_AT } = require("../public/js/checkout-choice");

const prices = {
  magicBundleFull: "£19.99",
  magicBundleEarly: "£16.99",
  magicBundleLate: "£24.98",
  singleVideo: "£14.99",
  singleVideoLate: "£19.98",
  sibling: "£11.99",
};

const stripe = {
  magicBundleEarlyBird: "https://buy.stripe.com/early",
  magicBundleFullPrice: "https://buy.stripe.com/full",
  singleVideo: "https://buy.stripe.com/single",
  lateBundle: "https://buy.stripe.com/late-bundle",
  lateSingle: "https://buy.stripe.com/late-single",
};

const phaseOptions = {
  earlyBird: true,
  earlyBirdEnds: "2026-11-15T23:59:59+00:00",
  lateOrdersFrom: "2026-12-13T00:00:00Z",
};

test("sibling price says it is per extra child, up to 4 siblings", () => {
  assert.strictEqual(siblingRate("£11.99"), "+£11.99 per extra child (up to 4 siblings)");
  assert.strictEqual(twoChildrenFor("magicBundle", { early: true, prices }), "2 children = £16.99 + £11.99");
  assert.strictEqual(twoChildrenFor("magicBundle", { early: false, prices }), "2 children = £19.99 + £11.99");
  assert.strictEqual(twoChildrenFor("singleVideo", { early: true, prices }), "2 children = £14.99 + £11.99");
  assert.strictEqual(twoChildrenFor("video", { early: true, prices }), "2 children = your video + £11.99");
  assert.strictEqual(twoChildrenFor("magicBundle", { late: true, early: true, prices }), "2 children = £24.98 + £11.99");
  assert.strictEqual(twoChildrenFor("singleVideo", { late: true, prices }), "2 children = £19.98 + £11.99");
});

test("the offer follows early bird, then full price, then late rush", () => {
  assert.strictEqual(offerPhase({ ...phaseOptions, now: "2026-10-18T12:00:00Z" }), "early");
  assert.strictEqual(offerPhase({ ...phaseOptions, now: "2026-11-15T23:59:59Z" }), "early");
  assert.strictEqual(offerPhase({ ...phaseOptions, now: "2026-11-16T00:00:00Z" }), "standard");
  assert.strictEqual(offerPhase({ ...phaseOptions, now: "2026-12-12T23:59:59Z" }), "standard");
  assert.strictEqual(offerPhase({ ...phaseOptions, now: "2026-12-13T00:00:00Z" }), "late");
  assert.strictEqual(offerPhase({ ...phaseOptions, now: "2026-12-18T12:00:00Z" }), "late");
  assert.strictEqual(offerPhase({ ...phaseOptions, earlyBird: false, now: "2026-10-18T12:00:00Z" }), "standard");
  assert.strictEqual(offerPhase({ ...phaseOptions, lateOrders: true, now: "2026-10-18T12:00:00Z" }), "late");
  assert.strictEqual(offerPhase({ ...phaseOptions, lateOrders: false, now: "2026-12-20T00:00:00Z" }), "standard");
  assert.strictEqual(offerPhase({ ...phaseOptions, now: "not-a-date" }), "standard");
});

test("orders stay open through 19 December UK, including the rush fee, and close at midnight", () => {
  assert.strictEqual(LATE_ORDERS_FROM, "2026-12-13T00:00:00Z");
  assert.strictEqual(ORDERS_CLOSE_AT, "2026-12-20T00:00:00Z");
  assert.strictEqual(offerPhase({ ...phaseOptions, now: "2026-12-19T23:59:00Z" }), "late");
  assert.strictEqual(ordersOpen("2026-12-19T23:59:00Z"), true);
  assert.strictEqual(ordersOpen("2026-12-19T23:59:59Z"), true);
  assert.strictEqual(ordersOpen("2026-12-20T00:00:00Z"), false);
  assert.strictEqual(offerPhase({ ...phaseOptions, now: "2026-12-20T00:30:00Z" }), "late");
  assert.strictEqual(ordersOpen("2026-12-13T00:00:00Z"), true);
});

test("the continue link follows the package the customer chose", () => {
  const earlyBundle = packageChoice("magicBundle", { early: true, prices, stripe });
  const laterBundle = packageChoice("magicBundle", { early: false, prices, stripe });
  const single = packageChoice("singleVideo", { early: true, prices, stripe });
  const unknown = packageChoice("other", { early: false, prices, stripe });
  const lateBundle = packageChoice("magicBundle", { early: true, late: true, prices, stripe });
  const lateSingle = packageChoice("singleVideo", { late: true, prices, stripe });

  assert.deepStrictEqual(
    { name: earlyBundle.name, detail: earlyBundle.detail, href: earlyBundle.href },
    { name: "Magic bundle", detail: "£16.99 early bird", href: stripe.magicBundleEarlyBird }
  );
  assert.strictEqual(laterBundle.detail, "£19.99");
  assert.strictEqual(laterBundle.href, stripe.magicBundleFullPrice);
  assert.deepStrictEqual(
    { name: single.name, detail: single.detail, href: single.href },
    { name: "Single video", detail: "£14.99", href: stripe.singleVideo }
  );
  assert.strictEqual(unknown.href, stripe.magicBundleFullPrice);
  assert.deepStrictEqual(
    { name: lateBundle.name, detail: lateBundle.detail, href: lateBundle.href },
    { name: "Magic bundle", detail: "£24.98, rush included", href: stripe.lateBundle }
  );
  assert.deepStrictEqual(
    { name: lateSingle.name, detail: lateSingle.detail, href: lateSingle.href },
    { name: "Single video", detail: "£19.98, rush included", href: stripe.lateSingle }
  );
});

test("the server refuses checkout after 19 December, including rush, and redirects before that", async () => {
  async function withServer(now, run) {
    const server = createServer({ log() {}, now });
    const port = await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    });
    try {
      await run(port);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }

  await withServer("2026-10-24T12:00:00Z", async (port) => {
    const early = await fetch(`http://127.0.0.1:${port}/order/pay?package=magicBundle`, { redirect: "manual" });
    assert.strictEqual(early.status, 302);
    assert.strictEqual(early.headers.get("location"), "https://buy.stripe.com/5kQaEYfzNeFI4gq1fD1wY00");
    const single = await fetch(`http://127.0.0.1:${port}/order/pay?package=singleVideo`, { redirect: "manual" });
    assert.strictEqual(single.headers.get("location"), "https://buy.stripe.com/8x29AUdrFcxA28i6zX1wY02");
    const odd = await fetch(`http://127.0.0.1:${port}/order/pay?package=https://evil.example`, { redirect: "manual" });
    assert.strictEqual(odd.headers.get("location"), "https://buy.stripe.com/5kQaEYfzNeFI4gq1fD1wY00");
  });

  await withServer("2026-12-19T18:00:00Z", async (port) => {
    const rush = await fetch(`http://127.0.0.1:${port}/order/pay?package=singleVideo`, { redirect: "manual" });
    assert.strictEqual(rush.status, 302);
    assert.strictEqual(rush.headers.get("location"), "https://buy.stripe.com/dRmcN6aft69cfZ87E11wY04");
  });

  await withServer("2026-12-20T00:00:00Z", async (port) => {
    const home = await fetch(`http://127.0.0.1:${port}/`);
    const html = await home.text();
    assert.match(html, /data-orders-closed/);
    assert.match(html, /Santa's workshop is closed for orders this Christmas\. Thank you!/);
    assert.doesNotMatch(html, /id="orders-closed" hidden/);
    const pay = await fetch(`http://127.0.0.1:${port}/order/pay?package=magicBundle`, { redirect: "manual" });
    assert.strictEqual(pay.status, 200);
    assert.strictEqual(pay.headers.get("location"), null);
    const body = await pay.text();
    assert.match(body, /Santa's workshop is closed for orders this Christmas\. Thank you!/);
    assert.doesNotMatch(body, /buy\.stripe\.com/);
    const rush = await fetch(`http://127.0.0.1:${port}/order/pay?package=singleVideo`, { redirect: "manual" });
    assert.strictEqual(rush.status, 200);
    assert.doesNotMatch(await rush.text(), /buy\.stripe\.com/);
  });
});

test("the page copy uses the configured sibling price and the pay step", async () => {
  const config = fs.readFileSync(path.join(__dirname, "../public/js/config.js"), "utf8");
  const sibling = config.match(/sibling:\s*"(£\d+\.\d+)"/)[1];
  const rate = siblingRate(sibling);
  const server = createServer({ log() {} });
  const port = await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
  try {
    const home = await fetch(`http://127.0.0.1:${port}/`);
    const html = await home.text();
    const mentions = html.split(rate).length - 1;
    assert.ok(
      mentions >= 5,
      `expected the sibling rate on the price cards, the sibling extra, the FAQ and the footer, found ${mentions}`
    );
    assert.match(html, /2 children = £16\.99 \+ £11\.99/);
    assert.match(html, /2 children = £14\.99 \+ £11\.99/);
    assert.match(html, /2 children = your video \+ £11\.99/);
    assert.match(html, /You've chosen:/);
    assert.match(html, /Tick the box to continue/);
    assert.match(html, />Continue to secure payment</);
    assert.match(
      html,
      /id="pay-continue"[\s\S]*?Adding more than one brother or sister\? Add the sibling extra at checkout, then on your phone tap ‘Details’ \(top right\) to change how many \(\+£11\.99 each, up to 4\)\./
    );
    const pay = html.match(/<a[^>]*id="pay-continue"[^>]*>/)[0];
    assert.match(pay, /aria-disabled="true"/);
    assert.match(pay, /href="#checkout"/);
    assert.doesNotMatch(pay, /style=/);
    assert.doesNotMatch(html, /Father Christmas/);
    assert.doesNotMatch(html, /<h3>Rush|Rush £4\.99|data-price="rush"|add rush/);
    assert.match(html, /in good time for Christmas/);
    assert.match(html, /data-late-only hidden>Ordering late\? Rush delivery is included so your video arrives in time\./);
    assert.match(config, /lateOrdersFrom:\s*"2026-12-13T00:00:00Z"/);
    assert.match(config, /lateBundle:\s*"https:\/\/buy\.stripe\.com\/4gMaEYevJfJM7sCf6t1wY03"/);
    assert.match(config, /lateSingle:\s*"https:\/\/buy\.stripe\.com\/dRmcN6aft69cfZ87E11wY04"/);
    assert.doesNotMatch(config, /buy\.stripe\.com\/test_/);

    const terms = await fetch(`http://127.0.0.1:${port}/terms`);
    const termsHtml = await terms.text();
    assert.match(termsHtml, /£11\.99 per extra child \(up to 4 siblings\)/);
    assert.match(termsHtml, /Magic bundle £24\.98, single video £19\.98/);
    assert.match(termsHtml, /in good time for Christmas/);
    assert.match(termsHtml, /the price includes rush delivery/);
    assert.doesNotMatch(termsHtml, /Rush £4\.99|if you pay for it/);
    assert.doesNotMatch(termsHtml, /Father Christmas/);
    assert.match(termsHtml, /Saturday 19 December/);
    assert.match(html, /The last day is Sat 19 Dec/);
    assert.match(html, /id="orders-closed"/);
    assert.doesNotMatch(html, /data-orders-closed/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
