/* =============================================================================
   Santa Says My Name — swap these URLs before you take a payment
   -----------------------------------------------------------------------------
   This is the only place the checkout links live.

   Stripe
   1. Create one Stripe Payment Link for each key below, at the price shown.
   2. On every Payment Link, set the after-payment redirect to tallyOrderForm.
      The Tally form collects the child's details. Do not put those fields
      on the Stripe page. Card data stays with Stripe; child details stay
      on Tally, so they can be deleted by 6 January 2027.
   3. Paste the live https://buy.stripe.com/... URLs over the placeholders.

   Early bird
   magicBundleEarlyBird is £16.99 until the end of Sun 15 Nov 2026.
   From 16 Nov the page sends Magic bundle buttons to magicBundleFullPrice
   (£19.99) by itself. Create both links before launch.
   Set earlyBird to false if you want to end the £16.99 offer sooner.

   Tally
   tallyOrderForm  — after payment: first name, how to say it, age, one good
                     deed, one wish, who it's from. No photos, surnames,
                     schools or home addresses.
   tallyFreeVideo  — email only, for the free generic "Santa's on his way"
                     video. No child details.
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
    siblingAddon: "https://buy.stripe.com/placeholder_sibling",
    rushAddon: "https://buy.stripe.com/placeholder_rush",
    namedSleigh: "https://buy.stripe.com/placeholder_named_sleigh",
  },

  tallyOrderForm: "https://tally.so/r/placeholder-child-details",
  tallyFreeVideo: "https://tally.so/r/placeholder-free-video",

  trader: {
    name: "Neil Carroll trading as Santa Says My Name",
    address: "[geographic address]",
    email: "[email]",
  },
};
