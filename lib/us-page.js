"use strict";

// USD list used when config.js has not filled a key. The live numbers Neil
// can change are public/js/config.js → usd. magicBundleFull is the standard
// price after 15 Nov 2026. Late prices must equal that standard (or the
// single video) plus rush, or PayPal refuses the order.
const USD_DEFAULTS = {
  magicBundleEarly: "$19.99",
  magicBundleFull: "$24.99",
  magicBundleLate: "$29.98",
  singleVideo: "$19.99",
  singleVideoLate: "$24.98",
  sibling: "$14.99",
  rush: "$4.99",
  namedSleigh: "$4.99",
};

function usdBook(usd) {
  const source = usd && typeof usd === "object" ? usd : {};
  const book = { ...USD_DEFAULTS };
  for (const key of Object.keys(USD_DEFAULTS)) {
    if (typeof source[key] === "string" && source[key].trim()) book[key] = source[key].trim();
  }
  return book;
}

function applyPhrase(html, from, to) {
  return String(html).split(from).join(to);
}

function applyUsHtml(html, usd) {
  const book = usdBook(usd);
  let out = String(html || "");
  out = applyPhrase(out, '<html lang="en-GB">', '<html lang="en-US">');
  out = applyPhrase(
    out,
    "<body data-sales-page>",
    '<body data-sales-page data-market="us" data-currency="USD">'
  );
  out = applyPhrase(
    out,
    "<p>Santa says Saoirse (Seer-sha) perfectly. He'll get your child's name right too.</p>",
    "<p>Santa says Saoirse (Seer-sha) perfectly. He'll get your child's name right too.</p>\n            <p>You hear the same British Santa. That voice is part of the film.</p>"
  );
  out = applyPhrase(
    out,
    "<h2>Your child's details</h2>",
    "<h2>Your child's details</h2>\n        <p>The person who orders is an adult. We do not collect personal information from children.</p>"
  );
  out = applyPhrase(
    out,
    "We run Meta ads, and we use Microsoft Clarity to see how this page is used. Both load only with your consent, and neither gets your child's details.",
    "We use Microsoft Clarity and Meta to see how this page is used. They run unless you turn them off, or your browser sends Global Privacy Control. Use Do Not Sell or Share My Personal Information in the footer. Neither gets your child's details. We do not sell personal information."
  );

  const phrases = [
    ["Personalised", "Personalized"],
    ["personalised", "personalized"],
    ["favourite", "favorite"],
    ["Favourite", "Favorite"],
    ["15 December", "December 15"],
    ["12 December", "December 12"],
    ["13 December", "December 13"],
    ["1 December", "December 1"],
    ["Sun 15 Nov", "Sun Nov 15"],
    ["Sat 12 Dec", "Sat Dec 12"],
    ["Tue 15 Dec", "Tue Dec 15"],
    ["Sun 13 Dec", "Sun Dec 13"],
    ["Sat 19 Dec", "Sat Dec 19"],
    ["23:59 UK", "6:59pm Eastern"],
    ["pounds sterling", "US dollars"],
    ["No VAT is charged. ", ""],
    ["1 Dec", "Dec 1"],
    ["12 Dec", "Dec 12"],
    ["13 Dec", "Dec 13"],
    ["15 Dec", "Dec 15"],
    ["19 Dec", "Dec 19"],
    ["£24.98", book.magicBundleLate],
    ["£19.98", book.singleVideoLate],
    ["£19.99", book.magicBundleFull],
    ["£16.99", book.magicBundleEarly],
    ["£14.99", book.singleVideo],
    ["£11.99", book.sibling],
    ["£4.99", book.rush],
  ];
  for (const [from, to] of phrases) out = applyPhrase(out, from, to);
  return out;
}

module.exports = { USD_DEFAULTS, usdBook, applyUsHtml };
