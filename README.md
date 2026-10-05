# pi-control

Remote-control your [Pi](https://pi.dev) coding sessions from your phone.

Two pieces, one product:

- **`server/`** — a small Node.js service (Dockerized) that accepts
  extensions and serves a clean mobile web UI.
- **`extension/`** — a Pi extension that links a session to the server:
  it streams the full session scrollback + live activity, and accepts
  remote input injected exactly like typed terminal text.

```
phone browser ──wss (passcode)──► pi-control server ◄──wss (server key)── pi + extension
```

See [PLAN.md](PLAN.md) for the architecture and protocol, and
[SECURITY.md](SECURITY.md) for the security model and audit.

---

## 1. Run the server

### Docker (recommended)

```bash
cd server
docker build -t pi-control .

docker run -d --name pi-control --restart unless-stopped \
  -p 8787:8787 \
  -e PI_REMOTE_SERVER_KEY="$(openssl rand -hex 32)" \
pi-control
```

Or with Compose (see `server/docker-compose.yml`):

```bash
cd server
export PI_REMOTE_SERVER_KEY="$(openssl rand -hex 32)"
docker compose up -d --build
```

### Without Docker

```bash
cd server
npm install
PI_REMOTE_SERVER_KEY="$(openssl rand -hex 32)" node src/server.js
```

Open `http://<server>:8787/` on your phone — you'll be asked for the
server key.

> If you don't set `PI_REMOTE_SERVER_KEY`, a random one is generated and
> printed in the startup log (dev convenience only).

### TLS (production)

Either terminate TLS at a reverse proxy (Caddy/nginx — forward
`Upgrade`/`Connection` headers for the WebSocket paths and set
`PI_REMOTE_TRUST_PROXY=1`), or serve TLS directly:

```bash
-e PI_REMOTE_TLS_CERT=/secrets/cert.pem -e PI_REMOTE_TLS_KEY=/secrets/key.pem
```

### Server options (env)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `8787` / `0.0.0.0` | listen address |
| `PI_REMOTE_SERVER_KEY` | generated | master secret for extensions + session list |
| `PI_REMOTE_TLS_CERT` / `PI_REMOTE_TLS_KEY` | — | serve HTTPS/WSS directly |
| `PI_REMOTE_TRUST_PROXY` | off | honor `X-Forwarded-For` (behind a proxy) |
| `PI_REMOTE_MAX_SESSIONS` | `32` | linked-session cap |
| `PI_REMOTE_BUFFER_ITEMS` | `1000` | ring-buffer size per session |
| `PI_REMOTE_OFFLINE_GRACE_MS` | `600000` | keep offline sessions this long |

---

## 2. Install the Pi extension

Copy the extension file into a Pi extension location:

```bash
# global (all projects)
cp extension/index.ts ~/.pi/agent/extensions/pi-control.ts

# or project-local
mkdir -p .pi/extensions && cp extension/index.ts .pi/extensions/pi-control.ts
```

An example config is at [`extension/pi-control.example.json`](extension/pi-control.example.json)
(`extension/README.md` documents every field).

Configure it by creating `~/.pi/agent/pi-control.json` (keep it `0600` —
it contains the server key):

```json
{
	"url": "wss://your-server:8787",   // /ws/pi is implied
	"key": "<same PI_REMOTE_SERVER_KEY>",
	"passcode": "MYCODE42",              // optional; the phone UI access code
	"debug": false                        // optional, stderr diagnostics
}
```

The extension is a no-op when the file is missing or lacks `url` + `key`.
Then start Pi normally. On link you'll see:

- a notification: `pi-control linked — passcode: MYCODE42`
- a persistent status line (taskbar): `pi-control: ● linked · code MYCODE42`

Type `/pi-control` any time to re-show the status/passcode.

**Passcode:** set `passcode` (4–16 chars, no whitespace) to choose a fixed
code for every session from this machine; omit it and the server generates
a random 6-char code per session, shown in the TUI. The web UI uppercases
passcode entry, so keep it uppercase.

### Extension options

| Config field (JSON) | Meaning |
|---|---|
| `url` | server URL (`ws://`/`wss://`); required |
| `key` | the server key; required |
| `passcode` | (optional) fixed phone access code; server generates one when omitted |
| `debug` | (optional) log connection diagnostics to stderr |

Overrides: point `PI_CONTROL_CONFIG` at an alternate config file (e.g.
per-machine), or pass `--pi-control-url` / `--pi-control-key` for a single
run.

---

## 3. Use the phone UI

1. Open the server URL in your phone's browser.
2. Enter the **server key** → session list (host, cwd, state dot, model,
   last activity).
3. Tap a session → enter its **passcode** (your configured `passcode`, or the
   generated one shown in the Pi terminal status line).
4. You now see the live transcript — user messages, assistant output,
   collapsible tool calls/results, compaction markers — plus a status bar.
5. Type and send:
   - **queue** (default): the message is queued and processed when Pi is
     idle (like typing while it works).
   - **steer**: interrupts the current turn with your message.
   - **■ Stop**: aborts the running agent.

Remote messages are badged `remote` in the transcript so you can tell
phone input from terminal input.

Both secrets are remembered by the browser (clear them with the lock
icon). Use a private window on shared devices.

---

## 4. Development

```bash
# server test harness (22 checks: auth, limits, relay, lockout, liveness)
node test/harness.mjs

# full end-to-end: real `pi` + extension + server (10 checks,
# includes a remote steer and a remote abort)
node test/extension-e2e.mjs
```

Layout:

```
server/     Node service (single runtime dep: ws) + Dockerfile + web UI
extension/  the Pi extension (type-only imports; no runtime deps)
test/       harness.mjs (server) and extension-e2e.mjs (full loop)
```

## 5. Security notes

Read [SECURITY.md](SECURITY.md) before exposing the server beyond your
LAN. Short version: use a long random key, use TLS, and remember the
server key grants full control while a passcode grants one session.
