/* =============================================================================
   Santa Says My Name — live checkout links
   -----------------------------------------------------------------------------
   Three Stripe Payment Links only. Extras are optional items inside those
   checkouts, not their own links.

   Optional items
   - Sibling £11.99, up to 4: on all three Payment Links.
   - Rush £4.99: on all three Payment Links.
   - Named sleigh video £4.99, voice only: on the single-video link only.
     Both Magic bundles already include the named sleigh clip.

   Payment Links (live)
   1. magicBundleEarlyBird — Magic bundle early bird £16.99
      Optional items: Sibling, Rush.
   2. magicBundleFullPrice — Magic bundle £19.99
      Optional items: Sibling, Rush.
   3. singleVideo — Single video £14.99
      Optional items: Sibling, Rush, Named sleigh video.

   After-payment redirect, already set on each link:
   https://tally.so/r/Dq25LE?order={CHECKOUT_SESSION_ID}
   Stripe replaces {CHECKOUT_SESSION_ID}. The Tally form Dq25LE has a hidden
   field named order. Child details stay on Tally, never on the card page,
   and are deleted by 6 January 2027.

   Early bird
   magicBundleEarlyBird (£16.99) is used until the end of Sun 15 Nov 2026.
   From 16 Nov the page sends Magic bundle buttons to magicBundleFullPrice
   (£19.99). Set earlyBird to false to end the £16.99 offer sooner.

   Tally
   tallyOrderForm  — https://tally.so/r/Dq25LE (hidden field: order).
                     Preview link. The Stripe redirect adds ?order={CHECKOUT_SESSION_ID}.
   tallyFreeVideo  — https://tally.so/r/aON07Z
                     Email only, for the free "Santa's on his way" video.
                     No child details and no order field.
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
    magicBundleEarlyBird: "https://buy.stripe.com/5kQaEYfzNeFI4gq1fD1wY00",
    magicBundleFullPrice: "https://buy.stripe.com/eVq5kE0ET2X0dR03nL1wY01",
    singleVideo: "https://buy.stripe.com/8x29AUdrFcxA28i6zX1wY02",
  },

  tallyAfterPayment: "https://tally.so/r/Dq25LE?order={CHECKOUT_SESSION_ID}",

  tallyOrderForm: "https://tally.so/r/Dq25LE",
  tallyFreeVideo: "https://tally.so/r/aON07Z",

  trader: {
    name: "Neil Carroll trading as Santa Says My Name",
    address: "[geographic address]",
    email: "[email]",
  },
};
