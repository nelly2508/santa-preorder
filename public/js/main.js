(function () {
  const config = window.SANTA_CONFIG;
  if (!config) return;

  const choiceApi = window.SANTA_CHECKOUT;
  const now = previewNow();
  const phase = choiceApi && choiceApi.offerPhase
    ? choiceApi.offerPhase({
        now,
        earlyBird: config.earlyBird,
        earlyBirdEnds: config.earlyBirdEnds,
        lateOrders: config.lateOrders,
        lateOrdersFrom: config.lateOrdersFrom,
      })
    : "early";
  const early = phase === "early";
  const late = phase === "late";
  const ordersClosed = document.body.hasAttribute("data-orders-closed")
    || (choiceApi && choiceApi.ordersOpen && !choiceApi.ordersOpen(now));
  if (ordersClosed) {
    document.body.setAttribute("data-orders-closed", "");
    const note = document.getElementById("orders-closed");
    if (note) note.hidden = false;
  }
  const marketUs = document.body.getAttribute("data-market") === "us";
  const prices = marketUs && config.usd ? config.usd : config.prices;
  const payCurrency = document.body.getAttribute("data-currency") || (marketUs ? "USD" : "GBP");
  const bundlePrice = late ? prices.magicBundleLate : early ? prices.magicBundleEarly : prices.magicBundleFull;
  const singlePrice = late ? prices.singleVideoLate : prices.singleVideo;
  const offer = choiceApi && choiceApi.choiceOffer
    ? choiceApi.choiceOffer({ early, late, prices })
    : null;

  const bundleLabel = early
    ? `Order the Magic bundle — ${bundlePrice} early bird`
    : `Order the Magic bundle — ${bundlePrice}`;

  document.querySelectorAll("[data-label='bundle']").forEach((link) => {
    link.textContent = bundleLabel;
  });

  const offerBanner = document.getElementById("offer-banner");
  if (offerBanner && choiceApi && choiceApi.offerBanner) {
    const text = choiceApi.offerBanner({
      early,
      late,
      closed: ordersClosed,
      price: bundlePrice,
      earlyBirdEnds: config.earlyBirdEnds,
    });
    offerBanner.hidden = !text;
    offerBanner.textContent = text;
    if (text && early && !late) offerBanner.setAttribute("data-choice-open", "");
    else offerBanner.removeAttribute("data-choice-open");
  }

  if (offer) {
    document.querySelectorAll("[data-price='from']").forEach((el) => {
      el.textContent = offer.from;
    });
    const upsell = document.getElementById("hero-upsell");
    if (upsell && offer.upsell) upsell.textContent = offer.upsell;
    const gap = document.getElementById("choice-difference");
    if (gap) gap.textContent = offer.difference || "";
  }

  document.querySelectorAll("[data-link='tally']").forEach((link) => {
    link.href = config.tallyOrderForm;
  });

  document.querySelectorAll("[data-link='free']").forEach((link) => {
    link.href = config.tallyFreeVideo;
  });

  document.querySelectorAll("[data-pay='singleVideo']").forEach((link) => {
    if (link.id === "pay-continue" || link.closest("#choice-sheet")) return;
    link.textContent = `Order the single video — ${singlePrice}`;
  });

  document.querySelectorAll("[data-price='bundle']").forEach((el) => {
    el.textContent = bundlePrice;
  });

  document.querySelectorAll("[data-price='single']").forEach((el) => {
    el.textContent = singlePrice;
  });

  document.querySelectorAll("[data-price='namedSleigh']").forEach((el) => {
    if (prices.namedSleigh) el.textContent = `+${prices.namedSleigh}`;
  });

  if (choiceApi && prices.sibling) {
    const rate = choiceApi.siblingRate(prices.sibling);
    document.querySelectorAll("[data-sibling-rate]").forEach((el) => {
      el.textContent = rate;
    });
    document.querySelectorAll("[data-two-children]").forEach((el) => {
      el.textContent = choiceApi.twoChildrenFor(el.getAttribute("data-two-children"), {
        early,
        late,
        prices,
      });
    });
  }

  if (!early) {
    document.querySelectorAll("[data-early-only]").forEach((el) => {
      el.hidden = true;
    });
  }

  if (late) {
    document.querySelectorAll("[data-before-late]").forEach((el) => {
      el.hidden = true;
    });
    document.querySelectorAll("[data-late-only]").forEach((el) => {
      el.hidden = false;
    });
    const pricingHeading = document.getElementById("pricing-heading");
    if (pricingHeading) pricingHeading.textContent = "Pay now. Christmas week price.";
  }

  const trader = config.trader || {};
  document.querySelectorAll("[data-trader='name']").forEach((el) => {
    el.textContent = trader.name || "";
  });
  document.querySelectorAll("[data-trader='address']").forEach((el) => {
    el.textContent = trader.address || "";
  });
  document.querySelectorAll("[data-trader='identity']").forEach((el) => {
    el.textContent = trader.identity || [trader.name, trader.address].filter(Boolean).join(", ");
  });
  document.querySelectorAll("[data-trader='email']").forEach((el) => {
    const email = trader.email || "";
    el.textContent = email;
    if (el.tagName === "A" && email.includes("@")) {
      el.href = `mailto:${email}`;
    }
  });

  let choiceSheet = null;
  let choiceOpener = null;
  let restoreChoiceFocus = true;
  let syncSheet = function () {};
  let revealPaypal = function () {};
  let noteOrder = function () {};
  let resumeIntoSheet = false;

  if (!ordersClosed) {
    setupCheckout();
    setupChoice();
    if (resumeIntoSheet) openChoice(null, { quietOpen: true, restore: false });
  }
  setupFilms();
  setupDeferredImages();
  setupEnlarge();

  function previewNow() {
    try {
      const raw = new URLSearchParams(window.location.search).get("asof");
      if (!raw) return new Date();
      const parsed = new Date(raw);
      if (Number.isNaN(parsed.getTime())) return new Date();
      return parsed;
    } catch (error) {
      return new Date();
    }
  }

  function setupCheckout() {
    const checkout = document.getElementById("checkout");
    const continueLink = document.getElementById("pay-continue");
    const chosenName = document.getElementById("chosen-name");
    const chosenPrice = document.getElementById("chosen-price");
    if (!continueLink || !choiceApi) return;

    const resume = choiceApi.resumeOrder ? choiceApi.resumeOrder(window.location.search) : { packageKey: "", siblings: 0, sleigh: false };
    let selectedKey = resume.packageKey || "magicBundle";
    let siblings = resume.siblings || 0;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const siblingFaces = document.getElementById("sibling-faces");
    const childrenCount = document.getElementById("children-count");
    const childrenLess = document.getElementById("children-less");
    const childrenMore = document.getElementById("children-more");
    const totalAmount = document.getElementById("order-total-amount");

    const paypalMode = marketUs || document.body.getAttribute("data-payment-provider") !== "stripe";
    const paypalNote = document.getElementById("paypal-note");
    const paypalSlot = document.getElementById("paypal-buttons");
    const payLabel = document.getElementById("pay-label");
    const sleighBox = document.getElementById("named-sleigh");
    const sleighAdd = document.getElementById("sleigh-add");
    const paypalMessage = "Pay with PayPal or card is not available just now. Please email hello@santasaysmyname.com and we will help you order.";
    let paypalRendered = false;
    let paypalLoading = false;

    function showSiblingExample(key) {
      const want = key === "singleVideo" ? "singleVideo" : "magicBundle";
      document.querySelectorAll("[data-two-children]").forEach((el) => {
        el.hidden = el.getAttribute("data-two-children") !== want;
      });
    }

    function siblingMark() {
      const figure = document.createElement("span");
      figure.className = "sibling-face";
      figure.innerHTML = '<svg viewBox="0 0 64 80" focusable="false" aria-hidden="true"><g fill="currentColor"><circle cx="32" cy="20" r="12"/><path d="M8 76c1.6-16 10.2-28 24-28s22.4 12 24 28z"/></g></svg>';
      return figure;
    }

    function dropFace(figure) {
      if (!figure || !figure.parentNode) return;
      if (motion.matches) {
        figure.remove();
        return;
      }
      figure.classList.remove("is-shown");
      figure.classList.add("is-leaving");
      const done = () => {
        if (figure.parentNode) figure.remove();
      };
      figure.addEventListener("transitionend", done, { once: true });
      setTimeout(done, 400);
    }

    function shownFaces() {
      return [...siblingFaces.children].filter((figure) => !figure.classList.contains("is-leaving"));
    }

    function renderFaces(count, animate) {
      if (!siblingFaces) return;
      const next = Math.max(0, count);
      const current = shownFaces();
      while (current.length < next) {
        const figure = siblingMark();
        siblingFaces.appendChild(figure);
        current.push(figure);
        if (animate && !motion.matches) {
          requestAnimationFrame(() => requestAnimationFrame(() => figure.classList.add("is-shown")));
        } else {
          figure.classList.add("is-shown");
        }
      }
      while (current.length > next) dropFace(current.pop());
    }

    function renderSiblings() {
      const children = siblings + 1;
      if (childrenCount) childrenCount.textContent = String(children);
      if (childrenLess) childrenLess.disabled = siblings <= 0;
      if (childrenMore) childrenMore.disabled = siblings >= 4;
    }

    function renderTotal() {
      if (!choiceApi.orderAmount || !totalAmount) return;
      const amount = choiceApi.orderAmount({
        packageKey: selectedKey,
        siblings,
        sleigh: !!(sleighBox && sleighBox.checked && selectedKey === "singleVideo"),
        early,
        late,
        prices,
      });
      if (amount && amount.total) {
        totalAmount.textContent = amount.total;
        if (chosenPrice) chosenPrice.textContent = amount.total;
      }
    }

    function syncRadios() {
      document.querySelectorAll(".sheet-choice input[name='santa-package']").forEach((input) => {
        const on = input.value === selectedKey;
        input.checked = on;
        const label = input.closest(".sheet-choice");
        if (label) label.classList.toggle("is-selected", on);
      });
    }

    function renderChoice() {
      const picked = choiceApi.packageChoice(selectedKey, {
        early,
        late,
        prices,
        stripe: config.stripe,
      });
      if (chosenName && chosenName.textContent !== picked.name) chosenName.textContent = picked.name;
      if (chosenPrice && chosenPrice.textContent !== picked.detail) chosenPrice.textContent = picked.detail;
      return picked;
    }

    function showPaypalNote(message) {
      if (!paypalNote) return;
      paypalNote.hidden = !message;
      paypalNote.textContent = message || "";
    }

    function hidePaypal() {
      if (payLabel) payLabel.hidden = true;
      if (paypalSlot) paypalSlot.hidden = true;
      if (continueLink) continueLink.hidden = false;
    }

    function currentUtm() {
      const utm = {};
      const current = new URLSearchParams(window.location.search);
      ["utm_source", "utm_campaign", "utm_content"].forEach((key) => {
        utm[key] = current.get(key) || "";
      });
      return utm;
    }

    function loadPaypalSdk(clientId) {
      if (window.paypal) return Promise.resolve(window.paypal);
      return new Promise((resolve, reject) => {
        const params = new URLSearchParams({
          "client-id": clientId,
          currency: payCurrency,
          intent: "capture",
          components: "buttons",
          "enable-funding": "card",
          "disable-funding": "paylater,venmo,credit",
        });
        const script = document.createElement("script");
        script.src = `https://www.paypal.com/sdk/js?${params.toString()}`;
        const nonce = document.body.getAttribute("data-csp-nonce");
        if (nonce) {
          script.setAttribute("data-csp-nonce", nonce);
          script.nonce = nonce;
        }
        script.async = true;
        script.onload = () => (window.paypal ? resolve(window.paypal) : reject(new Error("sdk")));
        script.onerror = () => reject(new Error("sdk"));
        document.head.appendChild(script);
      });
    }

    function showPaypal() {
      if (!paypalMode) return;
      const clientId = document.body.getAttribute("data-paypal-client-id") || "";
      const ready = document.body.getAttribute("data-paypal-ready") === "1" && clientId;
      if (!ready) {
        showPaypalNote(paypalMessage);
        return;
      }
      if (continueLink) continueLink.hidden = true;
      if (payLabel) payLabel.hidden = false;
      if (paypalSlot) paypalSlot.hidden = false;
      if (paypalRendered || paypalLoading) return;
      showPaypalNote("");
      paypalLoading = true;
      showPaypalNote("Loading PayPal…");
      loadPaypalSdk(clientId).then((paypal) => {
        paypalLoading = false;
        if (!paypalSlot || paypalRendered) return;
        showPaypalNote("");
        paypalRendered = true;
        paypal.Buttons({
          style: { layout: "vertical", shape: "rect", label: "paypal" },
          onClick: (data, actions) => {
            recordPayClick();
            document.dispatchEvent(new Event("santa-pay"));
            if (window.fbq) window.fbq("track", "InitiateCheckout", { currency: payCurrency });
            return actions.resolve();
          },
          createOrder: () => {
            const utm = currentUtm();
            return fetch("/api/paypal/orders", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "omit",
              cache: "no-store",
              body: JSON.stringify({
                package: selectedKey,
                siblings,
                sleigh: !!(sleighBox && sleighBox.checked && selectedKey === "singleVideo"),
                utm_source: utm.utm_source,
                utm_campaign: utm.utm_campaign,
                utm_content: utm.utm_content,
                market: marketUs ? "us" : "uk",
                variant: pageVariant(),
              }),
            }).then(async (res) => {
              const payload = await res.json().catch(() => ({}));
              if (!res.ok || !payload.id) {
                showPaypalNote(payload.error || paypalMessage);
                throw new Error("create");
              }
              return payload.id;
            });
          },
          onApprove: (data) => fetch(`/api/paypal/orders/${encodeURIComponent(data.orderID)}/capture`, {
            method: "POST",
            credentials: "omit",
            cache: "no-store",
          }).then(async (res) => {
            const payload = await res.json().catch(() => ({}));
            if (!res.ok || payload.status === "PAYER_ACTION_REQUIRED") {
              if (payload.payerAction) {
                window.location.assign(payload.payerAction);
                return;
              }
              showPaypalNote(payload.error || "Your bank still needs to approve this payment. If it goes through, we will email you.");
              return;
            }
            if (!payload.continueUrl || payload.continueUrl.indexOf("/order/continue?session_id=") !== 0) {
              showPaypalNote(payload.error || "The payment did not complete. Please try again, or email hello@santasaysmyname.com.");
              return;
            }
            window.location.assign(payload.continueUrl);
          }),
          onCancel: () => {
            showPaypalNote("Payment cancelled. You can try again when you're ready.");
          },
          onError: () => {
            showPaypalNote("The payment did not complete. Please try again, or email hello@santasaysmyname.com.");
          },
        }).render(paypalSlot).catch(() => {
          paypalRendered = false;
          paypalLoading = false;
          hidePaypal();
          showPaypalNote(paypalMessage);
        });
      }).catch(() => {
        paypalLoading = false;
        hidePaypal();
        showPaypalNote(paypalMessage);
      });
    }

    function syncSleigh() {
      if (!sleighAdd) return;
      sleighAdd.hidden = !(paypalMode && selectedKey === "singleVideo");
    }

    function syncContinue() {
      const picked = renderChoice();
      syncSleigh();
      syncRadios();
      renderTotal();
      if (checkout) checkout.classList.add("is-ready");
      const utm = currentUtm();
      const query = choiceApi.orderQuery
        ? choiceApi.orderQuery({
          packageKey: picked.key,
          siblings,
          sleigh: !!(sleighBox && sleighBox.checked),
          utm,
          market: marketUs ? "us" : "uk",
          variant: pageVariant(),
        })
        : `package=${encodeURIComponent(picked.key)}`;
      continueLink.setAttribute("aria-disabled", "false");
      continueLink.removeAttribute("tabindex");
      continueLink.setAttribute("aria-describedby", "order-total");
      if (paypalMode) {
        continueLink.href = "#checkout";
        continueLink.removeAttribute("data-pay");
      } else {
        continueLink.href = `/order/pay?${query}`;
        continueLink.setAttribute("data-pay", picked.key);
      }
    }

    function recordOrderTap() {
      recordFunnel("order_tap", { package: selectedKey });
    }

    function recordPayClick() {
      recordFunnel("pay_click", { package: selectedKey });
    }

    document.querySelectorAll("[data-pay]").forEach((link) => {
      if (link === continueLink || link.closest("#choice-sheet")) return;
      link.addEventListener("click", (event) => {
        event.preventDefault();
        selectedKey = link.getAttribute("data-pay") === "singleVideo" ? "singleVideo" : "magicBundle";
        document.dispatchEvent(new Event("santa-pay"));
        showSiblingExample(selectedKey);
        openChoice(link, { quietOpen: false });
      });
    });

    continueLink.addEventListener("click", (event) => {
      if (paypalMode) {
        event.preventDefault();
        showPaypal();
        return;
      }
      if (continueLink.getAttribute("aria-disabled") === "true") {
        event.preventDefault();
        return;
      }
      recordPayClick();
    });

    function setChildren(next, animate) {
      const count = Math.max(0, Math.min(4, next));
      if (count === siblings && animate) return;
      siblings = count;
      renderSiblings();
      renderFaces(siblings + 1, animate);
      syncContinue();
    }

    if (childrenMore) {
      childrenMore.addEventListener("click", () => setChildren(siblings + 1, true));
    }
    if (childrenLess) {
      childrenLess.addEventListener("click", () => setChildren(siblings - 1, true));
    }
    document.querySelectorAll(".sheet-choice input[name='santa-package']").forEach((input) => {
      input.addEventListener("change", () => {
        if (!input.checked) return;
        const next = input.value === "singleVideo" ? "singleVideo" : "magicBundle";
        if (next === selectedKey) return;
        selectedKey = next;
        showSiblingExample(selectedKey);
        syncContinue();
        recordOrderTap();
      });
    });
    if (sleighBox) {
      sleighBox.addEventListener("change", () => syncContinue());
      if (resume.sleigh) sleighBox.checked = true;
    }

    syncSheet = function () {
      showSiblingExample(selectedKey);
      renderSiblings();
      syncContinue();
    };
    revealPaypal = showPaypal;
    noteOrder = recordOrderTap;
    resumeIntoSheet = !!(resume.packageKey || resume.siblings || resume.sleigh);

    showSiblingExample(selectedKey);
    renderSiblings();
    renderFaces(siblings + 1, false);
    syncContinue();
  }

  function paypalOverlayOpen() {
    return !!document.querySelector(".paypal-checkout-sandbox, .venmo-checkout-sandbox, #Cardinal-Modal, #Cardinal-ElementContainer");
  }

  function closeChoice(options) {
    restoreChoiceFocus = !(options && options.restore === false);
    if (!choiceSheet || choiceSheet.hidden) return;
    choiceSheet.hidden = true;
    document.body.classList.remove("sheet-open");
    const back = choiceOpener;
    choiceOpener = null;
    if (restoreChoiceFocus && back && typeof back.focus === "function") back.focus({ preventScroll: true });
    restoreChoiceFocus = true;
  }

  function openChoice(trigger, options) {
    const source = options || {};
    if (!choiceSheet || ordersClosed) return;
    if (choiceSheet.hidden) {
      choiceOpener = trigger || document.activeElement;
      restoreChoiceFocus = source.restore !== false;
      choiceSheet.hidden = false;
      document.body.classList.add("sheet-open");
      if (!source.quietOpen) recordFunnel("choice_open");
      syncSheet();
      const closeButton = document.getElementById("choice-close");
      if (closeButton && typeof closeButton.focus === "function") closeButton.focus({ preventScroll: true });
      requestAnimationFrame(() => revealPaypal());
    } else {
      syncSheet();
    }
    if (!source.quietOpen) noteOrder();
  }

  function setupChoice() {
    choiceSheet = document.getElementById("choice-sheet");
    if (!choiceSheet) return;

    const scrim = document.getElementById("choice-scrim");
    if (scrim) scrim.addEventListener("click", () => closeChoice());

    const closeButton = document.getElementById("choice-close");
    if (closeButton) closeButton.addEventListener("click", () => closeChoice());

    choiceSheet.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        if (paypalOverlayOpen()) return;
        event.preventDefault();
        closeChoice();
        return;
      }
      if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;
      if (paypalOverlayOpen()) return;
      const items = [...choiceSheet.querySelectorAll("a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])")]
        .filter((el) => el.getClientRects().length > 0);
      if (!items.length) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const leavingBack = event.shiftKey && (active === first || !choiceSheet.contains(active));
      const leavingForward = !event.shiftKey && active === last;
      if (!leavingBack && !leavingForward) return;
      event.preventDefault();
      (leavingBack ? last : first).focus({ preventScroll: true });
    });

    choiceSheet.querySelectorAll('a[href^="#"]').forEach((link) => {
      link.addEventListener("click", () => closeChoice({ restore: false }));
    });

    document.addEventListener("click", (event) => {
      const opener = event.target && event.target.closest && event.target.closest("[data-choice-open]");
      if (!opener || ordersClosed) return;
      event.preventDefault();
      openChoice(opener);
    });

    const checkout = document.getElementById("checkout");
    if (checkout && "IntersectionObserver" in window) {
      const observer = new IntersectionObserver((entries) => {
        const visible = entries.some((entry) => entry.isIntersecting && entry.intersectionRatio > 0);
        document.body.classList.toggle("order-in-view", visible);
      }, { threshold: [0, 0.15] });
      observer.observe(checkout);
    }
  }

  function pageVariant() {
    const name = document.body.getAttribute("data-variant") || "";
    return name === "explainer" || name === "parents" ? name : "";
  }

  function tagClarity() {
    const variant = pageVariant();
    if (!variant || typeof window.clarity !== "function") return;
    try {
      window.clarity("set", "variant", variant);
    } catch (error) {
      // Clarity is optional. The film still plays.
    }
  }

  function recordFunnel(eventName, extra) {
    try {
      const params = new URLSearchParams(window.location.search);
      const payload = {
        event: eventName,
        utm_source: params.get("utm_source") || "",
        utm_campaign: params.get("utm_campaign") || "",
        utm_content: params.get("utm_content") || "",
        market: document.body.getAttribute("data-market") === "us" ? "us" : "uk",
        variant: pageVariant(),
      };
      const pkg = extra && extra.package;
      if (pkg === "singleVideo" || pkg === "magicBundle") payload.package = pkg;
      const body = JSON.stringify(payload);
      fetch("/api/funnel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
        credentials: "omit",
        cache: "no-store",
      }).catch(() => {});
    } catch (error) {
      // Counting must not block the order.
    }
  }

  function armPlayer(video, button) {
    if (!video || !button) return { start() {} };
    let armed = false;

    function showPoster() {
      const poster = video.getAttribute("data-poster");
      if (poster && !video.getAttribute("poster")) video.setAttribute("poster", poster);
    }

    function attachSource() {
      if (armed) return;
      armed = true;
      showPoster();
      const src = video.getAttribute("data-src");
      if (src && !video.querySelector("source")) {
        const source = document.createElement("source");
        source.src = src;
        source.type = "video/mp4";
        video.appendChild(source);
      }
      const track = video.querySelector("track");
      const trackSrc = track && track.getAttribute("data-src");
      if (track && trackSrc && !track.getAttribute("src")) track.src = trackSrc;
      video.load();
    }

    if ("IntersectionObserver" in window) {
      const observer = new IntersectionObserver((entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        showPoster();
        observer.disconnect();
      });
      observer.observe(video);
    } else {
      showPoster();
    }

    function start() {
      button.hidden = true;
      attachSource();
      const pending = video.play();
      if (pending && typeof pending.catch === "function") {
        pending.catch(() => {
          button.hidden = false;
        });
      }
    }

    button.addEventListener("click", start);
    video.addEventListener("pointerdown", () => attachSource());
    video.addEventListener("play", () => {
      button.hidden = true;
    });
    return { start };
  }

  function armHero(video, button) {
    if (!video) return;
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    function start() {
      if (button) button.hidden = true;
      const pending = video.play();
      if (pending && typeof pending.catch === "function") {
        pending.catch(() => {
          if (button) button.hidden = false;
        });
      }
    }
    if (button) {
      button.addEventListener("click", start);
      video.addEventListener("play", () => {
        button.hidden = true;
      });
    }
    if (video.autoplay || video.hasAttribute("autoplay")) start();
  }

  function armHeroTap(video, playButton) {
    if (!video) return;
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");
    video.autoplay = false;
    video.removeAttribute("autoplay");
    video.loop = false;
    video.removeAttribute("loop");
    video.muted = false;
    video.defaultMuted = false;
    video.removeAttribute("muted");
    const marketUs = document.body.getAttribute("data-market") === "us";
    const fallbackSrc = marketUs ? "/assets/us-sample-saoirse-4x5-usd.mp4" : "/assets/santa-preview-v3.mp4";
    const fallbackPoster = "/assets/santa-preview-poster-lite.webp";
    let fellBack = false;
    let started = false;

    function currentSrc() {
      const source = video.querySelector("source");
      return (source && source.getAttribute("src")) || video.currentSrc || "";
    }

    function isFinalSample(src) {
      return src.indexOf("santa-preview-v3.mp4") !== -1 || src.indexOf("us-sample-saoirse-4x5-usd.mp4") !== -1;
    }

    function useFallback() {
      if (fellBack || isFinalSample(currentSrc())) return;
      fellBack = true;
      started = false;
      const source = video.querySelector("source");
      if (source) source.setAttribute("src", fallbackSrc);
      video.setAttribute("poster", fallbackPoster);
      video.load();
      render();
    }

    video.addEventListener("error", useFallback);
    const sourceEl = video.querySelector("source");
    if (sourceEl) sourceEl.addEventListener("error", useFallback);

    const soundApi = window.SANTA_HERO_SOUND;
    const toggle = document.getElementById("hero-toggle");
    const label = playButton ? playButton.querySelector(".hero-play-label") : null;

    function phase() {
      if (video.ended) return "ended";
      if (!started) return "idle";
      if (video.paused) return "paused";
      return "playing";
    }

    function render() {
      const view = soundApi && soundApi.heroView ? soundApi.heroView(phase()) : null;
      if (!view) return;
      if (playButton) {
        playButton.hidden = !view.poster;
        playButton.setAttribute("aria-label", view.posterAria);
      }
      if (label) {
        label.textContent = view.posterText;
        label.hidden = !view.posterText;
      }
      if (toggle) {
        toggle.hidden = !view.toggle;
        toggle.textContent = view.toggleText;
        toggle.setAttribute("aria-label", view.toggleAria);
        toggle.setAttribute("aria-pressed", view.togglePressed ? "true" : "false");
      }
    }

    function begin(restart) {
      video.muted = false;
      video.removeAttribute("muted");
      if (restart) {
        try {
          video.currentTime = 0;
        } catch (error) {
          // A browser that has not buffered yet still plays from the start.
        }
      }
      const pending = video.play();
      if (pending && typeof pending.catch === "function") {
        pending.catch(() => render());
      }
    }

    function onControl(event) {
      event.stopPropagation();
      const action = soundApi && soundApi.heroStart
        ? soundApi.heroStart(phase())
        : { restart: !started || video.ended, pause: started && !video.paused && !video.ended };
      if (action.pause) {
        video.pause();
        return;
      }
      begin(action.restart);
    }

    if (playButton) playButton.addEventListener("click", onControl);
    if (toggle) toggle.addEventListener("click", onControl);
    video.addEventListener("play", () => {
      started = true;
      render();
    });
    video.addEventListener("pause", render);
    video.addEventListener("ended", render);
    render();
  }

  function setupFilms() {
    armHeroTap(document.getElementById("hear-santa"), document.getElementById("hero-start"));
    armPlayer(document.getElementById("hero-film"), document.getElementById("hero-play"));
    const see = document.getElementById("see-example");
    if (see) {
      see.addEventListener("click", () => {
        recordFunnel("example_tap");
        const hear = document.getElementById("hear");
        if (hear && typeof hear.scrollIntoView === "function") {
          const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
          hear.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
        }
        const start = document.getElementById("hero-start");
        if (start && !start.hidden) start.click();
      });
    }
    tagClarity();
  }

  function setupDeferredImages() {
    document.querySelectorAll("img[data-src]").forEach((img) => {
      const load = () => {
        if (img.getAttribute("src")) return;
        img.src = img.getAttribute("data-src");
      };
      if (!("IntersectionObserver" in window)) {
        load();
        return;
      }
      const observer = new IntersectionObserver((entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        load();
        observer.disconnect();
      });
      observer.observe(img);
    });
  }

  function setupEnlarge() {
    const dialog = document.getElementById("enlarge");
    const full = document.getElementById("enlarge-img");
    if (!dialog || !full) return;

    document.querySelectorAll("[data-enlarge]").forEach((button) => {
      button.addEventListener("click", () => {
        const source = button.querySelector("img");
        if (!source) return;
        full.src = source.currentSrc || source.src;
        full.alt = source.alt;
        if (typeof dialog.showModal === "function") dialog.showModal();
      });
    });

    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
  }
})();
