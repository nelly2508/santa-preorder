/* How the hero turns sound on. Loaded in the browser before main.js,
   and required by the tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.SANTA_HERO_SOUND = api;
})(typeof window === "undefined" ? null : window, function () {
  // A tap on the video or the sound prompt restarts. Any other first
  // gesture only unmutes, so the film keeps its place.
  function unmutePlan(where) {
    const restart = where === "video" || where === "sound";
    return { unmute: true, restart, hidePrompt: true };
  }

  return { unmutePlan };
});
