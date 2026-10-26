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
  const prices = config.prices;
  const bundlePrice = late ? prices.magicBundleLate : early ? prices.magicBundleEarly : prices.magicBundleFull;
  const singlePrice = late ? prices.singleVideoLate : prices.singleVideo;

  const bundleLabels = {
    bundle: early
      ? `Pre-order the Magic bundle — ${bundlePrice} early bird`
      : `Pre-order the Magic bundle — ${bundlePrice}`,
    final: early
      ? `Pre-order now — ${bundlePrice} early bird`
      : `Pre-order now — ${bundlePrice}`,
  };

  document.querySelectorAll("[data-pay]").forEach((link) => {
    const label = link.getAttribute("data-label");
    if (label && bundleLabels[label]) link.textContent = bundleLabels[label];
  });

  document.querySelectorAll("[data-link='tally']").forEach((link) => {
    link.href = config.tallyOrderForm;
  });

  document.querySelectorAll("[data-link='free']").forEach((link) => {
    link.href = config.tallyFreeVideo;
  });

  document.querySelectorAll("[data-pay='singleVideo']").forEach((link) => {
    if (link.id === "pay-continue") return;
    link.textContent = `Pre-order the single video — ${singlePrice}`;
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
    if (pricingHeading) pricingHeading.textContent = "Pay now. Rush delivery included.";
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

  if (!ordersClosed) setupCheckout();
  setupSampleVideo();
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
    const box = document.getElementById("reg37");
    const hint = document.getElementById("agree-hint");
    const checkout = document.getElementById("checkout");
    const continueLink = document.getElementById("pay-continue");
    const chosenName = document.getElementById("chosen-name");
    const chosenPrice = document.getElementById("chosen-price");
    if (!box || !continueLink || !choiceApi) return;

    let selectedKey = "magicBundle";
    let siblings = 0;
    let attempted = false;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const addSibling = document.getElementById("add-sibling");
    const removeSibling = document.getElementById("sibling-remove");
    const siblingCount = document.getElementById("sibling-count");
    const siblingNext = document.getElementById("sibling-next");

    function showSiblingExample(key) {
      const want = key === "singleVideo" ? "singleVideo" : "magicBundle";
      document.querySelectorAll("[data-two-children]").forEach((el) => {
        el.hidden = el.getAttribute("data-two-children") !== want;
      });
    }

    function renderSiblings() {
      const amount = prices.sibling || "";
      if (removeSibling) removeSibling.hidden = siblings === 0;
      if (addSibling) {
        addSibling.disabled = siblings >= 4;
        addSibling.textContent = siblings === 0 ? "Add a sibling" : "Add another sibling";
      }
      if (siblingCount) {
        if (siblings === 0) siblingCount.textContent = "No siblings added yet.";
        else if (siblings === 1) siblingCount.textContent = `1 sibling added (${amount}).`;
        else siblingCount.textContent = `${siblings} siblings added (${amount} each).`;
      }
      if (siblingNext) {
        if (siblings === 0) {
          siblingNext.hidden = true;
          siblingNext.textContent = "";
        } else if (siblings === 1) {
          siblingNext.hidden = false;
          siblingNext.textContent = "On the card page, tap Add next to Sibling.";
        } else {
          siblingNext.hidden = false;
          siblingNext.textContent = `On the card page, tap Add next to Sibling, then set the quantity to ${siblings}.`;
        }
      }
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

    function syncContinue(moveFocus) {
      const picked = renderChoice();
      const ready = box.checked;
      if (hint) hint.hidden = !attempted || ready;
      if (checkout) checkout.classList.toggle("is-ready", ready);
      box.setAttribute("aria-invalid", attempted && !ready ? "true" : "false");
      continueLink.setAttribute("aria-disabled", ready ? "false" : "true");
      if (ready) {
        continueLink.href = `/order/pay?package=${encodeURIComponent(picked.key)}`;
        continueLink.setAttribute("data-pay", picked.key);
        continueLink.removeAttribute("tabindex");
        continueLink.setAttribute("aria-describedby", "chosen-package");
        if (moveFocus) continueLink.focus();
      } else {
        continueLink.href = "#checkout";
        continueLink.removeAttribute("data-pay");
        continueLink.tabIndex = -1;
        if (attempted && hint) continueLink.setAttribute("aria-describedby", "agree-hint");
        else continueLink.removeAttribute("aria-describedby");
      }
    }

    function scrollToCheckout() {
      if (!checkout) return;
      checkout.scrollIntoView({
        behavior: motion.matches ? "auto" : "smooth",
        block: "start",
      });
    }

    document.querySelectorAll("[data-pay]").forEach((link) => {
      if (link === continueLink) return;
      link.addEventListener("click", (event) => {
        event.preventDefault();
        selectedKey = link.getAttribute("data-pay") === "singleVideo" ? "singleVideo" : "magicBundle";
        showSiblingExample(selectedKey);
        syncContinue(false);
        scrollToCheckout();
        if (box.checked) continueLink.focus();
        else box.focus({ preventScroll: true });
      });
    });

    box.addEventListener("change", () => {
      if (box.checked) attempted = false;
      syncContinue(box.checked);
    });

    continueLink.addEventListener("click", (event) => {
      if (box.checked && continueLink.getAttribute("aria-disabled") !== "true") return;
      event.preventDefault();
      attempted = true;
      if (hint) hint.hidden = false;
      continueLink.setAttribute("aria-describedby", "agree-hint");
      box.setAttribute("aria-invalid", "true");
      box.focus();
    });

    if (addSibling) {
      addSibling.addEventListener("click", () => {
        if (siblings >= 4) return;
        siblings += 1;
        renderSiblings();
      });
    }
    if (removeSibling) {
      removeSibling.addEventListener("click", () => {
        if (siblings <= 0) return;
        siblings -= 1;
        renderSiblings();
      });
    }

    showSiblingExample(selectedKey);
    renderSiblings();
    syncContinue(false);
  }

  function setupSampleVideo() {
    const video = document.getElementById("hear-santa");
    const button = document.getElementById("sample-play");
    if (!video || !button) return;
    button.addEventListener("click", () => {
      button.hidden = true;
      const pending = video.play();
      if (pending && typeof pending.catch === "function") {
        pending.catch(() => {
          button.hidden = false;
        });
      }
    });
    video.addEventListener("play", () => {
      button.hidden = true;
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
