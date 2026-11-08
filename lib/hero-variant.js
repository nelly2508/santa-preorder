"use strict";

// Two films already in public/assets. There is no separate file named
// explainer. Variant A is the hero film titled "Every name. Said right."
// Variant B is the grown-ups film ("Psst... grown-ups only"). The name
// sample further down the page uses the same file as variant A, because
// that is the only clip of Santa saying a name.
const COOKIE = "ssmn_variant";
const MAX_AGE = 60 * 60 * 24 * 180;

const FILMS = {
  explainer: {
    src: "/assets/santa-preview-v3.mp4",
    poster: "/assets/santa-preview-poster-lite.webp",
    track: "/assets/santa-preview.vtt",
    label: "Every name, said right",
  },
  parents: {
    src: "/assets/exit-sales-v4.mp4",
    poster: "/assets/exit-sales-poster-v4.jpg",
    track: "",
    label: "A short film for grown-ups",
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

function filmFor(variant) {
  return FILMS[normaliseVariant(variant)] || FILMS.explainer;
}

function applyHeroFilm(html, variant) {
  const film = filmFor(variant);
  const track = film.track
    ? `\n              <track data-src="${film.track}" kind="captions" srclang="en" label="English" default>`
    : "";
  const open = `<video id="hero-film" controls playsinline preload="none" width="1080" height="1350" poster="${film.poster}" data-src="${film.src}" data-poster="${film.poster}" aria-label="${film.label}">${track}`;
  return String(html).replace(
    '<video id="hero-film" data-hero-film controls playsinline preload="none" width="1080" height="1350">',
    open
  );
}

module.exports = {
  COOKIE,
  FILMS,
  normaliseVariant,
  assignVariant,
  resolveVariant,
  readCookie,
  variantCookie,
  filmFor,
  applyHeroFilm,
};
