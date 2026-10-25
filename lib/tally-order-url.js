"use strict";

// The only builder for the post-payment Tally link. The redirect page and
// the order confirmation email both call this, so the hidden-field query
// cannot drift between them.

const TALLY_ORDER_FORM = "https://tally.so/r/Dq25LE";

function tallyOrderUrl(sessionId, summary, email) {
  const url = new URL(TALLY_ORDER_FORM);
  if (sessionId) url.searchParams.set("order", sessionId);
  if (!summary) return url.toString();
  url.searchParams.set("children", String(summary.children));
  url.searchParams.set("rush", summary.rush ? "1" : "0");
  url.searchParams.set("sleigh", summary.sleigh ? "1" : "0");
  if (summary.packageType) url.searchParams.set("package", summary.packageType);
  const address = typeof email === "string" ? email.trim() : "";
  if (address) url.searchParams.set("email", address);
  return url.toString();
}

module.exports = {
  TALLY_ORDER_FORM,
  tallyOrderUrl,
};
