/**
 * game.js — 遊戲規則與狀態（試作版：單機，所有被偵測到的人都是「靶」）
 *
 * 連線版時，這裡的 TargetRegistry 會改成由房主廣播的權威狀態驅動；
 * takeDamage() 改為送出封包，本地只做預測顯示。
 */

const RULES = {
  maxHp: 100,
  damage: { hit: 5, head: 50, torso: 25 },   // hit=剪影命中（方向C，每發 5 傷害）
  fireCooldownMs: 100,    // 射速：0.1 秒/發（全自動連發，免換彈）
  respawnMs: 5000,        // 擊倒後 5 秒重生
  targetForgetMs: 4000,   // 追蹤 ID 消失多久後遺忘該靶
  ghostKeepMs: 60000,     // 遺忘後血量以顏色檔案保留多久（出鏡再回來不回滿血）
};

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

  /** 對目標造成傷害。回傳 {hp, killed, personId} */
  takeDamage(trackId, part, now) {
    const p = this._person(trackId);
    if (!p || (p.deadUntil && now < p.deadUntil)) return null;
    p.hp = Math.max(0, p.hp - RULES.damage[part]);
    let killed = false;
    if (p.hp === 0) {
      p.deadUntil = now + RULES.respawnMs;
      killed = true;
    }
    return { hp: p.hp, killed, personId: p.id };
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
