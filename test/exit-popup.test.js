"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const { createServer } = require("../server");
const exitPopup = require("../public/js/exit-popup");

const WEEK = exitPopup.WEEK_MS;

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

test("the exit popup stays off excluded pages, recent views, and buy clicks", () => {
  assert.strictEqual(exitPopup.MOBILE_DELAY_MS, 25000);
  assert.strictEqual(exitPopup.isExcludedPath("/"), false);
  assert.strictEqual(exitPopup.isExcludedPath("/index.html"), false);
  assert.strictEqual(exitPopup.isExcludedPath("/order"), true);
  assert.strictEqual(exitPopup.isExcludedPath("/order/"), true);
  assert.strictEqual(exitPopup.isExcludedPath("/order/continue"), true);
  assert.strictEqual(exitPopup.isExcludedPath("/order/pay"), true);
  assert.strictEqual(exitPopup.isExcludedPath("/privacy"), true);
  assert.strictEqual(exitPopup.isExcludedPath("/privacy/"), true);
  assert.strictEqual(exitPopup.isExcludedPath("/terms"), true);
  assert.strictEqual(exitPopup.isExcludedPath("/thank-you"), true);
  assert.strictEqual(exitPopup.isExcludedPath("/thanks"), true);

  const now = Date.parse("2026-10-24T12:00:00Z");
  assert.strictEqual(exitPopup.seenRecently(String(now - WEEK + 1), now), true);
  assert.strictEqual(exitPopup.seenRecently(String(now - 6 * 24 * 60 * 60 * 1000), now), true);
  assert.strictEqual(exitPopup.seenRecently(String(now - WEEK), now), false);
  assert.strictEqual(exitPopup.seenRecently("nope", now), false);
  assert.strictEqual(exitPopup.seenRecently(null, now), false);

  assert.strictEqual(exitPopup.forceRequested("?exitpopup=1"), true);
  assert.strictEqual(exitPopup.forceRequested("?exitpopup=1&asof=2026-12-01"), true);
  assert.strictEqual(exitPopup.forceRequested("?exitpopup=0"), false);
  assert.strictEqual(exitPopup.forceRequested(""), false);

  const open = {
    salesPage: true,
    excluded: false,
    ordersClosed: false,
    consentOpen: false,
    force: false,
    buyClicked: false,
    seenRecently: false,
  };
  assert.strictEqual(exitPopup.shouldOffer(open), true);
  assert.strictEqual(exitPopup.shouldOffer({ ...open, salesPage: false }), false);
  assert.strictEqual(exitPopup.shouldOffer({ ...open, excluded: true }), false);
  assert.strictEqual(exitPopup.shouldOffer({ ...open, ordersClosed: true }), false);
  assert.strictEqual(exitPopup.shouldOffer({ ...open, consentOpen: true }), false);
  assert.strictEqual(exitPopup.shouldOffer({ ...open, buyClicked: true }), false);
  assert.strictEqual(exitPopup.shouldOffer({ ...open, seenRecently: true }), false);
  assert.strictEqual(exitPopup.shouldOffer({ ...open, force: true, buyClicked: true, seenRecently: true }), true);
  assert.strictEqual(exitPopup.shouldOffer({ ...open, force: true, consentOpen: true }), false);
});

test("desktop leave is through the top, and a phone flick is a fast upward scroll after 25 seconds", () => {
  assert.strictEqual(exitPopup.leavesThroughTop({ clientY: -1, relatedTarget: null }), true);
  assert.strictEqual(exitPopup.leavesThroughTop({ clientY: 0, relatedTarget: null }), true);
  assert.strictEqual(exitPopup.leavesThroughTop({ clientY: 40, relatedTarget: null }), false);
  assert.strictEqual(exitPopup.leavesThroughTop({ clientY: -1, relatedTarget: {} }), false);
  assert.strictEqual(exitPopup.leavesThroughTop({ clientY: -1, toElement: {} }), false);

  assert.strictEqual(exitPopup.mobileReady(24999), false);
  assert.strictEqual(exitPopup.mobileReady(25000), true);
  assert.strictEqual(exitPopup.fastUpwardScroll({ fromY: 400, toY: 300, fromTime: 0, toTime: 120 }), true);
  assert.strictEqual(exitPopup.fastUpwardScroll({ fromY: 200, toY: 100, fromTime: 1000, toTime: 1000 }), true);
  assert.strictEqual(exitPopup.fastUpwardScroll({ fromY: 200, toY: 170, fromTime: 0, toTime: 40 }), false);
  assert.strictEqual(exitPopup.fastUpwardScroll({ fromY: 400, toY: 300, fromTime: 0, toTime: 500 }), false);
  assert.strictEqual(exitPopup.fastUpwardScroll({ fromY: 100, toY: 180, fromTime: 0, toTime: 40 }), false);

  const media = (coarse) => (query) => ({ matches: query.indexOf("pointer: coarse") !== -1 ? coarse : false });
  assert.strictEqual(exitPopup.desktopPointer(media(false)), true);
  assert.strictEqual(exitPopup.desktopPointer(media(true)), false);
  assert.strictEqual(exitPopup.desktopPointer(null), false);
});

