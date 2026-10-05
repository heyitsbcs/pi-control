# pi-remote extension

Install:

```bash
cp extension/index.ts ~/.pi/agent/extensions/pi-remote.ts
cp extension/pi-control.example.json ~/.pi/agent/pi-control.json
chmod 600 ~/.pi/agent/pi-control.json
# edit ~/.pi/agent/pi-control.json:
#   url -> your pi-control server (ws:// or wss://)
#   key -> the server's PI_REMOTE_SERVER_KEY
```

Start Pi — on link you'll see `pi-remote linked — passcode: XXXXXX` and a
persistent status line. Passcode shown there is what you type in the phone
UI.

### Config fields (`~/.pi/agent/pi-control.json`)

| Field | Required | Meaning |
|---|---|---|
| `url` | yes | Server address, `ws://host:port` or `wss://host:port`. `/ws/pi` is appended if no path. |
| `key` | yes | The server's `PI_REMOTE_SERVER_KEY`. |
| `passcodeFile` | no | File the 6-char passcode is written to (mode 600) on each link. Useful for headless runs. |
| `debug` | no | `true` logs connection diagnostics to Pi's stderr. |

Missing file, or missing `url`/`key` → the extension is an inert no-op.

### Overrides

- `PI_REMOTE_CONFIG=/path/to/other.json` — use a different config file
  (per-machine configs, testing).
- `pi --pi-remote-url wss://... --pi-remote-key ...` — per-run override of
  `url` / `key`.

### Type-check (dev)

```bash
cd extension
npm install        # typescript only
npm run typecheck
```

`tsconfig.json` is a dev convenience; it maps
`@earendil-works/pi-coding-agent` to a local install path — adjust the
`paths` entry if your Pi lives elsewhere.
