"use strict";

const crypto = require("crypto");
const { offerPhase, ordersOpen } = require("../public/js/checkout-choice");

const WORKSHOP = "elvesworkshop@santasaysmyname.com";
const DEFAULT_HOST = "secure244.inmotionhosting.com";
const DEFAULT_PORT = 465;
const DEFAULT_ALERT_TO = "neilcarroll2508@gmail.com";
const FROM_NAME = "Santa's Elves";
const CLAIM_TTL_MS = 10 * 60 * 1000;

const MARK = {
  alert: "ssm_email_alert",
  buyer: "ssm_email_buyer",
  claim: "ssm_email_claim",
  claimAt: "ssm_email_claim_at",
};

const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

const flights = new Map();
const stripeClients = new Map();

function cleanAddress(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.length > 254 || !EMAIL.test(raw)) return "";
  return raw;
}

function smtpPort(value) {
  if (value == null || value === "") return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return DEFAULT_PORT;
  return port;
}

function smtpHost(value) {
  const host = String(value || "").trim();
  if (!host || /[\s/\\]/.test(host)) return DEFAULT_HOST;
  return host;
}

function smtpSettings(env) {
  const source = env || {};
  const port = smtpPort(source.SMTP_PORT);
  const user = cleanAddress(source.SMTP_USER) || WORKSHOP;
  const alertTo = cleanAddress(source.ORDER_ALERT_TO) || DEFAULT_ALERT_TO;
  const pass = source.SMTP_PASS == null ? "" : String(source.SMTP_PASS);
  const brevoKey = source.BREVO_API_KEY == null ? "" : String(source.BREVO_API_KEY).trim();
  return {
    host: smtpHost(source.SMTP_HOST),
    port,
    secure: port === 465,
    user,
    pass,
    brevoKey,
    alertTo,
    from: { name: FROM_NAME, address: user },
    replyTo: user,
  };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function oneLine(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim();
}

function londonDate(ms) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const value = (type) => Number(parts.find((part) => part.type === type).value);
  return { year: value("year"), month: value("month"), day: value("day") };
}

function compareLondonDate(date, mark) {
  if (date.year !== mark.year) return date.year < mark.year ? -1 : 1;
  if (date.month !== mark.month) return date.month < mark.month ? -1 : 1;
  if (date.day !== mark.day) return date.day < mark.day ? -1 : 1;
  return 0;
}

// The only delivery-timing sentence. Keyed on the order's UK calendar
// date. The rush window starts when offerPhase says "late", which is the
// same instant the rush fee is included in the price (LATE_ORDERS_FROM).
// Swap the sentences here if the wording changes. The date tests stay.
const DELIVERY_LINES = {
  batches: "We'll start sending videos from 1 December. Pre-orders go out in batches, and your video is guaranteed by 15 December.",
  "by-15-december": "Your video is guaranteed by 15 December.",
  rush: "Your video is guaranteed within 48 hours.",
  tight: "Your video is guaranteed within 48 hours.",
  closed: "Your video is guaranteed within 48 hours.",
};

function deliveryWindow(placedAtMs) {
  const date = londonDate(placedAtMs);
  if (!ordersOpen(placedAtMs)) return "closed";
  if (compareLondonDate(date, { year: 2026, month: 12, day: 1 }) <= 0) return "batches";
  // 14 and 15 December would make "by 15 December" impossible to keep.
  if (date.year === 2026 && date.month === 12 && date.day >= 14 && date.day <= 15) return "tight";
  // Same boundary as the included rush fee. Do not copy that timestamp here.
  if (offerPhase({ now: new Date(placedAtMs) }) === "late") return "rush";
  return "by-15-december";
}

function deliveryLine(placedAtMs) {
  return DELIVERY_LINES[deliveryWindow(placedAtMs)];
}

function packageLabel(packageType) {
  if (packageType === "bundle_early_bird") return "Magic bundle (early bird)";
  if (packageType === "bundle") return "Magic bundle";
  if (packageType === "single") return "Single video";
  return "Santa video";
}

function yesNo(value) {
  if (value === true) return "yes";
  if (value === false) return "no";
  return "unknown";
}

function childrenLabel(value) {
  if (value == null || value === "") return "unknown";
  const count = Number(value);
  if (!Number.isFinite(count)) return "unknown";
  return String(count);
}

