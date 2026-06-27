import { createHmac, createHash } from 'node:crypto';

// ── Crypto (port langsung dari src/crypto.ts) ────────────────────────────────

function md5Hex(data) {
  return createHash('md5').update(data, 'utf8').digest('hex');
}

/**
 * Signing untuk API request:
 * sigString = "${timestamp}\n${method}\n${path}\n${bodyMD5}"
 * body kosong → bodyMD5 = "" (BUKAN md5 dari string kosong)
 */
function signRequest(secret, method, path, body, timestamp) {
  const bodyMD5 = body === '' ? '' : md5Hex(body);
  const sigString = `${timestamp}\n${method}\n${path}\n${bodyMD5}`;
  return createHmac('sha256', secret).update(sigString, 'utf8').digest('hex');
}

/**
 * Signing untuk channel auth:
 * sigString = "${socketId}:${channelName}" atau "${socketId}:${channelName}:${channelData}"
 */
function signChannel(secret, socketId, channelName, channelData) {
  const sigString = channelData
    ? `${socketId}:${channelName}:${channelData}`
    : `${socketId}:${channelName}`;
  return createHmac('sha256', secret).update(sigString, 'utf8').digest('hex');
}

/**
 * Signing untuk webhook:
 * input = "${timestamp}.${payload}"  ← titik, bukan newline!
 */
function signWebhookPayload(secret, timestamp, payload) {
  const input = `${timestamp}.${payload}`;
  return createHmac('sha256', secret).update(input, 'utf8').digest('hex');
}

// ── Error classes ─────────────────────────────────────────────────────────────

class RealtimeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RealtimeError';
  }
}

class ApiError extends Error {
  constructor(message, status, raw) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.raw = raw;
  }
}

class AuthenticationError extends ApiError {
  constructor(message, status, raw) {
    super(message, status, raw);
    this.name = 'AuthenticationError';
  }
}

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

// ── Apinator Client ───────────────────────────────────────────────────────────

class Apinator {
  #appId;
  #key;
  #secret;
  #host;

  constructor(options) {
    this.#appId   = options.appId;
    this.#key     = options.key;
    this.#secret  = options.secret;
    this.#host    = `https://ws-${options.cluster}.apinator.io`;
  }

  // Trigger event ke satu atau beberapa channel
  async trigger(params) {
    if (params.channel && params.channels) {
      throw new ValidationError("Cannot specify both 'channel' and 'channels'");
    }
    if (!params.channel && !params.channels) {
      throw new ValidationError("Must specify 'channel' or 'channels'");
    }

    const body = {
      name: params.name,
      data: params.data,
      ...(params.channel  && { channel: params.channel }),
      ...(params.channels && { channels: params.channels }),
      ...(params.socketId && { socket_id: params.socketId }),
    };

    await this.#request('POST', `/apps/${this.#appId}/events`, JSON.stringify(body));
  }

