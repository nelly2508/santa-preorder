/* Exit popup for the sales page.
   Desktop: the pointer leaves through the top of the window.
   Phone: about 25 seconds on the page, then a fast upward flick.
   A back-button press is not used. Seeing it would mean pushing a history
   entry, and that traps the visitor on the page.
   ?exitpopup=1 opens it as soon as the cookie banner is gone, and does not
   spend the 7-day pause. The sales video is not requested until it opens. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) {
    root.SANTA_EXIT = api;
    if (root.document) api.start(root);
  }
})(typeof window === "undefined" ? null : window, function () {
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const MOBILE_DELAY_MS = 25000;
  const STORAGE_KEY = "ssmn_exit_popup";
  const BUY_KEY = "ssmn_buy_clicked";
  const VIDEO_SRC = "/assets/exit-sales-v4.mp4";
  const POSTER_SRC = "/assets/exit-sales-poster-v4.jpg";

  function normalPath(pathname) {
    const path = String(pathname || "/").split("?")[0].split("#")[0];
    if (path.length > 1 && path.endsWith("/")) return path.slice(0, -1);
    return path || "/";
  }

  function isExcludedPath(pathname) {
    const path = normalPath(pathname);
    if (path === "/order" || path.startsWith("/order/")) return true;
    if (path === "/privacy" || path === "/terms") return true;
    if (path === "/thank-you" || path === "/thanks") return true;
    return false;
  }

  function seenRecently(stored, nowMs) {
    const then = Number(stored);
    if (!Number.isFinite(then)) return false;
    return nowMs - then < WEEK_MS;
  }

  function forceRequested(search) {
    const params = new URLSearchParams(search || "");
    return params.get("exitpopup") === "1";
  }

  function shouldOffer(state) {
    const source = state || {};
    if (!source.salesPage) return false;
    if (source.excluded) return false;
    if (source.ordersClosed) return false;
    if (source.consentOpen) return false;
    if (source.force) return true;
    if (source.buyClicked) return false;
    if (source.seenRecently) return false;
    return true;
  }

  function leavesThroughTop(event) {
    if (!event) return false;
    if (event.relatedTarget || event.toElement) return false;
    return typeof event.clientY === "number" && event.clientY <= 0;
  }

  function mobileReady(elapsedMs) {
    return elapsedMs >= MOBILE_DELAY_MS;
  }

  // Upward travel of at least 80px inside a 300ms window, quick enough to be a flick.
  function fastUpwardScroll(sample) {
    const source = sample || {};
    const dy = source.fromY - source.toY;
    const dt = source.toTime - source.fromTime;
    if (!(dy >= 80)) return false;
    if (!(dt >= 0) || dt > 300) return false;
    if (dt === 0) return true;
    return dy / dt >= 0.4;
  }

  function desktopPointer(matchMedia) {
    if (typeof matchMedia !== "function") return false;
    // Phones and tablets report a coarse pointer. A mouse does not, so the
    // top-of-window leave is the desktop trigger. A coarse screen uses the
    // timed upward flick instead.
    return !matchMedia("(pointer: coarse)").matches;
  }

  function readItem(storage, key) {
    try {
      return storage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function writeItem(storage, key, value) {
    try {
      storage.setItem(key, value);
    } catch (error) {
      /* Private browsing can refuse storage. This page still will not open twice. */
    }
  }

  function start(window) {
    const doc = window.document;
    if (!doc.body || !doc.body.hasAttribute("data-sales-page")) return;
    if (isExcludedPath(window.location.pathname)) return;
    if (doc.body.hasAttribute("data-orders-closed")) return;

    const dialog = doc.getElementById("exit-popup");
    if (!dialog || typeof dialog.showModal !== "function") return;

    const force = forceRequested(window.location.search);
    let opened = false;
    let pending = false;
    const startedAt = window.performance && window.performance.now ? window.performance.now() : Date.now();

    doc.addEventListener("click", rememberBuy, true);

    function rememberBuy(event) {
      const target = event.target && event.target.closest && event.target.closest("a");
      if (!target) return;
      const href = target.href || target.getAttribute("href") || "";
      const toStripe = href.indexOf("buy.stripe.com") !== -1;
      const orderButton = target.hasAttribute("data-pay");
      if (!toStripe && !orderButton) return;
      if (target.getAttribute("aria-disabled") === "true") return;
      writeItem(window.sessionStorage, BUY_KEY, "1");
    }

    function consentOpen() {
      return !!doc.querySelector(".consent");
    }

    function gate() {
      return shouldOffer({
        salesPage: true,
        excluded: false,
        ordersClosed: doc.body.hasAttribute("data-orders-closed"),
        consentOpen: false,
        force,
        buyClicked: readItem(window.sessionStorage, BUY_KEY) === "1",
        seenRecently: seenRecently(readItem(window.localStorage, STORAGE_KEY), Date.now()),
      });
    }

    function mountVideo() {
      const slot = doc.getElementById("exit-popup-media");
      const unmute = doc.getElementById("exit-unmute");
      if (!slot || slot.querySelector("video")) {
        if (unmute) unmute.hidden = false;
        return;
      }
      const video = doc.createElement("video");
      video.className = "exit-popup-video";
      video.controls = true;
      video.muted = true;
      video.defaultMuted = true;
      video.autoplay = true;
      video.playsInline = true;
      video.setAttribute("playsinline", "");
      video.preload = "none";
      video.poster = POSTER_SRC;
      video.width = 1080;
      video.height = 1350;
      video.setAttribute("aria-label", "A short film for grown-ups");
      const source = doc.createElement("source");
      source.type = "video/mp4";
      source.src = VIDEO_SRC;
      video.appendChild(source);
      slot.appendChild(video);
      if (unmute) {
        unmute.hidden = false;
        unmute.addEventListener("click", () => {
          video.muted = !video.muted;
          const silent = video.muted;
          unmute.textContent = silent ? "Unmute" : "Mute";
          unmute.setAttribute("aria-pressed", silent ? "false" : "true");
          unmute.setAttribute("aria-label", silent ? "Unmute video" : "Mute video");
          if (!silent) video.play().catch(() => {});
        });
      }
      video.play().catch(() => {});
    }

    function pauseVideo() {
      const video = dialog.querySelector("video");
      if (video) video.pause();
    }

    function show() {
      if (opened) return;
      opened = true;
      pending = false;
      if (!force) writeItem(window.localStorage, STORAGE_KEY, String(Date.now()));
      mountVideo();
      dialog.showModal();
      const pixel = window.SANTA_PIXEL;
      if (pixel && typeof pixel.trackCustom === "function") pixel.trackCustom("ExitPopupView");
    }

    function requestOpen() {
      if (opened) return;
      if (consentOpen()) {
        pending = true;
        return;
      }
      if (!gate()) return;
      show();
    }

    dialog.addEventListener("close", pauseVideo);
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
    const closeButton = doc.getElementById("exit-popup-close");
    const dismiss = doc.getElementById("exit-popup-no");
    const cta = doc.getElementById("exit-popup-cta");
    if (closeButton) closeButton.addEventListener("click", () => dialog.close());
    if (dismiss) dismiss.addEventListener("click", () => dialog.close());
    if (cta) {
      cta.addEventListener("click", () => {
        if (dialog.open) dialog.close();
      }, true);
    }

    const observer = new MutationObserver(() => {
      if (!pending || consentOpen()) return;
      pending = false;
      if (gate()) show();
    });
    observer.observe(doc.body, { childList: true });

    // The cookie banner is inserted on DOMContentLoaded. Waiting for that
    // event means we see the banner before deciding to open.
    function boot() {
      if (force) {
        requestOpen();
        return;
      }
      if (!gate() && !consentOpen()) return;

      if (desktopPointer(window.matchMedia && window.matchMedia.bind(window))) {
        doc.documentElement.addEventListener("mouseout", (event) => {
          if (leavesThroughTop(event)) requestOpen();
        });
        return;
      }

      armPhone();
    }

    if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", boot);
    else boot();

    function armPhone() {
      const samples = [];
      window.addEventListener("scroll", () => {
        const y = window.scrollY;
        const t = window.performance.now();
        const previous = samples.length ? samples[samples.length - 1] : null;
        if (previous && y < previous.y) {
          const stale = t - previous.t > 300;
          const sample = stale
            ? { fromY: previous.y, toY: y, fromTime: t, toTime: t }
            : { fromY: previous.y, toY: y, fromTime: previous.t, toTime: t };
          if (mobileReady(t - startedAt) && fastUpwardScroll(sample)) requestOpen();
        }
        samples.push({ y, t });
        while (samples.length && t - samples[0].t > 300) samples.shift();
        const oldest = samples[0];
        if (oldest && mobileReady(t - startedAt) && fastUpwardScroll({
          fromY: oldest.y,
          toY: y,
          fromTime: oldest.t,
          toTime: t,
        })) requestOpen();
      }, { passive: true });

      let wheelY = 0;
      let wheelT = 0;
      window.addEventListener("wheel", (event) => {
        const t = window.performance.now();
        if (t - wheelT > 300) {
          wheelY = 0;
          wheelT = t;
        }
        if (event.deltaY >= 0) {
          wheelY = 0;
          wheelT = t;
          return;
        }
        if (wheelY === 0) wheelT = t;
        wheelY += -event.deltaY;
        const dt = t === wheelT ? 0 : t - wheelT;
        if (mobileReady(t - startedAt) && fastUpwardScroll({
          fromY: wheelY,
          toY: 0,
          fromTime: t - dt,
          toTime: t,
        })) requestOpen();
      }, { passive: true });
    }
  }

  return {
    WEEK_MS,
    MOBILE_DELAY_MS,
    STORAGE_KEY,
    BUY_KEY,
    VIDEO_SRC,
    POSTER_SRC,
    isExcludedPath,
    seenRecently,
    forceRequested,
    shouldOffer,
    leavesThroughTop,
    mobileReady,
    fastUpwardScroll,
    desktopPointer,
    start,
  };
});
