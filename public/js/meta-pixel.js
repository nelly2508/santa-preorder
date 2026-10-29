/* Meta Pixel and Microsoft Clarity — both load only after Accept.
   The choice is remembered in localStorage under ssmn_consent.
   No thanks leaves both unloaded. Clarity is added on the pre-order
   page only (data-sales-page). Checkout pages that include this file
   for the pixel do not get Clarity. UK ads, amounts in GBP. */
(function () {
  "use strict";

  var PIXEL = "898274206954064";
  var CURRENCY = "GBP";
  var KEY = "ssmn_consent";
  var listening = false;

  function readConsent() {
    try {
      return localStorage.getItem(KEY);
    } catch (error) {
      return null;
    }
  }

  function storeConsent(value) {
    try {
      localStorage.setItem(KEY, value);
    } catch (error) {
      /* Private browsing can refuse storage. The choice still applies to this page. */
    }
  }

  function once(fn) {
    var used = false;
    return function () {
      if (used) return;
      used = true;
      fn();
    };
  }

  function whenReady(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }

  function continueOrder() {
    var url = document.body && document.body.getAttribute("data-continue");
    if (!url) return;
    window.location.replace(url);
  }

  function trackPage() {
    fbq("track", "PageView");
    if (document.body && document.body.hasAttribute("data-sales-page")) {
      fbq("track", "ViewContent", {
        content_name: "Santa Says My Name",
        currency: CURRENCY,
      });
    }
    var raw = document.body && document.body.getAttribute("data-purchase-value");
    if (raw == null || raw === "") return;
    var value = Number(raw);
    if (!Number.isFinite(value)) return;
    fbq("track", "Purchase", {
      value: value,
      currency: (document.body.getAttribute("data-purchase-currency") || CURRENCY).toUpperCase(),
    });
  }

  function onCheckoutClick(event) {
    var el = event.target && event.target.closest && event.target.closest('a[href*="buy.stripe.com"], a[data-pay], #pay-continue');
    if (!el || !window.fbq) return;
    var href = el.href || el.getAttribute("href") || "";
    var toStripe = href.indexOf("buy.stripe.com") !== -1;
    var orderButton = el.hasAttribute("data-pay");
    if (!toStripe && !orderButton) return;
    if (el.getAttribute("aria-disabled") === "true") return;
    fbq("track", "InitiateCheckout", { currency: CURRENCY });
  }

  function listenForCheckout() {
    if (listening) return;
    listening = true;
    document.addEventListener("click", onCheckoutClick, true);
  }

  function trackCustom(name) {
    if (readConsent() !== "yes") return;
    if (typeof fbq !== "function") return;
    if (!name) return;
    fbq("trackCustom", name);
  }

  window.SANTA_PIXEL = { trackCustom: trackCustom };

  function loadClarity() {
    if (!document.body || !document.body.hasAttribute("data-sales-page")) return;
    if (typeof window.clarity !== "function") {
      (function (c, l, a, r, i, t, y) {
        c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
        t = l.createElement(r);
        t.async = 1;
        t.src = "https://www.clarity.ms/tag/" + i;
        y = l.getElementsByTagName(r)[0];
        y.parentNode.insertBefore(t, y);
      })(window, document, "clarity", "script", "z5hnjy7wjx");
    }
    window.clarity("consent");
  }

  function load(done) {
    loadClarity();
    var finish = done ? once(done) : function () {};
    if (window.fbq) {
      trackPage();
      listenForCheckout();
      finish();
      return;
    }

    !(function (f, b, e, v, n, t, s) {
      if (f.fbq) return;
      n = f.fbq = function () {
        n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
      };
      if (!f._fbq) f._fbq = n;
      n.push = n;
      n.loaded = !0;
      n.version = "2.0";
      n.queue = [];
      t = b.createElement(e);
      t.async = !0;
      t.src = v;
      s = b.getElementsByTagName(e)[0];
      s.parentNode.insertBefore(t, s);
    })(window, document, "script", "https://connect.facebook.net/en_US/fbevents.js");

    fbq("consent", "grant");
    fbq("init", PIXEL);
    trackPage();
    listenForCheckout();

    if (!done) return;
    var script = document.querySelector('script[src*="fbevents.js"]');
    if (script) {
      script.addEventListener("load", function () {
        window.setTimeout(finish, 400);
      });
      script.addEventListener("error", finish);
    }
    window.setTimeout(finish, 2500);
  }

  function hideBanner(banner) {
    banner.remove();
    document.body.classList.remove("has-consent");
  }

  function showBanner() {
    if (document.querySelector(".consent")) return;
    var bar = document.createElement("div");
    bar.className = "consent";
    bar.setAttribute("role", "region");
    bar.setAttribute("aria-label", "Cookies");

    var copy = document.createElement("p");
    copy.appendChild(document.createTextNode("We\u2019d like to use a Meta cookie to measure our ads, and Microsoft Clarity to see how the pre-order page is used. They stay off unless you accept. "));
    var privacy = document.createElement("a");
    privacy.href = "/privacy#cookies";
    privacy.textContent = "Privacy";
    copy.appendChild(privacy);

    var actions = document.createElement("div");
    actions.className = "consent-actions";

    var yes = document.createElement("button");
    yes.type = "button";
    yes.className = "btn";
    yes.textContent = "Accept";

    var no = document.createElement("button");
    no.type = "button";
    no.className = "btn consent-decline";
    no.textContent = "No thanks";

    yes.addEventListener("click", function () {
      storeConsent("yes");
      hideBanner(bar);
      load();
    });
    no.addEventListener("click", function () {
      storeConsent("no");
      hideBanner(bar);
    });

    actions.appendChild(yes);
    actions.appendChild(no);
    bar.appendChild(copy);
    bar.appendChild(actions);
    document.body.classList.add("has-consent");
    document.body.appendChild(bar);
  }

  var consent = readConsent();
  var ordering = document.body && document.body.hasAttribute("data-order-continue");
  if (consent === "yes") load(ordering ? continueOrder : null);
  else if (ordering) continueOrder();
  else if (consent !== "no") whenReady(showBanner);
})();
