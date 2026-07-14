/**
 * detector-seg.js — 人物輪廓分割偵測（取代 MoveNet 骨架）
 * 用自訓 yolo11n-seg（onnxruntime-web）輸出人物剪影遮罩。
 * 命中判定改為「十字標中心點落在人物剪影內即命中」（方向 C，無頭/軀幹之分）。
 *
 * detect(video) 回傳: Array<{
 *   id,                       // 輕量追蹤器給的穩定 ID
 *   score,
 *   bbox: {minX,minY,maxX,maxY},   // 影片像素座標
 *   mask: Uint8Array(mh*mw), mh, mw,  // 剪影二值遮罩（proto 解析度）
 *   _tf: {scale,padX,padY,mw,mh}      // 影片→proto 座標轉換
 * }>
 */

// 自動選最佳組合（依實測數據）：
//   WebGPU(新機)＝被開銷卡住，降解析度換不到速度 → 用 256 拿最佳品質
//   WASM(舊機)＝被運算量卡住，降解析度大幅加速 → 用 128 保流暢
const SEG_HIRES = { model: 'models/seg_r8_256.onnx', size: 256 };
const SEG_LORES = { model: 'models/seg_r8_128.onnx', size: 128 };
// CONF 0.35→乾淨偵測不誤判背景；NMS 0.5→合併同人重複框但保留不同人；MASK_TH 低→剪影略大於人（寧可略大不可小於人）
const SEG_CONF = 0.35, SEG_NMS_IOU = 0.5, SEG_MASK_TH = 0.4;

function _sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

