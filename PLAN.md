# Pi Control — Plan, Functionality, and Protocol

Remote-control your Pi coding agent sessions from your phone.

Two artifacts, one product:

1. **Pi extension** (`extension/index.ts`) — runs inside any Pi session on your
   desktop/laptop. Forwards the full text scrollback + live activity to the
   server, and accepts remote input that is injected into the session exactly
   like typed terminal input.
2. **Server** (`server/`) — a Node.js service (Dockerized) that accepts
   extension connections and serves a clean mobile web UI for monitoring
   sessions and sending commands.

```
┌────────────────┐   wss://server/ws/pi    ┌─────────────────┐   wss://server/ws/viewer + HTTPS   ┌──────────┐
│  Pi (desktop)  │ ◄─────────────────────► │   pi-control    │ ◄────────────────────────────────► │  Phone   │
│  + extension   │      auth key           │   server        │        passcode per session        │  browser │
└────────────────┘                         └─────────────────┘                                    └──────────┘
```

---

## 1. Architecture

- **One WebSocket per role.** The extension holds a `/ws/pi` connection
  (authenticated with the *server key* — a shared secret configured on both
  ends). Each phone viewer holds a `/ws/viewer` connection (authenticated per
  session with a *passcode*).
- **Server is a relay + short-term buffer.** Per session it keeps a bounded
  ring buffer of transcript items. A phone joining mid-session gets the buffer
  (and the extension re-dumps the full scrollback via `request_scrollback`),
  so the UI is complete even if it never saw the history stream.
- **The extension is the source of truth.** Pi owns the session; the server
  never stores long-term state. If the extension drops, the session shows as
  `offline`; when it reconnects, viewers are kept and the transcript
  re-syncs.
- **Transport security.** The server supports TLS directly
  (`PI_REMOTE_TLS_CERT` / `PI_REMOTE_TLS_KEY`) or behind any reverse proxy
  (Caddy/nginx). Recommended: TLS in production.

### Auth model (two independent secrets, per the design brief)

| Secret | Held by | Grants |
|---|---|---|
| **Server key** (`PI_REMOTE_SERVER_KEY`) | Pi extension + phone UI | Extension: register/link sessions. Phone UI: list sessions. |
| **Session passcode** (6-char, server-generated at link time, shown in Pi TUI) | Phone UI user | View + send commands + abort to *that one* session. |

Key and passcode are never placed in URL query strings (log-safe).

---

## 2. Exact functionality

### Server

Configuration (env):
- `PORT` (default `8787`), `HOST` (default `0.0.0.0`)
- `PI_REMOTE_SERVER_KEY` — master secret. If unset, a random one is generated
  and printed at startup (dev convenience; production must set it).
- `PI_REMOTE_TLS_CERT` / `PI_REMOTE_TLS_KEY` — enable HTTPS/WSS directly.
- `PI_REMOTE_MAX_SESSIONS` (default `32`)
- `PI_REMOTE_BUFFER_ITEMS` (default `1000`, ring buffer per session)
- `PI_REMOTE_OFFLINE_GRACE_MS` (default `10min` — keep session record after extension disconnect)

Features:
1. HTTP API (all JSON):
   - `GET /api/health` → `{ ok, version, sessions }` (no auth)
   - `GET /api/sessions` → session list. Requires `Authorization: Bearer <server key>`.
   - `GET /api/sessions/:id` → single session. Same auth.
   - `GET /` → web UI (static, strict CSP).
2. `/ws/pi` — extension channel (see protocol).
3. `/ws/viewer` — phone channel (see protocol).
4. Session registry: upsert on auth, heartbeat liveness, offline grace,
   per-session ring buffer of items, viewer fan-out, command relay.
5. Passcodes: 6 chars from a 28-char unambiguous Crockford-style alphabet
   (~450M combinations), constant-time comparison, per-session lockout
   (5 failures → 60 s lock), per-IP rate limit on unauthenticated viewer auth.
6. Hard limits: 256 KB max frame, 200 KB max item text, 2000 items per
   scrollback (oldest dropped), 16 KB max remote input text, max concurrent
   viewers per session (default 8), 10 s handshake deadline.
