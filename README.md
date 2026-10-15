# Santa Says My Name

One-page pre-order site for a personalised Father Christmas video. Plain HTML, CSS and JavaScript, served by a tiny Node server so Railway can deploy it with no extra config.

## Swap the Stripe and Tally links

All checkout URLs live in one block at the top of [`public/js/config.js`](public/js/config.js). There are three Payment Links. Sibling, rush and the named sleigh video are optional items on each link, chosen inside that one checkout. The page shows their prices and does not have separate pay buttons for them.

### Products to create in Stripe

One-time prices, in pounds:

1. Magic bundle early bird — £16.99
2. Magic bundle — £19.99
3. Single video — £14.99
4. Sibling — £11.99 (optional item only, not its own Payment Link)
5. Rush — £4.99 (optional item only, not its own Payment Link)
6. Named sleigh video — £4.99, voice only (optional item only, not its own Payment Link)

### Payment Links to create

1. `magicBundleEarlyBird` — Magic bundle early bird £16.99, with Sibling, Rush and Named sleigh video as optional items.
2. `magicBundleFullPrice` — Magic bundle £19.99, with the same three optional items.
3. `singleVideo` — Single video £14.99, with the same three optional items.

Paste the live `https://buy.stripe.com/...` URLs over the placeholders in `config.js`.

### After payment

On every Payment Link, set the after-payment redirect to:

```
https://tally.so/r/<FORM_ID>?order={CHECKOUT_SESSION_ID}
```

Replace `<FORM_ID>` with the Tally form id. Leave `{CHECKOUT_SESSION_ID}` as written — Stripe fills it in. That same string is `tallyAfterPayment` in `config.js`.

On the Tally order form, add a hidden field named `order`. Tally then stores the Stripe Checkout session on every response. Do not put a child's details on the Stripe page.

Also set:

- `tallyOrderForm` — `https://tally.so/r/<FORM_ID>` (the preview link; same form, with the hidden `order` field)
- `tallyFreeVideo` — email only, for the free generic sleigh video. No child details and no `order` field.

Put your real postal address and email in `trader`. They appear in the footer and the privacy notice.

The page charges £16.99 for the Magic bundle until the end of Sunday 15 November 2026, then switches the bundle buttons to the £19.99 link. Create both Stripe links before launch. Set `earlyBird` to `false` to end the offer sooner.

Drop the 20-second sample film at `public/assets/sample.mp4` (fictional child, same pipeline as a real order). Until that file is there, the sample section keeps a poster and a video element.

## Run it locally

```bash
npm start
```

The server listens on `PORT` (default 3000). Open `http://localhost:3000`.

## Deploy on Railway

1. New Project
2. Deploy from GitHub repo
3. santa-preorder
4. Generate domain

Railway sees `package.json`, runs `npm start`, and injects `PORT`. No Dockerfile, Procfile or Railway config file is required.
