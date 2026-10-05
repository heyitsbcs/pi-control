/**
 * pi-remote — link a Pi session to a pi-control server.
 *
 * Forwards the full session scrollback + live activity to a pi-control
 * server, and accepts remote input that is injected exactly like typed
 * terminal input (pi.sendUserMessage with steer/followUp semantics).
 *
 * Configuration (env vars; the extension is a no-op without both):
 *   PI_REMOTE_URL  — ws:// or wss:// host:port of the pi-control server
 *   PI_REMOTE_KEY  — the server's PI_REMOTE_SERVER_KEY
 *   PI_REMOTE_PASSCODE_FILE (optional) — headless passcode delivery:
 
 *
 * On successful link, the session passcode is shown in the TUI (status
 * line + one-time notification). Use the passcode in the pi-control web UI.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface Item {
	id: string;
	role: "user" | "assistant" | "tool" | "system" | "info";
	kind?: "text" | "tool_call" | "tool_result" | "error" | "compaction";
	title?: string;
	text: string;
	ts: number;
}

type ConnectionState = "disconnected" | "connecting" | "linked";

interface Config {
	url: string;
	key: string;
	passcodeFile?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const MAX_TOOL_TEXT = 8_000;
const MAX_ITEM_TEXT = 200_000;
const CHUNK_FRAME_BYTES = 180_000;
const FLUSH_INTERVAL_MS = 125;

function debug(...args: unknown[]) {
	if (process.env.PI_REMOTE_DEBUG) console.error("[pi-remote]", ...args);
}

function truncate(s: string, max: number): string {
	return s.length <= max ? s : s.slice(0, max) + "…";
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((b): b is { type: string; text: string } => !!b && b.type === "text" && typeof (b as any).text === "string")
			.map((b) => b.text)
			.join("\n");
	}
	return "";
}

function assistantText(message: any): string {
	if (message?.errorMessage) return `⚠ ${message.errorMessage}`;
	return extractText(message?.content);
}

function summarizeArgs(args: unknown): string {
	try {
		const s = JSON.stringify(args ?? {});
		return truncate(s, 2_000);
	} catch {
		return String(args);
	}
}

function toolResultText(result: unknown): string {
	const r = result as any;
	if (r == null) return "";
	if (typeof r === "string") return r;
	if (Array.isArray(r?.content)) return extractText(r.content);
	if (typeof r?.content === "string") return r.content;
	if (typeof r === "object") {
		try {
			return JSON.stringify(r);
		} catch {
			return String(r);
		}
	}
	return String(r);
}

// ---------------------------------------------------------------------------
// Remote link
// ---------------------------------------------------------------------------
class RemoteLink {
	private ws: WebSocket | null = null;
	private state: ConnectionState = "disconnected";
	private passcode: string | null = null;
	private linkedSessionId: string | null = null;
	private config: Config;
	private pi: ExtensionAPI;
	private ctx: ExtensionContext | null = null;

	private seq = 0;
	inputSeq = 0;
	private reconnectDelay = 1_000;
	private stopRequested = true;
	private lastState: "idle" | "running" | "waiting_user" = "idle";
	private flushTimer: NodeJS.Timeout | null = null;
	private dirtyItems = new Map<string, Item>();
	private currentAssistantId: string | null = null;
	private hbN = 0;
	private hbTimer: NodeJS.Timeout | null = null;
	private notifiedPasscode = false;
	toolState = new Map<string, { text: string }>();

	constructor(pi: ExtensionAPI, config: Config) {
		this.pi = pi;
		this.config = config;
	}

	get state_() {
		return this.state;
	}
	get passcode_() {
		return this.passcode;
	}

	setContext(ctx: ExtensionContext) {
		this.ctx = ctx;
	}

	// -- lifecycle -----------------------------------------------------------

	start() {
		this.stopRequested = false;
		this.passcode = null;
		this.linkedSessionId = null;
		this.connect();
	}

	/** (Re)start if not currently linked or connecting. */
	restartIfNeeded() {
		if (this.state === "disconnected") this.start();
	}

	stop() {
		this.stopRequested = true;
		this.ctx = null;
		this.flushNow();
		this.clearTimers();
		try {
			this.ws?.close();
		} catch {
			/* ignore */
		}
		this.ws = null;
		this.state = "disconnected";
		this.updateStatus();
	}

	private clearTimers() {
		if (this.flushTimer) {
			clearInterval(this.flushTimer);
			this.flushTimer = null;
		}
		if (this.hbTimer) {
			clearInterval(this.hbTimer);
			this.hbTimer = null;
		}
	}

	private connect() {
		if (this.stopRequested) return;
		this.state = "connecting";
		debug(`connect -> ${this.config.url}`);
		this.updateStatus();

		let ws: WebSocket;
		try {
			ws = new WebSocket(this.config.url);
		} catch (err: any) {
			this.scheduleReconnect(`bad url: ${err?.message}`);
			return;
		}
		this.ws = ws;

		ws.addEventListener("open", () => {
			debug("ws open; sending auth");
			this.sendRaw({
				type: "auth",
				protocol: 1,
				key: this.config.key,
				session: this.sessionMeta(),
			});
		});

		ws.addEventListener("message", (ev) => {
			let msg: any;
			try {
				msg = JSON.parse(String(ev.data));
			} catch {
				return;
			}
			debug(`recv ${msg?.type}`);
			this.onMessage(msg);
		});

		const onDown = (ev?: any) => {
			debug(`ws closed code=${ev?.code} reason=${ev?.reason}`);
			this.state = "disconnected";
			this.currentAssistantId = null;
			this.toolState.clear();
			this.updateStatus();
			this.scheduleReconnect();
		};
		ws.addEventListener("close", onDown);
		ws.addEventListener("error", (ev: any) => {
			debug(`ws error: ${ev?.error?.message || ev?.message || "unknown"}`);
			/* close follows */
		});
	}

	private scheduleReconnect(reason?: string) {
		if (this.stopRequested) return;
		const delay = this.reconnectDelay;
		this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
		setTimeout(() => this.connect(), delay).unref?.();
		if (reason) this.notify(`pi-remote: ${reason}`);
	}

	// -- session identity ------------------------------------------------------

	private sessionMeta() {
		let cwd = process.cwd();
		try {
			if (this.ctx?.cwd) cwd = this.ctx.cwd;
		} catch {
			/* ctx stale */
		}
		const sm = this.ctx?.sessionManager as any;
		let id = "";
		try {
			id = sm?.getSessionId?.() ?? "";
		} catch {
			/* ignore */
		}
		if (!id) id = "sid-" + crypto.randomBytes(6).toString("hex");
		let name = "";
		try {
			name = sm?.getSessionName?.() ?? "";
		} catch {
			/* ignore */
		}
		return {
			id,
			hostname: os.hostname(),
			cwd,
			name: name || undefined,
			client: "pi-extension",
		};
	}

	/** Re-link when the underlying pi session changed (new/resume/fork). */
	checkSessionChanged() {
		if (!this.passcode_) return;
		const meta = this.sessionMeta();
		if (meta.id !== this.linkedSessionId && this.linkedSessionId) {
			// fresh auth for the new session
			if (this.ws && this.ws.readyState === 1 /* OPEN */) {
				this.sendRaw({ type: "auth", protocol: 1, key: this.config.key, session: meta });
			}
		}
	}

	// -- incoming ---------------------------------------------------------------

	private onMessage(msg: any) {
		switch (msg?.type) {
			case "auth_ok": {
				const wasLinked = this.state === "linked";
				this.state = "linked";
				this.reconnectDelay = 1_000;
				this.passcode = String(msg.session?.passcode ?? "");
				this.linkedSessionId = String(msg.session?.id ?? "");
				if (!wasLinked) {
					this.notify(`pi-remote linked — passcode: ${this.passcode}`);
					this.writePasscodeFile();
					this.dumpScrollback();
					this.setStatus("idle");
					this.startHeartbeat();
				}
				this.updateStatus();
				break;
			}
			case "auth_error": {
				this.state = "disconnected";
				this.passcode = null;
				this.notify(`pi-remote: ${msg.error}`);
				try {
					this.ws?.close();
				} catch {
					/* ignore */
				}
				this.scheduleReconnect();
				break;
			}
			case "remote_input": {
				this.handleRemoteInput(String(msg.text ?? ""), msg.deliverAs === "steer" ? "steer" : "followUp");
				break;
			}
			case "remote_abort": {
				try {
					this.ctx?.abort?.();
				} catch {
					/* ctx stale */
				}
				break;
			}
			case "request_scrollback": {
				this.dumpScrollback();
				break;
			}
			case "hb": {
				break;
			}
			case "error": {
				// non-fatal; log only
				break;
			}
		}
	}

	private handleRemoteInput(text: string, deliverAs: "steer" | "followUp") {
		try {
			this.pi.sendUserMessage(truncate(text, 16_000), { deliverAs, expandPromptTemplates: true });
			// The input event below also fires for extension-injected text
			// (source "extension"); it renders the remote bubble.
		} catch (err: any) {
			this.notify(`pi-remote: could not inject input: ${err?.message}`);
		}
	}

	// -- outgoing ----------------------------------------------------------------

	private sendRaw(obj: unknown) {
		const ws = this.ws;
		if (ws && ws.readyState === 1 /* OPEN */) {
			try {
				ws.send(JSON.stringify(obj));
			} catch {
				/* ignore */
			}
		}
	}

	private startHeartbeat() {
		if (this.hbTimer) clearInterval(this.hbTimer);
		this.hbTimer = setInterval(() => {
			this.hbN += 1;
			this.sendRaw({ type: "hb", n: this.hbN });
		}, 25_000);
		this.hbTimer.unref?.();
	}

	setStatus(state: "idle" | "running" | "waiting_user", tool?: string | null) {
		this.lastState = state;
		this.sendRaw({
			type: "status",
			seq: ++this.seq,
			state,
			model: this.modelName(),
			tool: tool ?? null,
		});
	}

	/** Re-send the current state (e.g. after a model change). */
	refreshStatus() {
		this.setStatus(this.lastState);
	}

	private modelName(): string | undefined {
		const m = this.ctx?.model as any;
		return m ? `${m.provider}/${m.id}` : undefined;
	}

	/** Queue a transcript item for flush (replace-by-id). */
	queueItem(item: Item) {
		item.text = truncate(item.text, MAX_ITEM_TEXT);
		this.dirtyItems.set(item.id, item);
		this.flushSoon();
	}

	private flushSoon() {
		if (this.flushTimer) return;
		this.flushTimer = setInterval(() => this.flushDirty(), FLUSH_INTERVAL_MS);
		this.flushTimer.unref?.();
	}

	private flushDirty() {
		if (!this.dirtyItems.size) {
			if (this.flushTimer) {
				clearInterval(this.flushTimer);
				this.flushTimer = null;
			}
			return;
		}
		const items = [...this.dirtyItems.values()];
		this.dirtyItems.clear();
		for (const item of items) {
			this.sendRaw({ type: "item", seq: ++this.seq, item });
		}
		if (!this.dirtyItems.size && this.flushTimer) {
			clearInterval(this.flushTimer);
			this.flushTimer = null;
		}
	}

	/** Send pending items immediately (turn boundaries, shutdown). */
	flushNow() {
		if (this.flushTimer) {
			clearInterval(this.flushTimer);
			this.flushTimer = null;
		}
		if (this.dirtyItems.size) this.flushDirty();
	}

	/** Send the full scrollback in bounded chunks (first chunk resets). */
	dumpScrollback() {
		const items = this.buildScrollback();
		let chunk: Item[] = [];
		let chunkBytes = 2;
		const flushChunk = (reset: boolean) => {
			if (!chunk.length) return;
			this.sendRaw({ type: "scrollback", reset, items: chunk });
			chunk = [];
			chunkBytes = 2;
		};
		flushChunk(true);
		for (const item of items) {
			const size = JSON.stringify(item).length + 2;
			if (chunkBytes + size > CHUNK_FRAME_BYTES) flushChunk(false);
			chunk.push(item);
			chunkBytes += size;
		}
		flushChunk(false);
	}

	private buildScrollback(): Item[] {
		const items: Item[] = [];
		const sm = this.ctx?.sessionManager as any;
		if (!sm) return items;
		let entries: any[] = [];
		try {
			entries = sm.buildContextEntries?.() ?? sm.getEntries?.() ?? [];
		} catch {
			return items;
		}
		for (const entry of entries) {
			const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now();
			if (entry.type === "message") {
				const msg = entry.message;
				if (!msg) continue;
				if (msg.role === "user") {
					const text = extractText(msg.content);
					if (text) items.push({ id: entry.id, role: "user", text, ts });
				} else if (msg.role === "assistant") {
					const text = assistantText(msg);
					if (text) items.push({ id: entry.id, role: "assistant", text, ts });
				} else if (msg.role === "toolResult") {
					const text = truncate(toolResultText(msg.content), MAX_TOOL_TEXT);
					items.push({
						id: entry.id,
						role: "tool",
						kind: msg.isError ? "error" : "tool_result",
						title: msg.toolName ?? "tool",
						text,
						ts,
					});
				}
				// system messages are skipped (noise)
			} else if (entry.type === "compaction") {
				items.push({
					id: entry.id,
					role: "info",
					kind: "compaction",
					text: truncate(entry.summary ?? "context compacted", 400),
					ts,
				});
			} else if (entry.type === "custom_message" && entry.display) {
				const text = extractText(entry.content);
				if (text) items.push({ id: entry.id, role: "system", text, ts });
			}
		}
		return items;
	}

	// -- TUI --------------------------------------------------------------------

	private writePasscodeFile() {
		const file = this.config.passcodeFile;
		if (!file || !this.passcode) return;
		try {
			fs.writeFileSync(file, this.passcode + "\n", { mode: 0o600 });
			// writeFileSync mode only applies on creation; enforce on reuse.
			fs.chmodSync(file, 0o600);
		} catch {
			/* best-effort; TUI status line is the primary channel */
		}
	}

	private updateStatus() {
		const ctx = this.ctx;
		if (!ctx) return;
		let hasUI = false;
		try {
			hasUI = ctx.hasUI;
		} catch {
			// ctx stale after session replacement; drop the reference
			this.ctx = null;
			return;
		}
		if (!hasUI) return;
		try {
			if (this.state === "linked" && this.passcode) {
				ctx.ui.setStatus("pi-remote", `pi-remote: ● linked · code ${this.passcode}`);
			} else if (this.state === "connecting") {
				ctx.ui.setStatus("pi-remote", "pi-remote: ○ connecting…");
			} else {
				ctx.ui.setStatus("pi-remote", "pi-remote: ○ offline");
			}
		} catch {
			/* ignore */
		}
	}

	private notify(text: string) {
		try {
			this.ctx?.ui?.notify?.(text, this.state === "linked" ? "info" : "warning");
		} catch {
			/* ignore */
		}
	}
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------
export default function (pi: ExtensionAPI) {
	// CLI flags (optional override for env vars)
	try {
		pi.registerFlag("pi-remote-url", { description: "pi-control server URL (ws:// or wss://)", type: "string" });
		pi.registerFlag("pi-remote-key", { description: "pi-control server key", type: "string" });
	} catch {
		/* flags are best-effort */
	}

	let config: Config | null = null;
	let link: RemoteLink | null = null;

	const resolveConfig = (): Config | null => {
		if (config) return config;
		let url = "";
		let key = "";
		try {
			url = String(pi.getFlag("pi-remote-url") ?? "") || process.env.PI_REMOTE_URL || "";
			key = String(pi.getFlag("pi-remote-key") ?? "") || process.env.PI_REMOTE_KEY || "";
		} catch {
			url = process.env.PI_REMOTE_URL || "";
			key = process.env.PI_REMOTE_KEY || "";
		}
		url = url.trim();
		key = key.trim();
		if (!url || !key) return null;
		if (!/^wss?:\/\//.test(url)) {
			console.error(`[pi-remote] PI_REMOTE_URL must be ws:// or wss:// (got: ${url})`);
			return null;
		}
		try {
			const u = new URL(url);
			if (u.pathname === "/" || u.pathname === "") u.pathname = "/ws/pi";
			url = u.toString();
		} catch {
			console.error(`[pi-remote] PI_REMOTE_URL is not a valid URL: ${url}`);
			return null;
		}
		config = {
			url,
			key,
			passcodeFile: (process.env.PI_REMOTE_PASSCODE_FILE || "").trim() || undefined,
		};
		return config;
	};

	const ensureLink = (ctx: ExtensionContext): RemoteLink | null => {
		const cfg = resolveConfig();
		if (!cfg) return null;
		if (!link || (link as any).stopRequested === true && link.state_ === "disconnected") {
			link = new RemoteLink(pi, cfg);
		}
		link.setContext(ctx);
		return link;
	};

	// Handlers are registered immediately; each resolves the (lazily
	// created) link at fire time, and session_start triggers the first
	// link + connection.
	const wireEvents = (pi: ExtensionAPI) => {
		const withLink = (fn: (event: any, l: RemoteLink, ctx: ExtensionContext) => void) =>
			(event: any, ctx: ExtensionContext) => {
				const l = ensureLink(ctx);
				if (l) fn(event, l, ctx);
			};

			pi.on("session_start", withLink((event, l) => {
				debug(`session_start reason=${event?.reason}`);
				l.restartIfNeeded();
				l.checkSessionChanged();
			}));

			pi.on("session_info_changed", withLink((event, l, ctx) => {
				try {
					ctx.ui?.setStatus?.(
						"pi-remote",
						`pi-remote: ● linked · code ${l.passcode_ ?? "…"}${event.name ? ` · ${event.name}` : ""}`,
					);
				} catch {
					/* ignore */
				}
			}));

			pi.on("input", withLink((event, l) => {
				// User input (interactive, rpc, or extension-injected remote text).
				const text = event?.text || "";
				if (!text) return;
				const id = `in-${(l.inputSeq = (l.inputSeq ?? 0) + 1)}`;
				l.queueItem({
					id,
					role: "user",
					text: event.source === "extension" ? `[remote] ${truncate(text, 16_000)}` : truncate(text, 16_000),
					ts: Date.now(),
				});
			}));

			pi.on("agent_start", withLink((_e, l) => l.setStatus("running")));
			pi.on("agent_end", withLink((_e, l) => { l.flushNow(); l.setStatus("idle"); }));
			pi.on("agent_settled", withLink((_e, l) => { l.flushNow(); l.setStatus("idle"); }));

			pi.on("message_update", withLink((event, l) => {
				const msg: any = event.message;
				if (msg?.role !== "assistant") return;
				l.queueItem({ id: "a-stream", role: "assistant", text: assistantText(msg), ts: Date.now() });
			}));

			pi.on("message_end", withLink((event, l) => {
				const msg: any = event.message;
				if (msg?.role !== "assistant") return;
				const text = assistantText(msg);
				if (text) l.queueItem({ id: "a-stream", role: "assistant", text, ts: Date.now() });
				l.flushNow();
			}));

			pi.on("tool_execution_start", withLink((event, l) => {
				const id = `tool-${event.toolCallId}`;
				l.toolState.set(id, { text: summarizeArgs(event.args) });
				l.queueItem({
					id,
					role: "tool",
					kind: "tool_call",
					title: event.toolName,
					text: l.toolState.get(id)?.text ?? "",
					ts: Date.now(),
				});
				l.setStatus("running", event.toolName);
			}));

			pi.on("tool_execution_update", withLink((event, l) => {
				const id = `tool-${event.toolCallId}`;
				const partial = toolResultText(event.partialResult);
				const prev = l.toolState.get(id)?.text ?? "";
				const text = partial.length > prev.length ? partial : prev;
				l.toolState.set(id, { text });
				l.queueItem({
					id,
					role: "tool",
					kind: "tool_call",
					title: event.toolName,
					text: truncate(text, MAX_TOOL_TEXT),
					ts: Date.now(),
				});
			}));

			pi.on("tool_execution_end", withLink((event, l) => {
				const id = `tool-${event.toolCallId}`;
				l.toolState.delete(id);
				const text = truncate(toolResultText(event.result), MAX_TOOL_TEXT);
				l.queueItem({
					id,
					role: "tool",
					kind: event.isError ? "error" : "tool_result",
					title: event.toolName,
					text,
					ts: Date.now(),
				});
				l.setStatus("running");
			}));

			pi.on("session_compact", withLink((event, l) => {
				const e: any = event;
				l.queueItem({
					id: `compact-${Date.now()}`,
					role: "info",
					kind: "compaction",
					text: truncate(String(e?.compactionEntry?.summary ?? "context compacted"), 400),
					ts: Date.now(),
				});
			}));

			pi.on("model_select", withLink((_e, l) => l.refreshStatus()));

			pi.on("user_bash", withLink((event, l) => {
				l.queueItem({
					id: `bash-${Date.now()}`,
					role: "system",
					text: `! ${truncate(event.command, 500)}`,
					ts: Date.now(),
				});
			}));

			pi.on("session_shutdown", withLink((_e, l) => l.stop()));
	};

	wireEvents(pi);

	// Command: show link status
	try {
		pi.registerCommand("pi-remote", {
			description: "Show pi-remote link status and passcode",
			handler: async (_args, ctx) => {
				const l = ensureLink(ctx);
				if (!l) {
					ctx.ui.notify("pi-remote: not configured (set PI_REMOTE_URL and PI_REMOTE_KEY)", "warning");
					return;
				}
				if (l.state_ === "linked" && l.passcode_) {
					ctx.ui.notify(`pi-remote: linked · passcode ${l.passcode_} · ${config?.url}`, "info");
				} else {
					ctx.ui.notify(`pi-remote: ${l.state_} (${config?.url})`, "warning");
				}
			},
		});
	} catch {
		/* command registration is best-effort */
	}
}
