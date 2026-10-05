# pi-control — Security audit

Scope: `server/` (Node.js relay + web UI) and `extension/` (Pi extension).
Threat model: an untrusted network (internet) between the desktop/laptop and
the phone; the operator's two secrets (server key, session passcode) are the
trust boundary. A single-user tool: the server key is held only by the
operator.

## Results

| # | Area | Finding | Severity | Status |
|---|------|---------|----------|--------|
| 1 | WS auth | Server key + passcode compared with `crypto.timingSafeEqual` | — | ✅ implemented |
| 2 | Passcode | 6 chars from 28-char unambiguous alphabet (~480 billion combos); per-session lockout after 5 failures (60 s) | — | ✅ implemented |
| 3 | Rate limit | Per-IP handshake limiter on **both** channels (viewer 20/min, pi 60/min) | Med | ✅ fixed in audit (pi channel had none) |
| 4 | XFF spoofing | `X-Forwarded-For` trusted unconditionally → client could bypass per-IP limits | High | ✅ fixed in audit: only honored with `PI_REMOTE_TRUST_PROXY=1` |
| 5 | Frame limits | 256 KB max frame (enforced twice: ws `maxPayload` + `parseFrame`), 200 KB item text, 16 KB remote input, 2000 items/scrollback | — | ✅ implemented |
| 6 | Resource caps | max 32 sessions, 1000-item ring buffer, 8 viewers/session, 10 s handshake deadline, 30 s WS keepalive | — | ✅ implemented |
| 7 | Web CSP | `connect-src ws: wss:` allowed any endpoint | Low | ✅ fixed in audit: tightened to `connect-src 'self'` |
| 8 | XSS | Web UI renders all server/user content via `textContent`/DOM APIs only; no `innerHTML`, no external assets, `default-src 'none'` | — | ✅ verified |
| 9 | Headers | `nosniff`, `Referrer-Policy: no-referrer`, HSTS (when TLS), strict CSP | — | ✅ implemented |
| 10 | Secrets in transit | Key/passcode sent in first WS text frame — **never in URL query** (log-safe) | — | ✅ verified |
| 11 | Secrets in logs | Server logs only session id / host / ip; never keys, passcodes, or transcript content | — | ✅ verified |
| 12 | TLS | `PI_REMOTE_TLS_CERT/KEY` serve HTTPS/WSS directly; otherwise run behind a reverse proxy (Caddy/nginx) | High (if ws:// over LAN/internet) | ⚠️ operator responsibility — **use TLS in production** |
| 13 | Passcode file (extension) | `PI_REMOTE_PASSCODE_FILE` written world-readable on file reuse | Med | ✅ fixed in audit: explicit `chmod 600` after write |
| 14 | Static serving | Fixed path→file map (no traversal); API is GET-only, 405 otherwise | — | ✅ verified |
| 15 | API auth | `/api/sessions*` require `Authorization: Bearer <key>` (timing-safe); 401 otherwise | — | ✅ verified (harness tests) |
| 16 | Input injection | Remote text goes through `pi.sendUserMessage` (same path as typed input); 16 KB cap both ends; extension/truncation | — | ✅ verified (e2e steer test) |
| 17 | Extension ctx safety | All `ctx`/`pi` accesses guarded against post-session staleness (no crashes on shutdown races) | Med | ✅ fixed during e2e (crash found & fixed) |
| 18 | Docker | Non-root `node` user, `npm ci`-equivalent install, pinned `node:22-alpine` | — | ✅ implemented |

### Accepted residual risks (documented)

- **Server key ⇒ full control.** Anyone with the server key can link
  sessions, list them, and obtain every passcode. This is by design (it is
  the operator secret). Keep it secret; rotate it to evict.
- **Session id chosen by the extension.** With the server key, a client can
  register under any session id, including one already linked (takes over the
  relay). Single-user trust model makes this acceptable; a multi-user product
  would need per-extension identity (certs or per-machine keys).
- **Passcode lockout is per-session, not per-IP.** An attacker who knows a
  session id can lock out the legitimate user for 60 s (self-clearing DoS).
- **Timing-safe compare leaks length** (standard `timingSafeEqual` behavior)
  on key mismatch. Negligible given key entropy.
- **No replay protection.** v1 has no per-frame nonces; replace-by-id items
  and session-scoped passcodes bound the impact. `seq` fields are already
  on the wire for a future gap-detection upgrade.
- **Web UI stores key + passcodes in `localStorage`** for convenience; the
  lock icon clears them. A shared device should use a private window.

## Transport guidance (production)

1. **Prefer TLS.** Either:
   - direct: `PI_REMOTE_TLS_CERT=/path/cert.pem PI_REMOTE_TLS_KEY=/path/key.pem`, or
   - reverse proxy: Caddy/nginx terminating TLS and proxying `http://localhost:8787`
     **and** the `Upgrade`/`Connection` headers for `/ws/pi` and `/ws/viewer`.
     Set `PI_REMOTE_TRUST_PROXY=1` so per-IP limits see the real client IP.
2. Bind `HOST=127.0.0.1` when behind a proxy.
3. Use a long random key: `openssl rand -hex 32`.

## Test coverage for security behavior

- `test/harness.mjs`: bad/missing key → 401/`auth_error`; wrong passcode →
  rejected; repeated failures → session lock (correct passcode also rejected
  while locked); unknown session; oversized command rejected; malformed /
  oversized frames handled without crash; offline command rejection.
- `test/extension-e2e.mjs`: passcode delivery file permissions path, real
  auth round-trips, abort and steer only from authenticated viewers.
