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

/* ---------- auth modal: sign in / sign up with Google or GitHub ----------
   Real auth is powered by Supabase. Every trigger on the page carries
   data-auth-open="signin|signup"; the two provider buttons run the OAuth flow.

   ►► TO GO LIVE: paste your two Supabase values below (see SETUP-AUTH.md).
      Nothing else in this file needs to change. */
(function () {
  var modal = document.getElementById("auth-modal");
  if (!modal || typeof modal.showModal !== "function") return;

  /* ===== CONFIG — paste from Supabase → Project Settings → API ===== */
  var SUPABASE_URL = "https://iizcvlkktkbftbuvxlvw.supabase.co";
  var SUPABASE_ANON_KEY = "sb_publishable_VaUgqRxTKjYRV05V1TuM_g_F9xrkCQ4";
  /* ================================================================= */

  var CDN = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
  var supaReady = !!(SUPABASE_URL && SUPABASE_ANON_KEY);
  var sbClient = null;

  var he = document.documentElement.lang === "he";
  var titleEl = modal.querySelector(".auth-modal-title");
  var subEl = modal.querySelector(".auth-modal-sub");
  var noteEl = modal.querySelector("[data-auth-note]");
  var switchBtn = modal.querySelector("[data-auth-switch]");
  var lastFocus = null;
  var mode = "signin";

  /* load the Supabase client on demand (only when configured) */
  function getClient() {
    if (sbClient) return Promise.resolve(sbClient);
    return import(CDN).then(function (mod) {
      sbClient = mod.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      return sbClient;
    });
  }

  function setMode(m) {
    mode = m === "signup" ? "signup" : "signin";
    titleEl.textContent = modal.getAttribute("data-title-" + mode);
    subEl.textContent = modal.getAttribute("data-sub-" + mode);
    if (switchBtn) switchBtn.textContent = modal.getAttribute("data-switch-" + mode);
    noteEl.textContent = "";
  }

  function open(m) {
    setMode(m);
    lastFocus = document.activeElement;
    modal.showModal();
    var first = modal.querySelector("[data-auth-provider]");
    if (first) first.focus();
    track("auth_modal_open", { mode: mode });
  }

  // native <dialog> gives us ESC + focus trap for free
  modal.addEventListener("close", function () {
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  });
  // click on the backdrop (target is the dialog element itself) closes
  modal.addEventListener("click", function (ev) {
    if (ev.target === modal) modal.close();
  });

  document.querySelectorAll("[data-auth-open]").forEach(function (el) {
    el.addEventListener("click", function (ev) {
      ev.preventDefault();
      open(el.getAttribute("data-auth-open"));
    });
  });
  modal.querySelectorAll("[data-auth-close]").forEach(function (el) {
    el.addEventListener("click", function () { modal.close(); });
  });
  if (switchBtn) {
    switchBtn.addEventListener("click", function () {
      setMode(mode === "signin" ? "signup" : "signin");
    });
  }

  modal.querySelectorAll("[data-auth-provider]").forEach(function (el) {
    el.addEventListener("click", function () {
      var provider = el.getAttribute("data-auth-provider");
      track("auth_provider_click", { provider: provider, mode: mode });
      if (!supaReady) {
        noteEl.textContent = he
          ? "ההתחברות עדיין לא מחוברת. ראו SETUP-AUTH.md כדי לחבר את Google ו‑GitHub."
          : "Sign-in isn't connected yet — see SETUP-AUTH.md to wire up Google and GitHub.";
        return;
      }
      noteEl.textContent = he ? "מעביר להתחברות…" : "Redirecting…";
      getClient().then(function (sb) {
        return sb.auth.signInWithOAuth({
          provider: provider,
          options: {
            // After login, land on the dashboard input screen (per language).
            redirectTo: window.location.origin + (he ? "/he/app/" : "/app/"),
            // GitHub needs repo read to list/pull the user's repositories.
            scopes: provider === "github" ? "read:user repo" : undefined
          }
        });
      }).catch(function () {
        noteEl.textContent = he
          ? "משהו השתבש בהתחברות. נסו שוב בעוד רגע."
          : "Something went wrong starting sign-in. Please try again.";
      });
    });
  });

  /* ---- signed-in state: swap the header buttons for an account chip ---- */
  function applySession(session) {
    var authLi = document.querySelector(".nav-auth");
    if (!authLi || !session || !session.user) return;
    var u = session.user;
    var meta = u.user_metadata || {};
    var name = meta.full_name || meta.name || meta.user_name || u.email || "Account";

    authLi.innerHTML = "";
    var who = document.createElement("span");
    who.className = "nav-user";
    who.textContent = (he ? "שלום, " : "Hi, ") + name;
    var dash = document.createElement("a");
    dash.className = "btn btn-primary btn-sm";
    dash.href = he ? "/he/app/" : "/app/";
    dash.textContent = he ? "לאבחונים שלי" : "My audits";
    var out = document.createElement("button");
    out.type = "button";
    out.className = "btn btn-quiet btn-sm";
    out.textContent = he ? "התנתקות" : "Sign out";
    out.addEventListener("click", function () {
      getClient().then(function (sb) { return sb.auth.signOut(); })
        .then(function () { window.location.reload(); });
    });
    authLi.appendChild(who);
    authLi.appendChild(dash);
    authLi.appendChild(out);
    if (modal.open) modal.close();
  }

  if (supaReady) {
    getClient().then(function (sb) {
      sb.auth.getSession().then(function (res) { applySession(res.data.session); });
      sb.auth.onAuthStateChange(function (_evt, session) { applySession(session); });
    }).catch(function () { /* CDN blocked or offline — buttons still show the note */ });
  }
})();
