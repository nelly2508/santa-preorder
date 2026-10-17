"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { resolveOrderRedirect, fallbackLocation } = require("./lib/order-continue");

const PORT = Number(process.env.PORT) || 3000;
const HOST = "0.0.0.0";
const ROOT = path.resolve(__dirname, "public");

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
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Content-Security-Policy":
      "default-src 'self'; img-src 'self'; media-src 'self'; style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'",
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

function safeFile(urlPath) {
  let pathname;
  try {
    pathname = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (pathname.includes("\0")) return null;
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.resolve(ROOT, `.${pathname}`);
  if (filePath !== ROOT && !filePath.startsWith(`${ROOT}${path.sep}`)) return null;
  return filePath;
}

function redirect(res, location) {
  res.writeHead(302, {
    Location: location,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  res.end();
}

function createServer(options = {}) {
  const env = options.env || process.env;
  const log = options.log || ((message) => console.error(message));
  return http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      notFound(res, req.method);
      return;
    }

    if (url.pathname === "/order/continue") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { Allow: "GET, HEAD", "Cache-Control": "no-store" });
        res.end();
        return;
      }
      const sessionId = url.searchParams.get("session_id") || "";
      resolveOrderRedirect({
        sessionId,
        env,
        retrieveSession: options.retrieveSession,
        log,
      }).then(
        (location) => redirect(res, location),
        (error) => {
          log(`order/continue ${sessionId || "(missing session)"}: ${error && error.message ? error.message : error}`);
          redirect(res, fallbackLocation(/^cs_(live|test)_[A-Za-z0-9]+$/.test(sessionId) ? sessionId : ""));
        }
      );
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" });
      res.end();
      return;
    }

    const filePath = safeFile(url.pathname);
    if (!filePath) {
      notFound(res, req.method);
      return;
    }

    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) {
        notFound(res, req.method);
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const headers = {
        "Content-Type": MIME[ext] || "application/octet-stream",
        "Content-Length": stat.size,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "strict-origin-when-cross-origin",
        "Content-Security-Policy":
          "default-src 'self'; img-src 'self'; media-src 'self'; style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'",
        "Cache-Control": LONG_CACHE.has(ext) ? "public, max-age=86400" : "no-cache",
      };
      res.writeHead(200, headers);
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      fs.createReadStream(filePath).pipe(res);
    });
  });
}

if (require.main === module) {
  createServer().listen(PORT, HOST, () => {
    console.log(`Santa Says My Name listening on ${HOST}:${PORT}`);
  });
}

module.exports = { createServer };