function formatMoney(amountTotal, currency) {
  if (amountTotal == null || amountTotal === "") return "unknown";
  const amount = Number(amountTotal);
  if (!Number.isFinite(amount)) return "unknown";
  const major = (amount / 100).toFixed(2);
  const code = String(currency || "gbp").trim().toLowerCase();
  if (code === "gbp") return `£${major}`;
  return `${major} ${code.toUpperCase()}`;
}

function formatUkTime(unixSeconds) {
  const seconds = Number(unixSeconds);
  const date = Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date();
  const formatted = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
  return `${formatted} UK`;
}

function buyerEmail(session) {
  const details = session && session.customer_details;
  if (!details || typeof details.email !== "string") return "";
  return details.email.trim();
}

function placedAtMs(session, now) {
  const seconds = Number(session && session.created);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  return now || Date.now();
}

function orderFacts({ session, sessionId, summary, location, now }) {
  const packageType = summary && summary.packageType ? summary.packageType : "";
  const whenSeconds = session && session.created;
  return {
    sessionId: sessionId || "",
    packageType,
    packageLabel: packageLabel(packageType),
    magicBundle: packageType === "bundle" || packageType === "bundle_early_bird",
    children: summary ? summary.children : null,
    rush: summary ? summary.rush : null,
    sleigh: summary ? summary.sleigh : null,
    email: buyerEmail(session),
    amountLabel: formatMoney(session && session.amount_total, session && session.currency),
    whenLabel: formatUkTime(whenSeconds),
    placedAtMs: placedAtMs(session, now),
    tallyUrl: location || "",
  };
}

function emailShell({ preheader, title, innerHtml }) {
  return `<!DOCTYPE html>
<html lang="en-GB">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:#140e0c;color:#f6efe4;">
  <div style="display:none;max-height:0;overflow:hidden;color:#140e0c;">${escapeHtml(preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#140e0c;">
    <tr>
      <td align="center" style="padding:28px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#241612;border-radius:18px;">
          <tr>
            <td style="padding:32px 28px;font-family:Georgia,'Times New Roman',serif;color:#f6efe4;font-size:18px;line-height:1.5;">
              <p style="margin:0 0 12px;color:#e8b75a;font-family:'Segoe UI',sans-serif;font-size:12px;letter-spacing:0.16em;text-transform:uppercase;">Santa Says My Name</p>
              <h1 style="margin:0 0 20px;font-weight:normal;font-size:28px;line-height:1.25;color:#f6efe4;">${escapeHtml(title)}</h1>
              ${innerHtml}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function paragraph(text, style) {
  return `<p style="margin:0 0 16px;${style || ""}">${escapeHtml(text)}</p>`;
}

function renderCustomerEmail(facts) {
  const delivery = deliveryLine(facts.placedAtMs);
  const subject = "Santa's elves have your order! 🎄";
  const lines = [
    "Hello,",
    "Thank you, your order is in, and Santa's elves are already buzzing! 🎅",
    "What happens next",
    "Your details. If you haven't already, tell us your favourite little ones' names (and how to say them), their age, one lovely thing they did this year and their Christmas wish.",
    facts.tallyUrl,
    `Delivery. ${delivery}`,
    "Ready for that gasp when Santa says their name.",
  ];
  if (facts.magicBundle) {
    lines.push("Your Nice List certificate and letter from Santa come with it 📜.");
  }
    lines.push(
    "Your order",
    `Package: ${facts.packageLabel}`,
    `Children: ${childrenLabel(facts.children)}`,
    `Rush delivery: ${yesNo(facts.rush)}`,
    `Named sleigh: ${yesNo(facts.sleigh)}`,
    `Amount paid: ${facts.amountLabel}`,
    `Order: ${oneLine(facts.sessionId)}`,
    "If anything needs changing, just reply to this email and a human elf will help.",
    "Warmest Christmas wishes,",
    "The Santa Says My Name team",
    "santasaysmyname.com",
    "Made with AI, checked by a human elf."
  );

  const href = escapeHtml(facts.tallyUrl);
  const summary = [
    paragraph(`Package: ${facts.packageLabel}`),
    paragraph(`Children: ${childrenLabel(facts.children)}`),
    paragraph(`Rush delivery: ${yesNo(facts.rush)}`),
    paragraph(`Named sleigh: ${yesNo(facts.sleigh)}`),
    paragraph(`Amount paid: ${facts.amountLabel}`),
    paragraph(`Order: ${oneLine(facts.sessionId)}`),
  ].join("");
  const bundle = facts.magicBundle
    ? paragraph("Your Nice List certificate and letter from Santa come with it 📜.")
    : "";
  const innerHtml = [
    paragraph("Hello,"),
    paragraph("Thank you, your order is in, and Santa's elves are already buzzing! 🎅"),
    `<h2 style="margin:24px 0 12px;font-weight:normal;font-size:22px;color:#e8b75a;">What happens next</h2>`,
    paragraph("Your details. If you haven't already, tell us your favourite little ones' names (and how to say them), their age, one lovely thing they did this year and their Christmas wish."),
    `<p style="margin:0 0 16px;"><a href="${href}" style="display:inline-block;background:#e8b75a;color:#2a1608;text-decoration:none;padding:12px 18px;border-radius:999px;font-family:'Segoe UI',sans-serif;font-size:16px;">Add your child's details</a></p>`,
    `<p style="margin:0 0 16px;font-size:15px;word-break:break-all;"><a href="${href}" style="color:#e8b75a;">${href}</a></p>`,
    paragraph(`Delivery. ${delivery}`),
    paragraph("Ready for that gasp when Santa says their name."),
    bundle,
    `<h2 style="margin:24px 0 12px;font-weight:normal;font-size:22px;color:#e8b75a;">Your order</h2>`,
    summary,
    paragraph("If anything needs changing, just reply to this email and a human elf will help."),
    paragraph("Warmest Christmas wishes,"),
    paragraph("The Santa Says My Name team"),
    `<p style="margin:0 0 16px;"><a href="https://santasaysmyname.com" style="color:#e8b75a;">santasaysmyname.com</a></p>`,
    `<p style="margin:28px 0 0;color:#a87420;font-size:14px;">Made with AI, checked by a human elf.</p>`,
  ].join("");

  return {
    subject,
    text: lines.join("\n\n"),
    html: emailShell({
      preheader: "Your order is in, and Santa's elves are already buzzing.",
      title: "Santa's elves have your order!",
      innerHtml,
    }),
  };
}