async function createSegDetector(onStatus) {
  onStatus('載入 onnxruntime…');
  // onnxruntime-web 由 index.html 以 <script> 載入，全域 ort 可用
  let backend = 'webgpu', sess = null, cfg = SEG_HIRES;
  try {
    sess = await ort.InferenceSession.create(SEG_HIRES.model, { executionProviders: ['webgpu'] });
  } catch (e) {
    backend = 'wasm'; cfg = SEG_LORES;
    onStatus('WebGPU 不可用，改用 WASM 流暢版…');
    ort.env.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 4);
    sess = await ort.InferenceSession.create(SEG_LORES.model, { executionProviders: ['wasm'] });
  }
  const SEG_SIZE = cfg.size;
  onStatus(`輪廓模型就緒（${SEG_SIZE}）`);

  const inName = sess.inputNames[0], outN = sess.outputNames;
  const pre = document.createElement('canvas'); pre.width = pre.height = SEG_SIZE;
  const preCtx = pre.getContext('2d', { willReadFrequently: true });

  // 輕量追蹤器：以 bbox 中心距離配對前後影格，給穩定 ID
  let tracks = [];   // {id, cx, cy, lastSeen}
  let nextId = 1;

  function assignIds(dets, now) {
    const used = new Set();
    for (const d of dets) {
      const cx = (d.bbox.minX + d.bbox.maxX) / 2, cy = (d.bbox.minY + d.bbox.maxY) / 2;
      const diag = Math.hypot(d.bbox.maxX - d.bbox.minX, d.bbox.maxY - d.bbox.minY);
      let best = null, bestD = Infinity;
      for (const t of tracks) {
        if (used.has(t.id)) continue;
        const dist = Math.hypot(cx - t.cx, cy - t.cy);
        if (dist < Math.max(60, diag * 0.6) && dist < bestD) { bestD = dist; best = t; }
      }
      if (best) { d.id = best.id; best.cx = cx; best.cy = cy; best.lastSeen = now; used.add(best.id); }
      else { d.id = nextId++; tracks.push({ id: d.id, cx, cy, lastSeen: now }); used.add(d.id); }
    }
    tracks = tracks.filter(t => now - t.lastSeen < 1500);
  }

  return {
    backend,
    async detect(video) {
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw) return [];
      const _t0 = performance.now();
      // letterbox 到 192
      const scale = Math.min(SEG_SIZE / vw, SEG_SIZE / vh);
      const nw = vw * scale, nh = vh * scale, padX = (SEG_SIZE - nw) / 2, padY = (SEG_SIZE - nh) / 2;
      preCtx.fillStyle = '#000'; preCtx.fillRect(0, 0, SEG_SIZE, SEG_SIZE);
      preCtx.drawImage(video, padX, padY, nw, nh);
      const d = preCtx.getImageData(0, 0, SEG_SIZE, SEG_SIZE).data;
      const t = new Float32Array(3 * SEG_SIZE * SEG_SIZE);
      const area = SEG_SIZE * SEG_SIZE;
      for (let i = 0; i < area; i++) {
        t[i] = d[i * 4] / 255; t[area + i] = d[i * 4 + 1] / 255; t[2 * area + i] = d[i * 4 + 2] / 255;
      }
      const _t1 = performance.now();
      const res = await sess.run({ [inName]: new ort.Tensor('float32', t, [1, 3, SEG_SIZE, SEG_SIZE]) });
      const _t2 = performance.now();
      const o0 = res[outN[0]], o1 = res[outN[1]];
      const [, ch, N] = o0.dims;               // ch=37
      const [, , mh, mw] = o1.dims;            // 32,48,48
      const A = o0.data, P = o1.data;

      // 解析 + 收集通過信心的框
      const dets = [];
      for (let i = 0; i < N; i++) {
        const score = A[4 * N + i];
        if (score < SEG_CONF) continue;
        const cx = A[i], cy = A[N + i], w = A[2 * N + i], h = A[3 * N + i];
        const coeffs = new Float32Array(32);
        for (let k = 0; k < 32; k++) coeffs[k] = A[(5 + k) * N + i];
        dets.push({ score, ix1: cx - w / 2, iy1: cy - h / 2, ix2: cx + w / 2, iy2: cy + h / 2, coeffs });
      }
      // NMS
      dets.sort((a, b) => b.score - a.score);
      const keep = [];
      for (const dd of dets) {
        let ok = true;
        for (const k of keep) {
          const xx1 = Math.max(dd.ix1, k.ix1), yy1 = Math.max(dd.iy1, k.iy1);
          const xx2 = Math.min(dd.ix2, k.ix2), yy2 = Math.min(dd.iy2, k.iy2);
          const inter = Math.max(0, xx2 - xx1) * Math.max(0, yy2 - yy1);
          const u = (dd.ix2 - dd.ix1) * (dd.iy2 - dd.iy1) + (k.ix2 - k.ix1) * (k.iy2 - k.iy1) - inter;
          if (u > 0 && inter / u > SEG_NMS_IOU) { ok = false; break; }
        }
        if (ok) keep.push(dd);
      }

      const inputToVideoX = ix => (ix - padX) / scale;
      const inputToVideoY = iy => (iy - padY) / scale;
      const mxScale = mw / SEG_SIZE, myScale = mh / SEG_SIZE;

      const out = keep.map(dd => {
        // 二值遮罩（proto 解析度），限制在 bbox 內
        const raw = new Uint8Array(mh * mw);
        const bx1 = dd.ix1 * mxScale, bx2 = dd.ix2 * mxScale, by1 = dd.iy1 * myScale, by2 = dd.iy2 * myScale;
        for (let my = 0; my < mh; my++) {
          if (my < by1 - 1 || my > by2 + 1) continue;
          for (let mx = 0; mx < mw; mx++) {
            if (mx < bx1 - 1 || mx > bx2 + 1) continue;
            let v = 0; for (let k = 0; k < 32; k++) v += dd.coeffs[k] * P[(k * mh + my) * mw + mx];
            if (_sigmoid(v) >= SEG_MASK_TH) raw[my * mw + mx] = 1;
          }
        }
        // 膨脹 1 格：剪影略大於人、保證不小於人（寧可略大不可小）
        const mask = new Uint8Array(mh * mw);
        for (let my = 0; my < mh; my++) {
          for (let mx = 0; mx < mw; mx++) {
            if (!raw[my * mw + mx]) continue;
            mask[my * mw + mx] = 1;
            if (mx > 0) mask[my * mw + mx - 1] = 1;
            if (mx < mw - 1) mask[my * mw + mx + 1] = 1;
            if (my > 0) mask[(my - 1) * mw + mx] = 1;
            if (my < mh - 1) mask[(my + 1) * mw + mx] = 1;
          }
        }
        return {
          score: dd.score,
          bbox: {
            minX: Math.max(0, inputToVideoX(dd.ix1)), minY: Math.max(0, inputToVideoY(dd.iy1)),
            maxX: Math.min(vw, inputToVideoX(dd.ix2)), maxY: Math.min(vh, inputToVideoY(dd.iy2)),
          },
          mask, mh, mw,
          _tf: { scale, padX, padY, mxScale, myScale },
        };
      });
      assignIds(out, performance.now());
      const _t3 = performance.now();
      window.__segProf = { pre: +(_t1-_t0).toFixed(1), infer: +(_t2-_t1).toFixed(1), post: +(_t3-_t2).toFixed(1), total: +(_t3-_t0).toFixed(1) };
      return out;
    },
  };
}

