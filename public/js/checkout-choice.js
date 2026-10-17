/* Package choice and sibling price lines for the pre-order page.
   Loaded in the browser before main.js, and required by the tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) root.SANTA_CHECKOUT = api;
})(typeof window === "undefined" ? null : window, function () {
  function siblingRate(amount) {
    return `+${amount} per extra child (up to 4 siblings)`;
  }

  function twoChildrenExample(base, sibling) {
    return `2 children = ${base} + ${sibling}`;
  }

  function twoChildrenFor(key, options) {
    const prices = options.prices || {};
    let base = prices.magicBundleFull;
    if (key === "singleVideo") base = prices.singleVideo;
    else if (key === "video") base = "your video";
    else if (options.early) base = prices.magicBundleEarly;
    return twoChildrenExample(base, prices.sibling);
  }

  function packageChoice(key, options) {
    const prices = options.prices || {};
    const stripe = options.stripe || {};
    if (key === "singleVideo") {
      return {
        key: "singleVideo",
        name: "Single video",
        detail: prices.singleVideo,
        href: stripe.singleVideo,
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
    siblingRate,
    twoChildrenExample,
    twoChildrenFor,
    packageChoice,
  };
});
