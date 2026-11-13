"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { describeOrder, fallbackLocation, selectSecretKey } = require("./lib/order-continue");
const { createVisitCounter, secretsMatch, presentedSecret, partsFromUrl } = require("./lib/visit-counts");
const { UNKNOWN_COUNTRY, createFunnelCounter, funnelFromSession } = require("./lib/funnel-counts");
const { countryFromRequest } = require("./lib/client-country");
const { offerPhase, ordersOpen, packageChoice, clampSiblings, orderQuery, offerBanner } = require("./public/js/checkout-choice");
const { publicOrigin, createCheckoutSession } = require("./lib/checkout-session");
const { paymentProvider, paypalEnv, createPaypalOrder, capturePaypalOrder, fulfilStoredOrder, handlePaypalWebhook } = require("./lib/paypal");
const { applyUsHtml } = require("./lib/us-page");
const { COOKIE, applyHeroFilm, applyHeroSample, normaliseVariant, readCookie, resolveVariant, variantCookie } = require("./lib/hero-variant");
const { isPaypalOrderId, createOrderStore } = require("./lib/paypal-orders");
const { sessionForPaidOrder } = require("./lib/quote");
const crypto = require("crypto");
const vm = require("vm");

const PORT = Number(process.env.PORT) || 3000;
const HOST = "0.0.0.0";
const ROOT = path.resolve(__dirname, "public");

// One nonce per response. The sales page copies it onto the PayPal SDK script
// as data-csp-nonce so PayPal's style tags are allowed. style-src-attr is separate
// so the bank-approval overlay can still set position and z-index on its container.
const CSP_NONCE = Symbol("cspNonce");
const PAYPAL_HOSTS = "https://*.paypal.com https://*.paypalobjects.com https://www.paypal.com https://www.paypalobjects.com https://www.sandbox.paypal.com";

function cspNonce(res) {
  if (!res[CSP_NONCE]) res[CSP_NONCE] = crypto.randomBytes(16).toString("base64url");
  return res[CSP_NONCE];
}

function contentSecurityPolicy(nonce) {
  const quotedNonce = `'nonce-${nonce}'`;
  return [
    "default-src 'self' https://*.clarity.ms https://c.bing.com",
    `img-src 'self' data: https://www.facebook.com https://*.clarity.ms https://c.bing.com ${PAYPAL_HOSTS}`,
    "media-src 'self'",
    `style-src 'self' ${quotedNonce}`,
    "style-src-attr 'unsafe-inline'",
    `script-src 'self' ${quotedNonce} https://connect.facebook.net https://*.clarity.ms https://c.bing.com ${PAYPAL_HOSTS}`,
    "font-src 'self'",
    `connect-src 'self' https://www.facebook.com https://connect.facebook.net https://graph.facebook.com https://*.clarity.ms https://c.bing.com ${PAYPAL_HOSTS}`,
    `frame-src https://www.facebook.com ${PAYPAL_HOSTS}`,
    "worker-src 'self' blob:",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

function securityHeaders(res) {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Content-Security-Policy": contentSecurityPolicy(cspNonce(res)),
  };
}

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
    ...securityHeaders(res),
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
    <p><a class="btn" href="/">Back to the order page</a></p>
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
    ...securityHeaders(res),
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
  const purchaseCurrency = hasAmount ? String(purchase.currency || "GBP").toUpperCase() : "";
  const purchaseAttrs = hasAmount
    ? ` data-purchase-value="${escapeHtml(purchase.value.toFixed(2))}" data-purchase-currency="${escapeHtml(purchaseCurrency)}"`
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
    .replace("<body data-sales-page", "<body data-sales-page data-orders-closed")
    .replace('id="orders-closed" hidden', 'id="orders-closed"');
}

