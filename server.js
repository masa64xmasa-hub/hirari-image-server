"use strict";

const crypto = require("crypto");
const path = require("path");
const express = require("express");
const helmet = require("helmet");
const multer = require("multer");
const sharp = require("sharp");
const { Pool } = require("pg");
const rateLimit = require("express-rate-limit");
const { toBuffer, fromBuffer, findSimilar, orderPair, Embedder } = require("./similarity");

const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const REPORT_LIMIT = 3; // この回数通報された投稿・コメントは非表示にする
const COMMENT_MAX = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLIENT_RE = /^[A-Za-z0-9_-]{16,64}$/;
const TOKEN_RE = /^[0-9a-f]{48}$/;

// 似ている絵の検出（ENABLE_SIMILARITY=1 のときだけ動く）
const SIM_ENABLED = process.env.ENABLE_SIMILARITY === "1";
function numEnv(name, fallback, lo, hi) {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
}
const SIM_SHOW = numEnv("SIMILARITY_THRESHOLD", 0.85, 0.5, 0.99); // 原作者に見せる類似度
const SIM_STORE = Math.min(0.75, SIM_SHOW);                        // 記録しておく類似度（しきい値を下げ直せるように）
const VERDICTS = ["plagiarism", "safe", "unrelated"];

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL が設定されていません。");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // 外部URLでつなぐ場合だけ DATABASE_SSL=1 を設定する（Render内部URLでは不要）
  ssl: process.env.DATABASE_SSL === "1" ? { rejectUnauthorized: false } : undefined,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS posts (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      title       text NOT NULL DEFAULT '',
      image       bytea NOT NULL,
      token_hash  text NOT NULL,
      reports     integer NOT NULL DEFAULT 0,
      created_at  timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS posts_created_idx ON posts (created_at DESC);

    CREATE TABLE IF NOT EXISTS likes (
      post_id    uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      client_id  text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (post_id, client_id)
    );

    CREATE TABLE IF NOT EXISTS comments (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      post_id    uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      body       text NOT NULL,
      client_id  text NOT NULL,
      reports    integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS comments_post_idx ON comments (post_id, created_at);

    -- 絵の特徴ベクトル（512個の数字をfloat32で並べたもの）
    ALTER TABLE posts ADD COLUMN IF NOT EXISTS embedding bytea;

    -- 似ている絵のペア。a が先に投稿された絵（原作者の候補）、b が後から投稿された絵
    CREATE TABLE IF NOT EXISTS similar_pairs (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      a_id       uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      b_id       uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      score      real NOT NULL,
      verdict    text CHECK (verdict IN ('plagiarism', 'safe', 'unrelated')),
      judged_at  timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (a_id, b_id)
    );
    CREATE INDEX IF NOT EXISTS similar_pairs_a_idx ON similar_pairs (a_id);
  `);
}

/* ---------- 似ている絵の検出 ---------- */
const embedder = SIM_ENABLED ? new Embedder() : null;
const simQueue = [];
const simQueued = new Set();
let simRunning = false;

async function processEmbedding(postId) {
  const { rows } = await pool.query(
    "SELECT image FROM posts WHERE id = $1 AND embedding IS NULL AND reports < $2",
    [postId, REPORT_LIMIT]
  );
  if (!rows.length) return;
  const vec = await embedder.embed(rows[0].image);
  await pool.query("UPDATE posts SET embedding = $2 WHERE id = $1", [postId, toBuffer(vec)]);

  const me = await pool.query("SELECT created_at FROM posts WHERE id = $1", [postId]);
  if (!me.rows.length) return; // 計算中に削除された
  const others = await pool.query(
    "SELECT id, created_at, embedding FROM posts WHERE embedding IS NOT NULL AND id <> $1 AND reports < $2",
    [postId, REPORT_LIMIT]
  );
  const hits = findSimilar(
    vec,
    others.rows.map((r) => ({ id: r.id, createdAt: r.created_at, vec: fromBuffer(r.embedding) })),
    SIM_STORE
  );
  for (const h of hits) {
    const { older, newer } = orderPair(
      { id: postId, createdAt: me.rows[0].created_at },
      { id: h.id, createdAt: h.createdAt }
    );
    await pool.query(
      `INSERT INTO similar_pairs (a_id, b_id, score) VALUES ($1, $2, $3)
       ON CONFLICT (a_id, b_id) DO NOTHING`,
      [older.id, newer.id, h.score]
    );
  }
}

async function runSimQueue() {
  if (simRunning) return;
  simRunning = true;
  try {
    while (simQueue.length) {
      const id = simQueue.shift();
      try {
        await processEmbedding(id);
      } catch (e) {
        console.error("特徴ベクトルの計算に失敗:", id, e && e.message); // 次の起動時にもう一度試される
      } finally {
        simQueued.delete(id);
      }
    }
  } finally {
    simRunning = false;
  }
}

function enqueueEmbedding(id) {
  if (!SIM_ENABLED || simQueued.has(id)) return;
  simQueued.add(id);
  simQueue.push(id);
  runSimQueue();
}

async function enqueueBacklog() {
  const { rows } = await pool.query(
    "SELECT id FROM posts WHERE embedding IS NULL AND reports < $1 ORDER BY created_at ASC",
    [REPORT_LIMIT]
  );
  rows.forEach((r) => enqueueEmbedding(r.id));
}

const app = express();
app.set("trust proxy", 1); // Renderのプロキシ越しに本当のIPを見る

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "script-src": ["'self'"],
        "style-src": ["'self'", "https://fonts.googleapis.com"],
        "font-src": ["https://fonts.gstatic.com"],
        "img-src": ["'self'", "data:", "blob:"],
        "upgrade-insecure-requests": null,
      },
    },
  })
);
app.use(express.json({ limit: "10kb" }));

/* ---------- 投稿の受け取り ---------- */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

function limiter(limit) {
  return rateLimit({
    windowMs: 60 * 60 * 1000,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "rate_limited" },
  });
}
const postLimiter = limiter(12);
const reportLimiter = limiter(30);
const likeLimiter = limiter(200);
const commentLimiter = limiter(20);

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

// ブラウザごとの匿名ID。いいねの重複防止と、自分のコメントの判定に使う
function clientId(req) {
  const v = String(req.get("x-client-id") || "");
  return CLIENT_RE.test(v) ? v : null;
}

function isAdmin(req) {
  const given = String(req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!ADMIN_TOKEN) return false;
  return crypto.timingSafeEqual(Buffer.from(sha256(given)), Buffer.from(sha256(ADMIN_TOKEN)));
}

/* ---------- API ---------- */
app.get("/healthz", (req, res) => res.type("text").send("ok"));

app.get("/api/posts", async (req, res, next) => {
  try {
    const limit = Math.min(30, Math.max(1, parseInt(req.query.limit, 10) || 12));
    let before = null;
    if (req.query.before) {
      const t = new Date(String(req.query.before));
      if (!Number.isNaN(t.getTime())) before = t.toISOString();
    }
    const { rows } = await pool.query(
      `SELECT p.id, p.title, p.created_at,
              (SELECT count(*) FROM likes l WHERE l.post_id = p.id)::int AS like_count,
              (SELECT count(*) FROM comments c WHERE c.post_id = p.id AND c.reports < $1)::int AS comment_count,
              EXISTS (SELECT 1 FROM likes l WHERE l.post_id = p.id AND l.client_id = $4::text) AS liked
         FROM posts p
        WHERE p.reports < $1 AND ($2::timestamptz IS NULL OR p.created_at < $2::timestamptz)
        ORDER BY p.created_at DESC
        LIMIT $3`,
      [REPORT_LIMIT, before, limit, clientId(req)]
    );
    res.json({
      posts: rows.map((r) => ({
        id: r.id,
        title: r.title,
        createdAt: r.created_at.toISOString(),
        likes: r.like_count,
        comments: r.comment_count,
        liked: r.liked,
      })),
    });
  } catch (e) {
    next(e);
  }
});

app.get("/img/:id", async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.sendStatus(404);
    const { rows } = await pool.query(
      "SELECT image FROM posts WHERE id = $1 AND reports < $2",
      [req.params.id, REPORT_LIMIT]
    );
    if (!rows.length) return res.sendStatus(404);
    res.set("Content-Type", "image/jpeg");
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.send(rows[0].image);
  } catch (e) {
    next(e);
  }
});

app.post("/api/posts", postLimiter, upload.single("photo"), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "no_image" });

    let jpeg;
    try {
      // 向きを直し、1600px以内に縮め、JPEGで保存し直す。
      // 再エンコードで位置情報などのメタデータも消える。
      jpeg = await sharp(req.file.buffer, { limitInputPixels: 60e6 })
        .rotate()
        .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: 82, mozjpeg: true })
        .toBuffer();
    } catch (e) {
      return res.status(400).json({ error: "bad_image" });
    }

    const title = String(req.body.title || "").trim().slice(0, 40);
    const deleteToken = crypto.randomBytes(24).toString("hex");
    const { rows } = await pool.query(
      `INSERT INTO posts (title, image, token_hash)
       VALUES ($1, $2, $3)
       RETURNING id, created_at`,
      [title, jpeg, sha256(deleteToken)]
    );
    enqueueEmbedding(rows[0].id); // 似ている絵の検出は、返事のあとで裏で行う
    res.status(201).json({
      id: rows[0].id,
      title,
      createdAt: rows[0].created_at.toISOString(),
      likes: 0,
      comments: 0,
      liked: false,
      deleteToken,
    });
  } catch (e) {
    next(e);
  }
});

app.delete("/api/posts/:id", async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.sendStatus(404);
    const token = String(req.get("x-delete-token") || "");
    if (!token) return res.sendStatus(403);
    const { rowCount } = await pool.query(
      "DELETE FROM posts WHERE id = $1 AND token_hash = $2",
      [req.params.id, sha256(token)]
    );
    res.sendStatus(rowCount ? 204 : 403);
  } catch (e) {
    next(e);
  }
});

app.post("/api/posts/:id/report", reportLimiter, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.sendStatus(404);
    await pool.query("UPDATE posts SET reports = reports + 1 WHERE id = $1", [req.params.id]);
    res.sendStatus(204);
  } catch (e) {
    next(e);
  }
});

/* ---------- いいね ---------- */
async function likeCount(postId) {
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM likes WHERE post_id = $1", [postId]);
  return rows[0].n;
}

app.post("/api/posts/:id/like", likeLimiter, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.sendStatus(404);
    const cid = clientId(req);
    if (!cid) return res.status(400).json({ error: "no_client" });
    try {
      await pool.query(
        "INSERT INTO likes (post_id, client_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [req.params.id, cid]
      );
    } catch (e) {
      if (e.code === "23503") return res.sendStatus(404); // 投稿が存在しない
      throw e;
    }
    res.json({ likes: await likeCount(req.params.id), liked: true });
  } catch (e) {
    next(e);
  }
});

app.delete("/api/posts/:id/like", likeLimiter, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.sendStatus(404);
    const cid = clientId(req);
    if (!cid) return res.status(400).json({ error: "no_client" });
    await pool.query("DELETE FROM likes WHERE post_id = $1 AND client_id = $2", [req.params.id, cid]);
    res.json({ likes: await likeCount(req.params.id), liked: false });
  } catch (e) {
    next(e);
  }
});

/* ---------- コメント ---------- */
app.get("/api/posts/:id/comments", async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.sendStatus(404);
    const { rows } = await pool.query(
      `SELECT id, body, created_at, COALESCE(client_id = $3::text, false) AS mine
         FROM (SELECT * FROM comments
                WHERE post_id = $1 AND reports < $2
                ORDER BY created_at DESC
                LIMIT 100) t
        ORDER BY created_at ASC`,
      [req.params.id, REPORT_LIMIT, clientId(req)]
    );
    res.json({
      comments: rows.map((r) => ({
        id: r.id,
        body: r.body,
        createdAt: r.created_at.toISOString(),
        mine: r.mine,
      })),
    });
  } catch (e) {
    next(e);
  }
});

app.post("/api/posts/:id/comments", commentLimiter, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.sendStatus(404);
    const cid = clientId(req);
    if (!cid) return res.status(400).json({ error: "no_client" });
    const body = String((req.body && req.body.body) || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!body) return res.status(400).json({ error: "empty" });
    if (Array.from(body).length > COMMENT_MAX) return res.status(400).json({ error: "too_long" });
    let rows;
    try {
      ({ rows } = await pool.query(
        `INSERT INTO comments (post_id, body, client_id)
         VALUES ($1, $2, $3)
         RETURNING id, created_at`,
        [req.params.id, body, cid]
      ));
    } catch (e) {
      if (e.code === "23503") return res.sendStatus(404); // 投稿が存在しない
      throw e;
    }
    res.status(201).json({
      id: rows[0].id,
      body,
      createdAt: rows[0].created_at.toISOString(),
      mine: true,
    });
  } catch (e) {
    next(e);
  }
});

app.delete("/api/comments/:id", async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.sendStatus(404);
    const cid = clientId(req);
    if (!cid) return res.sendStatus(403);
    const { rowCount } = await pool.query(
      "DELETE FROM comments WHERE id = $1 AND client_id = $2",
      [req.params.id, cid]
    );
    res.sendStatus(rowCount ? 204 : 403);
  } catch (e) {
    next(e);
  }
});

app.post("/api/comments/:id/report", reportLimiter, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.sendStatus(404);
    await pool.query("UPDATE comments SET reports = reports + 1 WHERE id = $1", [req.params.id]);
    res.sendStatus(204);
  } catch (e) {
    next(e);
  }
});

/* ---------- 似ている絵の確認（原作者向け） ---------- */
const reviewLimiter = limiter(120);

// 自分の投稿の削除キーを送ると、その絵に似た絵（後から投稿されたもの）の一覧が返る
app.post("/api/review/list", reviewLimiter, async (req, res, next) => {
  try {
    if (!SIM_ENABLED) return res.json({ enabled: false, pairs: [] });
    const raw = Array.isArray(req.body && req.body.tokens) ? req.body.tokens : [];
    const hashes = raw
      .filter((t) => typeof t === "string" && TOKEN_RE.test(t))
      .slice(0, 100)
      .map(sha256);
    if (!hashes.length) return res.json({ enabled: true, pairs: [] });
    const { rows } = await pool.query(
      `SELECT sp.id, sp.score,
              a.id AS a_id, a.title AS a_title, a.created_at AS a_at,
              b.id AS b_id, b.title AS b_title, b.created_at AS b_at
         FROM similar_pairs sp
         JOIN posts a ON a.id = sp.a_id
         JOIN posts b ON b.id = sp.b_id
        WHERE a.token_hash = ANY($1::text[])
          AND sp.verdict IS NULL AND sp.score >= $2
          AND a.reports < $3 AND b.reports < $3
        ORDER BY sp.score DESC, sp.created_at DESC
        LIMIT 50`,
      [hashes, SIM_SHOW, REPORT_LIMIT]
    );
    res.json({
      enabled: true,
      pairs: rows.map((r) => ({
        id: r.id,
        score: r.score,
        original: { id: r.a_id, title: r.a_title, createdAt: r.a_at.toISOString() },
        other: { id: r.b_id, title: r.b_title, createdAt: r.b_at.toISOString() },
      })),
    });
  } catch (e) {
    next(e);
  }
});

// 原作者（先に投稿した側の削除キーを持つ人）だけが判定できる。判定は本人にしか見えず、投稿には影響しない
app.post("/api/review/:id/verdict", reviewLimiter, async (req, res, next) => {
  try {
    if (!SIM_ENABLED) return res.sendStatus(404);
    if (!UUID_RE.test(req.params.id)) return res.sendStatus(404);
    const token = String((req.body && req.body.token) || "");
    const verdict = String((req.body && req.body.verdict) || "");
    if (!TOKEN_RE.test(token)) return res.sendStatus(403);
    if (!VERDICTS.includes(verdict)) return res.status(400).json({ error: "bad_verdict" });
    const { rowCount } = await pool.query(
      `UPDATE similar_pairs sp
          SET verdict = $1, judged_at = now()
         FROM posts a
        WHERE sp.id = $2 AND a.id = sp.a_id AND a.token_hash = $3`,
      [verdict, req.params.id, sha256(token)]
    );
    res.sendStatus(rowCount ? 204 : 403);
  } catch (e) {
    next(e);
  }
});

/* ---------- 管理者用 ---------- */
// 判定済みのペアの類似度と判定を返す（しきい値を決める材料）
app.get("/api/admin/verdicts", async (req, res, next) => {
  try {
    if (!isAdmin(req)) return res.sendStatus(403);
    const { rows } = await pool.query(
      `SELECT score, verdict, judged_at FROM similar_pairs
        WHERE verdict IS NOT NULL ORDER BY judged_at DESC LIMIT 5000`
    );
    res.json({
      threshold: SIM_SHOW,
      verdicts: rows.map((r) => ({ score: r.score, verdict: r.verdict, judgedAt: r.judged_at.toISOString() })),
    });
  } catch (e) {
    next(e);
  }
});

// Authorization: Bearer <ADMIN_TOKEN> で任意の投稿・コメントを削除する
app.delete("/api/admin/posts/:id", async (req, res, next) => {
  try {
    if (!isAdmin(req)) return res.sendStatus(403);
    if (!UUID_RE.test(req.params.id)) return res.sendStatus(404);
    const { rowCount } = await pool.query("DELETE FROM posts WHERE id = $1", [req.params.id]);
    res.sendStatus(rowCount ? 204 : 404);
  } catch (e) {
    next(e);
  }
});

app.delete("/api/admin/comments/:id", async (req, res, next) => {
  try {
    if (!isAdmin(req)) return res.sendStatus(403);
    if (!UUID_RE.test(req.params.id)) return res.sendStatus(404);
    const { rowCount } = await pool.query("DELETE FROM comments WHERE id = $1", [req.params.id]);
    res.sendStatus(rowCount ? 204 : 404);
  } catch (e) {
    next(e);
  }
});

/* ---------- 画面 ---------- */
app.use(express.static(path.join(__dirname, "public"), { maxAge: "5m" }));

/* ---------- エラー処理 ---------- */
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.code === "LIMIT_FILE_SIZE" ? "too_large" : "bad_upload" });
  }
  console.error(err);
  res.status(500).json({ error: "server_error" });
});

initDb()
  .then(() =>
    app.listen(PORT, () => {
      console.log("ひらり: port " + PORT + (SIM_ENABLED ? "（似ている絵の検出: ON）" : ""));
      if (SIM_ENABLED) enqueueBacklog().catch((e) => console.error("未処理の絵の取得に失敗", e));
    })
  )
  .catch((e) => {
    console.error("DBの初期化に失敗しました", e);
    process.exit(1);
  });
