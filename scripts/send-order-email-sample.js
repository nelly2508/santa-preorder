"use strict";

const { sendSampleOrderEmails } = require("../lib/order-email");

sendSampleOrderEmails({ env: process.env }).then(
  (message) => {
    console.log(message);
  },
  (error) => {
    const secret = process.env.SMTP_PASS;
    let text = error && error.message ? error.message : String(error);
    if (secret) text = text.split(secret).join("[redacted]");
    console.error(text);
    process.exit(1);
  }
);
