"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const test = require("node:test");
const { post } = require("../public/js/funnel-beacon");

const SEARCH = "?utm_source=meta&utm_campaign=xmas&utm_content=video";

function orderTap(body) {
  return JSON.parse(body);
}

test("an order tap is queued with sendBeacon before the page can navigate", () => {
  const calls = [];
  const fetchCalls = [];
  const how = post("order_tap", `${SEARCH}#checkout`, {
    sendBeacon(url, body) {
      calls.push({ url, body });
      return true;
    },
    fetch(...args) {
      fetchCalls.push(args);
      return Promise.resolve();
    },
  });
  assert.strictEqual(how, "beacon");
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(fetchCalls.length, 0);
  assert.strictEqual(calls[0].url, "/api/funnel");
  assert.strictEqual(typeof calls[0].body, "string");
  assert.deepStrictEqual(orderTap(calls[0].body), {
    event: "order_tap",
    utm_source: "meta",
    utm_campaign: "xmas",
    utm_content: "video",
  });
});

test("a refused beacon falls back to a simple keepalive fetch", () => {
  const fetchCalls = [];
  const thrown = post("order_tap", SEARCH, {
    sendBeacon() {
      throw new Error("refused");
    },
    fetch(...args) {
      fetchCalls.push(args);
      return Promise.resolve();
    },
  });
  const missing = post("order_tap", SEARCH, {
    fetch(...args) {
      fetchCalls.push(args);
      return Promise.resolve();
    },
  });
  const full = post("order_tap", SEARCH, {
    sendBeacon() {
      return false;
    },
    fetch(...args) {
      fetchCalls.push(args);
      return Promise.resolve();
    },
  });
  assert.strictEqual(thrown, "fetch");
  assert.strictEqual(missing, "fetch");
  assert.strictEqual(full, "fetch");
  assert.strictEqual(fetchCalls.length, 3);
  for (const [url, init] of fetchCalls) {
    assert.strictEqual(url, "/api/funnel");
    assert.strictEqual(init.method, "POST");
    assert.strictEqual(init.keepalive, true);
    assert.strictEqual(init.credentials, "omit");
    assert.strictEqual(init.cache, undefined);
    assert.strictEqual(init.headers["Content-Type"], "text/plain;charset=UTF-8");
    assert.strictEqual(orderTap(init.body).event, "order_tap");
  }
  assert.strictEqual(post("order_tap", SEARCH, {}), "failed");
});

function element(tag, attrs) {
  const attributes = { ...attrs };
  const listeners = [];
  const node = {
    tagName: tag.toUpperCase(),
    hidden: false,
    disabled: false,
    checked: false,
    textContent: "",
    href: attrs.href || "",
    tabIndex: 0,
    className: attrs.className || "",
    classList: { toggle() {}, add() {}, remove() {} },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attributes, name) ? String(attributes[name]) : null;
    },
    setAttribute(name, value) {
      attributes[name] = String(value);
      if (name === "href") node.href = String(value);
    },
    removeAttribute(name) {
      delete attributes[name];
    },
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attributes, name);
    },
    addEventListener(type, fn) {
      listeners.push({ type, fn });
    },
    click() {
      const event = {
        type: "click",
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
      };
      for (const listener of listeners) {
        if (listener.type === "click") listener.fn(event);
      }
      return event;
    },
    dispatch(type) {
      for (const listener of listeners) {
        if (listener.type === type) listener.fn({ type });
      }
    },
    focus() {},
    scrollIntoView() {},
  };
  if (attrs.id) node.id = attrs.id;
  return node;
}

