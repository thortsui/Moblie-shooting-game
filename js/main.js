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

  let mode = 'solo';           // 'solo' | 'host' | 'client'
  let net = null;              // HostNet / ClientNet
  let netState = null;         // {hp, deadUntil, kills}（本地時間軸）
  let prevMyHp = RULES.maxHp;
  let myColor = null;
  let soloKills = 0;

  const registry = new TargetRegistry();   // solo 模式用
  const fireCtl = new FireControl();
  const sfx = new Sfx();

  let detector = null, detectorPromise = null;
  let poses = [];
  let mirrored = false;
  let running = false;

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
    // 強化畫質：優先 2K 高解析度（清晰、利於顏色/特徵辨識），偵測仍縮到 192 不影響速度；失敗逐層降級
    const UHD = { width: { ideal: 2560 }, height: { ideal: 1440 }, frameRate: { ideal: 60 } };
    const HI = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } };
    const candidates = [
      { facingMode: { exact: 'environment' }, ...UHD },
      { facingMode: { exact: 'environment' }, ...HI },
      { facingMode: 'environment', ...HI },
      { ...UHD },
      { ...HI },
      { width: { ideal: 1280 }, height: { ideal: 720 } },
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
    if (!detectorPromise) detectorPromise = createSegDetector(onStatus || (() => {}));
    return detectorPromise;
  }

  function resizeOverlay() {
    overlay.width = window.innerWidth * devicePixelRatio;
    overlay.height = window.innerHeight * devicePixelRatio;
    overlay.style.width = window.innerWidth + 'px';
    overlay.style.height = window.innerHeight + 'px';
  }
  window.addEventListener('resize', resizeOverlay);

  /* ── 偵測迴圈 ── */
  let fpsCount = 0, fpsLast = performance.now(), detErrors = 0;
  async function detectLoop() {
    while (running) {
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
          // 顏色識別：這個人是哪個玩家
          for (const det of result) {
            det.pid = classifyPlayer(segColorSample(video, det), net.players, net.myPid);
          }
        }
        poses = result;
      } catch (e) {
        console.error('[detect]', e);
        detErrors++;
      }
      fpsCount++;
      const now = performance.now();
      if (now - fpsLast >= 1000) {
        $('fpsText').textContent = fpsCount;
        fpsCount = 0; fpsLast = now;
      }
      await new Promise(r => setTimeout(r, 0));
    }
  }

  /* ── 渲染迴圈 ── */
  function render() {
    if (!running) return;
    const now = performance.now();
    const t = coverTransform();
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    for (const pose of poses) drawTarget(pose, t, now);
    drawEffects(now);
    updateFireRing(now);
    updateSelfStatus(now);
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

    const topMid = toScreen((bounds.minX + bounds.maxX) / 2, bounds.minY, t);
    const barW = Math.max(70 * devicePixelRatio, (bounds.maxX - bounds.minX) * t.scale * 0.6);
    const barH = 10 * devicePixelRatio;
    const bx = topMid.x - barW / 2;
    const by = topMid.y - barH - 14 * devicePixelRatio;

    if (!info.registered) {
      // 未登錄的人：只標示問號，不能打
      ctx.font = `${14 * devicePixelRatio}px system-ui`;
      ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(255,255,255,.55)';
      ctx.shadowColor = '#000'; ctx.shadowBlur = 4;
      ctx.fillText('未登錄', topMid.x, by + barH);
      ctx.shadowBlur = 0;
      return;
    }

    if (dead) {
      const secs = Math.ceil(info.deadRemainMs / 1000);
      ctx.font = `${16 * devicePixelRatio}px system-ui`;
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
    ctx.lineWidth = 1.5 * devicePixelRatio;
    roundRect(bx, by, barW, barH, barH / 2); ctx.stroke();
    ctx.font = `${11 * devicePixelRatio}px system-ui`;
    ctx.textAlign = 'center'; ctx.fillStyle = '#fff';
    ctx.shadowColor = '#000'; ctx.shadowBlur = 4;
    ctx.fillText(`${info.label} · ${info.hp}`, topMid.x, by - 4 * devicePixelRatio);
    ctx.shadowBlur = 0;
  }

  /** 畫人物剪影：遮罩畫進離屏 canvas，再平滑縮放貼到螢幕（避免一格格方塊過度覆蓋） */
  const _maskCv = document.createElement('canvas');
  const _maskCtx = _maskCv.getContext('2d');
  function drawMask(det, t, rgba) {
    if (!det.mask) return;
    const tf = det._tf;
    if (_maskCv.width !== det.mw) { _maskCv.width = det.mw; _maskCv.height = det.mh; }
    const img = _maskCtx.createImageData(det.mw, det.mh);
    const [r, g, b, a] = rgba;
    for (let i = 0; i < det.mask.length; i++) {
      if (det.mask[i]) { img.data[i*4] = r; img.data[i*4+1] = g; img.data[i*4+2] = b; img.data[i*4+3] = a; }
    }
    _maskCtx.putImageData(img, 0, 0);
    // proto→螢幕 為線性映射；計算整個遮罩網格貼到螢幕的位置與尺寸
    const cellW = t.scale / (tf.mxScale * tf.scale);
    const cellH = t.scale / (tf.myScale * tf.scale);
    const originX = -tf.padX / tf.scale * t.scale + t.offX;
    const originY = -tf.padY / tf.scale * t.scale + t.offY;
    ctx.save();
    if (mirrored) { ctx.translate(overlay.width, 0); ctx.scale(-1, 1); }
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(_maskCv, 0, 0, det.mw, det.mh, originX, originY, cellW * det.mw, cellH * det.mh);
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

  /* ── 開火特效 ── */
  const effects = [];
  function drawEffects(now) {
    for (let i = effects.length - 1; i >= 0; i--) {
      const fx = effects[i];
      const p = (now - fx.t0) / fx.dur;
      if (p >= 1) { effects.splice(i, 1); continue; }
      const cx = overlay.width / 2, cy = overlay.height / 2;
      const sx = cx, sy = overlay.height * 0.66;   // 由槍口射出
      ctx.save();
      ctx.globalAlpha = (1 - p) * 0.9;
      const grad = ctx.createLinearGradient(sx, sy, cx, cy);
      grad.addColorStop(0, 'rgba(255,210,90,1)');
      grad.addColorStop(1, 'rgba(255,255,255,.2)');
      ctx.strokeStyle = grad;
      ctx.lineWidth = (4 - 3 * p) * devicePixelRatio;
      ctx.shadowColor = 'rgba(255,180,60,.9)';
      ctx.shadowBlur = 12 * devicePixelRatio;
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(cx, cy); ctx.stroke();
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
    sfx.shot();
    navigator.vibrate?.(20);   // 每發輕微震動（iOS Safari 不支援，Android 有效）
    effects.push({ t0: now, dur: 90 });
    flashClass($('muzzleFlash'), 'show');
    flashClass($('gunOverlay'), 'recoil');
    flashClass($('gameScreen'), 'shake');

    const t = coverTransform();
    const aim = screenCenterToVideo(t);

    // 找被打中的目標：十字標中心點落在剪影內即命中（最靠近中心者優先）
    let best = null;
    for (const det of poses) {
      const info = targetInfo(det, now);
      if (!info?.registered || info.dead) continue;
      if (!segHitTest(det, aim.x, aim.y)) continue;
      const b = det.bbox;
      const d = Math.hypot(aim.x - (b.minX + b.maxX) / 2, aim.y - (b.minY + b.maxY) / 2);
      if (!best || d < best.d) best = { det, d };
    }
    if (!best) return;

    if (mode === 'solo') {
      const result = registry.takeDamage(best.det.id, 'hit', now);
      if (!result) return;
      hitFeedback(result.killed, `P${result.personId}`);
      if (result.killed) { soloKills++; $('killsText').textContent = soloKills; }
    } else {
      net.sendHit(best.det.pid, 'hit');               // 房主權威判定
      const name = net.players.find(p => p.pid === best.det.pid)?.name ?? '';
      hitFeedback(false, name);                       // 樂觀回饋（擊倒訊息等房主廣播）
    }
  }

  function hitFeedback(killed, name) {
    sfx.hit(false);
    navigator.vibrate?.(60);
    flashClass($('hitMarker'), 'show');
    if (killed) { sfx.kill(); showHitText(`💀 擊倒 ${name}！`); }
    else showHitText(`-${RULES.damage.hit}`);
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

  // 全自動連發（0.1 秒/發）不需要冷卻環顯示
  function updateFireRing() {}

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
      const ready = document.createElement('span');
      if (p.offline) { ready.className = 'not-ready'; ready.textContent = '📴 斷線中'; }
      else { ready.className = p.color ? 'ready' : 'not-ready'; ready.textContent = p.color ? '✔ 已登錄' : '未取樣'; }
      row.append(chip, name, ready);
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
  });

  $('startGameBtn').addEventListener('click', () => {
    if (mode === 'host') net.start();
  });

  // ?solo=1 → 單機測試專用頁（只留單機按鈕，跟正式對戰頁分開）
  if (new URLSearchParams(location.search).has('solo')) {
    $('hostBtn').style.display = 'none';
    document.querySelector('.join-row').style.display = 'none';
    $('nameInput').style.display = 'none';
    $('soloBtn').textContent = '🎯 開始單機測試';
    $('soloBtn').classList.add('primary');
  }

  // 按住開火鍵 = 全自動連發（tryFire 內以射速冷卻節流）
  let firing = false, fireTimer = null;
  function startFire() {
    if (firing) return;
    firing = true;
    $('fireBtn').classList.add('firing');
    const loop = () => { if (!firing) return; tryFire(); fireTimer = setTimeout(loop, 20); };
    loop();
  }
  function stopFire() {
    firing = false;
    clearTimeout(fireTimer);
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
