/**
 * reid.js — 認人（玩家重識別）
 * 小型嵌入模型（reid_v1.onnx，MobileNetV3-small → L2 正規化 128 維向量）。
 * 大廳登錄：取樣自己軀幹 → 向量廣播給全房；戰鬥中：對偵測到的人裁切 → 向量
 * → 與已登錄玩家做 cosine 比對。比顏色識別更能分辨相近衣色、不怕光線變化；
 * 模型載入失敗時整體自動退回顏色識別（reid = null）。
 */

async function createReidEmbedder() {
  const MODEL = 'models/reid_v2.onnx?v=40';
  let sess = null, backend = 'webgpu';
  try {
    sess = await ort.InferenceSession.create(MODEL, { executionProviders: ['webgpu'] });
  } catch {
    backend = 'wasm';
    sess = await ort.InferenceSession.create(MODEL, { executionProviders: ['wasm'] });
  }
  const W = 128, H = 256, AREA = W * H;
  const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  const inName = sess.inputNames[0], outName = sess.outputNames[0];

  /** 對影片指定區域算 128 維嵌入（回傳 Float32Array，已 L2 正規化） */
  async function embedRegion(video, x, y, w, h) {
    if (!video.videoWidth || w < 8 || h < 8) return null;
    cx.drawImage(video, x, y, w, h, 0, 0, W, H);
    const d = cx.getImageData(0, 0, W, H).data;
    const t = new Float32Array(3 * AREA);
    for (let i = 0; i < AREA; i++) {
      t[i]            = (d[i * 4]     / 255 - MEAN[0]) / STD[0];
      t[AREA + i]     = (d[i * 4 + 1] / 255 - MEAN[1]) / STD[1];
      t[2 * AREA + i] = (d[i * 4 + 2] / 255 - MEAN[2]) / STD[2];
    }
    const out = await sess.run({ [inName]: new ort.Tensor('float32', t, [1, 3, H, W]) });
    return out[outName].data;
  }
  return { embedRegion, backend };
}

/** 兩個 128 維嵌入的 cosine 相似度（皆已正規化 → 內積即是） */
function embCosine(a, b) {
  let s = 0;
  for (let i = 0; i < 128; i++) s += a[i] * b[i];
  return s;
}
