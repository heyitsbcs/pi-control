# pi-control extension

Install:

```bash
cp extension/index.ts ~/.pi/agent/extensions/pi-control.ts
cp extension/pi-control.example.json ~/.pi/agent/pi-control.json
chmod 600 ~/.pi/agent/pi-control.json
# edit ~/.pi/agent/pi-control.json:
#   url    -> your pi-control server (ws:// or wss://)
#   key    -> the server's PI_REMOTE_SERVER_KEY
#   passcode -> the code you'll type in the phone UI (4-16 chars, no spaces)
```

Start Pi — you'll see a `pi-control: ● linked` status line (taskbar) and a
one-time notification on link.

### Config fields (`~/.pi/agent/pi-control.json`)

| Field | Required | Meaning |
|---|---|---|
| `url` | yes | Server address, `ws://host:port` or `wss://host:port`. `/ws/pi` is appended if no path. |
| `key` | yes | The server's `PI_REMOTE_SERVER_KEY`. |
| `passcode` | no | The phone-side access code for every session from this machine. 4–16 chars, no whitespace. Omit to let the server generate a random one per session (shown in the TUI). |
| `debug` | no | `true` logs connection diagnostics to Pi's stderr. |

Missing file, or missing `url`/`key` → the extension is an inert no-op.

**Passcode notes.** The web UI uppercases passcode input, so keep your
passcode uppercase (e.g. `MYCODE42`). Changing `passcode` in the config
rotates the session code on the next link. The per-session 5-fail lockout
(60 s) still applies.

### Overrides

- `PI_CONTROL_CONFIG=/path/to/other.json` — use a different config file
  (per-machine configs, testing).
- `pi --pi-control-url wss://... --pi-control-key ...` — per-run override of
  `url` / `key`.

### In-session

Type `/pi-control` any time to re-show link status and passcode.

### Type-check (dev)

```bash
cd extension
npm install        # typescript only
npm run typecheck
```

`tsconfig.json` is a dev convenience; it maps
`@earendil-works/pi-coding-agent` to a local install path — adjust the
`paths` entry if your Pi lives elsewhere.