function renderSaleAlert(facts) {
  const customer = facts.email ? oneLine(facts.email) : "(none on the payment)";
  const lines = [
    `Package: ${facts.packageLabel}`,
    `Amount: ${facts.amountLabel}`,
    `Children: ${childrenLabel(facts.children)}`,
    `Add-ons: rush ${yesNo(facts.rush)}, sleigh ${yesNo(facts.sleigh)}`,
    `Customer: ${customer}`,
    `Stripe session: ${oneLine(facts.sessionId)}`,
    `Time: ${facts.whenLabel}`,
    `Delivery: ${deliveryLine(facts.placedAtMs)}`,
    `Order form: ${facts.tallyUrl}`,
  ];
  const subject = `🎄 New Santa order – ${facts.amountLabel} – ${facts.packageLabel}`;
  return {
    subject,
    text: lines.join("\n"),
    html: emailShell({
      preheader: subject,
      title: "New Santa order",
      innerHtml: lines.map((line) => paragraph(line)).join(""),
    }),
  };
}

function publicError(error, secret) {
  let message = error && error.message ? String(error.message) : String(error);
  for (const part of String(secret || "").split("\u0000")) {
    if (part) message = message.split(part).join("[redacted]");
  }
  return message.replace(/\s+/g, " ").slice(0, 400);
}

function isPermissionError(error) {
  if (!error) return false;
  const message = String(error.message || "");
  return error.statusCode === 403 || error.code === "more_permissions_required" || /permission/i.test(message);
}

function permissionHint() {
  return "Stripe key cannot mark this order as emailed. On the restricted key, set PaymentIntents to Read and Write. Checkout Sessions Write also works.";
}

function alertDue(metadata) {
  return !metadata || metadata[MARK.alert] !== "1";
}

function buyerDue(metadata) {
  const value = metadata && metadata[MARK.buyer];
  return value !== "1" && value !== "skipped";
}

function claimHeld(metadata, now, ttl) {
  const claim = metadata && metadata[MARK.claim];
  if (!claim) return false;
  const at = Number(metadata[MARK.claimAt]);
  if (!Number.isFinite(at)) return false;
  return now - at < ttl;
}

