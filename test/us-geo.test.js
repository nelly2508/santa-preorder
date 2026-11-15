"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { createServer } = require("../server");
const { isBot } = require("../lib/bot-ua");
const { countryForRedirect } = require("../lib/client-country");

const BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const WHATSAPP_PERSON = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 WhatsApp/2.23.20.0";
const GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const GOOGLE_OTHER = "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 (compatible; GoogleOther)";
const IP_US = "8.8.8.8";
const IP_GB = "81.2.69.142";
const SECRET = "geo-test-secret";

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}

function setCookies(res) {
  if (typeof res.headers.getSetCookie === "function") return res.headers.getSetCookie();
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

async function withServer(extra, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "santa-geo-"));
  const server = createServer({
    log() {},
    now: "2026-11-03T12:00:00Z",
    visitsFile: path.join(dir, "visits.json"),
    funnelFile: path.join(dir, "funnel.json"),
    env: { VISITS_SECRET: SECRET },
    ...extra,
  });
  const port = await listen(server);
  try {
    await fn(port);
  } finally {
    await close(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function browserHeaders(ip, extra) {
  return {
    "user-agent": BROWSER,
    ...(ip ? { "x-forwarded-for": ip } : {}),
    ...extra,
  };
}

async function report(port, pathname) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    headers: { Authorization: `Bearer ${SECRET}` },
  });
  assert.strictEqual(res.status, 200);
  return res.json();
}

test("bot detection catches crawlers and scripts and leaves real browsers alone", () => {
  const bot = (ua) => isBot({ headers: { "user-agent": ua } });
  assert.strictEqual(bot(""), true);
  assert.strictEqual(bot("   "), true);
  assert.strictEqual(isBot({ headers: {} }), true);
  assert.strictEqual(bot(GOOGLEBOT), true);
  assert.strictEqual(bot(GOOGLE_OTHER), true);
  assert.strictEqual(bot("Mozilla/5.0 (compatible; Google-InspectionTool/1.0;)"), true);
  assert.strictEqual(bot("facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)"), true);
  assert.strictEqual(bot("meta-externalagent/1.1"), true);
  assert.strictEqual(bot("WhatsApp/2.23.20.0 A"), true);
  assert.strictEqual(bot("curl/8.5.0"), true);
  assert.strictEqual(bot("python-requests/2.31.0"), true);
  assert.strictEqual(bot("node-fetch/1.0"), true);
  assert.strictEqual(bot("axios/1.6.0"), true);
  assert.strictEqual(bot(BROWSER), false);
  assert.strictEqual(bot(WHATSAPP_PERSON), false);
  assert.strictEqual(bot("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"), false);
  assert.strictEqual(bot("node"), false);
});

test("redirect country uses a geo header, then the forwarded address, and never the socket", () => {
  const lookup = (ip) => {
    if (ip === IP_US) return "US";
    if (ip === IP_GB) return "GB";
    return "US";
  };
  const socket = { remoteAddress: IP_US };
  assert.strictEqual(countryForRedirect({ headers: {}, socket }, lookup), "");
  assert.strictEqual(countryForRedirect({ headers: { "x-railway-edge": "iad1" }, socket }, lookup), "");
  assert.strictEqual(countryForRedirect({ headers: { "x-forwarded-for": IP_US } }, lookup), "US");
  assert.strictEqual(countryForRedirect({ headers: { "x-forwarded-for": `${IP_GB}, ${IP_US}` } }, lookup), "GB");
  assert.strictEqual(countryForRedirect({ headers: { "x-forwarded-for": "unknown", "x-real-ip": IP_US } }, lookup), "US");
  assert.strictEqual(countryForRedirect({ headers: { "cf-ipcountry": "us" } }, lookup), "US");
  assert.strictEqual(countryForRedirect({ headers: { "cf-ipcountry": "GB", "x-forwarded-for": IP_US } }, lookup), "GB");
  assert.strictEqual(countryForRedirect({ headers: { "cf-ipcountry": "XX", "x-forwarded-for": IP_US } }, lookup), "US");
  assert.strictEqual(countryForRedirect({ headers: { "cf-ipcountry": "T1", "x-forwarded-for": IP_GB } }, lookup), "GB");
  assert.strictEqual(countryForRedirect({
    headers: { "x-forwarded-for": IP_US },
    socket: { remoteAddress: IP_GB },
  }, () => {
    throw new Error("down");
  }), "XX");
});

