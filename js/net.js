/**
 * net.js — PeerJS 連線層（WebRTC DataChannel）
 *
 * 拓撲：星狀。房主 = hub = 權威伺服器（血量/擊殺/重生的唯一真相來源）。
 * 玩家手機本地判定命中後送 {t:'hit'} 給房主，房主計算扣血並廣播 {t:'state'}。
 *
 * 訊息協定：
 *   client→host : {t:'join', name} {t:'color', color} {t:'hit', victim, part}
 *   host→client : {t:'welcome', pid} {t:'players', players} {t:'start'}
 *                 {t:'state', hp, deadRemain, kills} {t:'kill', killer, victim}
 */

const ROOM_PREFIX = 'pgf-room-';

class NetBase {
  constructor() { this.handlers = {}; this.myPid = null; this.players = []; }
  on(ev, fn) { this.handlers[ev] = fn; return this; }
  emit(ev, ...a) { this.handlers[ev]?.(...a); }
  /** host 的 state 廣播統一轉成本地時間軸的資料形狀 */
  toLocalState(msg) {
    const now = performance.now();
    const deadUntil = {};
    for (const pid in msg.deadRemain) deadUntil[pid] = now + msg.deadRemain[pid];
    return { hp: msg.hp, deadUntil, kills: msg.kills };
  }
}

/* ── 房主 ── */
class HostNet extends NetBase {
  constructor(myName) {
    super();
    this.myPid = 0;
    this.nextPid = 1;
    this.conns = new Map();                    // pid -> DataConnection
    this.players = [{ pid: 0, name: myName, color: null }];
    this.state = { hp: { 0: RULES.maxHp }, deadUntil: {}, kills: { 0: 0 } };
    this.started = false;
    this._open();
  }

  _open() {
    this.roomCode = String(Math.floor(1000 + Math.random() * 9000));
    this.peer = new Peer(ROOM_PREFIX + this.roomCode);
    this.peer.on('open', () => this.emit('open', this.roomCode));
    this.peer.on('error', err => {
      if (err.type === 'unavailable-id') { this.peer.destroy(); this._open(); }  // 房號撞號重抽
      else this.emit('error', err);
    });
    this.peer.on('connection', conn => {
      conn.on('data', d => this._onData(conn, d));
      conn.on('close', () => this._onConnLost(conn));
      conn.on('error', () => this._onConnLost(conn));
    });
  }

  /** 玩家斷線：保留狀態一段時間，等他重連拿回原本的血量/擊殺數 */
  _onConnLost(conn) {
    const pid = conn._pid;
    if (pid == null || this.conns.get(pid) !== conn) return;
    this.conns.delete(pid);
    const p = this.players.find(p => p.pid === pid);
    if (!p) return;
    p.offline = true;
    p._removeTimer = setTimeout(() => this._removePlayer(pid), RULES.ghostKeepMs);
    this._broadcastPlayers();
  }

  _onData(conn, d) {
    switch (d?.t) {
      case 'join': {
        const name = String(d.name || '').slice(0, 12);
        // 同名玩家斷線重連 → 拿回原本的 pid 與狀態
        const existing = this.players.find(p => p.name === name && p.offline);
        if (existing) {
          clearTimeout(existing._removeTimer);
          existing.offline = false;
          conn._pid = existing.pid;
          this.conns.set(existing.pid, conn);
          conn.send({ t: 'welcome', pid: existing.pid });
          if (this.started) conn.send({ t: 'start' });
          this._broadcastPlayers();
          this._broadcastState();
          break;
        }
        const pid = this.nextPid++;
        conn._pid = pid;
        this.conns.set(pid, conn);
        this.players.push({ pid, name: name || `玩家${pid}`, color: null });
        this.state.hp[pid] = RULES.maxHp;
        this.state.kills[pid] = 0;
        conn.send({ t: 'welcome', pid });
        if (this.started) conn.send({ t: 'start' });
        this._broadcastPlayers();
        this._broadcastState();
        break;
      }
      case 'color': {
        const p = this.players.find(p => p.pid === conn._pid);
        if (p && d.color) { p.color = d.color; this._broadcastPlayers(); }
        break;
      }
      case 'hit':
        this.applyHit(conn._pid, d.victim, d.part);
        break;
    }
  }

  _removePlayer(pid) {
    if (pid == null) return;
    this.conns.delete(pid);
    this.players = this.players.filter(p => p.pid !== pid);
    delete this.state.hp[pid]; delete this.state.deadUntil[pid]; delete this.state.kills[pid];
    this._broadcastPlayers();
    this._broadcastState();
  }

  setMyColor(color) { this.players[0].color = color; this._broadcastPlayers(); }

  start() {
    if (this.started) return;
    this.started = true;
    this._respawnTimer = setInterval(() => this._tickRespawn(), 250);
    this._bcast({ t: 'start' });
    this.emit('start');
    this._broadcastState();
  }

