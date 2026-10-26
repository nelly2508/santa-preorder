"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const { createServer } = require("../server");

const PUBLIC = path.join(__dirname, "../public");

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

async function withServer(fn, options) {
  const server = createServer(options || { log() {} });
  const port = await listen(server);
  try {
    await fn(port);
  } finally {
    await close(server);
  }
}

test("preview assets are the original files, with a smaller webp poster", () => {
  assert.strictEqual(
    sha256(path.join(PUBLIC, "assets/santa-preview-v3.mp4")),
    "d6d62331f67114058263b2a450deb78c4e5a862cdc4c027ea16d1429c850aefc"
  );
  assert.strictEqual(
    sha256(path.join(PUBLIC, "assets/santa-preview-poster-v3.jpg")),
    "d00d1ce90c0aa523f776edd6fc1fce59514c36cdcbfafb2f3f96180ea7240972"
  );
  assert.strictEqual(
    sha256(path.join(PUBLIC, "assets/santa-preview.vtt")),
    "36a2bf353fc8bca777b1b4307967c5bb3444b34bc304dd532045816f09ec541d"
  );
  const jpg = fs.statSync(path.join(PUBLIC, "assets/santa-preview-poster-v3.jpg")).size;
  const webp = fs.statSync(path.join(PUBLIC, "assets/santa-preview-poster-v3.webp")).size;
  assert.ok(webp < jpg, `webp poster should be smaller than the jpg (${webp} >= ${jpg})`);

  const vtt = fs.readFileSync(path.join(PUBLIC, "assets/santa-preview.vtt"), "utf8");
  assert.match(vtt, /^WEBVTT\r?\n/);
  assert.match(
    vtt,
    /I can't make any promises, Saoirse, but I'll have a quiet word with the elves\./
  );
  assert.doesNotMatch(vtt, /Ho ho/);
});

