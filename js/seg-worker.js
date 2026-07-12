/**
 * seg-worker.js — 方法 D：偵測搬到背景執行緒
 * 在 Web Worker 裡跑 onnxruntime 推論 + 遮罩解碼，主線程只負責顯示畫面。
 * 主線程用 createImageBitmap(video) 把影格 transfer 進來，回傳 detections。
 *
 * 方法 C（GPU 後處理）：webgpu 後端時，模型輸出留在 GPU（gpu-buffer），
 * CPU 只下載小的 box 張量（output0）做解碼+NMS；遮罩合成
 * sigmoid(coeffs·protos) 改用 WebGPU compute shader 在 GPU 上算，
 * 每個偵測只回讀 mh*mw 的小遮罩 → 省掉 512KB 原型遮罩的 readback。
 * 任一步失敗自動退回 CPU 路徑（getData 下載 protos 後照舊算）。
 */
importScripts('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.webgpu.min.js');
// worker 內 import() 的 base URL 是 worker 腳本位置，ORT 的 .jsep.mjs 會被解析到
// 本站 /js/ 下而 404 → 明確指回 CDN
ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';

const SEG_CONF = 0.35, SEG_NMS_IOU = 0.5, SEG_MASK_TH = 0.4;
// sigmoid(v) >= TH ⇔ v >= logit(TH)，shader 直接比 v 省一次 exp
const SEG_MASK_LOGIT = Math.log(SEG_MASK_TH / (1 - SEG_MASK_TH));
const MAXD = 8; // GPU 遮罩批次上限（單畫面人數不會超過）
function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

let sess = null, backend = 'webgpu', SEG_SIZE = 256, inName = '';
let cvs = null, cctx = null;
let gpuPost = false;      // C 是否啟用（session 以 gpu-buffer 輸出建立成功）
let gpu = null;           // { device, pipeline, params, coeffs, boxes, out, staging, capacity }

onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    try {
    try {
      const wantC = msg.gpuPost !== false;
      try {
        sess = await ort.InferenceSession.create(msg.hires.model, {
          executionProviders: ['webgpu'],
          ...(wantC ? { preferredOutputLocation: 'gpu-buffer' } : {}),
        });
        gpuPost = wantC;
      } catch (err) {
        // gpu-buffer 選項失敗就退回一般 webgpu session
        sess = await ort.InferenceSession.create(msg.hires.model, { executionProviders: ['webgpu'] });
        gpuPost = false;
      }
      backend = 'webgpu'; SEG_SIZE = msg.hires.size;
      if (gpuPost) {
        try { initGpuPost(); } catch (err) { gpuPost = false; }
      }
    } catch (err) {
      backend = 'wasm'; SEG_SIZE = msg.lores.size; gpuPost = false;
      ort.env.wasm.numThreads = msg.threads || 4;
      sess = await ort.InferenceSession.create(msg.lores.model, { executionProviders: ['wasm'] });
    }
    inName = sess.inputNames[0];
    cvs = new OffscreenCanvas(SEG_SIZE, SEG_SIZE);
    cctx = cvs.getContext('2d', { willReadFrequently: true });
    postMessage({ type: 'ready', backend, size: SEG_SIZE, gpuPost });
    } catch (err) {
      // 兩種後端都失敗：明確回報，讓主線程退回主線程偵測器（不再無聲卡死）
      postMessage({ type: 'init-error', error: String(err) });
    }
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

/* ── 方法 C：WebGPU 遮罩合成 pipeline（init 一次） ── */
const MASK_WGSL = `
struct Params { n: u32, mh: u32, mw: u32, th: f32 };
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> protos: array<f32>;   // 32*mh*mw
@group(0) @binding(2) var<storage, read> coeffs: array<f32>;   // n*32
@group(0) @binding(3) var<storage, read> boxes: array<f32>;    // n*4 (mask 座標 x1,y1,x2,y2)
@group(0) @binding(4) var<storage, read_write> outMask: array<u32>; // n*mh*mw
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let mx = gid.x; let my = gid.y; let di = gid.z;
  if (mx >= params.mw || my >= params.mh || di >= params.n) { return; }
  let oIdx = (di * params.mh + my) * params.mw + mx;
  let b = di * 4u;
  let fx = f32(mx); let fy = f32(my);
  if (fx < boxes[b] - 1.0 || fx > boxes[b + 2u] + 1.0 ||
      fy < boxes[b + 1u] - 1.0 || fy > boxes[b + 3u] + 1.0) { outMask[oIdx] = 0u; return; }
  let area = params.mh * params.mw;
  var v = 0.0;
  for (var k = 0u; k < 32u; k = k + 1u) {
    v = v + coeffs[di * 32u + k] * protos[k * area + my * params.mw + mx];
  }
  outMask[oIdx] = select(0u, 1u, v >= params.th);
}`;

function initGpuPost() {
  const device = ort.env.webgpu.device;
  if (!device) throw new Error('no webgpu device');
  const module = device.createShaderModule({ code: MASK_WGSL });
  const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  gpu = { device, pipeline, params: null, coeffs: null, boxes: null, out: null, staging: null, capacity: 0 };
}

