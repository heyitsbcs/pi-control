/* pi-control web UI — vanilla JS, no dependencies, no external assets.
 * All user/server content is rendered via textContent (never innerHTML). */

"use strict";

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls) => {
	const e = document.createElement(tag);
	if (cls) e.className = cls;
	return e;
};

const LS_KEY = "pi-control:key";
const codeKeyFor = (id) => "pi-control:code:" + id;

const state = {
	key: localStorage.getItem(LS_KEY) || "",
	sessionId: null,
	ws: null,
	wsTimer: null,
	hbTimer: null,
	items: new Map(), // id -> item
	deferredResync: false, // resync pending while the user is mid-drag
	resyncFlushTimer: null, // interval that flushes deferredResync
	retry: 1,
	connected: false,
	pendingEcho: null,
};

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function apiSessions() {
	const res = await fetch("/api/sessions", {
		headers: { Authorization: "Bearer " + state.key },
	});
	if (res.status === 401) throw new Error("bad key");
	if (!res.ok) throw new Error("server error");
	const data = await res.json();
	return data.sessions || [];
}

// ---------------------------------------------------------------------------
// Router / screens
// ---------------------------------------------------------------------------
function show(screenId) {
	for (const s of document.querySelectorAll(".screen")) s.classList.add("hidden");
	$(screenId).classList.remove("hidden");
}

function route() {
	clearTimers();
	const hash = location.hash || "#/key";
	if (hash.startsWith("#/session/")) {
		state.sessionId = decodeURIComponent(hash.slice("#/session/".length));
		show("#screen-session");
		openSession();
	} else if (hash === "#/sessions") {
		show("#screen-list");
		renderList();
	} else {
		show("#screen-key");
	}
}

function clearTimers() {
	if (state.wsTimer) { clearTimeout(state.wsTimer); state.wsTimer = null; }
	if (state.hbTimer) { clearInterval(state.hbTimer); state.hbTimer = null; }
}

function disconnectWs() {
	if (state.wsTimer) { clearTimeout(state.wsTimer); state.wsTimer = null; }
	if (state.hbTimer) { clearInterval(state.hbTimer); state.hbTimer = null; }
	if (state.ws) {
		state.ws.onclose = null;
		state.ws.onerror = null;
		state.ws.onmessage = null;
		try { state.ws.close(); } catch { /* ignore */ }
		state.ws = null;
	}
	state.connected = false;
}

// ---------------------------------------------------------------------------
// Key screen
// ---------------------------------------------------------------------------
$("#form-key").addEventListener("submit", async (e) => {
	e.preventDefault();
	state.key = $("#key-input").value.trim();
	localStorage.setItem(LS_KEY, state.key);
	$("#key-error").classList.add("hidden");
	try {
		await apiSessions();
		location.hash = "#/sessions";
	} catch (err) {
		const msg = $("#key-error");
		msg.textContent = err.message === "bad key"
			? "That key was rejected. Check PI_REMOTE_SERVER_KEY and try again."
			: "Could not reach the server. " + err.message;
		msg.classList.remove("hidden");
	}
});

$("#btn-logout").addEventListener("click", () => {
	localStorage.removeItem(LS_KEY);
	for (const k of Object.keys(localStorage)) {
		if (k.startsWith("pi-control:code:")) localStorage.removeItem(k);
	}
	state.key = "";
	location.hash = "#/key";
});

