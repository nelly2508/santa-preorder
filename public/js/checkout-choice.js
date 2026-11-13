/* Package choice and sibling price lines for the pre-order page.
   Loaded in the browser before main.js, and required by the tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) root.SANTA_CHECKOUT = api;
})(typeof window === "undefined" ? null : window, function () {
  const LATE_ORDERS_FROM = "2026-12-13T00:00:00Z";
  // After 23:59 UK on 19 December 2026. GMT that week, so this is midnight
  // at the start of 20 December. Orders close at this same instant, including
  // orders at the Christmas week price.
  const ORDERS_CLOSE_AT = "2026-12-20T00:00:00Z";

  function siblingRate(amount) {
    return `+${amount} per extra child (up to 4 siblings)`;
  }

  function twoChildrenExample(base, sibling) {
    return `2 children = ${base} + ${sibling}`;
  }

  function offerPhase(options) {
    const source = options || {};
    const now = source.now instanceof Date ? source.now : new Date(source.now == null ? Date.now() : source.now);
    const nowMs = now.getTime();
    const lateFrom = new Date(source.lateOrdersFrom || LATE_ORDERS_FROM);
    let late = false;
    if (source.lateOrders === true) late = true;
    else if (source.lateOrders === false) late = false;
    else late = !Number.isNaN(lateFrom.getTime()) && !Number.isNaN(nowMs) && nowMs >= lateFrom.getTime();

    if (late) return "late";
    if (source.earlyBird === false) return "standard";
    const earlyEnd = new Date(source.earlyBirdEnds || "");
    if (!Number.isNaN(earlyEnd.getTime()) && !Number.isNaN(nowMs) && nowMs <= earlyEnd.getTime()) return "early";
    return "standard";
  }

  function ordersOpen(now, options) {
    const source = options || {};
    const moment = now instanceof Date ? now : new Date(now == null ? Date.now() : now);
    const ms = moment.getTime();
    if (Number.isNaN(ms)) return true;
    const closeAt = new Date(source.ordersCloseAt || ORDERS_CLOSE_AT);
    if (Number.isNaN(closeAt.getTime())) return true;
    return ms < closeAt.getTime();
  }

  function twoChildrenFor(key, options) {
    const prices = options.prices || {};
    const late = !!options.late;
    let base = prices.magicBundleFull;
    if (key === "singleVideo") base = late ? prices.singleVideoLate : prices.singleVideo;
    else if (key === "video") base = "your video";
    else if (late) base = prices.magicBundleLate;
    else if (options.early) base = prices.magicBundleEarly;
    return twoChildrenExample(base, prices.sibling);
  }

  function clampSiblings(value) {
    const count = Number(value);
    if (!Number.isInteger(count) || count < 0) return 0;
    return Math.min(count, 4);
  }

  function campaignPart(value) {
    if (value == null) return "";
    const raw = String(value).trim();
    if (!raw || raw.includes("@")) return "";
    return raw.replace(/[^A-Za-z0-9 ._-]+/g, "").trim().slice(0, 64);
  }

  function resumeOrder(search) {
    const params = new URLSearchParams(String(search || "").replace(/^\?/, "").split("#")[0]);
    const raw = params.get("package");
    const packageKey = raw === "singleVideo" || raw === "magicBundle" ? raw : "";
    return {
      packageKey,
      siblings: clampSiblings(params.get("siblings")),
      sleigh: packageKey === "singleVideo" && params.get("sleigh") === "1",
    };
  }

  function orderQuery(options) {
    const source = options || {};
    const params = new URLSearchParams();
    const packageKey = source.packageKey === "singleVideo" ? "singleVideo" : "magicBundle";
    params.set("package", packageKey);
    const siblings = clampSiblings(source.siblings);
    if (siblings > 0) params.set("siblings", String(siblings));
    if (packageKey === "singleVideo" && (source.sleigh === true || source.sleigh === 1 || source.sleigh === "1")) {
      params.set("sleigh", "1");
    }
    const utm = source.utm || {};
    for (const key of ["utm_source", "utm_campaign", "utm_content"]) {
      const value = campaignPart(utm[key]);
      if (value) params.set(key, value);
    }
    if (source.market === "us") params.set("market", "us");
    if (source.variant === "explainer" || source.variant === "parents") params.set("variant", source.variant);
    return params.toString();
  }

  // The same pounds or dollars PayPal charges: the phase price, plus each
  // extra child, plus the named sleigh only on the single video. Late prices
  // already include the Christmas week amount, so it is not added again.
  function orderAmount(options) {
    const source = options || {};
    const prices = source.prices || {};
    const late = !!source.late;
    const early = !!source.early && !late;
    const packageKey = source.packageKey === "singleVideo" ? "singleVideo" : "magicBundle";
    const siblings = clampSiblings(source.siblings);
    const sleigh = packageKey === "singleVideo" && (source.sleigh === true || source.sleigh === 1 || source.sleigh === "1");
    const baseLabel = packageKey === "singleVideo"
      ? (late ? prices.singleVideoLate : prices.singleVideo)
      : (late ? prices.magicBundleLate : early ? prices.magicBundleEarly : prices.magicBundleFull);
    const base = priceMinor(baseLabel);
    const sibling = priceMinor(prices.sibling);
    if (base == null || sibling == null) return null;
    let total = base + siblings * sibling;
    if (sleigh) {
      const extra = priceMinor(prices.namedSleigh);
      if (extra == null) return null;
      total += extra;
    }
    return {
      packageKey,
      siblings,
      children: siblings + 1,
      sleigh,
      totalMinor: total,
      total: formatMinor(total, baseLabel),
    };
  }

  // Early bird is a fixed line, with no price. After that, the 48-hour
  // sentence the page already uses, plus the current bundle price.
  // Nothing to show when the shop is closed, or when that later price is missing.
  function offerBanner(options) {
    const source = options || {};
    if (source.closed) return "";
    if (source.early && !source.late) return "Early bird pricing ends 15 Nov";
    const price = source.price || "";
    if (!price) return "";
    return `Delivered within 48 hours of your order, whatever the date. ${price}`;
  }

  function priceMinor(label) {
    const match = String(label == null ? "" : label).replace(/,/g, "").match(/(\d+)(?:\.(\d{1,2}))?/);
    if (!match) return null;
    const whole = Number(match[1]);
    const frac = Number((match[2] || "").padEnd(2, "0") || "0");
    if (!Number.isFinite(whole) || !Number.isFinite(frac)) return null;
    return whole * 100 + frac;
  }

  function moneySymbol(sample) {
    const match = String(sample == null ? "" : sample).trim().match(/^[^\d-]+/);
    return match ? match[0] : "£";
  }

  function formatMinor(minor, sample) {
    const negative = minor < 0;
    const abs = Math.abs(minor);
    const major = Math.floor(abs / 100);
    const frac = abs % 100;
    const body = frac === 0 ? String(major) : `${major}.${String(frac).padStart(2, "0")}`;
    return `${negative ? "-" : ""}${moneySymbol(sample)}${body}`;
  }

  // Cheapest live price, and the words that explain the bundle gap.
  // A zero gap (US early bird, both $19.99) is "same price, more magic".
  function choiceOffer(options) {
    const source = options || {};
    const prices = source.prices || {};
    const late = !!source.late;
    const early = !!source.early && !late;
    const single = late ? prices.singleVideoLate : prices.singleVideo;
    const bundle = late ? prices.magicBundleLate : early ? prices.magicBundleEarly : prices.magicBundleFull;
    const singleMinor = priceMinor(single);
    const bundleMinor = priceMinor(bundle);
    const sleigh = prices.namedSleigh || "";
    let from = single || bundle || "";
    if (singleMinor != null && bundleMinor != null && bundleMinor < singleMinor) from = bundle;
    const diff = singleMinor == null || bundleMinor == null ? null : bundleMinor - singleMinor;
    const base = "The Magic bundle adds a letter, a Nice List certificate and a named sleigh video";
    let difference = "";
    let upsell = `${base}.`;
    if (diff === 0) {
      difference = sleigh
        ? `Same price, more magic — the named sleigh alone is usually ${sleigh}.`
        : "Same price, more magic.";
      upsell = `${base} — same price, more magic.`;
    } else if (diff != null && diff > 0) {
      const more = formatMinor(diff, bundle || single);
      difference = sleigh
        ? `Just ${more} more — the named sleigh alone is usually ${sleigh}.`
        : `Just ${more} more.`;
      upsell = early
        ? `${base} — just ${more} more during early bird.`
        : `${base} — just ${more} more.`;
    }
    return {
      from,
      single: single || "",
      bundle: bundle || "",
      early,
      late,
      diff,
      difference,
      upsell,
    };
  }

  function packageChoice(key, options) {
    const prices = options.prices || {};
    const stripe = options.stripe || {};
    const late = !!options.late;
    if (key === "singleVideo") {
      return {
        key: "singleVideo",
        name: "Single video",
        detail: late ? `${prices.singleVideoLate}, Christmas week price` : prices.singleVideo,
        href: late ? stripe.lateSingle : stripe.singleVideo,
      };
    }
    if (late) {
      return {
        key: "magicBundle",
        name: "Magic bundle",
        detail: `${prices.magicBundleLate}, Christmas week price`,
        href: stripe.lateBundle,
      };
    }
    const early = !!options.early;
    return {
      key: "magicBundle",
      name: "Magic bundle",
      detail: early ? `${prices.magicBundleEarly} early bird` : prices.magicBundleFull,
      href: early ? stripe.magicBundleEarlyBird : stripe.magicBundleFullPrice,
    };
  }

  // One sheet open, then one order tap when the pay buttons are first shown.
  // Changing package in the same open sheet does not count again.
  function nextSheetEvent(state, action) {
    const current = state && typeof state === "object" ? state : { open: false, intent: false };
    if (action === "resume") return { state: { open: true, intent: true }, events: [] };
    if (action === "open") {
      if (current.open) return { state: current, events: [] };
      return { state: { open: true, intent: false }, events: ["sheet_open"] };
    }
    if (action === "pay") {
      if (!current.open || current.intent) return { state: current, events: [] };
      return { state: { open: true, intent: true }, events: ["order_tap"] };
    }
    if (action === "change" || action === "close") {
      if (action === "close") return { state: { open: false, intent: false }, events: [] };
      return { state: current, events: [] };
    }
    return { state: current, events: [] };
  }

  return {
    LATE_ORDERS_FROM,
    ORDERS_CLOSE_AT,
    siblingRate,
    ordersOpen,
    twoChildrenExample,
    offerPhase,
    twoChildrenFor,
    packageChoice,
    priceMinor,
    formatMinor,
    choiceOffer,
    clampSiblings,
    campaignPart,
    resumeOrder,
    orderQuery,
    orderAmount,
    offerBanner,
    nextSheetEvent,
  };
});
