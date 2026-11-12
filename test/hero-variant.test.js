"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { createServer } = require("../server");
const { assignVariant, normaliseVariant, resolveVariant, heroSample, applyHeroSample, filmFor } = require("../lib/hero-variant");
const { unmutePlan } = require("../public/js/hero-sound");

const DELIVERY = "Delivered within 48 hours of your order, whatever the date.";

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}

test("the hero video uses the full v4 explainer when those files exist, otherwise the name sample", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "santa-hero-"));
  assert.deepStrictEqual(heroSample("uk", dir), {
    src: "/assets/santa-preview-v3.mp4",
    poster: "/assets/santa-preview-poster-lite.webp",
    fallback: true,
  });
  assert.deepStrictEqual(heroSample("us", dir), {
    src: "/assets/us-sample-saoirse-4x5-usd.mp4",
    poster: "/assets/santa-preview-poster-lite.webp",
    fallback: true,
  });
  fs.writeFileSync(path.join(dir, "hero-uk-v4-full.mp4"), "film");
  assert.strictEqual(heroSample("uk", dir).fallback, true);
  fs.writeFileSync(path.join(dir, "hero-uk-v4-full.jpg"), "poster");
  assert.deepStrictEqual(heroSample("uk", dir), {
    src: "/assets/hero-uk-v4-full.mp4",
    poster: "/assets/hero-uk-v4-full.jpg",
    fallback: false,
  });
  fs.writeFileSync(path.join(dir, "hero-us-v4-full.mp4"), "film");
  fs.writeFileSync(path.join(dir, "hero-us-v4-full.jpg"), "poster");
  assert.strictEqual(heroSample("us", dir).src, "/assets/hero-us-v4-full.mp4");
  const html = '<video poster="/assets/santa-preview-poster-lite.webp"><source src="/assets/santa-preview-v3.mp4" type="video/mp4"><track src="/assets/santa-preview.vtt" kind="captions"></video>';
  const swapped = applyHeroSample(html, "us", dir);
  assert.match(swapped, /poster="\/assets\/hero-us-v4-full\.jpg"/);
  assert.match(swapped, /src="\/assets\/hero-us-v4-full\.mp4"/);
  assert.doesNotMatch(swapped, /santa-preview\.vtt/);
  assert.match(applyHeroSample(html, "uk", os.tmpdir()), /santa-preview-v3\.mp4/);
});