// ---------------------------------------------------------------------------
// Session list
// ---------------------------------------------------------------------------
async function renderList() {
	try {
		const sessions = await apiSessions();
		const cards = $("#session-cards");
		cards.replaceChildren();
		$("#list-empty").classList.toggle("hidden", sessions.length > 0);
		$("#list-count").textContent = sessions.length
			? sessions.length + (sessions.length === 1 ? " session" : " sessions")
			: "";
		for (const s of sessions) {
			const card = el("div", "card session-card");
			card.tabIndex = 0;
			const open = () => { location.hash = "#/session/" + encodeURIComponent(s.id); };
			card.addEventListener("click", open);
			card.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });

			const top = el("div", "sc-top");
			const dot = el("span", "dot " + (s.state === "offline" ? "offline" : s.state === "running" ? "running" : "idle"));
			const title = el("div", "sc-title");
			title.textContent = s.title || s.id.slice(0, 12);
			top.append(dot, title);

			const sub = el("div", "sc-sub");
			sub.textContent = [s.hostname, s.cwd].filter(Boolean).join(" · ");
			const meta = el("div", "sc-meta");
			const parts = [];
			if (s.model) parts.push(s.model);
			if (s.state === "running" && s.tool) parts.push("running " + s.tool + "…");
			parts.push(relTime(s.lastActivity));
			meta.textContent = parts.join(" · ");

			card.append(top, sub, meta);
			cards.append(card);
		}
	} catch (err) {
		if (err.message === "bad key") {
			state.key = "";
			location.hash = "#/key";
			return;
		}
		$("#list-count").textContent = "refresh failed — retrying";
	}
}

function relTime(ts) {
	if (!ts) return "";
	const d = Date.now() - ts;
	if (d < 15_000) return "just now";
	if (d < 60_000) return Math.floor(d / 1000) + "s ago";
	if (d < 3_600_000) return Math.floor(d / 60_000) + "m ago";
	if (d < 86_400_000) return Math.floor(d / 3_600_000) + "h ago";
	return Math.floor(d / 86_400_000) + "d ago";
}

// ---------------------------------------------------------------------------
// Session screen + viewer websocket
// ---------------------------------------------------------------------------
$("#btn-back").addEventListener("click", () => { location.hash = "#/sessions"; });

function openSession() {
	disconnectWs();
	state.items.clear();
	$("#transcript").replaceChildren();
	$("#live-view").classList.add("hidden");
	$("#passcode-gate").classList.remove("hidden");
	$("#session-title").textContent = "session";
	$("#session-sub").textContent = "";
	$("#status-text").textContent = "connecting…";
	setStatusDot("idle");
	$("#passcode-input").value = localStorage.getItem(codeKeyFor(state.sessionId)) || "";
	$("#passcode-error").classList.add("hidden");
}

$("#form-passcode").addEventListener("submit", (e) => {
	e.preventDefault();
	const code = $("#passcode-input").value.trim();
	if (!code) return;
	localStorage.setItem(codeKeyFor(state.sessionId), code);
	connectViewer(code);
});

function wsUrl() {
	const proto = location.protocol === "https:" ? "wss" : "ws";
	return proto + "://" + location.host + "/ws/viewer";
}

function connectViewer(code) {
	disconnectWs();
	console.log("[ui] dial", wsUrl(), "session=", state.sessionId, "code.len=", code ? code.length : 0);
	const ws = new WebSocket(wsUrl());
	state.ws = ws;
	const fail = (message) => {
		console.log("[ui] FAIL", message, "readyState=", ws.readyState);
		const p = $("#passcode-error");
		p.textContent = message;
		p.classList.remove("hidden");
	};

	state.wsTimer = setTimeout(() => {
		if (ws.readyState !== WebSocket.OPEN) {
			fail("No response from server. Check your connection.");
			try { ws.close(); } catch { /* ignore */ }
		}
	}, 8000);

	ws.onopen = () => {
		console.log("[ui] OPEN -> auth", state.sessionId);
		ws.send(JSON.stringify({ protocol: 1, type: "auth", session: state.sessionId, code }));
	};
	ws.onmessage = (ev) => {
		let msg;
		try { msg = JSON.parse(ev.data); } catch { return; }
		console.log("[ui] msg", msg.type, msg.error || "");
		state.retry = 1;
		handleViewerMessage(msg);
	};
	ws.onclose = (e) => {
		console.log("[ui] CLOSE", e.code, e.reason || "");
		if (state.ws !== ws) return; // superseded
		state.connected = false;
		if (state.sessionId !== null && $("#live-view").classList.contains("hidden")) {
			fail("Connection failed.");
			return;
		}
		// Reconnect loop with backoff (keeps stored code).
		if (state.sessionId !== null) {
			const delay = Math.min(10_000, state.retry * 1000);
			state.retry += 1;
			setStatusText("reconnecting…");
			setStatusDot("offline");
			state.wsTimer = setTimeout(() => {
				if (state.sessionId !== null && !state.connected) connectViewer(code);
			}, delay);
		}
	};
	ws.onerror = () => { console.log("[ui] WS error event"); /* onclose handles it */ };
}

