# cf-worker-apinator
A lightweight Cloudflare Worker that provides compatible endpoints for **Apinator**.

> **Official Resources**
>
> - 🌐 Website: https://apinator.io
> - 📚 GitHub: https://github.com/apinator-io

---

## Endpoints

### `POST /trigger`

Trigger an event on a specified channel.

#### Request

* **Method:** `POST`
* **Content-Type:** `application/json`

##### Body Parameters

| Parameter | Type   | Required | Description                       |
| --------- | ------ | :------: | --------------------------------- |
| `channel` | string |     ✅    | Target channel name.              |
| `event`   | string |     ✅    | Event name to broadcast.          |
| `data`    | object |    No    | JSON payload sent with the event. |

#### Example Request

##### cURL

```bash
curl -X POST https://xxx.workers.dev/trigger \
  -H "Content-Type: application/json" \
  -d "{\"channel\":\"test-channel\",\"event\":\"hello\",\"data\":{\"message\":\"Halo!\"}}"
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

---

### `POST /auth`

Generate an authentication signature for private or presence channels.

#### Request

* **Method:** `POST`
* **Content-Type:** `application/x-www-form-urlencoded`

##### Form Parameters

| Parameter      | Type   | Required | Description                                  |
| -------------- | ------ | :------: | -------------------------------------------- |
| `socket_id`    | string |     ✅    | Socket ID provided by the client connection. |
| `channel_name` | string |     ✅    | Private or presence channel name.            |

#### Example Request

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

#### Example Response

```json
{
  "auth": "app_xxxxx:xxxxx"
}
```