function matches(el, selector) {
  if (selector.startsWith(".") ) {
    return el.className.split(/\s+/).includes(selector.slice(1));
  }
  const attr = /^\[([^\]=]+)(?:=(['"]?)([^'"\]]*)\2)?\]$/.exec(selector);
  if (!attr) return false;
  if (attr[3] == null) return el.hasAttribute(attr[1]);
  return el.getAttribute(attr[1]) === attr[3];
}

function page(options) {
  const mobile = !!(options && options.mobile);
  const nodes = [
    element("a", { id: "hero-order", "data-pay": "magicBundle", "data-label": "bundle", href: "#checkout", className: "btn" }),
    element("a", { "data-pay": "magicBundle", "data-label": "bundle", href: "#checkout", className: "btn" }),
    element("a", { "data-pay": "singleVideo", href: "#checkout", className: "btn" }),
    element("a", { "data-pay": "magicBundle", "data-label": "final", href: "#checkout", className: "btn" }),
    element("a", { id: "exit-popup-cta", "data-pay": "magicBundle", href: "#checkout", className: "btn" }),
    element("a", { id: "pay-continue", href: "#checkout", "aria-disabled": "true", className: "btn" }),
    element("input", { id: "reg37" }),
    element("p", { id: "agree-hint" }),
    element("div", { id: "checkout", className: "checkout" }),
    element("div", { className: "agree" }),
    element("strong", { id: "chosen-name" }),
    element("span", { id: "chosen-price" }),
    element("button", { id: "add-sibling" }),
    element("button", { id: "sibling-remove" }),
    element("p", { id: "sibling-count" }),
    element("p", { id: "sibling-next" }),
  ];
  const body = element("body", {});
  const beacons = [];
  const fetches = [];
  const document = {
    body,
    getElementById(id) {
      return nodes.find((node) => node.id === id) || null;
    },
    querySelector(selector) {
      return nodes.find((node) => matches(node, selector)) || null;
    },
    querySelectorAll(selector) {
      return nodes.filter((node) => matches(node, selector));
    },
  };
  const context = {
    console,
    URLSearchParams,
    Date,
    JSON,
    Object,
    Array,
    Number,
    String,
    Math,
    Error,
    Promise,
    document,
    location: { search: SEARCH, href: `https://santasaysmyname.com/${SEARCH}` },
    navigator: {
      sendBeacon(url, payload) {
        beacons.push({ url, body: payload });
        return true;
      },
    },
    fetch(...args) {
      fetches.push(args);
      return Promise.resolve({ status: 204 });
    },
    matchMedia(query) {
      return { matches: mobile && query.indexOf("max-width") !== -1 };
    },
  };
  context.window = context;
  vm.createContext(context);
  for (const file of ["config.js", "checkout-choice.js", "funnel-beacon.js", "main.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../public/js", file), "utf8"), context, { filename: file });
  }
  return { nodes, document, beacons, fetches };
}

test("every order button records a tap, including straight to checkout on a phone", () => {
  for (const mobile of [false, true]) {
    const { nodes, document, beacons, fetches } = page({ mobile });
    const orderButtons = nodes.filter((node) => node.hasAttribute("data-pay") && node.id !== "pay-continue");
    assert.strictEqual(orderButtons.length, 5);
    for (const button of orderButtons) {
      const event = button.click();
      assert.strictEqual(event.defaultPrevented, true);
    }
    assert.strictEqual(beacons.length, 5);
    assert.strictEqual(fetches.length, 0);

    const pay = document.getElementById("pay-continue");
    const blocked = pay.click();
    assert.strictEqual(blocked.defaultPrevented, true);
    assert.strictEqual(beacons.length, 5);

    const box = document.getElementById("reg37");
    box.checked = true;
    box.dispatch("change");
    assert.match(pay.href, /^\/order\/pay\?/);
    assert.match(pay.href, /utm_source=meta/);
    const event = pay.click();
    assert.strictEqual(event.defaultPrevented, false);
    assert.strictEqual(beacons.length, 6);
    assert.strictEqual(fetches.length, 0);
    for (const beacon of beacons) {
      assert.strictEqual(beacon.url, "/api/funnel");
      assert.deepStrictEqual(orderTap(beacon.body), {
        event: "order_tap",
        utm_source: "meta",
        utm_campaign: "xmas",
        utm_content: "video",
      });
    }
  }
});