function handleViewerMessage(msg) {
	switch (msg.type) {
		case "auth_ok": {
			$("#passcode-gate").classList.add("hidden");
			$("#live-view").classList.remove("hidden");
			state.connected = true;
			const s = msg.session || {};
			$("#session-title").textContent = s.title || state.sessionId.slice(0, 12);
			$("#session-sub").textContent = [s.hostname, s.cwd].filter(Boolean).join(" · ");
			for (const item of msg.history || []) upsertItem(item);
			applyStatus(msg.status);
			if (state.hbTimer) clearInterval(state.hbTimer);
			state.hbTimer = setInterval(() => {
				if (state.ws && state.ws.readyState === WebSocket.OPEN) {
					state.ws.send(JSON.stringify({ type: "hb", n: Date.now() }));
				}
			}, 25_000);
			requestScrollback();
			$("#command-input").focus?.();
			break;
		}
		case "auth_error": {
			const messages = {
				bad_passcode: "Wrong passcode. It is set in the extension config (passcode in ~/.pi/agent/pi-control.json) or shown in the Pi terminal status line (pi-control).",
				unknown_session: "This session is no longer known to the server. Go back and refresh.",
				locked: "Too many wrong attempts — this session is locked for 60 seconds.",
				rate_limited: "Too many connection attempts from this device. Try again shortly.",
				too_many_viewers: "Too many viewers on this session.",
				auth_required_first: "Connection protocol error.",
				unsupported_protocol: "Protocol mismatch — update the server or client.",
			};
			$("#passcode-error").textContent = messages[msg.error] || ("Connection error: " + msg.error);
			$("#passcode-error").classList.remove("hidden");
			break;
		}
		case "resync": {
			// Transcript rebuild. While the user is mid-drag (or wheel-
			// reading) defer the clear so the view never jumps under
			// their finger; the streaming re-dump items ("item" case
			// below) flush it as soon as it is safe.
			if (isUserScrolling()) {
				state.deferredResync = true;
				if (!state.resyncFlushTimer) {
					state.resyncFlushTimer = setInterval(() => {
						if (!state.deferredResync) {
							clearInterval(state.resyncFlushTimer);
							state.resyncFlushTimer = null;
							return;
						}
						if (!isUserScrolling()) flushDeferredResync();
					}, 250);
				}
			} else {
				state.items.clear();
				$("#transcript").replaceChildren();
			}
			break;
		}
		case "item": {
			if (state.deferredResync && !isUserScrolling()) flushDeferredResync();
			upsertItem(msg.item);
			break;
		}
		case "status": {
			applyStatus(msg);
			break;
		}
		case "echo": {
			if (msg.action === "user_message") {
				if (state.pendingEcho) { clearTimeout(state.pendingEcho); state.pendingEcho = null; }
				setStatusText("message sent — waiting for Pi…");
			}
			if (msg.action === "abort") setStatusText("stop requested…");
			break;
		}
		case "error": {
			const messages = {
				offline: "Pi is not connected right now — try again when it comes back.",
				bad_command: "That message could not be sent (too long?).",
			};
			const text = messages[msg.code] || ("Server error: " + msg.code);
			if (msg.code !== "offline") {
				$("#command-input").classList.add("shake");
				setTimeout(() => $("#command-input").classList.remove("shake"), 400);
			}
			setStatusText(text);
			break;
		}
		case "session_removed": {
			setStatusText("session removed");
			setStatusDot("offline");
			setTimeout(() => { location.hash = "#/sessions"; }, 1200);
			break;
		}
		case "hb": {
			break;
		}
	}
}

