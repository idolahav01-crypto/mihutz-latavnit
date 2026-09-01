/* תשנה — token administration.
   Shared by /admin/ (en) and /he/admin/ (he). Language comes from <html lang>.

   Everything here is a form over two database functions. The check below that
   hides the tool from a non-admin is a courtesy, not a defence: admin_list_wallets
   and admin_set_balance each refuse a caller who is not in public.admins, so a
   browser that skips this file, edits it, or calls the API directly gets an
   exception rather than a write. */
"use strict";

(function () {
  /* ===== config (the same project the dashboard uses) ===== */
  var SUPABASE_URL = "https://iizcvlkktkbftbuvxlvw.supabase.co";
  var SUPABASE_ANON_KEY = "sb_publishable_VaUgqRxTKjYRV05V1TuM_g_F9xrkCQ4";
  var SB_CDN = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

  var he = document.documentElement.lang === "he";
  var HOME = he ? "/he/" : "/";

  var T = he ? {
    hi: "שלום, ",
    loading: "טוען חשבונות...",
    denied: "אין לכם הרשאת ניהול. אם זו טעות, צריך להוסיף אתכם לטבלת admins במסד הנתונים.",
    count: function (n, total) { return n + " מתוך " + total; },
    noMatch: "אין חשבון שתואם לחיפוש.",
    empty: "אין עדיין חשבונות.",
    never: "טרם עודכן",
    balance: "יתרה",
    reason: "סיבה (רשות)",
    reasonHint: "למשל: זיכוי ידני",
    save: "שמירה",
    saving: "שומר...",
    saved: function (before, after) { return "נשמר. " + before + " ← " + after + "."; },
    unchanged: "היתרה כבר במספר הזה — לא נשמר כלום.",
    badNumber: "צריך מספר שלם, אפס או יותר.",
    failed: "השמירה נכשלה. שום דבר לא שונה.",
    loadFailed: "לא הצלחנו לטעון את החשבונות. נסו לרענן.",
    tableLoading: "טוען...",
    tableFailed: "לא הצלחנו לטעון את הנתונים.",
    tableEmpty: "אין עדיין נתונים.",
    cCols: ["מייל", "טוקנים", "הרצות", "הצליחו", "נכשלו", "בניות", "עלות", "אחרונה"],
    rCols: ["מתי", "מייל", "מקור", "סטטוס", "לפני", "אחרי", "שיפור", "עלות"]
  } : {
    hi: "Hi, ",
    loading: "Loading accounts...",
    denied: "You don't have admin rights. If that's wrong, you need adding to the admins table in the database.",
    count: function (n, total) { return n + " of " + total; },
    noMatch: "No account matches that search.",
    empty: "No accounts yet.",
    never: "Never updated",
    balance: "Balance",
    reason: "Reason (optional)",
    reasonHint: "e.g. manual credit",
    save: "Save",
    saving: "Saving...",
    saved: function (before, after) { return "Saved. " + before + " → " + after + "."; },
    unchanged: "The balance is already that number — nothing was saved.",
    badNumber: "Needs a whole number, zero or more.",
    failed: "The save failed. Nothing was changed.",
    loadFailed: "We couldn't load the accounts. Try refreshing.",
    tableLoading: "Loading...",
    tableFailed: "We couldn't load that data.",
    tableEmpty: "Nothing here yet.",
    cCols: ["Email", "Tokens", "Runs", "Done", "Failed", "Builds", "Cost", "Last run"],
    rCols: ["When", "Email", "Source", "Status", "Before", "After", "Gain", "Cost"]
  };

  var $ = function (id) { return document.getElementById(id); };
  var sb = null, user = null, rows = [];

  document.addEventListener("DOMContentLoaded", function () {
    say($("admin-note"), T.loading);
    import(SB_CDN).then(function (mod) {
      sb = mod.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      return sb.auth.getSession();
    }).then(function (res) {
      var session = res.data && res.data.session;
      if (!session) { window.location.replace(HOME); return; }
      user = session.user;
      showUser();
      window.Wallet.load(sb, user);
      return loadWallets();
    }).catch(function () {
      window.location.replace(HOME);
    });
  });

  function showUser() {
    var m = user.user_metadata || {};
    var name = m.full_name || m.name || m.user_name || user.email || "";
    if ($("app-user")) $("app-user").textContent = T.hi + name;
    if ($("signout")) {
      $("signout").addEventListener("click", function () {
        sb.auth.signOut().then(function () { window.location.replace(HOME); });
      });
    }
  }

  /* The listing is the access check. A non-admin gets 42501 back from the
     function itself, which is the same wall a hand-written API call hits. */
  function loadWallets() {
    return sb.rpc("admin_list_wallets").then(function (r) {
      if (r.error) {
        deny(r.error.code === "42501" || /not authorised/i.test(r.error.message || "")
          ? T.denied : T.loadFailed);
        return;
      }
      rows = r.data || [];
      say($("admin-note"), "");
      if ($("admin-tools")) $("admin-tools").hidden = false;
      wireSearch();
      wireTabs();
      render("");
    });
  }

  function deny(msg) {
    say($("admin-note"), msg);
    if ($("admin-note")) $("admin-note").classList.add("is-denied");
    if ($("admin-tools")) $("admin-tools").hidden = true;
    if ($("wallet-list")) $("wallet-list").innerHTML = "";
  }

  /* ===== the three panels =====
     Each one is fetched the first time it is opened and then kept, so moving
     between tabs costs nothing and a stale figure cannot linger unnoticed —
     a reload is the way to refresh, which is what a reader expects of a page
     that is a report. */
  var loaded = {};

  function wireTabs() {
    var tabs = document.querySelectorAll(".admin-tab");
    Array.prototype.forEach.call(tabs, function (tab) {
      tab.addEventListener("click", function () {
        Array.prototype.forEach.call(tabs, function (t) {
          var on = t === tab;
          t.classList.toggle("is-on", on);
          t.setAttribute("aria-selected", on ? "true" : "false");
          var panel = $(t.getAttribute("data-panel"));
          if (panel) panel.hidden = !on;
        });
        var which = tab.getAttribute("data-panel");
        if (which === "panel-customers") fill("customers-table", "admin_customers", null, T.cCols, customerRow);
        if (which === "panel-runs") fill("runs-table", "admin_scan_log", { rows_wanted: 200 }, T.rCols, runRow);
      });
    });
  }

  function fill(tableId, fn, args, cols, toRow) {
    if (loaded[tableId]) return;
    var table = $(tableId);
    if (!table) return;
    table.innerHTML = '<caption class="dtable-note">' + esc(T.tableLoading) + "</caption>";
    sb.rpc(fn, args || {}).then(function (r) {
      if (r.error) {
        table.innerHTML = '<caption class="dtable-note">' + esc(T.tableFailed) + "</caption>";
        return;
      }
      var data = r.data || [];
      if (!data.length) {
        table.innerHTML = '<caption class="dtable-note">' + esc(T.tableEmpty) + "</caption>";
        return;
      }
      loaded[tableId] = true;
      table.innerHTML =
        "<thead><tr>" + cols.map(function (c) { return "<th>" + esc(c) + "</th>"; }).join("") + "</tr></thead>" +
        "<tbody>" + data.map(toRow).join("") + "</tbody>";
    }).catch(function () {
      table.innerHTML = '<caption class="dtable-note">' + esc(T.tableFailed) + "</caption>";
    });
  }

  /* Numbers are data: monospace, tabular, and aligned to the same edge down
     the column so they can be compared without reading each one. */
  function num(v) { return '<td class="n">' + esc(v === null || v === undefined ? "—" : String(v)) + "</td>"; }
  function txt(v) { return "<td>" + esc(v === null || v === undefined ? "—" : String(v)) + "</td>"; }
  function mono(v) { return '<td class="m ltr">' + esc(v === null || v === undefined ? "—" : String(v)) + "</td>"; }

  function customerRow(c) {
    return "<tr>" + mono(c.email) + num(c.tokens) + num(c.runs) + num(c.done) +
      num(c.failed) + num(c.builds) + num(c.cost_usd === null ? null : "$" + c.cost_usd) +
      mono(c.last_run) + "</tr>";
  }

  function runRow(r) {
    /* a failed run has no scores to show, so its reason takes their place */
    var status = r.error ? r.status + " — " + r.error : (r.build_status || r.status);
    return "<tr>" + mono(String(r.ran_at).replace("T", " ").slice(0, 16)) + mono(r.email) +
      "<td class=\"src ltr\">" + esc(r.source || "—") + "</td>" + txt(status) +
      num(r.score_before) + num(r.score_after) +
      num(r.improved_by === null ? null : "-" + r.improved_by) +
      num(r.cost_usd === null ? null : "$" + r.cost_usd) + "</tr>";
  }

  function wireSearch() {
    var box = $("admin-search");
    if (!box) return;
    box.addEventListener("input", function () { render(this.value); });
  }

  function render(filter) {
    var list = $("wallet-list");
    if (!list) return;
    var q = String(filter || "").trim().toLowerCase();
    var shown = q
      ? rows.filter(function (r) { return (r.email || "").toLowerCase().indexOf(q) !== -1; })
      : rows;

    if ($("admin-count")) {
      $("admin-count").textContent = rows.length ? T.count(shown.length, rows.length) : "";
    }

    if (!shown.length) {
      list.innerHTML = "";
      say($("admin-empty"), rows.length ? T.noMatch : T.empty);
      if ($("admin-empty")) $("admin-empty").hidden = false;
      return;
    }
    if ($("admin-empty")) $("admin-empty").hidden = true;

    list.innerHTML = shown.map(function (r) {
      var when = r.updated_at ? String(r.updated_at).slice(0, 10) : T.never;
      return '<li class="wal" data-user="' + esc(r.user_id) + '">' +
        '<span class="wal-who">' +
          '<span class="wal-email ltr">' + esc(r.email || r.user_id) + "</span>" +
          '<span class="wal-meta">' + esc(when) + "</span>" +
        "</span>" +
        '<label class="wal-field">' +
          '<span class="wal-label">' + esc(T.balance) + "</span>" +
          '<input type="number" class="wal-input" inputmode="numeric" min="0" step="1" ' +
            'value="' + esc(String(r.balance)) + '" data-was="' + esc(String(r.balance)) + '" />' +
        "</label>" +
        '<label class="wal-field wal-field-wide">' +
          '<span class="wal-label">' + esc(T.reason) + "</span>" +
          '<input type="text" class="wal-reason" placeholder="' + esc(T.reasonHint) + '" />' +
        "</label>" +
        '<button type="button" class="btn btn-primary btn-sm wal-save">' + esc(T.save) + "</button>" +
        '<span class="wal-status" role="status" aria-live="polite"></span>' +
      "</li>";
    }).join("");

    list.onclick = function (e) {
      var btn = e.target.closest ? e.target.closest(".wal-save") : null;
      if (btn) save(btn.closest(".wal"));
    };
  }

  function save(row) {
    if (!row) return;
    var input = row.querySelector(".wal-input");
    var status = row.querySelector(".wal-status");
    var btn = row.querySelector(".wal-save");
    var before = Number(input.getAttribute("data-was"));
    var next = input.value.trim();

    /* Number("") is 0, which would silently empty somebody's wallet — so a
       blank box is refused before anything is parsed. */
    if (next === "" || !/^\d+$/.test(next)) { fail(status, T.badNumber); return; }
    var value = Number(next);
    if (value === before) { fail(status, T.unchanged); return; }

    btn.disabled = true;
    status.className = "wal-status";
    say(status, T.saving);

    sb.rpc("admin_set_balance", {
      target: row.getAttribute("data-user"),
      new_balance: value,
      reason: row.querySelector(".wal-reason").value
    }).then(function (r) {
      btn.disabled = false;
      if (r.error) { fail(status, T.failed); return; }
      input.setAttribute("data-was", String(value));
      status.className = "wal-status is-ok";
      say(status, T.saved(before, value));
      /* keep the in-memory copy honest, so a re-render after a search does
         not put back the number this page has just replaced */
      var id = row.getAttribute("data-user");
      var hit = rows.filter(function (x) { return x.user_id === id; })[0];
      if (hit) hit.balance = value;
      /* the admin may have just edited their own wallet */
      if (id === user.id) window.Wallet.paint(value);
    }).catch(function () {
      btn.disabled = false;
      fail(status, T.failed);
    });
  }

  function fail(el, msg) {
    if (!el) return;
    el.className = "wal-status is-bad";
    say(el, msg);
  }

  function say(el, msg) { if (el) el.textContent = msg; }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }
})();