test("a US visitor on / is sent to /us with the query string, and that redirect is not a view", async () => {
  await withServer({}, async (port) => {
    const origin = `http://127.0.0.1:${port}`;
    const home = await fetch(`${origin}/?utm_source=meta&utm_content=video`, {
      redirect: "manual",
      headers: browserHeaders(IP_US),
    });
    assert.strictEqual(home.status, 302);
    assert.strictEqual(home.headers.get("location"), "/us?utm_source=meta&utm_content=video");
    assert.match(home.headers.get("cache-control") || "", /private/);
    assert.match(home.headers.get("cache-control") || "", /no-store/);
    assert.match(home.headers.get("vary") || "", /User-Agent/);
    assert.match(home.headers.get("vary") || "", /Cookie/);

    const head = await fetch(`${origin}/?utm_source=meta`, {
      method: "HEAD",
      redirect: "manual",
      headers: browserHeaders(IP_US),
    });
    assert.strictEqual(head.status, 302);
    assert.strictEqual(head.headers.get("location"), "/us?utm_source=meta");

    const index = await fetch(`${origin}/index.html?utm_source=meta`, {
      redirect: "manual",
      headers: browserHeaders(IP_US),
    });
    assert.strictEqual(index.status, 302);
    assert.strictEqual(index.headers.get("location"), "/us?utm_source=meta");

    const prefetch = await fetch(`${origin}/`, {
      redirect: "manual",
      headers: browserHeaders(IP_US, { "sec-purpose": "prefetch" }),
    });
    assert.strictEqual(prefetch.status, 302);

    const privacy = await fetch(`${origin}/privacy`, {
      redirect: "manual",
      headers: browserHeaders(IP_US),
    });
    assert.strictEqual(privacy.status, 200);
    await privacy.text();

    let counts = await report(port, "/admin/funnel");
    assert.strictEqual(counts.total.view, 0);
    assert.strictEqual((await report(port, "/admin/visits")).total, 0);

    const us = await fetch(`${origin}/us?utm_source=meta&utm_content=video`, {
      redirect: "manual",
      headers: browserHeaders(IP_US),
    });
    assert.strictEqual(us.status, 200);
    const usHtml = await us.text();
    assert.match(usHtml, /data-market="us"/);
    assert.match(usHtml, /\$19\.99/);
    assert.match(usHtml, /hreflang="en-GB" href="https:\/\/santasaysmyname\.com\/"/);
    assert.match(usHtml, /hreflang="en-US" href="https:\/\/santasaysmyname\.com\/us"/);
    assert.match(usHtml, /hreflang="x-default" href="https:\/\/santasaysmyname\.com\/"/);

    const gb = await fetch(`${origin}/`, {
      redirect: "manual",
      headers: browserHeaders(IP_GB),
    });
    assert.strictEqual(gb.status, 200);
    const gbHtml = await gb.text();
    assert.match(gbHtml, /£16\.99/);
    assert.doesNotMatch(gbHtml, /data-market="us"/);
    assert.match(gbHtml, /hreflang="en-GB" href="https:\/\/santasaysmyname\.com\/"/);
    assert.ok(!setCookies(gb).some((row) => row.startsWith("ssmn_market=")));

    const noHeader = await fetch(`${origin}/`, {
      redirect: "manual",
      headers: { "user-agent": BROWSER },
    });
    assert.strictEqual(noHeader.status, 200);
    assert.match(await noHeader.text(), /£16\.99/);

    const edgeOnly = await fetch(`${origin}/`, {
      redirect: "manual",
      headers: browserHeaders(null, { "x-railway-edge": "iad1" }),
    });
    assert.strictEqual(edgeOnly.status, 200);
    await edgeOnly.text();

    const gbPrefetch = await fetch(`${origin}/?utm_source=meta&utm_content=skip`, {
      redirect: "manual",
      headers: browserHeaders(IP_GB, { "sec-purpose": "prefetch" }),
    });
    assert.strictEqual(gbPrefetch.status, 200);
    await gbPrefetch.text();

    counts = await report(port, "/admin/funnel");
    assert.strictEqual(counts.markets.us.view, 1);
    assert.strictEqual(counts.markets.uk.view, 3);
    assert.strictEqual((await report(port, "/admin/visits")).total, 3);
  });
});

test("with no country header and no forwarded address there is no redirect", async () => {
  await withServer({
    countryLookup(ip) {
      if (ip === "203.0.113.5") throw new Error("down");
      return "US";
    },
  }, async (port) => {
    const origin = `http://127.0.0.1:${port}`;
    const stay = await fetch(`${origin}/`, {
      redirect: "manual",
      headers: { "user-agent": BROWSER, "x-railway-edge": "iad1" },
    });
    assert.strictEqual(stay.status, 200);
    assert.match(await stay.text(), /£16\.99/);

    const forwarded = await fetch(`${origin}/?utm_source=meta`, {
      redirect: "manual",
      headers: browserHeaders("198.51.100.1"),
    });
    assert.strictEqual(forwarded.status, 302);
    assert.strictEqual(forwarded.headers.get("location"), "/us?utm_source=meta");

    const failed = await fetch(`${origin}/`, {
      redirect: "manual",
      headers: browserHeaders("203.0.113.5"),
    });
    assert.strictEqual(failed.status, 200);
    await failed.text();

    const headerUs = await fetch(`${origin}/`, {
      redirect: "manual",
      headers: { "user-agent": BROWSER, "cf-ipcountry": "US" },
    });
    assert.strictEqual(headerUs.status, 302);
    assert.strictEqual(headerUs.headers.get("location"), "/us");

    const headerGb = await fetch(`${origin}/`, {
      redirect: "manual",
      headers: browserHeaders("198.51.100.1", { "cf-ipcountry": "GB" }),
    });
    assert.strictEqual(headerGb.status, 200);
    assert.match(await headerGb.text(), /£16\.99/);

    const headerUnknown = await fetch(`${origin}/?utm_content=video`, {
      redirect: "manual",
      headers: browserHeaders("198.51.100.1", { "cf-ipcountry": "XX" }),
    });
    assert.strictEqual(headerUnknown.status, 302);
    assert.strictEqual(headerUnknown.headers.get("location"), "/us?utm_content=video");
  });
});

