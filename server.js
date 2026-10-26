"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { describeOrder, fallbackLocation } = require("./lib/order-continue");
const { createVisitCounter, secretsMatch, presentedSecret } = require("./lib/visit-counts");
const { offerPhase, ordersOpen, packageChoice } = require("./public/js/checkout-choice");
const vm = require("vm");

const PORT = Number(process.env.PORT) || 3000;
const HOST = "0.0.0.0";
const ROOT = path.resolve(__dirname, "public");

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' https://www.facebook.com; media-src 'self'; style-src 'self'; script-src 'self' https://connect.facebook.net; font-src 'self'; connect-src 'self' https://www.facebook.com https://connect.facebook.net https://graph.facebook.com; frame-src https://www.facebook.com; base-uri 'self'; frame-ancestors 'none'",
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".woff2": "font/woff2",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".vtt": "text/vtt; charset=utf-8",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

const LONG_CACHE = new Set([".webp", ".woff2", ".svg", ".jpg", ".jpeg", ".png", ".gif", ".mp4", ".webm"]);

function send(res, status, body, headers, method) {
  const payload = Buffer.from(body);
  res.writeHead(status, {
    "Content-Length": payload.length,
    ...SECURITY_HEADERS,
    ...headers,
  });
  res.end(method === "HEAD" ? undefined : payload);
}

function notFound(res, method) {
  const body = `<!DOCTYPE html>
<html lang="en-GB">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Page not found — Santa Says My Name</title>
  <link rel="stylesheet" href="/css/styles.css">
</head>
<body class="missing">
  <main class="missing-main">
    <p class="kicker">404</p>
    <h1>That page has gone up the chimney.</h1>
    <p><a class="btn" href="/">Back to the pre-order page</a></p>
  </main>
</body>
</html>`;
  send(
    res,
    404,
    body,
    { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
    method
  );
}

function candidateFiles(urlPath) {
  let pathname;
  try {
    pathname = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (pathname.includes("\0")) return null;
  if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
  if (pathname === "/" || pathname === "") pathname = "/index.html";

  const names = [pathname];
  if (!path.extname(pathname)) names.push(`${pathname}.html`);

  const files = [];
  for (const name of names) {
    const filePath = path.resolve(ROOT, `.${name}`);
    if (filePath !== ROOT && !filePath.startsWith(`${ROOT}${path.sep}`)) return null;
    files.push(filePath);
  }
  return files;
}

// One satisfiable byte range, or null to send the whole file.
// "unsatisfiable" means the client asked for bytes the file does not have.
function parseSingleRange(header, size) {
  if (header == null || header === "") return null;
  const value = Array.isArray(header) ? String(header[0]) : String(header);
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match) return null;

  const startText = match[1];
  const endText = match[2];
  if (startText === "" && endText === "") return null;

  if (startText === "") {
    const suffix = Number(endText);
    if (!Number.isFinite(suffix) || suffix <= 0 || size <= 0) return "unsatisfiable";
    const length = Math.min(Math.floor(suffix), size);
    return { start: size - length, end: size - 1 };
  }

  const start = Number(startText);
  if (!Number.isFinite(start) || start < 0) return null;
  if (size <= 0 || start >= size) return "unsatisfiable";

  let end = size - 1;
  if (endText !== "") {
    end = Number(endText);
    if (!Number.isFinite(end) || end < start) return null;
    if (end >= size) end = size - 1;
  }

  return { start, end };
}

function streamFile(filePath, res, range) {
  const options = range ? { start: range.start, end: range.end } : {};
  const stream = fs.createReadStream(filePath, options);
  stream.on("error", () => {
    res.destroy();
  });
  stream.pipe(res);
}

function serveFile(filePath, stat, res, method, rangeHeader) {
  const ext = path.extname(filePath).toLowerCase();
  const cache = LONG_CACHE.has(ext) ? "public, max-age=86400" : "no-cache";
  const headers = {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": cache,
    ...SECURITY_HEADERS,
  };
  const range = parseSingleRange(rangeHeader, stat.size);

  if (range === "unsatisfiable") {
    send(
      res,
      416,
      "",
      {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Range": `bytes */${stat.size}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-cache",
      },
      method
    );
    return;
  }

  if (range) {
    const length = range.end - range.start + 1;
    res.writeHead(206, {
      ...headers,
      "Content-Length": length,
      "Content-Range": `bytes ${range.start}-${range.end}/${stat.size}`,
    });
    if (method === "HEAD") {
      res.end();
      return;
    }
    streamFile(filePath, res, range);
    return;
  }

  res.writeHead(200, {
    ...headers,
    "Content-Length": stat.size,
  });
  if (method === "HEAD") {
    res.end();
    return;
  }
  streamFile(filePath, res);
}

function serveFirst(files, index, res, method, rangeHeader) {
  if (index >= files.length) {
    notFound(res, method);
    return;
  }

  const filePath = files[index];
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      serveFirst(files, index + 1, res, method, rangeHeader);
      return;
    }
    serveFile(filePath, stat, res, method, rangeHeader);
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function orderContinueHtml(location, purchase) {
  const safeUrl = escapeHtml(location);
  const hasAmount = purchase && Number.isFinite(purchase.value);
  const purchaseAttrs = hasAmount
    ? ` data-purchase-value="${escapeHtml(purchase.value.toFixed(2))}" data-purchase-currency="GBP"`
    : "";
  return `<!DOCTYPE html>
<html lang="en-GB">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Payment received — Santa Says My Name</title>
  <meta name="referrer" content="no-referrer">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/css/styles.css">
  <noscript><meta http-equiv="refresh" content="0;url=${safeUrl}"></noscript>
</head>
<body class="order-continue" data-order-continue data-continue="${safeUrl}"${purchaseAttrs}>
  <main class="section">
    <div class="wrap narrow">
      <p class="kicker">Paid</p>
      <h1>Payment received.</h1>
      <p class="lede">Next, tell us your child\u2019s name. We\u2019re opening the order form.</p>
      <p><a class="btn" href="${safeUrl}" rel="noreferrer">Continue to the order form</a></p>
    </div>
  </main>
  <script src="/js/meta-pixel.js"></script>
</body>
</html>`;
}

function sendOrderPage(res, method, result) {
  const location = result && result.location ? result.location : fallbackLocation("");
  send(
    res,
    200,
    orderContinueHtml(location, result && result.purchase),
    {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
    method
  );
}

let siteConfigCache;

function siteConfig() {
  if (!siteConfigCache) {
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(ROOT, "js/config.js"), "utf8"), sandbox, { filename: "config.js" });
    siteConfigCache = sandbox.window.SANTA_CONFIG;
  }
  return siteConfigCache;
}

