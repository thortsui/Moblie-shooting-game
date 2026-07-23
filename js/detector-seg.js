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

// 解析度策略（正確率 vs 幀率；使用者：正確率優先、但偵測 fps 保底 15）：
//   WebGPU（iPhone 14/A15 以上等級）＝256：正確率高、誤判低。推論在背景執行緒（seg-worker），
//     不佔主線程 → 準星/瞄準框顯示不被偵測（yolo）拖累。若實測偵測 fps 撐不到 15，
//     main.js 的 detectLoop 會呼叫 downgrade() 自動切回 192 保底流暢（見下方 worker 包裝）。
//   主線程退回路徑（瀏覽器不支援 Worker/OffscreenCanvas 時）＝192：避免 256 在主線程卡住準星。
//   WASM（舊機）＝128：被運算量卡住，只能靠降解析度保流暢。
//   ?hq 強制 256、?fast 強制 192（效能對照用）。
const _qs = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
// dynamic ONNX：單一模型檔吃任意 /32 尺寸。letterbox 改「長邊=size、短邊貼相機比例向上取 /32」，
// 灰邊從直拍 44% 降到 <6%（實測準度微升 0.9157→0.9194、速度 1.19×+，見工作日誌 2026-07-20）。
// size 意義不變（=長邊），升降階梯照舊，但換檔不再需要重載模型（同一檔案，只改輸入尺寸）。
// ── 模型世代選單（index.html #genSelect；localStorage 記憶；預設 r9=綜合最強）──
// 標籤依 2026-07-20 全模型大會考（192/256/320 × valgt/parts 雙基準）
const SEG_GENS = [
  { id: 'auto',   label: '自動 — 畫質優先・效能夠再上 r9s（預設）' },
  { id: 'r9',     label: 'r9 — nano 綜合最強' },
  { id: 'r9s',    label: 'r9s — 三卷大滿貫（s・慢3×）' },
  { id: 'r9_1024',label: 'r9_1024 — 1024特化（乾淨史高0.74@1024）' },
  { id: 'r16n',   label: 'r16n — r9s蒸餾版（≈r9）' },
  { id: 'r12s',   label: 'r12s — 舊s王（已被r9s取代）' },
  { id: 'r9_640', label: 'r9_640 — 高解析特化（320↑）' },
  { id: 'r11',    label: 'r11 — 前代 320/384 部署版' },
  { id: 'r13n',   label: 'r13n — 蒸餾實驗版' },
  { id: 'r12n',   label: 'r12n — 劣化增強版' },
  { id: 'r14n',   label: 'r14n — 全手段疊加版' },
  { id: 'r10',    label: 'r10 — r9 微調版' },
  { id: 'r8',     label: 'r8 — 第 8 代' },
  { id: 'r7',     label: 'r7 — 第 7 代' },
  { id: 'r6',     label: 'r6 — 第 6 代' },
  { id: 'r5',     label: 'r5 — 第 5 代' },
  { id: 'r4',     label: 'r4 — 第 4 代' },
  { id: 'r3',     label: 'r3 — 第 3 代' },
  { id: 'r2',     label: 'r2 — 第 2 代' },
  { id: 'r1',     label: 'r1 — 初代' },
];
function segGenId() {
  try { const g = localStorage.getItem('segGen'); if (g && SEG_GENS.some(x => x.id === g)) return g; } catch {}
  return 'auto';
}
function segGenModel(id) {
  const g = id || segGenId();
  return `models/seg_${g === 'auto' ? 'r9' : g}_dyn.onnx`;   // auto 模式基底=r9(nano 綜合最強)
}
// 階梯 cfg 的 model 用 getter：切換世代後，升降檔自動跟著用新世代（不會切回預設）
function _genCfg(size) { return { get model() { return segGenModel(); }, size }; }
const SEG_384 = _genCfg(384);
const SEG_320 = _genCfg(320);
const SEG_256 = _genCfg(256);
const SEG_192 = _genCfg(192);
const SEG_LORES = _genCfg(128);
// 自動階梯(gen=auto,預設):畫質優先往上爬,各檔位配三卷會考該檔位最強的 nano
// (≤256 r9;320/384 r9_640 貼臉卷勝出);效能真的過剩(strong 門檻:偵測≥25/畫面≥50/連續5秒)
// 才進 r9s 檔——s 系列 3.5× 算力,唯玩家機器扛得住才上。成本序:0.4x→1→1.8→2.8→4→6.6→10.3(GFLOPs 相對值)
const SEG_AUTO_LADDER = [
  { model: 'models/seg_r9_dyn.onnx',     size: 128 },
  { model: 'models/seg_r9_dyn.onnx',     size: 192 },
  { model: 'models/seg_r9_dyn.onnx',     size: 256 },
  { model: 'models/seg_r9_640_dyn.onnx', size: 320 },
  { model: 'models/seg_r9_640_dyn.onnx', size: 384 },
  { model: 'models/seg_r9s_dyn.onnx',    size: 256, strong: true },
  { model: 'models/seg_r9s_dyn.onnx',    size: 320, strong: true },
];
/** 目前生效的升降階梯:auto=混合配對表;指定世代=該代 128~384 */
function segLadder() { return segGenId() === 'auto' ? SEG_AUTO_LADDER : SEG_LADDER; }
// 升降階梯（自適應解析度）。實測官方 GT mAP50：192=0.503、256=0.576、320=0.616、384=0.645
// → 推論解析度越高正確率越高（小目標/多人收益最大），跑得動的手機自動往上爬。
const SEG_LADDER = [SEG_LORES, SEG_192, SEG_256, SEG_320, SEG_384];
// 預設 192（不分 worker/主線程）：iPhone WebGPU 上 256 推論太重 → 偵測更新率跟不上、剪影無法貼合移動的人。
// 192 推論快、偵測 fps 高、剪影貼合，且 r9 官方評估本就在 192、正確率與 256 幾乎相同。?hq 才 256。
const SEG_WORKER_HIRES = _qs.has('hq') ? SEG_256 : SEG_192;
const SEG_MAIN_HIRES = _qs.has('hq') ? SEG_256 : SEG_192;
// 256 撐不到 15fps 時的保底降級目標
const SEG_FALLBACK = SEG_192;
// 舊變數名相容（若他處引用）
const SEG_HIRES = SEG_WORKER_HIRES;
// 信心門檻「準星中央加權」：中央（瞄準區）0.60、邊緣 0.70（正確率優先，門檻拉到極高、只認非常確定的目標；歷程 0.18/0.30→0.25/0.35→0.30/0.40→0.45/0.55→0.60/0.70）；
// NMS 0.6→重疊的多位玩家不互吃；MASK_TH 0.5→剪影貼身剛剛好（v35 前刻意放大，使用者要求改貼身）
const SEG_CONF_CENTER = 0.60, SEG_CONF_EDGE = 0.70, SEG_NMS_IOU = 0.6, SEG_MASK_TH = 0.5;
/** 依候選框中心離畫面中心的距離回傳門檻（letterbox 座標，W/H=輸入寬高；正方形時與舊版一致） */
function segConfTh(cx, cy, W, H) {
  const d = Math.hypot(cx - W / 2, cy - H / 2) / (Math.min(W, H) / 2);   // 0=正中 1=短邊緣
  const t = Math.min(1, Math.max(0, (d - 0.3) / 0.7));      // 中央 30% 全放寬
  return SEG_CONF_CENTER + (SEG_CONF_EDGE - SEG_CONF_CENTER) * t;
}

