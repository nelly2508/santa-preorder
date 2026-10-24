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
  // at the start of 20 December. Rush orders close at this same instant.
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

  function packageChoice(key, options) {
    const prices = options.prices || {};
    const stripe = options.stripe || {};
    const late = !!options.late;
    if (key === "singleVideo") {
      return {
        key: "singleVideo",
        name: "Single video",
        detail: late ? `${prices.singleVideoLate}, rush included` : prices.singleVideo,
        href: late ? stripe.lateSingle : stripe.singleVideo,
      };
    }
    if (late) {
      return {
        key: "magicBundle",
        name: "Magic bundle",
        detail: `${prices.magicBundleLate}, rush included`,
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

  return {
    LATE_ORDERS_FROM,
    ORDERS_CLOSE_AT,
    siblingRate,
    ordersOpen,
    twoChildrenExample,
    offerPhase,
    twoChildrenFor,
    packageChoice,
  };
});
