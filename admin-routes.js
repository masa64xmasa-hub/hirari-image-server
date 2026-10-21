"use strict";

// 管理者用のAPI。ADMIN_TOKEN を知っている人だけが使える。
// 統計・通報の確認・削除・バックアップ・復元。

const readline = require("readline");
const rateLimit = require("express-rate-limit");
const express = require("express");

const BACKUP_VERSION = 1;

function registerAdmin(app, deps) {
  const { pool, tokenOk, UUID_RE, REPORT_LIMIT, simEnabled } = deps;

  // 合言葉をまちがえた回数が多いIPは、1時間ほど止める（成功した分は数えない）
  const failLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 30,
    skipSuccessfulRequests: true,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "rate_limited" },
  });
  function bearer(req) {
    return String(req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  }
  // ヘッダーの Bearer か、フォームの token のどちらでもよい（バックアップのダウンロード用）
  function adminOnly(req, res, next) {
    const given = bearer(req) || (req.body && typeof req.body.token === "string" ? req.body.token : "");
    if (!tokenOk(given)) return res.sendStatus(403);
    next();
  }
  const guard = [failLimiter, adminOnly];
  const form = express.urlencoded({ extended: false, limit: "4kb" });

  /* ---------- 統計 ---------- */
  app.get("/api/admin/stats", guard, async (req, res, next) => {
    try {
      const q = await pool.query(
        `SELECT
           (SELECT count(*) FROM posts)::int AS posts,
           (SELECT count(*) FROM posts WHERE reports >= $1)::int AS hidden_posts,
           (SELECT count(*) FROM posts WHERE reports > 0)::int AS reported_posts,
           (SELECT count(*) FROM comments)::int AS comments,
           (SELECT count(*) FROM comments WHERE reports > 0)::int AS reported_comments,
           (SELECT count(*) FROM likes)::int AS likes,
           (SELECT count(*) FROM posts WHERE embedding IS NOT NULL)::int AS embedded,
           (SELECT count(*) FROM posts WHERE created_at > now() - interval '1 day')::int AS posts_24h,
           (SELECT count(*) FROM similar_pairs WHERE verdict IS NULL)::int AS pairs_pending,
           (SELECT count(*) FROM similar_pairs WHERE verdict IS NOT NULL)::int AS pairs_judged,
           (SELECT COALESCE(sum(octet_length(image)), 0) FROM posts)::bigint AS image_bytes,
           pg_database_size(current_database())::bigint AS db_bytes`,
        [REPORT_LIMIT]
      );
      const r = q.rows[0];
      res.json({
        posts: r.posts,
        hiddenPosts: r.hidden_posts,
        reportedPosts: r.reported_posts,
        comments: r.comments,
        reportedComments: r.reported_comments,
        likes: r.likes,
        embedded: r.embedded,
        posts24h: r.posts_24h,
        pairsPending: r.pairs_pending,
        pairsJudged: r.pairs_judged,
        imageBytes: Number(r.image_bytes),
        dbBytes: Number(r.db_bytes),
        similarity: !!simEnabled,
        rssBytes: process.memoryUsage().rss,
        uptimeSec: Math.round(process.uptime()),
      });
    } catch (e) {
      next(e);
    }
  });

  /* ---------- 投稿・コメントの一覧 ---------- */
  const postRow = (r) => ({
    id: r.id,
    title: r.title,
    tags: r.tags,
    reports: r.reports,
    hidden: r.reports >= REPORT_LIMIT,
    createdAt: r.ct,
    likes: r.like_count,
    comments: r.comment_count,
  });
  const POST_SELECT = `SELECT p.id, p.title, p.tags, p.reports, p.created_at::text AS ct,
       (SELECT count(*) FROM likes l WHERE l.post_id = p.id)::int AS like_count,
       (SELECT count(*) FROM comments c WHERE c.post_id = p.id)::int AS comment_count
     FROM posts p`;

  // filter=reported: 通報された投稿とコメント / filter=all: 新しい順に全部
  app.get("/api/admin/posts", guard, async (req, res, next) => {
    try {
      if (req.query.filter === "reported") {
        const posts = await pool.query(`${POST_SELECT} WHERE p.reports > 0 ORDER BY p.reports DESC, p.created_at DESC LIMIT 100`);
        const comments = await pool.query(
          `SELECT id, post_id, body, reports, created_at::text AS ct
             FROM comments WHERE reports > 0 ORDER BY reports DESC, created_at DESC LIMIT 100`
        );
        return res.json({
          posts: posts.rows.map(postRow),
          comments: comments.rows.map((c) => ({
            id: c.id, postId: c.post_id, body: c.body, reports: c.reports, createdAt: c.ct,
          })),
        });
      }
      const before = typeof req.query.before === "string" && req.query.before.length < 64 ? req.query.before : null;
      let rows;
      try {
        ({ rows } = await pool.query(
          `${POST_SELECT} WHERE ($1::timestamptz IS NULL OR p.created_at < $1::timestamptz)
            ORDER BY p.created_at DESC LIMIT 30`,
          [before]
        ));
      } catch (e) {
        return res.status(400).json({ error: "bad_before" });
      }
      res.json({ posts: rows.map(postRow), comments: [] });
    } catch (e) {
      next(e);
    }
  });

  // 非表示中の絵も確認できるサムネイル（<img>ではヘッダーを付けられないので、画面側でfetchして表示する）
  app.get("/api/admin/thumb/:id", guard, async (req, res, next) => {
    try {
      if (!UUID_RE.test(req.params.id)) return res.sendStatus(404);
      const { rows } = await pool.query("SELECT COALESCE(thumb, image) AS img FROM posts WHERE id = $1", [req.params.id]);
      if (!rows.length) return res.sendStatus(404);
      res.set("Content-Type", "image/jpeg");
      res.set("Cache-Control", "private, no-store");
      res.send(rows[0].img);
    } catch (e) {
      next(e);
    }
  });

  // 通報を取り消す（非表示も解除される）
  for (const [kind, table] of [["post", "posts"], ["comment", "comments"]]) {
    app.post(`/api/admin/${table}/:id/clear`, guard, async (req, res, next) => {
      try {
        if (!UUID_RE.test(req.params.id)) return res.sendStatus(404);
        await pool.query("DELETE FROM report_log WHERE kind = $1 AND target = $2", [kind, req.params.id]);
        const { rowCount } = await pool.query(`UPDATE ${table} SET reports = 0 WHERE id = $1`, [req.params.id]);
        res.sendStatus(rowCount ? 204 : 404);
      } catch (e) {
        next(e);
      }
    });
  }

  /* ---------- バックアップ ---------- */
  // 1行1件のJSON（NDJSON）で、少しずつ流して送る。メモリを使いすぎないため。
  app.post("/api/admin/backup", form, guard, async (req, res, next) => {
    let started = false;
    try {
      const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
      res.set({
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Content-Disposition": `attachment; filename="hirari-backup-${stamp}.ndjson"`,
        "Cache-Control": "no-store",
      });
      started = true;
      let closed = false;
      res.on("close", () => { closed = true; });
      const write = async (obj) => {
        if (closed) throw new Error("closed");
        if (!res.write(JSON.stringify(obj) + "\n")) {
          await new Promise((resolve) => { res.once("drain", resolve); res.once("close", resolve); });
        }
      };
      const b64 = (b) => (b ? b.toString("base64") : null);

      await write({ t: "meta", v: BACKUP_VERSION, at: new Date().toISOString() });

      let cursor = null;
      for (;;) {
        const { rows } = await pool.query(
          `SELECT id, title, tags, token_hash, created_at::text AS ct, image, embedding
             FROM posts
            WHERE ($1::timestamptz IS NULL OR created_at > $1::timestamptz
                   OR (created_at = $1::timestamptz AND id > $2::uuid))
            ORDER BY created_at, id LIMIT 20`,
          cursor ? [cursor.ct, cursor.id] : [null, null]
        );
        if (!rows.length) break;
        for (const r of rows) {
          await write({
            t: "post", id: r.id, title: r.title, tags: r.tags, token_hash: r.token_hash,
            created_at: r.ct, image: b64(r.image), embedding: b64(r.embedding),
          });
        }
        cursor = { ct: rows[rows.length - 1].ct, id: rows[rows.length - 1].id };
      }
      const likes = await pool.query("SELECT post_id, client_id, created_at::text AS ct FROM likes");
      for (const r of likes.rows) await write({ t: "like", post_id: r.post_id, client_id: r.client_id, created_at: r.ct });
      const comments = await pool.query(
        "SELECT id, post_id, body, client_id, created_at::text AS ct FROM comments ORDER BY created_at"
      );
      for (const r of comments.rows) {
        await write({ t: "comment", id: r.id, post_id: r.post_id, body: r.body, client_id: r.client_id, created_at: r.ct });
      }
      const pairs = await pool.query(
        `SELECT id, a_id, b_id, score, verdict, judged_at::text AS jt, created_at::text AS ct FROM similar_pairs`
      );
      for (const r of pairs.rows) {
        await write({
          t: "pair", id: r.id, a_id: r.a_id, b_id: r.b_id, score: r.score, verdict: r.verdict,
          judged_at: r.jt, created_at: r.ct,
        });
      }
      await write({ t: "end" }); // この行があれば、最後まで書き出せたことが分かる
      res.end();
    } catch (e) {
      if (started) {
        console.error("バックアップ中に失敗", e);
        res.destroy(); // 途中で切れたことが、ダウンロード側に伝わるようにする
      } else {
        next(e);
      }
    }
  });

  /* ---------- 復元 ---------- */
  // バックアップのファイルをそのまま本文として送る。すでにある投稿は上書きせず、足りないものだけ足す。
  app.post("/api/admin/restore", guard, async (req, res, next) => {
    const client = await pool.connect();
    const n = { posts: 0, likes: 0, comments: 0, pairs: 0, skipped: 0 };
    let sawEnd = false;
    try {
      await client.query("BEGIN");
      const rl = readline.createInterface({ input: req, crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line.trim()) continue;
        let o;
        try { o = JSON.parse(line); } catch (e) { throw Object.assign(new Error("bad_line"), { code: "bad_file" }); }
        if (!o || typeof o !== "object") continue;
        if (o.t === "meta") {
          if (o.v !== BACKUP_VERSION) throw Object.assign(new Error("bad_version"), { code: "bad_version" });
        } else if (o.t === "end") {
          sawEnd = true;
        } else if (o.t === "post") {
          if (!UUID_RE.test(o.id) || !o.image || typeof o.token_hash !== "string") { n.skipped++; continue; }
          const tags = Array.isArray(o.tags) ? o.tags.filter((x) => typeof x === "string").slice(0, 5) : [];
          const r = await client.query(
            `INSERT INTO posts (id, title, image, token_hash, tags, embedding, created_at)
             VALUES ($1::uuid, $2::text, $3::bytea, $4::text, $5::text[], $6::bytea, $7::timestamptz)
             ON CONFLICT (id) DO NOTHING`,
            [o.id, String(o.title || "").slice(0, 40), Buffer.from(o.image, "base64"), o.token_hash, tags,
             o.embedding ? Buffer.from(o.embedding, "base64") : null, o.created_at]
          );
          n.posts += r.rowCount;
        } else if (o.t === "like") {
          const r = await client.query(
            `INSERT INTO likes (post_id, client_id, created_at)
             SELECT $1::uuid, $2::text, $3::timestamptz WHERE EXISTS (SELECT 1 FROM posts WHERE id = $1::uuid)
             ON CONFLICT DO NOTHING`,
            [o.post_id, String(o.client_id), o.created_at]
          );
          n.likes += r.rowCount;
        } else if (o.t === "comment") {
          const r = await client.query(
            `INSERT INTO comments (id, post_id, body, client_id, created_at)
             SELECT $1::uuid, $2::uuid, $3::text, $4::text, $5::timestamptz WHERE EXISTS (SELECT 1 FROM posts WHERE id = $2::uuid)
             ON CONFLICT (id) DO NOTHING`,
            [o.id, o.post_id, String(o.body).slice(0, 200), String(o.client_id), o.created_at]
          );
          n.comments += r.rowCount;
        } else if (o.t === "pair") {
          const r = await client.query(
            `INSERT INTO similar_pairs (id, a_id, b_id, score, verdict, judged_at, created_at)
             SELECT $1::uuid, $2::uuid, $3::uuid, $4::real, $5::text, $6::timestamptz, $7::timestamptz
              WHERE EXISTS (SELECT 1 FROM posts WHERE id = $2::uuid) AND EXISTS (SELECT 1 FROM posts WHERE id = $3::uuid)
             ON CONFLICT DO NOTHING`,
            [o.id, o.a_id, o.b_id, o.score, o.verdict || null, o.judged_at || null, o.created_at]
          );
          n.pairs += r.rowCount;
        }
      }
      if (!sawEnd) throw Object.assign(new Error("incomplete"), { code: "incomplete" });
      await client.query("COMMIT");
      res.json({ ok: true, restored: n });
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch (e2) { /* 接続が切れていても続ける */ }
      if (e && e.code === "bad_file") return res.status(400).json({ error: "bad_file" });
      if (e && e.code === "bad_version") return res.status(400).json({ error: "bad_version" });
      if (e && e.code === "incomplete") return res.status(400).json({ error: "incomplete" });
      console.error("復元に失敗", e);
      res.status(500).json({ error: "restore_failed" });
    } finally {
      client.release();
    }
  });
}

module.exports = { registerAdmin };
