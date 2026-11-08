"use strict";

// Variant A is the v7 explainer ad. The UK page and the US page each have
// their own file. Variant B is the grown-ups film. Hear Santa, further down,
// stays the Saoirse sample and is not part of this swap.
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
  if (normaliseVariant(variant) === "parents") return PARENTS;
  return market === "us" ? EXPLAINER.us : EXPLAINER.uk;
}

function applyHeroFilm(html, variant, market) {
  const film = filmFor(variant, market);
  const open = `<video id="hero-film" autoplay muted loop playsinline controls width="1080" height="1350" poster="${film.poster}" aria-label="${film.label}"><source src="${film.src}" type="video/mp4">`;
  return String(html).replace(
    '<video id="hero-film" data-hero-film controls playsinline preload="none" width="1080" height="1350">',
    open
  );
}

module.exports = {
  COOKIE,
  EXPLAINER,
  PARENTS,
  normaliseVariant,
  assignVariant,
  resolveVariant,
  readCookie,
  variantCookie,
  filmFor,
  applyHeroFilm,
};