test("the sales page holds the dialog, and the video file is not in the first HTML", async () => {
  const server = createServer({ log() {} });
  const port = await listen(server);
  try {
    const home = await fetch(`http://127.0.0.1:${port}/`);
    const html = await home.text();
    const popup = html.slice(html.indexOf('id="exit-popup"'), html.indexOf('id="enlarge"'));
    assert.match(popup, /role="dialog"/);
    assert.match(popup, /aria-modal="true"/);
    assert.match(popup, /aria-labelledby="exit-popup-title"/);
    assert.match(popup, /aria-label="Close"/);
    assert.match(popup, /Before you go\.\.\. give your favourite little ones that moment this Christmas\./);
    assert.match(popup, /id="exit-popup-cta"[^>]*data-pay="magicBundle"[^>]*href="#checkout"/);
    assert.match(popup, />Hear Santa say their name</);
    assert.match(popup, /id="exit-popup-no">No thanks</);
    assert.match(popup, /id="exit-unmute"/);
    assert.doesNotMatch(popup, /money back|refund|guarantee|autoplay|\bmuted\b|exit-sales-v4\.mp4/i);
    assert.match(html, /src="js\/exit-popup\.js"/);

    const privacy = await (await fetch(`http://127.0.0.1:${port}/privacy`)).text();
    const terms = await (await fetch(`http://127.0.0.1:${port}/terms`)).text();
    const order = await (await fetch(`http://127.0.0.1:${port}/order/continue?session_id=cs_live_exitpopup`)).text();
    for (const page of [privacy, terms, order]) {
      assert.doesNotMatch(page, /exit-popup|exit-sales-v4/);
    }

    const source = fs.readFileSync(path.join(__dirname, "../public/js/exit-popup.js"), "utf8");
    assert.match(source, /\/assets\/exit-sales-v4\.mp4/);
    assert.match(source, /preload = "none"/);
    assert.match(source, /trackCustom\("ExitPopupView"\)/);
    assert.doesNotMatch(source, /pushState|history\.back/);

    const pixel = fs.readFileSync(path.join(__dirname, "../public/js/meta-pixel.js"), "utf8");
    assert.match(pixel, /function trackCustom\(name\)/);
    assert.match(pixel, /readConsent\(\) !== "yes"/);
    assert.match(pixel, /fbq\("trackCustom", name\)/);
    assert.match(pixel, /898274206954064/);

    const videoPath = path.join(__dirname, "../public/assets/exit-sales-v4.mp4");
    const posterPath = path.join(__dirname, "../public/assets/exit-sales-poster-v4.jpg");
    assert.strictEqual(
      crypto.createHash("sha256").update(fs.readFileSync(videoPath)).digest("hex"),
      "21dc5e7f07e6c7f64574eaf9708a72264bfc879fc72c06166ff81e55db9f5e8b"
    );
    assert.strictEqual(
      crypto.createHash("sha256").update(fs.readFileSync(posterPath)).digest("hex"),
      "51687c60d7b9f13d9c1d68d16333872d330e18e5c6cdc57ae9a783e103cbef6b"
    );

    const file = fs.readFileSync(videoPath);
    const probe = await fetch(`http://127.0.0.1:${port}/assets/exit-sales-v4.mp4`, {
      headers: { Range: "bytes=0-7" },
    });
    assert.strictEqual(probe.status, 206);
    assert.strictEqual(probe.headers.get("content-type"), "video/mp4");
    assert.strictEqual(Buffer.from(await probe.arrayBuffer()).subarray(4, 8).toString("ascii"), "ftyp");
    const poster = await fetch(`http://127.0.0.1:${port}/assets/exit-sales-poster-v4.jpg`, { method: "HEAD" });
    assert.strictEqual(poster.status, 200);
    assert.strictEqual(poster.headers.get("content-type"), "image/jpeg");
    assert.ok(file.length > 1000);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
