"use strict";

const crypto = require("crypto");
const path = require("path");
const express = require("express");
const helmet = require("helmet");
const multer = require("multer");
const sharp = require("sharp");
const { Pool } = require("pg");
const rateLimit = require("express-rate-limit");

const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const REPORT_LIMIT = 3; // この回数通報された投稿は非表示にする
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
  `);
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

const postLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate_limited" },
});
const reportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate_limited" },
});

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

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
      `SELECT id, title, created_at
         FROM posts
        WHERE reports < $1 AND ($2::timestamptz IS NULL OR created_at < $2::timestamptz)
        ORDER BY created_at DESC
        LIMIT $3`,
      [REPORT_LIMIT, before, limit]
    );
    res.json({
      posts: rows.map((r) => ({ id: r.id, title: r.title, createdAt: r.created_at.toISOString() })),
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
    res.status(201).json({
      id: rows[0].id,
      title,
      createdAt: rows[0].created_at.toISOString(),
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

// 管理者用: Authorization: Bearer <ADMIN_TOKEN> で任意の投稿を削除する
app.delete("/api/admin/posts/:id", async (req, res, next) => {
  try {
    const given = String(req.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const a = Buffer.from(sha256(given));
    const b = Buffer.from(sha256(ADMIN_TOKEN));
    if (!ADMIN_TOKEN || !crypto.timingSafeEqual(a, b)) return res.sendStatus(403);
    if (!UUID_RE.test(req.params.id)) return res.sendStatus(404);
    const { rowCount } = await pool.query("DELETE FROM posts WHERE id = $1", [req.params.id]);
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
  .then(() => app.listen(PORT, () => console.log("ひらり: port " + PORT)))
  .catch((e) => {
    console.error("DBの初期化に失敗しました", e);
    process.exit(1);
  });
