/**
 * game.js — 遊戲規則與狀態（試作版：單機，所有被偵測到的人都是「靶」）
 *
 * 連線版時，這裡的 TargetRegistry 會改成由房主廣播的權威狀態驅動；
 * takeDamage() 改為送出封包，本地只做預測顯示。
 */

const RULES = {
  maxHp: 100,
  damage: { hit: 5, head: 50, torso: 25 },   // hit=剪影命中（舊版相容用；實際傷害看所選武器）
  fireCooldownMs: 100,    // 舊版預設射速（FireControl 建構子預設值；實際射速看所選武器）
  respawnMs: 5000,        // 擊倒後 5 秒重生
  targetForgetMs: 4000,   // 追蹤 ID 消失多久後遺忘該靶
  ghostKeepMs: 60000,     // 遺忘後血量以顏色檔案保留多久（出鏡再回來不回滿血）
};

/** 武器表（開戰前選定，遊戲中不可換）。
    body=剪影命中傷害（現行只判剪影內外，一律吃 body）；
    head 保留給未來部位判定用；cooldownMs=每發冷卻。 */
const WEAPONS = [
  { id: 'pistol',  name: '手槍',   body: 25, head: 50,  cooldownMs: 700,
    note: '預設均衡槍：四槍中身、兩槍爆頭，0.7 秒一發穩定好上手。' },
  { id: 'rifle',   name: '步槍',   body: 34, head: 68,  cooldownMs: 850,
    note: '沉穩主力：三槍中身即倒（1.7 秒），節奏沉穩火力足。' },
  { id: 'smg',     name: '衝鋒槍', body: 12, head: 20,  cooldownMs: 320,
    note: '潑水流：射速最快、單發最輕，打不太準也能靠連發補回來。' },
  { id: 'shotgun', name: '散彈槍', body: 40, head: 60,  cooldownMs: 1050,
    note: '近身重擊：單發軀幹傷害僅次於狙擊，但爆頭加成最小。' },
  { id: 'sniper',  name: '狙擊槍', body: 70, head: 100, cooldownMs: 1750,
    note: '一發爆頭直接帶走、中身兩發，1.75 秒一發。' },
  { id: 'rocket',  name: '火箭筒', body: 90, head: 100, cooldownMs: 2450,
    note: '一發近乎帶走且爆風有容錯範圍，2.45 秒一發、彈頭有飛行時間。' },
];

/** 各武器的射擊特效參數（曳光/散彈扇/光束/火箭），main.js drawEffects 依此繪製 */
const WEAPON_FX = {
  pistol:  { type: 'tracer',  dur: 90,  width: 4,   color: '255,210,90' },
  rifle:   { type: 'tracer',  dur: 110, width: 5,   color: '255,180,60' },
  smg:     { type: 'tracer',  dur: 70,  width: 3,   color: '255,230,120' },
  shotgun: { type: 'pellets', dur: 140, pellets: 7, spread: 0.10, color: '255,190,80' },
  sniper:  { type: 'beam',    dur: 240, width: 3,   color: '160,220,255' },
  rocket:  { type: 'rocket',  travelMs: 260, blastDur: 320, blastRadiusFrac: 0.07, color: '255,140,50' },
};
const DEFAULT_WEAPON_ID = 'pistol';

/** 以 id 取武器；未知 id（含舊版沒送）回傳 null */
function weaponById(id) { return WEAPONS.find(w => w.id === id) || null; }

/** 場上目標的「人物檔案」登記表。
    每個被掃描到的人建立一個專屬 ID（P1、P2…整場不變）；
    偵測器的追蹤 ID 只是暫時代號，透過「位置接續 + 衣服顏色」映射回同一個人物檔案，
    解決追蹤器頻繁掉鎖造成 ID 一直變、血條被重置打不完的問題。 */
class TargetRegistry {
  constructor() {
    this.persons = new Map();    // personId -> {id, color, hp, deadUntil, lastSeen, lastPos, lastSize}
    this.trackMap = new Map();   // 偵測追蹤 ID -> {personId, lastSeen}
    this.nextPersonId = 1;
  }

