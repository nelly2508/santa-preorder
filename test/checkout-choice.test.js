"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const { createServer } = require("../server");
const { siblingRate, twoChildrenFor, packageChoice, offerPhase, ordersOpen, orderQuery, choiceOffer, orderAmount, offerBanner, LATE_ORDERS_FROM, ORDERS_CLOSE_AT } = require("../public/js/checkout-choice");
const { quoteCart } = require("../lib/quote");

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

test("the pay link carries market only for the US page", () => {
  assert.strictEqual(orderQuery({ packageKey: "singleVideo", market: "uk" }), "package=singleVideo");
  assert.strictEqual(
    orderQuery({ packageKey: "magicBundle", market: "us", utm: { utm_source: "meta" } }),
    "package=magicBundle&utm_source=meta&market=us"
  );
});

test("sibling price says it is per extra child, up to 4 siblings", () => {
  assert.strictEqual(siblingRate("£11.99"), "+£11.99 per extra child (up to 4 siblings)");
  assert.strictEqual(twoChildrenFor("magicBundle", { early: true, prices }), "2 children = £16.99 + £11.99");
  assert.strictEqual(twoChildrenFor("magicBundle", { early: false, prices }), "2 children = £19.99 + £11.99");
  assert.strictEqual(twoChildrenFor("singleVideo", { early: true, prices }), "2 children = £14.99 + £11.99");
  assert.strictEqual(twoChildrenFor("video", { early: true, prices }), "2 children = your video + £11.99");
  assert.strictEqual(twoChildrenFor("magicBundle", { late: true, early: true, prices }), "2 children = £24.98 + £11.99");
  assert.strictEqual(twoChildrenFor("singleVideo", { late: true, prices }), "2 children = £19.98 + £11.99");
});

