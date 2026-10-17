# Santa Says My Name

Pre-order site for a personalised Father Christmas video. Plain HTML, CSS and JavaScript, served by a tiny Node server so Railway can deploy it with no extra config.

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

Each Payment Link redirects to:

```
https://tally.so/r/Dq25LE?order={CHECKOUT_SESSION_ID}
```

Leave `{CHECKOUT_SESSION_ID}` as written. Stripe fills it in. That string is `tallyAfterPayment` in `config.js`.

The order form is https://tally.so/r/Dq25LE and has a hidden field named `order`. The free-video email form is https://tally.so/r/aON07Z (no child details, no `order` field).

Put your real postal address in `trader.address`. The contact email is `trader.email`, set to `hello@santasaysmyname.com` so you can change it in one place. Both appear in the footer, the short privacy notice, and on `/privacy` and `/terms`.

## Privacy and terms

- `/privacy` — privacy policy (UK GDPR)
- `/terms` — terms of sale

The footer links to both. A trailing slash works too (`/privacy/`, `/terms/`). Child details used to make a video, and the video files, are deleted about 90 days after delivery. A basic sales record is kept for 6 years for tax.

The page charges £16.99 for the Magic bundle until the end of Sunday 15 November 2026, then switches the bundle buttons to the £19.99 link. Set `earlyBird` to `false` to end the offer sooner.

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
