"use strict";

const fs = require("fs");
const path = require("path");

// Variant A is the v7 explainer ad. The UK page and the US page each have
// their own file. Variant B is the grown-ups film. That film stays below
// the fold. The hero is the full v4 explainer when those files are in
// the media folder, and the name sample until then.
const COOKIE = "ssmn_variant";
const MAX_AGE = 60 * 60 * 24 * 180;

const EXPLAINER = {
  uk: {
    src: "/assets/uk-explainer-4x5-v7.mp4",
    poster: "/assets/uk-explainer-4x5-v7-poster.jpg",
    label: "A short explainer film",
  },
  us: {
    src: "/assets/us-explainer-4x5-v7.mp4",
    poster: "/assets/us-explainer-4x5-v7-poster.jpg",
    label: "A short explainer film",
  },
};

const PARENTS = {
  src: "/assets/exit-sales-v4.mp4",
  poster: "/assets/exit-sales-poster-v4.jpg",
  label: "A short film for grown-ups",
};

// US copy of the grown-ups film. The end card says From $19.99 and
// "favorite", so the UK file is left as it is.
const PARENTS_US = {
  src: "/assets/us-grownups-4x5-usd.mp4",
  poster: "/assets/exit-sales-poster-v4.jpg",
  label: "A short film for grown-ups",
};

const HERO_FILES = {
  uk: { file: "hero-uk-v4-full.mp4", poster: "hero-uk-v4-full.jpg" },
  us: { file: "hero-us-v4-full.mp4", poster: "hero-us-v4-full.jpg" },
};

const HERO_FALLBACK = {
  uk: {
    src: "/assets/santa-preview-v3.mp4",
    poster: "/assets/santa-preview-poster-lite.webp",
    fallback: true,
  },
  us: {
    src: "/assets/us-sample-saoirse-4x5-usd.mp4",
    poster: "/assets/santa-preview-poster-lite.webp",
    fallback: true,
  },
};

function normaliseVariant(value) {
  const name = String(value == null ? "" : value).trim().toLowerCase();
  if (name === "a" || name === "explainer") return "explainer";
  if (name === "b" || name === "parents" || name === "parents-only") return "parents";
  return "";
}

function assignVariant(existing, random) {
  const saved = normaliseVariant(existing);
  if (saved) return saved;
  const roll = typeof random === "function" ? Number(random()) : Math.random();
  return roll < 0.5 ? "explainer" : "parents";
}

function resolveVariant(options) {
  const source = options || {};
  const forced = normaliseVariant(source.query);
  if (forced) return forced;
  const saved = normaliseVariant(source.cookie);
  if (saved) return saved;
  return assignVariant("", source.random || Math.random);
}

function readCookie(header, name) {
  const raw = String(header || "");
  for (const part of raw.split(";")) {
    const piece = part.trim();
    const eq = piece.indexOf("=");
    if (eq <= 0) continue;
    if (piece.slice(0, eq) !== name) continue;
    const value = piece.slice(eq + 1);
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return "";
}

function variantCookie(variant, secure) {
  const name = normaliseVariant(variant);
  if (!name) return "";
  const bits = [`${COOKIE}=${name}`, `Max-Age=${MAX_AGE}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (secure) bits.push("Secure");
  return bits.join("; ");
}

function filmFor(variant, market) {
  if (normaliseVariant(variant) === "parents") return market === "us" ? PARENTS_US : PARENTS;
  return market === "us" ? EXPLAINER.us : EXPLAINER.uk;
}

function heroSample(market, assetsDir) {
  const wanted = market === "us" ? HERO_FILES.us : HERO_FILES.uk;
  if (assetsDir) {
    const video = path.join(assetsDir, wanted.file);
    const poster = path.join(assetsDir, wanted.poster);
    if (fs.existsSync(video) && fs.existsSync(poster)) {
      return {
        src: `/assets/${wanted.file}`,
        poster: `/assets/${wanted.poster}`,
        fallback: false,
      };
    }
  }
  return { ...(market === "us" ? HERO_FALLBACK.us : HERO_FALLBACK.uk) };
}

function applyHeroSample(html, market, assetsDir) {
  const media = heroSample(market, assetsDir);
  let next = String(html)
    .replace('poster="/assets/santa-preview-poster-lite.webp"', `poster="${media.poster}"`)
    .replace('src="/assets/santa-preview-v3.mp4"', `src="${media.src}"`);
  if (!media.fallback) {
    next = next.replace(/\s*<track src="\/assets\/santa-preview\.vtt"[^>]*>/, "");
  }
  return next;
}

function applyHeroFilm(html, variant, market) {
  const film = filmFor(variant, market);
  // Below the fold, and not requested until Play. The hero itself is the
  // name sample, which also waits for a tap.
  const open = `<video id="hero-film" data-hero-film controls playsinline preload="none" width="1080" height="1350" data-src="${film.src}" data-poster="${film.poster}" aria-label="${film.label}">`;
  return String(html).replace(
    '<video id="hero-film" data-hero-film controls playsinline preload="none" width="1080" height="1350">',
    open
  );
}

module.exports = {
  COOKIE,
  EXPLAINER,
  PARENTS,
  PARENTS_US,
  normaliseVariant,
  assignVariant,
  resolveVariant,
  readCookie,
  variantCookie,
  filmFor,
  heroSample,
  applyHeroSample,
  applyHeroFilm,
  HERO_FILES,
  HERO_FALLBACK,
};
