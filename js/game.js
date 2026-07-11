/**
 * game.js — 遊戲規則與狀態（試作版：單機，所有被偵測到的人都是「靶」）
 *
 * 連線版時，這裡的 TargetRegistry 會改成由房主廣播的權威狀態驅動；
 * takeDamage() 改為送出封包，本地只做預測顯示。
 */

const RULES = {
  maxHp: 100,
  damage: { head: 50, torso: 25 },
  fireCooldownMs: 1000,   // 每槍 1 秒冷卻
  respawnMs: 5000,        // 擊倒後 5 秒重生
  targetForgetMs: 4000,   // 追蹤 ID 消失多久後遺忘該靶
  ghostKeepMs: 60000,     // 遺忘後血量以顏色檔案保留多久（出鏡再回來不回滿血）
};

/** 場上目標（被鏡頭看到的人）的血量登記表，以追蹤 ID 為鍵。
    追蹤 ID 消失時把血量連同衣服顏色存成「幽靈檔案」，
    新 ID 出現時比對顏色繼承血量 → 出鏡再回來不會回滿血。 */
class TargetRegistry {
  constructor() { this.targets = new Map(); this.ghosts = []; }

  /** 每影格呼叫。colorOf(pose) 回傳該姿態的軀幹顏色（可省略） */
  sync(poses, now, colorOf) {
    for (const pose of poses) {
      let t = this.targets.get(pose.id);
      const color = colorOf?.(pose) || null;
      if (!t) {
        // 先找顏色相近的幽靈檔案繼承血量
        let inherited = null;
        if (color && typeof colorDistance === 'function') {
          const idx = this.ghosts.findIndex(g => colorDistance(g.color, color) < 0.5);
          if (idx >= 0) inherited = this.ghosts.splice(idx, 1)[0];
        }
        t = inherited
          ? { id: pose.id, hp: inherited.hp, deadUntil: inherited.deadUntil, lastSeen: now }
          : { id: pose.id, hp: RULES.maxHp, deadUntil: 0, lastSeen: now };
        this.targets.set(pose.id, t);
      }
      if (color) t.color = color;   // 持續更新顏色檔案
      t.lastSeen = now;
      // 重生
      if (t.deadUntil && now >= t.deadUntil) {
        t.deadUntil = 0;
        t.hp = RULES.maxHp;
      }
    }
    // 遺忘太久沒出現的 ID → 轉存幽靈檔案
    for (const [id, t] of this.targets) {
      if (now - t.lastSeen > RULES.targetForgetMs) {
        this.targets.delete(id);
        if (t.color && t.hp < RULES.maxHp) {
          this.ghosts.push({ color: t.color, hp: t.hp, deadUntil: t.deadUntil, expire: now + RULES.ghostKeepMs });
        }
      }
    }
    this.ghosts = this.ghosts.filter(g => g.expire > now);
  }

  get(id) { return this.targets.get(id); }

  isDead(id, now) {
    const t = this.targets.get(id);
    return !!(t && t.deadUntil && now < t.deadUntil);
  }

  /** 對目標造成傷害。回傳 {hp, killed} */
  takeDamage(id, part, now) {
    const t = this.targets.get(id);
    if (!t || (t.deadUntil && now < t.deadUntil)) return null;
    t.hp = Math.max(0, t.hp - RULES.damage[part]);
    let killed = false;
    if (t.hp === 0) {
      t.deadUntil = now + RULES.respawnMs;
      killed = true;
    }
    return { hp: t.hp, killed };
  }
}

/** 開火冷卻控制 */
class FireControl {
  constructor() { this.lastFire = -Infinity; }
  canFire(now) { return now - this.lastFire >= RULES.fireCooldownMs; }
  fire(now) { this.lastFire = now; }
  /** 冷卻進度 0(剛開完槍)~1(可再開火) */
  progress(now) {
    return Math.min(1, (now - this.lastFire) / RULES.fireCooldownMs);
  }
}

/* ── 音效：WebAudio 直接合成，不需音檔 ── */
class Sfx {
  constructor() { this.ctx = null; }
  ensure() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }
  /** 槍聲：短促噪音爆 */
  shot() {
    this.ensure();
    const ctx = this.ctx, t = ctx.currentTime;
    const len = 0.12, buf = ctx.createBuffer(1, ctx.sampleRate * len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2.5);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.5, t);
    src.connect(g).connect(ctx.destination); src.start(t);
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
