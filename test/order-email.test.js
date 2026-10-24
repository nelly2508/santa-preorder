"use strict";

const assert = require("assert");
const test = require("node:test");
const { createServer } = require("../server");
const { describeOrder } = require("../lib/order-continue");
const { LATE_ORDERS_FROM, offerPhase } = require("../public/js/checkout-choice");
const {
  WORKSHOP,
  MARK,
  smtpSettings,
  deliveryLine,
  deliveryWindow,
  orderFacts,
  renderCustomerEmail,
  renderSaleAlert,
  deliverPaidOrderEmails,
  sendSampleOrderEmails,
  escapeHtml,
} = require("../lib/order-email");

const PASS = "mailbox-secret";

function memoryMetadata(initial) {
  let metadata = { ...(initial || {}) };
  return {
    async readMetadata() {
      return { ...metadata };
    },
    async writeMetadata(patch) {
      const next = { ...metadata };
      for (const [key, value] of Object.entries(patch || {})) {
        if (value == null || value === "") delete next[key];
        else next[key] = String(value);
      }
      metadata = next;
      return { ...metadata };
    },
    snapshot() {
      return { ...metadata };
    },
  };
}

function paidSession(created, extra) {
  return {
    payment_status: "paid",
    amount_total: 1999,
    currency: "gbp",
    created,
    payment_intent: "pi_test_1",
    customer_details: { email: "parent@example.com" },
    ...extra,
  };
}

function deliverOptions(overrides) {
  const store = overrides.store || memoryMetadata();
  return {
    sessionId: overrides.sessionId || "cs_live_mailorder",
    session: overrides.session || paidSession(Date.parse("2026-11-20T15:04:00Z") / 1000),
    summary: overrides.summary || { children: 2, rush: true, sleigh: false, packageType: "bundle" },
    location: overrides.location || "https://tally.so/r/Dq25LE?order=cs_live_mailorder&children=2&rush=1&sleigh=0&package=bundle&email=parent%40example.com",
    env: overrides.env || { SMTP_PASS: PASS },
    log: overrides.log || (() => {}),
    readMetadata: store.readMetadata,
    writeMetadata: store.writeMetadata,
    sendMail: overrides.sendMail || (async () => {}),
    flights: overrides.flights || new Map(),
    now: overrides.now,
    claimId: overrides.claimId,
    claimTtlMs: overrides.claimTtlMs,
    store,
  };
}

test("smtp defaults are the workshop mailbox, and host, port and user can be overridden", () => {
  const defaults = smtpSettings({});
  assert.strictEqual(defaults.host, "secure244.inmotionhosting.com");
  assert.strictEqual(defaults.port, 465);
  assert.strictEqual(defaults.secure, true);
  assert.strictEqual(defaults.user, WORKSHOP);
  assert.deepStrictEqual(defaults.from, { name: "Santa's Elves", address: WORKSHOP });
  assert.strictEqual(defaults.replyTo, WORKSHOP);
  assert.strictEqual(defaults.alertTo, "neilcarroll2508@gmail.com");

  const custom = smtpSettings({
    SMTP_HOST: "mail.example.com",
    SMTP_PORT: "587",
    SMTP_USER: "elf@santasaysmyname.com",
    ORDER_ALERT_TO: "owner@example.com",
    SMTP_PASS: PASS,
  });
  assert.strictEqual(custom.host, "mail.example.com");
  assert.strictEqual(custom.port, 587);
  assert.strictEqual(custom.secure, false);
  assert.strictEqual(custom.user, "elf@santasaysmyname.com");
  assert.strictEqual(custom.alertTo, "owner@example.com");
  assert.strictEqual(smtpSettings({ SMTP_PORT: "nope" }).port, 465);
});

