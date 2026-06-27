# cf-worker-apinator

A lightweight Cloudflare Worker that provides compatible endpoints for **Apinator**.

> **Official Resources**
>
> - 🌐 Website: https://apinator.io
> - 📚 GitHub: https://github.com/apinator-io

---

## Requirements

- [Node.js](https://nodejs.org) v18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) v3+
- A Cloudflare account
- An Apinator account with an existing app

---

## Setup

### 1. Clone the repository

```bash
git clone https://github.com/barbatosotos/cf-worker-apinator.git
cd cf-worker-apinator
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure `wrangler.toml`

```toml
name = "cf-worker-apinator"
main = "src/worker.js"
compatibility_date = "2024-01-01"
compatibility_flags = ["nodejs_compat"]

[vars]
APINATOR_CLUSTER = "eu"  # or "us"
```

### 4. Set secrets

Set the following secrets via Wrangler CLI. You can find these values in your [Apinator dashboard](https://apinator.io).

```bash
wrangler secret put APINATOR_APP_ID
wrangler secret put APINATOR_KEY
wrangler secret put APINATOR_SECRET
```

| Secret | Description |
| --- | --- |
| `APINATOR_APP_ID` | Your Apinator application ID |
| `APINATOR_KEY` | Your Apinator API key |
| `APINATOR_SECRET` | Your Apinator API secret |

### 5. Deploy

```bash
wrangler deploy
```

---

## Endpoints

### `POST /trigger`

Trigger an event on one or more channels.

#### Request

- **Method:** `POST`
- **Content-Type:** `application/json`

##### Body Parameters

| Parameter  | Type            | Required | Description                                            |
| ---------- | --------------- | :------: | ------------------------------------------------------ |
| `channel`  | string          |    ✅\*   | Single target channel name.                            |
| `channels` | string[]        |    ✅\*   | Multiple target channel names.                         |
| `event`    | string          |    ✅    | Event name to broadcast.                               |
| `data`     | object          |    No    | JSON payload sent with the event.                      |
| `socketId` | string          |    No    | Exclude a specific socket connection from receiving the event. |

> \* Use either `channel` **or** `channels`, not both.

#### Example Request

##### cURL — Single channel

```bash
curl -X POST https://xxx.workers.dev/trigger \
  -H "Content-Type: application/json" \
  -d "{\"channel\":\"test-channel\",\"event\":\"hello\",\"data\":{\"message\":\"Halo!\"}}"
```

##### cURL — Multiple channels

```bash
curl -X POST https://xxx.workers.dev/trigger \
  -H "Content-Type: application/json" \
  -d "{\"channels\":[\"user-1\",\"user-2\"],\"event\":\"notification\",\"data\":{\"message\":\"New update\"}}"
```

##### PowerShell

```powershell
Invoke-RestMethod -Method POST `
  -Uri "https://xxx.workers.dev/trigger" `
  -ContentType "application/json" `
  -Body '{"channel":"test-channel","event":"hello","data":{"message":"Halo!"}}'
```

#### Example Response

```json
{
  "ok": true
}
```

#### Error Responses

| Status | Description |
| --- | --- |
| `400` | Both `channel` and `channels` were specified, or neither was provided |
| `401` | Invalid Apinator credentials |

---

### `POST /auth`

Generate an authentication signature for private or presence channels.

#### Request

- **Method:** `POST`
- **Content-Type:** `application/x-www-form-urlencoded`

##### Form Parameters

| Parameter      | Type   | Required | Description                                                                 |
| -------------- | ------ | :------: | --------------------------------------------------------------------------- |
| `socket_id`    | string |    ✅    | Socket ID provided by the client connection.                                |
| `channel_name` | string |    ✅    | Private or presence channel name.                                           |
| `channel_data` | string |    No    | JSON string with user info. Required for presence channels (e.g., `{"user_id":"user1","user_info":{"name":"Alice"}}`). |

#### Example Request — Private channel

##### cURL

```bash
curl -X POST https://xxx.workers.dev/auth \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "socket_id=12345.67890&channel_name=private-chat"
```

##### PowerShell

```powershell
Invoke-RestMethod -Method POST `
  -Uri "https://xxx.workers.dev/auth" `
  -ContentType "application/x-www-form-urlencoded" `
  -Body "socket_id=12345.67890&channel_name=private-chat"
```

#### Example Request — Presence channel

##### cURL

```bash
curl -X POST https://xxx.workers.dev/auth \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "socket_id=12345.67890&channel_name=presence-room&channel_data=%7B%22user_id%22%3A%22user1%22%2C%22user_info%22%3A%7B%22name%22%3A%22Alice%22%7D%7D"
```

##### PowerShell

```powershell
$channelData = '{"user_id":"user1","user_info":{"name":"Alice"}}'
$encoded     = [System.Uri]::EscapeDataString($channelData)

Invoke-RestMethod -Method POST `
  -Uri "https://xxx.workers.dev/auth" `
  -ContentType "application/x-www-form-urlencoded" `
  -Body "socket_id=12345.67890&channel_name=presence-room&channel_data=$encoded"
```

#### Example Response — Private channel

```json
{
  "auth": "app_xxxxx:xxxxx"
}
```

#### Example Response — Presence channel

```json
{
  "auth": "app_xxxxx:xxxxx",
  "channel_data": "{\"user_id\":\"user1\",\"user_info\":{\"name\":\"Alice\"}}"
}
```

#### Error Responses

| Status | Description |
| --- | --- |
| `400` | Missing `socket_id` or `channel_name` |

---

### `POST /webhooks`

Receive and verify webhook events sent by Apinator. This endpoint validates the HMAC-SHA256 signature on every incoming request to ensure the payload is authentic.

#### Request

- **Method:** `POST`
- **Content-Type:** `application/json`

##### Required Headers

| Header                  | Description                                      |
| ----------------------- | ------------------------------------------------ |
| `X-Realtime-Signature`  | HMAC-SHA256 signature generated by Apinator.     |
| `X-Realtime-Timestamp`  | Unix timestamp (seconds) when the request was sent. |

> Requests with a timestamp older than **300 seconds** are automatically rejected to prevent replay attacks.

#### Example Webhook Payload

```json
{
  "event": "channel_vacated",
  "data": {
    "channel": "test-channel"
  }
}
```

#### Example Response

```json
{
  "received": true
}
```

#### Error Responses

| Status | Description |
| --- | --- |
| `401` | Missing headers, expired timestamp, or invalid signature |

#### Testing Webhooks Locally

Since Apinator sends webhooks to a public URL, you can simulate a webhook request by manually generating a valid signature:

##### PowerShell

```powershell
& {
  $s = "your-apinator-secret"
  $t = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  $p = '{"event":"channel_vacated","data":{"channel":"test-channel"}}'
  $h = New-Object System.Security.Cryptography.HMACSHA256
  $h.Key = [System.Text.Encoding]::UTF8.GetBytes($s)
  $sig = -join ($h.ComputeHash([System.Text.Encoding]::UTF8.GetBytes("$t.$p")) | ForEach-Object { $_.ToString("x2") })

  Invoke-RestMethod -Method POST `
    -Uri "https://xxx.workers.dev/webhooks" `
    -ContentType "application/json" `
    -Headers @{
      "X-Realtime-Signature" = $sig
      "X-Realtime-Timestamp" = $t.ToString()
    } `
    -Body $p
}
```

##### cURL

```bash
SECRET="your-apinator-secret"
TIMESTAMP=$(date +%s)
PAYLOAD='{"event":"channel_vacated","data":{"channel":"test-channel"}}'
SIGNATURE=$(echo -n "${TIMESTAMP}.${PAYLOAD}" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')

curl -X POST https://xxx.workers.dev/webhooks \
  -H "Content-Type: application/json" \
  -H "X-Realtime-Signature: $SIGNATURE" \
  -H "X-Realtime-Timestamp: $TIMESTAMP" \
  -d "$PAYLOAD"
```

---

## Signing Reference

This worker reimplements the Apinator signing algorithm from [`@apinator/server`](https://github.com/apinator-io/sdk-node) using `node:crypto` (available via the `nodejs_compat` compatibility flag).

| Operation | Algorithm | Signing Input |
| --- | --- | --- |
| API request | HMAC-SHA256 | `{timestamp}\n{method}\n{path}\n{md5(body)}` |
| Channel auth | HMAC-SHA256 | `{socket_id}:{channel_name}` or `{socket_id}:{channel_name}:{channel_data}` |
| Webhook verify | HMAC-SHA256 | `{timestamp}.{body}` |

> Body MD5 is computed only when body is non-empty. An empty body uses an empty string `""` instead of `md5("")`.

---

## License

MIT
