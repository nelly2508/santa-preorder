(function () {
  const config = window.SANTA_CONFIG;
  if (!config) return;

  const early = isEarlyBird(config);
  const prices = config.prices;
  const bundlePrice = early ? prices.magicBundleEarly : prices.magicBundleFull;

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

  document.querySelectorAll("[data-price='bundle']").forEach((el) => {
    el.textContent = bundlePrice;
  });

  ["rush", "namedSleigh"].forEach((key) => {
    document.querySelectorAll(`[data-price='${key}']`).forEach((el) => {
      if (prices[key]) el.textContent = `+${prices[key]}`;
    });
  });

  const choiceApi = window.SANTA_CHECKOUT;
  if (choiceApi && prices.sibling) {
    const rate = choiceApi.siblingRate(prices.sibling);
    document.querySelectorAll("[data-sibling-rate]").forEach((el) => {
      el.textContent = rate;
    });
    document.querySelectorAll("[data-two-children]").forEach((el) => {
      el.textContent = choiceApi.twoChildrenFor(el.getAttribute("data-two-children"), {
        early,
        prices,
      });
    });
  }

  if (!early) {
    document.querySelectorAll("[data-early-only]").forEach((el) => {
      el.hidden = true;
    });
    document.querySelectorAll(".js-early-note").forEach((el) => {
      el.textContent = "Nice List Promise: love it or your money back";
    });
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

  setupCheckout();

  setupSample();
  setupEnlarge();

  function isEarlyBird(cfg) {
    if (cfg.earlyBird === false) return false;
    const end = new Date(cfg.earlyBirdEnds);
    if (Number.isNaN(end.getTime())) return false;
    return Date.now() <= end.getTime();
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
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");

    function renderChoice() {
      const picked = choiceApi.packageChoice(selectedKey, {
        early,
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
      if (hint) hint.hidden = ready;
      if (checkout) checkout.classList.toggle("is-ready", ready);
      continueLink.setAttribute("aria-disabled", ready ? "false" : "true");
      if (ready) {
        continueLink.href = picked.href;
        continueLink.removeAttribute("tabindex");
        continueLink.setAttribute("aria-describedby", "chosen-package");
        if (moveFocus) continueLink.focus();
      } else {
        continueLink.href = "#checkout";
        continueLink.tabIndex = -1;
        continueLink.setAttribute("aria-describedby", "agree-hint");
      }
    }

    function scrollToCheckout() {
      if (!checkout) return;
      checkout.scrollIntoView({
        behavior: motion.matches ? "auto" : "smooth",
        block: "center",
      });
    }

    document.querySelectorAll("[data-pay]").forEach((link) => {
      if (link === continueLink) return;
      link.addEventListener("click", (event) => {
        event.preventDefault();
        selectedKey = link.getAttribute("data-pay") === "singleVideo" ? "singleVideo" : "magicBundle";
        syncContinue(false);
        scrollToCheckout();
        if (box.checked) continueLink.focus();
        else box.focus({ preventScroll: true });
      });
    });

    box.addEventListener("change", () => {
      syncContinue(box.checked);
    });

    continueLink.addEventListener("click", (event) => {
      if (box.checked && continueLink.getAttribute("aria-disabled") !== "true") return;
      event.preventDefault();
      if (hint) hint.hidden = false;
      box.focus();
    });

    syncContinue(false);
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

  function setupSample() {
    const video = document.getElementById("sample-video");
    const soundBtn = document.getElementById("sound-toggle");
    const slot = document.getElementById("sample-slot");
    const caption = document.getElementById("sample-caption");
    if (!video) return;

    function showSlot() {
      const source = video.querySelector("source");
      if (source) source.removeAttribute("src");
      video.removeAttribute("src");
      video.removeAttribute("controls");
      if (slot) slot.hidden = false;
    }

    function showFilm() {
      if (slot) slot.hidden = true;
      video.controls = true;
      if (caption) {
        caption.textContent = "Real sample. Made with AI. This is exactly what you'll get.";
      }
      if (soundBtn) soundBtn.hidden = false;
      video.muted = true;
      const play = video.play();
      if (play && typeof play.catch === "function") play.catch(() => {});
    }

    fetch("assets/sample.mp4", { method: "HEAD" })
      .then((res) => {
        if (!res.ok) {
          showSlot();
          return;
        }
        video.preload = "auto";
        video.addEventListener("loadeddata", showFilm, { once: true });
        video.addEventListener("error", showSlot, { once: true });
        video.load();
      })
      .catch(showSlot);

    if (soundBtn) {
      soundBtn.addEventListener("click", () => {
        video.muted = !video.muted;
        soundBtn.textContent = video.muted ? "Tap for sound" : "Mute";
        soundBtn.setAttribute("aria-pressed", video.muted ? "false" : "true");
        if (!video.muted) {
          const play = video.play();
          if (play && typeof play.catch === "function") play.catch(() => {});
        }
      });
    }
  }
})();
