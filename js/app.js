/* מחוץ לתבנית — dashboard: input selection + Stage 1 detection.
   Shared by /app/ (en) and /he/app/ (he). Language comes from <html lang>. */
"use strict";

(function () {
  /* ===== config (same project the landing auth uses) ===== */
  var SUPABASE_URL = "https://iizcvlkktkbftbuvxlvw.supabase.co";
  var SUPABASE_ANON_KEY = "sb_publishable_VaUgqRxTKjYRV05V1TuM_g_F9xrkCQ4";
  var SB_CDN = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
  var JSZIP_CDN = "https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm";

  var MAX_ZIP_BYTES = 5 * 1024 * 1024; /* 5MB */
  var MAX_BUNDLE_BYTES = 300000;
  var MAX_FILE_BYTES = 60000;

  var he = document.documentElement.lang === "he";
  var HOME = he ? "/he/" : "/";

  /* ===== dynamic strings (static UI text lives in the HTML) ===== */
  var T = he ? {
    hi: "שלום, ",
    signout: "התנתקות",
    reading: "קורא קבצים",
    filtering: "מסנן קבצים לא רלוונטיים",
    uploading: "מעלה לניתוח",
    fetching: "מושך את הריפו",
    diagnosing: "מריץ אבחון מול 108 סימנים...",
    zipOnly: "קובץ ‎.zip בלבד.",
    zipTooBig: "הקובץ גדול מ-5MB.",
    zipEmpty: "לא נמצאו קבצים לסריקה בארכיון.",
    urlFormat: "פורמט לא תקין. דוגמה: https://github.com/user/repo",
    urlChecking: "בודק את הריפו...",
    urlOk: "הריפו נמצא וזמין.",
    urlNotFound: "הריפו לא נמצא. בדוק את הכתובת.",
    urlPrivate: "הריפו פרטי — התחבר עם GitHub (טאב 'חיבור GitHub') כדי לגשת אליו.",
    ghNotConnected: "GitHub לא מחובר. עבור לטאב 'חיבור GitHub' כדי לחבר.",
    ghExpired: "החיבור ל-GitHub פג. התחבר מחדש עם GitHub.",
    reposEmpty: "לא נמצאו ריפוזיטוריז בחשבון.",
    noRepoMatch: "אין ריפו שתואם לחיפוש.",
    select: "בחירה",
    scanned: function (n) { return "נסרקו " + n + " קבצים"; },
    foundSignals: function (p, appl) { return "נמצאו " + p + " סימנים מתוך " + appl + " ישימים"; },
    errGeneric: "משהו השתבש. נסה שוב בעוד רגע.",
    errRepoPrivate: "הריפו פרטי או שאין הרשאה. התחבר עם GitHub.",
    errNoFiles: "לא נמצאו קבצים לסריקה.",
    errDetect: "האבחון נכשל. נסה שוב.",
    noApiKey: "מנוע האבחון לא מוגדר — חסר ANTHROPIC_API_KEY ב-Supabase (Edge Functions → Secrets).",
    badApiKey: "מפתח ה-ANTHROPIC_API_KEY לא תקין — כנראה נדבקו איתו רווח או ירידת שורה. הגדירו אותו מחדש."
  } : {
    hi: "Hi, ",
    signout: "Sign out",
    reading: "Reading files",
    filtering: "Filtering out irrelevant files",
    uploading: "Uploading for analysis",
    fetching: "Fetching the repo",
    diagnosing: "Running diagnosis against 108 signals...",
    zipOnly: "Only .zip files.",
    zipTooBig: "File is larger than 5MB.",
    zipEmpty: "No scannable files in the archive.",
    urlFormat: "Invalid format. Example: https://github.com/user/repo",
    urlChecking: "Checking the repo...",
    urlOk: "Repo found and accessible.",
    urlNotFound: "Repo not found. Check the URL.",
    urlPrivate: "Repo is private — connect GitHub (the 'Connect GitHub' tab) to access it.",
    ghNotConnected: "GitHub is not connected. Use the 'Connect GitHub' tab to connect.",
    ghExpired: "GitHub connection expired. Reconnect with GitHub.",
    reposEmpty: "No repositories found on the account.",
    noRepoMatch: "No repo matches your search.",
    select: "Select",
    scanned: function (n) { return "Scanned " + n + " files"; },
    foundSignals: function (p, appl) { return "Found " + p + " signals of " + appl + " applicable"; },
    errGeneric: "Something went wrong. Try again in a moment.",
    errRepoPrivate: "Repo is private or you lack access. Connect GitHub.",
    errNoFiles: "No scannable files found.",
    errDetect: "Diagnosis failed. Try again.",
    noApiKey: "Diagnosis engine not configured — ANTHROPIC_API_KEY is missing in Supabase (Edge Functions → Secrets).",
    badApiKey: "ANTHROPIC_API_KEY is invalid — a space or newline was probably pasted with it. Set it again."
  };

  /* ===== file filtering (mirrors the fetch-repo edge function) ===== */
  var SKIP_DIR = /(^|\/)(node_modules|\.git|dist|build|\.next|\.nuxt|out|vendor|coverage|\.cache|\.vercel|\.turbo)(\/|$)/;
  var SKIP_FILE = /\.(min\.(js|css)|map|lock|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|pdf|zip|gz|br|wasm|ds_store)$/i;
  var LOCKFILES = /(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb)$/i;
  function keepPath(p) { return !SKIP_DIR.test(p) && !LOCKFILES.test(p) && !SKIP_FILE.test(p); }

  /* ===== dom ===== */
  var $ = function (id) { return document.getElementById(id); };
  var els = {};
  var sb = null, user = null, ghConnected = false, busy = false;

  /* ===== boot ===== */
  document.addEventListener("DOMContentLoaded", function () {
    cacheEls();
    wireStatic();
    import(SB_CDN).then(function (mod) {
      sb = mod.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      return sb.auth.getSession();
    }).then(function (res) {
      var session = res.data && res.data.session;
      if (!session) { window.location.replace(HOME); return; }
      user = session.user;
      persistGithubToken(session);
      sb.auth.onAuthStateChange(function (_e, s) { if (s) { user = s.user; persistGithubToken(s); } });
      showUser();
      return refreshGithubStatus();
    }).then(function () {
      if (user) wireTabs();
    }).catch(function () {
      window.location.replace(HOME);
    });
  });

  function cacheEls() {
    ["app-user", "signout", "app-input", "report", "loading", "loading-line",
     "err-banner", "panel-oauth", "panel-zip", "panel-url",
     "dropzone", "zip-input", "zip-chosen", "zip-start",
     "url-input", "url-status", "url-start",
     "gh-connected", "gh-disconnected", "gh-connect", "repo-search", "repo-list",
     "score", "report-caption", "report-body"
    ].forEach(function (id) { els[id] = $(id); });
    els.tabs = Array.prototype.slice.call(document.querySelectorAll(".tab"));
  }

  /* ===== auth helpers ===== */
  function showUser() {
    var m = user.user_metadata || {};
    var name = m.full_name || m.name || m.user_name || user.email || "";
    if (els["app-user"]) els["app-user"].textContent = T.hi + name;
    if (els.signout) {
      els.signout.textContent = T.signout;
      els.signout.addEventListener("click", function () {
        sb.auth.signOut().then(function () { window.location.replace(HOME); });
      });
    }
  }

  /* Save the GitHub OAuth token so edge functions can read repos later. */
  function persistGithubToken(session) {
    if (!session || !session.provider_token) return;
    var identities = (session.user && session.user.identities) || [];
    var isGithub = identities.some(function (i) { return i.provider === "github"; });
    if (!isGithub) return;
    sb.from("github_tokens").upsert({
      user_id: session.user.id,
      provider_token: session.provider_token,
      provider_refresh_token: session.provider_refresh_token || null,
      updated_at: new Date().toISOString()
    }).then(function () { ghConnected = true; });
  }

  function refreshGithubStatus() {
    return sb.from("github_tokens").select("user_id").eq("user_id", user.id).maybeSingle()
      .then(function (r) { ghConnected = !!(r && r.data); });
  }

  function connectGithub() {
    sb.auth.signInWithOAuth({
      provider: "github",
      options: {
        redirectTo: window.location.origin + (he ? "/he/app/" : "/app/"),
        scopes: "read:user repo"
      }
    });
  }

  /* ===== tabs ===== */
  function wireTabs() {
    if (els["gh-connect"]) els["gh-connect"].addEventListener("click", connectGithub);
    els.tabs.forEach(function (tab) {
      tab.addEventListener("click", function () { selectTab(tab.getAttribute("data-tab")); });
    });
    wireZip();
    wireUrl();
    if (els["repo-search"]) {
      els["repo-search"].addEventListener("input", function () { renderRepos(this.value); });
    }
    /* default tab: GitHub if connected, else ZIP */
    selectTab(ghConnected ? "oauth" : "zip");
  }

  function selectTab(name) {
    hideError();
    els.tabs.forEach(function (tab) {
      var on = tab.getAttribute("data-tab") === name;
      tab.setAttribute("aria-selected", on ? "true" : "false");
    });
    els["panel-oauth"].hidden = name !== "oauth";
    els["panel-zip"].hidden = name !== "zip";
    els["panel-url"].hidden = name !== "url";
    if (name === "oauth") loadRepos();
  }

  /* ===== ZIP tab ===== */
  function wireZip() {
    var dz = els.dropzone, input = els["zip-input"];
    dz.addEventListener("click", function () { input.click(); });
    dz.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
    ["dragenter", "dragover"].forEach(function (t) {
      dz.addEventListener(t, function (e) { e.preventDefault(); dz.classList.add("is-drag"); });
    });
    ["dragleave", "drop"].forEach(function (t) {
      dz.addEventListener(t, function (e) { e.preventDefault(); dz.classList.remove("is-drag"); });
    });
    dz.addEventListener("drop", function (e) { if (e.dataTransfer.files[0]) pickZip(e.dataTransfer.files[0]); });
    input.addEventListener("change", function () { if (input.files[0]) pickZip(input.files[0]); });
    els["zip-start"].addEventListener("click", function () { if (zipFile) startZip(); });
  }

  var zipFile = null;
  function pickZip(file) {
    hideError();
    if (!/\.zip$/i.test(file.name)) { showError(T.zipOnly); return; }
    if (file.size > MAX_ZIP_BYTES) { showError(T.zipTooBig); return; }
    zipFile = file;
    els["zip-chosen"].textContent = file.name;
    els["zip-start"].disabled = false;
  }

  function startZip() {
    if (busy) return;
    setBusy(true);
    showLoading(T.reading + "…");
    var scanId = null;
    createScan("zip", zipFile.name).then(function (id) {
      scanId = id;
      return import(JSZIP_CDN);
    }).then(function (mod) {
      var JSZip = mod.default || mod;
      return JSZip.loadAsync(zipFile);
    }).then(function (zip) {
      showLoading(T.filtering + "…");
      var names = Object.keys(zip.files).filter(function (n) {
        var f = zip.files[n];
        return !f.dir && keepPath(n);
      });
      var parts = [], total = 0, count = 0;
      var chain = Promise.resolve();
      names.forEach(function (n) {
        chain = chain.then(function () {
          if (total >= MAX_BUNDLE_BYTES) return;
          return zip.files[n].async("string").then(function (text) {
            if (text.length > MAX_FILE_BYTES) return;
            /* strip a single leading top-level dir (common in exported zips) */
            var rel = n.replace(/^[^/]+\//, "");
            var block = "=== FILE: " + rel + " ===\n" + text + "\n\n";
            total += block.length; count += 1; parts.push(block);
          }).catch(function () {});
        });
      });
      return chain.then(function () {
        if (count === 0) throw new Error("empty");
        showLoading(T.uploading + "…");
        return uploadBundle(scanId, parts.join(""));
      });
    }).then(function () {
      return runDetect(scanId);
    }).catch(function (e) {
      handleFlowError(e, scanId);
    });
  }

  /* ===== URL tab ===== */
  var urlTimer = null, urlValid = null;
  function wireUrl() {
    els["url-input"].addEventListener("input", function () {
      var v = this.value.trim();
      urlValid = null; els["url-start"].disabled = true;
      clearTimeout(urlTimer);
      var m = parseRepo(v);
      if (!v) { setUrlStatus("", ""); return; }
      if (!m) { setUrlStatus(T.urlFormat, "err"); return; }
      setUrlStatus(T.urlChecking, "checking");
      urlTimer = setTimeout(function () { checkRepo(m); }, 550);
    });
    els["url-start"].addEventListener("click", function () { if (urlValid) startUrl(urlValid); });
  }

  function parseRepo(v) {
    var m = v.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
    if (!m) return null;
    return { owner: m[1], repo: m[2] };
  }

  function checkRepo(m) {
    fetch("https://api.github.com/repos/" + m.owner + "/" + m.repo, {
      headers: { Accept: "application/vnd.github+json" }
    }).then(function (r) {
      if (r.status === 404) { setUrlStatus(T.urlNotFound, "err"); return null; }
      return r.json();
    }).then(function (data) {
      if (!data) return;
      if (data.private && !ghConnected) { setUrlStatus(T.urlPrivate, "err"); return; }
      urlValid = { owner: data.owner ? data.owner.login : m.owner, repo: data.name || m.repo, ref: data.default_branch || undefined, full: data.full_name || (m.owner + "/" + m.repo) };
      setUrlStatus(T.urlOk, "ok");
      els["url-start"].disabled = false;
    }).catch(function () { setUrlStatus(T.urlNotFound, "err"); });
  }

  function setUrlStatus(msg, cls) {
    var s = els["url-status"];
    s.textContent = msg;
    s.className = "field-status" + (cls ? " " + cls : "");
  }

  function startUrl(v) {
    if (busy) return;
    setBusy(true);
    showLoading(T.fetching + "…");
    var scanId = null;
    createScan("url", v.full).then(function (id) {
      scanId = id;
      return invokeFn("fetch-repo", { scan_id: id, owner: v.owner, repo: v.repo, ref: v.ref });
    }).then(function () {
      return runDetect(scanId);
    }).catch(function (e) { handleFlowError(e, scanId); });
  }

  /* ===== OAuth (repo list) tab ===== */
  var repos = [];
  function loadRepos() {
    if (!ghConnected) {
      els["gh-connected"].hidden = true;
      els["gh-disconnected"].hidden = false;
      return;
    }
    els["gh-disconnected"].hidden = true;
    els["gh-connected"].hidden = false;
    if (repos.length) return;
    els["repo-list"].innerHTML = '<li class="repo-row"><span class="spin"></span></li>';
    invokeFn("list-repos", {}).then(function (data) {
      repos = (data && data.repos) || [];
      renderRepos("");
    }).catch(function (e) {
      if (e && e.status === 428) { ghConnected = false; loadRepos(); return; }
      els["repo-list"].innerHTML = '<li class="repo-row">' + esc(T.errGeneric) + "</li>";
    });
  }

  function renderRepos(query) {
    var q = (query || "").toLowerCase();
    var list = repos.filter(function (r) { return !q || (r.full_name || "").toLowerCase().indexOf(q) !== -1; });
    if (!repos.length) { els["repo-list"].innerHTML = '<li class="repo-row">' + esc(T.reposEmpty) + "</li>"; return; }
    if (!list.length) { els["repo-list"].innerHTML = '<li class="repo-row">' + esc(T.noRepoMatch) + "</li>"; return; }
    els["repo-list"].innerHTML = list.map(function (r) {
      var sub = [];
      if (r.language) sub.push('<span class="lang-dot">●</span> ' + esc(r.language));
      if (r.updated_at) sub.push(esc(fmtDate(r.updated_at)));
      if (r.private) sub.push(he ? "פרטי" : "private");
      return '<li class="repo-row">' +
        '<span class="repo-meta"><span class="repo-name ltr">' + esc(r.full_name) + "</span>" +
        '<span class="repo-sub ltr">' + sub.join(" · ") + "</span></span>" +
        '<button type="button" class="btn btn-quiet btn-sm" data-repo="' + esc(r.full_name) + '" data-branch="' + esc(r.default_branch || "") + '">' + esc(T.select) + "</button></li>";
    }).join("");
    Array.prototype.forEach.call(els["repo-list"].querySelectorAll("[data-repo]"), function (btn) {
      btn.addEventListener("click", function () {
        var full = btn.getAttribute("data-repo").split("/");
        startGithub({ owner: full[0], repo: full[1], ref: btn.getAttribute("data-branch") || undefined, full: btn.getAttribute("data-repo") });
      });
    });
  }

  function startGithub(v) {
    if (busy) return;
    setBusy(true);
    showLoading(T.fetching + "…");
    var scanId = null;
    createScan("github", v.full).then(function (id) {
      scanId = id;
      return invokeFn("fetch-repo", { scan_id: id, owner: v.owner, repo: v.repo, ref: v.ref });
    }).then(function () {
      return runDetect(scanId);
    }).catch(function (e) { handleFlowError(e, scanId); });
  }

  /* ===== shared flow ===== */
  function createScan(type, ref) {
    return sb.from("scans").insert({ user_id: user.id, source_type: type, source_ref: ref, status: "pending" })
      .select("id").single().then(function (r) {
        if (r.error) throw r.error;
        return r.data.id;
      });
  }

  function uploadBundle(scanId, text) {
    var path = user.id + "/" + scanId + "/bundle.txt";
    return sb.storage.from("scans").upload(path, new Blob([text], { type: "text/plain" }), { upsert: true, contentType: "text/plain" })
      .then(function (r) { if (r.error) throw r.error; });
  }

  function runDetect(scanId) {
    showLoading(T.diagnosing);
    return invokeFn("detect", { scan_id: scanId }).then(function () {
      return loadReport(scanId);
    });
  }

  /* Invoke an edge function and, on failure, surface the server's own
     {error: "..."} payload — supabase-js puts it on error.context (a Response),
     not on res.data, so it has to be read out explicitly. */
  function invokeFn(name, body) {
    return sb.functions.invoke(name, { body: body || {} }).then(function (res) {
      if (!res.error) return res.data;
      var ctx = res.error.context;
      var status = ctx && ctx.status;
      var read = (ctx && typeof ctx.json === "function")
        ? ctx.json().catch(function () { return null; })
        : Promise.resolve(null);
      return read.then(function (payload) {
        var e = new Error("invoke_error");
        e.status = status;
        e.body = payload;
        throw e;
      });
    });
  }

  function loadReport(scanId) {
    return sb.from("scans").select("*").eq("id", scanId).single().then(function (r) {
      if (r.error) throw r.error;
      renderReport(r.data);
    });
  }

  /* ===== report view ===== */
  function renderReport(scan) {
    var det = scan.detection || {};
    var sigs = det.signals || [];
    var present = sigs.filter(function (s) { return s.present && s.applicable !== false; });
    var applicable = sigs.filter(function (s) { return s.applicable !== false; }).length;

    els.score.innerHTML = esc(String(scan.ai_fingerprint_score != null ? scan.ai_fingerprint_score : 0)) + "<small>/100</small>";
    els["report-caption"].textContent =
      T.foundSignals(scan.present_count != null ? scan.present_count : present.length, applicable) +
      " · " + T.scanned(scan.files_scanned != null ? scan.files_scanned : 0);

    /* group present signals by category, preserving id order */
    var groups = [];
    var byCat = {};
    present.sort(function (a, b) { return a.id - b.id; }).forEach(function (s) {
      var cat = catOf(s.id) || "—";
      if (!byCat[cat]) { byCat[cat] = []; groups.push(cat); }
      byCat[cat].push(s);
    });

    els["report-body"].innerHTML = groups.map(function (cat) {
      var rows = byCat[cat].map(function (s) {
        var ev = (s.evidence && s.evidence[0]) || null;
        var code = ev ? '<code>' + esc(clip(ev.snippet, 180)) + "</code>" : "";
        var file = ev ? '<span class="sig-file">' + esc(ev.file) + "</span>" : "";
        var w = s.weight === "very-high" ? "high" : s.weight;
        return '<li><span class="sig-id">#' + s.id + "</span>" +
          '<span class="sig-body"><span class="sig-name">' + esc(s.name) + "</span>" + code + file + "</span>" +
          '<span class="sig-flag w-' + esc(w || "medium") + '">' + esc(String(s.weight || "").toUpperCase()) + "</span></li>";
      }).join("");
      return '<div class="cat-group"><h3>' + esc(cat) + '</h3><ul class="led">' + rows + "</ul></div>";
    }).join("") || ("<p>" + esc(he ? "לא נמצאו סימנים במעבר הזה." : "No signals found in this pass.") + "</p>");

    hideLoading();
    els["app-input"].hidden = true;
    els.report.hidden = false;
    setBusy(false);
    window.scrollTo(0, 0);
  }

  /* ===== error handling ===== */
  function handleFlowError(e, scanId) {
    hideLoading();
    setBusy(false);
    var msg = T.errGeneric;
    var body = e && e.body;
    var reason = body && body.error;
    if (e && e.message === "empty") msg = T.zipEmpty;
    else if (reason === "repo_not_found_or_no_access") msg = T.errRepoPrivate;
    else if (reason === "no_scannable_files") msg = T.errNoFiles;
    else if (reason === "github_not_connected") msg = T.ghNotConnected;
    else if (reason === "github_token_expired") msg = T.ghExpired;
    else if (reason === "missing_anthropic_api_key") msg = T.noApiKey;
    else if (reason === "invalid_anthropic_api_key_characters") msg = T.badApiKey;
    else if (reason && /anthropic|model|bundle/.test(reason)) msg = T.errDetect;
    /* this is a work tool: never hide the concrete reason behind a generic line */
    else if (reason) msg = T.errGeneric + " (" + reason + ")";
    showError(msg);
  }

  function showError(msg) { els["err-banner"].textContent = msg; els["err-banner"].hidden = false; }
  function hideError() { els["err-banner"].hidden = true; }

  /* ===== ui state ===== */
  function setBusy(v) { busy = v; }
  function showLoading(line) {
    hideError();
    els["app-input"].hidden = true;
    els.report.hidden = true;
    els.loading.hidden = false;
    els["loading-line"].textContent = line;
  }
  function hideLoading() { els.loading.hidden = true; els["app-input"].hidden = false; }

  /* ===== small utils ===== */
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }
  function clip(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n) + "…" : s; }
  function fmtDate(iso) { try { return new Date(iso).toISOString().slice(0, 10); } catch (e) { return ""; } }

  function wireStatic() { /* placeholder for future static wiring */ }

  /* category lookup by signal id (16 categories, id ranges) */
  function catOf(id) {
    if (id <= 8) return he ? "טיפוגרפיה ופונטים" : "Typography & fonts";
    if (id <= 18) return he ? "צבע, גרדיאנטים ו-Visual" : "Color, gradients & visual";
    if (id <= 26) return he ? "פריסה ו-UX" : "Layout & UX";
    if (id <= 34) return he ? "SEO ומטא-דאטה" : "SEO & metadata";
    if (id <= 41) return he ? "קוד וביצועים" : "Code & performance";
    if (id <= 46) return he ? "אנימציות ואינטראקציות" : "Animations & interactions";
    if (id <= 54) return he ? "קופי ומיקרו-טקסט" : "Copy & microtext";
    if (id <= 59) return he ? "נגישות" : "Accessibility";
    if (id <= 65) return he ? "אייקונים, אנליטיקס, RTL" : "Icons, analytics, RTL";
    if (id <= 72) return he ? "דפוסי AI מסדר שני" : "Second-order AI clichés";
    if (id <= 83) return he ? "עברית ו-RTL" : "Hebrew & RTL";
    if (id <= 87) return he ? "צבע, מיתוג וניווט ישראלי" : "Israeli color, brand & nav";
    if (id <= 91) return he ? "גריד, ריווח וטפסים" : "Grid, spacing & forms";
    if (id <= 96) return he ? "אמון, רגולציה ונגישות ישראלית" : "Trust, regulation & IL a11y";
    if (id <= 103) return he ? "SEO וביצועים מתקדם" : "Advanced SEO & performance";
    return he ? "אותנטיות תוכן וקוד" : "Content & code authenticity";
  }
})();
