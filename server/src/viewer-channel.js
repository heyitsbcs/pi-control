import {
	parseFrame,
	sendSafe,
	genId,
	HANDSHAKE_TIMEOUT_MS,
	MAX_INPUT_TEXT_CHARS,
	passcodeEq,
} from "./util.js";
import { tryHandshake } from "./handshake-limit.js";


/**
 * Handle one phone/viewer (/ws/viewer) connection.
 * First frame: { type:"auth", session:"<id>", code:"<passcode>" }.
 */
export function handleViewerConnection(ws, registry, ip, { log } = {}) {
	let session = null;
	let viewer = null;
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

	ws.on("message", (data) => {
		const parsed = parseFrame(data.toString("utf8"));
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
			if (msg.protocol !== undefined && msg.protocol !== 1) {
				sendSafe(ws, JSON.stringify({ type: "auth_error", error: "unsupported_protocol" }));
				kill(4404, "unsupported_protocol");
				return;
			}
			if (!tryHandshake("viewer", ip)) {
				sendSafe(ws, JSON.stringify({ type: "auth_error", error: "rate_limited" }));
				kill(4290, "rate_limited");
				return;
			}
			const sid = typeof msg.session === "string" ? msg.session : "";
			session = registry.get(sid);
			if (!session) {
				sendSafe(ws, JSON.stringify({ type: "auth_error", error: "unknown_session" }));
				kill(4404, "unknown_session");
				return;
			}
			const code = typeof msg.code === "string" ? msg.code : "";
			if (code.length === 0 || code.length > 16) {
				sendSafe(ws, JSON.stringify({ type: "auth_error", error: "bad_passcode" }));
				kill(4401, "bad_passcode");
				return;
			}
			if (session.locked) {
				sendSafe(ws, JSON.stringify({ type: "auth_error", error: "locked" }));
				kill(4290, "locked");
				return;
			}
			if (!passcodeEq(code, session.passcode)) {
				session.tryPasscode(code); // record failure / lockout
				sendSafe(ws, JSON.stringify({ type: "auth_error", error: "bad_passcode" }));
				kill(4401, "bad_passcode");
				return;
			}
			viewer = {
				ws,
				ip,
				onSessionRemoved: (id) => {
					sendSafe(ws, JSON.stringify({ type: "session_removed", id }));
					kill(4502, "session_removed");
				},
			};
			if (!session.addViewer(viewer)) {
				sendSafe(ws, JSON.stringify({ type: "auth_error", error: "too_many_viewers" }));
				kill(4503, "too_many_viewers");
				return;
			}
			authenticated = true;
			clearTimeout(handshakeTimer);
			session.touch();
			sendSafe(ws, JSON.stringify({
				type: "auth_ok",
				session: { ...session.summary(), online: session.online },
				history: session.history(),
				status: {
					state: session.state,
					model: session.model,
					tool: session.tool,
					online: session.online,
				},
			}));
			log?.info({ sessionId: session.id, ip }, "viewer attached");
			return;
		}

		switch (msg.type) {
			case "hb": {
				sendSafe(ws, JSON.stringify({ type: "hb", n: typeof msg.n === "number" ? msg.n : 0, t: Date.now() }));
				return;
			}
			case "command": {
				const id = genId("cmd_");
				if (msg.action === "user_message") {
					const text = typeof msg.text === "string" ? msg.text.trim() : "";
					const deliverAs = msg.deliverAs === "steer" ? "steer" : "followUp";
					if (text.length === 0 || text.length > MAX_INPUT_TEXT_CHARS) {
						sendSafe(ws, JSON.stringify({ type: "error", code: "bad_command" }));
						return;
					}
					if (!session.online || !session.extWs) {
						sendSafe(ws, JSON.stringify({ type: "error", code: "offline", message: "extension is not connected" }));
						return;
					}
					sendSafe(ws, JSON.stringify({ type: "echo", id, action: "user_message", text, deliverAs }));
					sendSafe(session.extWs, JSON.stringify({ type: "remote_input", id, text, deliverAs }));
					return;
				}
				if (msg.action === "abort") {
					if (!session.online || !session.extWs) {
						sendSafe(ws, JSON.stringify({ type: "error", code: "offline", message: "extension is not connected" }));
						return;
					}
					sendSafe(ws, JSON.stringify({ type: "echo", id, action: "abort" }));
					sendSafe(session.extWs, JSON.stringify({ type: "remote_abort", id }));
					return;
				}
				sendSafe(ws, JSON.stringify({ type: "error", code: "bad_command" }));
				return;
			}
			case "request_scrollback": {
				if (session.online && session.extWs) {
					sendSafe(session.extWs, JSON.stringify({ type: "request_scrollback" }));
				} else {
					sendSafe(ws, JSON.stringify({ type: "error", code: "offline" }));
				}
				return;
			}
			default:
				sendSafe(ws, JSON.stringify({ type: "error", code: "unknown_frame" }));
		}
	});

	const onDisconnect = () => {
		if (closed) closed = true;
		clearTimeout(handshakeTimer);
		if (session && viewer) {
			session.removeViewer(viewer);
			session.touch();
			log?.info({ sessionId: session.id, ip }, "viewer detached");
		}
	};

	ws.on("close", onDisconnect);
	ws.on("error", onDisconnect);
}