function paymentAttributes(env) {
  if (paymentProvider(env) === "stripe") return ' data-payment-provider="stripe"';
  const config = paypalEnv(env);
  if (!config.ok) return ' data-payment-provider="paypal" data-paypal-ready="0"';
  return ` data-payment-provider="paypal" data-paypal-ready="1" data-paypal-client-id="${escapeHtml(config.clientId)}"`;
}

function salesMarket(pathname) {
  if (pathname === "/us" || pathname === "/us/") return "us";
  if (pathname === "/" || pathname === "/index.html") return "uk";
  return "";
}

function cookieIsSecure(req) {
  const proto = String((req && req.headers && req.headers["x-forwarded-proto"]) || "").split(",")[0].trim().toLowerCase();
  return proto === "https";
}

function applyOfferBanner(html, config, now, market, closed) {
  const phase = offerPhase({
    now,
    earlyBird: config.earlyBird,
    earlyBirdEnds: config.earlyBirdEnds,
    lateOrders: config.lateOrders,
    lateOrdersFrom: config.lateOrdersFrom,
  });
  const book = market === "us" && config.usd ? config.usd : config.prices;
  const early = phase === "early";
  const late = phase === "late";
  const price = late ? book.magicBundleLate : early ? book.magicBundleEarly : book.magicBundleFull;
  const label = offerBanner({
    early,
    late,
    closed,
    price,
    earlyBirdEnds: config.earlyBirdEnds,
  });
  const clickable = !!(label && early && !late);
  let next = '<button type="button" class="offer-banner" id="offer-banner" hidden></button>';
  if (label && clickable) {
    next = `<button type="button" class="offer-banner" id="offer-banner" data-choice-open>${escapeHtml(label)}</button>`;
  } else if (label) {
    next = `<button type="button" class="offer-banner" id="offer-banner">${escapeHtml(label)}</button>`;
  }
  return String(html).replace(/<(?:p|button)\b[^>]*id="offer-banner"[^>]*>[^<]*<\/(?:p|button)>/, next);
}

