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
      conn.on('close', () => this._removePlayer(conn._pid));
    });
  }

  _onData(conn, d) {
    switch (d?.t) {
      case 'join': {
        const pid = this.nextPid++;
        conn._pid = pid;
        this.conns.set(pid, conn);
        this.players.push({ pid, name: String(d.name || `玩家${pid}`).slice(0, 12), color: null });
        this.state.hp[pid] = RULES.maxHp;
        this.state.kills[pid] = 0;
        conn.send({ t: 'welcome', pid });
        this._broadcastPlayers();
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
    const pub = this.players.map(({ pid, name, color }) => ({ pid, name, color }));
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
    this.peer = new Peer();
    this.peer.on('error', err => {
      const msg = err.type === 'peer-unavailable' ? '找不到這個房間號碼' : `連線錯誤：${err.type}`;
      this.emit('error', new Error(msg));
    });
    this.peer.on('open', () => {
      this.conn = this.peer.connect(ROOM_PREFIX + roomCode.trim(), { reliable: true });
      this.conn.on('open', () => this.conn.send({ t: 'join', name: myName }));
      this.conn.on('data', d => this._onData(d));
      this.conn.on('close', () => this.emit('error', new Error('與房主斷線')));
    });
  }

  _onData(d) {
    switch (d?.t) {
      case 'welcome': this.myPid = d.pid; this.emit('open', null); break;
      case 'players': this.players = d.players; this.emit('players', d.players); break;
      case 'start': this.emit('start'); break;
      case 'state': this.emit('state', this.toLocalState(d)); break;
      case 'kill': this.emit('kill', d.killer, d.victim); break;
    }
  }

  sendColor(color) { if (this.conn?.open) this.conn.send({ t: 'color', color }); }
  sendHit(victim, part) { if (this.conn?.open) this.conn.send({ t: 'hit', victim, part }); }
  destroy() { this.peer?.destroy(); }
}
