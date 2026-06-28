/**
 * Apinator Client — single-file browser build
 * Combines: connection.ts · channel.ts · auth.ts · index.ts
 * Fixes applied: #1 activity timer reset · #2 reconnectAttempts timing
 *                #3 unavailable recovery · #4 split pong timer
 *                #5 stale socketId · #6 form-encoded auth
 *
 * Usage (ES module):
 *   import { Apinator } from './apinator-client.js';
 *
 * Usage (script tag):
 *   <script type="module" src="./client.js"></script>
 *   const client = new window.Apinator({ ... });
 *  -------------------------------------------------
 *  <script type="module">
 *  import { Apinator } from './apinator-client.js';
 *      const APP_KEY = 'app_xxxx';
 *      const CLUSTER = 'us';
 *      const client = new Apinator({ appKey: APP_KEY, cluster: CLUSTER });
 *  </script>
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const UNAVAILABLE_RETRY_DELAY = 60_000; // ms before retrying after 6 failed attempts
const PONG_TIMEOUT            = 30_000; // ms to wait for pong before closing

// ─── Connection ───────────────────────────────────────────────────────────────

class Connection {
  #ws               = null;
  #state            = 'initialized';
  #options;
  #onMessage;
  #onStateChange;
  #reconnectAttempts = 0;
  #reconnectTimer   = null;
  // [FIX 4] Two separate timers instead of one shared variable
  #activityTimer    = null; // fires after silence → sends ping
  #pongTimer        = null; // fires after ping → closes if no reply
  // [FIX 1] Stored so every incoming message can reset the timer
  #activityTimeout  = 120;
  #socketId         = null;

  constructor(options, onMessage, onStateChange) {
    this.#options       = options;
    this.#onMessage     = onMessage;
    this.#onStateChange = onStateChange;
  }

  get id()           { return this.#socketId; }
  get currentState() { return this.#state; }

  #resolveWSHost() {
    return `wss://ws-${this.#options.cluster}.apinator.io`;
  }

  connect() {
    if (this.#state === 'connected' || this.#state === 'connecting') return;
    this.#setState('connecting');

    const url = `${this.#resolveWSHost()}/app/${this.#options.appKey}` +
                `?protocol=7&client=js&version=1.0.0`;

    try {
      this.#ws = new WebSocket(url);
    } catch {
      this.#handleDisconnect();
      return;
    }

    // [FIX 2] Removed reconnectAttempts = 0 from here.
    // onopen fires when the TCP/WS handshake completes, NOT when the server
    // confirms the session via connection_established. Resetting early meant
    // the exponential backoff was bypassed when the server kept accepting
    // WebSocket connections but never sent connection_established.
    this.#ws.onopen = () => {};

    this.#ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return; // ignore malformed frames
      }
      this.#handleMessage(msg);
    };

    this.#ws.onclose = () => this.#handleDisconnect();
    this.#ws.onerror = () => {}; // onclose always fires after onerror
  }

  disconnect() {
    this.#clearTimers();
    this.#setState('disconnected');
    if (this.#ws) {
      this.#ws.close(1000, 'client disconnect');
      this.#ws = null;
    }
  }

  send(msg) {
    if (this.#ws && this.#ws.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify(msg));
    }
  }

  #handleMessage(msg) {
    if (msg.event === 'realtime:connection_established') {
      const data = JSON.parse(msg.data);
      this.#socketId        = data.socket_id;
      this.#activityTimeout = data.activity_timeout || 120;
      // [FIX 2] Reset attempt counter here — server confirmed the session.
      this.#reconnectAttempts = 0;
      this.#setState('connected');
      this.#resetActivityTimer();
      this.#onMessage(msg);
      return;
    }

    if (msg.event === 'realtime:error') {
      const data = JSON.parse(msg.data);
      if (data.code >= 4000 && data.code <= 4004) {
        // Fatal error — do not reconnect
        this.disconnect();
        return;
      }
    }

    // [FIX 1] Reset inactivity timer on every message while connected.
    // The original code only reset the timer once (on connection_established),
    // so after activity_timeout seconds the client would send a ping and risk
    // dropping an otherwise healthy connection that was still exchanging data.
    if (this.#state === 'connected') {
      this.#resetActivityTimer();
    }

    this.#onMessage(msg);
  }

  #handleDisconnect() {
    this.#ws = null;
    this.#clearTimers();

    if (this.#state === 'disconnected') return;

    if (this.#reconnectAttempts < 6) {
      this.#setState('connecting');
      const delay = Math.min(1000 * Math.pow(2, this.#reconnectAttempts), 30_000);
      this.#reconnectAttempts++;
      this.#reconnectTimer = setTimeout(() => this.connect(), delay);
    } else {
      this.#setState('unavailable');
      // [FIX 3] Original code stopped retrying after 6 attempts forever.
      // Schedule one more attempt after a longer cooldown so the client can
      // recover from server restarts or extended network partitions without
      // the caller having to call connect() manually.
      this.#reconnectTimer = setTimeout(() => {
        if (this.#state === 'unavailable') {
          this.#reconnectAttempts = 0;
          this.connect();
        }
      }, UNAVAILABLE_RETRY_DELAY);
    }
  }

  #resetActivityTimer() {
    // [FIX 4] Cancel both phases so a fresh inactivity window begins now.
    // Previously both phases wrote to the same `activityTimer` variable, so
    // the pong-wait phase overwrote the reference to the inactivity phase and
    // neither could be cancelled independently.
    if (this.#activityTimer) { clearTimeout(this.#activityTimer); this.#activityTimer = null; }
    if (this.#pongTimer)     { clearTimeout(this.#pongTimer);     this.#pongTimer     = null; }

    this.#activityTimer = setTimeout(() => {
      this.#activityTimer = null;
      this.send({ event: 'realtime:ping', data: '{}' });

      this.#pongTimer = setTimeout(() => {
        this.#pongTimer = null;
        if (this.#ws) this.#ws.close(); // triggers reconnect via onclose
      }, PONG_TIMEOUT);
    }, this.#activityTimeout * 1000);
  }

  #clearTimers() {
    if (this.#reconnectTimer) { clearTimeout(this.#reconnectTimer); this.#reconnectTimer = null; }
    if (this.#activityTimer)  { clearTimeout(this.#activityTimer);  this.#activityTimer  = null; }
    if (this.#pongTimer)      { clearTimeout(this.#pongTimer);      this.#pongTimer      = null; }
  }

  #setState(state) {
    const prev = this.#state;
    this.#state = state;
    // [FIX 5] Clear the socket ID whenever we leave "connected".
    // The original code left the old ID in place after a disconnect, so a
    // stale ID could reach the auth endpoint before a new
    // connection_established was received.
    if (state !== 'connected') this.#socketId = null;
    if (prev !== state) this.#onStateChange(prev, state);
  }
}

// ─── Channel ──────────────────────────────────────────────────────────────────

class Channel {
  name;
  #bindings   = new Map();
  #subscribed = false;

  constructor(name) {
    this.name = name;
  }

  get subscribed() { return this.#subscribed; }

  /** Bind a callback to an event on this channel. */
  bind(event, callback) {
    if (!this.#bindings.has(event)) this.#bindings.set(event, new Set());
    this.#bindings.get(event).add(callback);
    return this;
  }

  /** Unbind a callback (or all callbacks) for an event. */
  unbind(event, callback) {
    if (!callback) {
      this.#bindings.delete(event);
    } else {
      this.#bindings.get(event)?.delete(callback);
    }
    return this;
  }

  /** Remove all callbacks on this channel. */
  unbindAll() {
    this.#bindings.clear();
    return this;
  }

  /** Send a client event (private/presence channels only). */
  trigger(event, data) {
    if (!event.startsWith('client-')) {
      throw new Error('Client events must be prefixed with "client-"');
    }
    if (!this.name.startsWith('private-') && !this.name.startsWith('presence-')) {
      throw new Error('Client events can only be triggered on private or presence channels');
    }
    this._emit('__internal_trigger', { event, data });
    return this;
  }

  /** @internal */
  handleSubscribed(data) {
    this.#subscribed = true;
    this._emit('realtime:subscription_succeeded', data);
  }

  /** @internal */
  handleEvent(event, data) {
    this._emit(event, data);
  }

  /** @internal */
  handleError(data) {
    this.#subscribed = false;
    this._emit('realtime:subscription_error', data);
  }

  /** @internal — callable by subclasses */
  _emit(event, data) {
    const cbs = this.#bindings.get(event);
    if (!cbs) return;
    for (const cb of cbs) {
      try { cb(data); } catch { /* protect the SDK from user callback errors */ }
    }
  }
}