  /** 每影格呼叫。colorOf(pose) 回傳軀幹顏色；posOf(pose) 回傳 {x, y, size}（可省略） */
  sync(poses, now, colorOf, posOf) {
    // 本影格已被綁定的人物（防止兩個偵測框搶同一個檔案）
    const bound = new Set();
    for (const pose of poses) {
      const tm = this.trackMap.get(pose.id);
      if (tm) bound.add(tm.personId);
    }

    for (const pose of poses) {
      let tm = this.trackMap.get(pose.id);
      const color = colorOf?.(pose) || null;
      const pos = posOf?.(pose) || null;

      if (!tm) {
        let person = null;
        // 1) 位置接續：剛消失（<1.5 秒）且位置幾乎重疊的人 → 追蹤器掉鎖，是同一個人
        if (pos) {
          let bestD = Infinity;
          for (const p of this.persons.values()) {
            if (bound.has(p.id) || !p.lastPos) continue;
            if (now - p.lastSeen > 1500) continue;
            const d = Math.hypot(pos.x - p.lastPos.x, pos.y - p.lastPos.y);
            const limit = Math.max(60, (p.lastSize || 100) * 0.7);
            if (d < limit && d < bestD) { bestD = d; person = p; }
          }
        }
        // 2) 顏色比對：出鏡較久後回來的人
        if (!person && color) {
          for (const p of this.persons.values()) {
            if (bound.has(p.id) || !p.color) continue;
            if (colorDistance(p.color, color) < 0.5) { person = p; break; }
          }
        }
        // 3) 都沒有 → 新人物，發專屬 ID
        if (!person) {
          person = { id: this.nextPersonId++, color, hp: RULES.maxHp, deadUntil: 0, lastSeen: now };
          this.persons.set(person.id, person);
        }
        tm = { personId: person.id };
        this.trackMap.set(pose.id, tm);
        bound.add(person.id);
      }
      tm.lastSeen = now;

      const person = this.persons.get(tm.personId);
      person.lastSeen = now;
      if (pos) { person.lastPos = { x: pos.x, y: pos.y }; person.lastSize = pos.size; }
      // 顏色檔案緩慢更新，適應光線漸變。
      // 只在高信心（取樣色與檔案夠近）時才寫入——邊緣案例只讀不寫，
      // 避免認錯人時互相污染檔案造成「越錯越錯」的身分互換。
      if (color) {
        if (!person.color) {
          person.color = color;
        } else if (colorDistance(person.color, color) < 0.35) {
          person.color = {
            h: lerpHue(person.color.h, color.h, 0.15),
            s: person.color.s + (color.s - person.color.s) * 0.15,
            v: person.color.v + (color.v - person.color.v) * 0.15,
          };
        }
      }
      // 重生
      if (person.deadUntil && now >= person.deadUntil) {
        person.deadUntil = 0;
        person.hp = RULES.maxHp;
      }
    }

    // 清理過期的追蹤映射（人物檔案保留整場，專屬 ID 不回收）
    for (const [tid, tm] of this.trackMap) {
      if (now - tm.lastSeen > RULES.targetForgetMs) this.trackMap.delete(tid);
    }
  }

  _person(trackId) {
    const tm = this.trackMap.get(trackId);
    return tm ? this.persons.get(tm.personId) : null;
  }

  /** 以偵測追蹤 ID 取人物檔案（含專屬 id、hp、deadUntil） */
  get(trackId) { return this._person(trackId); }

  isDead(trackId, now) {
    const p = this._person(trackId);
    return !!(p && p.deadUntil && now < p.deadUntil);
  }

  /** 對目標造成傷害。dmg 未給時退回 RULES.damage[part]（舊版行為）。回傳 {hp, killed, personId} */
  takeDamage(trackId, part, now, dmg) {
    const p = this._person(trackId);
    if (!p || (p.deadUntil && now < p.deadUntil)) return null;
    p.hp = Math.max(0, p.hp - (dmg ?? RULES.damage[part]));
    let killed = false;
    if (p.hp === 0) {
      p.deadUntil = now + RULES.respawnMs;
      killed = true;
    }
    return { hp: p.hp, killed, personId: p.id };
  }
}