function ensureGpuBuffers(mh, mw) {
  const need = MAXD * mh * mw * 4;
  if (gpu.capacity >= need) return;
  const d = gpu.device;
  gpu.params?.destroy(); gpu.coeffs?.destroy(); gpu.boxes?.destroy(); gpu.out?.destroy(); gpu.staging?.destroy();
  gpu.params = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  gpu.coeffs = d.createBuffer({ size: MAXD * 32 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  gpu.boxes = d.createBuffer({ size: MAXD * 4 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  gpu.out = d.createBuffer({ size: need, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  gpu.staging = d.createBuffer({ size: need, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  gpu.capacity = need;
}

/** GPU 上算所有 keep 的遮罩，回傳 Uint32Array（keep.length*mh*mw，0/1） */
async function gpuMasks(protoBuffer, keep, mh, mw) {
  const n = Math.min(keep.length, MAXD);
  ensureGpuBuffers(mh, mw);
  const d = gpu.device;
  d.queue.writeBuffer(gpu.params, 0, new Uint32Array([n, mh, mw]));
  d.queue.writeBuffer(gpu.params, 12, new Float32Array([SEG_MASK_LOGIT]));
  const cf = new Float32Array(n * 32), bx = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    cf.set(keep[i].coeffs, i * 32);
    bx[i * 4] = keep[i].bx1; bx[i * 4 + 1] = keep[i].by1; bx[i * 4 + 2] = keep[i].bx2; bx[i * 4 + 3] = keep[i].by2;
  }
  d.queue.writeBuffer(gpu.coeffs, 0, cf);
  d.queue.writeBuffer(gpu.boxes, 0, bx);
  const bind = d.createBindGroup({
    layout: gpu.pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: gpu.params } },
      { binding: 1, resource: { buffer: protoBuffer } },
      { binding: 2, resource: { buffer: gpu.coeffs } },
      { binding: 3, resource: { buffer: gpu.boxes } },
      { binding: 4, resource: { buffer: gpu.out } },
    ],
  });
  const bytes = n * mh * mw * 4;
  const enc = d.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(gpu.pipeline);
  pass.setBindGroup(0, bind);
  pass.dispatchWorkgroups(Math.ceil(mw / 8), Math.ceil(mh / 8), n);
  pass.end();
  enc.copyBufferToBuffer(gpu.out, 0, gpu.staging, 0, bytes);
  d.queue.submit([enc.finish()]);
  await gpu.staging.mapAsync(GPUMapMode.READ, 0, bytes);
  const result = new Uint32Array(gpu.staging.getMappedRange(0, bytes).slice(0));
  gpu.staging.unmap();
  return result;
}

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

  // C：gpu-buffer 時只下載 output0（~200KB），protos 留在 GPU
  const useGpu = gpuPost && o1.location === 'gpu-buffer';
  const A = useGpu ? await o0.getData() : o0.data;
  const tDl = performance.now();

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
  for (const dd of keep) {
    dd.bx1 = dd.ix1*mxScale; dd.bx2 = dd.ix2*mxScale; dd.by1 = dd.iy1*myScale; dd.by2 = dd.iy2*myScale;
  }
  const dets = [], transfers = [];
  let mode = useGpu ? 'gpuC' : 'cpu';
  let gpuRaw = null;
  if (useGpu && keep.length) {
    try {
      gpuRaw = await gpuMasks(o1.gpuBuffer, keep, mh, mw);
    } catch (err) {
      mode = 'cpu(退回:' + String(err).slice(0, 40) + ')';
      gpuRaw = null;
    }
  }
  const tShader = performance.now();

  // GPU 失敗或本來就 CPU 路徑：需要 protos 在 CPU
  let P = null;
  if (!gpuRaw && keep.length) P = useGpu ? await o1.getData() : o1.data;

  for (let di = 0; di < keep.length; di++) {
    const dd = keep[di];
    const raw = new Uint8Array(mh * mw);
    if (gpuRaw && di < MAXD) {
      const base = di * mh * mw;
      for (let i = 0; i < mh * mw; i++) raw[i] = gpuRaw[base + i] & 1;
    } else if (P) {
      for (let my=0; my<mh; my++) {
        if (my<dd.by1-1||my>dd.by2+1) continue;
        for (let mx=0; mx<mw; mx++) {
          if (mx<dd.bx1-1||mx>dd.bx2+1) continue;
          let v=0; for (let k=0;k<32;k++) v+=dd.coeffs[k]*P[(k*mh+my)*mw+mx];
          if (sigmoid(v)>=SEG_MASK_TH) raw[my*mw+mx]=1;
        }
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
  // gpu-buffer 輸出的 GPU 記憶體要手動釋放（compute/copy 已 submit 且 readback 完成，安全）
  if (useGpu) { o0.dispose?.(); o1.dispose?.(); }
  const t3 = performance.now();
  const prof = {
    pre: +(t1-t0).toFixed(1), infer: +(t2-t1).toFixed(1), post: +(t3-t2).toFixed(1), total: +(t3-t0).toFixed(1),
    mode, dl: +(tDl-t2).toFixed(1), shader: +(tShader-tDl).toFixed(1),
  };
  return { dets, transfers, prof };
}
