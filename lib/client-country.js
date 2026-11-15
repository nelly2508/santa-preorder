"use strict";

const net = require("net");
const geoip = require("geoip-lite");
const { normaliseCountry } = require("./funnel-counts");

// Offline database only. Do not replace this with an HTTP lookup.
// The address is used for this call and then dropped. It is not returned,
// stored, or logged. Railway puts the visitor first in X-Forwarded-For and
// also sends X-Real-IP. A value that is not an address is skipped.

function stripMapped(ip) {
  const lower = ip.toLowerCase();
  if (lower.startsWith("::ffff:")) {
    const rest = ip.slice("::ffff:".length);
    if (net.isIP(rest) === 4) return rest;
  }
  return ip;
}

function tokenToIp(token) {
  let text = String(token || "").trim();
  if (!text) return "";
  if (text.charCodeAt(0) === 34 && text.charCodeAt(text.length - 1) === 34) {
    text = text.slice(1, -1).trim();
  }
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(text);
  if (bracket) text = bracket[1];
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(text)) text = text.replace(/:\d+$/, "");
  text = stripMapped(text);
  if (!net.isIP(text)) return "";
  return text;
}

function firstIp(header) {
  if (header == null || header === "") return "";
  const parts = Array.isArray(header) ? header : [header];
  for (const part of parts) {
    for (const token of String(part).split(",")) {
      const ip = tokenToIp(token);
      if (ip) return ip;
    }
  }
  return "";
}

function clientIp(req) {
  const headers = req && req.headers ? req.headers : {};
  return firstIp(headers["x-forwarded-for"])
    || firstIp(headers["x-real-ip"])
    || tokenToIp(req && req.socket && req.socket.remoteAddress)
    || "";
}

function geoLookup(ip) {
  const geo = geoip.lookup(ip);
  return geo && geo.country ? geo.country : "";
}

function countryFromIp(ip, lookup) {
  const clean = tokenToIp(ip);
  if (!clean) return normaliseCountry("");
  const fn = typeof lookup === "function" ? lookup : geoLookup;
  let code = "";
  try {
    const result = fn(clean);
    if (typeof result === "string") code = result;
  } catch {
    code = "";
  }
  return normaliseCountry(code);
}

function countryFromRequest(req, lookup) {
  return countryFromIp(clientIp(req), lookup);
}

// Railway does not add a visitor-country header. X-Railway-Edge is the edge
// city that accepted the TCP connection, not the visitor, so it is ignored.
// Cloudflare's CF-IPCountry is forwarded when Cloudflare sits in front. This
// site does not. Cloudflare's XX (unknown), T1 (Tor) and A1 (anonymous proxy)
// are not a country, and the lookup below is used instead.
function countryFromGeoHeader(req) {
  const headers = req && req.headers ? req.headers : {};
  const raw = headers["cf-ipcountry"];
  if (raw == null || raw === "") return "";
  const token = String(Array.isArray(raw) ? raw[0] : raw).split(",")[0].trim();
  const code = normaliseCountry(token);
  if (code === "XX" || code === "T1" || code === "A1") return "";
  return code;
}

// The address Railway puts in X-Forwarded-For or X-Real-IP. The socket address
// is the proxy on Railway, so it is not used for the redirect.
function forwardedClientIp(req) {
  const headers = req && req.headers ? req.headers : {};
  return firstIp(headers["x-forwarded-for"]) || firstIp(headers["x-real-ip"]) || "";
}

// Country used only to decide the US redirect. A geo header wins when it
// names a country. Otherwise the local database is used on the forwarded
// visitor address. "" means there was nothing to go on, and the caller must
// not redirect.
function countryForRedirect(req, lookup) {
  const fromHeader = countryFromGeoHeader(req);
  if (fromHeader) return fromHeader;
  const ip = forwardedClientIp(req);
  if (!ip) return "";
  return countryFromIp(ip, lookup);
}

module.exports = {
  clientIp,
  countryFromIp,
  countryFromRequest,
  countryForRedirect,
};
