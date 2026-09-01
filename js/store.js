/* תשנה — the store: token packages.
   Shared by /store/ (en) and /he/store/ (he). Language comes from <html lang>.
   Behind the same session gate as the dashboard: a price list is personal
   here, because the balance sits on it. */
"use strict";

(function () {
  /* ===== config (the same project the dashboard uses) ===== */
  var SUPABASE_URL = "https://iizcvlkktkbftbuvxlvw.supabase.co";
  var SUPABASE_ANON_KEY = "sb_publishable_VaUgqRxTKjYRV05V1TuM_g_F9xrkCQ4";
  var SB_CDN = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

  var he = document.documentElement.lang === "he";
  var HOME = he ? "/he/" : "/";

  /* Same localhost-only bypass the dashboard carries, so the page can be
     worked on without a session. Dead code on any deployed origin. */
  var DEV_NO_AUTH = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);

  /* ===== the catalogue =====
     The only place a price is written down. The rate per token, the
     discount and the money saved are all derived from these two numbers,
     so a price change can never leave a stale "16%" standing beside it.
     The first package is the base rate every other one is measured against. */
  var PACKAGES = [
    { tokens: 10,  usd: 10 },
    { tokens: 20,  usd: 18 },
    { tokens: 30,  usd: 26 },
    { tokens: 50,  usd: 42, popular: true },
    { tokens: 100, usd: 80 },
    { tokens: 250, usd: 185 }
  ];

  var T = he ? {
    unit: "טוקנים",
    rateSuffix: "לטוקן",
    save: "חיסכון",
    base: "מחיר הבסיס",
    popular: "הכי פופולרי",
    best: "החיסכון הגדול ביותר",
    wasLabel: "במחיר הבסיס",
    buy: "רכישה",
    buyLabel: function (n) { return "רכישת חבילה של " + n + " טוקנים"; },
    payNotLive: "התשלום עדיין לא פעיל באתר, אז שום דבר לא נגבה ולא נשלח.",
    /* the custom quantity */
    customBase: function (rate) {
      return rate + " לטוקן, מחיר הבסיס. ההנחות חלות רק על החבילות שלמעלה.";
    },
    customExact: function (n, pct, price, full) {
      return "זו בדיוק חבילת ה-" + n + ", אז אתם משלמים " + price +
        " במקום " + full + " — חיסכון של " + pct + "%.";
    },
    customBetter: function (more, n, price, full) {
      return "עוד " + more + " טוקנים ותשלמו " + price + " במקום " + full +
        ": חבילת ה-" + n + " נותנת לכם יותר טוקנים בפחות כסף.";
    },
    customBad: "הקלידו מספר שלם, טוקן אחד ומעלה."
  } : {
    unit: "tokens",
    rateSuffix: "per token",
    save: "Save",
    base: "Base price",
    popular: "Most popular",
    best: "Best value",
    wasLabel: "At the base price",
    buy: "Buy",
    buyLabel: function (n) { return "Buy the " + n + " token package"; },
    payNotLive: "Payment isn't live on the site yet, so nothing was charged and nothing was sent.",
    /* the custom quantity */
    customBase: function (rate) {
      return rate + " per token, the base price. The discounts apply only to the packages above.";
    },
    customExact: function (n, pct, price, full) {
      return "That is exactly the " + n + " package, so you pay " + price + " instead of " + full +
        " — a saving of " + pct + "%.";
    },
    customBetter: function (more, n, price, full) {
      return more + " more tokens and you would pay " + price + " instead of " + full +
        ": the " + n + " package gives you more tokens for less money.";
    },
    customBad: "Type a whole number, one token or more."
  };

  var $ = function (id) { return document.getElementById(id); };
  var sb = null, user = null;

  document.addEventListener("DOMContentLoaded", function () {
    renderPackages();
    wire();
    import(SB_CDN).then(function (mod) {
      sb = mod.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      return sb.auth.getSession();
    }).then(function (res) {
      var session = res.data && res.data.session;
      if (!session) {
        if (DEV_NO_AUTH) { user = { email: "dev@localhost" }; showUser(); return; }
        window.location.replace(HOME);
        return;
      }
      user = session.user;
      showUser();
      return window.Wallet.load(sb, user);
    }).catch(function () {
      if (!DEV_NO_AUTH) window.location.replace(HOME);
    });
  });

  function showUser() {
    var m = user.user_metadata || {};
    var name = m.full_name || m.name || m.user_name || user.email || "";
    if ($("app-user")) $("app-user").textContent = (he ? "שלום, " : "Hi, ") + name;
    if ($("signout")) {
      $("signout").addEventListener("click", function () {
        sb.auth.signOut().then(function () { window.location.replace(HOME); });
      });
    }
  }

  /* A package price stays as round as it really is ($42, not $42.00). A rate
     always carries its two decimals, whole or not, so the rate column can be
     read straight down without the decimal point moving. */
  function usdPrice(n) { return "$" + (Math.round(n) === n ? String(n) : n.toFixed(2)); }
  function usdRate(n) { return "$" + n.toFixed(2); }

  function baseRate() { return PACKAGES[0].usd / PACKAGES[0].tokens; }

  function savingOf(p) {
    var full = p.tokens * baseRate();
    return { money: full - p.usd, pct: Math.round((1 - (p.usd / p.tokens) / baseRate()) * 100) };
  }

  function renderPackages() {
    var list = $("pack-list");
    if (!list) return;
    var top = PACKAGES.reduce(function (a, b) {
      return savingOf(b).pct > savingOf(a).pct ? b : a;
    });
    var topPct = savingOf(top).pct || 1;

    list.innerHTML = PACKAGES.map(function (p) {
      var s = savingOf(p);
      /* The recommended package is the page's single primary action; every
         other row is quiet, so the ladder actually recommends something. */
      var cls = "btn btn-" + (p.popular ? "primary" : "quiet") + " pack-buy";
      var value = s.pct > 0
        ? '<span class="pack-save">' + esc(T.save) + " " + s.pct + "% — " +
            '<span class="fig ltr">' + esc(usdPrice(s.money)) + "</span></span>"
        : '<span class="pack-save is-base">' + esc(T.base) + "</span>";

      /* Two markers, and only two: the one the customer is being pointed at,
         and the one that is arithmetically the cheapest token on the page.
         Terracotta stays on the recommendation; the value marker borrows the
         savings green, so the two never compete. */
      var flag = "";
      if (p.popular) flag = '<span class="pack-flag">' + esc(T.popular) + "</span>";
      else if (p === top) flag = '<span class="pack-flag is-quiet">' + esc(T.best) + "</span>";

      return '<li class="pack' + (p.popular ? " is-popular" : "") + '">' + flag +
        '<span class="pack-qty">' +
          '<b class="pack-n">' + p.tokens + "</b>" +
          '<span class="pack-unit">' + esc(T.unit) + "</span>" +
        "</span>" +
        '<span class="pack-value">' +
          '<span class="pack-rate"><span class="fig ltr">' + esc(usdRate(p.usd / p.tokens)) +
            "</span> " + esc(T.rateSuffix) + "</span>" +
          '<span class="pack-bar" aria-hidden="true"><i style="inline-size:' +
            Math.round((s.pct / topPct) * 100) + '%"></i></span>' +
          value +
        "</span>" +
        '<span class="pack-money">' +
          /* What the same tokens cost at the base rate, struck through. It is
             arithmetic, not a fake "was" price: the base rate is the smallest
             package's own rate and it is printed at the top of the page. */
          (s.money > 0
            ? '<s class="pack-was ltr"><span class="vh">' + esc(T.wasLabel) + " </span>" +
                esc(usdPrice(p.tokens * baseRate())) + "</s>"
            : "") +
          '<span class="pack-price ltr">' + esc(usdPrice(p.usd)) + "</span>" +
        "</span>" +
        '<button type="button" class="' + cls + '" data-tokens="' + p.tokens +
          '" aria-label="' + esc(T.buyLabel(p.tokens)) + '">' + esc(T.buy) + "</button>" +
      "</li>";
    }).join("");
  }

  function wire() {
    var list = $("pack-list");
    if (list) {
      list.addEventListener("click", function (e) {
        var btn = e.target.closest ? e.target.closest(".pack-buy") : null;
        if (btn) buy();
      });
    }
    var qty = $("custom-qty");
    if (qty) {
      qty.addEventListener("input", priceCustom);
      priceCustom();
    }
    if ($("custom-buy")) $("custom-buy").addEventListener("click", buy);
  }

  /* ===== a quantity of the customer's own =====
     Any number is sold at the base rate. The packages are the only discount
     on the page, so the only thing this field does with them is refuse to
     overcharge: type a package's exact number and you are quoted its price,
     because charging $50 for 50 tokens on a page that sells 50 for $42 would
     be a trap. And when a package would hand over MORE tokens for LESS money
     than the number typed, the field says so — that comparison is arithmetic
     the customer would otherwise have to do themselves. */
  function packageFor(n) {
    for (var i = 0; i < PACKAGES.length; i++) {
      if (PACKAGES[i].tokens === n) return PACKAGES[i];
    }
    return null;
  }

  /* The package that gives strictly more tokens for no more money. Only ever
     fires in the customer's favour, so it can never read as a push to spend. */
  function betterThan(n, price) {
    var best = null;
    PACKAGES.forEach(function (p) {
      if (p.tokens > n && p.usd <= price && (!best || p.tokens > best.tokens)) best = p;
    });
    return best;
  }

  function priceCustom() {
    var raw = ($("custom-qty").value || "").trim();
    var out = $("custom-price"), note = $("custom-note"), btn = $("custom-buy");

    if (!/^\d+$/.test(raw) || Number(raw) < 1) {
      out.textContent = "—";
      note.textContent = T.customBad;
      note.className = "custom-note is-bad";
      if (btn) btn.disabled = true;
      return;
    }

    var n = Number(raw);
    var full = n * baseRate();
    var pack = packageFor(n);
    var price = pack ? pack.usd : full;

    out.textContent = usdPrice(price);
    if (btn) btn.disabled = false;

    if (pack && pack.usd < full) {
      note.className = "custom-note is-win";
      note.textContent = T.customExact(n, savingOf(pack).pct, usdPrice(pack.usd), usdPrice(full));
      return;
    }
    var better = betterThan(n, full);
    if (better) {
      note.className = "custom-note is-win";
      note.textContent = T.customBetter(better.tokens - n, better.tokens,
                                        usdPrice(better.usd), usdPrice(full));
      return;
    }
    note.className = "custom-note";
    note.textContent = T.customBase(usdRate(baseRate()));
  }

  /* Nothing is charged: no payment provider is connected yet. The page says
     so out loud rather than leaving a dead button, and this is the single
     place a checkout call will go when there is one. */
  function buy() {
    var out = $("store-status");
    if (!out) return;
    out.textContent = T.payNotLive;
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }
})();
