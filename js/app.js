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
  /* Below this present-signal count, an AI-built site was almost certainly
     under-detected, so we run one aggressive re-hunt pass (see detect/rehunt). */
  var REHUNT_FLOOR = 25;

  var he = document.documentElement.lang === "he";
  var HOME = he ? "/he/" : "/";

  /* ===== dynamic strings (static UI text lives in the HTML) ===== */
  var T = he ? {
    hi: "שלום, ",
    signout: "התנתקות",
    zipTooBig: "הקובץ גדול מ-5MB.",
    zipEmpty: "הארכיון ריק מקוד. ודאו שהוא מכיל את קבצי המקור ולא רק תיקיית build.",
    urlFormat: "פורמט לא תקין. דוגמה: https://github.com/user/repo",
    urlChecking: "בודק את הריפו...",
    urlOk: "הריפו נמצא וזמין.",
    urlNotFound: "הריפו לא נמצא. בדוק את הכתובת.",
    urlPrivate: "הריפו פרטי — חברו את GitHub כדי לגשת אליו.",
    ghNotConnected: "GitHub לא מחובר. השתמשו בשורת GitHub כדי לחבר.",
    ghExpired: "החיבור ל-GitHub פג. התחבר מחדש עם GitHub.",
    ghConnectedLabel: "הריפוזיטוריז שלכם ב-GitHub",
    ghDisconnectedLabel: "הריפוזיטוריז שלכם ב-GitHub",
    ghNoteConnected: "סריקה ישירה מהחשבון, כולל ריפוזיטוריז פרטיים",
    ghNoteDisconnected: "נכנסתם עם Google. חברו את GitHub כדי לסרוק גם ריפו פרטי",
    reposEmpty: "לא נמצאו ריפוזיטוריז בחשבון.",
    noRepoMatch: "אין ריפו שתואם לחיפוש.",
    reposLoading: "טוען ריפוזיטוריז...",
    allAudits: function (n) { return "כל האבחונים (" + n + ")"; },
    deleteTitle: "מחיקה", confirmDelete: "למחוק את האבחון הזה? אי אפשר לשחזר.",
    filesPicked: function (n, root) {
      return (root ? root + "/ — " : "") + n + (n === 1 ? " קובץ" : " קבצים");
    },
    scanSteps: ["קורא קבצים", "מסנן קבצים לא רלוונטיים", "מעלה לניתוח",
                "מריץ אבחון מול 110 סימנים"],
    scanned: function (n) { return "נסרקו " + n + " קבצים"; },
    foundSignals: function (p, appl) { return "נמצאו " + p + " סימנים מתוך " + appl + " ישימים"; },
    unevaluated: function (n) { return n + " סימנים לא נבדקו"; },
    /* cats: [{ name, count }], כבר ממוינות מהגדולה לקטנה */
    findingsSummary: function (total, cats) {
      var head = total === 1 ? "נמצא סימן אחד " : "נמצאו " + total + " סימנים ";
      var where = cats.length === 1 ? "בקטגוריה אחת" : "ב-" + cats.length + " קטגוריות";
      var top = cats.slice(0, 3).map(function (c) { return c.name + " (" + c.count + ")"; }).join(", ");
      var rest = cats.length - 3;
      return head + where + ": " + top + (rest > 0 ? ", ועוד " + rest : "") + ".";
    },
    expandFindings: "הרחבת התקלות",
    collapseFindings: "סגירת התקלות",
    errGeneric: "השרת לא ענה. נסו שוב — ואם זה חוזר, שלחו לנו את שם הריפו.",
    errRepoPrivate: "הריפו פרטי או שאין הרשאה. התחבר עם GitHub.",
    errNoFiles: "אין כאן קוד לסרוק — רק קבצים שמסוננים ממילא (node_modules,‏ ‎.git, תמונות).",
    errDetect: "מנוע האבחון החזיר תשובה לא תקינה. הריצו שוב; אם זה חוזר, זה אצלנו.",
    errRetry: "נסו שוב",
    searchClear: "ניקוי החיפוש",
    searchCount: function (n, total) { return n + " מתוך " + total; },
    noApiKey: "מנוע האבחון לא מוגדר — חסר ANTHROPIC_API_KEY ב-Supabase (Edge Functions → Secrets).",
    badApiKey: "מפתח ה-ANTHROPIC_API_KEY לא תקין — כנראה נדבקו איתו רווח או ירידת שורה. הגדירו אותו מחדש.",
    errTimeout: "האבחון ארך יותר מ-150 שניות ונקטע. נסו ריפו קטן יותר, או פנו אלינו.",
    ownerTitle: "מה מחכה לך",
    ownerNote: "את אלה אי אפשר לתקן אוטומטית — חסרה עובדה שרק אתם יודעים. אנחנו לא ממציאים עובדות, אז הם יישארו עד שתספקו אותן.",
    ownerNeeds: {
      business_details: "פרטי העסק — ח\"פ, כתובת, טלפון, שעות פעילות",
      legal_documents: "מסמכים משפטיים — תקנון, מדיניות פרטיות, הצהרת נגישות",
      real_images: "תמונות אמיתיות של העסק",
      real_numbers: "נתונים אמיתיים — מקור לסטטיסטיקה, המלצות עם שם ותפקיד",
      analytics_account: "חשבון מדידה — Google Tag Manager או Analytics",
      more_content: "תוכן נוסף — עמודים פנימיים או תרגום"
    },
    errContentLoss: "עצרנו את הבנייה: התוצאה יצאה חסרה לעומת האתר המקורי, ולא נמסור אתר שאיבד תוכן. זה לא משהו שעשיתם — זו בדיקת בטיחות אצלנו."
  } : {
    hi: "Hi, ",
    signout: "Sign out",
    zipTooBig: "File is larger than 5MB.",
    zipEmpty: "The archive has no source code in it. Check that it holds your source files, not just a build folder.",
    urlFormat: "Invalid format. Example: https://github.com/user/repo",
    urlChecking: "Checking the repo...",
    urlOk: "Repo found and accessible.",
    urlNotFound: "Repo not found. Check the URL.",
    urlPrivate: "Repo is private — connect GitHub to access it.",
    ghNotConnected: "GitHub is not connected. Use the GitHub row to connect.",
    ghExpired: "GitHub connection expired. Reconnect with GitHub.",
    ghConnectedLabel: "Your GitHub repositories",
    ghDisconnectedLabel: "Your GitHub repositories",
    ghNoteConnected: "Scanned straight from your account, private repos included",
    ghNoteDisconnected: "You signed in with Google. Connect GitHub to scan private repos too",
    reposEmpty: "No repositories found on the account.",
    noRepoMatch: "No repo matches your search.",
    reposLoading: "Loading repositories...",
    allAudits: function (n) { return "All audits (" + n + ")"; },
    deleteTitle: "Delete", confirmDelete: "Delete this audit? This can't be undone.",
    filesPicked: function (n, root) {
      return (root ? root + "/ — " : "") + n + (n === 1 ? " file" : " files");
    },
    scanSteps: ["Reading files", "Filtering out irrelevant files", "Uploading for analysis",
                "Running diagnosis against 110 signals"],
    scanned: function (n) { return "Scanned " + n + " files"; },
    foundSignals: function (p, appl) { return "Found " + p + " signals of " + appl + " applicable"; },
    unevaluated: function (n) { return n + " signals were not evaluated"; },
    /* cats: [{ name, count }], already sorted largest first */
    findingsSummary: function (total, cats) {
      var head = total === 1 ? "Found 1 signal " : "Found " + total + " signals ";
      var where = cats.length === 1 ? "in one category" : "across " + cats.length + " categories";
      var top = cats.slice(0, 3).map(function (c) { return c.name + " (" + c.count + ")"; }).join(", ");
      var rest = cats.length - 3;
      return head + where + ": " + top + (rest > 0 ? ", and " + rest + " more" : "") + ".";
    },
    expandFindings: "Expand the findings",
    collapseFindings: "Collapse the findings",
    errGeneric: "The server didn't answer. Try again — and if it keeps happening, send us the repo name.",
    errRepoPrivate: "Repo is private or you lack access. Connect GitHub.",
    errNoFiles: "There's no code here to scan — only files we filter out anyway (node_modules, .git, images).",
    errDetect: "The audit engine returned a malformed response. Run it again; if it repeats, it's on us.",
    errRetry: "Try again",
    searchClear: "Clear the search",
    searchCount: function (n, total) { return n + " of " + total; },
    noApiKey: "Diagnosis engine not configured — ANTHROPIC_API_KEY is missing in Supabase (Edge Functions → Secrets).",
    badApiKey: "ANTHROPIC_API_KEY is invalid — a space or newline was probably pasted with it. Set it again.",
    errTimeout: "Diagnosis ran past 150 seconds and was cut off. Try a smaller repo, or contact us.",
    ownerTitle: "Waiting on you",
    ownerNote: "These cannot be fixed automatically — each needs a fact only you have. We never invent facts, so they stay until you supply them.",
    ownerNeeds: {
      business_details: "Business details — company number, address, phone, hours",
      legal_documents: "Legal pages — terms, privacy policy, accessibility statement",
      real_images: "Real photographs of the business",
      real_numbers: "Real data — a source for each statistic, testimonials with a name and role",
      analytics_account: "An analytics account — Google Tag Manager or Analytics",
      more_content: "More content — inner pages or a translation"
    },
    errContentLoss: "We stopped the rebuild: the result came back missing content the original had, and we will not hand over a site that lost part of itself. This is our safety check, not something you did."
  };

  /* ===== file filtering =====
     A copy of keepPath() in supabase/functions/_shared/pipeline.ts, because the
     browser filters before upload and cannot import from there. The tests for
     these rules live with that copy. Change one, change both.

     The dotted-segment rule drops .git, .DS_Store, the "._name" sidecars macOS
     puts in every zip, and .env — which was otherwise read off the user's disk
     and uploaded. robots.txt is deliberately kept; three signals look for it. */
  var SKIP_DIR = /(^|\/)(node_modules|dist|build|\.next|\.nuxt|out|vendor|coverage|\.cache|\.vercel|\.turbo|__MACOSX)(\/|$)/;
  var SKIP_DOTTED = /(^|\/)\./;
  var SKIP_ARCHIVE_ARTIFACT = /(^|\/)pax_global_header$/;
  var SKIP_DOCS = /(\.(md|markdown|mdx|rst)$|(^|\/)(LICENSE|LICENCE|COPYING|NOTICE|CHANGELOG|AUTHORS|CONTRIBUTING)(\.(txt|rst))?$)/i;
  var SKIP_FILE = /\.(min\.(js|css)|map|lock|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|pdf|zip|gz|br|wasm|ds_store)$/i;
  var SKIP_LOCKFILES = /(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb)$/i;
  function keepPath(p) {
    return !SKIP_DIR.test(p) && !SKIP_DOTTED.test(p) &&
      !SKIP_ARCHIVE_ARTIFACT.test(p) && !SKIP_DOCS.test(p) &&
      !SKIP_LOCKFILES.test(p) && !SKIP_FILE.test(p);
  }

  /* ===== dom ===== */
  var $ = function (id) { return document.getElementById(id); };
  var els = {};
  var sb = null, user = null, ghConnected = false, busy = false;

  /* Dev-only auth bypass, kept deliberately so the dashboard can be worked on
     locally without a Supabase session. Gated on the hostname, so it is dead
     code on any deployed origin. It only fakes the client-side shell — every
     read still goes through Supabase and returns nothing without a real
     session, so there is no data behind it either way. */
  var DEV_NO_AUTH = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);

  /* ===== boot ===== */
  document.addEventListener("DOMContentLoaded", function () {
    cacheEls();
    wireStatic();
    import(SB_CDN).then(function (mod) {
      sb = mod.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      return sb.auth.getSession();
    }).then(function (res) {
      var session = res.data && res.data.session;
      /* localhost only — renders the shell with a stand-in user */
      if (!session && DEV_NO_AUTH) {
        user = { email: "dev@localhost", user_metadata: { full_name: "Dev" } };
        showUser(); wireInputs();
        return;
      }
      if (!session) { window.location.replace(HOME); return; }
      user = session.user;
      persistGithubToken(session);
      sb.auth.onAuthStateChange(function (_e, s) { if (s) { user = s.user; persistGithubToken(s); } });
      showUser();
      return refreshGithubStatus();
    }).then(function () {
      if (user) { wireInputs(); loadHistory(); }
    }).catch(function () {
      if (DEV_NO_AUTH) return;
      window.location.replace(HOME);
    });
  });

  function cacheEls() {
    ["app-user", "signout", "app-input", "report", "loading", "stages",
     "err-banner",
     "dropzone", "files-input", "dir-input", "pick-files", "pick-dir",
     "picked", "picked-what", "picked-clear", "files-start",
     "url-input", "url-status", "url-start",
     "gh-label", "gh-note", "gh-pick", "gh-connect",
     "repo-dialog", "repo-search", "repo-list", "repo-count", "repo-empty", "repo-names",
     "score", "report-caption", "report-body", "report-back",
     "history", "history-list", "history-all", "history-empty",
     "history-dialog", "history-all-list",
     "fix-pipeline", "rebuild-site", "propose-fixes", "fix-hint", "design-direction",
     "proposals", "fix-actions", "apply-fixes", "apply-result", "qa-result",
     "deliver-actions", "download-zip", "push-github", "deliver-result",
     "add-features", "features-result", "rb-progress", "score-delta",
     "scan-progress", "site-url"
    ].forEach(function (id) { els[id] = $(id); });
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
    els["gh-note"].textContent = ghConnected ? T.ghNoteConnected : T.ghNoteDisconnected;
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
    showRepoEmpty(T.reposLoading);
    invokeFn("list-repos", {}).then(function (data) {
      repos = (data && data.repos) || [];
      /* feed the browser's own autocomplete so typing narrows without guessing */
      els["repo-names"].innerHTML = repos.map(function (r) {
        return '<option value="' + esc(r.full_name) + '"></option>';
      }).join("");
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
      showRepoEmpty(T.errGeneric, T.errRetry, function () { repos = []; loadRepos(); });
    });
  }

  /* One place decides what the sheet shows when there is no list to show,
     and every variant offers the next move rather than a bare sentence. */
  function showRepoEmpty(msg, actionLabel, onAction) {
    els["repo-list"].innerHTML = "";
    els["repo-count"].textContent = "";
    var html = '<p class="empty-title">' + esc(msg) + "</p>";
    if (actionLabel) html += '<p class="empty-body"><button type="button" class="linkbtn" id="repo-empty-act">' + esc(actionLabel) + "</button></p>";
    els["repo-empty"].innerHTML = html;
    els["repo-empty"].hidden = false;
    if (actionLabel) $("repo-empty-act").addEventListener("click", onAction);
  }

  function renderRepos(query) {
    var q = (query || "").toLowerCase();
    if (!repos.length) { showRepoEmpty(T.reposEmpty); return; }

    var list = repos.filter(function (r) { return !q || (r.full_name || "").toLowerCase().indexOf(q) !== -1; });
    if (!list.length) {
      showRepoEmpty(T.noRepoMatch, T.searchClear, function () {
        els["repo-search"].value = "";
        renderRepos("");
        els["repo-search"].focus();
      });
      return;
    }

    els["repo-empty"].hidden = true;
    els["repo-count"].textContent = T.searchCount(list.length, repos.length);
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

  /* The 110-signal audit is split across sequential passes. Wall-clock scales
     with how many signals come back PRESENT, not with project size, so a
     heavily-templated site — the exact thing this product exists for — blows
     the 150s edge-function limit in a single call. Each pass audits a slice and
     the server merges; we drive them one at a time and only render at the end. */
  function runDetect(scanId) {
    setStage(3);

    function pass(n, total) {
      return invokeFn("detect", { scan_id: scanId, part: n, parts: total })
        .then(function (data) {
          if (data && data.done) return data;
          /* The server found signals the model never returned. Rather than
             score around the hole, it hands them back as another pass with a
             budget of its own. */
          if (data && data.gap) return gapPass(data.gap_attempt, n, total);
          setDetectProgress(n, total);
          return pass(n + 1, total);
        });
    }

    function gapPass(attempt, n, total) {
      prog.say(P.gapPass);
      return invokeFn("detect", {
        scan_id: scanId, gap: true, gap_attempt: attempt, part: n, parts: total,
      }).then(function (data) {
        if (data && data.gap) return gapPass(data.gap_attempt, n, total);
        return data;
      });
    }

    /* How long a pass takes is driven by how many signals come back PRESENT,
       which we cannot know before running it. When a pass overruns the
       function's budget, splitting finer is the fix — and doing it here beats
       making the user pay for a dead end and come back. Once only: if six
       passes still overrun, something else is wrong and retrying just burns
       more money. */
    /* Four, not three. Measured: at three parts a pass ran 86-90s of its 150s
       budget and the model started dropping the tail of its own list rather
       than overrunning — 22 of 110 signals went unevaluated on one run. Shorter
       passes are what stop that at the source; the server's gap pass is the
       safety net, not the plan. */
    return pass(1, 4)
      .catch(function (e) {
        var msg = (e && e.body && e.body.error) || "";
        if (String(msg).indexOf("stage_timeout") === -1) throw e;
        setDetectProgress(0, 6);
        return pass(1, 6);
      })
      .then(function (data) {
        // Aggressive recall: a suspiciously-low count on an AI-built site almost
        // always means the first look was too shy. Look once more, harder, only
        // at the signals marked absent. The server only ADDS evidenced signals,
        // so a re-hunt can never fabricate or lower the count.
        var found = data && typeof data.present_count === "number" ? data.present_count : null;
        if (found !== null && found < REHUNT_FLOOR) {
          prog.say(P.rehunting);
          return invokeFn("detect", { scan_id: scanId, rehunt: true })
            .catch(function () { /* non-fatal: keep the detection we have */ })
            .then(function () { return loadReport(scanId); });
        }
        return loadReport(scanId);
      });
  }

  /* Stage 2 is split for the same reason stage 1 is: it emits a full code pair
     per present signal, so a template-heavy site outruns the 150s function
     limit in one call. Pass 1 sets the design direction; later passes reuse it. */
  function designPass(n, total) {
    return invokeFn("design", { scan_id: currentScanId, part: n, parts: total })
      .then(function (data) {
        if (data && data.done) return data;
        setFixProgress(n, total);
        return designPass(n + 1, total);
      });
  }

  function setFixProgress(done, total) {
    if (els["fix-hint"]) els["fix-hint"].textContent = P.designPass(done, total);
  }

  /* Keeps the user oriented across a multi-pass audit that can take a while.
     Rewrites the diagnosis step's own label rather than adding new chrome. */
  function setDetectProgress(done, total) {
    if (!total) return;
    prog.to(P.detectPass(done, total), DETECT_FLOOR + (done / total) * (100 - DETECT_FLOOR));
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
    /* The stored detection carries an entry for every signal (present & absent).
       The report must show ONLY the ones actually present & applicable — not all
       110 — so the page stays short and about what was actually found. */
    var all = det.present_signals || det.signals || [];
    var present = all.filter(function (s) { return s.present === true && s.applicable !== false; });
    /* The denominator the score actually used. Counting it off the stored
       signals keeps the caption honest now that the catalogue strikes some
       out — saying "110 applicable" while five are struck out is a number that
       does not match the score beside it. Older scans without a signals array
       fall back to the previous fields. */
    var applicable = all.length
      ? all.filter(function (s) { return s.applicable !== false; }).length
      : (det.applicable_count != null
        ? det.applicable_count
        : 110 - ((det.not_applicable_ids || []).length));

    els.score.innerHTML = esc(String(scan.ai_fingerprint_score != null ? scan.ai_fingerprint_score : 0)) + "<small>/100</small>";
    /* A signal nobody evaluated is recorded with confidence 0 rather than
       dropped, so it cannot quietly leave the denominator. Saying so out loud
       is the point: this failure was found by reading the database by hand,
       and it should never take that again. */
    var unevaluated = all.filter(function (s) { return s.confidence === 0; }).length;
    els["report-caption"].textContent =
      T.foundSignals(scan.present_count != null ? scan.present_count : present.length, applicable) +
      " · " + T.scanned(scan.files_scanned != null ? scan.files_scanned : 0) +
      (unevaluated ? " · " + T.unevaluated(unevaluated) : "");

    /* group present signals by category, preserving id order */
    var groups = [];
    var byCat = {};
    present.sort(function (a, b) { return a.id - b.id; }).forEach(function (s) {
      var cat = catOf(s.id) || "—";
      if (!byCat[cat]) { byCat[cat] = []; groups.push(cat); }
      byCat[cat].push(s);
    });

    var full = groups.map(function (cat, i) {
      var rows = byCat[cat].map(function (s) {
        var ev = (s.evidence && s.evidence[0]) || null;
        var code = ev ? '<code>' + esc(clip(ev.snippet, 180)) + "</code>" : "";
        var file = ev ? '<span class="sig-file">' + esc(ev.file) + "</span>" : "";
        var w = s.weight === "very-high" ? "high" : s.weight;
        return '<li><span class="sig-id" dir="ltr">#' + s.id + "</span>" +
          '<span class="sig-body"><span class="sig-name">' + esc(s.name) + "</span>" + code + file + "</span>" +
          '<span class="sig-flag w-' + esc(w || "medium") + '" dir="ltr">' + esc(String(s.weight || "").toUpperCase()) + "</span></li>";
      }).join("");
      return '<details class="cat-group"' + (i === 0 ? " open" : "") + ">" +
        '<summary class="cat-summary"><span class="cat-title">' + esc(cat) + "</span>" +
        '<span class="cat-count">' + byCat[cat].length + "</span></summary>" +
        '<ul class="led">' + rows + "</ul></details>";
    }).join("");

    /* Signals that stay lit because a real-world fact is missing — a company
       number, a photograph, a customer's name. Shown apart from the rest so a
       leftover score reads as a short to-do list the owner can act on, instead
       of as a failure on our side. Absent on scans audited before the catalogue
       started marking them, and the block simply does not render. */
    var ownerGroups = [], ownerBy = {};
    present.forEach(function (s) {
      var needs = s.needs_owner_input;
      if (!needs || !T.ownerNeeds[needs]) return;
      if (!ownerBy[needs]) { ownerBy[needs] = []; ownerGroups.push(needs); }
      ownerBy[needs].push(s);
    });
    var ownerBlock = ownerGroups.length
      ? '<div class="owner-needs">' +
          '<h3 class="owner-needs-title">' + esc(T.ownerTitle) + "</h3>" +
          '<ul class="owner-needs-list">' +
            ownerGroups.map(function (needs) {
              var ids = ownerBy[needs].map(function (s) { return "#" + s.id; }).join(" ");
              return "<li><span>" + esc(T.ownerNeeds[needs]) + "</span>" +
                '<span class="owner-needs-ids" dir="ltr">' + esc(ids) + "</span></li>";
            }).join("") +
          "</ul>" +
          '<p class="owner-needs-note">' + esc(T.ownerNote) + "</p>" +
        "</div>"
      : "";

    /* The findings stay folded into one card: the summary paragraph says where
       the problems are, and the full per-signal list opens under it on request,
       so the fix pipeline above it is what the eye lands on first. */
    if (full) {
      var cats = groups.map(function (cat) { return { name: cat, count: byCat[cat].length }; })
        .sort(function (a, b) { return b.count - a.count; });
      els["report-body"].innerHTML =
        ownerBlock +
        '<div class="findings">' +
          '<div class="findings-head">' +
            '<p class="findings-sum">' + esc(T.findingsSummary(present.length, cats)) + "</p>" +
            '<button type="button" class="linkbtn findings-toggle" id="findings-toggle" ' +
              'aria-expanded="false" aria-controls="findings-full">' + esc(T.expandFindings) + "</button>" +
          "</div>" +
          '<div class="findings-full" id="findings-full" hidden>' + full + "</div>" +
        "</div>";
      wireFindingsToggle();
    } else {
      els["report-body"].innerHTML =
        "<p>" + esc(he ? "לא נמצאו סימנים." : "No signals found.") + "</p>";
    }

    els.loading.hidden = true;
    els["app-input"].hidden = true;
    els.history.hidden = true;
    els.report.hidden = false;
    renderFixPipeline(scan);
    setBusy(false);
    window.scrollTo(0, 0);
  }

  /* lets a fixture scan or feature proposal be pushed into the view locally, so
     the layout can be checked without running a real audit or model call */
  if (DEV_NO_AUTH) {
    window.__devRenderReport = renderReport;
    /* lazy: the progress helpers are defined further down the file */
    window.__devProgress = function () {
      return { prog: prog, setStage: setStage, showStages: showStages, detect: setDetectProgress };
    };
    window.__devFeatureProposal = function (feature, attempt) {
      featureAttempts = attempt || 1;
      renderFeatureProposal(feature);
    };
  }

  /* The card is rebuilt on every render, so the toggle is wired here rather
     than cached in cacheEls. */
  function wireFindingsToggle() {
    var btn = $("findings-toggle"), panel = $("findings-full");
    if (!btn || !panel) return;
    btn.addEventListener("click", function () {
      var open = panel.hidden;
      panel.hidden = !open;
      btn.setAttribute("aria-expanded", String(open));
      btn.textContent = open ? T.collapseFindings : T.expandFindings;
    });
  }

  /* ===== fix pipeline: stage 2 (design) → 4 (apply) → 5 (QA) =====
     The report view exposes a "Propose fixes" button. It runs Stage 2, shows the
     design_direction + per-signal proposals, then "Apply approved fixes" runs
     Stage 4 (apply) and Stage 5 (QA) with up to two automatic reapply rounds —
     the loop the server also caps. MVP auto-approves the applicable proposals. */
  var currentScanId = null;
  var currentApplicable = 0; /* how many proposals are auto-applicable — sizes the apply split */
  var transformTotal = 0;    /* number of files the redesign pass walks through */

  var P = he ? {
    propose: "שדרג ועצב מחדש", proposing: "משדרג ומעצב את האתר מחדש…",
    transformDone: "העיצוב מחדש הושלם — אפשר להוריד ולראות את התוצאה.",
    rebuildSpec: "לומד את האתר — מה יש בו בדיוק…",
    rebuildShell: "בונה את שפת העיצוב (צבעים, פונטים, מבנה)…",
    rebuildSection: function (d, t) { return "בונה מאפס — סקשן " + d + " מתוך " + t + "…"; },
    rebuildDone: "האתר נבנה מחדש מאפס — אפשר להוריד ולראות את התוצאה.",
    /* propose one → approve → build */
    addFeatures: "הצע פיצ'ר חדש",
    featuresProposing: "קורא ומבין את האתר — חושב על פיצ'ר…",
    featureBuilding: "בונה את הפיצ'ר…",
    featureProposalTitle: "הפיצ'ר המוצע",
    featureBuild: "בנה את זה",
    featureReject: "הצע אחר",
    featuresTitle: "הפיצ'ר שנוסף",
    featuresDone: "הפיצ'ר נוסף — אפשר להוריד ולראות.",
    /* interactive progress */
    rbStepUnderstand: "מבין את האתר",
    rbStepDesign: "בונה שפת עיצוב",
    rbStepSection: function (i) { return "בונה סקשן " + i; },
    rbStepAssemble: "מרכיב את האתר",
    /* AI score before/after */
    scoreScanning: function (d, t) { return t ? "מודד כמה AI האתר עכשיו — מעבר " + d + " מתוך " + t + "…" : "מודד כמה AI האתר עכשיו…"; },
    scoreTitle: "כמה AI האתר",
    scoreHint: "0 = אנושי לגמרי · 100 = AI מובהק",
    scoreBefore: "לפני",
    scoreAfter: "אחרי",
    scoreImproved: function (d) { return "ירידה של " + d + " נקודות ברמת ה-AI."; },
    scoreSame: "אין שינוי מדיד בציון.",
    scoreWorse: function (d) { return "עלייה של " + d + " נקודות — כדאי לבדוק."; },
    designTitle: "כיוון עיצובי", proposalsTitle: function (n) { return "הצעות תיקון (" + n + ")"; },
    apply: "החל תיקונים מאושרים", applying: "מחיל תיקונים…", qaRunning: "בקרת איכות…",
    qaPass: "עבר בקרת איכות", qaFail: "בקרת האיכות מצאה בעיות — מריץ סבב תיקון…",
    needsHuman: "חלק מהתיקונים דורשים בדיקה ידנית.",
    qaSkipped: "בקרת האיכות לא הושלמה — אבל התיקונים כבר הוחלו. אפשר להוריד ולבדוק.",
    applied: function (a, t) { return "הוחלו " + a + " מתוך " + t + " תיקונים"; },
    detectPass: function (d, t) {
      return d === 0 ? "הסריקה ארוכה מהצפוי — מפצל לחלקים קטנים יותר..."
                     : "סורק — מעבר " + d + " מתוך " + t;
    },
    designPass: function (d, t) { return "מגבש הצעות — מעבר " + d + " מתוך " + t; },
    applyPass: function (d, t) { return "מחיל תיקונים — מעבר " + d + " מתוך " + t; },
    transformPass: function (d, t) { return "משדרג ומעצב מחדש — שלב " + d + " מתוך " + t; },
    rehunting: "מחפש לעומק — עוד סימני AI...",
    gapPass: "משלים סימנים שלא נבדקו…",
    zipBuilding: "מכין את הקובץ...",
    zipReady: function (n) { return "הורד. " + n + " קבצים שונו."; },
    prOpening: "פותח Pull Request...",
    prDone: "ה-Pull Request נפתח. פתחו אותו, קראו את השינויים, ורק אז מזגו.",
    prNoGithub: "הסריקה הזאת לא הגיעה מ-GitHub, אז אפשר רק להוריד ZIP.",
    prNoToken: "GitHub לא מחובר. התחברו עם GitHub כדי לפתוח Pull Request.",
    prQaFailed: function (score) {
      return "בדיקת האיכות לא עברה" + (score != null ? " (ציון " + score + " מתוך 100)" : "") +
        ". אפשר לפתוח Pull Request בכל זאת — הוא ייפתח בענף נפרד ותוכלו לקרוא את השינויים לפני מיזוג. לפתוח?";
    },
    noFixes: "אין תיקונים אוטומטיים ישימים בסריקה הזו.",
    err: "משהו השתבש בשלב התיקון. נסו שוב.", strategic: "לא יושם — לא נמצא עוגן מדויק בקוד",
    palette: "פלטה", typography: "טיפוגרפיה", layout: "עיקרון פריסה", personality: "אופי"
  } : {
    propose: "Redesign the site", proposing: "Redesigning the site…",
    transformDone: "Redesign complete — download to see the result.",
    rebuildSpec: "Learning the site — exactly what it contains…",
    rebuildShell: "Building the design language (colors, fonts, layout)…",
    rebuildSection: function (d, t) { return "Rebuilding from scratch — section " + d + " of " + t + "…"; },
    rebuildDone: "The site was rebuilt from scratch — download to see the result.",
    /* propose one → approve → build */
    addFeatures: "Suggest a new feature",
    featuresProposing: "Reading & understanding the site — thinking of a feature…",
    featureBuilding: "Building the feature…",
    featureProposalTitle: "The proposed feature",
    featureBuild: "Build it",
    featureReject: "Suggest another",
    featuresTitle: "Feature added",
    featuresDone: "The feature was added — download to see it.",
    /* interactive progress */
    rbStepUnderstand: "Understanding the site",
    rbStepDesign: "Building the design language",
    rbStepSection: function (i) { return "Building section " + i; },
    rbStepAssemble: "Assembling the site",
    /* AI score before/after */
    scoreScanning: function (d, t) { return t ? "Measuring how AI the site is now — pass " + d + " of " + t + "…" : "Measuring how AI the site is now…"; },
    scoreTitle: "How AI the site is",
    scoreHint: "0 = fully human · 100 = obvious AI",
    scoreBefore: "Before",
    scoreAfter: "After",
    scoreImproved: function (d) { return d + " points less AI."; },
    scoreSame: "No measurable change in score.",
    scoreWorse: function (d) { return d + " points higher — worth a look."; },
    designTitle: "Design direction", proposalsTitle: function (n) { return "Fix proposals (" + n + ")"; },
    apply: "Apply approved fixes", applying: "Applying fixes…", qaRunning: "Running QA…",
    qaPass: "Passed QA", qaFail: "QA found issues — running a fix round…",
    needsHuman: "Some fixes need manual review.",
    qaSkipped: "QA couldn't finish — but the fixes are already applied. You can download and inspect.",
    applied: function (a, t) { return "Applied " + a + " of " + t + " fixes"; },
    detectPass: function (d, t) {
      return d === 0 ? "Taking longer than expected — splitting into smaller passes..."
                     : "Scanning — pass " + d + " of " + t;
    },
    designPass: function (d, t) { return "Building proposals — pass " + d + " of " + t; },
    applyPass: function (d, t) { return "Applying fixes — pass " + d + " of " + t; },
    transformPass: function (d, t) { return "Redesigning — step " + d + " of " + t; },
    rehunting: "Digging deeper — more AI signals...",
    gapPass: "Filling in signals that were skipped…",
    zipBuilding: "Preparing the file...",
    zipReady: function (n) { return "Downloaded. " + n + " files changed."; },
    prOpening: "Opening a pull request...",
    prDone: "Pull request opened. Open it, read the diff, and only then merge.",
    prNoGithub: "This scan didn't come from GitHub, so only the ZIP download applies.",
    prNoToken: "GitHub isn't connected. Sign in with GitHub to open a pull request.",
    prQaFailed: function (score) {
      return "QA did not pass" + (score != null ? " (score " + score + "/100)" : "") +
        ". You can still open a pull request — it goes to a separate branch and you can read the diff before merging. Open it?";
    },
    noFixes: "No auto-applicable fixes in this scan.",
    err: "Something went wrong during the fix stage. Try again.", strategic: "Not applied — no exact anchor in the code",
    palette: "Palette", typography: "Typography", layout: "Layout principle", personality: "Personality"
  };

  function fmtReason(e) {
    var r = e && e.body && e.body.error;
    return r ? " (" + r + ")" : "";
  }

  function renderFixPipeline(scan) {
    if (!els["fix-pipeline"]) return;
    currentScanId = scan.id;
    els["design-direction"].hidden = true;
    els["proposals"].hidden = true;
    els["fix-actions"].hidden = true;
    els["apply-result"].hidden = true;
    els["qa-result"].hidden = true;
    // Opening another scan must not leave the previous one's delivery buttons
    // on screen — they act on currentScanId and would package the wrong run.
    if (els["deliver-actions"]) els["deliver-actions"].hidden = true;
    if (els["deliver-result"]) els["deliver-result"].hidden = true;
    els["fix-hint"].textContent = "";
    els["propose-fixes"].hidden = false;
    els["propose-fixes"].disabled = false;
    els["propose-fixes"].textContent = P.propose;
    if (els["add-features"]) { els["add-features"].textContent = P.addFeatures; els["add-features"].disabled = false; els["add-features"].hidden = false; }
    if (els["features-result"]) els["features-result"].hidden = true;
    if (els["rb-progress"]) els["rb-progress"].hidden = true;
    if (els["score-delta"]) els["score-delta"].hidden = true;
    /* a scan opened from history must not inherit the previous one's rejects */
    featureRejects = [];
    featureAttempts = 0;
    /* a scan re-opened from history may already carry a measured after-score */
    if (scan.ai_fingerprint_score_after != null) {
      renderScoreDelta(
        { ai_fingerprint_score: scan.ai_fingerprint_score },
        { ai_fingerprint_score: scan.ai_fingerprint_score_after }
      );
    }
    /* a scan opened from history may already carry a design direction (from a
       redesign) and/or proposals (from the older patch flow) */
    if (scan.design_direction) renderDesign(scan.design_direction);
    if (scan.proposals && scan.proposals.length) renderProposals(scan.proposals);
    restoreDelivery(scan);
  }

  /* Everything the pipeline produced is persisted, so reopening a finished scan
     must show its result — and above all the download button — without paying
     for a single model call again. Anything at or past "applied" has an edited
     bundle in Storage, which is all the packaging step needs. */
  var DELIVERABLE = ["applied", "qa", "qa_passed", "qa_failed", "needs_human"];

  /* Every file the pipeline can write under scans/<user>/<scan>/. Deleting an
     audit must remove all of them; see deleteScan. */
  var SCAN_ARTEFACTS = [
    "bundle.txt", "edited-bundle.txt", "features.json",
    "spec.json", "shell.json", "rebuild-sections.json"
  ];
  function restoreDelivery(scan) {
    if (DELIVERABLE.indexOf(scan.pipeline_status) === -1) return;

    var log = scan.change_log || [];
    if (log.length) {
      var applied = log.filter(function (c) { return c.applied; }).length;
      renderApplyResult({ fixes_applied: applied, fixes_total: log.length });
    }

    var v = scan.qa_verdict;
    if (v) {
      var score = v.human_quality_score;
      var suffix = (score != null ? " · " + esc(String(score)) + "/100" : "");
      els["qa-result"].hidden = false;
      els["qa-result"].innerHTML = v.pass
        ? '<p class="qa-pass">' + esc(P.qaPass) + suffix + "</p>"
        : '<p class="qa-human">' + esc(P.needsHuman) + suffix + "</p>";
    }
    showDeliver();
  }

  function renderDesign(dd) {
    if (!dd) return;
    var pal = (dd.brand_palette || []).map(function (c) {
      return '<span class="tok" dir="ltr"><i style="background:' + esc(c.hex) + '"></i>' +
        esc((c.token || c.role || "") + " " + (c.hex || "")) + "</span>";
    }).join("");
    var typ = dd.typography ? esc((dd.typography.heading || "") + " / " + (dd.typography.body || "")) : "";
    els["design-direction"].innerHTML = "<h3>" + esc(P.designTitle) + "</h3>" +
      '<p class="dd-line"><b>' + esc(P.palette) + ":</b> " + pal + "</p>" +
      '<p class="dd-line"><b>' + esc(P.typography) + ":</b> " + typ + "</p>" +
      '<p class="dd-line"><b>' + esc(P.layout) + ":</b> " + esc(dd.layout_principle || "") + "</p>" +
      '<p class="dd-line"><b>' + esc(P.personality) + ":</b> " + esc((dd.personality || []).join(", ")) + "</p>" +
      (dd.rationale ? '<p class="dd-rationale">' + esc(dd.rationale) + "</p>" : "");
    els["design-direction"].hidden = false;
  }

  function renderProposals(list) {
    var applicable = list.filter(function (p) { return p.applicable_edit; });
    currentApplicable = applicable.length;
    els["proposals"].innerHTML = "<h3>" + esc(P.proposalsTitle(list.length)) + "</h3>" +
      '<ul class="prop-list">' + list.map(function (p) {
        var strategic = !p.applicable_edit;
        var head = "#" + esc(String(p.signal_id)) + " · " + esc(p.fix_type || "") + (p.risk ? " · " + esc(p.risk) : "");
        var code = (p.old_code && p.sample_new_code)
          ? '<div class="prop-diff" dir="ltr"><code class="old">' + esc(clip(String(p.old_code), 120)) +
            '</code><code class="new">' + esc(clip(String(p.sample_new_code), 120)) + "</code></div>"
          : "";
        var tag = strategic ? '<span class="prop-strategic">' + esc(P.strategic) + "</span>" : "";
        return '<li class="prop' + (strategic ? " is-strategic" : "") + '">' +
          '<div class="prop-head" dir="ltr">' + head + "</div>" +
          '<div class="prop-rationale">' + esc(p.rationale || "") + "</div>" + code + tag + "</li>";
      }).join("") + "</ul>";
    els["proposals"].hidden = false;
    els["propose-fixes"].hidden = true;
    if (applicable.length) {
      els["apply-fixes"].textContent = P.apply;
      els["fix-actions"].hidden = false;
    } else {
      els["fix-hint"].textContent = P.noFixes;
    }
  }

  /* Bold "fix every present signal" proposals are output-heavy, and OUTPUT — not
     input — is what races the function's 150s wall clock. So size the split to
     the number of present signals (aim for ~5 per pass), and if a pass still
     times out, double the split and start over. design resets its proposals on
     part 1, so restarting is safe and never duplicates. */
  function runDesign(parts) {
    return designPass(1, parts).catch(function (e) {
      var msg = (e && e.body && e.body.error) || "";
      if (String(msg).indexOf("stage_timeout") === -1 || parts >= 12) throw e;
      return runDesign(Math.min(12, parts * 2));
    });
  }

  /* ===== TransformDesigner: whole-file redesign (the primary flow) =====
     One server call per file (each a fresh 150s budget); the design direction is
     locked on the first file and reused for the rest so the site stays coherent.
     No proposals, no per-signal patches, no human step — the file is rewritten. */
  function transformPass(n) {
    var text = P.transformPass(n, transformTotal || n);
    els["fix-hint"].textContent = text;
    /* the file count only arrives with the first response */
    if (transformTotal) prog.to(text, ((n - 1) / transformTotal) * 100);
    else prog.estimate(text, 60000, 20);
    return invokeFn("transform", { scan_id: currentScanId, part: n }).then(function (data) {
      transformTotal = (data && data.parts) || transformTotal;
      if (transformTotal) prog.to(null, (n / transformTotal) * 100);
      if (data && data.done) return data;
      return transformPass(n + 1);
    });
  }

  function transformSite() {
    if (!currentScanId) return;
    els["propose-fixes"].disabled = true;
    els["proposals"].hidden = true;
    els["fix-actions"].hidden = true;
    if (els["score-delta"]) els["score-delta"].hidden = true;
    els["fix-hint"].textContent = P.proposing;
    transformTotal = 0;
    pipelineProgress(P.proposing);
    transformPass(1).then(function (data) {
      prog.done();
      els["propose-fixes"].hidden = true;
      renderDesign(data && data.design_direction);
      showDeliver(); /* the redesigned bundle is saved — offer download / PR */
      return runAfterScan(); /* same measured before/after the rebuild flow shows */
    }).then(function () {
      hideProgress();
      els["fix-hint"].textContent = P.transformDone;
    }).catch(function (e) {
      hideProgress();
      els["fix-hint"].textContent = P.err + " [transform]" + fmtReason(e);
      els["propose-fixes"].disabled = false;
    });
  }

  /* Every wait inside the report view shares one bar, in #rb-progress. */
  function pipelineProgress(text) { prog.start(els["rb-progress"], text); }
  function hideProgress() { prog.hide(); }

  function reenableFixButtons() {
    if (els["rebuild-site"]) els["rebuild-site"].disabled = false;
    if (els["add-features"]) els["add-features"].disabled = false;
    if (els["propose-fixes"]) els["propose-fixes"].disabled = false;
  }
  function busyFixButtons() {
    if (els["rebuild-site"]) els["rebuild-site"].disabled = true;
    if (els["add-features"]) els["add-features"].disabled = true;
    if (els["propose-fixes"]) els["propose-fixes"].disabled = true;
  }

  /* ===== honest AI score: re-run the SAME audit on the rebuilt/updated site
     (detect mode:"after") and show before → after. The scoring is the exact same
     deterministic, weight-based formula used for the original scan, so the two
     numbers are directly comparable and the "after" is measured, not asserted. */
  function afterScanPass(n, total) {
    els["fix-hint"].textContent = P.scoreScanning(n, total);
    prog.to(P.scoreScanning(n, total), ((n - 1) / total) * 100);
    return invokeFn("detect", { scan_id: currentScanId, mode: "after", part: n, parts: total })
      .then(function (data) {
        prog.to(null, (n / total) * 100);
        if (data && data.done) return data;
        return afterScanPass(n + 1, total);
      });
  }
  function runAfterScan() {
    els["fix-hint"].textContent = P.scoreScanning(0, 0);
    pipelineProgress(P.scoreScanning(0, 0));
    return afterScanPass(1, 3).then(function (data) {
      renderScoreDelta(data && data.before, data && data.after);
      return data;
    }).catch(function () {
      /* non-fatal: the rebuild already delivered; we just couldn't measure after */
      return null;
    });
  }
  function renderScoreDelta(before, after) {
    var el = els["score-delta"];
    if (!el || !after || after.ai_fingerprint_score == null) return;
    var b = (before && before.ai_fingerprint_score != null) ? before.ai_fingerprint_score : null;
    var a = after.ai_fingerprint_score;
    var delta = b == null ? null : (b - a); /* positive = less AI = better */
    var msg = delta == null ? "" :
      (delta > 0 ? P.scoreImproved(delta) : (delta < 0 ? P.scoreWorse(-delta) : P.scoreSame));
    el.hidden = false;
    el.innerHTML =
      "<h3>" + esc(P.scoreTitle) + "</h3>" +
      '<p class="score-hint">' + esc(P.scoreHint) + "</p>" +
      '<div class="score-ba">' +
        (b != null ? '<div class="score-chip"><span class="score-k">' + esc(P.scoreBefore) +
          '</span><span class="score-v" dir="ltr">' + esc(String(b)) + "</span></div>" : "") +
        '<div class="score-chip is-after"><span class="score-k">' + esc(P.scoreAfter) +
          '</span><span class="score-v" dir="ltr">' + esc(String(a)) + "</span></div>" +
      "</div>" +
      (msg ? '<p class="score-msg">' + esc(msg) + "</p>" : "");
  }

  /* ===== RebuildDesigner: understand the site, then build it again from
     scratch in our own clean format (the flagship flow). One server call per
     step (spec → shell → one per section), each a fresh 150s budget; the final
     step assembles a complete, self-contained page. Progress is shown live. ===== */
  var rebuildTotal = 0;
  var rbSectionNames = null;
  /* og:url, og:image and canonical are the only checks we cannot satisfy from
     the source alone: they need the address the site actually lives at. */
  function siteUrlValue() {
    var el = els["site-url"];
    return el && el.value ? el.value.trim() : "";
  }
  function rbLabels() {
    var labels = [P.rbStepUnderstand, P.rbStepDesign];
    if (rbSectionNames) {
      rbSectionNames.forEach(function (nm, i) { labels.push(nm || P.rbStepSection(i + 1)); });
    }
    return labels;
  }
  function rebuildPass(n, attempt) {
    attempt = attempt || 1;
    /* Step n names itself: the spec pass first, then the shell, then one per
       section using the section's own heading once the spec has told us them. */
    var labels = rbLabels();
    var text = labels[n - 1] || P.rbStepSection(n - 2);
    /* The total is only known after part 1 returns, so the spec pass is the one
       step with nothing to measure against. */
    if (rebuildTotal) prog.to(text, ((n - 1) / rebuildTotal) * 100);
    else prog.estimate(text, 60000, 20);
    els["fix-hint"].textContent = n === 1 ? P.rebuildSpec
      : (n === 2 ? P.rebuildShell
                 : P.rebuildSection(n - 2, rebuildTotal ? rebuildTotal - 2 : n - 2));
    /* The address only matters on part 1 — that is where it gets stored, and
       every later part reads it back from the scan row. */
    var payload = { scan_id: currentScanId, part: n };
    if (n === 1) payload.site_url = siteUrlValue();
    return invokeFn("rebuild", payload).then(function (data) {
      rebuildTotal = (data && data.parts) || rebuildTotal;
      if (n === 1 && data && data.spec_summary && data.spec_summary.sections) {
        rbSectionNames = data.spec_summary.sections.map(function (s) { return s.heading || s.type || ""; });
      }
      if (rebuildTotal) prog.to(null, (n / rebuildTotal) * 100);
      if (data && data.done) return data;
      return rebuildPass(n + 1);
    }).catch(function (e) {
      /* Every finished part is persisted server-side (spec.json, shell.json,
         rebuild-sections.json is merged by index), so re-running THIS part
         never repeats earlier work and can't duplicate a section. When a part
         overruns the function's budget — a load spike, not a dead end — retry
         the same part a few times to ride it out, then give up so a genuinely
         stuck part can't loop forever and burn money. */
      var msg = (e && e.body && e.body.error) || "";
      if (String(msg).indexOf("stage_timeout") === -1 || attempt >= 4) throw e;
      return rebuildPass(n, attempt + 1);
    });
  }

  function rebuildSite() {
    if (!currentScanId) return;
    busyFixButtons();
    els["proposals"].hidden = true;
    els["fix-actions"].hidden = true;
    if (els["score-delta"]) els["score-delta"].hidden = true;
    rebuildTotal = 0;
    rbSectionNames = null;
    pipelineProgress(P.rbStepUnderstand);
    rebuildPass(1).then(function (data) {
      prog.done();
      renderDesign(data && data.design_direction);
      showDeliver(); /* the rebuilt bundle is saved — offer download / PR */
      return runAfterScan(); /* measure the honest before/after AI score */
    }).then(function () {
      hideProgress();
      els["fix-hint"].textContent = P.rebuildDone;
      reenableFixButtons();
    }).catch(function (e) {
      hideProgress();
      els["fix-hint"].textContent = P.err + " [rebuild]" + fmtReason(e);
      reenableFixButtons();
    });
  }

  /* ===== FeatureDesigner: propose one feature, build it only once approved =====
     Nothing reaches the user's site until they press "build". They get one
     alternative if the first idea misses — two proposals is the whole budget —
     and one feature per scan, so the button goes away once it is built. */
  var FEATURE_ATTEMPTS = 2;
  var featureRejects = [];  /* names the user turned down, sent back so the model doesn't repeat them */
  var featureAttempts = 0;

  function renderFeatureProposal(feature) {
    var canReject = featureAttempts < FEATURE_ATTEMPTS;
    els["features-result"].hidden = false;
    els["features-result"].innerHTML =
      "<h3>" + esc(P.featureProposalTitle) + "</h3>" +
      '<div class="feat-proposal">' +
        '<p class="feat-name">' + esc(feature.name || "") + "</p>" +
        '<p class="feat-summary">' + esc(feature.summary || "") + "</p>" +
        '<div class="feat-actions">' +
          '<button type="button" class="btn btn-primary" id="feature-build">' + esc(P.featureBuild) + "</button>" +
          (canReject
            ? '<button type="button" class="btn" id="feature-reject">' + esc(P.featureReject) + "</button>"
            : "") +
        "</div>" +
      "</div>";
    /* the card is rebuilt on every proposal, so its buttons are wired here */
    $("feature-build").addEventListener("click", buildFeature);
    if (canReject) {
      $("feature-reject").addEventListener("click", function () {
        featureRejects.push(feature.name || "");
        proposeFeature();
      });
    }
  }

  function featureCardBusy(busyNow) {
    var build = $("feature-build"), reject = $("feature-reject");
    if (build) build.disabled = busyNow;
    if (reject) reject.disabled = busyNow;
  }

  function proposeFeature() {
    if (!currentScanId) return;
    featureAttempts += 1;
    featureCardBusy(true);
    busyFixButtons();
    if (els["score-delta"]) els["score-delta"].hidden = true;
    els["fix-hint"].textContent = P.featuresProposing;
    pipelineProgress(P.featuresProposing);
    prog.estimate(P.featuresProposing, 30000, 92);
    invokeFn("features", {
      scan_id: currentScanId, action: "propose", exclude: featureRejects
    }).then(function (data) {
      prog.done();
      hideProgress();
      els["fix-hint"].textContent = "";
      renderFeatureProposal((data && data.feature) || {});
      reenableFixButtons();
    }).catch(function (e) {
      els["fix-hint"].textContent = P.err + " [features]" + fmtReason(e);
      featureCardBusy(false);
      reenableFixButtons();
    });
  }

  function buildFeature() {
    if (!currentScanId) return;
    featureCardBusy(true);
    busyFixButtons();
    els["fix-hint"].textContent = P.featureBuilding;
    pipelineProgress(P.featureBuilding);
    prog.estimate(P.featureBuilding, 75000, 92);
    invokeFn("features", { scan_id: currentScanId, action: "build" }).then(function (data) {
      var feat = (data && data.feature) || {};
      prog.done();
      els["features-result"].innerHTML =
        "<h3>" + esc(P.featuresTitle) + "</h3>" +
        '<div class="feat-proposal">' +
          '<p class="feat-name">' + esc(feat.name || "") + "</p>" +
          '<p class="feat-summary">' + esc(feat.summary || "") + "</p>" +
        "</div>";
      els["fix-hint"].textContent = P.featuresDone;
      /* one feature per scan — the way back is a new scan */
      els["add-features"].hidden = true;
      showDeliver();
      return runAfterScan(); /* the honest before/after AI score */
    }).then(function () {
      reenableFixButtons();
    }).catch(function (e) {
      hideProgress();
      els["fix-hint"].textContent = P.err + " [features]" + fmtReason(e);
      featureCardBusy(false);
      reenableFixButtons();
    });
  }


  function proposeFixes() {
    if (!currentScanId) return;
    els["propose-fixes"].disabled = true;
    els["fix-hint"].textContent = P.proposing;
    sb.from("scans").select("present_count").eq("id", currentScanId).single()
      .then(function (r) {
        var n = (r && r.data && r.data.present_count) || 0;
        var parts = Math.min(12, Math.max(3, Math.ceil(n / 5)));
        return runDesign(parts);
      })
      .then(function (data) {
        els["fix-hint"].textContent = "";
        renderDesign(data && data.design_direction);
        /* design keeps its payload small (counts only); read the stored proposals */
        return sb.from("scans").select("design_direction,proposals").eq("id", currentScanId).single();
      }).then(function (r) {
        if (r && r.data) { renderDesign(r.data.design_direction); renderProposals(r.data.proposals || []); }
      }).catch(function (e) {
        els["fix-hint"].textContent = P.err + " [design]" + fmtReason(e);
        els["propose-fixes"].disabled = false;
      });
  }

  /* Apply is split into client-driven passes for the same reason detect/design
     are: each pass is a SEPARATE HTTP call with its own 150s budget, so bold
     whole-file rewrites can't blow one call. Each pass builds on the previous
     one's edits (server-side), so dependent fixes still see earlier work. */
  function applyPass(n, total) {
    els["apply-result"].innerHTML = "<p>" + esc(P.applyPass(n, total)) + "</p>";
    return invokeFn("apply", { scan_id: currentScanId, part: n, parts: total })
      .then(function (data) {
        if (data && data.done) return data;
        return applyPass(n + 1, total);
      });
  }

  function runApply(total) {
    return applyPass(1, total).catch(function (e) {
      var msg = (e && e.body && e.body.error) || "";
      if (String(msg).indexOf("stage_timeout") === -1 || total >= 12) throw e;
      return runApply(Math.min(12, total * 2));
    });
  }

  function applyFixes() {
    if (!currentScanId) return;
    els["fix-actions"].hidden = true;
    els["apply-result"].hidden = false;
    els["apply-result"].innerHTML = "<p>" + esc(P.applying) + "</p>";
    /* Count applicable fixes from the server (robust after a reload), then split
       ~4 per pass so each call stays well under the limit even for bold edits. */
    sb.from("scans").select("proposals").eq("id", currentScanId).single()
      .then(function (r) {
        var props = (r && r.data && r.data.proposals) || [];
        var applicable = props.filter(function (p) { return p.applicable_edit; }).length ||
          currentApplicable || 1;
        var total = Math.min(12, Math.max(1, Math.ceil(applicable / 4)));
        return runApply(total);
      })
      .then(function (data) {
        renderApplyResult(data);
        return runQa();
      }).catch(function (e) {
        els["apply-result"].innerHTML = "<p>" + esc(P.err + " [apply]" + fmtReason(e)) + "</p>";
      });
  }

  function renderApplyResult(data) {
    els["apply-result"].hidden = false;
    els["apply-result"].innerHTML = "<p>" +
      esc(P.applied(data.fixes_applied, data.fixes_total)) + "</p>";
  }

  /* ===== stage 6: hand the result back to the user ===== */
  function showDeliver() {
    if (els["deliver-actions"]) els["deliver-actions"].hidden = false;
  }

  function deliverSay(msg, cls) {
    var el = els["deliver-result"];
    if (!el) return;
    el.hidden = false;
    el.innerHTML = "<p" + (cls ? ' class="' + cls + '"' : "") + ">" + esc(msg) + "</p>";
  }

  /* Builds the ZIP in the browser from the assembled project the `package`
     function returns. Nothing is written anywhere on the way — the user gets a
     file and decides what to do with it. */
  function downloadZip() {
    deliverSay(P.zipBuilding);
    Promise.all([
      invokeFn("package", { scan_id: currentScanId }),
      import(JSZIP_CDN)
    ]).then(function (r) {
      var data = r[0], JSZip = r[1].default || r[1];
      var zip = new JSZip();
      data.files.forEach(function (f) { zip.file(f.path, f.content); });

      /* A report beside the code, so the ZIP is self-explanatory later when
         the browser tab that produced it is long gone. */
      zip.file("MIHUTZ-LATAVNIT-REPORT.json", JSON.stringify({
        source: data.source_ref,
        score_before: data.score_before,
        score_after: data.score_after,
        pipeline_status: data.pipeline_status,
        changed_files: data.changed_files,
        change_log: data.change_log,
        qa_verdict: data.qa_verdict,
        design_direction: data.design_direction
      }, null, 2));

      return zip.generateAsync({ type: "blob" }).then(function (blob) {
        var name = String(data.source_ref || "project").replace(/[^\w.-]+/g, "-");
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url;
        a.download = name + "-fixed.zip";
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        deliverSay(P.zipReady((data.changed_files || []).length));
      });
    }).catch(function (e) {
      deliverSay(P.err + fmtReason(e));
    });
  }

  /* Opens a PR on a NEW branch. The server refuses outright when QA failed
     unless we say we know — so the confirm() below is the user making that
     call knowingly, not a checkbox they can miss. */
  function pushToGithub(ack) {
    deliverSay(P.prOpening);
    invokeFn("push-github", { scan_id: currentScanId, acknowledge_qa_failed: !!ack })
      .then(function (data) {
        var el = els["deliver-result"];
        el.hidden = false;
        el.innerHTML = "<p>" + esc(P.prDone) + ' <a href="' + esc(data.pull_request_url) +
          '" target="_blank" rel="noopener">#' + esc(String(data.pull_request_number)) +
          "</a></p>";
      })
      .catch(function (e) {
        var body = e && e.body;
        var code = body && body.error;
        if (code === "qa_did_not_pass" && !ack) {
          if (window.confirm(P.prQaFailed(body.human_quality_score))) pushToGithub(true);
          else deliverSay("");
          return;
        }
        if (code === "not_a_github_scan") return deliverSay(P.prNoGithub);
        if (code === "github_not_connected") return deliverSay(P.prNoToken);
        deliverSay(P.err + fmtReason(e));
      });
  }

  function runQa() {
    els["qa-result"].hidden = false;
    els["qa-result"].innerHTML = "<p>" + esc(P.qaRunning) + "</p>";
    return invokeFn("qa", { scan_id: currentScanId }).then(function (data) {
      var score = (data.verdict && data.verdict.human_quality_score);
      if (data.pass) {
        els["qa-result"].innerHTML = '<p class="qa-pass">' + esc(P.qaPass) +
          (score != null ? " · " + esc(String(score)) + "/100" : "") + "</p>";
        showDeliver();
        return;
      }
      if (data.can_reapply) {
        els["qa-result"].innerHTML = "<p>" + esc(P.qaFail) + "</p>";
        var ids = ((data.verdict && data.verdict.recommend_reapply) || [])
          .map(function (x) { return x.signal_id; });
        return invokeFn("apply", { scan_id: currentScanId, reapply_signal_ids: ids })
          .then(function (again) {
            /* A reapply round changes how many fixes survive. Without this the
               panel keeps showing the FIRST apply's count — which is how a run
               that ended with 4 fixes and a failing QA score reported "9 of 12"
               and read as a success. */
            renderApplyResult(again);
            return runQa();
          });
      }
      /* Terminal: QA rejected it and there are no rounds left. The delivery
         buttons still appear — the user is entitled to inspect the output —
         but the score is shown so the decision is an informed one. */
      els["qa-result"].innerHTML = '<p class="qa-human">' + esc(P.needsHuman) +
        (score != null ? " · " + esc(String(score)) + "/100" : "") + "</p>";
      showDeliver();
    }).catch(function (e) {
      /* QA is a safety check, not a gate — the fixes are already applied
         deterministically (exact string replacements). If QA can't finish
         (e.g. a very large diff), don't block: surface it softly and still let
         the user download and inspect the result. */
      els["qa-result"].innerHTML = '<p class="qa-human">' + esc(P.qaSkipped + fmtReason(e)) + "</p>";
      showDeliver();
    });
  }

  /* ===== recent audits (history) ===== */
  var historyRows = [];
  function loadHistory() {
    if (!sb || !user || !els.history) return;
    sb.from("scans")
      .select("id,source_type,source_ref,ai_fingerprint_score,present_count,files_scanned,detection,design_direction,proposals,pipeline_status,change_log,qa_verdict,created_at")
      .eq("user_id", user.id).eq("status", "done")
      .order("created_at", { ascending: false }).limit(20)
      .then(function (r) {
        historyRows = (!r.error && r.data) || [];
        renderHistory();
      }).catch(function () { renderHistory(); });
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
    var empty = !historyRows.length;
    /* the section stays on screen either way — a first-time user should see
       where results will land, not a gap where a section used to be */
    els["history-empty"].hidden = !empty;
    els["history-list"].hidden = empty;
    els["history-all"].hidden = empty || historyRows.length <= HISTORY_PREVIEW;
    if (empty) { els["history-list"].innerHTML = ""; return; }
    renderHistoryInto(historyRows.slice(0, HISTORY_PREVIEW), els["history-list"]);
    if (!els["history-all"].hidden) els["history-all"].textContent = T.allAudits(historyRows.length);
  }

  function renderHistoryInto(rows, target) {
    var chevron = he ? "‹" : "›";
    target.innerHTML = rows.map(function (s) {
      var score = s.ai_fingerprint_score != null ? s.ai_fingerprint_score : 0;
      var ref = s.source_ref || sourceLabel(s.source_type);
      var sub = [sourceLabel(s.source_type), fmtDate(s.created_at)];
      if (s.present_count != null) sub.push(s.present_count + (he ? " סימנים" : " signals"));
      return '<li class="history-item">' +
        '<button type="button" class="history-row" data-id="' + esc(s.id) + '">' +
        '<span class="history-score" dir="ltr">' + esc(String(score)) + "<small>/100</small></span>" +
        '<span class="history-meta">' +
          '<span class="history-ref ltr">' + esc(ref) + "</span>" +
          '<span class="history-sub">' + esc(sub.join(" · ")) + "</span>" +
        "</span>" +
        '<span class="history-open" aria-hidden="true">' + chevron + "</span></button>" +
        '<button type="button" class="history-del" data-del="' + esc(s.id) + '" title="' + esc(T.deleteTitle) +
        '" aria-label="' + esc(T.deleteTitle) + '">✕</button></li>';
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
    Array.prototype.forEach.call(target.querySelectorAll("[data-del]"), function (btn) {
      btn.addEventListener("click", function (ev) {
        ev.stopPropagation();
        deleteScan(btn.getAttribute("data-del"));
      });
    });
  }

  /* Delete an audit (RLS lets a user delete only their own), then clean every
     artefact it left in Storage.

     This used to remove three files and leave spec.json, shell.json and
     rebuild-sections.json behind. Those hold the site's own content, so a user
     who deleted an audit still had their page sitting in our bucket — we
     recovered a deleted site from exactly these leftovers. The list is now the
     complete set the pipeline can write. */
  function deleteScan(id) {
    if (!id || !window.confirm(T.confirmDelete)) return;
    sb.from("scans").delete().eq("id", id).eq("user_id", user.id).then(function (r) {
      if (r.error) { showError(T.errGeneric); return; }
      var base = user.id + "/" + id + "/";
      try {
        sb.storage.from("scans").remove(SCAN_ARTEFACTS.map(function (f) { return base + f; }));
      } catch (e) { /* best-effort */ }
      historyRows = historyRows.filter(function (x) { return x.id !== id; });
      renderHistory();
      if (els["history-dialog"] && els["history-dialog"].open) {
        renderHistoryInto(historyRows, els["history-all-list"]);
      }
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
    else if (reason === "content_loss") {
      /* The one failure the user must be able to act on: name the missing
         things, not just the category. body.detail already reads as a sentence. */
      msg = T.errContentLoss + (body && body.detail ? " (" + body.detail + ")" : "");
    }
    else if (reason === "missing_anthropic_api_key") msg = T.noApiKey;
    else if (reason === "invalid_anthropic_api_key_characters") msg = T.badApiKey;
    else if (e && (e.status === 546 || e.status === 504)) msg = T.errTimeout;
    else if (reason && /anthropic|model|bundle/.test(reason)) msg = T.errDetect;
    /* this is a work tool: never hide the concrete reason behind a generic line */
    else if (reason) msg = T.errGeneric + " (" + reason + ")";
    else {
      /* No JSON {error} body — this is a DB/storage error or a function that
         crashed/timed out without a JSON response. Surface whatever we have
         (HTTP status + message) so we're never flying blind. */
      var detail = "";
      if (e) {
        if (e.status) detail += "status " + e.status;
        if (e.message && e.message !== "invoke_error") detail += (detail ? " · " : "") + e.message;
      }
      if (detail) msg = T.errGeneric + " (" + detail + ")";
    }
    if (e) { try { console.error("[audit flow error]", e, e && e.body); } catch (_) {} }
    showError(msg);
  }

  function showError(msg) { els["err-banner"].textContent = msg; els["err-banner"].hidden = false; }
  function hideError() { els["err-banner"].hidden = true; }

  /* ===== one progress bar for every wait =====
     The label above the bar names the step actually running. A stage that
     reports part/parts drives the fill from real numbers; a stage that is a
     single server call has nothing to report, so it eases toward a ceiling on
     a time estimate and stops there. Only done() reaches 100 — the bar never
     claims a finish that hasn't happened, and never runs backwards. */
  var prog = (function () {
    var host = null, label = "", value = 0, timer = null;
    var clock = null, startedAt = 0, frozen = null;

    function stop() { if (timer) { clearInterval(timer); timer = null; } }
    function stopClock() { if (clock) { clearInterval(clock); clock = null; } }

    /* seconds under a minute, m:ss above it */
    function elapsed() {
      var sec = frozen != null ? frozen : Math.floor((Date.now() - startedAt) / 1000);
      if (sec < 60) return sec + "s";
      return Math.floor(sec / 60) + ":" + ("0" + (sec % 60)).slice(-2);
    }

    function paintTime() {
      if (!host) return;
      host.querySelector(".prog-time").textContent = elapsed();
    }

    function paint() {
      if (!host) return;
      var v = Math.max(0, Math.min(100, value));
      var track = host.querySelector(".prog-track");
      host.querySelector(".prog-label").textContent = label;
      host.querySelector(".prog-pct").textContent = Math.round(v) + "%";
      host.querySelector(".prog-fill").style.inlineSize = v + "%";
      track.setAttribute("aria-valuenow", String(Math.round(v)));
      track.setAttribute("aria-label", label);
      paintTime();
    }

    return {
      start: function (container, text) {
        stop(); stopClock();
        if (!container) return;
        container.innerHTML =
          '<p class="prog-head">' +
            '<span class="prog-label"></span>' +
            '<span class="prog-meta mono ltr">' +
              '<span class="prog-pct"></span>' +
              '<span class="prog-time" aria-hidden="true"></span>' +
            "</span>" +
          "</p>" +
          '<div class="prog-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">' +
            '<div class="prog-fill"></div>' +
          "</div>";
        container.hidden = false;
        host = container;
        label = text || "";
        value = 0;
        startedAt = Date.now();
        frozen = null;
        paint();
        /* the clock runs for the whole wait — an honest-percentage stage has
           no other timer keeping the display alive between passes */
        clock = setInterval(paintTime, 1000);
      },
      /* honest position, as an absolute percentage */
      to: function (text, pct) {
        stop();
        if (text != null) label = text;
        if (pct != null) value = Math.max(value, pct);
        paint();
      },
      /* nothing to report: crawl toward `ceiling` over `ms` and hold there */
      estimate: function (text, ms, ceiling) {
        stop();
        if (text != null) label = text;
        var from = value, to = ceiling, t0 = Date.now();
        paint();
        timer = setInterval(function () {
          var k = Math.min(1, (Date.now() - t0) / ms);
          /* close to linear, easing off near the ceiling. A sharper curve
             lands on ~40% within seconds of a minute-long wait, which reads
             as a fake bar rather than a slow one. */
          value = from + (to - from) * (1 - Math.pow(1 - k, 1.5));
          paint();
          if (k >= 1) stop();
        }, 200);
      },
      /* keep the fill, change what it says it is doing */
      say: function (text) { label = text; paint(); },
      done: function () {
        stop(); stopClock();
        frozen = Math.floor((Date.now() - startedAt) / 1000);
        value = 100;
        paint();
      },
      hide: function () {
        stop(); stopClock();
        if (host) { host.hidden = true; host.innerHTML = ""; }
        host = null; label = ""; value = 0; frozen = null;
      }
    };
  })();

  /* ===== ui state ===== */
  function setBusy(v) { busy = v; }

  function showStages() {
    hideError();
    els["app-input"].hidden = true;
    els.history.hidden = true;
    els.report.hidden = true;
    els.loading.hidden = false;
  }

  /* The three client-side prep steps are near-instant, so they only claim the
     first slice of the bar; the audit itself owns the rest and reports its own
     passes through setDetectProgress. */
  var PREP_PCT = [4, 9, 14];
  var DETECT_FLOOR = 15;

  function setStage(i) {
    if (i < 0) { prog.hide(); return; }
    if (i === 0) prog.start(els["scan-progress"], T.scanSteps[0]);
    if (i < 3) { prog.to(T.scanSteps[i], PREP_PCT[i]); return; }
    /* the audit hasn't reported a pass yet — estimate until it does */
    prog.estimate(T.scanSteps[3], 25000, 30);
  }

  function hideStages() {
    els.loading.hidden = true;
    prog.hide();
    els["app-input"].hidden = false;
    els.history.hidden = false;
  }

  /* ===== small utils ===== */
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }
  function clip(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n) + "…" : s; }
  function fmtDate(iso) { try { return new Date(iso).toISOString().slice(0, 10); } catch (e) { return ""; } }

  function wireStatic() {
    if (els["report-back"]) els["report-back"].addEventListener("click", backToInput);
    // Primary flow is now the whole-file redesign (TransformDesigner). The old
    // propose→apply patch handlers stay defined but are no longer wired.
    if (els["rebuild-site"]) els["rebuild-site"].addEventListener("click", rebuildSite);
    if (els["propose-fixes"]) els["propose-fixes"].addEventListener("click", transformSite);
    if (els["apply-fixes"]) els["apply-fixes"].addEventListener("click", applyFixes);
    if (els["add-features"]) els["add-features"].addEventListener("click", proposeFeature);
    if (els["download-zip"]) els["download-zip"].addEventListener("click", downloadZip);
    if (els["push-github"]) els["push-github"].addEventListener("click", function () {
      pushToGithub(false);
    });
  }

  /* return from a report (fresh or from history) to the input + history view */
  function backToInput() {
    els.report.hidden = true;
    els["app-input"].hidden = false;
    els.history.hidden = false;
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