test("the hero unmutes in place, and a tap on the video or the prompt restarts", () => {
  assert.deepStrictEqual(unmutePlan("page"), { unmute: true, restart: false, hidePrompt: true });
  assert.deepStrictEqual(unmutePlan("video"), { unmute: true, restart: true, hidePrompt: true });
  assert.deepStrictEqual(unmutePlan("sound"), { unmute: true, restart: true, hidePrompt: true });
  const mainJs = fs.readFileSync(path.join(__dirname, "../public/js/main.js"), "utf8");
  assert.match(mainJs, /video\.muted = false/);
  assert.match(mainJs, /\.catch\(\(\) => \{\s*video\.muted = true/);
  assert.match(mainJs, /addEventListener\("pointerdown", onFirstGesture\)/);
  assert.match(mainJs, /addEventListener\("click", onFirstGesture\)/);
  assert.match(mainJs, /addEventListener\("keydown", onFirstGesture\)/);
  assert.match(mainJs, /applyUnmute\("page"\)/);
  assert.match(mainJs, /applyUnmute\("video"\)/);
  assert.match(mainJs, /applyUnmute\("sound"\)/);
  assert.match(mainJs, /preload="metadata"|video\.pause\(\)/);
  assert.strictEqual(filmFor("parents", "us").src, "/assets/us-grownups-4x5-usd.mp4");
  assert.strictEqual(filmFor("parents", "uk").src, "/assets/exit-sales-v4.mp4");
});

test("variant assignment is 50/50 and then sticky", () => {
  assert.strictEqual(normaliseVariant("A"), "explainer");
  assert.strictEqual(normaliseVariant("parents-only"), "parents");
  assert.strictEqual(normaliseVariant("nope"), "");
  assert.strictEqual(assignVariant("", () => 0), "explainer");
  assert.strictEqual(assignVariant("", () => 0.5), "parents");
  assert.strictEqual(assignVariant("parents", () => 0), "parents");
  assert.strictEqual(resolveVariant({ query: "b", cookie: "explainer", random: () => 0 }), "parents");
  assert.strictEqual(resolveVariant({ cookie: "explainer", random: () => 0.9 }), "explainer");
  assert.strictEqual(resolveVariant({ random: () => 0.9 }), "parents");
});

test("both sales pages keep the assigned film below the name sample", async () => {
  const server = createServer({
    log() {},
    now: "2026-10-31T12:00:00Z",
    visitsFile: null,
    funnelFile: null,
    env: {},
  });
  const port = await listen(server);
  try {
    for (const pathName of ["/", "/us"]) {
      const explainer = await fetch(`http://127.0.0.1:${port}${pathName}?variant=explainer`);
      const explainerHtml = await explainer.text();
      assert.match(explainer.headers.get("set-cookie") || "", /^ssmn_variant=explainer;/);
      assert.match(explainerHtml, /data-variant="explainer"/);
      const explainerSrc = pathName === "/us"
        ? "/assets/us-explainer-4x5-v7.mp4"
        : "/assets/uk-explainer-4x5-v7.mp4";
      const hero = explainerHtml.slice(explainerHtml.indexOf("<video id=\"hero-film\""), explainerHtml.indexOf("id=\"hero-play\""));
      assert.doesNotMatch(hero, /autoplay/);
      assert.doesNotMatch(hero, /\bmuted\b/);
      assert.doesNotMatch(hero, /\bloop\b/);
      assert.match(hero, /playsinline/);
      assert.match(hero, /preload="none"/);
      assert.match(hero, new RegExp(`data-src="${explainerSrc.replace(/\./g, "\\.")}"`));
      assert.match(hero, /data-poster="\/assets\/(?:uk|us)-explainer-4x5-v7-poster\.jpg"/);
      assert.doesNotMatch(hero, /<source/);
      assert.doesNotMatch(hero, /santa-preview|exit-sales/);
      assert.match(explainerHtml, new RegExp(DELIVERY.replace(/[.]/g, "\\.")));
      assert.match(explainerHtml, /id="see-example"[^>]*>See an example</);
      assert.ok(explainerHtml.indexOf('id="hear-santa"') < explainerHtml.indexOf('id="hero-order"'));
      assert.ok(explainerHtml.indexOf('id="hero-order"') < explainerHtml.indexOf('id="see-example"'));
      assert.ok(explainerHtml.indexOf('id="hear-santa"') < explainerHtml.indexOf('id="hero-film"'));
      assert.ok(explainerHtml.indexOf('id="hear-santa"') < explainerHtml.indexOf('id="pricing"'));
      assert.ok(explainerHtml.indexOf('id="hear-santa"') < explainerHtml.indexOf('id="faq"'));
      const sampleOpen = explainerHtml.slice(explainerHtml.indexOf("<video"), explainerHtml.indexOf(">", explainerHtml.indexOf('id="hear-santa"')) + 1);
      assert.match(sampleOpen, /\bautoplay\b/);
      assert.match(sampleOpen, /\bmuted\b/);
      assert.match(sampleOpen, /\bloop\b/);
      assert.match(sampleOpen, /\bplaysinline\b/);
      assert.match(sampleOpen, /preload="metadata"/);
      const heroFile = pathName === "/us" ? "hero-us-v4-full" : "hero-uk-v4-full";
      assert.match(sampleOpen, new RegExp(`poster="/assets/${heroFile}\\.jpg"`));
      assert.match(explainerHtml, new RegExp(`<source src="/assets/${heroFile}\\.mp4"`));
      assert.doesNotMatch(explainerHtml, /santa-preview\.vtt/);
      assert.match(explainerHtml, />Tap for sound</);
      assert.doesNotMatch(explainerHtml, /Hear Santa say a name/);
      assert.doesNotMatch(explainerHtml, /fictional name/i);
      assert.doesNotMatch(explainerHtml, /etsy/i);

      const parents = await fetch(`http://127.0.0.1:${port}${pathName}?variant=parents`);
      const parentsHtml = await parents.text();
      assert.match(parents.headers.get("set-cookie") || "", /^ssmn_variant=parents;/);
      assert.match(parentsHtml, /data-variant="parents"/);
      const parentsHero = parentsHtml.slice(parentsHtml.indexOf("<video id=\"hero-film\""), parentsHtml.indexOf("id=\"hero-play\""));
      const parentsSrc = pathName === "/us" ? "/assets/us-grownups-4x5-usd.mp4" : "/assets/exit-sales-v4.mp4";
      assert.match(parentsHero, new RegExp(`data-src="${parentsSrc.replace(/\./g, "\\.")}"`));
      assert.doesNotMatch(parentsHero, /autoplay|muted/);
      assert.doesNotMatch(parentsHero, /explainer-4x5/);
      assert.match(parentsHtml, new RegExp(`<source src="/assets/${pathName === "/us" ? "hero-us-v4-full" : "hero-uk-v4-full"}\\.mp4"`));
      assert.match(parentsHtml, /id="see-example"/);
    }

    const sticky = await fetch("http://127.0.0.1:" + port + "/", {
      headers: { Cookie: "ssmn_variant=parents" },
    });
    const stickyHtml = await sticky.text();
    assert.match(stickyHtml, /data-variant="parents"/);
    assert.match(stickyHtml, /<video id="hero-film"[\s\S]*?data-src="\/assets\/exit-sales-v4\.mp4"/);
  } finally {
    await close(server);
  }
});

test("view, order tap, example tap and checkout are counted per variant", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "santa-variant-"));
  const filePath = path.join(dir, "funnel-counts.json");
  const secret = "variant-secret";
  const server = createServer({
    log() {},
    now: "2026-10-31T12:00:00Z",
    visitsFile: null,
    funnelFile: filePath,
    env: { VISITS_SECRET: secret, PAYMENT_PROVIDER: "stripe" },
    stripe: {
      paymentLinks: {
        async list() {
          return { data: [{ id: "plink_uk", url: "https://buy.stripe.com/5kQaEYfzNeFI4gq1fD1wY00" }], has_more: false };
        },
        async retrieve() {
          return {
            id: "plink_uk",
            url: "https://buy.stripe.com/5kQaEYfzNeFI4gq1fD1wY00",
            currency: "gbp",
            metadata: { package: "bundle_early_bird" },
            line_items: { data: [{ price: { id: "price_bundle", currency: "gbp", unit_amount: 1699 }, quantity: 1 }] },
            optional_items: [],
          };
        },
      },
      checkout: {
        sessions: {
          async create() {
            return { id: "cs_test_variant1", url: "https://checkout.stripe.com/c/pay/cs_test_variant1" };
          },
        },
      },
    },
  });
  const port = await listen(server);
  const origin = `http://127.0.0.1:${port}`;
  try {
    assert.strictEqual((await fetch(`${origin}/?variant=explainer`)).status, 200);
    assert.strictEqual((await fetch(`${origin}/us?variant=parents`)).status, 200);
    const example = await fetch(`${origin}/api/funnel`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ event: "example_tap", variant: "parents", market: "us" }),
    });
    assert.strictEqual(example.status, 204);
    const tap = await fetch(`${origin}/api/funnel`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ event: "order_tap", variant: "explainer", market: "uk" }),
    });
    assert.strictEqual(tap.status, 204);
    const pay = await fetch(`${origin}/order/pay?package=magicBundle&variant=explainer`, { redirect: "manual" });
    assert.strictEqual(pay.status, 302);

    const report = await fetch(`${origin}/admin/funnel`, { headers: { Authorization: `Bearer ${secret}` } });
    const body = await report.json();
    assert.strictEqual(body.variants.explainer.view, 1);
    assert.strictEqual(body.variants.explainer.order_tap, 1);
    assert.strictEqual(body.variants.explainer.example_tap, 0);
    assert.strictEqual(body.variants.explainer.checkout_start, 1);
    assert.strictEqual(body.variants.parents.view, 1);
    assert.strictEqual(body.variants.parents.example_tap, 1);
    assert.strictEqual(body.variants.parents.order_tap, 0);
    assert.strictEqual(body.variants.parents.checkout_start, 0);
    const parentsBucket = body.buckets.find((row) => row.variant === "parents");
    assert.strictEqual(parentsBucket.market, "us");
    assert.strictEqual(parentsBucket.example_tap, 1);
  } finally {
    await close(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Clarity is tagged with the film when it is loaded", () => {
  const source = fs.readFileSync(path.join(__dirname, "../public/js/meta-pixel.js"), "utf8");
  assert.match(source, /clarity\("set", "variant", shown\)/);
  const page = fs.readFileSync(path.join(__dirname, "../public/js/main.js"), "utf8");
  assert.match(page, /clarity\("set", "variant", variant\)/);
  assert.match(page, /example_tap/);
  const css = fs.readFileSync(path.join(__dirname, "../public/css/styles.css"), "utf8");
  assert.match(css, /\.btn\.btn-see\s*\{[^}]*background:\s*transparent/);
  assert.match(css, /\.btn\.btn-see\s*\{[^}]*border:\s*1px solid/);
});
