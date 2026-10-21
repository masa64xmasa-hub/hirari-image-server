"use strict";

// おすすめの並べ方と、タグの整え方。DBやネットワークに触らない純粋な関数だけを置く。

const { cosine } = require("./similarity");

/* ---------- タグ ---------- */
const TAG_RE = /^[\p{L}\p{N}_-]{1,20}$/u;
const MAX_TAGS = 5;

// "#猫 #Cat、犬" のような文字列から、使えるタグ(最大5個)の配列を作る
function parseTags(input) {
  const list = Array.isArray(input) ? input.join(" ") : String(input == null ? "" : input);
  const out = [];
  for (let t of list.normalize("NFKC").split(/[\s,、，#＃]+/)) {
    t = t.trim().toLowerCase().slice(0, 20);
    if (!t || !TAG_RE.test(t) || out.includes(t)) continue;
    out.push(t);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/* ---------- おすすめの順位づけ ---------- */
const DAY = 86400000;

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

// 0〜1 に順位でならす（値そのものではなく、並びだけを使う）
function rankNormalize(values) {
  const idx = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(values.length).fill(0.5);
  if (idx.length < 2) return out;
  idx.forEach(([, i], r) => { out[i] = r / (idx.length - 1); });
  return out;
}

/**
 * candidates: [{ id, createdAt(ms), tags[], likes, comments, vec(Float32Array|null) }]
 * profile:    { tags: {tag: 重み}, seeds: [{ id, w }], seen: Set<id> }
 * seedVecs:   Map<id, Float32Array>  好みの元になった絵の特徴ベクトル
 * 戻り値: おすすめ順に並べた候補の配列（先頭から limit 件）
 */
function rankFeed(opts) {
  const { candidates, profile, seedVecs, now, limit } = opts;
  const rng = opts.rng || Math.random;
  const explore = opts.explore == null ? 0.2 : opts.explore;
  if (!candidates.length || limit <= 0) return [];

  const tagW = profile.tags || {};
  const seen = profile.seen || new Set();
  const seeds = (profile.seeds || []).filter((s) => s.w > 0 && seedVecs && seedVecs.get(s.id));
  const seedTotal = seeds.reduce((a, s) => a + s.w, 0);

  // 好みの絵に、特徴ベクトルがどれだけ近いか（ベクトルがない絵は評価しない）
  const sims = candidates.map((c) => {
    if (!c.vec || !seedTotal) return null;
    let s = 0;
    for (const seed of seeds) s += seed.w * cosine(c.vec, seedVecs.get(seed.id));
    return s / seedTotal;
  });
  const withSim = [];
  sims.forEach((s, i) => { if (s != null) withSim.push(i); });
  const norm = rankNormalize(withSim.map((i) => sims[i]));
  const simScore = new Array(candidates.length).fill(0);
  withSim.forEach((i, k) => { simScore[i] = (norm[k] - 0.5) * 2; }); // -1〜1

  const maxPop = Math.max(1, ...candidates.map((c) => c.likes + 0.5 * c.comments));
  const scored = candidates.map((c, i) => {
    let tagSum = 0;
    for (const t of c.tags || []) tagSum += tagW[t] || 0;
    const tag = Math.tanh(tagSum / 2);                                // -1〜1
    const recency = Math.pow(0.5, Math.max(0, now - c.createdAt) / (3 * DAY)); // 3日で半分
    const pop = Math.log1p(c.likes + 0.5 * c.comments) / Math.log1p(maxPop);
    const score =
      1.2 * tag +
      1.2 * simScore[i] +
      0.6 * recency +
      0.4 * pop +
      0.35 * rng() -
      (seen.has(c.id) ? 2 : 0);
    return { c, score };
  });
  scored.sort((a, b) => b.score - a.score);

  // 好みから外れたものも混ぜる（似たものばかりにならないように）
  const k = Math.min(Math.round(limit * explore), Math.max(0, scored.length - limit));
  const top = scored.slice(0, limit - k).map((s) => s.c);
  const rest = scored.slice(limit - k).map((s) => s.c);
  const picks = [];
  for (let n = 0; n < k && rest.length; n++) picks.push(rest.splice(Math.floor(rng() * rest.length), 1)[0]);
  // 2番目・6番目あたりに差し込む
  const slots = [2, 6, 9, 11];
  picks.forEach((p, n) => { top.splice(Math.min(slots[n] == null ? top.length : slots[n], top.length), 0, p); });
  return top.slice(0, limit);
}

module.exports = { parseTags, rankFeed, rankNormalize, MAX_TAGS, TAG_RE };
