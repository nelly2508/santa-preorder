/* What the hero shows, and what a tap does. Loaded before main.js,
   and required by the tests. Playback itself stays in main.js so the
   first play() call is inside the visitor's tap. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.SANTA_HERO_SOUND = api;
})(typeof window === "undefined" ? null : window, function () {
  function heroView(phase) {
    if (phase === "playing") {
      return {
        poster: false,
        posterText: "Tap to hear Santa",
        posterAria: "Tap to hear Santa",
        toggle: true,
        toggleText: "Pause",
        toggleAria: "Pause the video",
        togglePressed: true,
      };
    }
    if (phase === "paused") {
      return {
        poster: true,
        posterText: "",
        posterAria: "Play the video",
        toggle: true,
        toggleText: "Play",
        toggleAria: "Play the video",
        togglePressed: false,
      };
    }
    if (phase === "ended") {
      return {
        poster: true,
        posterText: "Watch again",
        posterAria: "Watch again",
        toggle: true,
        toggleText: "Play",
        toggleAria: "Watch again",
        togglePressed: false,
      };
    }
    return {
      poster: true,
      posterText: "Tap to hear Santa",
      posterAria: "Tap to hear Santa",
      toggle: false,
      toggleText: "Play",
      toggleAria: "Tap to hear Santa",
      togglePressed: false,
    };
  }

  // Idle and ended start from the beginning, so the name is not missed.
  // A pause in the middle continues from the current time.
  function heroStart(phase) {
    if (phase === "playing") return { restart: false, pause: true };
    if (phase === "paused") return { restart: false, pause: false };
    return { restart: true, pause: false };
  }

  return { heroView, heroStart };
});
