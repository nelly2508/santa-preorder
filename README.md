# Santa Says My Name

Pre-order site for a personalised Santa video. Plain HTML, CSS and JavaScript, served by a tiny Node server so Railway can deploy it with no extra config.

## Swap the Stripe and Tally links

The live URLs are in [`public/js/config.js`](public/js/config.js). There are five Payment Links. A sibling is £11.99 per extra child, up to 4 siblings (5 children in one order), and is an optional item on every link. The named sleigh video (£4.99, voice only) is an optional item on the single-video links only, because the Magic bundle already includes it. Rush is not an optional add-on. The page shows those prices and has no separate pay buttons for the extras. The order buttons on the page remember the package and continue to Stripe only after the “before you pay” box is ticked.

### Payment Links

1. `magicBundleEarlyBird` — Magic bundle early bird £16.99. Optional items: Sibling £11.99 per extra child (up to 4 siblings).  
   https://buy.stripe.com/5kQaEYfzNeFI4gq1fD1wY00
2. `magicBundleFullPrice` — Magic bundle £19.99. Optional items: Sibling £11.99 per extra child (up to 4 siblings).  
   https://buy.stripe.com/eVq5kE0ET2X0dR03nL1wY01
3. `singleVideo` — Single video £14.99. Optional items: Sibling £11.99 per extra child (up to 4 siblings), Named sleigh video £4.99 (voice only).  
   https://buy.stripe.com/8x29AUdrFcxA28i6zX1wY02
4. `lateBundle` — Magic bundle £19.99 with rush £4.99 built in (£24.98). Optional items: Sibling £11.99 per extra child (up to 4 siblings).  
   https://buy.stripe.com/4gMaEYevJfJM7sCf6t1wY03
5. `lateSingle` — Single video £14.99 with rush £4.99 built in (£19.98). Optional items: Sibling £11.99 per extra child (up to 4 siblings), Named sleigh video £4.99 (voice only).  
   https://buy.stripe.com/dRmcN6aft69cfZ87E11wY04

Sandbox copies of the two late links, for testing only. Do not put these on the live page:

- late bundle: https://buy.stripe.com/test_dRm8wQ81eaOFeUL03U8og03
- late single: https://buy.stripe.com/test_4gM5kEchu5ul7sjcQG8og04

### After payment

Each Payment Link must redirect to the site, not straight to Tally:

```
https://santasaysmyname.com/order/continue?session_id={CHECKOUT_SESSION_ID}
```