/** 開火冷卻控制（冷卻毫秒數可依所選武器調整） */
class FireControl {
  constructor(cooldownMs = RULES.fireCooldownMs) {
    this.lastFire = -Infinity;
    this.cooldownMs = cooldownMs;
  }
  canFire(now) { return now - this.lastFire >= this.cooldownMs; }
  fire(now) { this.lastFire = now; }
  /** 冷卻進度 0(剛開完槍)~1(可再開火) */
  progress(now) {
    return Math.min(1, (now - this.lastFire) / this.cooldownMs);
  }
}

/* ── 音效：WebAudio 直接合成，不需音檔 ── */
class Sfx {
  constructor() { this.ctx = null; }
  ensure() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }
  /** 槍聲：各武器參數化合成（噪音爆 + 低通塑形；重槍加低頻 thump、火箭是發射 whoosh） */
  shot(weaponId) {
    this.ensure();
    const P = {
      pistol:  { dur: 0.12, gain: 0.50, lp: 8000, decay: 2.5 },
      rifle:   { dur: 0.16, gain: 0.60, lp: 6000, decay: 2.2, thump: 120 },
      smg:     { dur: 0.07, gain: 0.35, lp: 9500, decay: 3.0 },
      shotgun: { dur: 0.30, gain: 0.85, lp: 2600, decay: 1.8, thump: 90 },
      sniper:  { dur: 0.28, gain: 0.80, lp: 5200, decay: 2.0, thump: 70 },
      rocket:  { dur: 0.35, gain: 0.60, lp: 1400, decay: 1.2, whoosh: true },
    }[weaponId] || { dur: 0.12, gain: 0.5, lp: 8000, decay: 2.5 };
    const ctx = this.ctx, t = ctx.currentTime;
    const buf = ctx.createBuffer(1, Math.max(1, ctx.sampleRate * P.dur), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, P.decay);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass';
    f.frequency.setValueAtTime(P.lp, t);
    if (P.whoosh) f.frequency.exponentialRampToValueAtTime(4000, t + P.dur);  // 發射尾音上揚
    const g = ctx.createGain(); g.gain.setValueAtTime(P.gain, t);
    src.connect(f).connect(g).connect(ctx.destination); src.start(t);
    if (P.thump) {   // 重槍低頻 thump
      const o = ctx.createOscillator(), og = ctx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(P.thump, t);
      o.frequency.exponentialRampToValueAtTime(40, t + 0.18);
      og.gain.setValueAtTime(0.5, t);
      og.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
      o.connect(og).connect(ctx.destination); o.start(t); o.stop(t + 0.22);
    }
  }
  /** 火箭爆炸：低頻悶爆 + 下墜音 */
  explosion() {
    this.ensure();
    const ctx = this.ctx, t = ctx.currentTime;
    const len = 0.55, buf = ctx.createBuffer(1, ctx.sampleRate * len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 1.6);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(900, t);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.9, t);
    src.connect(f).connect(g).connect(ctx.destination); src.start(t);
    const o = ctx.createOscillator(), og = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(130, t);
    o.frequency.exponentialRampToValueAtTime(35, t + 0.4);
    og.gain.setValueAtTime(0.6, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    o.connect(og).connect(ctx.destination); o.start(t); o.stop(t + 0.5);
  }
  /** 命中：短 ding；爆頭音調更高 */
  hit(headshot) {
    this.ensure();
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'square';
    o.frequency.setValueAtTime(headshot ? 1400 : 900, t);
    g.gain.setValueAtTime(0.25, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
    o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 0.15);
  }
  /** 擊倒：下滑音 */
  kill() {
    this.ensure();
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(600, t);
    o.frequency.exponentialRampToValueAtTime(120, t + 0.4);
    g.gain.setValueAtTime(0.3, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 0.4);
  }
}
