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

/* ---------- audit form: inline validation (signals #51, #89, #90) ---------- */
(function () {
  var form = document.getElementById("audit-form");
  if (!form) return;
  var status = document.getElementById("form-status");
  var he = document.documentElement.lang === "he";

  var fields = [
    { id: "f-name", valid: function (v) { return v.trim().length >= 2; } },
    { id: "f-email", valid: function (v) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim()); } },
    { id: "f-url", valid: function (v) {
        var s = v.trim();
        if (/^(github\.com|www\.)/i.test(s)) s = "https://" + s;
        try { var u = new URL(s); return u.protocol === "http:" || u.protocol === "https:"; }
        catch (e) { return false; }
      } }
  ];

  function check(f, showError) {
    var input = document.getElementById(f.id);
    var wrap = input.closest(".field");
    var ok = f.valid(input.value);
    if (showError) wrap.classList.toggle("is-invalid", !ok);
    if (ok) wrap.classList.remove("is-invalid");
    input.setAttribute("aria-invalid", ok ? "false" : "true");
    return ok;
  }

  /* validate on blur (immediate feedback), clear on input */
  fields.forEach(function (f) {
    var input = document.getElementById(f.id);
    input.addEventListener("blur", function () { if (input.value !== "") check(f, true); });
    input.addEventListener("input", function () { check(f, false); });
  });

  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var allOk = true;
    var firstBad = null;
    fields.forEach(function (f) {
      var ok = check(f, true);
      if (!ok && !firstBad) firstBad = document.getElementById(f.id);
      allOk = allOk && ok;
    });
    if (!allOk) {
      firstBad.focus();
      track("form_invalid");
      return;
    }

    var name = document.getElementById("f-name").value.trim();
    var email = document.getElementById("f-email").value.trim();
    var url = document.getElementById("f-url").value.trim();
    var note = document.getElementById("f-note").value.trim();

    var subject = he
      ? "בקשת אבחון — " + url
      : "Audit request — " + url;
    var body = (he
      ? "שם: " + name + "\nאימייל: " + email + "\nכתובת האתר: " + url + (note ? "\n\nהערות:\n" + note : "")
      : "Name: " + name + "\nEmail: " + email + "\nSite: " + url + (note ? "\n\nNotes:\n" + note : ""));

    window.location.href = "mailto:idolahav01@gmail.com?subject=" +
      encodeURIComponent(subject) + "&body=" + encodeURIComponent(body);

    status.dataset.state = "ok";
    status.textContent = he
      ? "נפתח חלון אימייל עם הפרטים — נשאר רק ללחוץ שליחה."
      : "An email draft opened with your details — just hit send.";
    track("form_submitted");
  });
})();