  // Buat auth signature untuk private/presence channel (synchronous)
  authenticateChannel(socketId, channelName, channelData) {
    const signature = signChannel(this.#secret, socketId, channelName, channelData);
    const auth = `${this.#key}:${signature}`;
    return channelData ? { auth, channel_data: channelData } : { auth };
  }

  // Ambil semua channel, opsional filter by prefix
  async getChannels(prefix) {
    let path = `/apps/${this.#appId}/channels`;
    if (prefix) path += `?filter_by_prefix=${encodeURIComponent(prefix)}`;
    const res = await this.#request('GET', path, '');
    return res.channels;
  }

  // Ambil info channel spesifik
  async getChannel(channelName) {
    const path = `/apps/${this.#appId}/channels/${encodeURIComponent(channelName)}`;
    return this.#request('GET', path, '');
  }

  // Verifikasi webhook (synchronous)
  verifyWebhook(headers, body, maxAge = 300) {
    const signature = headers['x-realtime-signature'];
    const timestamp  = headers['x-realtime-timestamp'];
    if (!signature || !timestamp) return false;

    // Cek usia timestamp
    const age = Math.abs(Math.floor(Date.now() / 1000) - parseInt(timestamp, 10));
    if (age > maxAge) return false;

    const expected = signWebhookPayload(this.#secret, timestamp, body);
    return expected === signature;
  }

  // Private: HTTP request dengan HMAC signing
  async #request(method, path, body) {
    const timestamp = Math.floor(Date.now() / 1000);
    const [signPath] = path.split('?'); // sign hanya path, tanpa query string
    const signature  = signRequest(this.#secret, method, signPath, body, timestamp);

    const headers = {
      'X-Realtime-Key':       this.#key,
      'X-Realtime-Timestamp': String(timestamp),
      'X-Realtime-Signature': signature,
      ...(body !== '' && { 'Content-Type': 'application/json' }),
    };

    let response;
    try {
      response = await fetch(`${this.#host}${path}`, {
        method,
        headers,
        body: body !== '' ? body : undefined,
      });
    } catch (err) {
      throw new RealtimeError(`Network error: ${err.message}`);
    }

    const text = await response.text();

    if (!response.ok) {
      let message = text;
      try {
        const problem = JSON.parse(text);
        message = problem.detail || problem.title || text;
      } catch { /* biarkan message = raw text */ }

      if (response.status === 401 || response.status === 403) {
        throw new AuthenticationError(message || 'Authentication failed', response.status, text);
      }
      if (response.status === 400 || response.status === 422) {
        throw new ValidationError(message || 'Validation failed');
      }
      throw new ApiError(
        message || `Request failed with status ${response.status}`,
        response.status,
        text,
      );
    }

    if (text === '') return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new RealtimeError(`Failed to parse response: ${text}`);
    }
  }
}

// ── Worker Request Handler ────────────────────────────────────────────────────

function createClient(env) {
  return new Apinator({
    appId:   env.APINATOR_APP_ID,
    key:     env.APINATOR_KEY,
    secret:  env.APINATOR_SECRET,
    cluster: env.APINATOR_CLUSTER,
  });
}

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const client = createClient(env);

    try {
      // POST /trigger → kirim event ke channel
      if (request.method === 'POST' && url.pathname === '/trigger') {
        const { channel, event, data } = await request.json();
        await client.trigger({ name: event, channel, data: JSON.stringify(data) });
        return Response.json({ ok: true });
      }

      // POST /auth → authenticate private/presence channel
      // Client Apinator mengirim body: socket_id=...&channel_name=...
      if (request.method === 'POST' && url.pathname === '/auth') {
        const params      = new URLSearchParams(await request.text());
        const socketId    = params.get('socket_id');
        const channelName = params.get('channel_name');
        const channelData = params.get('channel_data') ?? undefined;

        if (!socketId || !channelName) {
          return Response.json({ error: 'Missing socket_id or channel_name' }, { status: 400 });
        }

        const auth = client.authenticateChannel(socketId, channelName, channelData);
        return Response.json(auth);
      }

      // POST /webhooks → terima webhook dari Apinator
      if (request.method === 'POST' && url.pathname === '/webhooks') {
        const body    = await request.text();
        const headers = Object.fromEntries(request.headers.entries());

        if (!client.verifyWebhook(headers, body)) {
          return new Response('Unauthorized', { status: 401 });
        }

        const event = JSON.parse(body);
        console.log('Webhook received:', JSON.stringify(event));
        // TODO: proses event.name, event.data sesuai kebutuhan

        return Response.json({ received: true });
      }

      return new Response('Not Found', { status: 404 });

    } catch (err) {
      if (err instanceof ValidationError) {
        return Response.json({ error: err.message }, { status: 400 });
      }
      if (err instanceof AuthenticationError) {
        return Response.json({ error: err.message }, { status: 401 });
      }
      if (err instanceof ApiError) {
        return Response.json({ error: err.message }, { status: err.status });
      }
      console.error('Unexpected error:', err);
      return Response.json({ error: 'Internal Server Error' }, { status: 500 });
    }
  },
};