function paymentIntentId(session) {
  const value = session && session.payment_intent;
  if (typeof value === "string" && value) return value;
  if (value && typeof value === "object" && typeof value.id === "string") return value.id;
  return "";
}

function stringifyPatch(patch) {
  const metadata = {};
  for (const [key, value] of Object.entries(patch || {})) {
    metadata[key] = value == null ? "" : String(value);
  }
  return metadata;
}

function stripeSdk(key) {
  if (!key) throw new Error("missing Stripe secret key");
  if (!stripeClients.has(key)) {
    const Stripe = require("stripe");
    stripeClients.set(key, new Stripe(key));
  }
  return stripeClients.get(key);
}

async function openMarkerStore(session, sessionId, client) {
  const piId = paymentIntentId(session);
  if (piId) {
    try {
      const store = paymentIntentStore(client, piId);
      await store.read();
      return store;
    } catch (error) {
      if (!isPermissionError(error)) throw error;
    }
  }

  const id = (session && session.id) || sessionId;
  if (!id) throw new Error("paid session has no payment intent or session id to mark");
  try {
    const store = checkoutSessionStore(client, id);
    await store.read();
    return store;
  } catch (error) {
    if (isPermissionError(error)) {
      const wrapped = new Error(permissionHint());
      wrapped.cause = error;
      throw wrapped;
    }
    throw error;
  }
}

function markerStore(retrieve, update, kind) {
  return {
    kind,
    async read() {
      const current = await retrieve();
      return { ...(current.metadata || {}) };
    },
    async write(patch) {
      const updated = await update(patch);
      return { ...(updated.metadata || {}) };
    },
  };
}

function paymentIntentStore(client, piId) {
  return markerStore(
    () => client.paymentIntents.retrieve(piId),
    (patch) => client.paymentIntents.update(piId, { metadata: stringifyPatch(patch) }),
    "payment_intent"
  );
}

function checkoutSessionStore(client, id) {
  return markerStore(
    () => client.checkout.sessions.retrieve(id),
    (patch) => client.checkout.sessions.update(id, { metadata: stringifyPatch(patch) }),
    "checkout_session"
  );
}

function singleFlight(map, key, fn) {
  const book = map || flights;
  const existing = book.get(key);
  if (existing) return existing;
  const promise = Promise.resolve().then(fn).finally(() => {
    if (book.get(key) === promise) book.delete(key);
  });
  book.set(key, promise);
  return promise;
}

function secretsOf(settings) {
  return [settings.pass, settings.brevoKey].filter(Boolean).join("\u0000");
}

const BREVO_URL = "https://api.brevo.com/v3/smtp/email";

function brevoRecipients(value) {
  if (value == null || value === "") return undefined;
  const list = Array.isArray(value) ? value : [value];
  const out = list.map((item) => (typeof item === "string" ? { email: item } : { email: item.address, name: item.name }));
  return out.length ? out : undefined;
}

function brevoPayload(message) {
  const from = typeof message.from === "string" ? { address: message.from } : message.from || {};
  const payload = {
    sender: from.name ? { name: from.name, email: from.address } : { email: from.address },
    to: brevoRecipients(message.to),
    subject: message.subject,
    htmlContent: message.html,
    textContent: message.text,
  };
  const cc = brevoRecipients(message.cc);
  if (cc) payload.cc = cc;
  const bcc = brevoRecipients(message.bcc);
  if (bcc) payload.bcc = bcc;
  if (message.replyTo) payload.replyTo = { email: typeof message.replyTo === "string" ? message.replyTo : message.replyTo.address };
  return payload;
}

async function sendBrevo(message, settings, fetchImpl) {
  const doFetch = fetchImpl || globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  if (typeof timer.unref === "function") timer.unref();
  try {
    const response = await doFetch(BREVO_URL, {
      method: "POST",
      headers: { "api-key": settings.brevoKey, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(brevoPayload(message)),
      signal: controller.signal,
    });
    if (!response.ok) {
      let detail = "";
      try {
        detail = (await response.text()).slice(0, 300);
      } catch {}
      throw new Error(`Brevo send failed (${response.status}) ${detail}`.trim());
    }
  } finally {
    clearTimeout(timer);
  }
}

function defaultSender(settings) {
  return settings.brevoKey ? (message, s) => sendBrevo(message, s) : sendSmtp;
}

async function sendSmtp(message, settings) {
  const nodemailer = require("nodemailer");
  const transport = nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    requireTLS: !settings.secure,
    name: "santasaysmyname.com",
    auth: {
      user: settings.user,
      pass: settings.pass,
    },
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 10000,
  });
  try {
    await transport.sendMail(message);
  } finally {
    transport.close();
  }
}

