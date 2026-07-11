/**
 * main.js — 相機、渲染迴圈、輸入、HUD 串接
 */

(() => {
  const $ = id => document.getElementById(id);
  const video = $('video'), overlay = $('overlay');
  const ctx = overlay.getContext('2d');

  const registry = new TargetRegistry();
  const fireCtl = new FireControl();
  const sfx = new Sfx();

  let detector = null;
  let poses = [];          // 最新一批偵測結果（影片像素座標）
  let mirrored = false;    // 前鏡頭時鏡像顯示
  let running = false;

  /* ── 座標轉換：影片像素座標 ←→ 螢幕座標（object-fit: cover） ── */
  function coverTransform() {
    const vw = video.videoWidth, vh = video.videoHeight;
    const cw = overlay.width, ch = overlay.height;
    const scale = Math.max(cw / vw, ch / vh);
    const offX = (cw - vw * scale) / 2;
    const offY = (ch - vh * scale) / 2;
    return { scale, offX, offY, cw };
  }
  function toScreen(x, y, t) {
    const sx = x * t.scale + t.offX;
    return { x: mirrored ? t.cw - sx : sx, y: y * t.scale + t.offY };
  }
  function screenCenterToVideo(t) {
    const cx = overlay.width / 2, cy = overlay.height / 2;
    const sx = mirrored ? t.cw - cx : cx;   // 中心點鏡像後仍是中心，保留通式
    return { x: (sx - t.offX) / t.scale, y: (cy - t.offY) / t.scale };
  }

  /* ── 相機 ── */
  async function openCamera() {
    const tryGet = c => navigator.mediaDevices.getUserMedia({ video: c, audio: false });
    let stream;
    try {
      stream = await tryGet({ facingMode: { exact: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } });
      mirrored = false;
    } catch {
      // 桌機沒有後鏡頭 → 退回任意鏡頭（前鏡頭做鏡像）
      stream = await tryGet({ width: { ideal: 1280 }, height: { ideal: 720 } });
      mirrored = true;
    }
    video.srcObject = stream;
    if (mirrored) video.style.transform = 'scaleX(-1)';
    await new Promise(res => { video.onloadedmetadata = res; });
    await video.play();
  }

  function resizeOverlay() {
    overlay.width = window.innerWidth * devicePixelRatio;
    overlay.height = window.innerHeight * devicePixelRatio;
    overlay.style.width = window.innerWidth + 'px';
    overlay.style.height = window.innerHeight + 'px';
  }
  window.addEventListener('resize', resizeOverlay);

  /* ── 偵測迴圈（與渲染分離，偵測多慢都不卡 UI） ── */
  let fpsCount = 0, fpsLast = performance.now();
  async function detectLoop() {
    while (running) {
      try {
        poses = await detector.detect(video);
        registry.sync(poses, performance.now());
      } catch (e) {
        console.error('[detect]', e);
      }
      fpsCount++;
      const now = performance.now();
      if (now - fpsLast >= 1000) {
        $('fpsText').textContent = fpsCount;
        fpsCount = 0; fpsLast = now;
      }
      await new Promise(r => setTimeout(r, 0)); // 讓出主執行緒
    }
  }

  /* ── 渲染迴圈 ── */
  function render() {
    if (!running) return;
    const now = performance.now();
    const t = coverTransform();
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    for (const pose of poses) {
      const dead = registry.isDead(pose.id, now);
      drawTarget(pose, t, now, dead);
    }
    updateFireRing(now);
    requestAnimationFrame(render);
  }

  /** 畫單一目標：命中區域 + 頭上血條（或重生倒數） */
  function drawTarget(pose, t, now, dead) {
    const target = registry.get(pose.id);
    const bounds = poseBounds(pose);
    if (!target || !bounds) return;

    const px = t.scale;   // 影片→螢幕的縮放，用來換算線寬與尺寸

    // 命中區域可視化（半透明，之後正式版可關閉）
    const head = headCircle(pose);
    const torso = torsoQuad(pose);
    ctx.lineWidth = 2 * devicePixelRatio;
    if (torso) {
      ctx.beginPath();
      torso.forEach((p, i) => {
        const s = toScreen(p.x, p.y, t);
        i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y);
      });
      ctx.closePath();
      ctx.strokeStyle = dead ? 'rgba(120,120,120,.5)' : 'rgba(80,200,255,.7)';
      ctx.fillStyle = dead ? 'rgba(120,120,120,.12)' : 'rgba(80,200,255,.12)';
      ctx.fill(); ctx.stroke();
    }
    if (head) {
      const c = toScreen(head.cx, head.cy, t);
      ctx.beginPath();
      ctx.arc(c.x, c.y, head.r * px, 0, Math.PI * 2);
      ctx.strokeStyle = dead ? 'rgba(120,120,120,.5)' : 'rgba(255,120,120,.8)';
      ctx.fillStyle = dead ? 'rgba(120,120,120,.12)' : 'rgba(255,120,120,.12)';
      ctx.fill(); ctx.stroke();
    }

    // 頭上血條位置：外框頂端再往上一點
    const topMid = toScreen((bounds.minX + bounds.maxX) / 2, bounds.minY, t);
    const barW = Math.max(70 * devicePixelRatio, (bounds.maxX - bounds.minX) * px * 0.6);
    const barH = 10 * devicePixelRatio;
    const bx = topMid.x - barW / 2;
    const by = topMid.y - barH - 14 * devicePixelRatio;

    if (dead) {
      // 重生倒數
      const secs = Math.ceil((target.deadUntil - now) / 1000);
      ctx.font = `${16 * devicePixelRatio}px system-ui`;
      ctx.textAlign = 'center';
      ctx.fillStyle = '#fff';
      ctx.shadowColor = '#000'; ctx.shadowBlur = 6;
      ctx.fillText(`💀 重生 ${secs}s`, topMid.x, by + barH);
      ctx.shadowBlur = 0;
      return;
    }

    // 血條底
    ctx.fillStyle = 'rgba(0,0,0,.6)';
    roundRect(bx, by, barW, barH, barH / 2); ctx.fill();
    // 血量
    const ratio = target.hp / RULES.maxHp;
    ctx.fillStyle = ratio > 0.5 ? '#2ecc71' : ratio > 0.25 ? '#f39c12' : '#e74c3c';
    if (ratio > 0) { roundRect(bx, by, barW * ratio, barH, barH / 2); ctx.fill(); }
    // 外框 + ID
    ctx.strokeStyle = 'rgba(255,255,255,.7)';
    ctx.lineWidth = 1.5 * devicePixelRatio;
    roundRect(bx, by, barW, barH, barH / 2); ctx.stroke();
    ctx.font = `${11 * devicePixelRatio}px system-ui`;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff';
    ctx.shadowColor = '#000'; ctx.shadowBlur = 4;
    ctx.fillText(`P${pose.id} · ${target.hp}`, topMid.x, by - 4 * devicePixelRatio);
    ctx.shadowBlur = 0;
  }

  function roundRect(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* ── 開火 ── */
  function tryFire() {
    const now = performance.now();
    if (!fireCtl.canFire(now)) return;
    fireCtl.fire(now);
    sfx.shot();
    navigator.vibrate?.(30);
    $('fireBtn').classList.add('cooldown');

    // 十字標（螢幕中心）換算回影片座標做命中判定
    const t = coverTransform();
    const aim = screenCenterToVideo(t);

    // 多目標同時涵蓋時，取頭部優先、再取距中心最近者
    let best = null;
    for (const pose of poses) {
      if (registry.isDead(pose.id, now)) continue;
      const part = hitTest(pose, aim.x, aim.y);
      if (!part) continue;
      const head = headCircle(pose);
      const d = head ? Math.hypot(aim.x - head.cx, aim.y - head.cy) : Infinity;
      if (!best || (part === 'head' && best.part !== 'head') ||
          (part === best.part && d < best.d)) {
        best = { pose, part, d };
      }
    }
    if (!best) return;

    const result = registry.takeDamage(best.pose.id, best.part, now);
    if (!result) return;

    // 命中回饋
    sfx.hit(best.part === 'head');
    navigator.vibrate?.(60);
    flashClass($('hitMarker'), 'show');
    if (result.killed) {
      sfx.kill();
      showHitText(`💀 擊倒 P${best.pose.id}！`);
    } else if (best.part === 'head') {
      showHitText('🎯 爆頭 -50！');
    } else {
      showHitText('-25');
    }
  }

  function flashClass(el, cls) {
    el.classList.remove(cls);
    void el.offsetWidth;   // 重觸發動畫
    el.classList.add(cls);
  }
  function showHitText(msg) {
    const el = $('hitText');
    el.textContent = msg;
    flashClass(el, 'show');
  }

  function updateFireRing(now) {
    const p = fireCtl.progress(now);
    const ring = $('fireRing'), btn = $('fireBtn');
    if (p >= 1) {
      ring.style.background = 'none';
      btn.classList.remove('cooldown');
    } else {
      const deg = p * 360;
      ring.style.background =
        `conic-gradient(rgba(255,255,255,.85) ${deg}deg, rgba(0,0,0,.55) ${deg}deg)`;
      ring.style.mask = 'radial-gradient(circle, transparent 62%, #000 63%)';
      ring.style.webkitMask = 'radial-gradient(circle, transparent 62%, #000 63%)';
    }
  }

  /* ── 啟動流程 ── */
  async function start() {
    const btn = $('startBtn'), status = $('loadStatus');
    btn.disabled = true;
    try {
      status.textContent = '開啟相機…';
      await openCamera();
      detector = await createPoseDetector(msg => { status.textContent = msg; });

      $('startScreen').classList.add('hidden');
      $('gameScreen').classList.remove('hidden');
      resizeOverlay();

      // 防螢幕休眠（支援的瀏覽器）
      try { await navigator.wakeLock?.request('screen'); } catch {}

      running = true;
      detectLoop();
      requestAnimationFrame(render);
    } catch (e) {
      console.error('[start]', e);
      status.textContent = `啟動失敗：${e.message}（需要 HTTPS 或 localhost，且允許相機權限）`;
      btn.disabled = false;
    }
  }

  $('startBtn').addEventListener('click', start);
  // touchstart 比 click 快 ~100ms，射擊手感差很多
  $('fireBtn').addEventListener('touchstart', e => { e.preventDefault(); tryFire(); }, { passive: false });
  $('fireBtn').addEventListener('mousedown', e => { if (e.button === 0) tryFire(); });
})();
