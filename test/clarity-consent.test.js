"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "../public/js/meta-pixel.js"), "utf8");

function boot({ consent, sales, ordering }) {
  const scripts = [];
  const texts = [];
  const created = [];
  const store = {};
  if (consent) store.ssmn_consent = consent;
  const attrs = new Set();
  if (sales) attrs.add("data-sales-page");
  if (ordering) attrs.add("data-order-continue");
  const replaced = [];

  function anchor() {
    return {
      parentNode: {
        insertBefore(node) {
          scripts.push(node);
        },
      },
    };
  }

  const document = {
    readyState: "complete",
    body: {
      hasAttribute(name) {
        return attrs.has(name);
      },
      getAttribute(name) {
        return name === "data-continue" ? "https://tally.example/order" : null;
      },
      classList: { add() {}, remove() {} },
      appendChild() {},
    },
    createElement() {
      const node = {
        type: "",
        className: "",
        textContent: "",
        href: "",
        async: false,
        src: "",
        children: [],
        listeners: {},
        setAttribute() {},
        appendChild(child) {
          this.children.push(child);
          return child;
        },
        addEventListener(type, fn) {
          this.listeners[type] = fn;
        },
        remove() {},
      };
      created.push(node);
      return node;
    },
    createTextNode(text) {
      texts.push(text);
      return { text };
    },
    getElementsByTagName() {
      return [anchor()];
    },
    querySelector(selector) {
      if (selector === ".consent") return null;
      if (typeof selector === "string" && selector.indexOf("fbevents") !== -1) {
        return scripts.find((script) => String(script.src).indexOf("fbevents") !== -1) || null;
      }
      return null;
    },
    addEventListener() {},
  };

  const window = {
    document,
    localStorage: {
      getItem(key) {
        return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
      },
      setItem(key, value) {
        store[key] = value;
      },
    },
    setTimeout(fn) {
      fn();
    },
    location: {
      replace(url) {
        replaced.push(url);
      },
    },
  };
  window.window = window;

  const context = vm.createContext(window);
  vm.runInContext(source, context, { filename: "meta-pixel.js" });
  return { scripts, texts, created, store, window, replaced };
}

function clarityTags(scripts) {
  return scripts.filter((script) => String(script.src).indexOf("https://www.clarity.ms/tag/z5hnjy7wjx") !== -1);
}

function consentCalls(win) {
  if (!win.clarity || !win.clarity.q) return [];
  return Array.from(win.clarity.q).map((args) => Array.from(args));
}

test("Clarity stays unloaded until the pre-order page has Accept", () => {
  const waiting = boot({ sales: true });
  assert.deepStrictEqual(clarityTags(waiting.scripts), []);
  assert.strictEqual(waiting.window.clarity, undefined);
  assert.match(waiting.texts.join(" "), /Microsoft Clarity/);
  assert.match(waiting.texts.join(" "), /stay off unless you accept/);

  const yes = waiting.created.find((node) => node.textContent === "Accept");
  yes.listeners.click();
  yes.listeners.click();
  assert.strictEqual(clarityTags(waiting.scripts).length, 1);
  assert.deepStrictEqual(consentCalls(waiting.window), [["consent"], ["consent"]]);
  assert.strictEqual(waiting.store.ssmn_consent, "yes");

  const declined = boot({ sales: true });
  const no = declined.created.find((node) => node.textContent === "No thanks");
  no.listeners.click();
  assert.deepStrictEqual(clarityTags(declined.scripts), []);
  assert.strictEqual(declined.window.clarity, undefined);
  assert.strictEqual(declined.store.ssmn_consent, "no");
});

test("a remembered yes loads Clarity and sends consent on the pre-order page only", () => {
  const home = boot({ consent: "yes", sales: true });
  assert.strictEqual(clarityTags(home.scripts).length, 1);
  assert.deepStrictEqual(consentCalls(home.window), [["consent"]]);
  assert.ok(home.scripts.some((script) => String(script.src).indexOf("fbevents.js") !== -1));

  const privacy = boot({ consent: "yes", sales: false });
  assert.deepStrictEqual(clarityTags(privacy.scripts), []);
  assert.strictEqual(privacy.window.clarity, undefined);
  assert.ok(privacy.scripts.some((script) => String(script.src).indexOf("fbevents.js") !== -1));

  const paid = boot({ consent: "yes", ordering: true });
  assert.deepStrictEqual(clarityTags(paid.scripts), []);
  assert.strictEqual(paid.window.clarity, undefined);
  assert.deepStrictEqual(paid.replaced, ["https://tally.example/order"]);
});