function saleEnvelope(facts, settings) {
  const rendered = renderSaleAlert(facts);
  const message = {
    from: settings.from,
    replyTo: settings.replyTo,
    to: settings.alertTo,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
  };
  if (settings.alertTo.toLowerCase() !== settings.user.toLowerCase()) {
    message.cc = settings.user;
  }
  return message;
}

function buyerEnvelope(facts, settings) {
  const rendered = renderCustomerEmail(facts);
  return {
    from: settings.from,
    replyTo: settings.replyTo,
    to: cleanAddress(facts.email),
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
  };
}

async function releaseClaim(store, claimId) {
  const current = await store.read();
  if (current[MARK.claim] !== claimId) return;
  await store.write({
    [MARK.claim]: "",
    [MARK.claimAt]: "",
  });
}

async function sendOnce(options, settings, log) {
  const sessionId = options.sessionId || "";
  let store;
  try {
    if (typeof options.readMetadata === "function" && typeof options.writeMetadata === "function") {
      store = { read: options.readMetadata, write: options.writeMetadata };
    } else {
      const client = options.stripe || stripeSdk(options.stripeKey);
      store = await openMarkerStore(options.session, sessionId, client);
    }
  } catch (error) {
    log(`order email skipped for ${sessionId}: ${publicError(error, secretsOf(settings))}`);
    return { ok: false, reason: "claim-failed" };
  }

  let metadata;
  try {
    metadata = await store.read();
  } catch (error) {
    log(`order email skipped for ${sessionId}: ${publicError(error, secretsOf(settings))}`);
    return { ok: false, reason: "claim-failed" };
  }

  const pending = { alert: alertDue(metadata), buyer: buyerDue(metadata) };
  if (!pending.alert && !pending.buyer) return { ok: true, reason: "already-sent" };

  const now = options.now || Date.now();
  const ttl = options.claimTtlMs == null ? CLAIM_TTL_MS : options.claimTtlMs;
  if (claimHeld(metadata, now, ttl)) return { ok: false, reason: "claimed" };

  const claimId = options.claimId || `${now.toString(36)}-${crypto.randomBytes(8).toString("hex")}`;
  try {
    await store.write({
      [MARK.claim]: claimId,
      [MARK.claimAt]: String(now),
    });
    metadata = await store.read();
  } catch (error) {
    const detail = isPermissionError(error) ? permissionHint() : publicError(error, secretsOf(settings));
    log(`order email skipped for ${sessionId}: ${detail}`);
    return { ok: false, reason: "claim-failed" };
  }
  if (metadata[MARK.claim] !== claimId) return { ok: false, reason: "lost-race" };

  const facts = orderFacts(options);
  const send = options.sendMail || defaultSender(settings);
  const errors = [];

  async function sendAndMark(message, mark) {
    try {
      await send(message, settings);
    } catch (error) {
      errors.push(error);
      return;
    }
    try {
      await store.write(mark);
    } catch (error) {
      errors.push(error);
    }
  }

  if (pending.alert) await sendAndMark(saleEnvelope(facts, settings), { [MARK.alert]: "1" });
  if (pending.buyer) {
    if (!cleanAddress(facts.email)) {
      try {
        await store.write({ [MARK.buyer]: "skipped" });
      } catch (error) {
        errors.push(error);
      }
    } else {
      await sendAndMark(buyerEnvelope(facts, settings), { [MARK.buyer]: "1" });
    }
  }

  if (errors.length) {
    try {
      await releaseClaim(store, claimId);
    } catch (error) {
      log(`order email claim release failed for ${sessionId}: ${publicError(error, secretsOf(settings))}`);
    }
    log(`order email failed for ${sessionId}: ${errors.map((error) => publicError(error, secretsOf(settings))).join("; ")}`);
    return { ok: false, reason: "send-failed" };
  }

  log(`order email sent for ${sessionId}`);
  return { ok: true, reason: "sent" };
}