test("the homepage offers Hear Santa without autoplay", async () => {
  await withServer(async (port) => {
    const home = await fetch(`http://127.0.0.1:${port}/`);
    assert.strictEqual(home.status, 200);
    const html = await home.text();
    assert.match(html, /<h2>Hear Santa<\/h2>/);
    assert.match(html, /id="hear-santa"[\s\S]*?\bcontrols\b/);
    assert.match(html, /id="hear-santa"[\s\S]*?\bplaysinline\b/);
    assert.match(html, /id="hear-santa"[\s\S]*?preload="metadata"/);
    assert.match(html, /id="hear-santa"[\s\S]*?width="1080"/);
    assert.match(html, /id="hear-santa"[\s\S]*?height="1350"/);
    assert.match(html, /id="hear-santa"[\s\S]*?poster="\/assets\/review-poster-v3\.jpg"/);
    assert.match(html, /id="hear-santa"[\s\S]*?aria-label="Santa saying a short hello"/);
    assert.match(html, /src="\/assets\/santa-preview-v3\.mp4"/);
    assert.match(html, /src="\/assets\/santa-preview\.vtt"/);
    assert.match(
      html,
      /A quick hello from Santa\. The film you order says your child's name, a good deed and a wish\./
    );
    assert.match(
      html,
      /Santa says Saoirse \(Seer-sha\) perfectly\. He'll get your child's name right too\./
    );
    const hear = html.indexOf('id="hear"');
    const what = html.indexOf('id="what"');
    const samples = html.indexOf('id="samples"');
    const pricing = html.indexOf('id="pricing"');
    const checkout = html.indexOf('id="checkout"');
    const how = html.indexOf('id="how"');
    const faq = html.indexOf('id="faq"');
    const order = html.indexOf('id="order"');
    const privacy = html.indexOf('id="privacy"');
    assert.ok(
      hear < what &&
        what < samples &&
        samples < pricing &&
        pricing < checkout &&
        checkout < how &&
        how < faq &&
        faq < order &&
        order < privacy,
      "homepage sections are out of order"
    );
    assert.match(html, /Santa sits in an armchair by the fire/);
    assert.doesNotMatch(html, /id="hear-santa"[\s\S]*?\bautoplay\b/);
    assert.doesNotMatch(html, /id="hear-santa"[\s\S]*?\bmuted\b/);
    const css = await (await fetch(`http://127.0.0.1:${port}/css/styles.css`)).text();
    assert.match(css, /\.hear-player \.hear-frame video\s*\{[^}]*aspect-ratio:\s*4\s*\/\s*5/);
    assert.match(css, /\.hear-player \.hear-frame video\s*\{[^}]*object-fit:\s*contain/);
    assert.doesNotMatch(html, /Father Christmas|Oliver|sample\.mp4|Sample clip|sample-video/i);
    const withoutClosedLine = html.replace(/Santa's workshop is closed for orders this Christmas\. Thank you!/g, "");
    assert.doesNotMatch(withoutClosedLine, /workshop|By the fire first|coming later|workshop\.webp|sleigh\.webp|id="scenes"/i);
    assert.doesNotMatch(html, /id="hear"[\s\S]*?style=/);
    const terms = await fetch(`http://127.0.0.1:${port}/terms`);
    const termsHtml = await terms.text();
    assert.match(termsHtml, /The personalised film is Santa by the fire\. That is the film we make\./);
    assert.doesNotMatch(termsHtml, /workshop|coming later|asked to choose it/i);
  });
});

test("a static file answers one byte range and a plain GET", async () => {
  const file = fs.readFileSync(path.join(PUBLIC, "favicon.svg"));
  await withServer(async (port) => {
    const full = await fetch(`http://127.0.0.1:${port}/favicon.svg`);
    assert.strictEqual(full.status, 200);
    assert.strictEqual(full.headers.get("accept-ranges"), "bytes");
    assert.strictEqual(Number(full.headers.get("content-length")), file.length);
    assert.strictEqual(full.headers.get("content-security-policy").includes("media-src 'self'"), true);
    assert.deepStrictEqual(Buffer.from(await full.arrayBuffer()), file);

    const probe = await fetch(`http://127.0.0.1:${port}/favicon.svg`, {
      headers: { Range: "bytes=0-1" },
    });
    assert.strictEqual(probe.status, 206);
    assert.strictEqual(probe.headers.get("accept-ranges"), "bytes");
    assert.strictEqual(probe.headers.get("content-range"), `bytes 0-1/${file.length}`);
    assert.strictEqual(Number(probe.headers.get("content-length")), 2);
    assert.deepStrictEqual(Buffer.from(await probe.arrayBuffer()), file.subarray(0, 2));

    const open = await fetch(`http://127.0.0.1:${port}/favicon.svg`, {
      headers: { Range: "bytes=4-" },
    });
    assert.strictEqual(open.status, 206);
    assert.strictEqual(open.headers.get("content-range"), `bytes 4-${file.length - 1}/${file.length}`);
    assert.deepStrictEqual(Buffer.from(await open.arrayBuffer()), file.subarray(4));

    const suffix = await fetch(`http://127.0.0.1:${port}/favicon.svg`, {
      headers: { Range: "bytes=-5" },
    });
    assert.strictEqual(suffix.status, 206);
    assert.strictEqual(
      suffix.headers.get("content-range"),
      `bytes ${file.length - 5}-${file.length - 1}/${file.length}`
    );
    assert.deepStrictEqual(Buffer.from(await suffix.arrayBuffer()), file.subarray(file.length - 5));

    const clamped = await fetch(`http://127.0.0.1:${port}/favicon.svg`, {
      headers: { Range: "bytes=2-999999" },
    });
    assert.strictEqual(clamped.status, 206);
    assert.strictEqual(clamped.headers.get("content-range"), `bytes 2-${file.length - 1}/${file.length}`);
    assert.deepStrictEqual(Buffer.from(await clamped.arrayBuffer()), file.subarray(2));

    const hugeSuffix = await fetch(`http://127.0.0.1:${port}/favicon.svg`, {
      headers: { Range: "bytes=-999999" },
    });
    assert.strictEqual(hugeSuffix.status, 206);
    assert.strictEqual(hugeSuffix.headers.get("content-range"), `bytes 0-${file.length - 1}/${file.length}`);
    assert.deepStrictEqual(Buffer.from(await hugeSuffix.arrayBuffer()), file);
  });
});

test("an unsatisfiable range is 416 and a bad range is the whole file", async () => {
  const file = fs.readFileSync(path.join(PUBLIC, "favicon.svg"));
  await withServer(async (port) => {
    const missed = await fetch(`http://127.0.0.1:${port}/favicon.svg`, {
      headers: { Range: "bytes=1000000-1000001" },
    });
    assert.strictEqual(missed.status, 416);
    assert.strictEqual(missed.headers.get("content-range"), `bytes */${file.length}`);
    assert.strictEqual(missed.headers.get("accept-ranges"), "bytes");
    assert.strictEqual(Number(missed.headers.get("content-length")), 0);
    assert.strictEqual(await missed.text(), "");

    const emptySuffix = await fetch(`http://127.0.0.1:${port}/favicon.svg`, {
      headers: { Range: "bytes=-0" },
    });
    assert.strictEqual(emptySuffix.status, 416);
    assert.strictEqual(emptySuffix.headers.get("content-range"), `bytes */${file.length}`);

    const inverted = await fetch(`http://127.0.0.1:${port}/favicon.svg`, {
      headers: { Range: "bytes=8-2" },
    });
    assert.strictEqual(inverted.status, 200);
    assert.strictEqual(inverted.headers.get("content-range"), null);
    assert.deepStrictEqual(Buffer.from(await inverted.arrayBuffer()), file);

    const multi = await fetch(`http://127.0.0.1:${port}/favicon.svg`, {
      headers: { Range: "bytes=0-1,2-3" },
    });
    assert.strictEqual(multi.status, 200);
    assert.deepStrictEqual(Buffer.from(await multi.arrayBuffer()), file);

    const missing = await fetch(`http://127.0.0.1:${port}/assets/missing-preview.mp4`, {
      headers: { Range: "bytes=0-1" },
    });
    assert.strictEqual(missing.status, 404);
  });
});

test("HEAD honours a byte range and does not send a body", async () => {
  const file = fs.readFileSync(path.join(PUBLIC, "favicon.svg"));
  await withServer(async (port) => {
    const head = await fetch(`http://127.0.0.1:${port}/favicon.svg`, { method: "HEAD" });
    assert.strictEqual(head.status, 200);
    assert.strictEqual(head.headers.get("accept-ranges"), "bytes");
    assert.strictEqual(Number(head.headers.get("content-length")), file.length);
    assert.strictEqual(await head.text(), "");

    const ranged = await fetch(`http://127.0.0.1:${port}/favicon.svg`, {
      method: "HEAD",
      headers: { Range: "bytes=0-3" },
    });
    assert.strictEqual(ranged.status, 206);
    assert.strictEqual(ranged.headers.get("content-range"), `bytes 0-3/${file.length}`);
    assert.strictEqual(Number(ranged.headers.get("content-length")), 4);
    assert.strictEqual(await ranged.text(), "");

    const missing = await fetch(`http://127.0.0.1:${port}/no-such-page`, { method: "HEAD" });
    assert.strictEqual(missing.status, 404);
    assert.strictEqual(await missing.text(), "");
  });
});

test("the Santa preview answers the range probe iOS uses", async () => {
  const file = fs.readFileSync(path.join(PUBLIC, "assets/santa-preview-v3.mp4"));
  await withServer(async (port) => {
    const probe = await fetch(`http://127.0.0.1:${port}/assets/santa-preview-v3.mp4`, {
      headers: { Range: "bytes=0-1" },
    });
    assert.strictEqual(probe.status, 206);
    assert.strictEqual(probe.headers.get("content-type"), "video/mp4");
    assert.strictEqual(probe.headers.get("accept-ranges"), "bytes");
    assert.strictEqual(probe.headers.get("content-range"), `bytes 0-1/${file.length}`);
    assert.strictEqual(Number(probe.headers.get("content-length")), 2);
    assert.deepStrictEqual(Buffer.from(await probe.arrayBuffer()), file.subarray(0, 2));

    const rest = await fetch(`http://127.0.0.1:${port}/assets/santa-preview-v3.mp4`, {
      headers: { Range: "bytes=0-" },
    });
    assert.strictEqual(rest.status, 206);
    assert.strictEqual(rest.headers.get("content-range"), `bytes 0-${file.length - 1}/${file.length}`);
    assert.strictEqual(Number(rest.headers.get("content-length")), file.length);
    const body = Buffer.from(await rest.arrayBuffer());
    assert.strictEqual(body.length, file.length);
    assert.deepStrictEqual(body.subarray(0, 8), file.subarray(0, 8));
    assert.strictEqual(body.subarray(4, 8).toString("ascii"), "ftyp");

    const poster = await fetch(`http://127.0.0.1:${port}/assets/santa-preview-poster-v3.jpg`, { method: "HEAD" });
    assert.strictEqual(poster.status, 200);
    assert.strictEqual(poster.headers.get("content-type"), "image/jpeg");

    const reviewPoster = await fetch(`http://127.0.0.1:${port}/assets/review-poster-v3.jpg`);
    assert.strictEqual(reviewPoster.status, 200);
    assert.strictEqual(reviewPoster.headers.get("content-type"), "image/jpeg");
    assert.strictEqual(
      crypto.createHash("sha256").update(Buffer.from(await reviewPoster.arrayBuffer())).digest("hex"),
      sha256(path.join(PUBLIC, "assets/santa-preview-poster-v3.jpg"))
    );

    const webp = await fetch(`http://127.0.0.1:${port}/assets/santa-preview-poster-v3.webp`, { method: "HEAD" });
    assert.strictEqual(webp.status, 200);
    assert.strictEqual(webp.headers.get("content-type"), "image/webp");

    const captions = await fetch(`http://127.0.0.1:${port}/assets/santa-preview.vtt`);
    assert.strictEqual(captions.status, 200);
    assert.match(captions.headers.get("content-type"), /^text\/vtt/);
    assert.match(await captions.text(), /quiet word with the elves/);
  });
});

test("a range header on /order/continue still sends the customer on to Tally", async () => {
  await withServer(
    async (port) => {
      const redirect = await fetch(
        `http://127.0.0.1:${port}/order/continue?session_id=cs_live_range1`,
        { redirect: "manual", headers: { Range: "bytes=0-1" } }
      );
      assert.strictEqual(redirect.status, 200);
      assert.strictEqual(redirect.headers.get("content-range"), null);
      const body = await redirect.text();
      assert.match(
        body,
        /data-continue="https:\/\/tally\.so\/r\/Dq25LE\?order=cs_live_range1&amp;children=1&amp;rush=0&amp;sleigh=0&amp;package=single"/
      );
      assert.doesNotMatch(body, /data-purchase-value/);

      const blocked = await fetch(`http://127.0.0.1:${port}/assets/santa-preview-v3.mp4`, { method: "POST" });
      assert.strictEqual(blocked.status, 405);
    },
    {
      log() {},
      env: { STRIPE_SECRET_KEY: "rk_live_secret" },
      retrieveSession() {
        return {
          payment_status: "paid",
          metadata: {},
          line_items: {
            data: [
              {
                quantity: 1,
                description: "Single video",
                price: {
                  currency: "gbp",
                  unit_amount: 1499,
                  nickname: "",
                  metadata: {},
                  product: "prod_x",
                },
              },
            ],
          },
        };
      },
    }
  );
});