test("?market=uk is remembered so a later visit to / stays on the pound page", async () => {
  await withServer({}, async (port) => {
    const origin = `http://127.0.0.1:${port}`;
    const chosen = await fetch(`${origin}/?market=uk&utm_source=meta`, {
      redirect: "manual",
      headers: browserHeaders(IP_US),
    });
    assert.strictEqual(chosen.status, 200);
    assert.match(await chosen.text(), /£16\.99/);
    const marketCookie = setCookies(chosen).find((row) => row.startsWith("ssmn_market="));
    assert.ok(marketCookie, "expected ssmn_market cookie");
    assert.match(marketCookie, /^ssmn_market=uk;/);
    assert.match(marketCookie, /HttpOnly/);
    assert.match(marketCookie, /SameSite=Lax/);
    assert.match(marketCookie, /Path=\//);
    assert.doesNotMatch(marketCookie, /Secure/);

    const upper = await fetch(`${origin}/?market=UK`, {
      redirect: "manual",
      headers: browserHeaders(IP_US),
    });
    assert.strictEqual(upper.status, 200);
    await upper.text();

    const back = await fetch(`${origin}/`, {
      redirect: "manual",
      headers: browserHeaders(IP_US, { cookie: "ssmn_market=uk" }),
    });
    assert.strictEqual(back.status, 200);
    assert.match(await back.text(), /£16\.99/);
    assert.ok(setCookies(back).some((row) => row.startsWith("ssmn_market=uk")));

    const variantOnly = await fetch(`${origin}/`, {
      redirect: "manual",
      headers: browserHeaders(IP_US, { cookie: "ssmn_variant=parents" }),
    });
    assert.strictEqual(variantOnly.status, 302);
    assert.strictEqual(variantOnly.headers.get("location"), "/us");

    const secure = await fetch(`${origin}/?market=uk`, {
      redirect: "manual",
      headers: browserHeaders(IP_US, { "x-forwarded-proto": "https" }),
    });
    assert.strictEqual(secure.status, 200);
    await secure.text();
    const secureCookie = setCookies(secure).find((row) => row.startsWith("ssmn_market="));
    assert.match(secureCookie, /;\s*Secure/);

    const counts = await report(port, "/admin/funnel");
    assert.strictEqual(counts.markets.uk.view, 4);
    assert.strictEqual(counts.markets.us.view, 0);
  });
});

test("crawlers, link previews and scripts are not redirected and are not counted", async () => {
  await withServer({}, async (port) => {
    const origin = `http://127.0.0.1:${port}`;
    const cases = [
      GOOGLEBOT,
      GOOGLE_OTHER,
      "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
      "curl/8.5.0",
      "python-requests/2.31.0",
      "WhatsApp/2.23.20.0 A",
    ];
    for (const ua of cases) {
      const res = await fetch(`${origin}/?utm_source=meta`, {
        redirect: "manual",
        headers: { "user-agent": ua, "x-forwarded-for": IP_US },
      });
      assert.strictEqual(res.status, 200, ua);
      const html = await res.text();
      assert.match(html, /£16\.99/, ua);
      assert.match(html, /hreflang="en-GB" href="https:\/\/santasaysmyname\.com\/"/, ua);
      assert.match(html, /hreflang="en-US" href="https:\/\/santasaysmyname\.com\/us"/, ua);
      assert.match(html, /hreflang="x-default" href="https:\/\/santasaysmyname\.com\/"/, ua);
    }

    const usBot = await fetch(`${origin}/us`, {
      redirect: "manual",
      headers: { "user-agent": GOOGLEBOT, "x-forwarded-for": IP_US },
    });
    assert.strictEqual(usBot.status, 200);
    const usHtml = await usBot.text();
    assert.match(usHtml, /hreflang="en-US" href="https:\/\/santasaysmyname\.com\/us"/);
    assert.match(usHtml, /data-market="us"/);

    const bare = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1",
        port,
        path: "/",
        method: "GET",
        headers: { "x-forwarded-for": IP_US },
      }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      });
      req.on("error", reject);
      req.end();
    });
    assert.strictEqual(bare, 200);

    const person = await fetch(`${origin}/`, {
      redirect: "manual",
      headers: { "user-agent": WHATSAPP_PERSON, "x-forwarded-for": IP_US },
    });
    assert.strictEqual(person.status, 302);
    assert.strictEqual(person.headers.get("location"), "/us");

    const counts = await report(port, "/admin/funnel");
    assert.strictEqual(counts.total.view, 0);
    assert.strictEqual((await report(port, "/admin/visits")).total, 0);
  });
});
