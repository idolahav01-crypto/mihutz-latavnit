/* מחוץ לתבנית — shared behavior for EN + HE pages */
"use strict";

/* analytics scaffold: dataLayer + named events (signals #61, #62).
   Swap in a GTM container before launch — events already flow. */
window.dataLayer = window.dataLayer || [];
function track(eventName, params) {
  window.dataLayer.push(Object.assign({ event: eventName, lang: document.documentElement.lang }, params || {}));
}
document.querySelectorAll("[data-evt]").forEach(function (el) {
  el.addEventListener("click", function () { track(el.getAttribute("data-evt")); });
});

/* ---------- before / after slider ----------
   The range input is the single source of truth, so keyboard and
   screen-reader users get the identical control. Pointer drag on the
   frame just proxies into it. RTL-aware: the "before" pane always
   reveals from the inline-start edge. */
(function () {
  var frame = document.getElementById("ba-frame");
  var before = document.getElementById("ba-before");
  var divider = document.getElementById("ba-divider");
  var handle = document.getElementById("ba-handle");
  var range = document.getElementById("ba-range");
  if (!frame || !before || !range) return;

  var isRTL = document.documentElement.dir === "rtl";

  function apply(pct) {
    var insetSide = isRTL ? "right" : "left";
    before.style.clipPath = isRTL
      ? "inset(0 0 0 " + (100 - pct) + "%)"
      : "inset(0 " + (100 - pct) + "% 0 0)";
    var linePos = "calc(" + pct + "% - 1px)";
    divider.style[insetSide] = linePos;
    handle.style[insetSide] = linePos;
    handle.style.translate = isRTL ? "50% -50%" : "-50% -50%";
  }

  range.addEventListener("input", function () { apply(Number(range.value)); });

  function pctFromEvent(ev) {
    var rect = frame.getBoundingClientRect();
    var x = (ev.touches ? ev.touches[0].clientX : ev.clientX) - rect.left;
    var pct = (x / rect.width) * 100;
    if (isRTL) pct = 100 - pct;
    return Math.max(0, Math.min(100, pct));
  }

  var dragging = false;
  frame.addEventListener("pointerdown", function (ev) {
    dragging = true;
    frame.setPointerCapture(ev.pointerId);
    range.value = String(Math.round(pctFromEvent(ev)));
    apply(Number(range.value));
    track("ba_slider_drag");
  });
  frame.addEventListener("pointermove", function (ev) {
    if (!dragging) return;
    range.value = String(Math.round(pctFromEvent(ev)));
    apply(Number(range.value));
  });
  ["pointerup", "pointercancel"].forEach(function (t) {
    frame.addEventListener(t, function () { dragging = false; });
  });

  apply(Number(range.value));
})();

/* ---------- GitHub sign-in: no backend yet, so don't let the button 404 silently ---------- */
(function () {
  var btn = document.querySelector(".btn-github");
  if (!btn) return;
  var he = document.documentElement.lang === "he";
  btn.addEventListener("click", function (ev) {
    ev.preventDefault();
    var note = btn.closest(".signin-card").querySelector(".signin-note");
    note.textContent = he
      ? "עדיין בעבודה — ההתחברות עם GitHub תיפתח כאן בקרוב."
      : "Still wiring this up — GitHub sign-in will open here shortly.";
    track("github_signin_stub_click");
  });
})();
