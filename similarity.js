"use strict";

// 絵の「特徴ベクトル」の計算まわり。
// ・計算そのもの（CLIP）は重いので、別プロセス(embed-worker.js)に任せる。
// ・別プロセスは、使うときだけ起動し、しばらく使われなければ終了してメモリを空ける。
//   無料プランのメモリ(512MB)でサイト本体が落ちないようにするため。

const { fork } = require("child_process");
const path = require("path");

/* ---------- ベクトルの基本計算 ---------- */
function normalize(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const n = Math.sqrt(sum) || 1;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / n;
  return out;
}

// Float32Array <-> Buffer（DBのbytea列に入れる形）。環境に左右されないよう、リトルエンディアンで固定する
function toBuffer(vec) {
  const buf = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
  return buf;
}
function fromBuffer(buf) {
  const out = new Float32Array(Math.floor(buf.length / 4));
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

// コサイン類似度。1に近いほど似ている。長さが違うベクトルは比べられない（0を返す）
function cosine(a, b) {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d ? dot / d : 0;
}

// candidates: [{id, createdAt, vec}] のうち、vec と minScore 以上で似ているものを、似ている順に返す
function findSimilar(vec, candidates, minScore) {
  const hits = [];
  for (const c of candidates) {
    const score = cosine(vec, c.vec);
    if (score >= minScore) hits.push({ id: c.id, createdAt: c.createdAt, score });
  }
  hits.sort((x, y) => y.score - x.score);
  return hits;
}

// 2つの投稿のうち、先に投稿されたほうが「元の絵(older)」。同時刻ならidの順
function orderPair(x, y) {
  const tx = new Date(x.createdAt).getTime();
  const ty = new Date(y.createdAt).getTime();
  if (tx < ty || (tx === ty && String(x.id) < String(y.id))) return { older: x, newer: y };
  return { older: y, newer: x };
}

/* ---------- 別プロセスで特徴ベクトルを計算する ---------- */
class Embedder {
  constructor(opts) {
    opts = opts || {};
    this.workerPath = opts.workerPath || path.join(__dirname, "embed-worker.js");
    this.idleMs = opts.idleMs == null ? 120000 : opts.idleMs;       // 使われなくなってから終了するまで
    this.timeoutMs = opts.timeoutMs == null ? 180000 : opts.timeoutMs; // 1枚の計算の制限時間（モデルの初回読み込み込み）
    this.child = null;
    this.pending = new Map();
    this.seq = 1;
    this.idleTimer = null;
  }

  _spawn() {
    const child = fork(this.workerPath, [], {
      execArgv: ["--max-old-space-size=256"],
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    child.on("message", (m) => {
      if (!m || m.id == null) return;
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new Error(m.error));
      else p.resolve(fromBuffer(Buffer.from(m.embedding, "base64")));
      this._armIdle();
    });
    const onGone = (why) => {
      if (this.child === child) this.child = null;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("worker stopped: " + why));
        this.pending.delete(id);
      }
    };
    child.on("exit", (code, sig) => onGone("exit " + (code != null ? code : sig)));
    child.on("error", (e) => onGone(e.message));
    return child;
  }

  _armIdle() {
    clearTimeout(this.idleTimer);
    if (this.pending.size > 0 || !this.child) return;
    this.idleTimer = setTimeout(() => this.stop(), this.idleMs);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }

  // 画像(Buffer)から、長さ1に揃えた特徴ベクトル(Float32Array)を返す
  embed(imageBuffer) {
    return new Promise((resolve, reject) => {
      clearTimeout(this.idleTimer);
      if (!this.child) this.child = this._spawn();
      const child = this.child;
      const id = this.seq++;
      const timer = setTimeout(() => {
        // 固まったら、その別プロセスごと止める（次の呼び出しで起動し直す）
        this.pending.delete(id);
        reject(new Error("embed timeout"));
        try { child.kill("SIGKILL"); } catch (e) {}
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.send({ id, image: imageBuffer.toString("base64") });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  stop() {
    clearTimeout(this.idleTimer);
    const c = this.child;
    this.child = null;
    if (c) { try { c.kill(); } catch (e) {} }
  }
}

module.exports = { normalize, toBuffer, fromBuffer, cosine, findSimilar, orderPair, Embedder };
