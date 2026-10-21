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
  var tabRec = $("tabRec"), tabNew = $("tabNew"), tagchip = $("tagchip");
  var tagsIn = $("tags"), tagprev = $("tagprev"), tagsug = $("tagsug");
  var msheet = $("msheet"), mlist = $("mlist"), mstatus = $("mstatus"), mbtn = $("mbtn");

  var PAGE = 12;
  var cards = new Map();     // 投稿id -> {el, st, paint, p}
  var oldest = null;         // 読み込んだ中で一番古い投稿の時刻（新着・タグ表示用）
  var ended = false, loading = false, scrolled = false, busy = false;
  var mode = "rec";          // "rec"=おすすめ / "new"=新着 / "tag"=タグで絞り込み
  var tagFilter = "";
  var gen = 0;               // 表示を切り替えるたびに増やし、古い通信の結果を捨てる
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
  /* ---------- 好みの記録（このブラウザの中だけに保存） ---------- */
  // 見ていた時間などから、タグと「好きな絵」の重みを覚える。サーバーには保存せず、
  // おすすめを頼むときに、そのつど送るだけ。
  var PROF_KEY = "hirari.profile";
  var profile = loadProfile();

  function loadProfile() {
    var p = { tags: {}, seeds: {}, seen: [] };
    try {
      var raw = JSON.parse(localStorage.getItem(PROF_KEY) || "null");
      if (raw && typeof raw === "object") {
        if (raw.tags && typeof raw.tags === "object") p.tags = raw.tags;
        if (raw.seeds && typeof raw.seeds === "object") p.seeds = raw.seeds;
        if (Array.isArray(raw.seen)) p.seen = raw.seen.filter(function (x) { return typeof x === "string"; }).slice(-300);
      }
    } catch (e) {}
    // 起動のたびに少し薄める（古い好みより最近の好みを優先）
    Object.keys(p.tags).forEach(function (k) {
      p.tags[k] = (+p.tags[k] || 0) * 0.9;
      if (Math.abs(p.tags[k]) < 0.1) delete p.tags[k];
    });
    Object.keys(p.seeds).forEach(function (k) {
      p.seeds[k] = (+p.seeds[k] || 0) * 0.9;
      if (p.seeds[k] < 0.1) delete p.seeds[k];
    });
    return p;
  }
  function saveProfile() {
    try {
      var tk = Object.keys(profile.tags).sort(function (a, b) {
        return Math.abs(profile.tags[b]) - Math.abs(profile.tags[a]);
      }).slice(0, 40);
      var tags = {};
      tk.forEach(function (k) { tags[k] = Math.round(profile.tags[k] * 100) / 100; });
      var sk = Object.keys(profile.seeds).sort(function (a, b) { return profile.seeds[b] - profile.seeds[a]; }).slice(0, 30);
      var seeds = {};
      sk.forEach(function (k) { seeds[k] = Math.round(profile.seeds[k] * 100) / 100; });
      profile.tags = tags; profile.seeds = seeds;
      profile.seen = profile.seen.slice(-300);
      localStorage.setItem(PROF_KEY, JSON.stringify(profile));
    } catch (e) {}
  }
  function markSeen(id) {
    if (profile.seen.indexOf(id) < 0) profile.seen.push(id);
  }
  // 1枚の絵に対する反応を、重み w で記録する（正は好き、負は興味なし）
  function addInterest(id, w) {
    var c = cards.get(id);
    if (!c || !c.p || readTokens()[id]) return; // 自分の絵は好みに数えない
    (c.p.tags || []).forEach(function (t) {
      profile.tags[t] = Math.max(-3, Math.min(8, (profile.tags[t] || 0) + w));
    });
    if (w > 0) profile.seeds[id] = Math.min(5, (profile.seeds[id] || 0) + w);
    else if (profile.seeds[id]) profile.seeds[id] = Math.max(0, profile.seeds[id] + w);
  }
  function profileForRequest() {
    var tags = {};
    Object.keys(profile.tags).slice(0, 40).forEach(function (k) { tags[k] = profile.tags[k]; });
    var seeds = Object.keys(profile.seeds).slice(0, 30).map(function (k) { return { id: k, w: profile.seeds[k] }; });
    return { tags: tags, seeds: seeds, seen: profile.seen.slice(-150) };
  }

  /* ---------- 見ていた時間を測る ---------- */
  var active = null;   // いま画面に出ているカード {id, t0}
  var curId = null;
  var io = ("IntersectionObserver" in window)
    ? new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          var id = en.target.dataset.id;
          if (!id) return;
          if (en.isIntersecting) startView(id);
          else if (active && active.id === id) endView();
        });
      }, { root: feed, threshold: 0.6 })
    : null;

  function startView(id) {
    endView();
    curId = id;
    markSeen(id);
    if (document.visibilityState === "visible") active = { id: id, t0: Date.now() };
  }
  function endView() {
    if (!active) return;
    var dt = (Date.now() - active.t0) / 1000;
    var id = active.id;
    active = null;
    var w;
    if (dt < 1) w = -0.4;                          // すぐ飛ばした
    else if (dt < 3) w = 0.15;                     // ちらっと見た
    else w = Math.min(dt, 20) / 6;                 // じっくり見た（最大約3.3）
    addInterest(id, w);
    saveProfile();
  }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") endView();
    else if (curId && cards.has(curId)) active = { id: curId, t0: Date.now() };
  });
  window.addEventListener("pagehide", endView);

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
    img.addEventListener("click", function () { addInterest(p.id, 1); openViewer(url, img.alt); });

    var cap = document.createElement("div");
    cap.className = "cap gutter";
    if (p.title) {
      var ttl = document.createElement("p");
      ttl.className = "ttl";
      ttl.textContent = p.title;
      cap.appendChild(ttl);
    }
    if (p.tags && p.tags.length) {
      var tg = document.createElement("div");
      tg.className = "tags";
      p.tags.forEach(function (t) {
        var tb = document.createElement("button");
        tb.type = "button";
        tb.className = "tagbtn";
        tb.textContent = "#" + t;
        tb.addEventListener("click", function () { setMode("tag", t); });
        tg.appendChild(tb);
      });
      cap.appendChild(tg);
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
        .then(function (d) {
          st.likes = d.likes | 0; st.liked = !!d.liked;
          addInterest(p.id, want ? 3 : -3); saveProfile();
        })
        .catch(function () { st.likes = prev.likes; st.liked = prev.liked; })
        .then(function () { st.busy = false; paint(); });
    });
    cmt.btn.addEventListener("click", function () { openComments(p.id, { st: st, paint: paint }); });
    paint();

    el.appendChild(bd);
    el.appendChild(img);
    el.appendChild(cap);
    el.appendChild(acts);
    if (io) io.observe(el);
    return { el: el, st: st, paint: paint, p: p };
  }

  function removeMine(id, el, reset) {
    var token = readTokens()[id] || "";
    api("/api/posts/" + id, { method: "DELETE", headers: { "x-delete-token": token } })
      .then(function (r) {
        if (r.status === 204 || r.status === 403) { // 403は既に消えている場合など
          dropToken(id);
          dropCard(id);
          if (!cards.size) setMode(mode, tagFilter);
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
  function dropCard(id) {
    var c = cards.get(id);
    if (!c) return;
    if (io) io.unobserve(c.el);
    if (active && active.id === id) active = null;
    c.el.remove();
    cards.delete(id);
  }

  function addEndCard() {
    var el = document.createElement("article");
    el.className = "card endcard";
    var h = document.createElement("h2");
    var p = document.createElement("p");
    if (mode === "rec") {
      h.textContent = "ここまでです";
      p.textContent = "いまある絵は見終わりました。新しい投稿を待つか、もう一度見直せます。";
    } else {
      h.textContent = "これで全部です";
      p.textContent = mode === "tag" ? "このタグの絵は、いまのところここまでです。" : "新着はここまでです。";
    }
    var row = document.createElement("div");
    row.className = "row";
    var again = document.createElement("button");
    again.type = "button"; again.className = "btn ghost"; again.textContent = "最初から見直す";
    again.addEventListener("click", function () {
      if (mode === "rec") { profile.seen = []; saveProfile(); }
      setMode(mode, tagFilter);
    });
    var post = document.createElement("button");
    post.type = "button"; post.className = "btn"; post.textContent = "絵を投稿する";
    post.addEventListener("click", openSheet);
    row.appendChild(again); row.appendChild(post);
    el.appendChild(h); el.appendChild(p); el.appendChild(row);
    feed.appendChild(el);
  }

  function loadMore() {
    if (loading || ended) return Promise.resolve();
    loading = true;
    var my = gen;
    var req;
    if (mode === "rec") {
      var pr = profileForRequest();
      req = api("/api/feed", {
        method: "POST",
        json: {
          limit: 10,
          exclude: Array.from(cards.keys()).slice(-150),
          seen: pr.seen, tags: pr.tags, seeds: pr.seeds
        }
      });
    } else {
      req = api("/api/posts?limit=" + PAGE +
        (oldest ? "&before=" + encodeURIComponent(oldest) : "") +
        (mode === "tag" ? "&tag=" + encodeURIComponent(tagFilter) : ""));
    }
    return req
      .then(function (r) { if (!r.ok) throw new Error("load"); return r.json(); })
      .then(function (data) {
        if (my !== gen) return;
        var posts = data.posts || [];
        var added = 0;
        posts.forEach(function (p) {
          oldest = p.createdAt;
          if (cards.has(p.id)) return;
          var c = buildCard(p, cards.size === 0);
          cards.set(p.id, c);
          feed.appendChild(c.el);
          added++;
        });
        if (mode === "rec" ? added === 0 : posts.length < PAGE) {
          ended = true;
          if (cards.size) addEndCard();
        }
        showEmpty(cards.size ? "none" : "empty");
        updateCounter();
      })
      .catch(function () {
        if (my === gen && !cards.size) showEmpty("error");
      })
      .then(function () { if (my === gen) loading = false; });
  }

  // 表示を切り替える（おすすめ / 新着 / タグ）。画面を空にして最初から読み込む
  function setMode(m, tag) {
    endView();
    gen++;
    mode = m;
    tagFilter = m === "tag" ? tag : "";
    Array.from(cards.keys()).forEach(dropCard);
    feed.textContent = "";
    oldest = null; ended = false; loading = false; scrolled = false;
    curId = null;
    tabRec.setAttribute("aria-pressed", String(m === "rec"));
    tabNew.setAttribute("aria-pressed", String(m === "new"));
    tagchip.hidden = m !== "tag";
    tagchip.textContent = "#" + tagFilter + "  ✕";
    tagchip.setAttribute("aria-label", "タグ " + tagFilter + " の絞り込みをやめる");
    feed.scrollTo({ top: 0, behavior: "auto" });
    showEmpty("loading");
    updateCounter();
    loadMore();
  }
  tabRec.addEventListener("click", function () { if (mode !== "rec") setMode("rec"); });
  tabNew.addEventListener("click", function () { if (mode !== "new") setMode("new"); });
  tagchip.addEventListener("click", function () { setMode("rec"); });

  function updateCounter() {
    var n = feed.children.length;
    if (!n) { counter.textContent = ""; hint.hidden = true; return; }
    var i = Math.min(n - 1, Math.round(feed.scrollTop / Math.max(1, feed.clientHeight)));
    counter.textContent = mode === "rec" ? String(i + 1) : (i + 1) + " / " + n + (ended ? "" : "+");
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
    if (!msheet.hidden) { if (e.key === "Escape") msheet.hidden = true; return; }
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
        addInterest(target.id, 2); saveProfile();
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
  var TAG_OK;
  try { TAG_OK = new RegExp("^[\\p{L}\\p{N}_-]{1,20}$", "u"); } catch (e) { TAG_OK = /^[^\s#,、，]{1,20}$/; }
  var tagCache = null;

  // サーバーと同じ決まりでタグを整える（#や空白・読点で区切り、5個まで）
  function parseTags(s) {
    var out = [], over = false;
    String(s || "").normalize("NFKC").split(/[\s,、，#＃]+/).forEach(function (t) {
      t = t.trim().toLowerCase().slice(0, 20);
      if (!t || !TAG_OK.test(t) || out.indexOf(t) >= 0) return;
      if (out.length >= 5) { over = true; return; }
      out.push(t);
    });
    return { list: out, over: over };
  }
  function showTagPreview() {
    var r = parseTags(tagsIn.value);
    tagprev.textContent = r.list.length
      ? "タグ: " + r.list.map(function (t) { return "#" + t; }).join(" ") + (r.over ? "（6個目からは付きません）" : "")
      : "";
    renderTagSug(r.list);
  }
  function renderTagSug(chosen) {
    tagsug.textContent = "";
    var items = (tagCache || []).filter(function (t) { return chosen.indexOf(t) < 0; }).slice(0, 10);
    tagsug.hidden = !items.length;
    items.forEach(function (t) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = "#" + t;
      b.addEventListener("click", function () {
        var v = tagsIn.value.replace(/\s+$/, "");
        tagsIn.value = (v ? v + " " : "") + "#" + t + " ";
        showTagPreview();
        tagsIn.focus();
      });
      tagsug.appendChild(b);
    });
  }
  tagsIn.addEventListener("input", showTagPreview);
  function loadTagSug() {
    if (tagCache) { showTagPreview(); return; }
    api("/api/tags")
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) return;
        tagCache = (d.tags || []).map(function (x) { return x.tag; });
        showTagPreview();
      })
      .catch(function () {});
  }

  function openSheet() {
    resetForm();
    sheet.hidden = false;
    fileIn.focus();
    loadTagSug();
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
    tagsIn.value = "";
    showTagPreview();
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
        fd.append("tags", parseTags(tagsIn.value).list.join(" "));
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
        busy = false;
        tagCache = null;
        closeSheet();
        // タグで絞り込み中で、その絵にそのタグがないときは、おすすめに戻して先頭に出す
        if (mode === "tag" && (data.tags || []).indexOf(tagFilter) < 0) setMode("rec");
        var c = buildCard(data, true);
        cards.set(data.id, c);
        feed.insertBefore(c.el, feed.firstChild);
        showEmpty("none");
        feed.scrollTo({ top: 0, behavior: "auto" });
        updateCounter();
      })
      .catch(function (err) {
        setStatus(errMessage(err && err.code, err && err.status), true);
        sendBtn.disabled = false;
        busy = false;
      });
  });

  /* ---------- 自分の投稿一覧 ---------- */
  function setMStatus(text, isErr) {
    mstatus.textContent = text || "";
    mstatus.className = "note" + (isErr ? " err" : "");
  }
  function minfo(text) {
    var li = document.createElement("li");
    li.className = "minfo";
    li.textContent = text;
    return li;
  }
  function openMine() {
    msheet.hidden = false;
    setMStatus("");
    mlist.textContent = "";
    var tokens = ownTokens();
    if (!tokens.length) {
      mlist.appendChild(minfo("このブラウザで投稿した絵はまだありません。右下の＋から投稿できます。"));
      return;
    }
    mlist.appendChild(minfo("読み込み中…"));
    api("/api/posts/mine", { method: "POST", json: { tokens: tokens } })
      .then(function (r) { if (!r.ok) throw new Error("mine"); return r.json(); })
      .then(function (d) {
        if (msheet.hidden) return;
        mlist.textContent = "";
        var posts = d.posts || [];
        // サーバーに無い絵の削除キーは、ここで片付ける
        var have = {};
        posts.forEach(function (p) { have[p.id] = true; });
        var t = readTokens();
        Object.keys(t).forEach(function (id) { if (!have[id]) dropToken(id); });
        if (!posts.length) { mlist.appendChild(minfo("投稿した絵は見つかりませんでした。")); return; }
        mlist.appendChild(minfo(posts.length + "枚投稿しています。"));
        posts.forEach(function (p) { mlist.appendChild(buildMine(p)); });
      })
      .catch(function () {
        mlist.textContent = "";
        setMStatus("読み込めませんでした。もう一度開いてください。", true);
      });
  }
  function buildMine(p) {
    var li = document.createElement("li");
    li.className = "mitem";
    var tb = document.createElement("button");
    tb.type = "button";
    tb.className = "mthumb";
    tb.setAttribute("aria-label", (p.title || "投稿した絵") + "を拡大して見る");
    var im = document.createElement("img");
    im.src = "/thumb/" + p.id;
    im.alt = p.title || "投稿した絵";
    im.loading = "lazy";
    tb.appendChild(im);
    tb.addEventListener("click", function () { openViewer("/img/" + p.id, im.alt); });
    li.appendChild(tb);

    var meta = document.createElement("div");
    meta.className = "mmeta";
    meta.textContent = fmtTime(p.createdAt) + "  ♥" + (p.likes | 0) + "  💬" + (p.comments | 0);
    li.appendChild(meta);

    if (p.tags && p.tags.length) {
      var tg = document.createElement("div");
      tg.className = "mtags";
      p.tags.forEach(function (t) {
        var b = document.createElement("button");
        b.type = "button";
        b.textContent = "#" + t;
        b.addEventListener("click", function () { msheet.hidden = true; setMode("tag", t); });
        tg.appendChild(b);
      });
      li.appendChild(tg);
    }
    if (p.hidden) {
      var hd = document.createElement("div");
      hd.className = "mhide";
      hd.textContent = "通報により非表示";
      li.appendChild(hd);
    }
    li.appendChild(armedButton("削除", "本当に削除する", function (b, reset) {
      var token = readTokens()[p.id] || "";
      api("/api/posts/" + p.id, { method: "DELETE", headers: { "x-delete-token": token } })
        .then(function (r) {
          if (r.status === 204 || r.status === 403) {
            dropToken(p.id);
            li.remove();
            if (cards.has(p.id)) { dropCard(p.id); if (!cards.size) setMode(mode, tagFilter); updateCounter(); }
          } else { throw new Error("del"); }
        })
        .catch(function () { reset(); });
    }, "mdel"));
    return li;
  }
  mbtn.addEventListener("click", openMine);
  $("mclose").addEventListener("click", function () { msheet.hidden = true; });
  msheet.addEventListener("click", function (e) { if (e.target === msheet) msheet.hidden = true; });

  setMode("rec");
  checkReview(true);
})();