7. Web UI (vanilla JS, no external assets):
   - **Key screen** — enter server key (stored in `localStorage`).
   - **Sessions screen** — cards: title, host, cwd, state dot (online/idle,
     running, offline), model, last activity; auto-refresh + live via polling.
   - **Session screen** — passcode gate → live transcript: role-colored
     blocks, monospace tool calls/results (collapsible), status bar,
     auto-scroll with "jump to latest"; input bar with **Send** (queued
     follow-up) and **Stop** (abort) buttons.
   - Mobile-first: safe-area insets, large touch targets, dark theme.

### Pi extension

Configuration file `~/.pi/agent/pi-control.json` (no-op when missing, so it's
safe to leave installed):

```json
{ "url": "wss://host:8787", "key": "<server key>",
  "passcode": "optional", "debug": false }
```

Overrides: `PI_CONTROL_CONFIG` (alternate file path), or CLI flags
`--pi-control-url` / `--pi-control-key`.

Behavior:
1. On `session_start`: connect to the server, authenticate with the key,
   register the session (id = Pi session id, host name, cwd, session name).
2. On `auth_ok`: show the **passcode** via a one-time notification and keep a
   persistent status-line entry: `pi-control: ● linked · code ABC123`.
3. **Full scrollback** on every (re)connect and on viewer request: rendered
   from `ctx.sessionManager.buildContextEntries()` (compaction-aware) into
   transcript items.
4. **Live updates** mapped from Pi events:
   | Pi event | Transcript item / effect |
   |---|---|
   | `input` (interactive) | user text item (remote-origin inputs badged "remote") |
   | `message_start`/`message_update`/`message_end` (assistant) | streaming assistant item (full-text replaces, throttled ~125 ms) |
   | `tool_execution_start` | tool item: name + arg summary |
   | `tool_execution_update` | tool item streaming output |
   | `tool_execution_end` | tool item final output (truncated 8 KB), error flag |
   | `agent_start` / `agent_end` / `agent_settled` | status `running` / `idle` |
   | `session_compact` | compaction info item |
   | `model_select` | status model field |
   | `user_bash` | system item (`!` command) |
5. **Remote input**: `remote_input` frame → `pi.sendUserMessage(text,
   { deliverAs })` — identical path to typed input (goes through skill/template
   expansion unless `expandPromptTemplates:false`, respects steer/followUp
   semantics). `remote_abort` → `ctx.abort()` on the last-seen context.
6. Resilience: exponential backoff reconnect (1 s → 30 s cap), full re-dump on
   reconnect, app-level heartbeats, no-op in `print`/`json`-less modes,
   never blocks Pi (all server I/O off the hot path, bounded).
7. `/pi-control` command: show link status/passcode on demand.

---

## 3. Protocol review

Wire: WebSocket, JSON frames, UTF-8. Max frame 256 KB. Protocol version `1`.
All timestamps epoch ms.

### Transcript item (shared shape)

```jsonc
{
  "id":  "u7f3",           // stable; server/clients replace-by-id
  "role":  "user" | "assistant" | "tool" | "system" | "info",
  "kind":  "text" | "tool_call" | "tool_result" | "error" | "compaction",
  "title": "bash",          // optional: tool name / heading
  "text":  "ls -la …",      // display text (full text so far for streaming)
  "ts":    1717600000000
}
```

### `/ws/pi` — extension channel

| Dir | Frame | Notes |
|---|---|---|
| C→S | `{type:"auth", protocol:1, key, session:{id, hostname, cwd, name?}, client?}` | first frame, 10 s deadline |
| S→C | `{type:"auth_ok", protocol:1, session:{id, passcode}}` | passcode shown in TUI |
| S→C | `{type:"auth_error", error:"bad_key"\|"too_many_sessions"}` | then close 4401 |
| C→S | `{type:"hb", n}` | server echoes `{type:"hb", n, t}` |
| C→S | `{type:"scrollback", seq, items:[Item]}` | replaces view; forwarded to viewers as `resync` + items |
| C→S | `{type:"item", seq, item:Item}` | append/update by id |
| C→S | `{type:"status", seq, state:"idle"\|"running"\|"waiting_user", model?, tool?}` | session state |
| S→C | `{type:"remote_input", id, text, deliverAs:"followUp"\|"steer"}` | phone typed a command |
| S→C | `{type:"remote_abort", id}` | phone pressed Stop |
| S→C | `{type:"request_scrollback"}` | new viewer joined; re-dump |
| C→S | `{type:"ack", id}` | optional ack of command delivery |
| S→C | `{type:"error", code, message}` | e.g. `rate_limited`, `frame_too_large` |

