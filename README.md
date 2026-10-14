# Santa Says My Name

One-page pre-order site for a personalised Father Christmas video. Plain HTML, CSS and JavaScript, served by a tiny Node server so Railway can deploy it with no extra config.

## Swap the Stripe and Tally links

All checkout URLs live in one block at the top of [`public/js/config.js`](public/js/config.js).

1. In Stripe, create a Payment Link for each product:
   - Magic bundle early bird — £16.99 (`magicBundleEarlyBird`)
   - Magic bundle — £19.99 (`magicBundleFullPrice`)
   - Single video — £14.99 (`singleVideo`)
   - Sibling add-on — £11.99 (`siblingAddon`)
   - Rush — £4.99 (`rushAddon`)
   - Named sleigh video — £4.99, voice only (`namedSleigh`)
2. On **every** Payment Link, set the after-payment redirect to the Tally order form (`tallyOrderForm`). That form collects the child's details. Do not add those fields to Stripe.
3. Paste the live `https://buy.stripe.com/...` URLs over the placeholders in `config.js`.
4. Paste the Tally URLs too:
   - `tallyOrderForm` — after payment (first name, pronunciation, age, good deed, wish, who it's from)
   - `tallyFreeVideo` — email only, for the free generic sleigh video
5. Put your real postal address and email in `trader`. They appear in the footer and the privacy notice.

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