function serverNow(options) {
  if (typeof options.now === "function") return new Date(options.now());
  if (options.now != null) return new Date(options.now);
  return new Date();
}

const CLOSED_MESSAGE = "Santa's workshop is closed for orders this Christmas. Thank you!";

function closedOrderHtml() {
  return `<!DOCTYPE html>
<html lang="en-GB">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Orders closed — Santa Says My Name</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/css/styles.css">
</head>
<body class="order-continue">
  <main class="section">
    <div class="wrap narrow">
      <p class="kicker">Closed</p>
      <h1>${CLOSED_MESSAGE}</h1>
      <p><a class="btn" href="/">Back to Santa Says My Name</a></p>
    </div>
  </main>
</body>
</html>`;
}

function markOrdersClosed(html) {
  return html
    .replace("<body data-sales-page>", "<body data-sales-page data-orders-closed>")
    .replace('id="orders-closed" hidden', 'id="orders-closed"');
}

const WEBHOOK_MAX_BYTES = 1024 * 1024;

function webhookReply(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function handleStripeWebhook(req, res, { env, log, options }) {
  if (req.method !== "POST") {
    res.writeHead(405, { Allow: "POST", "Cache-Control": "no-store" });
    res.end();
    return;
  }
  const secret = env.STRIPE_WEBHOOK_SECRET ? String(env.STRIPE_WEBHOOK_SECRET).trim() : "";
  if (!secret) {
    log("stripe/webhook: STRIPE_WEBHOOK_SECRET is not set, refusing");
    req.resume();
    webhookReply(res, 503, { error: "webhook not configured" });
    return;
  }
  const chunks = [];
  let size = 0;
  let aborted = false;
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > WEBHOOK_MAX_BYTES && !aborted) {
      aborted = true;
      webhookReply(res, 413, { error: "too large" });
      req.destroy();
      return;
    }
    if (!aborted) chunks.push(chunk);
  });
  req.on("end", async () => {
    if (aborted) return;
    const raw = Buffer.concat(chunks);
    let event;
    try {
      const verify = options.constructWebhookEvent || ((body, sig, sec) => require("stripe").webhooks.constructEvent(body, sig, sec));
      event = verify(raw, req.headers["stripe-signature"] || "", secret);
    } catch {
      log("stripe/webhook: signature verification failed");
      webhookReply(res, 400, { error: "bad signature" });
      return;
    }
    if (!event || (event.type !== "checkout.session.completed" && event.type !== "checkout.session.async_payment_succeeded")) {
      webhookReply(res, 200, { received: true, ignored: true });
      return;
    }
    const sessionId = event.data && event.data.object && event.data.object.id ? String(event.data.object.id) : "";
    try {
      await describeOrder({
        sessionId,
        env,
        retrieveSession: options.retrieveSession,
        log,
        sendMail: options.sendMail,
        readMetadata: options.readMetadata,
        writeMetadata: options.writeMetadata,
        stripe: options.stripe,
        emailWaitMs: options.webhookEmailWaitMs == null ? 20000 : options.webhookEmailWaitMs,
        claimId: options.claimId,
        now: options.emailNow,
        claimTtlMs: options.claimTtlMs,
        flights: options.flights,
      });
    } catch (error) {
      log(`stripe/webhook ${sessionId}: ${error && error.message ? "order handling failed" : "order handling failed"}`);
    }
    webhookReply(res, 200, { received: true });
  });
}