  /** 權威扣血：shooter 打中 victim 的 part */
  applyHit(shooter, victim, part) {
    const now = Date.now();
    if (!this.started) return;
    if (!(victim in this.state.hp) || shooter === victim) return;
    if (this._isDead(shooter, now) || this._isDead(victim, now)) return;
    const dmg = RULES.damage[part];
    if (!dmg) return;
    this.state.hp[victim] = Math.max(0, this.state.hp[victim] - dmg);
    if (this.state.hp[victim] === 0) {
      this.state.deadUntil[victim] = now + RULES.respawnMs;
      this.state.kills[shooter] = (this.state.kills[shooter] || 0) + 1;
      const kName = this.players.find(p => p.pid === shooter)?.name ?? '?';
      const vName = this.players.find(p => p.pid === victim)?.name ?? '?';
      this._bcast({ t: 'kill', killer: kName, victim: vName });
      this.emit('kill', kName, vName);
    }
    this._broadcastState();
  }

  /** 房主自己開槍 */
  sendHit(victim, part) { this.applyHit(0, victim, part); }
  sendColor(color) { this.setMyColor(color); }

  _isDead(pid, now) { return (this.state.deadUntil[pid] || 0) > now; }

  _tickRespawn() {
    const now = Date.now();
    let changed = false;
    for (const pid of Object.keys(this.state.deadUntil)) {
      if (this.state.deadUntil[pid] <= now) {
        delete this.state.deadUntil[pid];
        this.state.hp[pid] = RULES.maxHp;
        changed = true;
      }
    }
    if (changed) this._broadcastState();
  }

  _broadcastPlayers() {
    const pub = this.players.map(({ pid, name, color, offline }) => ({ pid, name, color, offline: !!offline }));
    this._bcast({ t: 'players', players: pub });
    this.emit('players', pub);
  }

  _broadcastState() {
    const now = Date.now();
    const deadRemain = {};
    for (const pid in this.state.deadUntil) deadRemain[pid] = this.state.deadUntil[pid] - now;
    const msg = { t: 'state', hp: { ...this.state.hp }, deadRemain, kills: { ...this.state.kills } };
    this._bcast(msg);
    this.emit('state', this.toLocalState(msg));
  }

  _bcast(msg) { for (const c of this.conns.values()) if (c.open) c.send(msg); }

  destroy() { clearInterval(this._respawnTimer); this.peer?.destroy(); }
}

/* ── 加入的玩家 ── */
class ClientNet extends NetBase {
  constructor(roomCode, myName) {
    super();
    this.roomCode = roomCode.trim();
    this.myName = myName;
    this._welcomed = false;
    this._rejoinAttempts = 0;
    this.peer = new Peer();
    this.peer.on('error', err => {
      if (err.type === 'peer-unavailable') {
        // 首次加入找不到房間 → 報錯；重連中找不到 → 繼續重試
        if (!this._welcomed) this.emit('error', new Error('找不到這個房間號碼'));
        else this._scheduleRejoin();
      } else if (!this._welcomed) {
        this.emit('error', new Error(`連線錯誤：${err.type}`));
      }
    });
    this.peer.on('disconnected', () => { try { this.peer.reconnect(); } catch {} });
    this.peer.on('open', () => this._connect());
  }

  _connect() {
    this.conn = this.peer.connect(ROOM_PREFIX + this.roomCode, { reliable: true });
    this.conn.on('open', () => this.conn.send({ t: 'join', name: this.myName }));
    this.conn.on('data', d => this._onData(d));
    this.conn.on('close', () => this._onLost());
    this.conn.on('error', () => this._onLost());
  }

  /** 斷線（鎖屏/切出 App 常見）→ 自動重連，房主端會還原我的狀態 */
  _onLost() {
    if (this._destroyed) return;
    if (!this._welcomed) { this.emit('error', new Error('與房主斷線')); return; }
    this.emit('offline');
    this._scheduleRejoin();
  }

  _scheduleRejoin() {
    if (this._destroyed || this._rejoinTimer) return;
    if (++this._rejoinAttempts > 30) { this.emit('error', new Error('與房主斷線，重連失敗')); return; }
    this._rejoinTimer = setTimeout(() => {
      this._rejoinTimer = null;
      if (this.peer.destroyed) return;
      if (this.peer.disconnected) { try { this.peer.reconnect(); } catch {} }
      this._connect();
    }, 2000);
  }

  _onData(d) {
    switch (d?.t) {
      case 'welcome': {
        const first = !this._welcomed;
        this._welcomed = true;
        this._rejoinAttempts = 0;
        this.myPid = d.pid;
        this.emit(first ? 'open' : 'rejoined', null);
        break;
      }
      case 'players': this.players = d.players; this.emit('players', d.players); break;
      case 'start': this.emit('start'); break;
      case 'state': this.emit('state', this.toLocalState(d)); break;
      case 'kill': this.emit('kill', d.killer, d.victim); break;
    }
  }

  sendColor(color) { if (this.conn?.open) this.conn.send({ t: 'color', color }); }
  sendHit(victim, part) { if (this.conn?.open) this.conn.send({ t: 'hit', victim, part }); }
  destroy() { this._destroyed = true; clearTimeout(this._rejoinTimer); this.peer?.destroy(); }
}
