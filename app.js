(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var feed = $("feed"), empty = $("empty"), hint = $("hint"), counter = $("counter");
  var fab = $("fab"), sheet = $("sheet"), form = $("form"), fileIn = $("file");
  var preview = $("preview"), pickText = $("pickText"), titleIn = $("title");
  var statusEl = $("status"), sendBtn = $("send"), emptyBtn = $("emptyBtn");

  var PAGE = 12;
  var ids = new Set();       // 画面にある投稿のid
  var oldest = null;         // 読み込んだ中で一番古い投稿の時刻
  var ended = false, loading = false, scrolled = false, busy = false;
  var emptyMode = "loading";
  var file = null, previewUrl = null;

  /* ---------- 自分の投稿の削除キー（このブラウザにだけ保存） ---------- */
  var TOKEN_KEY = "hirari.tokens";
  function readTokens() {
    try { return JSON.parse(localStorage.getItem(TOKEN_KEY) || "{}") || {}; } catch (e) { return {}; }
  }
  function saveToken(id, token) {
    try {
      var t = readTokens();
      t[id] = token;
      localStorage.setItem(TOKEN_KEY, JSON.stringify(t));
    } catch (e) { /* 保存できなくても投稿自体は成功している */ }
  }
  function dropToken(id) {
    try {
      var t = readTokens();
      delete t[id];
      localStorage.setItem(TOKEN_KEY, JSON.stringify(t));
    } catch (e) {}
  }

  /* ---------- 表示のヘルパー ---------- */
  function fmtTime(iso) {
    var ms = Date.parse(iso);
    if (isNaN(ms)) return "";
    var m = Math.floor((Date.now() - ms) / 60000);
    if (m < 1) return "たった今";
    if (m < 60) return m + "分前";
    var h = Math.floor(m / 60);
    if (h < 24) return h + "時間前";
    var d = new Date(ms);
    return (d.getMonth() + 1) + "月" + d.getDate() + "日";
  }
  function setStatus(text, isErr) {
    statusEl.textContent = text || "";
    statusEl.className = isErr ? "err" : "";
  }
  function showEmpty(mode) {
    emptyMode = mode;
    var t = $("emptyTitle"), p = $("emptyText");
    if (mode === "none") { empty.hidden = true; return; }
    empty.hidden = false;
    emptyBtn.hidden = true;
    if (mode === "loading") {
      t.textContent = "読み込み中"; p.textContent = "投稿を取りに行っています。";
    } else if (mode === "error") {
      t.textContent = "読み込めませんでした";
      p.textContent = "通信を確認して、もう一度試してください。";
      emptyBtn.textContent = "もう一度読み込む";
      emptyBtn.hidden = false;
    } else {
      t.textContent = "まだ1枚もありません";
      p.textContent = "写真を1枚選ぶだけで投稿できます。最初のイラストを置いてみてください。";
      emptyBtn.textContent = "最初の1枚を投稿する";
      emptyBtn.hidden = false;
    }
  }

  /* ---------- カード ---------- */
  function buildCard(p, eager) {
    var url = "/img/" + p.id;
    var el = document.createElement("article");
    el.className = "card";
    el.dataset.id = p.id;

    var bd = document.createElement("div");
    bd.className = "bd";
    bd.style.backgroundImage = 'url("' + url + '")';

    var img = document.createElement("img");
    img.className = "pic";
    img.alt = p.title || "投稿されたイラスト";
    img.loading = eager ? "eager" : "lazy";
    img.decoding = "async";
    img.src = url;

    var cap = document.createElement("div");
    cap.className = "cap gutter";
    if (p.title) {
      var ttl = document.createElement("p");
      ttl.className = "ttl";
      ttl.textContent = p.title;
      cap.appendChild(ttl);
    }
    var meta = document.createElement("p");
    meta.className = "meta";
    var time = document.createElement("span");
    time.textContent = fmtTime(p.createdAt);
    meta.appendChild(time);

    var mine = readTokens()[p.id];
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "act";
    btn.textContent = mine ? "削除" : "通報";
    var armedText = mine ? "本当に削除する" : "本当に通報する";
    var timer = 0;
    btn.addEventListener("click", function () {
      if (!btn.classList.contains("armed")) {
        btn.classList.add("armed");
        btn.textContent = armedText;
        timer = setTimeout(function () {
          btn.classList.remove("armed");
          btn.textContent = mine ? "削除" : "通報";
        }, 3500);
        return;
      }
      clearTimeout(timer);
      btn.disabled = true;
      if (mine) removeMine(p.id, el, btn); else report(p.id, btn);
    });
    meta.appendChild(btn);
    cap.appendChild(meta);

    el.appendChild(bd);
    el.appendChild(img);
    el.appendChild(cap);
    return el;
  }

  function removeMine(id, el, btn) {
    fetch("/api/posts/" + id, { method: "DELETE", headers: { "x-delete-token": readTokens()[id] || "" } })
      .then(function (r) {
        if (r.status === 204 || r.status === 403) { // 403は既に消えている場合など
          dropToken(id);
          ids.delete(id);
          el.remove();
          if (!feed.children.length) showEmpty(ended ? "empty" : "loading");
          updateCounter();
        } else {
          throw new Error("delete");
        }
      })
      .catch(function () {
        btn.disabled = false;
        btn.classList.remove("armed");
        btn.textContent = "削除";
      });
  }

  function report(id, btn) {
    fetch("/api/posts/" + id + "/report", { method: "POST" })
      .then(function (r) {
        if (r.status === 204) { btn.textContent = "通報しました"; }
        else if (r.status === 429) { btn.textContent = "しばらくしてから"; btn.disabled = false; btn.classList.remove("armed"); }
        else throw new Error("report");
      })
      .catch(function () {
        btn.disabled = false;
        btn.classList.remove("armed");
        btn.textContent = "通報";
      });
  }

  /* ---------- 読み込み ---------- */
  function loadMore() {
    if (loading || ended) return Promise.resolve();
    loading = true;
    var url = "/api/posts?limit=" + PAGE + (oldest ? "&before=" + encodeURIComponent(oldest) : "");
    return fetch(url)
      .then(function (r) { if (!r.ok) throw new Error("load"); return r.json(); })
      .then(function (data) {
        var posts = data.posts || [];
        posts.forEach(function (p) {
          oldest = p.createdAt;
          if (ids.has(p.id)) return;
          ids.add(p.id);
          feed.appendChild(buildCard(p, feed.children.length === 0));
        });
        if (posts.length < PAGE) ended = true;
        showEmpty(feed.children.length ? "none" : "empty");
        updateCounter();
      })
      .catch(function () {
        if (!feed.children.length) showEmpty("error");
      })
      .then(function () { loading = false; });
  }

  function updateCounter() {
    var n = feed.children.length;
    if (!n) { counter.textContent = ""; hint.hidden = true; return; }
    var i = Math.min(n - 1, Math.round(feed.scrollTop / Math.max(1, feed.clientHeight)));
    counter.textContent = (i + 1) + " / " + n + (ended ? "" : "+");
    if (feed.scrollTop > 40) scrolled = true;
    hint.hidden = n < 2;
    hint.style.opacity = scrolled ? "0" : "1";
    if (!ended && i >= n - 4) loadMore();
  }

  var ticking = false;
  feed.addEventListener("scroll", function () {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () { ticking = false; updateCounter(); });
  }, { passive: true });
  window.addEventListener("resize", updateCounter);
  window.addEventListener("keydown", function (e) {
    if (!sheet.hidden) { if (e.key === "Escape") closeSheet(); return; }
    if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.key === "ArrowDown" || e.key === "PageDown" || e.key === " ") { e.preventDefault(); feed.scrollBy({ top: feed.clientHeight }); }
    if (e.key === "ArrowUp" || e.key === "PageUp") { e.preventDefault(); feed.scrollBy({ top: -feed.clientHeight }); }
  });

  /* ---------- 投稿シート ---------- */
  function openSheet() {
    resetForm();
    sheet.hidden = false;
    fileIn.focus();
  }
  function closeSheet() {
    if (busy) return;
    sheet.hidden = true;
    resetForm();
  }
  function resetForm() {
    file = null;
    fileIn.value = "";
    titleIn.value = "";
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
    preview.hidden = true; preview.removeAttribute("src");
    pickText.hidden = false;
    sendBtn.disabled = true;
    setStatus("");
  }
  fab.addEventListener("click", openSheet);
  emptyBtn.addEventListener("click", function () {
    if (emptyMode === "error") { showEmpty("loading"); loadMore(); } else { openSheet(); }
  });
  $("cancel").addEventListener("click", closeSheet);
  sheet.addEventListener("click", function (e) { if (e.target === sheet) closeSheet(); });

  fileIn.addEventListener("change", function () {
    var f = fileIn.files && fileIn.files[0];
    if (!f) return;
    if (!/^image\//.test(f.type)) { setStatus("画像ファイルを選んでください。", true); return; }
    file = f;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(f);
    preview.src = previewUrl;
    preview.hidden = false;
    pickText.hidden = true;
    sendBtn.disabled = false;
    setStatus("");
  });

  // 送る前にブラウザ側でも縮める（通信量を減らし、iPhoneのHEICなども読める形にする）。
  // ブラウザが読めない形式のときは、元のファイルをそのまま送ってサーバーに任せる。
  function shrink(f) {
    var url = URL.createObjectURL(f);
    return new Promise(function (resolve) {
      var i = new Image();
      i.onload = function () {
        try {
          var max = 1600;
          var s = Math.min(1, max / Math.max(i.naturalWidth, i.naturalHeight));
          var w = Math.max(1, Math.round(i.naturalWidth * s));
          var h = Math.max(1, Math.round(i.naturalHeight * s));
          var c = document.createElement("canvas");
          c.width = w; c.height = h;
          var ctx = c.getContext("2d");
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(i, 0, 0, w, h);
          c.toBlob(function (b) { URL.revokeObjectURL(url); resolve(b || f); }, "image/jpeg", 0.88);
        } catch (e) { URL.revokeObjectURL(url); resolve(f); }
      };
      i.onerror = function () { URL.revokeObjectURL(url); resolve(f); };
      i.src = url;
    });
  }

  function errMessage(code, status) {
    if (code === "too_large") return "写真が大きすぎます。別の写真を選んでください。";
    if (code === "bad_image") return "この写真を読み込めませんでした。JPEGかPNGで試してください。";
    if (status === 429 || code === "rate_limited") return "続けて投稿しすぎです。1時間ほど待ってからもう一度試してください。";
    return "投稿できませんでした。もう一度試してください。";
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (!file || busy) return;
    busy = true;
    sendBtn.disabled = true;
    setStatus("アップロード中…");
    shrink(file)
      .then(function (blob) {
        var fd = new FormData();
        fd.append("title", titleIn.value.trim().slice(0, 40));
        fd.append("photo", blob, "photo.jpg"); // ファイルは最後に追加する
        return fetch("/api/posts", { method: "POST", body: fd });
      })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (data) {
          if (r.status !== 201) { var err = new Error("post"); err.code = data.error; err.status = r.status; throw err; }
          return data;
        });
      })
      .then(function (data) {
        saveToken(data.id, data.deleteToken);
        ids.add(data.id);
        feed.insertBefore(buildCard(data, true), feed.firstChild);
        showEmpty("none");
        busy = false;
        closeSheet();
        feed.scrollTo({ top: 0, behavior: "auto" });
        updateCounter();
      })
      .catch(function (err) {
        setStatus(errMessage(err && err.code, err && err.status), true);
        sendBtn.disabled = false;
        busy = false;
      });
  });

  showEmpty("loading");
  loadMore();
})();
