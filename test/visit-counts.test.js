"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { createServer } = require("../server");
const { normalisePart, partsFromUrl } = require("../lib/visit-counts");

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}

test("campaign labels keep letters and drop anything that could be personal", () => {
  assert.strictEqual(normalisePart(" meta "), "meta");
  assert.strictEqual(normalisePart("Xmas_UK.video-1"), "Xmas_UK.video-1");
  assert.strictEqual(normalisePart("parent@example.com"), "");
  assert.strictEqual(normalisePart("<script>"), "script");
  assert.strictEqual(normalisePart(""), "");
  const url = new URL("http://localhost/?utm_source=meta&utm_campaign=xmas&utm_content=sao&utm_term=ignore&email=a@b.c");
  assert.deepStrictEqual(partsFromUrl(url), {
    utm_source: "meta",
    utm_campaign: "xmas",
    utm_content: "sao",
  });
});

test("visit counts are aggregate campaign totals behind the admin secret", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "santa-visits-"));
  const filePath = path.join(dir, "visit-counts.json");
  const secret = "visits-test-secret";
  const server = createServer({
    log() {},
    visitsFile: filePath,
    env: { VISITS_SECRET: secret },
  });
  const port = await listen(server);
  try {
    const home = await fetch(`http://127.0.0.1:${port}/?utm_source=meta&utm_campaign=xmas&utm_content=video`);
    assert.strictEqual(home.status, 200);
    const again = await fetch(`http://127.0.0.1:${port}/?utm_source=meta&utm_campaign=xmas&utm_content=video&email=parent@example.com`);
    assert.strictEqual(again.status, 200);
    const other = await fetch(`http://127.0.0.1:${port}/?utm_source=meta&utm_campaign=xmas&utm_content=still`);
    assert.strictEqual(other.status, 200);
    const plain = await fetch(`http://127.0.0.1:${port}/`);
    assert.strictEqual(plain.status, 200);
    const prefetched = await fetch(`http://127.0.0.1:${port}/?utm_source=meta&utm_campaign=xmas&utm_content=video`, {
      headers: { "sec-purpose": "prefetch" },
    });
    assert.strictEqual(prefetched.status, 200);
    await fetch(`http://127.0.0.1:${port}/privacy?utm_source=meta&utm_campaign=xmas&utm_content=video`);

    const missing = await fetch(`http://127.0.0.1:${port}/admin/visits`);
    assert.strictEqual(missing.status, 401);
    const query = await fetch(`http://127.0.0.1:${port}/admin/visits?secret=${secret}`);
    assert.strictEqual(query.status, 401);
    assert.doesNotMatch(await query.text(), new RegExp(secret));

    const wrong = await fetch(`http://127.0.0.1:${port}/admin/visits`, {
      headers: { Authorization: "Bearer not-the-secret" },
    });
    assert.strictEqual(wrong.status, 401);

    const report = await fetch(`http://127.0.0.1:${port}/admin/visits`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    assert.strictEqual(report.status, 200);
    assert.match(report.headers.get("cache-control"), /no-store/);
    const body = await report.json();
    assert.strictEqual(body.total, 4);
    assert.deepStrictEqual(
      body.visits.find((row) => row.utm_content === "video"),
      { utm_source: "meta", utm_campaign: "xmas", utm_content: "video", count: 2 }
    );
    assert.deepStrictEqual(
      body.visits.find((row) => row.utm_content === "still"),
      { utm_source: "meta", utm_campaign: "xmas", utm_content: "still", count: 1 }
    );
    assert.deepStrictEqual(
      body.visits.find((row) => row.utm_source === ""),
      { utm_source: "", utm_campaign: "", utm_content: "", count: 1 }
    );
    const saved = JSON.stringify(body);
    assert.doesNotMatch(saved, /ip|userAgent|email|parent@/i);

    const header = await fetch(`http://127.0.0.1:${port}/admin/visits`, {
      headers: { "X-Visits-Secret": secret },
    });
    assert.strictEqual(header.status, 200);

    const blocked = await fetch(`http://127.0.0.1:${port}/admin/visits`, { method: "POST" });
    assert.strictEqual(blocked.status, 405);

    const started = Date.now();
    while (Date.now() - started < 2000) {
      try {
        const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (saved.total === 4) break;
      } catch {
        // The file is written after the response, on purpose.
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    await close(server);
  }

  const restarted = createServer({
    log() {},
    visitsFile: filePath,
    env: { VISITS_SECRET: secret },
  });
  const port2 = await listen(restarted);
  try {
    const report = await fetch(`http://127.0.0.1:${port2}/admin/visits`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    const body = await report.json();
    assert.ok(body.total >= 4, `expected the file to keep the totals, got ${body.total}`);
  } finally {
    await close(restarted);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("visit counts stay closed when VISITS_SECRET is unset", async () => {
  const server = createServer({ log() {}, visitsFile: null, env: {} });
  const port = await listen(server);
  try {
    const report = await fetch(`http://127.0.0.1:${port}/admin/visits`);
    assert.strictEqual(report.status, 503);
    const body = await report.json();
    assert.deepStrictEqual(body, { error: "not configured" });
  } finally {
    await close(server);
  }
});