function applyStatus(st) {
	if (!st) return;
	const online = st.online !== false;
	const stateName = online ? st.state || "idle" : "offline";
	if (stateName === "offline") setStatusDot("offline");
	else if (stateName === "running") setStatusDot("running");
	else if (stateName === "waiting_user") setStatusDot("waiting");
	else setStatusDot("idle");

	if (!online) setStatusText("offline — Pi is not connected");
	else if (stateName === "running" && st.tool) setStatusText("running · " + st.tool + "…");
	else if (stateName === "running") setStatusText("working…");
	else if (stateName === "waiting_user") setStatusText("waiting for input");
	else setStatusText("idle");

	$("#status-model").textContent = st.model || "";
}

function setStatusDot(kind) {
	const d = $("#status-dot");
	d.className = "dot " + kind;
}

function setStatusText(text) {
	$("#status-text").textContent = text;
}

function requestScrollback() {
	if (state.ws && state.ws.readyState === WebSocket.OPEN) {
		state.ws.send(JSON.stringify({ type: "request_scrollback" }));
	}
}

// ---------------------------------------------------------------------------
// Transcript rendering
// ---------------------------------------------------------------------------
function upsertItem(item) {
	if (!item || typeof item.id !== "string") return;
	state.items.set(item.id, item);
	const container = $("#transcript");
	let node = container.querySelector('[data-item-id="' + cssEsc(item.id) + '"]');
	if (!node) {
		node = renderItem(item);
		container.append(node);
	} else {
		renderInto(node, item);
	}
	if (!isUserScrolling()) scrollToBottom();
	else showJumpIfAway();
}

function cssEsc(s) {
	return (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&");
}

function renderItem(item) {
	const node = document.createElement(toolNode(item) ? "details" : "div");
	node.dataset.itemId = item.id;
	if (toolNode(item)) {
		node.className = "msg tool";
		const summary = el("summary", "tool-summary");
		summary.append(el("span", "tool-name"), el("span", "tool-state"));
		node.append(summary, el("pre", "tool-body"));
		node.open = false;
	} else if (item.role === "user") {
		node.className = "msg user";
	} else if (item.kind === "compaction") {
		node.className = "msg compaction";
	} else if (item.role === "system" || item.role === "info") {
		node.className = "msg sysinfo";
	} else {
		node.className = "msg assistant";
	}
	renderInto(node, item);
	return node;
}

function toolNode(item) {
	return item.role === "tool";
}

function renderInto(node, item) {
	node.dataset.itemTs = item.ts || "";
	if (toolNode(item)) {
		const summary = node.querySelector(".tool-summary");
		const body = node.querySelector(".tool-body");
		const name = summary.querySelector(".tool-name");
		const st = summary.querySelector(".tool-state");
		name.textContent = item.title || (item.kind === "tool_result" ? "result" : "tool");
		st.textContent = item.kind === "error" ? "error" : item.kind === "tool_result" ? "done" : "…";
		body.textContent = item.text || "";
		node.classList.toggle("error", item.kind === "error");
		node.classList.toggle("result", item.kind === "tool_result");
		return;
	}
	let text = item.text || "";
	if (item.role === "user" && text.startsWith("[remote] ")) {
		node.classList.add("remote");
		text = text.slice("[remote] ".length);
	} else {
		node.classList.remove("remote");
	}
	node.textContent = text;
}

/** The element that actually scrolls. #transcript is not a scroll
 * container (no height/overflow of its own) — the document is. */
function pageScroller() {
	return document.scrollingElement || document.documentElement;
}

function scrollToBottom() {
	const t = pageScroller();
	t.scrollTop = t.scrollHeight;
	$("#btn-jump").classList.add("hidden");
}

function showJumpIfAway() {
	const t = pageScroller();
	const away = t.scrollHeight - t.scrollTop - t.clientHeight > 160;
	$("#btn-jump").classList.toggle("hidden", !away);
}

// -- Auto-pin to the latest -------------------------------------------------
// The view always follows the newest item, except while the user is
// actively scrolling (finger drag / trackpad / wheel). The moment
// scrolling stops, the next item snaps the view back to the bottom.
// Resyncs are similarly deferred while mid-drag (see the "resync" case).

let userScrolling = false; // finger/pointer drag in progress
let userScrollTimer = null; // drops userScrolling shortly after the last touchmove
let lastWheelAt = 0;
let lastTouchAt = 0;

function isUserScrolling() {
	if (userScrolling) return true;
	return Date.now() - lastWheelAt < 400; // wheel/trackpad settle window
}

function setUserScrolling(on) {
	if (userScrolling === on) return;
	userScrolling = on;
	if (!on) showJumpIfAway(); // reflect current position in the jump button
}

const transcriptEl = $("#transcript");
transcriptEl.addEventListener("touchstart", () => { lastTouchAt = Date.now(); }, { passive: true });
transcriptEl.addEventListener("touchmove", () => {
	lastTouchAt = Date.now();
	setUserScrolling(true);
	clearTimeout(userScrollTimer);
	// consider the drag done shortly after the finger stops moving,
	// even before touchend fires
	userScrollTimer = setTimeout(() => setUserScrolling(false), 250);
}, { passive: true });
transcriptEl.addEventListener("touchend", () => setUserScrolling(false), { passive: true });
transcriptEl.addEventListener("touchcancel", () => setUserScrolling(false), { passive: true });
transcriptEl.addEventListener("wheel", () => { lastWheelAt = Date.now(); }, { passive: true });
window.addEventListener("wheel", () => { lastWheelAt = Date.now(); }, { passive: true });
transcriptEl.addEventListener("mousedown", () => {
	if (Date.now() - lastTouchAt < 700) return; // synthetic post-tap mouse event
	setUserScrolling(true);
});
window.addEventListener("mouseup", () => setUserScrolling(false));

/**
 * Apply a resync that was deferred because the user was mid-drag:
 * clear, rebuild, and land on the latest.
 */
function flushDeferredResync() {
	state.deferredResync = false;
	if (state.resyncFlushTimer) {
		clearInterval(state.resyncFlushTimer);
		state.resyncFlushTimer = null;
	}
	state.items.clear();
	$("#transcript").replaceChildren();
	scrollToBottom();
}

$("#btn-jump").addEventListener("click", scrollToBottom);
window.addEventListener("scroll", showJumpIfAway);

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------
const commandInput = $("#command-input");

function autoGrow() {
	commandInput.style.height = "auto";
	commandInput.style.height = Math.min(commandInput.scrollHeight, 140) + "px";
}
commandInput.addEventListener("input", autoGrow);
commandInput.addEventListener("keydown", (e) => {
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		$("#form-command").requestSubmit();
	}
});