test("the offer follows early bird, then full price, then the Christmas week price", () => {
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

test("orders stay open through 19 December UK, including the Christmas week price, and close at midnight", () => {
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
    { name: "Magic bundle", detail: "£24.98, Christmas week price", href: stripe.lateBundle }
  );
  assert.deepStrictEqual(
    { name: lateSingle.name, detail: lateSingle.detail, href: lateSingle.href },
    { name: "Single video", detail: "£19.98, Christmas week price", href: stripe.lateSingle }
  );
});

test("the server refuses checkout after 19 December, including rush, and redirects before that", async () => {
  async function withServer(now, run) {
    const server = createServer({ log() {}, now, env: { PAYMENT_PROVIDER: "stripe" } });
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
      mentions >= 3,
      `expected the sibling rate on the one pricing line, the FAQ and the footer, found ${mentions}`
    );
    assert.match(html, /2 children = £16\.99 \+ £11\.99/);
    assert.match(html, /2 children = £14\.99 \+ £11\.99/);
    assert.match(html, /2 children = your video \+ £11\.99/);
    assert.match(html, /id="order-total"/);
    assert.match(html, /How many children\?/);
    assert.match(html, /id="sibling-faces"/);
    assert.match(html, /Delivered within 48 hours of your order, whatever the date\./);
    assert.doesNotMatch(html, /first week of December|by 15 December|12 December|batches from 1 December|in good time for Christmas/);
    assert.doesNotMatch(html, /Tick the box to continue/);
    assert.doesNotMatch(html, /lose my 14-day right|lose the right to cancel|14-day cancellation period/);
    assert.match(html, />Pay with PayPal or card</);
    assert.match(html, /id="children-more"/);
    assert.match(html, /id="children-less"/);
    assert.doesNotMatch(html, /id="add-sibling"/);
    assert.match(html, /class="promise-line"/);
    assert.match(html, /Nice List Promise<\/a>: love it or your money back/);
    assert.doesNotMatch(html, /tap ‘Details’|tap 'Details'|top right/);
    const pay = html.match(/<a[^>]*id="pay-continue"[^>]*>/)[0];
    assert.match(pay, /aria-disabled="false"/);
    assert.doesNotMatch(html, /id="reg37"|make-before-cancellation/);
    assert.match(pay, /href="#checkout"/);
    assert.doesNotMatch(pay, /style=/);
    assert.doesNotMatch(html, /Father Christmas/);
    assert.doesNotMatch(html, /<h3>Rush|Rush £4\.99|data-price="rush"|add rush|\brush\b/i);
    assert.match(html, /data-late-only hidden>Delivered within 48 hours of your order, whatever the date\. The Christmas week price applies from Sun 13 Dec\. It is the same delivery, not a faster one\./);
    assert.match(html, /Order the Magic bundle/);
    assert.doesNotMatch(html, /Pre-order/);
    assert.match(config, /lateOrdersFrom:\s*"2026-12-13T00:00:00Z"/);
    assert.match(config, /lateBundle:\s*"https:\/\/buy\.stripe\.com\/4gMaEYevJfJM7sCf6t1wY03"/);
    assert.match(config, /lateSingle:\s*"https:\/\/buy\.stripe\.com\/dRmcN6aft69cfZ87E11wY04"/);
    assert.doesNotMatch(config, /buy\.stripe\.com\/test_/);

    const terms = await fetch(`http://127.0.0.1:${port}/terms`);
    const termsHtml = await terms.text();
    assert.match(termsHtml, /£11\.99 per extra child \(up to 4 siblings\)/);
    assert.match(termsHtml, /Magic bundle £24\.98, single video £19\.98/);
    assert.match(termsHtml, /Christmas week price/);
    assert.match(termsHtml, /not a faster delivery/);
    assert.match(termsHtml, /If the video is not with you within 48 hours, we refund you in full/);
    assert.doesNotMatch(termsHtml, /Rush £4\.99|if you pay for it|\brush\b/i);
    assert.doesNotMatch(termsHtml, /Father Christmas/);
    assert.match(termsHtml, /Saturday 19 December/);
    assert.match(termsHtml, /Delivered within 48 hours of your order, whatever the date/);
    assert.doesNotMatch(termsHtml, /first week of December|15 December|12 December|1 December|in good time for Christmas|tick the box to ask us|lose the right to cancel/i);
    const mainJs = fs.readFileSync(path.join(__dirname, "../public/js/main.js"), "utf8");
    assert.match(mainJs, /Order the Magic bundle/);
    assert.match(html, /id="hero-order"[^>]*>Order now</);
    assert.match(html, /id="final-order"[^>]*>Order now</);
    assert.doesNotMatch(mainJs, /Order now -/);
    assert.match(mainJs, /Order the single video/);
    assert.match(mainJs, /Pay now\. Christmas week price\./);
    assert.doesNotMatch(mainJs, /Pre-order|Rush delivery|15 December/);
    assert.match(mainJs, /className = "sibling-face"/);
    assert.match(mainJs, /is-leaving/);
    assert.match(mainJs, /circle cx="32" cy="20" r="12"/);
    assert.match(html, /The last day is Sat 19 Dec/);
    assert.match(html, /id="orders-closed"/);
    assert.doesNotMatch(html, /data-orders-closed/);
    assert.match(mainJs, /choice_open/);
    assert.match(mainJs, /recordFunnel\("order_tap", \{ package: selectedKey \}\)/);
    assert.match(mainJs, /recordFunnel\("pay_click", \{ package: selectedKey \}\)/);
    assert.doesNotMatch(mainJs, /recordFunnel\("order_tap"\)/);
    assert.doesNotMatch(mainJs, /function focusCheckout|function scrollToCheckout/);
    assert.match(mainJs, /renderFaces\(siblings \+ 1,/);
    assert.doesNotMatch(mainJs, /renderFaces\(siblings,/);
    assert.match(mainJs, /preventScroll:\s*true/);
    const paypalClick = mainJs.slice(mainJs.indexOf("onClick:"), mainJs.indexOf("createOrder:"));
    assert.match(paypalClick, /recordPayClick\(\)/);
    assert.doesNotMatch(paypalClick, /order_tap|recordOrderTap/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("the gift sheet leads with the cheaper video and prices the gap from the live figures", () => {
  const named = { ...prices, namedSleigh: "£4.99" };
  const early = choiceOffer({ early: true, prices: named });
  assert.strictEqual(early.from, "£14.99");
  assert.strictEqual(early.single, "£14.99");
  assert.strictEqual(early.bundle, "£16.99");
  assert.strictEqual(early.difference, "Just £2 more — the named sleigh alone is usually £4.99.");
  assert.strictEqual(
    early.upsell,
    "The Magic bundle adds a letter, a Nice List certificate and a named sleigh video — just £2 more during early bird."
  );

  const standard = choiceOffer({ early: false, prices: named });
  assert.strictEqual(standard.from, "£14.99");
  assert.strictEqual(standard.bundle, "£19.99");
  assert.strictEqual(standard.difference, "Just £5 more — the named sleigh alone is usually £4.99.");
  assert.doesNotMatch(standard.upsell, /early bird/);

  const late = choiceOffer({ early: true, late: true, prices: named });
  assert.strictEqual(late.from, "£19.98");
  assert.strictEqual(late.bundle, "£24.98");
  assert.match(late.difference, /^Just £5 more/);
  assert.strictEqual(late.early, false);

  const usd = {
    magicBundleEarly: "$19.99",
    magicBundleFull: "$24.99",
    magicBundleLate: "$29.98",
    singleVideo: "$19.99",
    singleVideoLate: "$24.98",
    namedSleigh: "$4.99",
  };
  const usdEarly = choiceOffer({ early: true, prices: usd });
  assert.strictEqual(usdEarly.from, "$19.99");
  assert.strictEqual(usdEarly.bundle, "$19.99");
  assert.match(usdEarly.difference, /^Same price, more magic/);
  assert.match(usdEarly.upsell, /same price, more magic/);
  assert.match(usdEarly.difference, /\$4\.99/);

  const usdStandard = choiceOffer({ early: false, prices: usd });
  assert.strictEqual(usdStandard.from, "$19.99");
  assert.strictEqual(usdStandard.bundle, "$24.99");
  assert.strictEqual(usdStandard.difference, "Just $5 more — the named sleigh alone is usually $4.99.");

  const usdLate = choiceOffer({ late: true, prices: usd });
  assert.strictEqual(usdLate.from, "$24.98");
  assert.strictEqual(usdLate.bundle, "$29.98");
  assert.match(usdLate.difference, /^Just \$5 more/);
});

test("the sheet total matches the amount PayPal charges", () => {
  const named = { ...prices, namedSleigh: "£4.99", rush: "£4.99" };
  const cases = [
    { packageKey: "magicBundle", siblings: 0, phase: "early" },
    { packageKey: "magicBundle", siblings: 1, phase: "early" },
    { packageKey: "magicBundle", siblings: 4, phase: "standard" },
    { packageKey: "magicBundle", siblings: 2, phase: "late" },
    { packageKey: "singleVideo", siblings: 0, sleigh: false, phase: "early" },
    { packageKey: "singleVideo", siblings: 1, sleigh: true, phase: "early" },
    { packageKey: "singleVideo", siblings: 3, sleigh: true, phase: "late" },
    { packageKey: "magicBundle", siblings: 1, sleigh: true, phase: "early" },
  ];
  for (const item of cases) {
    const shown = orderAmount({ ...item, early: item.phase === "early", late: item.phase === "late", prices: named });
    const charged = quoteCart({ ...item, prices: named });
    assert.strictEqual(shown.totalMinor, charged.totalPence, JSON.stringify(item));
  }
  const usd = {
    magicBundleEarly: "$19.99",
    magicBundleFull: "$24.99",
    magicBundleLate: "$29.98",
    singleVideo: "$19.99",
    singleVideoLate: "$24.98",
    sibling: "$14.99",
    rush: "$4.99",
    namedSleigh: "$4.99",
  };
  const two = orderAmount({ packageKey: "magicBundle", siblings: 1, early: true, prices: usd });
  assert.strictEqual(two.total, "$34.98");
  assert.strictEqual(two.children, 2);
  assert.strictEqual(quoteCart({ packageKey: "magicBundle", siblings: 1, phase: "early", prices: usd, currency: "USD" }).totalPence, 3498);
});

test("the offer strip names the early-bird end, then the 48-hour line", () => {
  const later = "Delivered within 48 hours of your order, whatever the date.";
  assert.strictEqual(offerBanner({ early: true, price: "£16.99" }), "Early bird pricing ends 15 Nov");
  assert.strictEqual(offerBanner({ early: true, price: "$19.99" }), "Early bird pricing ends 15 Nov");
  assert.doesNotMatch(offerBanner({ early: true, price: "£16.99" }), /£|\$/);
  assert.strictEqual(offerBanner({ early: false, price: "£19.99" }), `${later} £19.99`);
  assert.strictEqual(offerBanner({ early: false, price: "$24.99" }), `${later} $24.99`);
  assert.strictEqual(offerBanner({ early: true, late: true, price: "£24.98" }), `${later} £24.98`);
  assert.strictEqual(offerBanner({ early: true, price: "£16.99", closed: true }), "");
  assert.strictEqual(offerBanner({ early: false, price: "" }), "");
  assert.doesNotMatch(offerBanner({ early: false, price: "£19.99" }), /first week|15 December|Early bird/);
});

test("the offer strip follows the clock and the order buttons stay plain", async () => {
  async function pageAt(now, path) {
    const server = createServer({ log() {}, now });
    const port = await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    });
    try {
      return await (await fetch(`http://127.0.0.1:${port}${path}`)).text();
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }

  const standard = await pageAt("2026-11-16T00:00:00Z", "/");
  const standardBanner = standard.match(/id="offer-banner"[^>]*>[^<]*/)[0];
  assert.match(standardBanner, />Delivered within 48 hours of your order, whatever the date\. £19\.99$/);
  assert.doesNotMatch(standardBanner, /data-choice-open/);
  assert.match(standard, /id="hero-order"[^>]*>Order now</);
  assert.doesNotMatch(standard, /Early bird pricing ends 15 Nov/);
  const late = await pageAt("2026-12-13T00:00:00Z", "/us");
  assert.match(late, /id="offer-banner">Delivered within 48 hours of your order, whatever the date\. \$29\.98</);
  assert.match(late, /class="us-order-bar"[\s\S]*?>Order now</);
  assert.doesNotMatch(late.slice(late.indexOf('class="us-order-bar"'), late.indexOf("js/config.js")), /\$|£/);
  const closed = await pageAt("2026-12-20T00:00:00Z", "/");
  assert.match(closed, /id="offer-banner" hidden/);
  assert.doesNotMatch(closed, /Early bird:/);
});

test("Order now opens a choice, and the pricing cards still name a package", async () => {
  const server = createServer({ log() {} });
  const port = await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
  try {
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    const hero = html.match(/id="hero-order"[^>]*>[^<]*/)[0];
    assert.match(hero, /data-choice-open/);
    assert.match(hero, />Order now$/);
    assert.doesNotMatch(hero, /data-pay|£|\$|early bird|48 hours/);
    assert.match(html, /id="offer-banner"[^>]*data-choice-open[^>]*>Early bird pricing ends 15 Nov</);
    assert.match(html, /data-price="from">£14\.99</);
    assert.match(html, /id="hero-delivery"/);
    assert.ok(html.indexOf('id="choose-bundle"') < html.indexOf('id="choose-video"'));
    assert.match(html, /id="choice-sheet"[^>]*aria-labelledby="choice-title"/);
    assert.match(html, /id="choice-sheet"[^>]*aria-modal="false"/);
    assert.match(html, /id="choice-close"/);
    assert.match(html, /Choose your gift/);
    assert.match(html, /Your Santa video/);
    assert.match(html, /Most popular/);
    assert.match(html, /id="choose-video"[^>]*value="singleVideo"/);
    assert.match(html, /id="choose-bundle"[^>]*value="magicBundle"/);
    assert.match(html, /id="choose-bundle"[^>]*checked/);
    const pricing = html.slice(html.indexOf('id="pricing"'), html.indexOf('id="checkout"'));
    assert.match(pricing, /data-pay="magicBundle"/);
    assert.match(pricing, /data-pay="singleVideo"/);
    assert.match(pricing, /Order the Magic bundle/);
    const finalCta = html.match(/id="final-order"[^>]*>[^<]*/)[0];
    assert.match(finalCta, /data-choice-open/);
    assert.match(finalCta, />Order now$/);
    assert.doesNotMatch(finalCta, /data-pay|£|\$/);
    assert.doesNotMatch(html, /etsy/i);
    const sheet = html.slice(html.indexOf('id="choice-sheet"'), html.indexOf('id="exit-popup"'));
    assert.doesNotMatch(sheet, /etsy/i);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