// ─── PresenceChannel ──────────────────────────────────────────────────────────

class PresenceChannel extends Channel {
  #presence = { count: 0, ids: [], hash: {} };
  #self     = null;

  /** Current user's presence info (available after subscription). */
  get me()          { return this.#self ?? undefined; }
  /** Number of members currently in this channel. */
  get memberCount() { return this.#presence.count; }

  /** Get all channel members as an array. */
  getMembers() {
    return this.#presence.ids
      .map((id) => {
        const userInfo = this.#presence.hash[id];
        return userInfo ? { user_id: id, user_info: userInfo } : null;
      })
      .filter(Boolean);
  }

  /** Get a specific member by user ID. */
  getMember(userId) {
    const userInfo = this.#presence.hash[userId];
    return userInfo ? { user_id: userId, user_info: userInfo } : undefined;
  }

  /** @internal */
  clearPresenceState() {
    this.#presence = { count: 0, ids: [], hash: {} };
    this.#self     = null;
  }

  /** @internal */
  handleSubscribed(data, self) {
    this.clearPresenceState();
    if (self) this.#self = self;

    if (_isPresenceData(data)) {
      const ids  = Array.isArray(data.presence.ids) ? data.presence.ids : [];
      const hash = data.presence.hash ?? {};
      this.#presence = {
        count : 0,
        ids   : ids.filter((id) => typeof id === 'string'),
        hash,
      };
      this.#presence.count = this.#presence.ids.length;
    } else if (data != null) {
      console.warn(`PresenceChannel "${this.name}" received malformed presence snapshot`, data);
    }

    super.handleSubscribed(data);
  }

  /** @internal */
  handleMemberAdded(info) {
    if (!this.#presence.ids.includes(info.user_id)) {
      this.#presence.ids = [...this.#presence.ids, info.user_id];
    }
    this.#presence.hash  = { ...this.#presence.hash, [info.user_id]: info.user_info };
    this.#presence.count = this.#presence.ids.length;
    this._emit('realtime:member_added', info);
  }

  /** @internal */
  handleMemberRemoved(info) {
    this.#presence.ids = this.#presence.ids.filter((id) => id !== info.user_id);
    const { [info.user_id]: _removed, ...rest } = this.#presence.hash;
    this.#presence.hash  = rest;
    this.#presence.count = this.#presence.ids.length;
    this._emit('realtime:member_removed', info);
  }
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function _fetchAuth(socketId, channelName, options) {
  // [FIX 6] Original code sent Content-Type: application/json with a JSON body.
  // The worker's /auth endpoint reads the body with URLSearchParams which
  // requires application/x-www-form-urlencoded — JSON would always fail.
  const body = new URLSearchParams({ socket_id: socketId, channel_name: channelName });

  const response = await fetch(options.endpoint, {
    method  : 'POST',
    headers : {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...options.headers,
    },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`Auth failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function _parsePresenceSelf(channelData) {
  try {
    const parsed = JSON.parse(channelData);
    if (
      typeof parsed.user_id !== 'string' || parsed.user_id.length === 0 ||
      !parsed.user_info || typeof parsed.user_info !== 'object' || Array.isArray(parsed.user_info)
    ) return null;
    return { user_id: parsed.user_id, user_info: parsed.user_info };
  } catch {
    return null;
  }
}

function _isPresenceInfo(data) {
  if (!data || typeof data !== 'object') return false;
  return (
    typeof data.user_id === 'string' && data.user_id.length > 0 &&
    !!data.user_info && typeof data.user_info === 'object' && !Array.isArray(data.user_info)
  );
}

function _isPresenceMemberRemovedData(data) {
  if (!data || typeof data !== 'object') return false;
  return typeof data.user_id === 'string' && data.user_id.length > 0;
}

function _isPresenceData(data) {
  if (!data || typeof data !== 'object') return false;
  const p = data.presence;
  if (!p || typeof p !== 'object') return false;
  return (
    typeof p.count === 'number' &&
    Array.isArray(p.ids) &&
    !!p.hash && typeof p.hash === 'object'
  );
}

// ─── Apinator ─────────────────────────────────────────────────────────────────

class Apinator {
  #connection;
  #channels           = new Map();
  #pendingPresenceSelf = new Map();
  #options;
  #globalBindings     = new Map();

  /**
   * @param {object}  options
   * @param {string}  options.appKey         - Apinator app key
   * @param {string}  options.cluster        - Region cluster, e.g. "eu" or "us"
   * @param {string}  [options.authEndpoint] - Auth endpoint URL for private/presence channels
   * @param {object}  [options.authHeaders]  - Extra headers sent to the auth endpoint
   */
  constructor(options) {
    this.#options    = options;
    this.#connection = new Connection(
      options,
      (msg)          => this.#handleMessage(msg),
      (prev, curr)   => this.#handleStateChange(prev, curr)
    );
  }

  /** Open the WebSocket connection. */
  connect() {
    this.#connection.connect();
    return this;
  }

  /** Close the connection and stop reconnecting. */
  disconnect() {
    this.#connection.disconnect();
    return this;
  }

  /** Socket ID assigned by the server (null until connected). */
  get socketId() { return this.#connection.id; }

  /**
   * Current connection state.
   * One of: "initialized" | "connecting" | "connected" | "unavailable" | "disconnected"
   */
  get state() { return this.#connection.currentState; }

  /**
   * Subscribe to a channel.
   * Prefix "private-" or "presence-" channels are authenticated automatically
   * via authEndpoint.
   * @returns {Channel|PresenceChannel}
   */
  subscribe(channelName) {
    if (this.#channels.has(channelName)) return this.#channels.get(channelName);

    const channel = channelName.startsWith('presence-')
      ? new PresenceChannel(channelName)
      : new Channel(channelName);

    this.#channels.set(channelName, channel);

    // Relay client events from channel.trigger() to the WebSocket
    channel.bind('__internal_trigger', (payload) => {
      this.#connection.send({
        event   : payload.event,
        channel : channelName,
        data    : JSON.stringify(payload.data),
      });
    });

    if (this.#connection.currentState === 'connected') {
      this.#sendSubscribe(channel);
    }

    return channel;
  }

  /** Unsubscribe from a channel and remove all its bindings. */
  unsubscribe(channelName) {
    const channel = this.#channels.get(channelName);
    if (!channel) return this;

    this.#connection.send({
      event : 'realtime:unsubscribe',
      data  : JSON.stringify({ channel: channelName }),
    });

    this.#pendingPresenceSelf.delete(channelName);
    if (channel instanceof PresenceChannel) channel.clearPresenceState();
    channel.unbindAll();
    this.#channels.delete(channelName);
    return this;
  }

  /** Get an already-subscribed channel by name. */
  channel(channelName) {
    return this.#channels.get(channelName);
  }

  /** Bind a global event callback (fires for matching events on any channel). */
  bind(event, callback) {
    if (!this.#globalBindings.has(event)) this.#globalBindings.set(event, new Set());
    this.#globalBindings.get(event).add(callback);
    return this;
  }

  /** Remove a global event callback (or all callbacks for that event). */
  unbind(event, callback) {
    if (!callback) {
      this.#globalBindings.delete(event);
    } else {
      this.#globalBindings.get(event)?.delete(callback);
    }
    return this;
  }

  /** Trigger a client event on a subscribed channel (must start with "client-"). */
  trigger(channelName, event, data) {
    if (!event.startsWith('client-')) {
      throw new Error('Client events must be prefixed with "client-"');
    }
    const channel = this.#channels.get(channelName);
    if (!channel)           throw new Error(`Channel "${channelName}" is not subscribed`);
    if (!channel.subscribed) throw new Error(`Channel "${channelName}" is not yet subscribed`);
    channel.trigger(event, data);
    return this;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  #handleMessage(msg) {
    // Fire matching global bindings
    const globalCbs = this.#globalBindings.get(msg.event);
    if (globalCbs) {
      const parsed = this.#parseData(msg.data);
      for (const cb of globalCbs) {
        try { cb(parsed); } catch {}
      }
    }

    if (!msg.channel) return;

    const channel = this.#channels.get(msg.channel);
    if (!channel) return;

    const data = this.#parseData(msg.data);

    switch (msg.event) {
      case 'realtime:subscription_succeeded':
        if (channel instanceof PresenceChannel) {
          const self = this.#pendingPresenceSelf.get(msg.channel);
          channel.handleSubscribed(data, self);
          this.#pendingPresenceSelf.delete(msg.channel);
        } else {
          channel.handleSubscribed(data);
        }
        break;

      case 'realtime:subscription_error':
        this.#pendingPresenceSelf.delete(msg.channel);
        if (channel instanceof PresenceChannel) channel.clearPresenceState();
        channel.handleError(data);
        break;

      case 'realtime:member_added':
        if (!(channel instanceof PresenceChannel)) break;
        if (!_isPresenceInfo(data)) {
          console.warn(`PresenceChannel "${channel.name}" malformed member_added payload`, data);
          break;
        }
        channel.handleMemberAdded(data);
        break;

      case 'realtime:member_removed':
        if (!(channel instanceof PresenceChannel)) break;
        if (!_isPresenceMemberRemovedData(data)) {
          console.warn(`PresenceChannel "${channel.name}" malformed member_removed payload`, data);
          break;
        }
        channel.handleMemberRemoved(data);
        break;

      default:
        channel.handleEvent(msg.event, data);
    }
  }

  #handleStateChange(prev, curr) {
    // Clear presence state when connection drops or resets
    if ((prev === 'connected' && curr === 'connecting') ||
        curr === 'disconnected' || curr === 'unavailable') {
      this.#clearPresenceState();
    }

    // Re-subscribe to all channels after reconnection
    if (curr === 'connected') {
      for (const channel of this.#channels.values()) {
        this.#sendSubscribe(channel);
      }
    }

    // Fire state_change global binding
    const cbs = this.#globalBindings.get('state_change');
    if (cbs) {
      for (const cb of cbs) {
        try { cb({ previous: prev, current: curr }); } catch {}
      }
    }
  }

  async #sendSubscribe(channel) {
    const isPrivate  = channel.name.startsWith('private-');
    const isPresence = channel.name.startsWith('presence-');

    if (!isPrivate && !isPresence) {
      // Public channel — no auth needed
      this.#connection.send({
        event : 'realtime:subscribe',
        data  : JSON.stringify({ channel: channel.name }),
      });
      return;
    }

    if (!this.#options.authEndpoint) {
      channel.handleError({ type: 'AuthError', error: 'No auth endpoint configured', status: 403 });
      return;
    }

    if (!this.#connection.id) {
      channel.handleError({ type: 'AuthError', error: 'Not connected', status: 403 });
      return;
    }

    try {
      const authResp = await _fetchAuth(
        this.#connection.id,
        channel.name,
        { endpoint: this.#options.authEndpoint, headers: this.#options.authHeaders }
      );

      const subscribeData = { channel: channel.name, auth: authResp.auth };

      if (isPresence) {
        if (!authResp.channel_data) {
          this.#pendingPresenceSelf.delete(channel.name);
          channel.handleError({ type: 'AuthError', error: 'channel_data required for presence channels', status: 403 });
          return;
        }

        const self = _parsePresenceSelf(authResp.channel_data);
        if (!self) {
          this.#pendingPresenceSelf.delete(channel.name);
          channel.handleError({ type: 'AuthError', error: 'invalid channel_data', status: 403 });
          return;
        }

        this.#pendingPresenceSelf.set(channel.name, self);
        subscribeData.channel_data = authResp.channel_data;
      } else if (authResp.channel_data) {
        subscribeData.channel_data = authResp.channel_data;
      }

      this.#connection.send({
        event : 'realtime:subscribe',
        data  : JSON.stringify(subscribeData),
      });
    } catch (err) {
      this.#pendingPresenceSelf.delete(channel.name);
      channel.handleError({ type: 'AuthError', error: String(err), status: 403 });
    }
  }

  #parseData(data) {
    try { return JSON.parse(data); } catch { return data; }
  }

  #clearPresenceState() {
    this.#pendingPresenceSelf.clear();
    for (const channel of this.#channels.values()) {
      if (channel instanceof PresenceChannel) channel.clearPresenceState();
    }
  }
}

// ─── Export ───────────────────────────────────────────────────────────────────

export { Apinator, Channel, PresenceChannel };

// Expose globally so <script type="module"> pages can use window.Apinator
if (typeof window !== 'undefined') {
  window.Apinator = Apinator;
}