### `/ws/viewer` — phone channel

| Dir | Frame | Notes |
|---|---|---|
| C→S | `{type:"auth", protocol:1, session:"<id>", code:"<passcode>"}` | first frame, 10 s deadline |
| S→C | `{type:"auth_ok", session:{id, title, cwd, hostname, state, model}, history:[Item], status}` | history = ring buffer |
| S→C | `{type:"auth_error", error:"unknown_session"\|"bad_passcode"\|"locked"\|"rate_limited"\|"offline"}` | `offline` still allowed (viewer stays attached) |
| C→S | `{type:"command", action:"user_message", text, deliverAs}` | ≤16 KB |
| C→S | `{type:"command", action:"abort"}` | |
| C→S | `{type:"request_scrollback"}` | |
| C→S | `{type:"hb", n}` | |
| S→C | `{type:"echo", action, text?, deliverAs?}` | optimistic echo of your own command |
| S→C | `{type:"item", item:Item}` | live item update |
| S→C | `{type:"resync"}` | server asked the extension to re-dump; drop local view |
| S→C | `{type:"status", state, model?, tool?, online:boolean}` | |
| S→C | `{type:"hb", n, t}` | |

### Protocol decisions (reviewed)

- **Push, not poll.** Live streaming via WS; the HTTP API exists only for the
  session list (and health). Polling the list every ~5 s is acceptable for a
  single-user tool and keeps the UI code trivial.
- **Replace-by-id items** instead of append-only deltas: streaming assistant
  text is the full text so far, so a dropped frame self-heals on the next
  update; ring buffer stays small; scrollback re-dump is idempotent.
- **No reliable delivery in v1.** Loss is handled by (a) replace-by-id and
  (b) `request_scrollback` on every new viewer. Adding sequence-gap detection
  later is backward-compatible (`seq` fields already exist).
- **`deliverAs` exposed to the phone**: `followUp` (default — queues until the
  agent is idle, matches "type while it works") and `steer` (interrupts the
  current stream). `Stop` maps to `ctx.abort()`.
- **Server key vs passcode separation** means a leaked phone-side passcode
  only exposes one session, and a leaked server key does not let a stranger
  *view* transcripts (only link/list).
- **Keys never in URLs** — WS auth happens in the first text frame.

---

## 4. Repo layout

```
pi-control/
  PLAN.md                 # this document
  README.md               # user docs: setup, Docker, phone usage
  server/
    Dockerfile            # node:22-alpine, non-root
    package.json          # single runtime dep: ws
    src/
      server.js           # entry: http + wss, static, api, config
      registry.js         # session registry + ring buffer
      pi-channel.js       # extension WS handling
      viewer-channel.js   # phone WS handling
      util.js             # timing-safe compare, passcodes, limits
    public/
      index.html app.js style.css
  extension/
    package.json
    index.ts              # the Pi extension (type-only imports, no runtime deps)
  test/
    harness.mjs           # end-to-end server test harness (built-in WS client)
    extension-e2e.mjs     # runs real `pi` with the extension against the server
```

## 5. Task order (per brief)

1. ✅ Plan (this document)
2. ✅ Functionality enumeration (§2)
3. ✅ Protocol review (§3)
4. ✅ Server implemented (`server/`, Dockerfile, web UI)
5. ✅ Test harness: `test/harness.mjs` — 22/22 passing (input + output + auth + limits)
6. ✅ Pi extension implemented (`extension/index.ts`, typechecks clean)
7. ✅ Extension vs server: `test/extension-e2e.mjs` — 10/10 passing
   (real `pi`: scrollback, live streaming, remote steer, remote abort, liveness)
8. ✅ Security audit: `SECURITY.md` (4 findings fixed, residuals documented)
