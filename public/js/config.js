/* =============================================================================
   Santa Says My Name — swap these URLs before you take a payment
   -----------------------------------------------------------------------------
   Three Stripe Payment Links only. Sibling, rush and the named sleigh video
   are optional items on each of those links, ticked inside the one checkout.
   They are not their own Payment Links.

   Products to create in Stripe (one-time prices, GBP)
   1. Magic bundle early bird    £16.99
   2. Magic bundle               £19.99
   3. Single video               £14.99
   4. Sibling                    £11.99   optional item only, not its own link
   5. Rush                       £4.99    optional item only, not its own link
   6. Named sleigh video         £4.99    optional item only, not its own link
      Voice only: Santa from behind, no lip-sync.

   Payment Links to create — paste each live URL into stripe below
   1. magicBundleEarlyBird
      Product 1 (Magic bundle early bird £16.99).
      Optional items: Sibling £11.99, Rush £4.99, Named sleigh video £4.99.
   2. magicBundleFullPrice
      Product 2 (Magic bundle £19.99).
      Same three optional items.
   3. singleVideo
      Product 3 (Single video £14.99).
      Same three optional items.

   After-payment redirect, on every link, exactly:
   https://tally.so/r/<FORM_ID>?order={CHECKOUT_SESSION_ID}
   Stripe replaces {CHECKOUT_SESSION_ID}. Leave that token as written.
   On the Tally form, add a hidden field named order, so each response
   stores the Stripe Checkout session. Child details stay on Tally only,
   never on the card page, and are deleted by 6 January 2027.

   Early bird
   magicBundleEarlyBird is £16.99 until the end of Sun 15 Nov 2026.
   From 16 Nov the page sends Magic bundle buttons to magicBundleFullPrice
   (£19.99). Create both links before launch.
   Set earlyBird to false to end the £16.99 offer sooner.

   Tally
   tallyOrderForm — the form itself, https://tally.so/r/<FORM_ID>, with a
                    hidden field named order. Used as the "preview" link.
                    The Stripe redirect is that URL plus ?order={CHECKOUT_SESSION_ID}.
   tallyFreeVideo — email only, for the free generic "Santa's on his way"
                    video. No child details, no order field.
   ============================================================================= */
window.SANTA_CONFIG = {
  earlyBird: true,
  earlyBirdEnds: "2026-11-15T23:59:59+00:00",

  prices: {
    magicBundleFull: "£19.99",
    magicBundleEarly: "£16.99",
    singleVideo: "£14.99",
    sibling: "£11.99",
    rush: "£4.99",
    namedSleigh: "£4.99",
  },

  stripe: {
    magicBundleEarlyBird: "https://buy.stripe.com/placeholder_magic_bundle_early_bird",
    magicBundleFullPrice: "https://buy.stripe.com/placeholder_magic_bundle",
    singleVideo: "https://buy.stripe.com/placeholder_single_video",
  },

  /* Paste into each Payment Link. Replace <FORM_ID> only. */
  tallyAfterPayment: "https://tally.so/r/<FORM_ID>?order={CHECKOUT_SESSION_ID}",

  tallyOrderForm: "https://tally.so/r/placeholder-child-details",
  tallyFreeVideo: "https://tally.so/r/placeholder-free-video",

  trader: {
    name: "Neil Carroll trading as Santa Says My Name",
    address: "[geographic address]",
    email: "[email]",
  },
};