function decorateSalesHtml(html, env, closed, nonce, variant, market) {
  const nonceAttr = nonce ? ` data-csp-nonce="${escapeHtml(nonce)}"` : "";
  const shown = normaliseVariant(variant);
  const variantAttr = shown ? ` data-variant="${shown}"` : "";
  let next = applyHeroFilm(html, shown || "explainer", market);
  next = applyHeroSample(next, market, path.join(ROOT, "assets"));
  next = next.replace("<body data-sales-page", `<body data-sales-page${variantAttr}${paymentAttributes(env)}${nonceAttr}`);
  if (paymentProvider(env) === "stripe") {
    next = next.replace(
      'id="pay-continue" href="#checkout" aria-disabled="false">Pay with PayPal or card<',
      'id="pay-continue" href="#checkout" aria-disabled="false">Continue to secure payment<'
    );
  }
  if (closed) next = markOrdersClosed(next);
  return next;
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
      const result = await describeOrder({
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
      if (options.onPaid) await options.onPaid(sessionId, result);
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

function funnelFilePath(options, env) {
  if (options.funnelFile === null) return null;
  if (typeof options.funnelFile === "string") return options.funnelFile;
  if (env && env.FUNNEL_FILE) return String(env.FUNNEL_FILE);
  // A volume path already used for visits or PayPal orders is the durable
  // disk. The default data/ file is inside the container and disappears
  // on a Railway redeploy.
  const anchored = String((env && (env.VISITS_FILE || env.PAYPAL_ORDERS_FILE)) || "").trim();
  if (anchored.includes("/") || anchored.includes("\\")) {
    return path.join(path.dirname(anchored), "funnel-counts.json");
  }
  return path.join(__dirname, "data", "funnel-counts.json");
}

function paypalOrdersPath(options, env) {
  if (options.paypalOrdersFile === null) return null;
  if (typeof options.paypalOrdersFile === "string") return options.paypalOrdersFile;
  if (env && env.PAYPAL_ORDERS_FILE) return String(env.PAYPAL_ORDERS_FILE);
  return path.join(__dirname, "data", "paypal-orders.json");
}

function sendJson(res, status, body, method, extra) {
  send(res, status, JSON.stringify(body), {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extra,
  }, method);
}

const FUNNEL_BODY_MAX = 2048;
const PAYPAL_BODY_MAX = 8192;
let funnelWindow = 0;
let funnelPosts = 0;
let paypalWindow = 0;
let paypalPosts = 0;

function allowFunnelPost() {
  const window = Math.floor(Date.now() / 1000);
  if (window !== funnelWindow) {
    funnelWindow = window;
    funnelPosts = 0;
  }
  funnelPosts += 1;
  return funnelPosts <= 40;
}

function allowPaypalPost() {
  const window = Math.floor(Date.now() / 1000);
  if (window !== paypalWindow) {
    paypalWindow = window;
    paypalPosts = 0;
  }
  paypalPosts += 1;
  return paypalPosts <= 30;
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const requestHost = String(req.headers.host || "");
  return host === requestHost || host === "santasaysmyname.com" || host === "www.santasaysmyname.com";
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function handleFunnelEvent(req, res, funnel, countryOf) {
  if (req.method !== "POST") {
    res.writeHead(405, { Allow: "POST", "Cache-Control": "no-store" });
    res.end();
    return;
  }
  if (!originAllowed(req)) {
    req.resume();
    sendJson(res, 400, { error: "bad request" }, req.method);
    return;
  }
  if (!allowFunnelPost()) {
    req.resume();
    sendJson(res, 429, { error: "busy" }, req.method);
    return;
  }
  readBody(req, FUNNEL_BODY_MAX).then((raw) => {
    let body;
    try {
      body = JSON.parse(raw || "");
    } catch {
      sendJson(res, 400, { error: "bad request" }, req.method);
      return;
    }
    // sheet_open is the order sheet. order_tap is one intent for that open
    // sheet. choice_open is the older name and stays so earlier counts remain.
    // pay_click is the PayPal or card button, and is not another order_tap.
    // view, checkout_start and checkout_complete are recorded on the server.
    const clientEvents = new Set(["choice_open", "sheet_open", "order_tap", "pay_click", "example_tap"]);
    const event = body && clientEvents.has(body.event) ? body.event : "";
    if (!event) {
      sendJson(res, 400, { error: "bad request" }, req.method);
      return;
    }
    try {
      // Country comes from the visitor address, never from the posted body.
      // Market is only which page the button was on. Variant is only the film shown.
      // package is only singleVideo or magicBundle. order_tap fills the choice
      // split. pay_click fills its own split and does not add to order_tap.
      funnel.record(event, {
        utm_source: body.utm_source,
        utm_campaign: body.utm_campaign,
        utm_content: body.utm_content,
        country: countryOf(req),
        market: body.market === "us" ? "us" : "uk",
        variant: body.variant,
        package: body.package,
      });
    } catch {
      // A missed count must not fail the tap.
    }
    send(res, 204, "", { "Cache-Control": "no-store" }, req.method);
  }).catch((error) => {
    const status = error && error.status === 413 ? 413 : 400;
    sendJson(res, status, { error: "bad request" }, req.method);
  });
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function funnelReportHtml(data) {
  const total = data && data.total ? data.total : {};
  const rows = [
    ["Sheet opens", total.sheet_open],
    ["Pay clicks", total.pay_click],
    ["Checkout starts", total.checkout_start],
    ["Checkout completes", total.checkout_complete],
    ["Order taps", total.order_tap],
    ["Earlier sheet opens", total.choice_open],
    ["Page views", total.view],
    ["Example taps", total.example_tap],
  ];
  const body = rows.map(([label, count]) => {
    const number = Number(count);
    return `<tr><th scope="row">${escapeHtml(label)}</th><td>${Number.isFinite(number) ? number : 0}</td></tr>`;
  }).join("");
  return `<!DOCTYPE html>
<html lang="en-GB">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Funnel</title>
  <style>
    body { font: 16px/1.4 sans-serif; margin: 1.5rem; color: #1c140f; }
    h1 { font-size: 1.4rem; }
    table { border-collapse: collapse; min-width: 18rem; }
    th, td { text-align: left; padding: 0.35rem 0.8rem; border-bottom: 1px solid #e6dcc8; }
    td { text-align: right; font-variant-numeric: tabular-nums; }
    p { max-width: 36rem; color: #5c4d42; }
  </style>
</head>
<body>
  <h1>Funnel</h1>
  <p>Sheet opens, pay clicks and checkout starts are the current steps. Order taps are one per open sheet, and also include earlier counts from before that change. Earlier sheet opens are the old choice_open numbers.</p>
  <table>
    <tbody>${body}</tbody>
  </table>
</body>
</html>`;
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
  const data = visits.snapshot();
  const accept = String(req.headers.accept || "");
  const funnelPage = data && data.total && Object.prototype.hasOwnProperty.call(data.total, "sheet_open");
  if (funnelPage && accept.includes("text/html") && !accept.includes("application/json")) {
    send(res, 200, funnelReportHtml(data), {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    }, req.method);
    return;
  }
  sendJson(res, 200, data, req.method);
}

function createServer(options = {}) {
  const env = options.env || process.env;
  const log = options.log || ((message) => console.error(message));
  const visits = options.visitCounter || createVisitCounter({ filePath: visitsFilePath(options, env) });
  const funnel = options.funnelCounter || createFunnelCounter({ filePath: funnelFilePath(options, env) });

  function visitorCountry(req) {
    try {
      return countryFromRequest(req, options.countryLookup);
    } catch {
      return UNKNOWN_COUNTRY;
    }
  }
  const linkCache = new Map();
  const paypalOrders = options.paypalOrders || createOrderStore(paypalOrdersPath(options, env));
  const paypalFetchImpl = options.paypalFetch || globalThis.fetch;
  const paypalTokens = options.paypalTokens || new Map();

  function paypalDeps(extra) {
    return {
      env,
      store: paypalOrders,
      fetchImpl: paypalFetchImpl,
      cache: paypalTokens,
      prices: siteConfig().prices,
      usdPrices: siteConfig().usd,
      log,
      sendMail: options.sendMail,
      claimId: options.claimId,
      now: options.emailNow,
      claimTtlMs: options.claimTtlMs,
      flights: options.flights,
      verify: options.verifyPaypalWebhook,
      ...extra,
    };
  }

  async function ensureCheckoutStart(orderId) {
    if (!isPaypalOrderId(orderId)) return;
    const row = await paypalOrders.get(orderId);
    if (!row || (row.metadata && row.metadata.funnel_start === "1")) return;
    try {
      funnel.record("checkout_start", {
        ...(row.utm || {}),
        variant: row.variant,
        country: row.country,
        market: row.quote && row.quote.market,
      });
      await funnel.flush();
    } catch {
      return;
    }
    await paypalOrders.update(orderId, (current) => {
      current.metadata = { ...(current.metadata || {}), funnel_start: "1" };
      return current;
    });
  }

  function funnelFromPaypalRow(orderId, row) {
    if (!row || row.status !== "COMPLETED" || !row.quote) return null;
    const session = sessionForPaidOrder({
      orderId,
      captureId: row.captureId,
      quote: row.quote,
      email: row.email,
      createdSeconds: Math.floor(Number(row.createdMs || Date.now()) / 1000),
      utm: row.utm,
      country: row.country,
      variant: row.variant,
      metadata: row.metadata,
    });
    return funnelFromSession(session);
  }

  async function markFunnel(sessionId, result) {
    if (isPaypalOrderId(sessionId)) await ensureCheckoutStart(sessionId);
    let info = result && result.funnel;
    if (!info && isPaypalOrderId(sessionId)) {
      info = funnelFromPaypalRow(sessionId, await paypalOrders.get(sessionId));
    }
    if (!info || info.alreadyCounted) return;
    if (!funnel.claimCompletion(sessionId)) return;
    try {
      funnel.record("checkout_complete", info);
      await funnel.flush();
    } catch {
      return;
    }
    const mark = async () => {
      if (isPaypalOrderId(sessionId)) {
        await paypalOrders.update(sessionId, (row) => {
          row.metadata = { ...(row.metadata || {}), ssm_funnel: "1" };
          return row;
        });
        return;
      }
      if (typeof options.markFunnelCounted === "function") {
        await options.markFunnelCounted(sessionId, info);
        return;
      }
      if (options.retrieveSession && !options.stripe) return;
      const stripe = options.stripe;
      const paymentIntentId = info.paymentIntentId;
      if (stripe && stripe.paymentIntents && paymentIntentId) {
        await stripe.paymentIntents.update(paymentIntentId, { metadata: { ssm_funnel: "1" } });
        return;
      }
      if (stripe && stripe.checkout && stripe.checkout.sessions) {
        await stripe.checkout.sessions.update(sessionId, { metadata: { ssm_funnel: "1" } });
        return;
      }
      if (options.retrieveSession) return;
      const key = selectSecretKey(sessionId, env);
      if (!key) return;
      const Stripe = require("stripe");
      const client = new Stripe(key);
      if (paymentIntentId) {
        try {
          await client.paymentIntents.update(paymentIntentId, { metadata: { ssm_funnel: "1" } });
          return;
        } catch {
          // The read-only payment intent falls through to the session mark.
        }
      }
      await client.checkout.sessions.update(sessionId, { metadata: { ssm_funnel: "1" } });
    };
    await Promise.race([
      mark().catch(() => log(`funnel mark failed for ${sessionId || "(missing session)"}`)),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
  }

  return http.createServer(async (req, res) => {
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

    if (url.pathname === "/admin/funnel") {
      handleVisitReport(req, res, env, funnel);
      return;
    }

    if (url.pathname === "/api/funnel") {
      handleFunnelEvent(req, res, funnel, visitorCountry);
      return;
    }

    const pageMarket = salesMarket(url.pathname);
    let pageVariant = "";
    if ((req.method === "GET" || req.method === "HEAD") && pageMarket) {
      const purpose = String(req.headers["sec-purpose"] || req.headers.purpose || "");
      const prefetch = /prefetch/i.test(purpose);
      pageVariant = resolveVariant({
        query: url.searchParams.get("variant"),
        cookie: readCookie(req.headers.cookie, COOKIE),
      });
      if (!prefetch) {
        try {
          if (pageMarket === "uk") visits.record(url);
          funnel.record("view", {
            ...partsFromUrl(url),
            country: visitorCountry(req),
            market: pageMarket,
            variant: pageVariant,
          });
        } catch {
          // A missed count must not stop the page.
        }
      }
    }

    if (url.pathname === "/api/paypal/config") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { Allow: "GET, HEAD", "Cache-Control": "no-store" });
        res.end();
        return;
      }
      const provider = paymentProvider(env);
      const paypal = paypalEnv(env);
      sendJson(res, 200, {
        provider,
        currency: "GBP",
        ready: provider === "stripe" || paypal.ok,
        clientId: provider === "paypal" && paypal.ok ? paypal.clientId : "",
      }, req.method);
      return;
    }

    const paypalCapture = /^\/api\/paypal\/orders\/([A-Z0-9]{17})\/capture$/.exec(url.pathname);
    if (url.pathname === "/api/paypal/orders" || paypalCapture) {
      if (req.method !== "POST") {
        res.writeHead(405, { Allow: "POST", "Cache-Control": "no-store" });
        res.end();
        return;
      }
      if (!originAllowed(req)) {
        req.resume();
        sendJson(res, 400, { error: "bad request" }, req.method);
        return;
      }
      if (!allowPaypalPost()) {
        req.resume();
        sendJson(res, 429, { error: "busy" }, req.method);
        return;
      }
      if (!paypalCapture && paymentProvider(env) === "stripe") {
        req.resume();
        sendJson(res, 404, { error: "Not found" }, req.method);
        return;
      }
      const orderId = paypalCapture ? paypalCapture[1] : "";
      readBody(req, paypalCapture ? 2048 : PAYPAL_BODY_MAX).then(async (raw) => {
        try {
          if (paypalCapture) {
            const outcome = await capturePaypalOrder(paypalDeps({
              orderId,
              emailWaitMs: options.emailWaitMs,
            }));
            if (outcome.result) await markFunnel(orderId, outcome.result);
            sendJson(res, outcome.status, outcome.body, req.method);
            return;
          }
          let body = {};
          if (raw) {
            try {
              body = JSON.parse(raw);
            } catch {
              sendJson(res, 400, { error: "Choose a video, then try again." }, req.method);
              return;
            }
          }
          const now = serverNow(options);
          const config = siteConfig();
          const country = visitorCountry(req);
          const outcome = await createPaypalOrder(paypalDeps({
            body,
            country,
            phase: offerPhase({
              now,
              earlyBird: config.earlyBird,
              earlyBirdEnds: config.earlyBirdEnds,
              lateOrders: config.lateOrders,
              lateOrdersFrom: config.lateOrdersFrom,
            }),
            open: ordersOpen(now),
            closedMessage: CLOSED_MESSAGE,
            nowMs: now.getTime(),
          }));
          if (outcome.status === 201 && outcome.body && isPaypalOrderId(outcome.body.id)) {
            try {
              funnel.record("checkout_start", { ...(outcome.utm || {}), country: outcome.country || country });
              await funnel.flush();
              await paypalOrders.update(outcome.body.id, (row) => {
                row.metadata = { ...(row.metadata || {}), funnel_start: "1" };
                return row;
              });
            } catch {
              // A missed count must not stop checkout.
            }
          }
          sendJson(res, outcome.status, outcome.body, req.method);
        } catch (error) {
          log(`paypal: ${error && error.message ? "request failed" : "request failed"}`);
          sendJson(res, 502, { error: "The payment did not complete. Please try again, or email hello@santasaysmyname.com." }, req.method);
        }
      }).catch((error) => {
        const status = error && error.status === 413 ? 413 : 400;
        sendJson(res, status, { error: "bad request" }, req.method);
      });
      return;
    }

    if (url.pathname === "/paypal/webhook") {
      if (req.method !== "POST") {
        res.writeHead(405, { Allow: "POST", "Cache-Control": "no-store" });
        res.end();
        return;
      }
      readBody(req, WEBHOOK_MAX_BYTES).then(async (raw) => {
        try {
          const outcome = await handlePaypalWebhook(paypalDeps({
            raw,
            headers: req.headers,
            emailWaitMs: options.webhookEmailWaitMs == null ? 20000 : options.webhookEmailWaitMs,
          }));
          if (outcome.result && outcome.orderId) await markFunnel(outcome.orderId, outcome.result);
          webhookReply(res, outcome.status, outcome.body);
        } catch (error) {
          log("paypal/webhook: order handling failed");
          webhookReply(res, 500, { error: "order handling failed" });
        }
      }).catch((error) => {
        const status = error && error.status === 413 ? 413 : 400;
        webhookReply(res, status, { error: "bad request" });
      });
      return;
    }

    if (url.pathname === "/stripe/webhook") {
      handleStripeWebhook(req, res, { env, log, options: { ...options, onPaid: markFunnel } });
      return;
    }

    if (url.pathname === "/order/continue") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { Allow: "GET, HEAD", "Cache-Control": "no-store" });
        res.end();
        return;
      }
      const sessionId = url.searchParams.get("session_id") || "";
      const pending = isPaypalOrderId(sessionId)
        ? fulfilStoredOrder(paypalDeps({
          orderId: sessionId,
          emailWaitMs: options.emailWaitMs,
        }))
        : describeOrder({
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
        });
      pending.then(
        async (result) => {
          await markFunnel(sessionId, result);
          sendOrderPage(res, req.method, result);
        },
        (error) => {
          let message = error && error.message ? error.message : String(error);
          for (const secret of [env && env.SMTP_PASS, env && env.BREVO_API_KEY, env && env.PAYPAL_CLIENT_SECRET, env && env.PAYPAL_WEBHOOK_ID]) {
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
      const market = url.searchParams.get("market") === "us" ? "us" : "uk";
      const variant = normaliseVariant(url.searchParams.get("variant"));
      const packageKey = url.searchParams.get("package") === "singleVideo" ? "singleVideo" : "magicBundle";
      const choice = packageChoice(packageKey, {
        early: phase === "early",
        late: phase === "late",
        prices: config.prices,
        stripe: config.stripe,
      });
      const utm = partsFromUrl(url);
      if (paymentProvider(env) !== "stripe") {
        const query = orderQuery({
          packageKey: choice.key,
          siblings: clampSiblings(url.searchParams.get("siblings")),
          sleigh: url.searchParams.get("sleigh") === "1",
          utm,
        });
        res.writeHead(302, {
          Location: `/?${query}#checkout`,
          "Cache-Control": "no-store",
          ...securityHeaders(res),
        });
        res.end();
        return;
      }
      let location = choice.href;
      const canCreate = options.createCheckoutSession !== null && (options.stripe || options.createCheckoutSession || (env.STRIPE_SECRET_KEY && !options.retrieveSession));
      if (canCreate) {
        const country = visitorCountry(req);
        try {
          const origin = publicOrigin(env, req.headers.host);
          const creator = options.createCheckoutSession || ((args) => createCheckoutSession({
            ...args,
            stripe: options.stripe || new (require("stripe"))(env.STRIPE_SECRET_KEY),
            cache: linkCache,
          }));
          const created = await creator({
            origin,
            utm,
            country,
            market,
            variant,
            siblings: clampSiblings(url.searchParams.get("siblings")),
            sleigh: url.searchParams.get("sleigh") === "1",
            packageKey: choice.key,
            paymentLinkUrl: choice.href,
            phase,
          });
          if (created && created.created && created.url) {
            location = created.url;
            try {
              funnel.record("checkout_start", { ...utm, country, market, variant });
            } catch {
              // A missed count must not stop checkout.
            }
          }
        } catch {
          log("checkout session was not created, using the payment link");
        }
      }
      res.writeHead(302, {
        Location: location,
        "Cache-Control": "no-store",
        ...securityHeaders(res),
      });
      res.end();
      return;
    }

    if (pageMarket && (req.method === "GET" || req.method === "HEAD")) {
      fs.readFile(path.join(ROOT, "index.html"), (err, buf) => {
        if (err) {
          notFound(res, req.method);
          return;
        }
        const closed = !ordersOpen(serverNow(options));
        let html = buf.toString("utf8");
        const config = siteConfig();
        if (pageMarket === "us") html = applyUsHtml(html, config.usd);
        html = applyOfferBanner(html, config, serverNow(options), pageMarket, closed);
        const headers = {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": closed ? "no-store" : "no-cache",
        };
        const baked = variantCookie(pageVariant, cookieIsSecure(req));
        if (baked) headers["Set-Cookie"] = baked;
        send(res, 200, decorateSalesHtml(html, env, closed, cspNonce(res), pageVariant, pageMarket), headers, req.method);
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
