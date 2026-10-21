(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var KEY = "hirari.admin";
  var token = "";
  try { token = sessionStorage.getItem(KEY) || ""; } catch (e) {}
  var before = null;

  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ Authorization: "Bearer " + token }, opts.headers || {});
    return fetch(path, opts);
  }
  function mb(n) { return (n / 1048576).toFixed(1) + " MB"; }
  function ago(ts) {
    var ms = Date.parse(String(ts).replace(" ", "T"));
    if (isNaN(ms)) return "";
    var d = new Date(ms);
    return d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate() + " " +
      ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  // 2回押すと実行するボタン
  function confirmBtn(label, cls, fn) {
    var b = el("button", cls, label);
    b.type = "button";
    var t = 0;
    b.addEventListener("click", function () {
      if (!b.dataset.armed) {
        b.dataset.armed = "1"; b.textContent = "本当に？";
        t = setTimeout(function () { delete b.dataset.armed; b.textContent = label; }, 3000);
        return;
      }
      clearTimeout(t);
      b.disabled = true;
      fn(b);
    });
    return b;
  }

  function showApp(on) {
    $("login").hidden = on;
    $("app").hidden = !on;
  }
  function logout(msg) {
    token = "";
    try { sessionStorage.removeItem(KEY); } catch (e) {}
    showApp(false);
    $("loginMsg").textContent = msg || "";
  }

  /* ---------- 統計 ---------- */
  function loadStats() {
    return api("/api/admin/stats").then(function (r) {
      if (r.status === 403) throw new Error("auth");
      if (r.status === 429) throw new Error("rate");
      if (!r.ok) throw new Error("stats");
      return r.json();
    }).then(function (s) {
      var box = $("stats");
      box.textContent = "";
      [
        [s.posts, "投稿"], [s.posts24h, "24時間以内の投稿"], [s.comments, "コメント"], [s.likes, "いいね"],
        [s.hiddenPosts, "非表示の投稿"], [s.reportedPosts, "通報された投稿"], [s.reportedComments, "通報されたコメント"],
        [s.pairsPending, "確認待ちの似た絵"], [s.pairsJudged, "判定済みの似た絵"],
        [s.embedded + " / " + s.posts, "特徴を計算した絵"],
        [mb(s.imageBytes), "絵のデータ量"], [mb(s.dbBytes), "データベース全体（上限1GB）"],
        [mb(s.rssBytes), "サーバーのメモリ（上限512MB）"]
      ].forEach(function (d) {
        var c = el("div", "stat");
        c.appendChild(el("b", "", String(d[0])));
        c.appendChild(el("span", "", d[1]));
        box.appendChild(c);
      });
    });
  }

  /* ---------- 一覧 ---------- */
  function thumb(img, id) {
    api("/api/admin/thumb/" + id).then(function (r) { return r.ok ? r.blob() : null; })
      .then(function (b) { if (b) img.src = URL.createObjectURL(b); })
      .catch(function () {});
  }
  function postItem(p, onGone) {
    var c = el("div", "card item");
    var img = el("img");
    img.alt = p.title || "投稿された絵";
    thumb(img, p.id);
    c.appendChild(img);
    var info = el("div", "info");
    info.appendChild(el("p", "", (p.title || "（タイトルなし）") + (p.tags && p.tags.length ? "  " + p.tags.map(function (t) { return "#" + t; }).join(" ") : "")));
    var meta = el("p", "muted", ago(p.createdAt) + "  ♥" + p.likes + "  コメント" + p.comments);
    info.appendChild(meta);
    if (p.reports > 0) {
      var bd = el("p");
      bd.appendChild(el("span", "badge", "通報 " + p.reports + (p.hidden ? "・非表示中" : "")));
      info.appendChild(bd);
    }
    var row = el("div", "row");
    var open = el("a", "", "ページを開く");
    open.href = "/p/" + p.id; open.target = "_blank"; open.rel = "noopener";
    row.appendChild(open);
    if (p.reports > 0) {
      var clr = el("button", "ghost", "通報を取り消す");
      clr.type = "button";
      clr.addEventListener("click", function () {
        clr.disabled = true;
        api("/api/admin/posts/" + p.id + "/clear", { method: "POST" })
          .then(function (r) { if (r.status !== 204) throw 0; onGone(true); })
          .catch(function () { clr.disabled = false; });
      });
      row.appendChild(clr);
    }
    row.appendChild(confirmBtn("削除", "danger", function (b) {
      api("/api/admin/posts/" + p.id, { method: "DELETE" })
        .then(function (r) { if (r.status !== 204 && r.status !== 404) throw 0; c.remove(); onGone(false); })
        .catch(function () { b.disabled = false; delete b.dataset.armed; b.textContent = "削除"; });
    }));
    info.appendChild(row);
    c.appendChild(info);
    return c;
  }
  function commentItem(m) {
    var c = el("div", "card");
    c.appendChild(el("p", "", m.body));
    var bd = el("p");
    bd.appendChild(el("span", "badge", "通報 " + m.reports));
    bd.appendChild(document.createTextNode("  " + ago(m.createdAt)));
    c.appendChild(bd);
    var row = el("div", "row");
    var clr = el("button", "ghost", "通報を取り消す");
    clr.type = "button";
    clr.addEventListener("click", function () {
      clr.disabled = true;
      api("/api/admin/comments/" + m.id + "/clear", { method: "POST" })
        .then(function (r) { if (r.status !== 204) throw 0; c.remove(); })
        .catch(function () { clr.disabled = false; });
    });
    row.appendChild(clr);
    row.appendChild(confirmBtn("削除", "danger", function (b) {
      api("/api/admin/comments/" + m.id, { method: "DELETE" })
        .then(function (r) { if (r.status !== 204 && r.status !== 404) throw 0; c.remove(); })
        .catch(function () { b.disabled = false; delete b.dataset.armed; b.textContent = "削除"; });
    }));
    c.appendChild(row);
    return c;
  }
  function loadReported() {
    return api("/api/admin/posts?filter=reported").then(function (r) { if (!r.ok) throw 0; return r.json(); })
      .then(function (d) {
        var box = $("reported");
        box.textContent = "";
        if (!d.posts.length && !d.comments.length) { box.appendChild(el("p", "muted", "いま通報されているものはありません。")); return; }
        d.posts.forEach(function (p) { box.appendChild(postItem(p, function () { loadReported(); loadStats(); })); });
        d.comments.forEach(function (m) { box.appendChild(commentItem(m)); });
      }).catch(function () { $("reported").textContent = "読み込めませんでした。"; });
  }
  function loadRecent(reset) {
    if (reset) { before = null; $("recent").textContent = ""; }
    var url = "/api/admin/posts?filter=all" + (before ? "&before=" + encodeURIComponent(before) : "");
    return api(url).then(function (r) { if (!r.ok) throw 0; return r.json(); })
      .then(function (d) {
        d.posts.forEach(function (p) {
          $("recent").appendChild(postItem(p, function () { loadReported(); loadStats(); }));
          before = p.createdAt;
        });
        $("more").hidden = d.posts.length < 30;
      }).catch(function () { $("recent").appendChild(el("p", "err", "読み込めませんでした。")); });
  }
  $("more").addEventListener("click", function () { loadRecent(false); });

  /* ---------- バックアップ・復元 ---------- */
  $("backupForm").addEventListener("submit", function () { $("backupToken").value = token; });
  $("restoreBtn").addEventListener("click", function () {
    var f = $("restoreFile").files && $("restoreFile").files[0];
    var msg = $("restoreMsg");
    if (!f) { msg.className = "err"; msg.textContent = "ファイルを選んでください。"; return; }
    var btn = $("restoreBtn");
    btn.disabled = true;
    msg.className = ""; msg.textContent = "復元中です。画面を閉じないでください…";
    api("/api/admin/restore", { method: "POST", body: f, headers: { "Content-Type": "application/x-ndjson" } })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (!r.ok) {
            var m = d.error === "incomplete" ? "ファイルの最後が欠けています。保存し直したファイルで試してください。"
              : d.error === "bad_file" || d.error === "bad_version" ? "このファイルは読み込めませんでした。"
              : "復元に失敗しました（何も変更されていません）。";
            throw new Error(m);
          }
          return d.restored;
        });
      })
      .then(function (n) {
        msg.className = "ok";
        msg.textContent = "復元しました。投稿 " + n.posts + "、コメント " + n.comments + "、いいね " + n.likes + " を追加しました。";
        loadStats(); loadReported(); loadRecent(true);
      })
      .catch(function (e) { msg.className = "err"; msg.textContent = e && e.message ? e.message : "復元に失敗しました。"; })
      .then(function () { btn.disabled = false; });
  });

  /* ---------- ログイン ---------- */
  function enter() {
    return loadStats().then(function () {
      showApp(true);
      loadReported();
      loadRecent(true);
    });
  }
  $("loginForm").addEventListener("submit", function (e) {
    e.preventDefault();
    token = $("token").value.trim();
    $("token").value = "";
    if (!token) return;
    $("loginMsg").textContent = "";
    enter().then(function () {
      try { sessionStorage.setItem(KEY, token); } catch (err) {}
    }).catch(function (err) {
      logout(err && err.message === "rate" ? "失敗が続いたため、しばらく使えません。" :
        err && err.message === "auth" ? "合言葉が違います。" : "読み込めませんでした。");
    });
  });
  $("logout").addEventListener("click", function () { logout(""); });
  if (token) enter().catch(function () { logout(""); });
})();
