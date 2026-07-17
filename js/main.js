/**
 * main.js — 畫面流程（選單/大廳/戰鬥）、相機、渲染迴圈、輸入、HUD
 *
 * 模式：
 *   solo   單機練習：鏡頭裡每個人都是靶（TargetRegistry 本地血量）
 *   host   房主：本機就是權威伺服器（HostNet）
 *   client 玩家：命中後回報房主（ClientNet）
 */

(() => {
  const $ = id => document.getElementById(id);
  const video = $('video'), overlay = $('overlay');
  const ctx = overlay.getContext('2d');
  // render 用的像素密度上限：手機 devicePixelRatio 常是 3，overlay 內部像素會被放到超大
  // （面積是 dpr=2 的 2.25×），每幀 clearRect+貼圖負擔重。clamp 到 2 大幅減負，且與相機畫質無關。
  const RDPR = Math.min(window.devicePixelRatio || 1, 2);

  let mode = 'solo';           // 'solo' | 'host' | 'client'
  let net = null;              // HostNet / ClientNet
  let netState = null;         // {hp, deadUntil, kills}（本地時間軸）
  let prevMyHp = RULES.maxHp;
  let myColor = null;
  let soloKills = 0;
  let myWeaponId = DEFAULT_WEAPON_ID;      // 開戰前選定；遊戲進行中不可換
  const myWeapon = () => weaponById(myWeaponId) || WEAPONS[0];

  const registry = new TargetRegistry();   // solo 模式用
  const fireCtl = new FireControl(myWeapon().cooldownMs);
  const sfx = new Sfx();

  let detector = null, detectorPromise = null;
  let poses = [];
  const trackMotion = new Map();   // 追蹤補間：目標 id -> {cx,cy,t,vx,vy}（video 座標 px/ms）
  let mirrored = false;
  let running = false;

  /* ── 認人（re-ID）：嵌入模型 + 登錄向量 + 比對快取 ── */
  let reid = null, myEmb = null;
  const reidCache = new Map();   // trackId -> {t, pid}
  const REID_TTL = 700, REID_MATCH_TH = 0.5, REID_BUDGET = 2;
  createReidEmbedder?.().then(r => { reid = r; console.log('[reid] 就緒', r.backend); })
    .catch(e => console.warn('[reid] 不可用，退回顏色識別', e));

  /* ── 座標轉換（object-fit: cover） ── */
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
    const sx = mirrored ? t.cw - cx : cx;
    return { x: (sx - t.offX) / t.scale, y: (cy - t.offY) / t.scale };
  }

  /* ── 相機 ── */
  const CAM_ERROR_HINT = {
    NotAllowedError: '相機權限被拒絕。請到瀏覽器設定允許此網站使用相機後重試',
    NotFoundError: '找不到相機裝置',
    NotReadableError: '相機被其他 App 佔用中，請關閉其他使用相機的 App 後重試',
    SecurityError: '瀏覽器安全設定阻擋了相機',
  };

  async function openCamera(onStatus) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('此瀏覽器不支援相機。若你是從 LINE / FB / IG 的訊息點開連結，請改用「以瀏覽器開啟」或複製網址到 Safari / Chrome');
    }
    // 原生高畫質：不指定解析度時 getUserMedia 會給低畫質預設（常 640×480/720p）→ 畫面被壓縮。
    // 故明確要求到 4K（ideal，裝置會給它支援的最高原生畫質），顯示清晰。
    // 偵測已與相機解析度解耦（只送 384 縮圖、推論固定 256），高畫質相機不加重偵測/GPU 負擔。失敗逐層降級。
    const UHD = { width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 30 } };
    const HI = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
    const candidates = [
      { facingMode: { exact: 'environment' }, ...UHD },
      { facingMode: { exact: 'environment' }, ...HI },
      { facingMode: 'environment', ...UHD },
      { ...UHD },
      { ...HI },
      true,
    ];
    let stream = null, lastErr = null;
    for (let i = 0; i < candidates.length; i++) {
      onStatus?.(`開啟相機…(嘗試 ${i + 1}/${candidates.length})`);
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: candidates[i], audio: false });
        break;
      } catch (e) {
        lastErr = e;
        if (e.name === 'NotAllowedError') break;
      }
    }
    if (!stream) throw new Error(CAM_ERROR_HINT[lastErr?.name] || `${lastErr?.name}: ${lastErr?.message}`);

    const settings = stream.getVideoTracks()[0].getSettings?.() || {};
    mirrored = settings.facingMode === 'user';
    video.srcObject = stream;
    video.style.transform = mirrored ? 'scaleX(-1)' : '';
    await new Promise((res, rej) => {
      video.onloadedmetadata = res;
      setTimeout(() => rej(new Error('相機串流逾時，畫面沒有送出資料')), 8000);
    });
    await video.play();
    onStatus?.(`相機就緒 ${video.videoWidth}x${video.videoHeight}${mirrored ? '（前鏡頭）' : ''}`);
  }

  async function ensureCamera(onStatus) {
    if (!video.srcObject) await openCamera(onStatus);
  }

  function preloadDetector(onStatus) {
    const cb = onStatus || (() => {});
    if (!detectorPromise) {
      // 方法 D：優先用 Web Worker 版（畫面不卡）；失敗或 ?nowk 退回主線程版
      const noWk = new URLSearchParams(location.search).has('nowk');
      detectorPromise = (segWorkerSupported() && !noWk)
        ? createSegDetectorWorker(cb).catch(e => { console.warn('[worker] 退回主線程', e); return createSegDetector(cb); })
        : createSegDetector(cb);
    }
    return detectorPromise;
  }

  function resizeOverlay() {
    overlay.width = window.innerWidth * RDPR;
    overlay.height = window.innerHeight * RDPR;
    overlay.style.width = window.innerWidth + 'px';
    overlay.style.height = window.innerHeight + 'px';
  }
  window.addEventListener('resize', resizeOverlay);

  /* ── 偵測迴圈（節流上限 ~18fps；偵測在背景執行緒，準星/畫面獨立跑滿幀）── */
  const DET_MIN_INTERVAL = new URLSearchParams(location.search).has('max') ? 0 : 50;   // 50ms≈20fps 上限：192 較輕，撐得起高更新率讓剪影貼合移動的人；撐不住時自適應降 128；?max=1 全速
  const DET_PERSIST_MS = 600;   // 單幀漏抓時沿用舊遮罩的時限（開火不因偵測斷幀落空）
  let fpsCount = 0, fpsLast = performance.now(), detErrors = 0;
  // 保底 15fps：WebGPU 背景執行緒解析度撐不住時階梯降級 256→192→128（fpsSwitching 防切換中重複觸發）；
  // 反向自動升階：跑得動（偵測≥20fps 且畫面≥40fps）連續 3 秒 → 升一階 128→192→256，讓快手機吃更高畫質
  let fpsSwitching = false;
  let upStreak = 0;    // 連續達標秒數（升階需連續 3 秒，避免瞬間好轉就升）
  let upBanned = 0;    // 曾經降級的解析度不再自動升回去（防升↔降振盪）
  async function detectLoop() {
    while (running) {
      const tStart = performance.now();
      try {
        const result = await detector.detect(video);
        detErrors = 0;
        if (mode === 'solo') {
          // 位置 + 顏色雙重比對，把追蹤 ID 映射回穩定的人物專屬 ID
          registry.sync(
            result,
            performance.now(),
            det => segColorSample(video, det),
            det => {
              const b = segBounds(det);
              if (!b) return null;
              return {
                x: (b.minX + b.maxX) / 2,
                y: (b.minY + b.maxY) / 2,
                size: Math.hypot(b.maxX - b.minX, b.maxY - b.minY),
              };
            }
          );
        } else {
          // 顏色識別：這個人是哪個玩家（基礎判定）
          for (const det of result) {
            det.pid = classifyPlayer(segColorSample(video, det), net.players, net.myPid);
          }
          // 認人（re-ID）覆蓋：嵌入向量比對，節流（每目標 ~700ms、每輪最多 2 個）
          if (reid && net.players.some(p => p.emb && p.pid !== net.myPid)) {
            let budget = REID_BUDGET;
            const tR = performance.now();
            for (const det of result) {
              const c = reidCache.get(det.id);
              if (c && tR - c.t < REID_TTL) { if (c.pid != null) det.pid = c.pid; continue; }
              if (budget-- <= 0) continue;
              try {
                const b = det.bbox;
                const e = await reid.embedRegion(video, b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);
                if (!e) continue;
                let best = null, bs = REID_MATCH_TH;
                for (const p of net.players) {
                  if (!p.emb || p.pid === net.myPid) continue;
                  const s = embCosine(e, p.emb);
                  if (s > bs) { bs = s; best = p.pid; }
                }
                reidCache.set(det.id, { t: tR, pid: best });
                if (best != null) det.pid = best;
              } catch { /* 單次嵌入失敗不影響本幀 */ }
            }
            if (reidCache.size > 64) {
              for (const [k, v] of reidCache) if (tR - v.t > 5000) reidCache.delete(k);
            }
          }
        }
        // 遮罩延續：這一幀沒接上的目標（偵測偶發漏抓），沿用上一幀的遮罩一小段時間，
        // 開火命中判定永遠有「最近可用」的剪影可打，不因單幀漏抓而落空。
        const tNow = performance.now();
        for (const det of result) det._seen = tNow;
        // 追蹤補間：算每個目標的移動速度（video 座標 px/ms），render 幀間外推讓剪影/血條/命中貼合移動的人
        for (const det of result) {
          const b = det.bbox;
          const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
          const m = trackMotion.get(det.id);
          if (m && tNow - m.t > 0 && tNow - m.t < 200) {
            const dt = tNow - m.t;
            const nvx = (cx - m.cx) / dt, nvy = (cy - m.cy) / dt;
            det._vx = m.vx * 0.5 + nvx * 0.5;   // EMA 平滑，避免單幀抖動
            det._vy = m.vy * 0.5 + nvy * 0.5;
          } else { det._vx = 0; det._vy = 0; }   // 首次見到或斷太久 → 不外推
          det._t0 = tNow;
          trackMotion.set(det.id, { cx, cy, t: tNow, vx: det._vx, vy: det._vy });
        }
        if (trackMotion.size > 32) { for (const [k, v] of trackMotion) if (tNow - v.t > 2000) trackMotion.delete(k); }
        const freshIds = new Set(result.map(d => d.id));
        for (const old of poses) {
          if (freshIds.has(old.id)) continue;
          if (tNow - (old._seen || 0) < DET_PERSIST_MS) result.push(old);
        }
        poses = result;
      } catch (e) {
        console.error('[detect]', e);
        detErrors++;
      }
      fpsCount++;
      const now = performance.now();
      if (now - fpsLast >= 1000) {
        const detFps = fpsCount;
        $('fpsText').textContent = `${detFps}/${renderFps}·${detector?.size || ''}`;   // 偵測/畫面·解析度
        // 階梯降級 256→192→128：以「畫面 fps」為準（GPU 被推論吃滿時畫面先掉，偵測 fps 未必低）；
        // 畫面 <24fps 或偵測 <12fps 就降一階釋放 GPU（切換在背景執行緒，不卡準星/畫面）
        if (detector?.worker && !fpsSwitching && detector.size > 128 &&
            renderFps > 0 && (renderFps < 24 || detFps < 12)) {
          const next = detector.size >= 256 ? SEG_192 : SEG_LORES;
          upBanned = detector.size;   // 這一階撐不住 → 之後不再自動升回來
          upStreak = 0;
          fpsSwitching = true;
          console.log(`[detect] 畫面${renderFps}/偵測${detFps}，降級 ${detector.size}→${next.size}`);
          detector.setResolution?.(next).finally(() => { fpsSwitching = false; });
        } else if (detector?.worker && detector.backend === 'webgpu' && !fpsSwitching &&
                   detector.size < 256 && detFps >= 20 && renderFps >= 40) {
          // 自動升階 128→192→256：只在 WebGPU（WASM 升階運算量翻倍會直接卡死）；
          // 偵測≥20 且畫面≥40 連續 3 秒才升，且不升回曾降級的解析度
          // ⚠️ 偵測被 DET_MIN_INTERVAL=50ms 節流封頂在 ~20fps，20 是「跑滿節流上限」才升的意思
          const up = detector.size <= 128 ? SEG_192 : SEG_256;
          if (upBanned && up.size >= upBanned) {
            upStreak = 0;
          } else if (++upStreak >= 3) {
            upStreak = 0;
            fpsSwitching = true;
            console.log(`[detect] 畫面${renderFps}/偵測${detFps}，升階 ${detector.size}→${up.size}`);
            detector.setResolution?.(up).finally(() => { fpsSwitching = false; });
          }
        } else {
          upStreak = 0;
        }
        fpsCount = 0; fpsLast = now;
      }
      // 節流：偵測快時補足間隔到 ~55ms(18fps 上限)，把剩餘時間讓給畫面繪製；偵測慢時全速跑
      const elapsed = performance.now() - tStart;
      const gap = Math.max(4, DET_MIN_INTERVAL - elapsed);
      await new Promise(r => setTimeout(r, gap));
    }
  }

  /* ── 渲染迴圈（畫面層，獨立於偵測、跑滿幀）── */
  let renderCount = 0, renderLast = performance.now(), renderFps = 0;
  function render() {
    if (!running) return;
    const now = performance.now();
    const t = coverTransform();
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    for (const pose of poses) {
      // 補間位移：自這批偵測起經過的時間 × 速度（clamp 120ms，斷幀時剪影不飄走）
      const dt = Math.min(120, now - (pose._t0 || now));
      pose._dx = (pose._vx || 0) * dt;
      pose._dy = (pose._vy || 0) * dt;
      drawTarget(pose, t, now);
    }
    drawEffects(now);
    if (firing) tryFire();      // 按住連發：綁定畫面幀，與冷卻環同幀 → 環與實際一致、連發跟畫面一樣順（不被偵測 setTimeout 飢餓）
    updateFireRing(now);
    updateSelfStatus(now);
    renderCount++;
    if (now - renderLast >= 1000) { renderFps = renderCount; renderCount = 0; renderLast = now; }
    requestAnimationFrame(render);
  }

  /** 目標資訊：依模式回傳 {label, hp, dead, deadRemainMs, registered} */
  function targetInfo(pose, now) {
    if (mode === 'solo') {
      const t = registry.get(pose.id);
      if (!t) return null;
      const dead = registry.isDead(pose.id, now);
      return { label: `P${t.id}`, pid: t.id, hp: t.hp, dead, deadRemainMs: dead ? t.deadUntil - now : 0, registered: true };
    }
    if (pose.pid == null || !netState) return { registered: false };
    const player = net.players.find(p => p.pid === pose.pid);
    if (!player) return { registered: false };
    const deadUntil = netState.deadUntil[pose.pid] || 0;
    const dead = deadUntil > now;
    return { label: player.name, pid: pose.pid, hp: netState.hp[pose.pid] ?? 0, dead, deadRemainMs: dead ? deadUntil - now : 0, registered: true };
  }

  // 每個玩家一種顏色（依人物 ID 取用），讓不同人一眼分得出
  const PERSON_COLORS = [
    [80,200,255,95],   // 藍
    [255,95,95,95],    // 紅
    [120,235,120,95],  // 綠
    [255,175,60,95],   // 橙
    [205,120,255,95],  // 紫
    [95,235,225,95],   // 青
    [255,120,200,95],  // 粉
    [235,230,90,95],   // 黃綠
  ];

  function drawTarget(pose, t, now) {
    const info = targetInfo(pose, now);
    const bounds = segBounds(pose);
    if (!info || !bounds) return;

    const dead = info.registered && info.dead;
    const unreg = !info.registered;

    // 剪影填色：未登錄=黃、死亡=灰、可擊殺=依人物 ID 給不同顏色
    const fill = unreg ? [255,210,80,70] : dead ? [150,150,150,55] : PERSON_COLORS[info.pid % PERSON_COLORS.length];
    drawMask(pose, t, fill);

    // 血條跟著補間位移一起平移，與剪影對齊
    const dx = pose._dx || 0, dy = pose._dy || 0;
    const topMid = toScreen((bounds.minX + bounds.maxX) / 2 + dx, bounds.minY + dy, t);
    const barW = Math.max(70 * RDPR, (bounds.maxX - bounds.minX) * t.scale * 0.6);
    const barH = 10 * RDPR;
    const bx = topMid.x - barW / 2;
    const by = topMid.y - barH - 14 * RDPR;

    if (!info.registered) {
      // 未登錄的人：只標示問號，不能打
      ctx.font = `${14 * RDPR}px system-ui`;
      ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(255,255,255,.55)';
      ctx.shadowColor = '#000'; ctx.shadowBlur = 4;
      ctx.fillText('未登錄', topMid.x, by + barH);
      ctx.shadowBlur = 0;
      return;
    }

    if (dead) {
      const secs = Math.ceil(info.deadRemainMs / 1000);
      ctx.font = `${16 * RDPR}px system-ui`;
      ctx.textAlign = 'center'; ctx.fillStyle = '#fff';
      ctx.shadowColor = '#000'; ctx.shadowBlur = 6;
      ctx.fillText(`💀 重生 ${secs}s`, topMid.x, by + barH);
      ctx.shadowBlur = 0;
      return;
    }

    // 頭上血條
    ctx.fillStyle = 'rgba(0,0,0,.6)';
    roundRect(bx, by, barW, barH, barH / 2); ctx.fill();
    const ratio = Math.max(0, info.hp) / RULES.maxHp;
    ctx.fillStyle = ratio > 0.5 ? '#2ecc71' : ratio > 0.25 ? '#f39c12' : '#e74c3c';
    if (ratio > 0) { roundRect(bx, by, barW * ratio, barH, barH / 2); ctx.fill(); }
    ctx.strokeStyle = 'rgba(255,255,255,.7)';
    ctx.lineWidth = 1.5 * RDPR;
    roundRect(bx, by, barW, barH, barH / 2); ctx.stroke();
    ctx.font = `${11 * RDPR}px system-ui`;
    ctx.textAlign = 'center'; ctx.fillStyle = '#fff';
    ctx.shadowColor = '#000'; ctx.shadowBlur = 4;
    ctx.fillText(`${info.label} · ${info.hp}`, topMid.x, by - 4 * RDPR);
    ctx.shadowBlur = 0;
  }

  /** 畫人物剪影：遮罩畫進「每個目標專屬」離屏 canvas 並快取，再平滑縮放貼到螢幕。
      快取關鍵：poses 只在偵測更新（~15fps），render 跑 60fps → 同一 det 物件會被重畫多次；
      只在遮罩內容/顏色變時才重建像素（省掉每幀 mw*mh 的 ImageData 迴圈），其餘幀只做 drawImage 縮放。 */
  function drawMask(det, t, rgba) {
    if (!det.mask) return;
    const tf = det._tf;
    const key = rgba[0] + ',' + rgba[1] + ',' + rgba[2] + ',' + rgba[3];
    if (!det._mcv || det._mcvKey !== key) {
      const mcv = det._mcv || (det._mcv = document.createElement('canvas'));
      if (mcv.width !== det.mw) { mcv.width = det.mw; mcv.height = det.mh; }
      const mctx = det._mctx || (det._mctx = mcv.getContext('2d'));
      const img = mctx.createImageData(det.mw, det.mh);
      const [r, g, b, a] = rgba;
      for (let i = 0; i < det.mask.length; i++) {
        if (det.mask[i]) { img.data[i*4] = r; img.data[i*4+1] = g; img.data[i*4+2] = b; img.data[i*4+3] = a; }
      }
      mctx.putImageData(img, 0, 0);
      det._mcvKey = key;
    }
    // proto→螢幕 為線性映射；計算整個遮罩網格貼到螢幕的位置與尺寸（含追蹤補間位移 _dx/_dy）
    const cellW = t.scale / (tf.mxScale * tf.scale);
    const cellH = t.scale / (tf.myScale * tf.scale);
    const originX = -tf.padX / tf.scale * t.scale + t.offX + (det._dx || 0) * t.scale;
    const originY = -tf.padY / tf.scale * t.scale + t.offY + (det._dy || 0) * t.scale;
    ctx.save();
    if (mirrored) { ctx.translate(overlay.width, 0); ctx.scale(-1, 1); }
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(det._mcv, 0, 0, det.mw, det.mh, originX, originY, cellW * det.mw, cellH * det.mh);
    ctx.restore();
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

  /* ── 開火特效（依武器：曳光/散彈扇/狙擊光束/火箭飛行+爆風）── */
  const effects = [];
  function drawEffects(now) {
    const cx = overlay.width / 2, cy = overlay.height / 2;
    const sx = cx, sy = overlay.height * 0.66;   // 由槍口射出
    const dpr = RDPR;
    for (let i = effects.length - 1; i >= 0; i--) {
      const fx = effects[i];
      const p = (now - fx.t0) / fx.dur;
      if (p >= 1) { effects.splice(i, 1); continue; }
      const col = fx.color || '255,210,90';
      ctx.save();
      switch (fx.type) {
        case 'pellets': {   // 散彈：扇形多道細曳光 + 末端彈孔點
          ctx.globalAlpha = (1 - p) * 0.85;
          for (const a of fx.angles) {
            const ex = cx + Math.sin(a) * overlay.width * 0.5 * fx.spreadPx;
            const ey = cy + Math.cos(a) * overlay.width * 0.5 * fx.spreadPx * 0.6 - 0;
            ctx.strokeStyle = `rgba(${col},.9)`;
            ctx.lineWidth = 2 * dpr;
            ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
            ctx.fillStyle = `rgba(${col},.9)`;
            ctx.beginPath(); ctx.arc(ex, ey, 3 * dpr * (1 - p), 0, Math.PI * 2); ctx.fill();
          }
          break;
        }
        case 'beam': {      // 狙擊：亮細光束、殘留較久
          ctx.globalAlpha = (1 - p);
          ctx.strokeStyle = `rgba(${col},.95)`;
          ctx.lineWidth = fx.width * dpr;
          ctx.shadowColor = `rgba(${col},.9)`;
          ctx.shadowBlur = 18 * dpr;
          ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(cx, cy); ctx.stroke();
          break;
        }
        case 'rocket': {    // 火箭：彈頭由槍口飛向準星 + 尾焰
          const rx = sx + (cx - sx) * p, ry = sy + (cy - sy) * p;
          ctx.globalAlpha = 1;
          ctx.fillStyle = `rgba(${col},1)`;
          ctx.shadowColor = `rgba(${col},.9)`;
          ctx.shadowBlur = 16 * dpr;
          ctx.beginPath(); ctx.arc(rx, ry, 6 * dpr * (1 - p * 0.5), 0, Math.PI * 2); ctx.fill();
          ctx.globalAlpha = 0.55;
          ctx.strokeStyle = `rgba(${col},.7)`;
          ctx.lineWidth = 4 * dpr * (1 - p);
          ctx.beginPath(); ctx.moveTo(sx + (cx - sx) * Math.max(0, p - 0.25), sy + (cy - sy) * Math.max(0, p - 0.25));
          ctx.lineTo(rx, ry); ctx.stroke();
          break;
        }
        case 'blast': {     // 爆風：擴張圓環 + 內部光暈
          const r = fx.radius * (0.4 + 0.6 * p);
          ctx.globalAlpha = (1 - p) * 0.9;
          ctx.strokeStyle = `rgba(${col},.95)`;
          ctx.lineWidth = 6 * dpr * (1 - p);
          ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
          ctx.globalAlpha = (1 - p) * 0.35;
          ctx.fillStyle = `rgba(${col},.8)`;
          ctx.beginPath(); ctx.arc(cx, cy, r * 0.8, 0, Math.PI * 2); ctx.fill();
          break;
        }
        default: {          // tracer：單道曳光（手槍/步槍/衝鋒槍，粗細顏色不同）
          ctx.globalAlpha = (1 - p) * 0.9;
          const grad = ctx.createLinearGradient(sx, sy, cx, cy);
          grad.addColorStop(0, `rgba(${col},1)`);
          grad.addColorStop(1, 'rgba(255,255,255,.2)');
          ctx.strokeStyle = grad;
          ctx.lineWidth = ((fx.width || 4) - 3 * p) * dpr;
          ctx.shadowColor = `rgba(${col},.9)`;
          ctx.shadowBlur = 12 * dpr;
          ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(cx, cy); ctx.stroke();
        }
      }
      ctx.restore();
    }
  }

  /* ── 自己被擊倒：重生遮罩 ── */
  function isMyDead(now) {
    return mode !== 'solo' && netState && (netState.deadUntil[net.myPid] || 0) > now;
  }
  function updateSelfStatus(now) {
    const overlayEl = $('respawnOverlay');
    if (isMyDead(now)) {
      overlayEl.classList.remove('hidden');
      $('respawnCount').textContent = Math.ceil((netState.deadUntil[net.myPid] - now) / 1000);
    } else {
      overlayEl.classList.add('hidden');
    }
  }

  /* ── 開火 ── */
  function tryFire() {
    const now = performance.now();
    if (!fireCtl.canFire(now)) return;
    if (isMyDead(now)) return;
    fireCtl.fire(now);
    const w = myWeapon();
    const fxSpec = WEAPON_FX[w.id] || WEAPON_FX.pistol;
    sfx.shot(w.id);
    navigator.vibrate?.(w.id === 'rocket' || w.id === 'sniper' ? 55 : 20);
    flashClass($('muzzleFlash'), 'show');
    flashClass($('gunOverlay'), 'recoil');
    flashClass($('gameScreen'), 'shake');

    // 射擊視覺效果（依武器）
    if (fxSpec.type === 'pellets') {
      effects.push({ type: 'pellets', t0: now, dur: fxSpec.dur, color: fxSpec.color,
        spreadPx: fxSpec.spread,
        angles: Array.from({ length: fxSpec.pellets }, () => (Math.random() * 2 - 1) * Math.PI) });
    } else if (fxSpec.type === 'rocket') {
      effects.push({ type: 'rocket', t0: now, dur: fxSpec.travelMs, color: fxSpec.color });
    } else {
      effects.push({ type: fxSpec.type, t0: now, dur: fxSpec.dur, width: fxSpec.width, color: fxSpec.color });
    }

    const t = coverTransform();
    const aim = screenCenterToVideo(t);

    if (fxSpec.type === 'rocket') {
      // 火箭：彈頭飛行後才在準星處爆炸結算（爆風有容錯半徑）
      setTimeout(() => {
        if (!running) return;
        const tNow = performance.now();
        sfx.explosion();
        navigator.vibrate?.(120);
        flashClass($('gameScreen'), 'shake');
        effects.push({ type: 'blast', t0: tNow, dur: fxSpec.blastDur, color: fxSpec.color,
          radius: overlay.height * fxSpec.blastRadiusFrac * 2 });
        resolveHit(aim, tNow, w, video.videoHeight * fxSpec.blastRadiusFrac);
      }, fxSpec.travelMs);
    } else {
      resolveHit(aim, now, w, 0);
    }
  }

  /** 命中結算：準星點落在剪影內即命中；blastR>0 時（火箭爆風）允許以圓周取樣容錯 */
  function resolveHit(aim, now, w, blastR) {
    const probes = [[aim.x, aim.y]];
    if (blastR > 0) {
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        probes.push([aim.x + Math.cos(a) * blastR, aim.y + Math.sin(a) * blastR]);
      }
    }
    let best = null;
    for (const det of poses) {
      const info = targetInfo(det, now);
      if (!info?.registered || info.dead) continue;
      // 命中與畫面一致：剪影視覺平移了 (_dx,_dy)，測試點反向平移回偵測時的 mask 座標
      const dx = det._dx || 0, dy = det._dy || 0;
      if (!probes.some(([px, py]) => segHitTest(det, px - dx, py - dy))) continue;
      const b = det.bbox;
      const d = Math.hypot(aim.x - ((b.minX + b.maxX) / 2 + dx), aim.y - ((b.minY + b.maxY) / 2 + dy));
      if (!best || d < best.d) best = { det, d };
    }
    if (!best) return;

    const dmg = w.body;   // 現行只判剪影內外，一律吃武器的軀幹傷害
    if (mode === 'solo') {
      const result = registry.takeDamage(best.det.id, 'hit', now, dmg);
      if (!result) return;
      hitFeedback(result.killed, `P${result.personId}`, dmg);
      if (result.killed) { soloKills++; $('killsText').textContent = soloKills; }
    } else {
      net.sendHit(best.det.pid, 'hit', dmg);          // 房主權威判定（帶上武器實際傷害）
      const name = net.players.find(p => p.pid === best.det.pid)?.name ?? '';
      hitFeedback(false, name, dmg);                  // 樂觀回饋（擊倒訊息等房主廣播）
    }
  }

  function hitFeedback(killed, name, dmg) {
    sfx.hit(false);
    navigator.vibrate?.(60);
    flashClass($('hitMarker'), 'show');
    if (killed) { sfx.kill(); showHitText(`💀 擊倒 ${name}！`); }
    else showHitText(`-${dmg}`);
  }

  function flashClass(el, cls) {
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }
  function showHitText(msg) {
    const el = $('hitText');
    el.textContent = msg;
    flashClass(el, 'show');
  }

  // 冷卻進度環：慢射速武器（如狙擊 2.5 秒）看得到什麼時候能再開槍
  let _ringActive = false;
  function updateFireRing(now) {
    const p = fireCtl.progress(now);
    if (p >= 1) {
      if (_ringActive) {
        $('fireRing').style.background = 'none';
        $('fireBtn').classList.remove('cooldown');
        _ringActive = false;
      }
      return;
    }
    _ringActive = true;
    $('fireBtn').classList.add('cooldown');
    $('fireRing').style.background =
      `conic-gradient(#ffd166 ${p * 360}deg, rgba(255,255,255,.18) ${p * 360}deg)`;
  }

  /* ── 武器選擇（主選單；遊戲進行中不可換） ── */
  function fmtRate(ms) {
    return `${parseFloat((ms / 1000).toFixed(2))} 秒/發`;   // 1000→1、1200→1.2、450→0.45
  }
  function renderWeaponList() {
    const list = $('weaponList');
    list.innerHTML = '';
    for (const w of WEAPONS) {
      const btn = document.createElement('button');
      btn.className = 'weapon-btn' + (w.id === myWeaponId ? ' selected' : '');
      const name = document.createElement('span');
      name.className = 'w-name';
      name.textContent = w.name;
      const stat = document.createElement('span');
      stat.className = 'w-stat';
      stat.textContent = `傷害 ${w.body}｜${fmtRate(w.cooldownMs)}`;
      btn.append(name, stat);
      btn.addEventListener('click', () => selectWeapon(w.id));
      list.appendChild(btn);
    }
  }
  function selectWeapon(id) {
    if (running || !weaponById(id)) return;   // 開戰後不可換
    myWeaponId = id;
    fireCtl.cooldownMs = myWeapon().cooldownMs;
    renderWeaponList();
    updateGunImage();
    net?.sendWeapon?.(id);   // 已在房間裡就同步給其他玩家（僅顯示用）
  }

  /** 依所選武器換槍圖；圖檔還沒就位時 fallback 回預設 gun.png */
  function updateGunImage() {
    const img = $('gunImg');
    img.onerror = () => { img.onerror = null; img.src = 'assets/gun.png?v=41'; };
    img.src = `assets/guns/${myWeaponId}.png?v=41`;
  }

  /* ── 連線事件 ── */
  function bindNetEvents() {
    window.__net = net;   // 除錯用把手（console 可直接查看/注入封包）
    net.on('players', renderPlayerList);
    net.on('start', enterBattle);
    net.on('kill', (killer, victim) => {
      const el = document.createElement('div');
      el.className = 'kill-msg';
      el.textContent = `${killer} 💀 ${victim}`;
      $('killFeed').appendChild(el);
      setTimeout(() => el.remove(), 3000);
    });
    net.on('state', st => {
      netState = st;
      const myHp = st.hp[net.myPid] ?? RULES.maxHp;
      if (myHp < prevMyHp) {
        flashClass($('damageFlash'), 'show');
        navigator.vibrate?.(150);
        sfx.kill && myHp === 0 && sfx.kill();
      }
      prevMyHp = myHp;
      $('myHpText').textContent = myHp;
      $('myHpFill').style.width = (myHp / RULES.maxHp * 100) + '%';
      $('killsText').textContent = st.kills[net.myPid] ?? 0;
    });
    net.on('offline', () => showHitText('⚠️ 連線中斷，自動重連中…'));
    net.on('rejoined', () => showHitText('✔ 已重新連上'));
    net.on('error', err => {
      alertStatus(`⚠️ ${err.message || err.type || err}`);
      showScreen('startScreen');
      net?.destroy?.(); net = null;
    });
  }

  function renderPlayerList(players) {
    const list = $('playerList');
    list.innerHTML = '';
    for (const p of players) {
      const row = document.createElement('div');
      row.className = 'player-row';
      const chip = document.createElement('span');
      chip.className = 'player-chip';
      chip.style.background = hsvToCss(p.color);
      const name = document.createElement('span');
      name.textContent = p.pid === net.myPid ? `${p.name}（你）` : p.name;
      const weapon = document.createElement('span');
      weapon.className = 'player-weapon';
      weapon.textContent = weaponById(p.weapon)?.name ?? '';   // 舊版房主沒有 weapon 欄位就留空
      const ready = document.createElement('span');
      if (p.offline) { ready.className = 'not-ready'; ready.textContent = '📴 斷線中'; }
      else { ready.className = p.color ? 'ready' : 'not-ready'; ready.textContent = p.color ? '✔ 已登錄' : '未取樣'; }
      row.append(chip, name, weapon, ready);
      list.appendChild(row);
    }
    if (mode === 'host') {
      $('startGameBtn').disabled = !players.every(p => p.color) || players.length < 1;
    }
  }

  /* ── 畫面切換 ── */
  function showScreen(id) {
    for (const s of ['startScreen', 'lobbyScreen', 'gameScreen']) {
      $(s).classList.toggle('hidden', s !== id);
    }
  }
  function alertStatus(msg) { $('loadStatus').textContent = msg; }

  function getName() {
    const v = $('nameInput').value.trim();
    return v || `玩家${Math.floor(10 + Math.random() * 90)}`;
  }

  async function enterLobby() {
    showScreen('lobbyScreen');
    $('lobbyStatus').textContent = '';
    try {
      await ensureCamera(msg => { $('sampleStatus').textContent = msg; });
      $('lobbyCam').srcObject = video.srcObject;
      $('sampleStatus').textContent = '';
    } catch (e) {
      $('sampleStatus').textContent = `⚠️ ${e.message}`;
    }
    // 大廳期間背景載入模型，開戰時零等待
    preloadDetector(msg => { $('lobbyStatus').textContent = msg; })
      .then(() => { $('lobbyStatus').textContent = '模型就緒 ✔'; })
      .catch(e => { $('lobbyStatus').textContent = `模型載入失敗：${e.message}`; });
  }

  async function enterBattle() {
    showScreen('gameScreen');
    try {
      await ensureCamera(() => {});
      detector = await preloadDetector();
      if (!$('fpsBox').textContent.includes('·')) {
        $('fpsBox').insertAdjacentText('beforeend', ` · ${detector.backend}`);
      }
      resizeOverlay();
      try { await navigator.wakeLock?.request('screen'); } catch {}
      updateGunImage();                            // 依所選武器換槍圖
      fireCtl.cooldownMs = myWeapon().cooldownMs;  // 開戰後鎖定射速（進行中不可換）
      prevMyHp = RULES.maxHp;
      if (!running) {
        running = true;
        detectLoop();
        requestAnimationFrame(render);
      }
    } catch (e) {
      console.error('[battle]', e);
      alertStatus(`啟動失敗：${e.message}`);
      showScreen('startScreen');
    }
  }

  /* ── 按鈕事件 ── */
  $('soloBtn').addEventListener('click', async () => {
    mode = 'solo';
    try {
      alertStatus('');
      await ensureCamera(msg => alertStatus(msg));
      await preloadDetector(msg => alertStatus(msg));
      enterBattle();
    } catch (e) { alertStatus(`啟動失敗：${e.message}`); }
  });

  $('hostBtn').addEventListener('click', () => {
    mode = 'host';
    alertStatus('建立房間中…');
    net = new HostNet(getName());
    bindNetEvents();
    net.on('open', code => {
      $('roomCodeText').textContent = code;
      $('lobbyHint').textContent = '把房號唸給朋友輸入加入';
      $('startGameBtn').classList.remove('hidden');
      $('startGameBtn').disabled = true;
      net.sendWeapon(myWeaponId);   // 把主選單選好的武器登記到玩家名單
      if (myEmb) net.sendEmb?.(myEmb);
      enterLobby();
      renderPlayerList(net.players);
    });
  });

  $('joinBtn').addEventListener('click', () => {
    const code = $('roomInput').value.trim();
    if (!/^\d{4}$/.test(code)) { alertStatus('請輸入 4 位數房號'); return; }
    mode = 'client';
    alertStatus('加入房間中…');
    net = new ClientNet(code, getName());
    bindNetEvents();
    net.on('open', () => {
      $('roomCodeText').textContent = code;
      $('lobbyHint').textContent = '等待房主開始遊戲…';
      $('startGameBtn').classList.add('hidden');
      net.sendWeapon(myWeaponId);   // 把主選單選好的武器同步給房主
      if (myEmb) net.sendEmb?.(myEmb);
      enterLobby();
    });
  });

  $('sampleBtn').addEventListener('click', () => {
    const cam = $('lobbyCam');
    const src = cam.videoWidth ? cam : video;
    if (!src.videoWidth) { $('sampleStatus').textContent = '相機還沒就緒'; return; }
    const vw = src.videoWidth, vh = src.videoHeight;
    const r = Math.min(vw, vh) * 0.22;
    const color = sampleRegion(src, vw / 2 - r / 2, vh / 2 - r / 2, r, r);
    if (!color) { $('sampleStatus').textContent = '取樣失敗，再試一次'; return; }
    myColor = color;
    net.sendColor(color);
    const warn = color.s < 0.2 ? '（顏色偏淡，建議穿更鮮豔的衣服）' : '';
    $('sampleStatus').textContent = `✔ 已登錄你的顏色 ${warn}`;
    $('sampleStatus').style.color = hsvToCss(color);
    // 認人：同一時刻取直式（人形比例）區域算嵌入向量並廣播
    if (reid) {
      const w2 = r * 1.2, h2 = Math.min(vh, r * 2.4);
      reid.embedRegion(src, vw / 2 - w2 / 2, Math.max(0, vh / 2 - h2 / 2), w2, h2)
        .then(e => {
          if (!e) return;
          myEmb = Array.from(e);
          net.sendEmb?.(myEmb);
          $('sampleStatus').textContent += '＋特徵';
        })
        .catch(() => {});
    }
  });

  $('startGameBtn').addEventListener('click', () => {
    if (mode === 'host') net.start();
  });

  renderWeaponList();   // 主選單武器列（預設手槍）

  // ?solo=1 → 單機測試專用頁（只留單機按鈕，跟正式對戰頁分開）
  if (new URLSearchParams(location.search).has('solo')) {
    $('hostBtn').style.display = 'none';
    document.querySelector('.join-row').style.display = 'none';
    $('nameInput').style.display = 'none';
    $('soloBtn').textContent = '🎯 開始單機測試';
    $('soloBtn').classList.add('primary');
  }

  // 按住開火鍵 = 全自動連發：第一發即時，之後由 render() 每幀嘗試（tryFire 內以射速冷卻節流）。
  // 連發交給畫面幀，不用獨立 setTimeout → 主線程忙（偵測）時也不會被飢餓，且與冷卻環同步。
  let firing = false;
  function startFire() {
    if (firing) return;
    firing = true;
    $('fireBtn').classList.add('firing');
    tryFire();   // 第一發即時
  }
  function stopFire() {
    firing = false;
    $('fireBtn').classList.remove('firing');
  }
  const fb = $('fireBtn');
  fb.addEventListener('touchstart', e => { e.preventDefault(); startFire(); }, { passive: false });
  fb.addEventListener('touchend', e => { e.preventDefault(); stopFire(); }, { passive: false });
  fb.addEventListener('touchcancel', stopFire);
  fb.addEventListener('mousedown', e => { if (e.button === 0) startFire(); });
  window.addEventListener('mouseup', stopFire);

  // 一開頁面就在背景預載模型（不等使用者按按鈕），大幅縮短進入遊戲的等待
  preloadDetector(msg => alertStatus(msg))
    .then(() => alertStatus('✔ 模型已就緒'))
    .catch(e => { detectorPromise = null; alertStatus(`模型預載失敗（進遊戲時會重試）：${e.message}`); });

  // 從背景切回來：相機可能被系統暫停或收回，恢復它；wake lock 也要重新申請
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    const track = video.srcObject?.getVideoTracks?.()[0];
    if (video.srcObject && (!track || track.readyState === 'ended')) {
      video.srcObject = null;
      try { await openCamera(() => {}); $('lobbyCam').srcObject = video.srcObject; } catch (e) { console.error('[cam-resume]', e); }
    } else {
      video.play().catch(() => {});
    }
    if (running) { try { await navigator.wakeLock?.request('screen'); } catch {} }
  });
})();
