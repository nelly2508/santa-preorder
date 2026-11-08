/* Meta Pixel and Microsoft Clarity.
   UK (default): both load only after Accept. The choice is remembered in
   localStorage under ssmn_consent. Reject leaves both unloaded. A footer
   Cookies link opens the choice again.
   US (/us, data-market="us"): opt-out. Both run unless the visitor turns
   them off, or the browser sends Global Privacy Control. The choice is
   remembered under ssmn_us_optout. Clarity is added on the pre-order page
   only (data-sales-page). First-party funnel counts do not use this file. */
(function () {
  "use strict";

  var PIXEL = "898274206954064";
  var KEY = "ssmn_consent";
  var US_KEY = "ssmn_us_optout";
  var listening = false;

  function pageMarket() {
    return document.body && document.body.getAttribute("data-market") === "us" ? "us" : "uk";
  }

  var CURRENCY = pageMarket() === "us" ? "USD" : "GBP";

  function readKey(key) {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function writeKey(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (error) {
      /* Private browsing can refuse storage. The choice still applies to this page. */
    }
  }

  function readConsent() {
    return readKey(KEY);
  }

  function gpcOptOut() {
    try {
      var nav = window.navigator;
      return !!(nav && nav.globalPrivacyControl === true);
    } catch (error) {
      return false;
    }
  }

  function usOptedOut() {
    return gpcOptOut() || readKey(US_KEY) === "yes";
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
    if (el.id === "pay-continue" && document.body && document.body.getAttribute("data-payment-provider") !== "stripe") return;
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
    if (pageMarket() === "us") {
      if (usOptedOut()) return;
    } else if (readConsent() !== "yes") return;
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
    var shown = document.body && document.body.getAttribute("data-variant");
    if (shown === "explainer" || shown === "parents") {
      try { window.clarity("set", "variant", shown); } catch (error) { /* optional */ }
    }
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

  function stopTracking() {
    if (typeof window.fbq === "function") {
      try { window.fbq("consent", "revoke"); } catch (error) { /* already gone */ }
    }
    if (typeof window.clarity === "function") {
      try { window.clarity("consent", false); } catch (error) { /* already gone */ }
    }
  }

  function hideBanner(banner) {
    banner.remove();
    document.body.classList.remove("has-consent");
  }

  function choiceButton(label) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "btn";
    button.textContent = label;
    return button;
  }

  function showBanner() {
    if (pageMarket() === "us") return;
    if (document.querySelector(".consent")) return;
    var bar = document.createElement("div");
    bar.className = "consent";
    bar.setAttribute("role", "region");
    bar.setAttribute("aria-label", "Cookies");

    var copy = document.createElement("p");
    copy.appendChild(document.createTextNode("We use a Meta cookie to measure ads, and Microsoft Clarity on this page. They stay off unless you accept. "));
    var privacy = document.createElement("a");
    privacy.href = "/privacy#cookies";
    privacy.textContent = "Privacy";
    copy.appendChild(privacy);

    var actions = document.createElement("div");
    actions.className = "consent-actions";

    var yes = choiceButton("Accept");
    var no = choiceButton("Reject");

    yes.addEventListener("click", function () {
      writeKey(KEY, "yes");
      hideBanner(bar);
      load();
    });
    no.addEventListener("click", function () {
      writeKey(KEY, "no");
      hideBanner(bar);
      stopTracking();
    });

    actions.appendChild(yes);
    actions.appendChild(no);
    bar.appendChild(copy);
    bar.appendChild(actions);
    document.body.classList.add("has-consent");
    document.body.appendChild(bar);
  }

  function markOptOut(button) {
    if (!button) return;
    button.setAttribute("aria-pressed", "true");
    button.textContent = "Sale of personal information is off";
  }

  function bindControls() {
    var cookies = document.querySelector("#cookie-settings");
    if (cookies && !cookies.__bound) {
      cookies.__bound = true;
      cookies.addEventListener("click", function (event) {
        if (pageMarket() === "us") return;
        if (event && event.preventDefault) event.preventDefault();
        showBanner();
      });
    }
    var opt = document.querySelector("#us-do-not-sell");
    if (opt && !opt.__bound) {
      opt.__bound = true;
      if (pageMarket() === "us" && usOptedOut()) markOptOut(opt);
      opt.addEventListener("click", function (event) {
        if (event && event.preventDefault) event.preventDefault();
        writeKey(US_KEY, "yes");
        stopTracking();
        markOptOut(opt);
      });
    }
  }

  whenReady(bindControls);

  var ordering = document.body && document.body.hasAttribute("data-order-continue");
  if (pageMarket() === "us") {
    if (usOptedOut()) {
      if (ordering) continueOrder();
    } else {
      load(ordering ? continueOrder : null);
    }
  } else {
    var consent = readConsent();
    if (consent === "yes") load(ordering ? continueOrder : null);
    else if (ordering) continueOrder();
    else if (consent !== "no") whenReady(showBanner);
  }
})();
