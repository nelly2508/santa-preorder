/* =============================================================================
   Santa Says My Name — live checkout links
   -----------------------------------------------------------------------------
   Five Stripe Payment Links. Sibling and named sleigh stay as optional items
   inside a checkout. Rush is not an optional add-on.

   Optional items
   - Sibling £11.99 per extra child, up to 4 siblings: on every Payment Link.
   - Named sleigh video £4.99, voice only: on the single-video links only.
     Both Magic bundles already include the named sleigh clip.

   Payment Links (live)
   1. magicBundleEarlyBird — Magic bundle early bird £16.99
      Optional items: Sibling.
   2. magicBundleFullPrice — Magic bundle £19.99
      Optional items: Sibling.
   3. singleVideo — Single video £14.99
      Optional items: Sibling, Named sleigh video.
   4. lateBundle — Magic bundle £19.99 with rush £4.99 included (£24.98)
      Optional items: Sibling. Used from Sun 13 Dec 2026.
   5. lateSingle — Single video £14.99 with rush £4.99 included (£19.98)
      Optional items: Sibling, Named sleigh video. Used from Sun 13 Dec 2026.

   After-payment redirect, set on each Payment Link:
   https://santasaysmyname.com/order/continue?session_id={CHECKOUT_SESSION_ID}
   Stripe replaces {CHECKOUT_SESSION_ID}. The server reads the Checkout
   Session and sends the customer to Tally with order, children, rush, sleigh,
   package, and email when Stripe has one. See the README. Child details stay
   on Tally, never on the card page, and are deleted about 90 days after delivery.

   Early bird
   magicBundleEarlyBird (£16.99) is used until the end of Sun 15 Nov 2026.
   From 16 Nov the Magic bundle buttons use magicBundleFullPrice (£19.99).
   Set earlyBird to false to end the £16.99 offer sooner.

   Late orders
   From 00:00 Europe/London on Sun 13 Dec 2026 the UK is on GMT, so the
   switch is 2026-12-13T00:00:00Z. From that moment Magic bundle buttons use
   lateBundle and single-video buttons use lateSingle. Late wins over early
   bird. lateOrders true forces those links. lateOrders false keeps the
   earlier links. Leave it null to follow lateOrdersFrom.
   A ?asof= date on the page (for example ?asof=2026-12-13T00:00:00Z) pretends
   that moment has arrived, so the switch can be checked. An invalid value is
   ignored. true or false on lateOrders still wins over ?asof=.

   Tally
   tallyOrderForm  — https://tally.so/r/Dq25LE
                     Hidden fields: order, children, rush, sleigh, package, email.
                     Preview link. The paid redirect fills them in.
   tallyFreeVideo  — https://tally.so/r/aON07Z
                     Email only, for the free "Santa's on his way" video.
                     No child details and no order field.
   ============================================================================= */
window.SANTA_CONFIG = {
  earlyBird: true,
  earlyBirdEnds: "2026-11-15T23:59:59+00:00",
  lateOrders: null,
  lateOrdersFrom: "2026-12-13T00:00:00Z",

  prices: {
    magicBundleFull: "£19.99",
    magicBundleEarly: "£16.99",
    magicBundleLate: "£24.98",
    singleVideo: "£14.99",
    singleVideoLate: "£19.98",
    sibling: "£11.99",
    rush: "£4.99",
    namedSleigh: "£4.99",
  },

  stripe: {
    magicBundleEarlyBird: "https://buy.stripe.com/5kQaEYfzNeFI4gq1fD1wY00",
    magicBundleFullPrice: "https://buy.stripe.com/eVq5kE0ET2X0dR03nL1wY01",
    singleVideo: "https://buy.stripe.com/8x29AUdrFcxA28i6zX1wY02",
    lateBundle: "https://buy.stripe.com/4gMaEYevJfJM7sCf6t1wY03",
    lateSingle: "https://buy.stripe.com/dRmcN6aft69cfZ87E11wY04",
  },

  tallyAfterPayment: "https://santasaysmyname.com/order/continue?session_id={CHECKOUT_SESSION_ID}",

  tallyOrderForm: "https://tally.so/r/Dq25LE",
  tallyFreeVideo: "https://tally.so/r/aON07Z",

  // The full identity is shown only on /privacy and /terms.
  // Change the email here and it updates everywhere those pages use it.
  trader: {
    name: "Neil Carroll trading as Santa Says My Name",
    address: "Dunholme, Thornes Road, Wakefield WF2 8QN",
    identity: "Neil Carroll trading as Santa Says My Name, Dunholme, Thornes Road, Wakefield WF2 8QN",
    email: "hello@santasaysmyname.com",
  },
};