function visitsFilePath(options, env) {
  if (options.visitsFile === null) return null;
  if (typeof options.visitsFile === "string") return options.visitsFile;
  if (env && env.VISITS_FILE) return String(env.VISITS_FILE);
  return path.join(__dirname, "data", "visit-counts.json");
}

function sendJson(res, status, body, method, extra) {
  send(res, status, JSON.stringify(body), {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extra,
  }, method);
}

function handleVisitReport(req, res, env, visits) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD", "Cache-Control": "no-store" });
    res.end();
    return;
  }
  const secret = env && env.VISITS_SECRET ? String(env.VISITS_SECRET).trim() : "";
  if (!secret) {
    sendJson(res, 503, { error: "not configured" }, req.method);
    return;
  }
  if (!secretsMatch(presentedSecret(req), secret)) {
    sendJson(res, 401, { error: "unauthorised" }, req.method, { "WWW-Authenticate": "Bearer" });
    return;
  }
  sendJson(res, 200, visits.snapshot(), req.method);
}

function createServer(options = {}) {
  const env = options.env || process.env;
  const log = options.log || ((message) => console.error(message));
  const visits = options.visitCounter || createVisitCounter({ filePath: visitsFilePath(options, env) });
  return http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      notFound(res, req.method);
      return;
    }

    if (url.pathname === "/admin/visits") {
      handleVisitReport(req, res, env, visits);
      return;
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const purpose = String(req.headers["sec-purpose"] || req.headers.purpose || "");
      if (!/prefetch/i.test(purpose)) {
        try {
          visits.record(url);
        } catch {
          // A missed count must not stop the page.
        }
      }
    }

    if (url.pathname === "/stripe/webhook") {
      handleStripeWebhook(req, res, { env, log, options });
      return;
    }

    if (url.pathname === "/order/continue") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { Allow: "GET, HEAD", "Cache-Control": "no-store" });
        res.end();
        return;
      }
      const sessionId = url.searchParams.get("session_id") || "";
      describeOrder({
        sessionId,
        env,
        retrieveSession: options.retrieveSession,
        log,
        sendMail: options.sendMail,
        readMetadata: options.readMetadata,
        writeMetadata: options.writeMetadata,
        stripe: options.stripe,
        emailWaitMs: options.emailWaitMs,
        claimId: options.claimId,
        now: options.emailNow,
        claimTtlMs: options.claimTtlMs,
        flights: options.flights,
      }).then(
        (result) => sendOrderPage(res, req.method, result),
        (error) => {
          let message = error && error.message ? error.message : String(error);
          for (const secret of [env && env.SMTP_PASS, env && env.BREVO_API_KEY]) {
            if (secret) message = message.split(String(secret)).join("[redacted]");
          }
          log(`order/continue ${sessionId || "(missing session)"}: ${message}`);
          sendOrderPage(res, req.method, {
            location: fallbackLocation(/^cs_(live|test)_[A-Za-z0-9]+$/.test(sessionId) ? sessionId : ""),
            purchase: null,
          });
        }
      );
      return;
    }

    if (url.pathname === "/order/pay") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { Allow: "GET, HEAD", "Cache-Control": "no-store" });
        res.end();
        return;
      }
      const now = serverNow(options);
      if (!ordersOpen(now)) {
        send(res, 200, closedOrderHtml(), {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        }, req.method);
        return;
      }
      const config = siteConfig();
      const phase = offerPhase({
        now,
        earlyBird: config.earlyBird,
        earlyBirdEnds: config.earlyBirdEnds,
        lateOrders: config.lateOrders,
        lateOrdersFrom: config.lateOrdersFrom,
      });
      const packageKey = url.searchParams.get("package") === "singleVideo" ? "singleVideo" : "magicBundle";
      const choice = packageChoice(packageKey, {
        early: phase === "early",
        late: phase === "late",
        prices: config.prices,
        stripe: config.stripe,
      });
      res.writeHead(302, {
        Location: choice.href,
        "Cache-Control": "no-store",
        ...SECURITY_HEADERS,
      });
      res.end();
      return;
    }

    if ((url.pathname === "/" || url.pathname === "/index.html") && (req.method === "GET" || req.method === "HEAD") && !ordersOpen(serverNow(options))) {
      fs.readFile(path.join(ROOT, "index.html"), (err, buf) => {
        if (err) {
          notFound(res, req.method);
          return;
        }
        send(res, 200, markOrdersClosed(buf.toString("utf8")), {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        }, req.method);
      });
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" });
      res.end();
      return;
    }

    const files = candidateFiles(url.pathname);
    if (!files) {
      notFound(res, req.method);
      return;
    }

    serveFirst(files, 0, res, req.method, req.headers.range);
  });
}

if (require.main === module) {
  createServer().listen(PORT, HOST, () => {
    console.log(`Santa Says My Name listening on ${HOST}:${PORT}`);
  });
}

module.exports = { createServer };
