# Santa Says My Name

One-page pre-order site for a personalised Santa video. Plain HTML, CSS and JavaScript, served by a tiny Node server so Railway can deploy it with no extra config.

## Swap the Stripe and Tally links

The live URLs are in [`public/js/config.js`](public/js/config.js). There are three Payment Links. Sibling and rush are optional items on all three. The named sleigh video is an optional item on the single-video link only, because both bundles already include it. The page shows those prices and has no separate pay buttons for them.

### Payment Links

1. `magicBundleEarlyBird` — Magic bundle early bird £16.99. Optional items: Sibling £11.99 (up to 4), Rush £4.99.  
   https://buy.stripe.com/5kQaEYfzNeFI4gq1fD1wY00
2. `magicBundleFullPrice` — Magic bundle £19.99. Optional items: Sibling £11.99 (up to 4), Rush £4.99.  
   https://buy.stripe.com/eVq5kE0ET2X0dR03nL1wY01
3. `singleVideo` — Single video £14.99. Optional items: Sibling £11.99 (up to 4), Rush £4.99, Named sleigh video £4.99 (voice only).  
   https://buy.stripe.com/8x29AUdrFcxA28i6zX1wY02

### After payment

Each Payment Link must redirect to the site, not straight to Tally:

```
https://santasaysmyname.com/order/continue?session_id={CHECKOUT_SESSION_ID}
```

Leave `{CHECKOUT_SESSION_ID}` as written. Stripe fills it in. The server then sends the customer on to the order form. The steps are in [After payment: the redirect](#after-payment-the-redirect) below.

The order form is https://tally.so/r/Dq25LE. The free-video email form is https://tally.so/r/aON07Z (no child details, no `order` field).

Put your real postal address and email in `trader`. They appear in the footer and the privacy notice.

The page charges £16.99 for the Magic bundle until the end of Sunday 15 November 2026, then switches the bundle buttons to the £19.99 link. Set `earlyBird` to `false` to end the offer sooner.

Drop the 20-second sample film at `public/assets/sample.mp4` (fictional child, same pipeline as a real order). Until that file is there, the sample section keeps a poster and a video element.

## After payment: the redirect

`GET /order/continue?session_id={CHECKOUT_SESSION_ID}` runs on the Node server Railway already starts. It looks up that Checkout Session with the Stripe API, counts the children, and redirects to:

```
https://tally.so/r/Dq25LE?order=<session_id>&children=<n>&rush=<0|1>&sleigh=<0|1>&package=<bundle_early_bird|bundle|single>
```

`children` is 1 plus the quantity of the Sibling add-on. A Magic bundle, early bird or full price, counts as including the named sleigh. The single video counts the sleigh only when that add-on was bought. Rush is 1 only when the rush add-on was bought.

If the session is missing, unpaid, or Stripe returns an error, the customer still goes to Tally with only `order` set, and the error is logged. They are never left on a dead page.

The server chooses the key from the session id. `cs_live_…` uses `STRIPE_SECRET_KEY`. `cs_test_…` uses `STRIPE_TEST_SECRET_KEY` when that is set, and otherwise `STRIPE_SECRET_KEY`.

### 1. Create the restricted key

In Stripe:

1. Developers
2. API keys
3. Create restricted key
4. Name it something like “Santa order redirect”
5. Set **Checkout Sessions** to **Read**
6. Leave every other permission off
7. Create the key and copy the secret (`rk_live_…`)

A restricted key is enough. The route only retrieves the Checkout Session. Do not use the secret key that can create charges.

For sandbox payments, create the same kind of key in test mode (`rk_test_…`).

### 2. Add the key in Railway

1. Open the Railway project for this site
2. Variables
3. Add `STRIPE_SECRET_KEY` and paste the live restricted key
4. Optional: add `STRIPE_TEST_SECRET_KEY` with the test restricted key
5. Save. Railway restarts the service with the new variables

Never put these keys in the repo or in `public/js/config.js`.

### 3. Point the Payment Links at this route

On each of the three Payment Links, set the after-payment redirect to:

```
https://santasaysmyname.com/order/continue?session_id={CHECKOUT_SESSION_ID}
```

Leave the `{CHECKOUT_SESSION_ID}` placeholder exactly like that. Stripe replaces it. Do this for the early-bird Magic bundle, the full-price Magic bundle, and the single video.

### 4. Add the hidden fields in Tally

On https://tally.so/r/Dq25LE, keep the hidden field named `order` and add four more hidden fields:

- `children`
- `rush`
- `sleigh`
- `package`

Tally fills a hidden field from the query string when the names match. `children` is how many children the order is for (1 to 5). `rush` and `sleigh` are `1` or `0`. `package` is `bundle_early_bird`, `bundle`, or `single`.

### How the products are recognised

Put this metadata on the Stripe objects so live and test mode are unambiguous:

- Each Payment Link: metadata `package` = `bundle_early_bird`, `bundle`, or `single`
- Sibling price or product: metadata `sku` = `addon_sibling`
- Rush price or product: metadata `sku` = `addon_rush`
- Named sleigh price or product: metadata `sku` = `addon_sleigh`

If the metadata is missing, the route also recognises product names that contain “Sibling”, “Rush”, “sleigh”, “early bird”, “bundle”, or “single”, and the base prices £16.99, £19.99 and £14.99.

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