Leave `{CHECKOUT_SESSION_ID}` as written. Stripe fills it in. The server then sends the customer on to the order form. The steps are in [After payment: the redirect](#after-payment-the-redirect) below.

The order form is https://tally.so/r/Dq25LE. The free-video email form is https://tally.so/r/aON07Z (no child details, no `order` field).

The contact email is `trader.email`, set to `hello@santasaysmyname.com` so you can change it in one place. The trader identity, including the postal address, is `trader.identity`. It is shown only on `/privacy` and `/terms`.

## Privacy and terms

- `/privacy` — privacy policy (UK GDPR)
- `/terms` — terms of sale

The footer links to both. A trailing slash works too (`/privacy/`, `/terms/`). Child details used to make a video, and the video files, are deleted about 90 days after delivery. A basic sales record is kept for 6 years for tax.

The page charges £16.99 for the Magic bundle until the end of Sunday 15 November 2026, then switches the bundle buttons to the £19.99 link. The single video stays at £14.99. Set `earlyBird` to `false` to end the £16.99 offer sooner.

From 00:00 Europe/London on Sunday 13 December 2026 the UK is on GMT, so the switch is `2026-12-13T00:00:00Z`. From that moment the Magic bundle buttons use `lateBundle` (£24.98) and the single-video buttons use `lateSingle` (£19.98). Rush delivery is included in those prices. Between 16 November and 12 December the bundle uses the full-price link. A late date wins over early bird.

`lateOrders` controls the switch. `true` forces the late links. `false` keeps the earlier links even after 13 December. `null` follows `lateOrdersFrom`. To preview a date without editing the config, open the page with `?asof=2026-12-13T00:00:00Z` (or any other ISO date). An invalid `asof` is ignored. `lateOrders` set to `true` or `false` still wins over `asof` for whether the late prices are on. `asof` only changes what this page shows. It does not change Stripe.

The only video on the page is the short Hear Santa clip at `public/assets/santa-preview-v3.mp4` (4:5). Santa says the name Saoirse. It is not the full film. The poster is `public/assets/santa-preview-poster-v3.jpg`, also served at `/assets/review-poster-v3.jpg`, and the captions are `public/assets/santa-preview.vtt`. The clip sits under the headline and loads metadata only until it is played. Letter and certificate samples are the Lily images in `public/assets`.

An exit popup on the sales page can play `public/assets/exit-sales-v4.mp4` (also 4:5). It stays closed until a desktop visitor leaves toward the top of the window, or a phone visitor has been on the page for about 25 seconds and flicks upward. It shows at most once every 7 days, waits until the cookie banner is dismissed, and does not load the video until it opens. Open the sales page with `?exitpopup=1` to show it straight away for a test. That test visit does not use up the 7 days.

## After payment: the redirect

`GET /order/continue?session_id={CHECKOUT_SESSION_ID}` runs on the Node server Railway already starts. It looks up that Checkout Session with the Stripe API, counts the children, and shows a short page that sends the customer on to:

```
https://tally.so/r/Dq25LE?order=<session_id>&children=<n>&rush=<0|1>&sleigh=<0|1>&package=<bundle_early_bird|bundle|single>&email=<address>
```

`email` is the address on the Checkout Session (`customer_details.email`), URL-encoded. It is left off when Stripe has no email. `children` is 1 plus the quantity of the Sibling add-on. Each sibling is one extra child at £11.99, up to 4 siblings. A Magic bundle, early bird or full price, counts as including the named sleigh. The single video counts the sleigh only when that add-on was bought. Rush is 1 only when the Checkout Session includes the rush line (`sku` `addon_rush`). The late links include that line, so a late order is `rush=1` with package `bundle` or `single`.

The query string is unchanged. The page exists so that, if this browser has already accepted the Meta cookie and Stripe reports `amount_total` in pounds, the Meta pixel can record a Purchase for that amount in GBP before the browser moves on. If the amount is missing, or the visitor has not accepted, no purchase is sent. The pixel is not loaded until Accept.

If the session is missing, unpaid, or Stripe returns an error, the customer still goes to Tally with only `order` set, and the error is logged. They are never left on a dead page.

The server chooses the key from the session id. `cs_live_…` uses `STRIPE_SECRET_KEY`. `cs_test_…` uses `STRIPE_TEST_SECRET_KEY` when that is set, and otherwise `STRIPE_SECRET_KEY`.

A paid session also sends the order emails below. A mail failure never changes where the customer is sent.

## Order emails

When `/order/continue` has confirmed the Checkout Session is paid, the server sends two messages from the site mailbox. Refreshing the page does not send them again.

- `BREVO_API_KEY`: when set, mail goes through Brevo's HTTPS API (`POST https://api.brevo.com/v3/smtp/email`). Railway Hobby blocks outbound SMTP, so this is the live path. SMTP below is used only when this is unset.
- `STRIPE_WEBHOOK_SECRET`: signing secret for `POST /stripe/webhook` (`checkout.session.completed`). Without it the route answers 503 and `/order/continue` still sends.
- `SMTP_HOST` defaults to `secure244.inmotionhosting.com`
- `SMTP_PORT` defaults to `465` (SSL)
- `SMTP_USER` defaults to `elvesworkshop@santasaysmyname.com`
- `SMTP_PASS` is the mailbox password. Railway already has it. It is never written to the log.
- `ORDER_ALERT_TO` defaults to `neilcarroll2508@gmail.com`

From and Reply-To are `Santa's Elves <elvesworkshop@santasaysmyname.com>` (the address follows `SMTP_USER`).

1. A sale alert to `ORDER_ALERT_TO`, with a copy to the workshop mailbox. The subject looks like `🎄 New Santa order – £19.99 – Magic bundle`. It includes the package, amount, children, rush, sleigh, customer email, Stripe session id, the UK time, and the delivery window.
2. A confirmation to the buyer. The Tally link is built by `tallyOrderUrl`, the same helper as the redirect, so it carries `order`, `children`, `rush`, `sleigh`, `package`, and `email` when Stripe has an address. The message keeps the existing wording and adds a line for anyone who paid and did not submit the form, plus a “Finish your order details” button. The delivery sentence depends on the UK date of the payment:
   - On or before 1 December: videos start going out from 1 December, in batches, and the video is guaranteed by 15 December.
   - From 2 December until the rush fee starts: guaranteed by 15 December.
   - 14–15 December: within 48 hours, so the mail never promises 15 December when that date cannot be kept.
   - From the rush fee onward, through 19 December: within 48 hours. The fee starts at 00:00 UK on 13 December 2026 (`LATE_ORDERS_FROM`, `2026-12-13T00:00:00Z` in `public/js/checkout-choice.js`). The email calls that same check. It does not keep a second copy of the timestamp.

The once-only mark is metadata on the PaymentIntent (`ssm_email_alert` and `ssm_email_buyer`). The route writes it with the Stripe key it already uses. A second visit sees the mark and does not send. If a send fails, the mark is left unset for that message so the next visit can try again. Two overlapping visits share one claim, and the one that does not win the claim does not send.

To preview the emails without a purchase, on a machine that has `SMTP_PASS`:

```bash
npm run email:sample
```

That sends only to `elvesworkshop@santasaysmyname.com`. Subjects start with `[Test]`. To try the real path, pay on a test Payment Link (or a live one) and refund it in Stripe. Open the continue page again and a second pair of emails should not arrive.

## Orders close on 19 December

After 23:59 UK time on Saturday 19 December 2026 the shop stops taking orders, including rush. That instant is `ORDERS_CLOSE_AT` (`2026-12-20T00:00:00Z`) in `public/js/checkout-choice.js`. The order page says Santa's workshop is closed. `GET /order/pay` will not redirect to Stripe. The site does not create Checkout Sessions itself; payment still happens on the existing Payment Links, and this route is what sends a customer there.

### 1. Create the restricted key

In Stripe:

1. Developers
2. API keys
3. Create restricted key
4. Name it something like “Santa order redirect”
5. Set **Checkout Sessions** to **Read**
6. Set **PaymentIntents** to **Read** and **Write**, so a paid order can be marked as emailed
7. Leave every other permission off
8. Create the key and copy the secret (`rk_live_…`)

A restricted key is enough. It does not need to create charges. Checkout Sessions Read is what loads the order. PaymentIntents Write is what stops a second email. If PaymentIntents cannot be written, Checkout Sessions Write is used instead, for the same mark on the session.

For sandbox payments, create the same kind of key in test mode (`rk_test_…`).

### 2. Add the key in Railway

1. Open the Railway project for this site
2. Variables
3. Add `STRIPE_SECRET_KEY` and paste the live restricted key
4. Optional: add `STRIPE_TEST_SECRET_KEY` with the test restricted key
5. Save. Railway restarts the service with the new variables

Never put these keys in the repo or in `public/js/config.js`.

### 3. Point the Payment Links at this route

On each Payment Link, including the two late-order links, set the after-payment redirect to:

```
https://santasaysmyname.com/order/continue?session_id={CHECKOUT_SESSION_ID}
```

Leave the `{CHECKOUT_SESSION_ID}` placeholder exactly like that. Stripe replaces it. Do this for the early-bird Magic bundle, the full-price Magic bundle, the single video, and both late-order links.

### 4. Add the hidden fields in Tally

On https://tally.so/r/Dq25LE, keep the hidden field named `order` and add these hidden fields:

- `children`
- `rush`
- `sleigh`
- `package`
- `email`

Tally fills a hidden field from the query string when the names match. The names are case-sensitive. `children` is how many children the order is for (1 to 5). `rush` and `sleigh` are `1` or `0`. `package` is `bundle_early_bird`, `bundle`, or `single`. `email` is the buyer’s address from Stripe.

A visible Email question is not filled by the URL on its own. Add the hidden field `email`, then on the Email question open the block menu (`⠿`), turn on Default answer, and choose the hidden field `email`. Publish the form. The address then shows in that question, and the buyer can change it before they submit.

### How the products are recognised

Put this metadata on the Stripe objects so live and test mode are unambiguous:

- Each Payment Link: metadata `package` = `bundle_early_bird`, `bundle`, or `single`
- Sibling price or product: metadata `sku` = `addon_sibling`
- Rush price or product: metadata `sku` = `addon_rush`
- Named sleigh price or product: metadata `sku` = `addon_sleigh`

If the metadata is missing, the route also recognises product names that contain “Sibling”, “Rush”, “sleigh”, “early bird”, “bundle”, or “single”, and the base prices £16.99, £19.99 and £14.99.

## Visit counts

Meta's pixel still loads only after Accept. Separately, the server counts openings of the pre-order page and groups them by `utm_source`, `utm_campaign` and `utm_content`. The count is a total for each trio. It does not store an IP address, a cookie, or any other personal data. A value that contains `@`, or characters that are not part of a short campaign name, is left blank rather than saved.

`GET /admin/visits` returns the totals as JSON. Set `VISITS_SECRET` to a long random string and send it as `Authorization: Bearer`, or as the `X-Visits-Secret` header. Do not put the secret in the query string. If `VISITS_SECRET` is unset, the route answers 503. A wrong secret answers 401. The secret is never written to the log.

Counts are kept in memory and, unless you pass `visitsFile: null` in code, written to `data/visit-counts.json`. On Railway set `VISITS_FILE` to a path on a volume if the totals should survive a new deploy. The file holds only the campaign names and the counts.

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