test("delivery wording follows the UK order date and the rush-fee boundary", () => {
  const batch = "We'll start sending videos from 1 December. Pre-orders go out in batches, and your video is guaranteed by 15 December.";
  const byFifteenth = "Your video is guaranteed by 15 December.";
  const within48 = "Your video is guaranteed within 48 hours.";
  const feeStarts = Date.parse(LATE_ORDERS_FROM);

  assert.strictEqual(deliveryLine(Date.parse("2026-11-20T15:04:00Z")), batch);
  assert.strictEqual(deliveryWindow(Date.parse("2026-12-01T23:59:00Z")), "batches");
  assert.strictEqual(deliveryLine(Date.parse("2026-12-01T23:59:00Z")), batch);
  assert.strictEqual(deliveryWindow(Date.parse("2026-12-02T00:00:00Z")), "by-15-december");
  assert.strictEqual(deliveryLine(Date.parse("2026-12-10T12:00:00Z")), byFifteenth);
  assert.doesNotMatch(deliveryLine(Date.parse("2026-12-10T12:00:00Z")), /48 hours|from 1 December/);

  assert.notStrictEqual(offerPhase({ now: feeStarts - 1 }), "late");
  assert.strictEqual(offerPhase({ now: feeStarts }), "late");
  assert.strictEqual(deliveryWindow(feeStarts - 1), "by-15-december");
  assert.strictEqual(deliveryWindow(feeStarts), "rush");
  assert.strictEqual(deliveryLine(feeStarts), within48);
  assert.doesNotMatch(deliveryLine(feeStarts), /by 15 December/);

  assert.strictEqual(deliveryWindow(Date.parse("2026-12-14T12:00:00Z")), "tight");
  assert.strictEqual(deliveryWindow(Date.parse("2026-12-15T22:00:00Z")), "tight");
  assert.strictEqual(deliveryLine(Date.parse("2026-12-15T22:00:00Z")), within48);
  assert.doesNotMatch(deliveryLine(Date.parse("2026-12-15T22:00:00Z")), /by 15 December/);

  assert.strictEqual(deliveryWindow(Date.parse("2026-12-19T23:59:00Z")), "rush");
  assert.strictEqual(deliveryLine(Date.parse("2026-12-19T23:59:00Z")), within48);
  assert.strictEqual(deliveryWindow(Date.parse("2026-12-20T00:00:00Z")), "closed");
  assert.doesNotMatch(deliveryLine(Date.parse("2026-11-20T15:04:00Z")), /recording/i);
  assert.doesNotMatch(deliveryLine(feeStarts), /recording/i);
});

