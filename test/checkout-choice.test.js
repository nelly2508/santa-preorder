"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const { createServer } = require("../server");
const { siblingRate, twoChildrenFor, packageChoice } = require("../public/js/checkout-choice");

const prices = {
  magicBundleFull: "£19.99",
  magicBundleEarly: "£16.99",
  singleVideo: "£14.99",
  sibling: "£11.99",
};

const stripe = {
  magicBundleEarlyBird: "https://buy.stripe.com/early",
  magicBundleFullPrice: "https://buy.stripe.com/full",
  singleVideo: "https://buy.stripe.com/single",
};

test("sibling price says it is per extra child, up to 4 siblings", () => {
  assert.strictEqual(siblingRate("£11.99"), "+£11.99 per extra child (up to 4 siblings)");
  assert.strictEqual(twoChildrenFor("magicBundle", { early: true, prices }), "2 children = £16.99 + £11.99");
  assert.strictEqual(twoChildrenFor("magicBundle", { early: false, prices }), "2 children = £19.99 + £11.99");
  assert.strictEqual(twoChildrenFor("singleVideo", { early: true, prices }), "2 children = £14.99 + £11.99");
  assert.strictEqual(twoChildrenFor("video", { early: true, prices }), "2 children = your video + £11.99");
});

test("the continue link follows the package the customer chose", () => {
  const earlyBundle = packageChoice("magicBundle", { early: true, prices, stripe });
  const laterBundle = packageChoice("magicBundle", { early: false, prices, stripe });
  const single = packageChoice("singleVideo", { early: true, prices, stripe });
  const unknown = packageChoice("other", { early: false, prices, stripe });

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
    assert.ok(mentions >= 6, `expected the sibling rate in the pricing, checkout, FAQ and footer, found ${mentions}`);
    assert.match(html, /2 children = £16\.99 \+ £11\.99/);
    assert.match(html, /2 children = £14\.99 \+ £11\.99/);
    assert.match(html, /2 children = your video \+ £11\.99/);
    assert.match(html, /You've chosen:/);
    assert.match(html, /Tick the box to continue/);
    assert.match(html, />Continue to secure payment</);
    const pay = html.match(/<a[^>]*id="pay-continue"[^>]*>/)[0];
    assert.match(pay, /aria-disabled="true"/);
    assert.match(pay, /href="#checkout"/);
    assert.doesNotMatch(pay, /style=/);
    assert.doesNotMatch(html, /Father Christmas/);

    const terms = await fetch(`http://127.0.0.1:${port}/terms`);
    const termsHtml = await terms.text();
    assert.match(termsHtml, /£11\.99 per extra child \(up to 4 siblings\)/);
    assert.doesNotMatch(termsHtml, /Father Christmas/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