function _sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

async function createSegDetector(onStatus) {
  onStatus('載入 onnxruntime…');
  // onnxruntime-web 由 index.html 以 <script> 載入，全域 ort 可用
  let backend = 'webgpu', sess = null, cfg = SEG_MAIN_HIRES;   // 主線程路徑用 192，避免 256 卡住準星
  try {
    sess = await ort.InferenceSession.create(SEG_MAIN_HIRES.model, { executionProviders: ['webgpu'] });
  } catch (e) {
    backend = 'wasm'; cfg = SEG_LORES;
    onStatus('WebGPU 不可用，改用 WASM 流暢版…');
    ort.env.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 4);
    sess = await ort.InferenceSession.create(SEG_LORES.model, { executionProviders: ['wasm'] });
  }
  const SEG_SIZE = cfg.size;
  onStatus(`輪廓模型就緒（${SEG_SIZE}）`);

  const inName = sess.inputNames[0], outN = sess.outputNames;
  const pre = document.createElement('canvas'); pre.width = pre.height = SEG_SIZE;   // 實際尺寸每幀依相機比例調整
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
      // 無灰邊 letterbox：長邊縮到 SEG_SIZE，短邊貼相機比例、向上取 /32（殘餘灰邊 ≤31px）
      const scale = SEG_SIZE / Math.max(vw, vh);
      const nw = vw * scale, nh = vh * scale;
      const W = Math.ceil(nw / 32) * 32, H = Math.ceil(nh / 32) * 32;
      const padX = (W - nw) / 2, padY = (H - nh) / 2;
      if (pre.width !== W || pre.height !== H) { pre.width = W; pre.height = H; }
      preCtx.fillStyle = '#000'; preCtx.fillRect(0, 0, W, H);
      preCtx.drawImage(video, padX, padY, nw, nh);
      const d = preCtx.getImageData(0, 0, W, H).data;
      const area = W * H;
      const t = new Float32Array(3 * area);
      for (let i = 0; i < area; i++) {
        t[i] = d[i * 4] / 255; t[area + i] = d[i * 4 + 1] / 255; t[2 * area + i] = d[i * 4 + 2] / 255;
      }
      const _t1 = performance.now();
      const res = await sess.run({ [inName]: new ort.Tensor('float32', t, [1, 3, H, W]) });
      const _t2 = performance.now();
      const o0 = res[outN[0]], o1 = res[outN[1]];
      const [, ch, N] = o0.dims;               // ch=37
      const [, , mh, mw] = o1.dims;            // 32,48,48
      const A = o0.data, P = o1.data;

      // 解析 + 收集通過信心的框
      const dets = [];
      for (let i = 0; i < N; i++) {
        const score = A[4 * N + i];
        if (score < SEG_CONF_CENTER) continue;
        const cx = A[i], cy = A[N + i], w = A[2 * N + i], h = A[3 * N + i];
        if (score < segConfTh(cx, cy, W, H)) continue;
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
      const mxScale = mw / W, myScale = mh / H;

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
        // 不再膨脹：剪影貼身剛剛好（使用者要求）
        const mask = raw;
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
  const worker = new Worker('js/seg-worker.js?v=46');
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
      hires: { model: abs(SEG_WORKER_HIRES.model), size: SEG_WORKER_HIRES.size },
      lores: { model: abs(SEG_LORES.model), size: SEG_LORES.size },
      threads: Math.min(4, navigator.hardwareConcurrency || 4),
      gpuPost,
    });
  });
  onStatus(`背景執行緒就緒（${ready.size}${ready.gpuPost ? '·C' : ''}）`);

  let curSize = ready.size;
  let reqId = 0;
  const pending = new Map();
  let switchResolve = null;
  worker.onmessage = e => {
    if (e.data.type === 'result') {
      if (e.data.prof) window.__segProf = e.data.prof;
      const p = pending.get(e.data.reqId);
      if (p) { pending.delete(e.data.reqId); p(e.data.dets); }
    } else if (e.data.type === 'model-ready') {
      if (!e.data.error) curSize = e.data.size;
      const r = switchResolve; switchResolve = null;
      r?.(e.data);
    }
  };

  return {
    backend: ready.backend,
    worker: true,
    get size() { return curSize; },
    /** 執行中切換偵測解析度（保底降級用）。cfg 省略時切到 SEG_FALLBACK(192)。回傳 Promise。 */
    setResolution(cfg) {
      const c = cfg || SEG_FALLBACK;
      if (c.size === curSize) return Promise.resolve({ size: curSize });
      return new Promise(res => {
        switchResolve = res;
        worker.postMessage({ type: 'setModel', model: abs(c.model), size: c.size });
      });
    },
    async detect(video) {
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw) return [];
      let bitmap;
      try {
        // 只送略大於模型輸入的縮圖（worker 仍 letterbox 到 SEG_SIZE），省主線程 createImageBitmap 與傳輸；
        // 座標仍以原 vw/vh 映射（worker drawImage 會把縮圖放大到 letterbox 尺寸，不影響命中座標）
        const s = Math.min(1, 384 / Math.max(vw, vh));
        bitmap = s < 1
          ? await createImageBitmap(video, { resizeWidth: Math.round(vw * s), resizeHeight: Math.round(vh * s), resizeQuality: 'low' })
          : await createImageBitmap(video);
      } catch { return []; }
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
