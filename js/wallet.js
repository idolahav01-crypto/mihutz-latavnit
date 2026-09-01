/* תשנה — the token wallet.
   Shared by the dashboard and the store so one place decides what a balance
   looks like: the header on one page can never disagree with the header on
   the next. Every element that should carry the number is marked
   data-wallet-n in the HTML, and this file fills all of them at once. */
"use strict";

window.Wallet = (function () {
  /* Read, never written, from the browser: a balance the customer could edit
     is not a balance. No wallet row means nothing has been bought yet, which
     is an honest zero. A failed read means we do not know, and an unknown
     number is a dash — we never print a figure we did not get. */
  function paint(n) {
    var txt = (typeof n === "number" && isFinite(n)) ? String(n) : "\u2014";
    Array.prototype.forEach.call(
      document.querySelectorAll("[data-wallet-n]"),
      function (el) { el.textContent = txt; }
    );
  }

  function load(sb, user) {
    if (!sb || !user || !user.id) return Promise.resolve();
    return sb.from("token_wallets").select("balance").eq("user_id", user.id).maybeSingle()
      .then(function (r) {
        if (!r || r.error) { paint(null); return; }
        paint(r.data ? Number(r.data.balance) || 0 : 0);
      })
      .catch(function () { paint(null); });
  }

  return { paint: paint, load: load };
})();
