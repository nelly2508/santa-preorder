"use strict";

const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const { brevoPayload, sendBrevo, smtpSettings, escapeHtml } = require("../lib/order-email");
const { tallyOrderUrl } = require("../lib/tally-order-url");
const { createServer } = require("../server");

test("brevo payload keeps sender, recipients, cc and reply-to", () => {
  const payload = brevoPayload({
    from: { name: "Santa's Elves", address: "elvesworkshop@santasaysmyname.com" },
    replyTo: "elvesworkshop@santasaysmyname.com",
    to: "neil@example.com",
    cc: "elvesworkshop@santasaysmyname.com",
    subject: "Hi",
    text: "t",
    html: "<p>h</p>",
  });
  assert.deepStrictEqual(payload.sender, { name: "Santa's Elves", email: "elvesworkshop@santasaysmyname.com" });
  assert.deepStrictEqual(payload.to, [{ email: "neil@example.com" }]);
  assert.deepStrictEqual(payload.cc, [{ email: "elvesworkshop@santasaysmyname.com" }]);
  assert.deepStrictEqual(payload.replyTo, { email: "elvesworkshop@santasaysmyname.com" });
  assert.strictEqual(payload.htmlContent, "<p>h</p>");
});

test("sendBrevo posts with the api key header and throws on errors", async () => {
  const settings = smtpSettings({ BREVO_API_KEY: "k-123" });
  let seen;
  await sendBrevo({ from: settings.from, to: "a@b.co", subject: "s", text: "t", html: "h" }, settings, async (url, init) => {
    seen = { url, init };
    return { ok: true };
  });
  assert.strictEqual(seen.url, "https://api.brevo.com/v3/smtp/email");
  assert.strictEqual(seen.init.headers["api-key"], "k-123");
  await assert.rejects(
    sendBrevo({ from: settings.from, to: "a@b.co" }, settings, async () => ({ ok: false, status: 401, text: async () => "unauthorised" })),
    /Brevo send failed \(401\)/
  );
});

function post(server, path, body, headers) {
  return new Promise((resolve, reject) => {
    server.listen(0, () => {
      const req = http.request({ port: server.address().port, path, method: "POST", headers }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          server.close();
          resolve({ status: res.statusCode, body: data });
        });
      });
      req.on("error", reject);
      req.end(body);
    });
  });
}

test("webhook refuses when STRIPE_WEBHOOK_SECRET is missing", async () => {
  const server = createServer({ env: {}, log: () => {} });
  const res = await post(server, "/stripe/webhook", "{}", {});
  assert.strictEqual(res.status, 503);
});

test("webhook rejects a bad signature", async () => {
  const server = createServer({ env: { STRIPE_WEBHOOK_SECRET: "whsec_x" }, log: () => {} });
  const res = await post(server, "/stripe/webhook", "{}", { "stripe-signature": "nope" });
  assert.strictEqual(res.status, 400);
});

test("webhook sends once for a completed session via the shared guard", async () => {
  const sent = [];
  let metadata = {};
  const session = {
    id: "cs_test_abc123",
    payment_status: "paid",
    amount_total: 2698,
    currency: "gbp",
    created: 1792875165,
    customer_details: { email: "buyer@example.com" },
    line_items: { data: [{ description: "Single Santa Video", quantity: 1, price: { unit_amount: 1499, currency: "gbp" } }] },
  };
  const options = {
    env: { STRIPE_WEBHOOK_SECRET: "whsec_x", BREVO_API_KEY: "k", STRIPE_SECRET_KEY: "sk_test_x" },
    log: () => {},
    constructWebhookEvent: () => ({ type: "checkout.session.completed", data: { object: { id: session.id } } }),
    retrieveSession: async () => session,
    readMetadata: async () => ({ ...metadata }),
    writeMetadata: async (patch) => {
      metadata = { ...metadata, ...patch };
      for (const [k, v] of Object.entries(metadata)) if (v === "") delete metadata[k];
      return { ...metadata };
    },
    sendMail: async (message) => sent.push(message),
  };
  const first = await post(createServer(options), "/stripe/webhook", "{}", { "stripe-signature": "ok" });
  assert.strictEqual(first.status, 200);
  assert.strictEqual(sent.length, 2);
  const tally = tallyOrderUrl(
    "cs_test_abc123",
    { children: 1, rush: false, sleigh: false, packageType: "single" },
    "buyer@example.com"
  );
  const buyer = sent.find((message) => message.to === "buyer@example.com");
  assert.strictEqual(tally, "https://tally.so/r/Dq25LE?order=cs_test_abc123&children=1&rush=0&sleigh=0&package=single&email=buyer%40example.com");
  assert.ok(buyer.text.includes(tally));
  assert.ok(buyer.html.includes(escapeHtml(tally)));
  assert.match(buyer.html, />Finish your order details</);
  assert.match(buyer.text, /If you didn't finish the order form after paying, use this link\./);
  await post(createServer(options), "/stripe/webhook", "{}", { "stripe-signature": "ok" });
  assert.strictEqual(sent.length, 2);
});
