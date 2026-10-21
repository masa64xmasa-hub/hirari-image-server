(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var feed = $("feed"), empty = $("empty"), hint = $("hint"), counter = $("counter");
  var fab = $("fab"), sheet = $("sheet"), form = $("form"), fileIn = $("file");
  var preview = $("preview"), pickText = $("pickText"), titleIn = $("title");
  var statusEl = $("status"), sendBtn = $("send"), emptyBtn = $("emptyBtn");
  var csheet = $("csheet"), clist = $("clist"), cform = $("cform"), cbody = $("cbody");
  var cstatus = $("cstatus"), csend = $("csend");
  var viewer = $("viewer"), stage = $("stage"), vimg = $("vimg");
  var rsheet = $("rsheet"), rlist = $("rlist"), rbtn = $("rbtn"), rcount = $("rcount"), rstatus = $("rstatus");

  var PAGE = 12;
  var cards = new Map();     // 投稿id -> {el, st, paint}
  var oldest = null;         // 読み込んだ中で一番古い投稿の時刻
  var ended = false, loading = false, scrolled = false, busy = false;
  var emptyMode = "loading";
  var file = null, previewUrl = null;
  var curComments = null;    // いま開いているコメント欄 {id, info}
  var csending = false;

  var ICON_HEART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.5l-1.2-1.1C6 15.1 3 12.4 3 8.9 3 6.2 5.1 4 7.8 4c1.6 0 3.1.8 4.2 2 1.1-1.2 2.6-2 4.2-2C18.9 4 21 6.2 21 8.9c0 3.5-3 6.2-7.8 10.5L12 20.5z"/></svg>';
  var ICON_COMMENT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

  /* ---------- このブラウザの目印（localStorage） ---------- */
  var TOKEN_KEY = "hirari.tokens";   // 自分の投稿の削除キー
  var CID_KEY = "hirari.cid";        // いいね・コメントの本人確認用の匿名ID
  var cidMem = null;

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
  function clientId() {
    if (cidMem) return cidMem;
    try {
      var v = localStorage.getItem(CID_KEY);
      if (v && /^[A-Za-z0-9_-]{16,64}$/.test(v)) { cidMem = v; return v; }
    } catch (e) {}
    var id = (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    while (id.length < 16) id += "0";
    cidMem = id;
    try { localStorage.setItem(CID_KEY, id); } catch (e) {}
    return id;
  }
  function api(path, opts) {
    opts = opts || {};
    var h = opts.headers || {};
    h["x-client-id"] = clientId();
    if (opts.json) {
      h["content-type"] = "application/json";
      opts.body = JSON.stringify(opts.json);
      delete opts.json;
    }
    opts.headers = h;
    return fetch(path, opts);
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
  function setCStatus(text, isErr) {
    cstatus.textContent = text || "";
    cstatus.className = "note" + (isErr ? " err" : "");
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
  // 1回目で「本当に〜する？」に変わり、もう一度押すと実行するボタン
  function armedButton(label, armedLabel, onConfirm, className) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = className;
    btn.textContent = label;
    var timer = 0;
    btn.addEventListener("click", function () {
      if (!btn.classList.contains("armed")) {
        btn.classList.add("armed");
        btn.textContent = armedLabel;
        timer = setTimeout(function () { btn.classList.remove("armed"); btn.textContent = label; }, 3500);
        return;
      }
      clearTimeout(timer);
      btn.disabled = true;
      onConfirm(btn, function reset() {
        btn.disabled = false;
        btn.classList.remove("armed");
        btn.textContent = label;
      });
    });
    return btn;
  }
  function mkAct(svg, label) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "abtn";
    btn.setAttribute("aria-label", label);
    btn.innerHTML = '<span class="ic">' + svg + '</span><span class="n"></span>';
    return { btn: btn, n: btn.querySelector(".n") };
  }

  /* ---------- カード ---------- */
  function buildCard(p, eager) {
    var st = { likes: p.likes | 0, liked: !!p.liked, comments: p.comments | 0, busy: false };
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
    img.addEventListener("click", function () { openViewer(url, img.alt); });

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

    var mine = !!readTokens()[p.id];
    var btn = armedButton(
      mine ? "削除" : "通報",
      mine ? "本当に削除する" : "本当に通報する",
      function (b, reset) {
        if (mine) removeMine(p.id, el, reset); else report(p.id, b, reset);
      },
      "act"
    );
    meta.appendChild(btn);
    cap.appendChild(meta);

    // いいね・コメント
    var like = mkAct(ICON_HEART, "いいね");
    var cmt = mkAct(ICON_COMMENT, "コメントを見る・書く");
    var acts = document.createElement("div");
    acts.className = "acts";
    acts.appendChild(like.btn);
    acts.appendChild(cmt.btn);

    function paint() {
      like.btn.classList.toggle("on", st.liked);
      like.btn.setAttribute("aria-pressed", String(st.liked));
      like.n.textContent = st.likes > 0 ? String(st.likes) : "";
      cmt.n.textContent = st.comments > 0 ? String(st.comments) : "";
    }
    like.btn.addEventListener("click", function () {
      if (st.busy) return;
      st.busy = true;
      var want = !st.liked;
      var prev = { likes: st.likes, liked: st.liked };
      st.liked = want;
      st.likes = Math.max(0, st.likes + (want ? 1 : -1));
      paint();
      api("/api/posts/" + p.id + "/like", { method: want ? "POST" : "DELETE" })
        .then(function (r) { if (!r.ok) throw new Error("like"); return r.json(); })
        .then(function (d) { st.likes = d.likes | 0; st.liked = !!d.liked; })
        .catch(function () { st.likes = prev.likes; st.liked = prev.liked; })
        .then(function () { st.busy = false; paint(); });
    });
    cmt.btn.addEventListener("click", function () { openComments(p.id, { st: st, paint: paint }); });
    paint();

    el.appendChild(bd);
    el.appendChild(img);
    el.appendChild(cap);
    el.appendChild(acts);
    return { el: el, st: st, paint: paint };
  }

  function removeMine(id, el, reset) {
    var token = readTokens()[id] || "";
    api("/api/posts/" + id, { method: "DELETE", headers: { "x-delete-token": token } })
      .then(function (r) {
        if (r.status === 204 || r.status === 403) { // 403は既に消えている場合など
          dropToken(id);
          cards.delete(id);
          el.remove();
          if (!feed.children.length) showEmpty(ended ? "empty" : "loading");
          updateCounter();
        } else {
          throw new Error("delete");
        }
      })
      .catch(function () { reset(); });
  }

  function report(id, btn, reset) {
    api("/api/posts/" + id + "/report", { method: "POST" })
      .then(function (r) {
        if (r.status === 204) { btn.textContent = "通報しました"; btn.classList.remove("armed"); }
        else if (r.status === 429) { reset(); btn.textContent = "しばらくしてから"; }
        else throw new Error("report");
      })
      .catch(function () { reset(); });
  }

  /* ---------- 読み込み ---------- */
  function loadMore() {
    if (loading || ended) return Promise.resolve();
    loading = true;
    var url = "/api/posts?limit=" + PAGE + (oldest ? "&before=" + encodeURIComponent(oldest) : "");
    return api(url)
      .then(function (r) { if (!r.ok) throw new Error("load"); return r.json(); })
      .then(function (data) {
        var posts = data.posts || [];
        posts.forEach(function (p) {
          oldest = p.createdAt;
          if (cards.has(p.id)) return;
          var c = buildCard(p, feed.children.length === 0);
          cards.set(p.id, c);
          feed.appendChild(c.el);
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
    if (!viewer.hidden) {
      if (e.key === "Escape") closeViewer();
      else if (e.key === "r" || e.key === "R") rotateBy(e.shiftKey ? -1 : 1);
      return;
    }
    if (!rsheet.hidden) { if (e.key === "Escape") rsheet.hidden = true; return; }
    if (!csheet.hidden) { if (e.key === "Escape") closeComments(); return; }
    if (!sheet.hidden) { if (e.key === "Escape") closeSheet(); return; }
    if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.key === "ArrowDown" || e.key === "PageDown" || e.key === " ") { e.preventDefault(); feed.scrollBy({ top: feed.clientHeight }); }
    if (e.key === "ArrowUp" || e.key === "PageUp") { e.preventDefault(); feed.scrollBy({ top: -feed.clientHeight }); }
  });

  /* ---------- ズーム・回転ビューア ---------- */
  var V = { x: 0, y: 0, s: 1, r: 0 };      // 移動・拡大率・回転(ラジアン)
  var pts = new Map();                     // 触れている指 id -> {x, y}
  var gest = null;                         // 2本指のときの前回の状態
  var tapMoved = false, tapStart = null;
  var lastTap = { t: 0, x: 0, y: 0 };

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function applyV() {
    vimg.style.transform = "translate(" + V.x + "px," + V.y + "px) rotate(" + V.r + "rad) scale(" + V.s + ")";
  }
  function animate() {
    vimg.classList.add("anim");
    clearTimeout(animate.t);
    animate.t = setTimeout(function () { vimg.classList.remove("anim"); }, 260);
  }
  // 画面中央を原点にした座標
  function rel(cx, cy) {
    var b = stage.getBoundingClientRect();
    return { x: cx - b.left - b.width / 2, y: cy - b.top - b.height / 2 };
  }
  // 点 m を動かさずに、ds 倍に拡大し dr だけ回転する
  function zoomAbout(m, ds, dr) {
    var s2 = clamp(V.s * ds, 0.5, 8);
    ds = s2 / V.s;
    var c = Math.cos(dr), si = Math.sin(dr);
    var vx = V.x - m.x, vy = V.y - m.y;
    V.x = m.x + ds * (c * vx - si * vy);
    V.y = m.y + ds * (si * vx + c * vy);
    V.s = s2;
    V.r += dr;
  }
  function resetV(withAnim) {
    if (withAnim) animate();
    V.x = 0; V.y = 0; V.s = 1; V.r = 0;
    applyV();
  }
  function rotateBy(dir) {
    animate();
    zoomAbout({ x: 0, y: 0 }, 1, dir * Math.PI / 2);
    applyV();
  }
  function openViewer(url, alt) {
    resetV(false);
    pts.clear(); gest = null;
    vimg.alt = alt || "";
    vimg.src = url;
    viewer.hidden = false;
    $("vclose").focus();
  }
  function closeViewer() {
    viewer.hidden = true;
    vimg.removeAttribute("src");
    pts.clear(); gest = null;
  }
  function twoPoints() {
    var a = Array.from(pts.values());
    var dx = a[1].x - a[0].x, dy = a[1].y - a[0].y;
    return {
      dist: Math.max(1, Math.hypot(dx, dy)),
      ang: Math.atan2(dy, dx),
      mid: rel((a[0].x + a[1].x) / 2, (a[0].y + a[1].y) / 2)
    };
  }

  stage.addEventListener("pointerdown", function (e) {
    try { stage.setPointerCapture(e.pointerId); } catch (err) {}
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) { tapMoved = false; tapStart = { x: e.clientX, y: e.clientY }; }
    if (pts.size === 2) { gest = twoPoints(); tapMoved = true; }
  });
  stage.addEventListener("pointermove", function (e) {
    var p = pts.get(e.pointerId);
    if (!p) return;
    var dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (pts.size === 1) {
      if (tapStart && Math.hypot(e.clientX - tapStart.x, e.clientY - tapStart.y) > 8) tapMoved = true;
      V.x += dx; V.y += dy;
      applyV();
    } else if (pts.size === 2 && gest) {
      var now = twoPoints();
      zoomAbout(gest.mid, now.dist / gest.dist, now.ang - gest.ang);
      V.x += now.mid.x - gest.mid.x;
      V.y += now.mid.y - gest.mid.y;
      gest = now;
      applyV();
    }
  });
  function endPointer(e) {
    if (!pts.has(e.pointerId)) return;
    var wasSingle = pts.size === 1;
    pts.delete(e.pointerId);
    gest = null;
    if (pts.size === 2) gest = twoPoints();
    if (wasSingle && !tapMoved && e.type === "pointerup") {
      var now = Date.now();
      if (now - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
        // ダブルタップ: 拡大 ⇔ 元に戻す
        if (V.s > 1.05 || Math.abs(V.r) > 0.01 || Math.abs(V.x) > 1 || Math.abs(V.y) > 1) {
          resetV(true);
        } else {
          animate();
          zoomAbout(rel(e.clientX, e.clientY), 2.5, 0);
          applyV();
        }
        lastTap.t = 0;
      } else {
        lastTap = { t: now, x: e.clientX, y: e.clientY };
      }
    }
  }
  stage.addEventListener("pointerup", endPointer);
  stage.addEventListener("pointercancel", endPointer);
  stage.addEventListener("wheel", function (e) {
    e.preventDefault();
    var d = e.deltaY || e.deltaX;
    if (e.shiftKey) zoomAbout(rel(e.clientX, e.clientY), 1, -d * 0.004);
    else zoomAbout(rel(e.clientX, e.clientY), Math.exp(-d * 0.0015), 0);
    applyV();
  }, { passive: false });
  stage.addEventListener("gesturestart", function (e) { e.preventDefault(); });
  $("vclose").addEventListener("click", closeViewer);
  $("vleft").addEventListener("click", function () { rotateBy(-1); });
  $("vright").addEventListener("click", function () { rotateBy(1); });
  $("vreset").addEventListener("click", function () { resetV(true); });

  /* ---------- コメント ---------- */
  function infoItem(text) {
    var li = document.createElement("li");
    li.className = "cinfo";
    li.textContent = text;
    return li;
  }
  function clearInfo() {
    Array.prototype.slice.call(clist.querySelectorAll(".cinfo")).forEach(function (n) { n.remove(); });
  }
  function openComments(id, info) {
    curComments = { id: id, info: info };
    clist.textContent = "";
    cbody.value = "";
    setCStatus("");
    csheet.hidden = false;
    loadComments(id);
  }
  function closeComments() {
    csheet.hidden = true;
    curComments = null;
    clist.textContent = "";
  }
  function loadComments(id) {
    clist.appendChild(infoItem("読み込み中…"));
    api("/api/posts/" + id + "/comments")
      .then(function (r) { if (!r.ok) throw new Error("load"); return r.json(); })
      .then(function (d) {
        if (!curComments || curComments.id !== id) return;
        var items = d.comments || [];
        clist.textContent = "";
        if (!items.length) clist.appendChild(infoItem("まだコメントはありません。"));
        items.forEach(function (c) { clist.appendChild(buildComment(c)); });
        clist.scrollTop = clist.scrollHeight;
        if (items.length < 100) { curComments.info.st.comments = items.length; curComments.info.paint(); }
      })
      .catch(function () {
        if (!curComments || curComments.id !== id) return;
        clist.textContent = "";
        clist.appendChild(infoItem("コメントを読み込めませんでした。"));
      });
  }
  function bumpComments(delta) {
    if (!curComments) return;
    var st = curComments.info.st;
    st.comments = Math.max(0, st.comments + delta);
    curComments.info.paint();
  }
  function buildComment(c) {
    var li = document.createElement("li");
    var text = document.createElement("p");
    text.className = "ctext";
    text.textContent = c.body;
    var meta = document.createElement("div");
    meta.className = "cmeta";
    var time = document.createElement("span");
    time.textContent = fmtTime(c.createdAt);
    meta.appendChild(time);

    var btn;
    if (c.mine) {
      btn = armedButton("削除", "本当に削除する", function (b, reset) {
        api("/api/comments/" + c.id, { method: "DELETE" })
          .then(function (r) {
            if (r.status === 204 || r.status === 403) {
              li.remove();
              bumpComments(-1);
              if (!clist.children.length) clist.appendChild(infoItem("まだコメントはありません。"));
            } else { throw new Error("del"); }
          })
          .catch(function () { reset(); });
      }, "cact");
    } else {
      btn = armedButton("通報", "本当に通報する", function (b, reset) {
        api("/api/comments/" + c.id + "/report", { method: "POST" })
          .then(function (r) {
            if (r.status === 204) { b.textContent = "通報しました"; b.classList.remove("armed"); }
            else if (r.status === 429) { reset(); b.textContent = "しばらくしてから"; }
            else throw new Error("rep");
          })
          .catch(function () { reset(); });
      }, "cact");
    }
    meta.appendChild(btn);
    li.appendChild(text);
    li.appendChild(meta);
    return li;
  }
  $("cclose").addEventListener("click", closeComments);
  csheet.addEventListener("click", function (e) { if (e.target === csheet) closeComments(); });
  cform.addEventListener("submit", function (e) {
    e.preventDefault();
    var target = curComments;
    var body = cbody.value.replace(/\s+/g, " ").trim();
    if (!target || !body || csending) return;
    csending = true;
    csend.disabled = true;
    setCStatus("");
    api("/api/posts/" + target.id + "/comments", { method: "POST", json: { body: body } })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (r.status !== 201) { var err = new Error("post"); err.status = r.status; err.code = d.error; throw err; }
          return d;
        });
      })
      .then(function (c) {
        if (curComments !== target) return;
        clearInfo();
        clist.appendChild(buildComment(c));
        clist.scrollTop = clist.scrollHeight;
        cbody.value = "";
        bumpComments(1);
      })
      .catch(function (err) {
        if (err && err.status === 429) setCStatus("コメントが多すぎます。しばらく待ってください。", true);
        else if (err && err.code === "too_long") setCStatus("コメントは200文字までです。", true);
        else setCStatus("送れませんでした。もう一度試してください。", true);
      })
      .then(function () { csending = false; csend.disabled = false; });
  });

  /* ---------- 似ている絵の確認（原作者向け） ---------- */
  var reviewPairs = [];
  var lastReviewCheck = 0;

  function ownTokens() {
    var t = readTokens();
    return Object.keys(t).map(function (k) { return t[k]; }).slice(-100);
  }
  function setReviewCount(n) {
    rcount.textContent = String(n);
    rbtn.hidden = n < 1;
  }
  function setRStatus(text, isErr) {
    rstatus.textContent = text || "";
    rstatus.className = "note" + (isErr ? " err" : "");
  }
  // 自分の絵に似た絵が見つかっていないか、サーバーに聞く（60秒以内の再確認は省く）
  function checkReview(force) {
    var now = Date.now();
    if (!force && now - lastReviewCheck < 60000) return;
    var tokens = ownTokens();
    if (!tokens.length) { setReviewCount(0); return; }
    lastReviewCheck = now;
    api("/api/review/list", { method: "POST", json: { tokens: tokens } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) return;
        reviewPairs = d.pairs || [];
        setReviewCount(reviewPairs.length);
        if (!rsheet.hidden) renderReview();
      })
      .catch(function () {});
  }
  function figure(post, label) {
    var fig = document.createElement("figure");
    var b = document.createElement("button");
    b.type = "button";
    b.setAttribute("aria-label", label + "を拡大して見る");
    var im = document.createElement("img");
    im.src = "/img/" + post.id;
    im.alt = label;
    im.loading = "lazy";
    b.appendChild(im);
    b.addEventListener("click", function () { openViewer("/img/" + post.id, label); });
    var cap = document.createElement("figcaption");
    cap.textContent = label + "（" + fmtTime(post.createdAt) + "）" + (post.title ? " " + post.title : "");
    fig.appendChild(b);
    fig.appendChild(cap);
    return fig;
  }
  function buildPair(p) {
    var li = document.createElement("li");
    li.className = "pair";
    var imgs = document.createElement("div");
    imgs.className = "pair-imgs";
    imgs.appendChild(figure(p.original, "あなたの絵"));
    imgs.appendChild(figure(p.other, "似ている絵"));
    var score = document.createElement("p");
    score.className = "pair-score";
    score.textContent = "似ている度 " + Math.round(p.score * 100) + "%";
    var btns = document.createElement("div");
    btns.className = "pair-btns";
    [
      ["plagiarism", "盗作だと思う", "btn warn"],
      ["safe", "セーフ（似ているだけ）", "btn ghost"],
      ["unrelated", "無関係", "btn ghost"]
    ].forEach(function (d) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = d[2];
      b.textContent = d[1];
      b.addEventListener("click", function () { judge(p, d[0], li, btns); });
      btns.appendChild(b);
    });
    li.appendChild(imgs);
    li.appendChild(score);
    li.appendChild(btns);
    return li;
  }
  function renderReview() {
    rlist.textContent = "";
    setRStatus("");
    if (!reviewPairs.length) {
      var li = document.createElement("li");
      li.className = "rinfo";
      li.textContent = "確認が必要な絵はありません。";
      rlist.appendChild(li);
      return;
    }
    reviewPairs.forEach(function (p) { rlist.appendChild(buildPair(p)); });
  }
  function judge(p, verdict, li, btns) {
    var token = readTokens()[p.original.id];
    if (!token) { setRStatus("この絵の削除キーがこのブラウザにありません。投稿したブラウザで開いてください。", true); return; }
    Array.prototype.forEach.call(btns.children, function (b) { b.disabled = true; });
    setRStatus("");
    api("/api/review/" + p.id + "/verdict", { method: "POST", json: { token: token, verdict: verdict } })
      .then(function (r) {
        if (r.status !== 204) throw new Error("verdict");
        reviewPairs = reviewPairs.filter(function (x) { return x.id !== p.id; });
        setReviewCount(reviewPairs.length);
        renderReview();
        setRStatus("選んだ結果を保存しました。");
      })
      .catch(function () {
        Array.prototype.forEach.call(btns.children, function (b) { b.disabled = false; });
        setRStatus("保存できませんでした。もう一度試してください。", true);
      });
  }
  rbtn.addEventListener("click", function () {
    rsheet.hidden = false;
    renderReview();
    checkReview(true);
  });
  $("rclose").addEventListener("click", function () { rsheet.hidden = true; });
  rsheet.addEventListener("click", function (e) { if (e.target === rsheet) rsheet.hidden = true; });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") checkReview(false);
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
        return api("/api/posts", { method: "POST", body: fd });
      })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (data) {
          if (r.status !== 201) { var err = new Error("post"); err.code = data.error; err.status = r.status; throw err; }
          return data;
        });
      })
      .then(function (data) {
        saveToken(data.id, data.deleteToken);
        var c = buildCard(data, true);
        cards.set(data.id, c);
        feed.insertBefore(c.el, feed.firstChild);
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
  checkReview(true);
})();
