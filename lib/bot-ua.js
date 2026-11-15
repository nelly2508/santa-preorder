"use strict";

// Link-preview scrapers, search crawlers and script clients. They fetch the
// page from a data centre, do not run the page JavaScript, and were being
// counted as views. A normal browser user agent is left alone, including
// in-app browsers (Facebook, Instagram, WhatsApp) that a person is actually using.
const BOT_UA = /bot|crawl|spider|slurp|facebookexternalhit|facebot|facebookcatalog|meta-externalagent|meta-externalfetcher|preview|headless|lighthouse|curl|wget|python|node-fetch|axios|go-http|java\/|okhttp|monitor|uptime|pingdom|iframely|embedly|ia_archiver|qwantify|sogou|googleother|google-inspectiontool|mediapartners-google|feedfetcher-google|apis-google|duplexweb-google|google-read-aloud|google-site-verification|scrapy|httpx|aiohttp|libwww|httpclient|postman|insomnia/i;

function isBot(req) {
  const ua = String((req && req.headers && req.headers["user-agent"]) || "").trim();
  if (!ua) return true;
  // WhatsApp's link preview starts with WhatsApp/. The in-app browser is a
  // full Mozilla user agent that merely mentions WhatsApp later on.
  if (/^whatsapp\//i.test(ua)) return true;
  return BOT_UA.test(ua);
}

module.exports = { isBot };
