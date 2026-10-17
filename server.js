"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { resolveOrderRedirect, fallbackLocation } = require("./lib/order-continue");

const PORT = Number(process.env.PORT) || 3000;
const HOST = "0.0.0.0";
const ROOT = path.resolve(__dirname, "public");

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self'; media-src 'self'; style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'",
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