async function deliverPaidOrderEmails(options) {
  const source = options || {};
  const settings = smtpSettings(source.env);
  const log = typeof source.log === "function" ? source.log : () => {};
  const sessionId = source.sessionId || "";
  const session = source.session;

  if (!settings.pass && !settings.brevoKey) {
    log(`order email skipped for ${sessionId}: neither BREVO_API_KEY nor SMTP_PASS is set`);
    return { ok: false, reason: "no-password" };
  }
  if (!session || session.payment_status !== "paid") {
    log(`order email skipped for ${sessionId}: session is not paid`);
    return { ok: false, reason: "not-paid" };
  }

  return singleFlight(source.flights, sessionId, () => sendOnce(source, settings, log));
}

function sampleFacts(kind) {
  const kinds = {
    early: { sessionId: "cs_test_manualemail_nov", created: "2026-11-20T15:04:00Z", packageType: "bundle", rush: false, amount: 1699 },
    mid: { sessionId: "cs_test_manualemail_dec", created: "2026-12-10T12:00:00Z", packageType: "bundle", rush: false, amount: 1999 },
    rush: { sessionId: "cs_test_manualemail_rush", created: "2026-12-16T12:00:00Z", packageType: "single", rush: true, amount: 1998 },
  };
  const picked = kinds[kind] || kinds.early;
  return orderFacts({
    sessionId: picked.sessionId,
    location: `https://tally.so/r/Dq25LE?order=${picked.sessionId}&children=2&rush=${picked.rush ? "1" : "0"}&sleigh=1&package=${picked.packageType}&email=elvesworkshop%40santasaysmyname.com`,
    summary: { children: 2, rush: picked.rush, sleigh: true, packageType: picked.packageType },
    session: {
      payment_status: "paid",
      amount_total: picked.amount,
      currency: "gbp",
      created: Date.parse(picked.created) / 1000,
      customer_details: { email: WORKSHOP },
    },
  });
}

function assertWorkshopOnly(message) {
  const recipients = [message.to, message.cc, message.bcc].filter((value) => value != null && value !== "");
  if (recipients.length === 0) throw new Error("Refusing to send a test email with no recipient");
  for (const recipient of recipients) {
    if (String(recipient).toLowerCase() !== WORKSHOP) {
      throw new Error(`Refusing to send a test email to ${recipient}`);
    }
  }
}

function buildSampleMessages() {
  const early = sampleFacts("early");
  const mid = sampleFacts("mid");
  const rush = sampleFacts("rush");
  const banner = "This is a test from the Santa Says My Name server. No customer is waiting.";
  return [renderSaleAlert(rush), renderCustomerEmail(early), renderCustomerEmail(mid), renderCustomerEmail(rush)].map((rendered) => ({
    from: { name: FROM_NAME, address: WORKSHOP },
    replyTo: WORKSHOP,
    to: WORKSHOP,
    subject: `[Test] ${rendered.subject}`,
    text: `${banner}\n\n${rendered.text}`,
    html: rendered.html,
  }));
}

async function sendSampleOrderEmails(options) {
  const source = options || {};
  const settings = smtpSettings(source.env);
  if (!settings.pass && !settings.brevoKey) throw new Error("Neither BREVO_API_KEY nor SMTP_PASS is set. Refusing to send.");
  const send = source.sendMail || defaultSender(settings);
  const messages = buildSampleMessages().map((message) => ({
    ...message,
    from: settings.from,
    replyTo: settings.replyTo,
    to: WORKSHOP,
    cc: undefined,
    bcc: undefined,
  }));
  for (const message of messages) {
    assertWorkshopOnly(message);
    await send(message, settings);
  }
  return `Sent ${messages.length} test emails to ${WORKSHOP} only.`;
}

module.exports = {
  WORKSHOP,
  DEFAULT_ALERT_TO,
  MARK,
  CLAIM_TTL_MS,
  smtpSettings,
  deliveryLine,
  deliveryWindow,
  orderFacts,
  renderCustomerEmail,
  renderSaleAlert,
  deliverPaidOrderEmails,
  buildSampleMessages,
  sendSampleOrderEmails,
  escapeHtml,
  brevoPayload,
  sendBrevo,
};