test("the customer email is warm night-and-gold html plus text, with the tally link", () => {
  const location = "https://tally.so/r/Dq25LE?order=cs_live_mailorder&children=2&rush=0&sleigh=1&package=bundle&email=parent%40example.com";
  const facts = orderFacts({
    sessionId: "cs_live_mailorder",
    location,
    summary: { children: 2, rush: false, sleigh: true, packageType: "bundle" },
    session: paidSession(Date.parse("2026-11-20T15:04:00Z") / 1000, { amount_total: 1699 }),
  });
  const message = renderCustomerEmail(facts);
  assert.strictEqual(message.subject, "Santa's elves have your order! 🎄");
  assert.match(message.text, /Hello,/);
  assert.match(message.text, /Thank you, your order is in, and Santa's elves are already buzzing/);
  assert.match(message.text, /What happens next/);
  assert.match(message.text, /favourite little ones' names \(and how to say them\), their age, one lovely thing they did this year and their Christmas wish/);
  assert.ok(message.text.includes(location));
  assert.match(message.text, /We'll start sending videos from 1 December/);
  assert.match(message.text, /Pre-orders go out in batches/);
  assert.match(message.text, /your video is guaranteed by 15 December/);
  assert.match(message.text, /Ready for that gasp when Santa says their name/);
  assert.match(message.text, /Nice List certificate and letter from Santa/);
  assert.match(message.text, /Amount paid: £16\.99/);
  assert.match(message.text, /Children: 2/);
  assert.match(message.text, /Named sleigh: yes/);
  assert.match(message.text, /reply to this email and a human elf will help/);
  assert.match(message.text, /Warmest Christmas wishes/);
  assert.match(message.text, /The Santa Says My Name team/);
  assert.match(message.text, /santasaysmyname\.com/);
  assert.match(message.text, /Made with AI, checked by a human elf/);
  assert.match(message.html, /#140e0c/);
  assert.match(message.html, /#e8b75a/);
  assert.match(message.html, new RegExp(escapeHtml(location).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(`${message.text}\n${message.html}`, /recording/i);
  assert.doesNotMatch(message.text, /within 48 hours/);

  const single = renderCustomerEmail(orderFacts({
    sessionId: "cs_live_single",
    location: "https://tally.so/r/Dq25LE?order=cs_live_single&children=1&rush=0&sleigh=1&package=single",
    summary: { children: 1, rush: false, sleigh: true, packageType: "single" },
    session: paidSession(Date.parse("2026-12-16T12:00:00Z") / 1000, { amount_total: 1998 }),
  }));
  assert.match(single.text, /Your video is guaranteed within 48 hours/);
  assert.doesNotMatch(single.text, /Nice List|certificate|by 15 December/);
  assert.match(single.text, /Amount paid: £19\.98/);
});

test("the sale alert names the package, amount, children, add-ons, email, session and delivery window", () => {
  const facts = orderFacts({
    sessionId: "cs_live_alert1",
    location: "https://tally.so/r/Dq25LE?order=cs_live_alert1&children=1&rush=1&sleigh=1&package=single",
    summary: { children: 1, rush: true, sleigh: true, packageType: "single" },
    session: paidSession(Date.parse("2026-12-16T15:04:00Z") / 1000, {
      amount_total: 2498,
      customer_details: { email: "buyer@example.com" },
    }),
  });
  const alert = renderSaleAlert(facts);
  assert.strictEqual(alert.subject, "🎄 New Santa order – £24.98 – Single video");
  assert.match(alert.text, /Package: Single video/);
  assert.match(alert.text, /Amount: £24\.98/);
  assert.match(alert.text, /Children: 1/);
  assert.match(alert.text, /Add-ons: rush yes, sleigh yes/);
  assert.match(alert.text, /Customer: buyer@example.com/);
  assert.match(alert.text, /Stripe session: cs_live_alert1/);
  assert.match(alert.text, /20 December 2026|16 December 2026/);
  assert.match(alert.text, /15:04/);
  assert.match(alert.text, /UK/);
  assert.match(alert.text, /Your video is guaranteed within 48 hours/);
  assert.match(alert.text, /Order form: https:\/\/tally\.so\/r\/Dq25LE\?order=cs_live_alert1/);

  const early = renderSaleAlert(orderFacts({
    sessionId: "cs_live_early",
    location: "https://tally.so/r/Dq25LE?order=cs_live_early",
    summary: { children: 1, rush: false, sleigh: true, packageType: "bundle_early_bird" },
    session: paidSession(Date.parse("2026-11-02T10:00:00Z") / 1000, { amount_total: 1699 }),
  }));
  assert.strictEqual(early.subject, "🎄 New Santa order – £16.99 – Magic bundle (early bird)");
  assert.match(early.text, /We'll start sending videos from 1 December/);
});

test("each paid order is emailed once, including a refresh and an overlapping visit", async () => {
  const store = memoryMetadata();
  const flights = new Map();
  const sent = [];
  const sendMail = async (message) => {
    sent.push(message.subject);
  };
  const first = deliverOptions({ store, flights, sendMail });
  const again = deliverOptions({ store, flights: new Map(), sendMail, sessionId: first.sessionId });
  const result = await deliverPaidOrderEmails(first);
  assert.strictEqual(result.reason, "sent");
  assert.deepStrictEqual(sent, [
    "🎄 New Santa order – £19.99 – Magic bundle",
    "Santa's elves have your order! 🎄",
  ]);
  assert.strictEqual(store.snapshot()[MARK.alert], "1");
  assert.strictEqual(store.snapshot()[MARK.buyer], "1");

  const second = await deliverPaidOrderEmails(again);
  assert.strictEqual(second.reason, "already-sent");
  assert.strictEqual(sent.length, 2);

  const parallelStore = memoryMetadata();
  const parallelFlights = new Map();
  let parallelSends = 0;
  const parallel = deliverOptions({
    store: parallelStore,
    flights: parallelFlights,
    sessionId: "cs_live_parallel",
    sendMail: async () => {
      parallelSends += 1;
    },
  });
  await Promise.all([
    deliverPaidOrderEmails(parallel),
    deliverPaidOrderEmails({ ...parallel, flights: parallelFlights }),
  ]);
  assert.strictEqual(parallelSends, 2);
});

test("a fresh claim is left alone, a stale claim can be retried, and a lost race does not send", async () => {
  const now = 1_700_000_000_000;
  const held = memoryMetadata({
    [MARK.claim]: "other",
    [MARK.claimAt]: String(now - 60 * 1000),
  });
  let heldSends = 0;
  const heldResult = await deliverPaidOrderEmails(deliverOptions({
    store: held,
    now,
    sendMail: async () => {
      heldSends += 1;
    },
  }));
  assert.strictEqual(heldResult.reason, "claimed");
  assert.strictEqual(heldSends, 0);

  const stale = memoryMetadata({
    [MARK.claim]: "other",
    [MARK.claimAt]: String(now - 11 * 60 * 1000),
  });
  let staleSends = 0;
  const staleResult = await deliverPaidOrderEmails(deliverOptions({
    store: stale,
    now,
    sendMail: async () => {
      staleSends += 1;
    },
  }));
  assert.strictEqual(staleResult.reason, "sent");
  assert.strictEqual(staleSends, 2);

  let metadata = {};
  let lostSends = 0;
  const lost = await deliverPaidOrderEmails(deliverOptions({
    store: {
      async readMetadata() {
        return { ...metadata };
      },
      async writeMetadata(patch) {
        if (patch[MARK.claim]) {
          metadata = { ...metadata, [MARK.claim]: "other-worker", [MARK.claimAt]: String(patch[MARK.claimAt] || "") };
          return { ...metadata };
        }
        metadata = { ...metadata, ...patch };
        return { ...metadata };
      },
    },
    claimId: "mine",
    sendMail: async () => {
      lostSends += 1;
    },
  }));
  assert.strictEqual(lost.reason, "lost-race");
  assert.strictEqual(lostSends, 0);
});

test("a failed send can be retried, and a missing buyer address is not retried", async () => {
  const store = memoryMetadata();
  const logs = [];
  let attempts = 0;
  const failing = await deliverPaidOrderEmails(deliverOptions({
    store,
    sendMail: async () => {
      attempts += 1;
      throw new Error(`535 ${PASS} rejected`);
    },
    log(message) {
      logs.push(message);
    },
  }));
  assert.strictEqual(failing.reason, "send-failed");
  assert.strictEqual(store.snapshot()[MARK.alert], undefined);
  assert.strictEqual(store.snapshot()[MARK.claim], undefined);
  assert.match(logs.join("\n"), /order email failed/);
  assert.ok(!logs.join("\n").includes(PASS));

  const retried = await deliverPaidOrderEmails(deliverOptions({
    store,
    flights: new Map(),
    sendMail: async () => {
      attempts += 1;
    },
    log(message) {
      logs.push(message);
    },
  }));
  assert.strictEqual(retried.reason, "sent");
  assert.ok(attempts >= 3);
  assert.ok(!logs.join("\n").includes(PASS));

  const noBuyer = memoryMetadata();
  const subjects = [];
  await deliverPaidOrderEmails(deliverOptions({
    store: noBuyer,
    session: paidSession(Date.parse("2026-11-20T15:04:00Z") / 1000, { customer_details: { email: "   " } }),
    sendMail: async (message) => {
      subjects.push(message.subject);
    },
  }));
  assert.deepStrictEqual(subjects, ["🎄 New Santa order – £19.99 – Magic bundle"]);
  assert.strictEqual(noBuyer.snapshot()[MARK.buyer], "skipped");
  subjects.length = 0;
  const skipped = await deliverPaidOrderEmails(deliverOptions({
    store: noBuyer,
    flights: new Map(),
    session: paidSession(Date.parse("2026-11-20T15:04:00Z") / 1000, { customer_details: null }),
    sendMail: async (message) => {
      subjects.push(message.subject);
    },
  }));
  assert.strictEqual(skipped.reason, "already-sent");
  assert.deepStrictEqual(subjects, []);
});

test("the alert goes to Neil with a workshop copy, and the buyer gets the confirmation", async () => {
  const messages = [];
  await deliverPaidOrderEmails(deliverOptions({
    sendMail: async (message) => {
      messages.push(message);
    },
  }));
  assert.strictEqual(messages[0].to, "neilcarroll2508@gmail.com");
  assert.strictEqual(messages[0].cc, WORKSHOP);
  assert.deepStrictEqual(messages[0].from, { name: "Santa's Elves", address: WORKSHOP });
  assert.strictEqual(messages[0].replyTo, WORKSHOP);
  assert.strictEqual(messages[1].to, "parent@example.com");
  assert.strictEqual(messages[1].cc, undefined);
  assert.strictEqual(messages[1].replyTo, WORKSHOP);
  assert.ok(!JSON.stringify(messages).includes(PASS));
});

test("a paid order still reaches Tally when the email fails, and an unpaid order sends nothing", async () => {
  const logs = [];
  const store = memoryMetadata();
  const described = await describeOrder({
    sessionId: "cs_live_mailfail",
    env: { STRIPE_SECRET_KEY: "rk_live_secret", SMTP_PASS: PASS },
    log(message) {
      logs.push(message);
    },
    readMetadata: store.readMetadata,
    writeMetadata: store.writeMetadata,
    flights: new Map(),
    retrieveSession() {
      return {
        ...paidSession(Date.parse("2026-11-20T15:04:00Z") / 1000),
        line_items: {
          data: [{
            quantity: 1,
            description: "Magic bundle",
            price: { currency: "gbp", unit_amount: 1999, metadata: { package: "bundle" }, product: { name: "Magic bundle" } },
          }],
        },
      };
    },
    sendMail() {
      throw new Error(`auth failed ${PASS}`);
    },
  });
  assert.strictEqual(
    described.location,
    "https://tally.so/r/Dq25LE?order=cs_live_mailfail&children=1&rush=0&sleigh=1&package=bundle&email=parent%40example.com"
  );
  assert.ok(!logs.join("\n").includes(PASS));

  let called = false;
  const unpaid = await describeOrder({
    sessionId: "cs_live_unpaidmail",
    env: { STRIPE_SECRET_KEY: "rk_live_secret", SMTP_PASS: PASS },
    log() {},
    retrieveSession() {
      return { payment_status: "unpaid" };
    },
    sendMail() {
      called = true;
    },
  });
  assert.strictEqual(unpaid.location, "https://tally.so/r/Dq25LE?order=cs_live_unpaidmail");
  assert.strictEqual(called, false);
});

test("the sample send can only address the workshop mailbox", async () => {
  const messages = [];
  const result = await sendSampleOrderEmails({
    env: { SMTP_PASS: PASS, ORDER_ALERT_TO: "neilcarroll2508@gmail.com" },
    sendMail: async (message) => {
      messages.push(message);
    },
  });
  assert.match(result, /elvesworkshop@santasaysmyname.com only/);
  assert.ok(messages.length >= 3);
  for (const message of messages) {
    assert.strictEqual(message.to, WORKSHOP);
    assert.strictEqual(message.cc, undefined);
    assert.strictEqual(message.bcc, undefined);
    assert.match(message.subject, /^\[Test\] /);
    assert.ok(!JSON.stringify(message).includes("neilcarroll2508@gmail.com"));
    assert.ok(!JSON.stringify(message).includes(PASS));
  }
  const bodies = messages.map((message) => message.text).join("\n");
  assert.match(bodies, /from 1 December/);
  assert.match(bodies, /guaranteed by 15 December/);
  assert.match(bodies, /within 48 hours/);
  await assert.rejects(
    () => sendSampleOrderEmails({ env: {}, sendMail: async () => {} }),
    /SMTP_PASS is set/
  );
});

test("GET /order/continue still shows Tally when sending mail throws", async () => {
  const store = memoryMetadata();
  const server = createServer({
    env: { STRIPE_SECRET_KEY: "rk_live_secret", SMTP_PASS: PASS },
    log() {},
    readMetadata: store.readMetadata,
    writeMetadata: store.writeMetadata,
    flights: new Map(),
    sendMail() {
      throw new Error(`smtp ${PASS}`);
    },
    retrieveSession() {
      return {
        ...paidSession(Date.parse("2026-11-20T15:04:00Z") / 1000, { amount_total: 1499 }),
        line_items: {
          data: [{
            quantity: 1,
            description: "Single video",
            price: { currency: "gbp", unit_amount: 1499, metadata: {}, product: "prod_x" },
          }],
        },
      };
    },
  });
  const port = await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
  try {
    const response = await fetch(`http://127.0.0.1:${port}/order/continue?session_id=cs_live_routemail`, { redirect: "manual" });
    assert.strictEqual(response.status, 200);
    const html = await response.text();
    assert.match(html, /data-continue="https:\/\/tally\.so\/r\/Dq25LE\?order=cs_live_routemail/);
    assert.doesNotMatch(html, /mailbox-secret/);
  } finally {
    server.close();
  }
});
