import {
	parseFrame,
	sendSafe,
	HANDSHAKE_TIMEOUT_MS,
	MAX_SCROLLBACK_ITEMS,
	STATES,
} from "./util.js";
import { tryHandshake } from "./handshake-limit.js";

/**
 * Handle one extension (/ws/pi) connection:
 *  - first frame must be auth (10s deadline)
 *  - then relay scrollback / items / status to the registry + viewers
 */
export function handlePiConnection(ws, registry, { log, ip } = {}) {
	let session = null;
	let authenticated = false;
	let closed = false;

	const kill = (code, reason) => {
		if (closed) return;
		closed = true;
		try {
			ws.close(code, reason);
		} catch {
			/* ignore */
		}
	};

	const handshakeTimer = setTimeout(() => {
		if (!authenticated) kill(4408, "handshake_timeout");
	}, HANDSHAKE_TIMEOUT_MS);

	const broadcast = (frame) => {
		if (!session) return;
		const payload = JSON.stringify(frame);
		for (const v of session.viewers) {
			sendSafe(v.ws, payload);
		}
	};

	ws.on("message", (data) => {
		const raw = data.toString("utf8");
		const parsed = parseFrame(raw);
		if (parsed.error) {
			sendSafe(ws, JSON.stringify({ type: "error", code: parsed.error }));
			if (parsed.error === "frame_too_large") kill(4409, "frame_too_large");
			return;
		}
		const msg = parsed.value;

		if (!authenticated) {
			if (msg.type !== "auth") {
				sendSafe(ws, JSON.stringify({ type: "auth_error", error: "auth_required_first" }));
				kill(4401, "auth_required");
				return;
			}
			if (msg.protocol !== 1) {
				sendSafe(ws, JSON.stringify({ type: "auth_error", error: "unsupported_protocol" }));
				kill(4404, "unsupported_protocol");
				return;
			}
			const key = typeof msg.key === "string" ? msg.key : "";
			if (!tryHandshake("pi", ip)) {
				sendSafe(ws, JSON.stringify({ type: "auth_error", error: "rate_limited" }));
				kill(4290, "rate_limited");
				return;
			}
			if (key.length < 8 || key.length > 512) {
				sendSafe(ws, JSON.stringify({ type: "auth_error", error: "bad_key" }));
				kill(4401, "bad_key");
				return;
			}
			// Key check is supplied by the server (timing-safe) to keep this module stateless.
			if (registry.serverKeyOk(key) === false) {
				sendSafe(ws, JSON.stringify({ type: "auth_error", error: "bad_key" }));
				kill(4401, "bad_key");
				return;
			}
			const meta = msg.session;
			if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
				sendSafe(ws, JSON.stringify({ type: "auth_error", error: "bad_session" }));
				kill(4401, "bad_session");
				return;
			}
			const res = registry.upsert(meta);
			if (!res.ok) {
				sendSafe(ws, JSON.stringify({ type: "auth_error", error: res.error }));
				kill(res.error === "too_many_sessions" ? 4503 : 4401, res.error);
				return;
			}
			session = res.session;
			session.extWs = ws;
			authenticated = true;
			clearTimeout(handshakeTimer);
			sendSafe(ws, JSON.stringify({
				type: "auth_ok",
				protocol: 1,
				session: { id: session.id, passcode: session.passcode },
			}));
			broadcast({
				type: "status",
				state: session.state,
				model: session.model,
				tool: session.tool,
				online: true,
			});
			// Tell every already-attached viewer to drop their view; the
			// extension will re-dump on the first scrollback/resync frame.
			broadcast({ type: "resync" });
			log?.info({ sessionId: session.id, host: session.hostname }, "extension linked");
			return;
		}

		switch (msg.type) {
			case "hb": {
				sendSafe(ws, JSON.stringify({ type: "hb", n: typeof msg.n === "number" ? msg.n : 0, t: Date.now() }));
				return;
			}
			case "scrollback": {
				if (!Array.isArray(msg.items) || msg.items.length > MAX_SCROLLBACK_ITEMS) {
					sendSafe(ws, JSON.stringify({ type: "error", code: "bad_scrollback" }));
					return;
				}
				if (msg.reset) {
					session.clearBuffer();
					broadcast({ type: "resync" });
				}
				session.touch();
				for (const rawItem of msg.items) {
					const item = session.putItem(rawItem);
					if (item) broadcast({ type: "item", item });
				}
				return;
			}
			case "item": {
				const item = session.putItem(msg.item);
				if (item) {
					broadcast({ type: "item", item });
				} else {
					sendSafe(ws, JSON.stringify({ type: "error", code: "bad_item" }));
				}
				return;
			}
			case "status": {
				if (typeof msg.state === "string" && STATES.has(msg.state)) session.state = msg.state;
				if (typeof msg.model === "string" && msg.model.length <= 128) session.model = msg.model;
				if (msg.tool === null || (typeof msg.tool === "string" && msg.tool.length <= 128)) {
					session.tool = msg.tool;
				}
				session.touch();
				broadcast({
					type: "status",
					state: session.state,
					model: session.model,
					tool: session.tool,
					online: true,
				});
				return;
			}
			case "ack": {
				return; // accepted; nothing to do in v1
			}
			default:
				sendSafe(ws, JSON.stringify({ type: "error", code: "unknown_frame" }));
		}
	});

	const onDisconnect = () => {
		if (closed) closed = true;
		clearTimeout(handshakeTimer);
		if (session) {
			if (session.extWs === ws) session.extWs = null;
			registry.markOffline(session);
			broadcast({
				type: "status",
				state: session.state,
				model: session.model,
				tool: null,
				online: false,
			});
			log?.info({ sessionId: session.id }, "extension disconnected");
		}
	};

	ws.on("close", onDisconnect);
	ws.on("error", onDisconnect);
}
