"use strict";

// 絵の特徴ベクトルを計算する別プロセス（CLIPの画像側）。
// ・普段は similarity.js の Embedder が必要なときだけ起動する。
// ・`node embed-worker.js --prefetch` で、モデルを先にダウンロードしておく（ビルド時に使う）。

const path = require("path");
const { normalize, toBuffer } = require("./similarity");

const MODEL = process.env.CLIP_MODEL || "Xenova/clip-vit-base-patch32";

let loading = null;
function load() {
  if (!loading) {
    loading = (async () => {
      const tf = await import("@huggingface/transformers");
      // 保存先をプロジェクト内にする。ビルド時にダウンロードしておけば、起動後は再ダウンロード不要
      tf.env.cacheDir = path.join(__dirname, ".model-cache");
      const processor = await tf.AutoProcessor.from_pretrained(MODEL);
      const model = await tf.CLIPVisionModelWithProjection.from_pretrained(MODEL, { dtype: "q8" });
      return { tf, processor, model };
    })();
  }
  return loading;
}

async function embed(base64) {
  const { tf, processor, model } = await load();
  const blob = new Blob([Buffer.from(base64, "base64")]);
  const image = await tf.RawImage.fromBlob(blob);
  const inputs = await processor(image);
  const out = await model(inputs);
  const vec = normalize(Float32Array.from(out.image_embeds.data));
  if (out.image_embeds.dispose) out.image_embeds.dispose();
  return vec;
}

if (process.argv.includes("--prefetch")) {
  load()
    .then(() => { console.log("CLIPモデルを用意しました: " + MODEL); process.exit(0); })
    .catch((e) => {
      // 失敗してもビルドは止めない。使うときに改めてダウンロードされる
      console.error("CLIPモデルの事前ダウンロードに失敗しました（起動後に再試行されます）:", e && e.message);
      process.exit(0);
    });
} else if (process.send) {
  process.on("message", async (msg) => {
    if (!msg || msg.id == null) return;
    try {
      const vec = await embed(msg.image);
      process.send({ id: msg.id, embedding: toBuffer(vec).toString("base64") });
    } catch (e) {
      process.send({ id: msg.id, error: String((e && e.message) || e) });
    }
  });
  process.on("disconnect", () => process.exit(0));
}
