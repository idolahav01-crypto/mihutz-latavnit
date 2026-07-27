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
  var HISTORY_PREVIEW = 3; /* rows shown inline; the rest live in the sheet */

  var he = document.documentElement.lang === "he";
  var HOME = he ? "/he/" : "/";

  /* ===== dynamic strings (static UI text lives in the HTML) ===== */
  var T = he ? {
    hi: "שלום, ",
    signout: "התנתקות",
    zipTooBig: "הקובץ גדול מ-5MB.",
    zipEmpty: "לא נמצאו קבצים לסריקה.",
    urlFormat: "פורמט לא תקין. דוגמה: https://github.com/user/repo",
    urlChecking: "בודק את הריפו...",
    urlOk: "הריפו נמצא וזמין.",
    urlNotFound: "הריפו לא נמצא. בדוק את הכתובת.",
    urlPrivate: "הריפו פרטי — חברו את GitHub כדי לגשת אליו.",
    ghNotConnected: "GitHub לא מחובר. השתמשו בשורת GitHub כדי לחבר.",
    ghExpired: "החיבור ל-GitHub פג. התחבר מחדש עם GitHub.",
    ghConnectedLabel: "הריפוזיטוריז שלכם ב-GitHub",
    ghDisconnectedLabel: "לסריקת ריפו פרטי — חברו את GitHub",
    reposEmpty: "לא נמצאו ריפוזיטוריז בחשבון.",
    noRepoMatch: "אין ריפו שתואם לחיפוש.",
    reposLoading: "טוען ריפוזיטוריז...",
    allAudits: function (n) { return "כל האבחונים (" + n + ")"; },
    filesPicked: function (n, root) {
      return (root ? root + "/ — " : "") + n + (n === 1 ? " קובץ" : " קבצים");
    },
    scanned: function (n) { return "נסרקו " + n + " קבצים"; },
    foundSignals: function (p, appl) { return "נמצאו " + p + " סימנים מתוך " + appl + " ישימים"; },
    errGeneric: "משהו השתבש. נסה שוב בעוד רגע.",
    errRepoPrivate: "הריפו פרטי או שאין הרשאה. התחבר עם GitHub.",
    errNoFiles: "לא נמצאו קבצים לסריקה.",
    errDetect: "האבחון נכשל. נסה שוב.",
    noApiKey: "מנוע האבחון לא מוגדר — חסר ANTHROPIC_API_KEY ב-Supabase (Edge Functions → Secrets).",
    badApiKey: "מפתח ה-ANTHROPIC_API_KEY לא תקין — כנראה נדבקו איתו רווח או ירידת שורה. הגדירו אותו מחדש.",
    errTimeout: "האבחון ארך יותר מ-150 שניות ונקטע. נסו ריפו קטן יותר, או פנו אלינו."
  } : {
    hi: "Hi, ",
    signout: "Sign out",
    zipTooBig: "File is larger than 5MB.",
    zipEmpty: "No scannable files found.",
    urlFormat: "Invalid format. Example: https://github.com/user/repo",
    urlChecking: "Checking the repo...",
    urlOk: "Repo found and accessible.",
    urlNotFound: "Repo not found. Check the URL.",
    urlPrivate: "Repo is private — connect GitHub to access it.",
    ghNotConnected: "GitHub is not connected. Use the GitHub row to connect.",
    ghExpired: "GitHub connection expired. Reconnect with GitHub.",
    ghConnectedLabel: "Your GitHub repositories",
    ghDisconnectedLabel: "To scan a private repo, connect GitHub",
    reposEmpty: "No repositories found on the account.",
    noRepoMatch: "No repo matches your search.",
    reposLoading: "Loading repositories...",
    allAudits: function (n) { return "All audits (" + n + ")"; },
    filesPicked: function (n, root) {
      return (root ? root + "/ — " : "") + n + (n === 1 ? " file" : " files");
    },
    scanned: function (n) { return "Scanned " + n + " files"; },
    foundSignals: function (p, appl) { return "Found " + p + " signals of " + appl + " applicable"; },
    errGeneric: "Something went wrong. Try again in a moment.",
    errRepoPrivate: "Repo is private or you lack access. Connect GitHub.",
    errNoFiles: "No scannable files found.",
    errDetect: "Diagnosis failed. Try again.",
    noApiKey: "Diagnosis engine not configured — ANTHROPIC_API_KEY is missing in Supabase (Edge Functions → Secrets).",
    badApiKey: "ANTHROPIC_API_KEY is invalid — a space or newline was probably pasted with it. Set it again.",
    errTimeout: "Diagnosis ran past 150 seconds and was cut off. Try a smaller repo, or contact us."
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
      if (user) { wireInputs(); loadHistory(); }
    }).catch(function () {
      window.location.replace(HOME);
    });
  });

  function cacheEls() {
    ["app-user", "signout", "app-input", "report", "loading", "stages",
     "err-banner",
     "dropzone", "files-input", "dir-input", "pick-files", "pick-dir",
     "picked", "picked-what", "picked-clear", "files-start",
     "url-input", "url-status", "url-start",
     "gh-label", "gh-pick", "gh-connect",
     "repo-dialog", "repo-search", "repo-list",
     "score", "report-caption", "report-body", "report-back",
     "history", "history-list", "history-all", "history-dialog", "history-all-list"
    ].forEach(function (id) { els[id] = $(id); });
    els.stageItems = Array.prototype.slice.call(document.querySelectorAll(".stages li"));
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
    }).then(function () { ghConnected = true; paintGithubRow(); });
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

  /* ===== wiring: three input paths, all live at once ===== */
  function wireInputs() {
    wireFiles();
    wireUrl();
    wireGithubRow();
    wireDialogs();
  }

  /* The GitHub row never disappears — only its button changes, so the
     three paths stay in the same three places whatever the account state. */
  function wireGithubRow() {
    els["gh-connect"].addEventListener("click", connectGithub);
    els["gh-pick"].addEventListener("click", openRepoDialog);
    els["repo-search"].addEventListener("input", function () { renderRepos(this.value); });
    paintGithubRow();
  }

  function paintGithubRow() {
    els["gh-label"].textContent = ghConnected ? T.ghConnectedLabel : T.ghDisconnectedLabel;
    els["gh-pick"].hidden = !ghConnected;
    els["gh-connect"].hidden = ghConnected;
  }

  /* ===== path 1: files, folder, or zip ===== */
  function wireFiles() {
    var dz = els.dropzone;
    els["pick-files"].addEventListener("click", function (e) { e.stopPropagation(); els["files-input"].click(); });
    els["pick-dir"].addEventListener("click", function (e) { e.stopPropagation(); els["dir-input"].click(); });
    dz.addEventListener("click", function () { els["files-input"].click(); });
    dz.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); els["files-input"].click(); }
    });
    ["dragenter", "dragover"].forEach(function (t) {
      dz.addEventListener(t, function (e) { e.preventDefault(); dz.classList.add("is-drag"); });
    });
    ["dragleave", "drop"].forEach(function (t) {
      dz.addEventListener(t, function (e) { e.preventDefault(); dz.classList.remove("is-drag"); });
    });
    dz.addEventListener("drop", function (e) {
      collectFromDrop(e.dataTransfer).then(setPicked).catch(function () { showError(T.errGeneric); });
    });
    els["files-input"].addEventListener("change", function () {
      setPicked(fromFileList(this.files, false));
    });
    els["dir-input"].addEventListener("change", function () {
      setPicked(fromFileList(this.files, true));
    });
    els["picked-clear"].addEventListener("click", clearPicked);
    els["files-start"].addEventListener("click", function () { if (picked.length) startFiles(); });
  }

  /* A picked entry is always {path, file} — the shape the bundler wants,
     whichever of the four ways the user handed the files over. */
  var picked = [], pickedRoot = "";

  function fromFileList(list, fromDirectory) {
    return Array.prototype.map.call(list, function (f) {
      return { path: (fromDirectory && f.webkitRelativePath) || f.name, file: f };
    });
  }

  /* Drag-and-drop is the only path that can carry a directory tree, and
     only via the non-standard webkitGetAsEntry. Fall back to the flat
     file list when the browser does not offer entries. */
  function collectFromDrop(dt) {
    var items = dt.items ? Array.prototype.slice.call(dt.items) : [];
    var entries = items.map(function (it) {
      return it.webkitGetAsEntry ? it.webkitGetAsEntry() : null;
    }).filter(Boolean);
    if (!entries.length) return Promise.resolve(fromFileList(dt.files, false));
    return Promise.all(entries.map(function (en) { return walkEntry(en, ""); }))
      .then(function (nested) { return [].concat.apply([], nested); });
  }

  function walkEntry(entry, prefix) {
    var path = prefix + entry.name;
    if (entry.isFile) {
      return new Promise(function (resolve) {
        entry.file(function (f) { resolve([{ path: path, file: f }]); }, function () { resolve([]); });
      });
    }
    if (!entry.isDirectory) return Promise.resolve([]);
    if (!keepPath(path + "/")) return Promise.resolve([]); /* skip node_modules etc. before reading */
    return readAllEntries(entry.createReader()).then(function (children) {
      return Promise.all(children.map(function (c) { return walkEntry(c, path + "/"); }))
        .then(function (nested) { return [].concat.apply([], nested); });
    });
  }

  /* readEntries returns at most ~100 per call, so it has to be drained. */
  function readAllEntries(reader) {
    var all = [];
    return new Promise(function (resolve) {
      (function next() {
        reader.readEntries(function (batch) {
          if (!batch.length) { resolve(all); return; }
          all = all.concat(Array.prototype.slice.call(batch));
          next();
        }, function () { resolve(all); });
      })();
    });
  }

  function setPicked(entries) {
    hideError();
    if (!entries || !entries.length) return;
    var over = entries.filter(function (e) { return e.file.size > MAX_ZIP_BYTES; });
    if (over.length) { showError(T.zipTooBig); return; }
    picked = entries;
    pickedRoot = commonRoot(entries);
    var single = entries.length === 1 ? entries[0] : null;
    els["picked-what"].textContent = single
      ? single.file.name
      : T.filesPicked(entries.length, pickedRoot);
    els.picked.hidden = false;
  }

  function clearPicked() {
    picked = []; pickedRoot = "";
    els.picked.hidden = true;
    els["files-input"].value = "";
    els["dir-input"].value = "";
    hideError();
  }

  function commonRoot(entries) {
    var first = entries[0].path.split("/");
    if (first.length < 2) return "";
    var root = first[0];
    return entries.every(function (e) { return e.path.indexOf(root + "/") === 0; }) ? root : "";
  }

  /* A lone .zip goes through JSZip; anything else is read directly.
     Both converge on the same bundle format and the same upload. */
  function startFiles() {
    if (busy) return;
    setBusy(true);
    showStages();
    setStage(0);
    var lone = picked.length === 1 ? picked[0].file : null;
    var isZip = lone && /\.zip$/i.test(lone.name);
    var ref = isZip ? lone.name : T.filesPicked(picked.length, pickedRoot);
    var scanId = null;

    createScan("zip", ref).then(function (id) {
      scanId = id;
      return isZip ? bundleFromZip(lone) : bundleFromEntries(picked);
    }).then(function (bundle) {
      if (!bundle) throw new Error("empty");
      setStage(2);
      return uploadBundle(scanId, bundle);
    }).then(function () {
      return runDetect(scanId);
    }).catch(function (e) {
      handleFlowError(e, scanId);
    });
  }

  function bundleFromZip(file) {
    return import(JSZIP_CDN).then(function (mod) {
      var JSZip = mod.default || mod;
      return JSZip.loadAsync(file);
    }).then(function (zip) {
      setStage(1);
      var names = Object.keys(zip.files).filter(function (n) {
        return !zip.files[n].dir && keepPath(n);
      });
      var parts = [], total = 0;
      var chain = Promise.resolve();
      names.forEach(function (n) {
        chain = chain.then(function () {
          if (total >= MAX_BUNDLE_BYTES) return;
          return zip.files[n].async("string").then(function (text) {
            if (text.length > MAX_FILE_BYTES) return;
            /* strip a single leading top-level dir (common in exported zips) */
            var block = fileBlock(n.replace(/^[^/]+\//, ""), text);
            total += block.length; parts.push(block);
          }).catch(function () {});
        });
      });
      return chain.then(function () { return parts.length ? parts.join("") : null; });
    });
  }

  function bundleFromEntries(entries) {
    setStage(1);
    var keep = entries.filter(function (e) { return keepPath(e.path); });
    var parts = [], total = 0;
    var chain = Promise.resolve();
    keep.forEach(function (e) {
      chain = chain.then(function () {
        if (total >= MAX_BUNDLE_BYTES) return;
        if (e.file.size > MAX_FILE_BYTES) return;
        return readText(e.file).then(function (text) {
          if (text == null || text.length > MAX_FILE_BYTES) return;
          var rel = pickedRoot ? e.path.replace(pickedRoot + "/", "") : e.path;
          var block = fileBlock(rel, text);
          total += block.length; parts.push(block);
        }).catch(function () {});
      });
    });
    return chain.then(function () { return parts.length ? parts.join("") : null; });
  }

  function fileBlock(path, text) { return "=== FILE: " + path + " ===\n" + text + "\n\n"; }

  function readText(file) {
    if (file.text) return file.text();
    return new Promise(function (resolve) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result || "")); };
      fr.onerror = function () { resolve(null); };
      fr.readAsText(file);
    });
  }

  /* ===== path 2: public repo URL ===== */
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
    s.className = "row-status" + (cls ? " " + cls : "");
  }

  function startUrl(v) { startRemote("url", v); }

  /* ===== path 3: a repo from the connected account ===== */
  var repos = [];

  function openRepoDialog() {
    els["repo-dialog"].showModal();
    loadRepos();
    els["repo-search"].focus();
  }

  function loadRepos() {
    if (repos.length) { renderRepos(els["repo-search"].value); return; }
    els["repo-list"].innerHTML = '<li><span class="repo-row is-note">' + esc(T.reposLoading) + "</span></li>";
    invokeFn("list-repos", {}).then(function (data) {
      repos = (data && data.repos) || [];
      renderRepos("");
    }).catch(function (e) {
      if (e && e.status === 428) {
        /* the token went stale — send the row back to its connect state */
        ghConnected = false;
        paintGithubRow();
        els["repo-dialog"].close();
        showError(T.ghExpired);
        return;
      }
      els["repo-list"].innerHTML = '<li><span class="repo-row is-note">' + esc(T.errGeneric) + "</span></li>";
    });
  }

  function renderRepos(query) {
    var q = (query || "").toLowerCase();
    var note = function (msg) {
      els["repo-list"].innerHTML = '<li><span class="repo-row is-note">' + esc(msg) + "</span></li>";
    };
    if (!repos.length) { note(T.reposEmpty); return; }
    var list = repos.filter(function (r) { return !q || (r.full_name || "").toLowerCase().indexOf(q) !== -1; });
    if (!list.length) { note(T.noRepoMatch); return; }

    els["repo-list"].innerHTML = list.map(function (r) {
      var sub = [];
      if (r.language) sub.push(esc(r.language));
      if (r.updated_at) sub.push(esc(fmtDate(r.updated_at)));
      if (r.private) sub.push(he ? "פרטי" : "private");
      return '<li><button type="button" class="repo-row" data-repo="' + esc(r.full_name) +
        '" data-branch="' + esc(r.default_branch || "") + '">' +
        '<span class="repo-meta"><span class="repo-name ltr">' + esc(r.full_name) + "</span>" +
        '<span class="repo-sub ltr">' + sub.join(" · ") + "</span></span>" +
        '<span class="history-open" aria-hidden="true">' + (he ? "‹" : "›") + "</span></button></li>";
    }).join("");

    Array.prototype.forEach.call(els["repo-list"].querySelectorAll("[data-repo]"), function (btn) {
      btn.addEventListener("click", function () {
        var full = btn.getAttribute("data-repo");
        var parts = full.split("/");
        els["repo-dialog"].close();
        startRemote("github", {
          owner: parts[0], repo: parts[1],
          ref: btn.getAttribute("data-branch") || undefined,
          full: full
        });
      });
    });
  }

  /* URL and GitHub differ only in the source_type they record. */
  function startRemote(type, v) {
    if (busy) return;
    setBusy(true);
    showStages();
    setStage(0); /* fetch-repo does the read/filter/upload trio server-side */
    var scanId = null;
    createScan(type, v.full).then(function (id) {
      scanId = id;
      return invokeFn("fetch-repo", { scan_id: id, owner: v.owner, repo: v.repo, ref: v.ref });
    }).then(function () {
      return runDetect(scanId);
    }).catch(function (e) { handleFlowError(e, scanId); });
  }

  /* ===== dialogs ===== */
  function wireDialogs() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-close-dialog]"), function (btn) {
      btn.addEventListener("click", function () { btn.closest("dialog").close(); });
    });
    /* clicking the backdrop closes; clicking the sheet itself must not */
    Array.prototype.forEach.call(document.querySelectorAll("dialog.sheet"), function (dlg) {
      dlg.addEventListener("click", function (e) { if (e.target === dlg) dlg.close(); });
    });
    els["history-all"].addEventListener("click", function () {
      renderHistoryInto(historyRows, els["history-all-list"]);
      els["history-dialog"].showModal();
    });
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
    setStage(3);
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
    /* detect returns only the signals it found, plus the ids it ruled
       inapplicable — absent ones are never sent, which is what keeps the
       call inside the platform's time limit. */
    var present = det.present_signals || det.signals || [];
    var applicable = det.applicable_count != null
      ? det.applicable_count
      : 108 - ((det.not_applicable_ids || []).length);

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
        return '<li><span class="sig-id" dir="ltr">#' + s.id + "</span>" +
          '<span class="sig-body"><span class="sig-name">' + esc(s.name) + "</span>" + code + file + "</span>" +
          '<span class="sig-flag w-' + esc(w || "medium") + '" dir="ltr">' + esc(String(s.weight || "").toUpperCase()) + "</span></li>";
      }).join("");
      return '<div class="cat-group"><h3>' + esc(cat) + '</h3><ul class="led">' + rows + "</ul></div>";
    }).join("") || ("<p>" + esc(he ? "לא נמצאו סימנים במעבר הזה." : "No signals found in this pass.") + "</p>");

    els.loading.hidden = true;
    els["app-input"].hidden = true;
    els.history.hidden = true;
    els.report.hidden = false;
    setBusy(false);
    window.scrollTo(0, 0);
  }

  /* ===== recent audits (history) ===== */
  var historyRows = [];
  function loadHistory() {
    if (!sb || !user || !els.history) return;
    sb.from("scans")
      .select("id,source_type,source_ref,ai_fingerprint_score,present_count,files_scanned,detection,created_at")
      .eq("user_id", user.id).eq("status", "done")
      .order("created_at", { ascending: false }).limit(20)
      .then(function (r) {
        if (r.error || !r.data || !r.data.length) return;
        historyRows = r.data;
        renderHistory();
        els.history.hidden = false;
      }).catch(function () { /* history is non-critical */ });
  }

  function sourceLabel(t) {
    if (t === "github") return "GitHub";
    if (t === "zip") return "ZIP";
    if (t === "url") return he ? "קישור" : "link";
    return t || "";
  }

  /* Only the three most recent stay on the page — the rest are one click
     away in the sheet, so the working screen never grows past one view. */
  function renderHistory() {
    renderHistoryInto(historyRows.slice(0, HISTORY_PREVIEW), els["history-list"]);
    var overflow = historyRows.length > HISTORY_PREVIEW;
    els["history-all"].hidden = !overflow;
    if (overflow) els["history-all"].textContent = T.allAudits(historyRows.length);
  }

  function renderHistoryInto(rows, target) {
    var chevron = he ? "‹" : "›";
    target.innerHTML = rows.map(function (s) {
      var score = s.ai_fingerprint_score != null ? s.ai_fingerprint_score : 0;
      var ref = s.source_ref || sourceLabel(s.source_type);
      var sub = [sourceLabel(s.source_type), fmtDate(s.created_at)];
      if (s.present_count != null) sub.push(s.present_count + (he ? " סימנים" : " signals"));
      return '<li><button type="button" class="history-row" data-id="' + esc(s.id) + '">' +
        '<span class="history-score" dir="ltr">' + esc(String(score)) + "<small>/100</small></span>" +
        '<span class="history-meta">' +
          '<span class="history-ref ltr">' + esc(ref) + "</span>" +
          '<span class="history-sub">' + esc(sub.join(" · ")) + "</span>" +
        "</span>" +
        '<span class="history-open" aria-hidden="true">' + chevron + "</span></button></li>";
    }).join("");

    Array.prototype.forEach.call(target.querySelectorAll("[data-id]"), function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-id");
        var s = historyRows.filter(function (x) { return x.id === id; })[0];
        if (!s) return;
        els["history-dialog"].close();
        setBusy(true);
        renderReport(s);
      });
    });
  }

  /* ===== error handling ===== */
  function handleFlowError(e, scanId) {
    hideStages();
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
    else if (e && (e.status === 546 || e.status === 504)) msg = T.errTimeout;
    else if (reason && /anthropic|model|bundle/.test(reason)) msg = T.errDetect;
    /* this is a work tool: never hide the concrete reason behind a generic line */
    else if (reason) msg = T.errGeneric + " (" + reason + ")";
    showError(msg);
  }

  function showError(msg) { els["err-banner"].textContent = msg; els["err-banner"].hidden = false; }
  function hideError() { els["err-banner"].hidden = true; }

  /* ===== ui state ===== */
  function setBusy(v) { busy = v; }

  function showStages() {
    hideError();
    els["app-input"].hidden = true;
    els.history.hidden = true;
    els.report.hidden = true;
    els.loading.hidden = false;
  }

  /* Everything before `i` is done, `i` is running, the rest are waiting. */
  function setStage(i) {
    els.stageItems.forEach(function (li, n) {
      li.classList.toggle("is-done", n < i);
      li.classList.toggle("is-active", n === i);
    });
  }

  function hideStages() {
    els.loading.hidden = true;
    setStage(-1);
    els["app-input"].hidden = false;
    if (historyRows.length) els.history.hidden = false;
  }

  /* ===== small utils ===== */
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }
  function clip(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n) + "…" : s; }
  function fmtDate(iso) { try { return new Date(iso).toISOString().slice(0, 10); } catch (e) { return ""; } }

  function wireStatic() {
    if (els["report-back"]) els["report-back"].addEventListener("click", backToInput);
  }

  /* return from a report (fresh or from history) to the input + history view */
  function backToInput() {
    els.report.hidden = true;
    els["app-input"].hidden = false;
    if (historyRows.length) els.history.hidden = false;
    clearPicked();
    setBusy(false);
    window.scrollTo(0, 0);
    loadHistory(); /* refresh so a just-finished scan shows up */
  }

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
