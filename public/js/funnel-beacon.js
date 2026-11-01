/* Queues an order-tap count before the page can navigate away.
   Continue to secure payment goes straight to /order/pay. A fetch whose
   Content-Type is application/json is not a simple request, so a phone can
   cancel it as that navigation starts and the tap never arrives.
   sendBeacon queues a text/plain POST first. fetch with keepalive is only
   the fallback, and it stays a simple request for the same reason. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.SANTA_FUNNEL = api;
})(typeof window === "undefined" ? null : window, function () {
  function bodyFor(eventName, search) {
    const params = new URLSearchParams(String(search || "").replace(/^\?/, "").split("#")[0]);
    return JSON.stringify({
      event: eventName,
      utm_source: params.get("utm_source") || "",
      utm_campaign: params.get("utm_campaign") || "",
      utm_content: params.get("utm_content") || "",
    });
  }

  function post(eventName, search, transport) {
    const body = bodyFor(eventName, search);
    const via = transport || {};
    if (typeof via.sendBeacon === "function") {
      try {
        // A string is text/plain. A JSON Blob is not safelisted and is dropped.
        if (via.sendBeacon("/api/funnel", body)) return "beacon";
      } catch (error) {
        // A browser that refuses the beacon still gets the fetch below.
      }
    }
    if (typeof via.fetch !== "function") return "failed";
    try {
      const pending = via.fetch("/api/funnel", {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body,
        keepalive: true,
        credentials: "omit",
      });
      if (pending && typeof pending.catch === "function") pending.catch(() => {});
      return "fetch";
    } catch (error) {
      return "failed";
    }
  }

  return { bodyFor, post };
});
