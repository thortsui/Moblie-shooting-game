/**
 * seg-worker.js — 方法 D：偵測搬到背景執行緒
 * 在 Web Worker 裡跑 onnxruntime 推論 + 遮罩解碼，主線程只負責顯示畫面。
 * 主線程用 createImageBitmap(video) 把影格 transfer 進來，回傳 detections。
 */
importScripts('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.webgpu.min.js');

const SEG_CONF = 0.35, SEG_NMS_IOU = 0.5, SEG_MASK_TH = 0.4;
function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

let sess = null, backend = 'webgpu', SEG_SIZE = 256, inName = '';
let cvs = null, cctx = null;

onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    try {
      sess = await ort.InferenceSession.create(msg.hires.model, { executionProviders: ['webgpu'] });
      backend = 'webgpu'; SEG_SIZE = msg.hires.size;
    } catch (err) {
      backend = 'wasm'; SEG_SIZE = msg.lores.size;
      ort.env.wasm.numThreads = msg.threads || 4;
      sess = await ort.InferenceSession.create(msg.lores.model, { executionProviders: ['wasm'] });
    }
    inName = sess.inputNames[0];
    cvs = new OffscreenCanvas(SEG_SIZE, SEG_SIZE);
    cctx = cvs.getContext('2d', { willReadFrequently: true });
    postMessage({ type: 'ready', backend, size: SEG_SIZE });
    return;
  }
  if (msg.type === 'frame') {
    try {
      const { dets, transfers, prof } = await runDetect(msg.bitmap, msg.vw, msg.vh);
      msg.bitmap.close();
      postMessage({ type: 'result', reqId: msg.reqId, dets, prof }, transfers);
    } catch (err) {
      msg.bitmap.close?.();
      postMessage({ type: 'result', reqId: msg.reqId, dets: [], error: String(err) });
    }
  }
};

async function runDetect(bitmap, vw, vh) {
  const t0 = performance.now();
  const scale = Math.min(SEG_SIZE / vw, SEG_SIZE / vh);
  const nw = vw * scale, nh = vh * scale, padX = (SEG_SIZE - nw) / 2, padY = (SEG_SIZE - nh) / 2;
  cctx.fillStyle = '#000'; cctx.fillRect(0, 0, SEG_SIZE, SEG_SIZE);
  cctx.drawImage(bitmap, padX, padY, nw, nh);
  const d = cctx.getImageData(0, 0, SEG_SIZE, SEG_SIZE).data;
  const area = SEG_SIZE * SEG_SIZE;
  const t = new Float32Array(3 * area);
  for (let i = 0; i < area; i++) { t[i] = d[i*4]/255; t[area+i] = d[i*4+1]/255; t[2*area+i] = d[i*4+2]/255; }
  const t1 = performance.now();

  const res = await sess.run({ [inName]: new ort.Tensor('float32', t, [1, 3, SEG_SIZE, SEG_SIZE]) });
  const t2 = performance.now();
  const on = sess.outputNames;
  const o0 = res[on[0]], o1 = res[on[1]];
  const [, ch, N] = o0.dims; const [, , mh, mw] = o1.dims;
  const A = o0.data, P = o1.data;

  const cand = [];
  for (let i = 0; i < N; i++) {
    const score = A[4 * N + i];
    if (score < SEG_CONF) continue;
    const cx = A[i], cy = A[N+i], w = A[2*N+i], h = A[3*N+i];
    const coeffs = new Float32Array(32);
    for (let k = 0; k < 32; k++) coeffs[k] = A[(5+k)*N + i];
    cand.push({ score, ix1: cx-w/2, iy1: cy-h/2, ix2: cx+w/2, iy2: cy+h/2, coeffs });
  }
  cand.sort((a, b) => b.score - a.score);
  const keep = [];
  for (const dd of cand) {
    let ok = true;
    for (const k of keep) {
      const xx1=Math.max(dd.ix1,k.ix1), yy1=Math.max(dd.iy1,k.iy1), xx2=Math.min(dd.ix2,k.ix2), yy2=Math.min(dd.iy2,k.iy2);
      const inter=Math.max(0,xx2-xx1)*Math.max(0,yy2-yy1);
      const u=(dd.ix2-dd.ix1)*(dd.iy2-dd.iy1)+(k.ix2-k.ix1)*(k.iy2-k.iy1)-inter;
      if (u>0 && inter/u > SEG_NMS_IOU) { ok=false; break; }
    }
    if (ok) keep.push(dd);
  }

  const i2vX = ix => (ix - padX) / scale, i2vY = iy => (iy - padY) / scale;
  const mxScale = mw / SEG_SIZE, myScale = mh / SEG_SIZE;
  const dets = [], transfers = [];
  for (const dd of keep) {
    const raw = new Uint8Array(mh * mw);
    const bx1=dd.ix1*mxScale, bx2=dd.ix2*mxScale, by1=dd.iy1*myScale, by2=dd.iy2*myScale;
    for (let my=0; my<mh; my++) {
      if (my<by1-1||my>by2+1) continue;
      for (let mx=0; mx<mw; mx++) {
        if (mx<bx1-1||mx>bx2+1) continue;
        let v=0; for (let k=0;k<32;k++) v+=dd.coeffs[k]*P[(k*mh+my)*mw+mx];
        if (sigmoid(v)>=SEG_MASK_TH) raw[my*mw+mx]=1;
      }
    }
    const mask = new Uint8Array(mh * mw);
    for (let my=0; my<mh; my++) for (let mx=0; mx<mw; mx++) {
      if (!raw[my*mw+mx]) continue;
      mask[my*mw+mx]=1;
      if (mx>0) mask[my*mw+mx-1]=1; if (mx<mw-1) mask[my*mw+mx+1]=1;
      if (my>0) mask[(my-1)*mw+mx]=1; if (my<mh-1) mask[(my+1)*mw+mx]=1;
    }
    dets.push({
      score: dd.score,
      bbox: { minX: Math.max(0,i2vX(dd.ix1)), minY: Math.max(0,i2vY(dd.iy1)), maxX: Math.min(vw,i2vX(dd.ix2)), maxY: Math.min(vh,i2vY(dd.iy2)) },
      mask, mh, mw,
      _tf: { scale, padX, padY, mxScale, myScale },
    });
    transfers.push(mask.buffer);
  }
  const t3 = performance.now();
  const prof = { pre: +(t1-t0).toFixed(1), infer: +(t2-t1).toFixed(1), post: +(t3-t2).toFixed(1), total: +(t3-t0).toFixed(1) };
  return { dets, transfers, prof };
}
