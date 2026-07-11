/**
 * colorid.js — 玩家顏色識別
 * 每位玩家在大廳取樣自己衣服（軀幹）的顏色；戰鬥中對偵測到的人取樣軀幹顏色，
 * 以 HSV 距離比對出「這個人是哪個玩家」。
 */

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

const _sampCanvas = document.createElement('canvas');
_sampCanvas.width = _sampCanvas.height = 12;
const _sampCtx = _sampCanvas.getContext('2d', { willReadFrequently: true });

/** 對影片指定區域取平均色（回傳 HSV），區域太小回傳 null */
function sampleRegion(video, x, y, w, h) {
  if (!video.videoWidth || w < 4 || h < 4) return null;
  try {
    _sampCtx.drawImage(video, x, y, w, h, 0, 0, 12, 12);
  } catch { return null; }
  const d = _sampCtx.getImageData(0, 0, 12, 12).data;
  let rs = 0, gs = 0, bs = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) { rs += d[i]; gs += d[i + 1]; bs += d[i + 2]; n++; }
  return rgbToHsv(rs / n, gs / n, bs / n);
}

/** 取樣一個姿態的軀幹中央區域顏色（影片座標） */
function sampleTorsoColor(video, pose) {
  const quad = torsoQuad(pose);
  if (!quad) return null;
  const xs = quad.map(p => p.x), ys = quad.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  // 只取中央 50%，避開邊緣背景混入
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const w = (maxX - minX) * 0.5, h = (maxY - minY) * 0.5;
  return sampleRegion(video, cx - w / 2, cy - h / 2, w, h);
}

/** 兩個 HSV 顏色的距離（色相為主、飽和/明度為輔） */
function colorDistance(a, b) {
  const dh = Math.min(Math.abs(a.h - b.h), 360 - Math.abs(a.h - b.h)) / 180;
  const ds = Math.abs(a.s - b.s), dv = Math.abs(a.v - b.v);
  // 兩者都接近無彩色（白灰黑）時，色相不可靠，改比明度
  if (a.s < 0.18 && b.s < 0.18) return dv * 1.2 + ds * 0.5;
  return dh * 2 + ds * 0.7 + dv * 0.4;
}

const COLOR_MATCH_THRESHOLD = 0.55;   // 超過此距離視為「不是任何已登錄玩家」（需實測調整）

/** 比對顏色屬於哪個玩家，回傳 pid 或 null（excludePid = 自己） */
function classifyPlayer(hsv, players, excludePid) {
  if (!hsv) return null;
  let best = null, bestD = Infinity;
  for (const p of players) {
    if (!p.color || p.pid === excludePid) continue;
    const d = colorDistance(hsv, p.color);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best && bestD < COLOR_MATCH_THRESHOLD ? best.pid : null;
}

/** HSV → CSS 色票（大廳顯示用） */
function hsvToCss(c) {
  return c ? `hsl(${Math.round(c.h)}, ${Math.round(c.s * 100)}%, ${Math.round(Math.max(0.15, c.v * 0.6) * 100)}%)` : '#555';
}
