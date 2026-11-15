// Thin WebSocket client for the game server.
export class Net {
  constructor() { this.ws = null; this.h = {}; this.id = null; this.connected = false; this.pingMs = 0; this._pt = null; }

  on(type, fn) { (this.h[type] = this.h[type] || []).push(fn); return this; }
  _emit(type, m) { for (const f of this.h[type] || []) { try { f(m); } catch (e) { console.error('net handler', type, e); } } }

  connect() {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      let ws;
      try { ws = this.ws = new WebSocket(`${proto}://${location.host}`); } catch (e) { reject(e); return; }
      let opened = false;
      ws.onopen = () => {
        opened = true; this.connected = true;
        clearInterval(this._pt);
        this._pt = setInterval(() => this.send({ t: 'ping', c: performance.now() }), 4000);
      };
      ws.onmessage = (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        if (m.t === 'welcome') { this.id = m.id; resolve(m); }
        if (m.t === 'pong') this.pingMs = Math.round(performance.now() - m.c);
        this._emit(m.t, m); this._emit('*', m);
      };
      ws.onclose = () => { this.connected = false; clearInterval(this._pt); this._emit('close', {}); if (!opened) reject(new Error('Could not reach server')); };
      ws.onerror = () => { if (!opened) reject(new Error('Could not reach server')); };
    });
  }

  send(o) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); }
  close() { try { this.ws && this.ws.close(); } catch {} this.connected = false; this.id = null; }
}