/* ── 方法 D：Web Worker 版偵測（推論+解碼在背景執行緒，主線程只顯示畫面）── */
function _makeTracker() {
  let tracks = [], nextId = 1;
  return function assignIds(dets, now) {
    const used = new Set();
    for (const d of dets) {
      const cx = (d.bbox.minX + d.bbox.maxX) / 2, cy = (d.bbox.minY + d.bbox.maxY) / 2;
      const diag = Math.hypot(d.bbox.maxX - d.bbox.minX, d.bbox.maxY - d.bbox.minY);
      let best = null, bestD = Infinity;
      for (const t of tracks) {
        if (used.has(t.id)) continue;
        const dist = Math.hypot(cx - t.cx, cy - t.cy);
        if (dist < Math.max(60, diag * 0.6) && dist < bestD) { bestD = dist; best = t; }
      }
      if (best) { d.id = best.id; best.cx = cx; best.cy = cy; best.lastSeen = now; used.add(best.id); }
      else { d.id = nextId++; tracks.push({ id: d.id, cx, cy, lastSeen: now }); used.add(d.id); }
    }
    tracks = tracks.filter(t => now - t.lastSeen < 1500);
  };
}

function segWorkerSupported() {
  return typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function';
}

async function createSegDetectorWorker(onStatus) {
  onStatus('啟動背景執行緒…');
  const worker = new Worker('js/seg-worker.js?v=29');
  const abs = m => new URL(m, location.href).href;
  const assignIds = _makeTracker();
  // 方法 C：GPU 後處理，?noc 可關閉做 A/B 對照
  const gpuPost = !new URLSearchParams(location.search).has('noc');

  const ready = await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('worker init 逾時')), 30000);
    worker.onmessage = e => {
      if (e.data.type === 'ready') { clearTimeout(to); resolve(e.data); }
      if (e.data.type === 'init-error') { clearTimeout(to); reject(new Error(e.data.error)); }
    };
    worker.onerror = e => { clearTimeout(to); reject(new Error('worker error: ' + e.message)); };
    worker.postMessage({
      type: 'init',
      hires: { model: abs(SEG_HIRES.model), size: SEG_HIRES.size },
      lores: { model: abs(SEG_LORES.model), size: SEG_LORES.size },
      threads: Math.min(4, navigator.hardwareConcurrency || 4),
      gpuPost,
    });
  });
  onStatus(`背景執行緒就緒（${ready.size}${ready.gpuPost ? '·C' : ''}）`);

  let reqId = 0;
  const pending = new Map();
  worker.onmessage = e => {
    if (e.data.type === 'result') {
      if (e.data.prof) window.__segProf = e.data.prof;
      const p = pending.get(e.data.reqId);
      if (p) { pending.delete(e.data.reqId); p(e.data.dets); }
    }
  };

  return {
    backend: ready.backend,
    worker: true,
    async detect(video) {
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw) return [];
      let bitmap;
      try { bitmap = await createImageBitmap(video); } catch { return []; }
      const id = ++reqId;
      const dets = await new Promise(res => {
        pending.set(id, res);
        worker.postMessage({ type: 'frame', bitmap, vw, vh, reqId: id }, [bitmap]);
      });
      assignIds(dets, performance.now());
      return dets;
    },
  };
}

/* ── 命中：影片座標點是否落在剪影內 ── */
function segHitTest(det, px, py) {
  const tf = det._tf;
  const ix = px * tf.scale + tf.padX, iy = py * tf.scale + tf.padY;
  const mx = Math.round(ix * tf.mxScale), my = Math.round(iy * tf.myScale);
  if (mx < 0 || my < 0 || mx >= det.mw || my >= det.mh) return false;
  return det.mask[my * det.mw + mx] === 1;
}

/* ── 外框（頭上血條定位用） ── */
function segBounds(det) {
  const b = det.bbox;
  return { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY };
}

/* ── 顏色取樣：剪影上半身區域（多人識別用） ── */
function segColorSample(video, det) {
  const b = det.bbox;
  const w = b.maxX - b.minX, h = b.maxY - b.minY;
  // 取軀幹帶（上 30%~65%）中央
  const x = b.minX + w * 0.3, y = b.minY + h * 0.35, rw = w * 0.4, rh = h * 0.3;
  if (typeof sampleRegion === 'function') return sampleRegion(video, x, y, rw, rh);
  return null;
}
