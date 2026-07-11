/**
 * detector.js — 視覺偵測抽象層
 *
 * 對外只暴露一個介面，之後要把 MoveNet 換成 YOLOv8-pose(ONNX) 時，
 * 只要重寫 createPoseDetector() 回傳同樣形狀的物件即可，遊戲邏輯不用動。
 *
 * detect(video) 回傳: Array<{
 *   id: number,              // 跨影格追蹤 ID
 *   score: number,
 *   keypoints: {  [name]: {x, y, score} }   // COCO 17 點，座標為「影片像素座標」
 * }>
 */

const KEYPOINT_NAMES = [
  'nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear',
  'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow',
  'left_wrist', 'right_wrist', 'left_hip', 'right_hip',
  'left_knee', 'right_knee', 'left_ankle', 'right_ankle',
];

const MIN_POSE_SCORE = 0.25;
const MIN_KP_SCORE = 0.3;

const DET_MAX_DIM = 256;     // 推論輸入長邊（與模型內部解析度一致，餵更大只是浪費）
const SMOOTH_ALPHA = 0.55;   // 關鍵點指數平滑係數（越小越穩但越拖）

async function createPoseDetector(onStatus, forceBackend) {
  // WebGPU（iOS 18+ / 新 Android 快很多）→ 失敗退回 WebGL；可強制指定
  let backend = forceBackend || 'webgpu';
  if (backend === 'webgpu') {
    try {
      onStatus('載入 WebGPU 加速…');
      await tf.setBackend('webgpu');
      await tf.ready();
    } catch {
      backend = 'webgl';
    }
  }
  if (backend === 'webgl') {
    onStatus('載入 WebGL 後端…');
    await tf.setBackend('webgl');
    await tf.ready();
  }

  onStatus('載入 MoveNet MultiPose 模型…');
  const detector = await poseDetection.createDetector(
    poseDetection.SupportedModels.MoveNet,
    {
      modelType: poseDetection.movenet.modelType.MULTIPOSE_LIGHTNING,
      enableTracking: true,
      trackerType: poseDetection.TrackerType.BoundingBox,
    }
  );
  onStatus('模型就緒');

  // 推論用縮小畫布：影片先縮到長邊 256 再餵模型，大幅減少 GPU 上傳成本
  const detCanvas = document.createElement('canvas');
  const detCtx = detCanvas.getContext('2d', { willReadFrequently: true });

  // 每個追蹤 ID 的平滑狀態
  const smooth = new Map();   // id -> { kp: {name:{x,y}}, lastSeen }

  return {
    backend,
    async detect(video) {
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw) return [];
      const scale = DET_MAX_DIM / Math.max(vw, vh);
      const dw = Math.round(vw * scale), dh = Math.round(vh * scale);
      if (detCanvas.width !== dw) { detCanvas.width = dw; detCanvas.height = dh; }
      detCtx.drawImage(video, 0, 0, dw, dh);

      const poses = await detector.estimatePoses(detCanvas, { flipHorizontal: false });
      const now = performance.now();
      const out = poses
        .filter(p => (p.score ?? 1) >= MIN_POSE_SCORE)
        .map(p => {
          const id = p.id ?? 0;
          let st = smooth.get(id);
          if (!st) { st = { kp: {} }; smooth.set(id, st); }
          st.lastSeen = now;
          const kp = {};
          p.keypoints.forEach((k, i) => {
            const name = k.name || KEYPOINT_NAMES[i];
            // 縮小畫布座標 → 影片座標
            const x = k.x / scale, y = k.y / scale;
            // 指數平滑抑制抖動
            const prev = st.kp[name];
            const sx = prev ? prev.x + SMOOTH_ALPHA * (x - prev.x) : x;
            const sy = prev ? prev.y + SMOOTH_ALPHA * (y - prev.y) : y;
            st.kp[name] = { x: sx, y: sy };
            kp[name] = { x: sx, y: sy, score: k.score ?? 0 };
          });
          return { id, score: p.score ?? 1, keypoints: kp };
        });

      // 清掉消失太久的平滑狀態
      for (const [id, st] of smooth) {
        if (now - st.lastSeen > 4000) smooth.delete(id);
      }
      return out;
    },
  };
}

/* ── 命中區域幾何 ──
   由關鍵點推導「頭部圓區」與「軀幹四邊形」，座標同為影片像素座標 */

function getKp(pose, name) {
  const k = pose.keypoints[name];
  return k && k.score >= MIN_KP_SCORE ? k : null;
}

/** 頭部圓區：以可見的鼻/眼/耳關鍵點平均為圓心。
    半徑優先用雙耳距離，退而用肩寬估計。回傳 null 表示頭部不可見。 */
function headCircle(pose) {
  const pts = ['nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear']
    .map(n => getKp(pose, n)).filter(Boolean);
  if (pts.length === 0) return null;

  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;

  const le = getKp(pose, 'left_ear'), re = getKp(pose, 'right_ear');
  const ls = getKp(pose, 'left_shoulder'), rs = getKp(pose, 'right_shoulder');
  let r = null;
  if (le && re) r = Math.hypot(le.x - re.x, le.y - re.y) * 1.25;
  else if (ls && rs) r = Math.hypot(ls.x - rs.x, ls.y - rs.y) * 0.45;
  if (!r || r < 10) r = 28;
  return { cx, cy, r };
}

/** 軀幹判定區的放大係數（關鍵點只在骨架上，實際身體比骨架寬一圈） */
const TORSO_EXPAND_X = 1.45;   // 左右：涵蓋手臂內側與身體輪廓
const TORSO_EXPAND_Y = 1.30;   // 上下：涵蓋肩頸與骨盆

/** 軀幹四邊形：左肩→右肩→右髖→左髖，並以中心點放大。回傳 null 表示軀幹不完整。 */
function torsoQuad(pose) {
  const ls = getKp(pose, 'left_shoulder'), rs = getKp(pose, 'right_shoulder');
  const lh = getKp(pose, 'left_hip'), rh = getKp(pose, 'right_hip');
  if (!ls || !rs || !lh || !rh) return null;
  const pts = [ls, rs, rh, lh];
  const cx = pts.reduce((s, p) => s + p.x, 0) / 4;
  const cy = pts.reduce((s, p) => s + p.y, 0) / 4;
  return pts.map(p => ({
    x: cx + (p.x - cx) * TORSO_EXPAND_X,
    y: cy + (p.y - cy) * TORSO_EXPAND_Y,
  }));
}

/** 射線法：點是否在多邊形內 */
function pointInPolygon(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if (((yi > py) !== (yj > py)) &&
        (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

/** 判定一點打中哪個部位：'head' | 'torso' | null */
function hitTest(pose, px, py) {
  const head = headCircle(pose);
  if (head && Math.hypot(px - head.cx, py - head.cy) <= head.r) return 'head';
  const torso = torsoQuad(pose);
  if (torso && pointInPolygon(px, py, torso)) return 'torso';
  return null;
}

/** 玩家整體外框（畫頭上血條用的定位參考） */
function poseBounds(pose) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, n = 0;
  for (const name of KEYPOINT_NAMES) {
    const k = getKp(pose, name);
    if (!k) continue;
    minX = Math.min(minX, k.x); maxX = Math.max(maxX, k.x);
    minY = Math.min(minY, k.y); maxY = Math.max(maxY, k.y);
    n++;
  }
  return n >= 3 ? { minX, minY, maxX, maxY } : null;
}