$("#form-command").addEventListener("submit", (e) => {
	e.preventDefault();
	const text = commandInput.value.trim();
	if (!text) return;
	if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
		setStatusText("not connected");
		return;
	}
	const deliverAs = $("#deliver-as").value === "steer" ? "steer" : "followUp";
	state.ws.send(JSON.stringify({
		type: "command",
		action: "user_message",
		text,
		deliverAs,
	}));
	commandInput.value = "";
	autoGrow();
	// Optimistic fallback if the server echo is lost.
	state.pendingEcho = setTimeout(() => {
		if (state.pendingEcho) {
			state.pendingEcho = null;
			setStatusText("message sent — waiting for Pi…");
		}
	}, 1200);
});

$("#btn-abort").addEventListener("click", () => {
	if (state.ws && state.ws.readyState === WebSocket.OPEN) {
		state.ws.send(JSON.stringify({ type: "command", action: "abort" }));
		setStatusText("stop requested…");
	}
});

// ---------------------------------------------------------------------------
// Topbar
// ---------------------------------------------------------------------------
$("#btn-refresh").addEventListener("click", () => {
	if (location.hash === "#/sessions") renderList();
	else route();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function boot() {
	$("#btn-logout").classList.toggle("hidden", !state.key);
	if (state.key) {
		apiSessions().then(() => {
			if (!location.hash || location.hash === "#/") location.hash = "#/sessions";
		}).catch(() => {
			/* stay on key screen */
		});
	}
	window.addEventListener("hashchange", route);
	route();
}

// Poll the list while it is visible.
setInterval(() => {
	if (location.hash === "#/sessions" && !document.hidden) renderList();
}, 5000);

boot();
