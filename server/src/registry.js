import {
	genPasscode,
	normalizePasscode,
	sanitizeItem,
	MAX_SCROLLBACK_ITEMS,
	MAX_VIEWERS_PER_SESSION,
	PASSCODE_LOCK_FAILURES,
	PASSCODE_LOCK_MS,
	timingSafeEq,
} from "./util.js";

/**
 * In-memory session registry with a bounded per-session item ring buffer.
 *
 * Session lifecycle:
 *   upsert() on extension auth -> online
 *   markOffline() on extension disconnect -> kept for grace period
 *   prune() after grace -> removed (viewers notified before removal)
 */
export class Session {
	constructor({ id, hostname, cwd, name, client, passcode, maxBufferItems }) {
		this.id = id;
		this.hostname = hostname ?? "unknown";
		this.cwd = cwd ?? "";
		this.title = name || cwd.split("/").filter(Boolean).pop() || id.slice(0, 8);
		this.client = client ?? "pi-extension";
		this.passcode = passcode;
		this.extWs = null;
		this.viewers = new Set(); // { ws, ip }
		this.buffer = new Map(); // itemId -> item, insertion-ordered (newest last)
		this.maxBufferItems = maxBufferItems;

		this.state = "idle"; // idle | running | waiting_user
		this.model = null;
		this.tool = null;
		this.online = false;
		this.seq = 0;
		this.createdAt = Date.now();
		this.lastActivity = Date.now();
		this.lastItemTs = null;
		this.itemCount = 0;

		// passcode lockout
		this.pcFailures = 0;
		this.pcLockUntil = 0;
	}

	/** Add or replace-by-id a transcript item. Returns sanitized item or null. */
	putItem(rawItem) {
		const item = sanitizeItem(rawItem);
		if (!item) return null;
		if (this.buffer.has(item.id)) this.buffer.delete(item.id);
		this.buffer.set(item.id, item);
		this.lastItemTs = Math.max(this.lastItemTs ?? 0, item.ts);
		this.lastActivity = Date.now();
		while (this.buffer.size > this.maxBufferItems) {
			const oldest = this.buffer.keys().next().value;
			this.buffer.delete(oldest);
		}
		return item;
	}

	clearBuffer() {
		this.buffer.clear();
		this.itemCount = 0;
		this.lastItemTs = null;
	}

	history() {
		return [...this.buffer.values()];
	}

	touch() {
		this.lastActivity = Date.now();
	}

	/** Try a passcode; returns true on success. Updates lockout state. */
	tryPasscode(candidate) {
		const now = Date.now();
		if (now < this.pcLockUntil) return false;
		if (timingSafeEq(candidate, this.passcode)) {
			this.pcFailures = 0;
			this.pcLockUntil = 0;
			return true;
		}
		this.pcFailures += 1;
		if (this.pcFailures >= PASSCODE_LOCK_FAILURES) {
			this.pcLockUntil = now + PASSCODE_LOCK_MS;
			this.pcFailures = 0;
		}
		return false;
	}

	get locked() {
		return Date.now() < this.pcLockUntil;
	}

	addViewer(viewer) {
		if (this.viewers.size >= MAX_VIEWERS_PER_SESSION) return false;
		this.viewers.add(viewer);
		return true;
	}

	removeViewer(viewer) {
		this.viewers.delete(viewer);
	}

	summary() {
		return {
			id: this.id,
			title: this.title,
			hostname: this.hostname,
			cwd: this.cwd,
			client: this.client,
			state: this.online ? this.state : "offline",
			model: this.model,
			tool: this.online ? this.tool : null,
			createdAt: this.createdAt,
			lastActivity: this.lastActivity,
			lastItemTs: this.lastItemTs,
			viewers: this.viewers.size,
		};
	}
}

export class Registry {
	constructor({ maxSessions, maxBufferItems, offlineGraceMs, serverKey }) {
		this.maxSessions = maxSessions;
		this.maxBufferItems = maxBufferItems;
		this.offlineGraceMs = offlineGraceMs;
		this.sessions = new Map();
		this._serverKey = serverKey;
	}

	get count() {
		return this.sessions.size;
	}

	/** Timing-safe server-key check (used by /ws/pi auth and the HTTP API). */
	serverKeyOk(key) {
		return timingSafeEq(key, this._serverKey);
	}

	get(id) {
		if (typeof id !== "string" || id.length === 0 || id.length > 128) return undefined;
		return this.sessions.get(id);
	}

	list() {
		return [...this.sessions.values()].sort((a, b) => b.lastActivity - a.lastActivity);
	}

	/**
	 * Register or refresh a session from an extension auth frame.
	 * Returns { ok, session?, error? }.
	 */
	upsert(meta) {
		if (typeof meta.id !== "string" || meta.id.length === 0 || meta.id.length > 128) {
			return { ok: false, error: "bad_session" };
		}
		// Operator-chosen passcode (optional; validated). When supplied it
		// takes the place of the generated one and may rotate it on
		// re-link (failure counter resets with it).
		const chosen = normalizePasscode(meta.passcode);
		if (typeof meta.passcode === "string" && meta.passcode.trim() !== "" && chosen === null) {
			return { ok: false, error: "bad_passcode" };
		}
		let session = this.sessions.get(meta.id);
		if (!session) {
			if (this.sessions.size >= this.maxSessions) {
				return { ok: false, error: "too_many_sessions" };
			}
			session = new Session({
				id: meta.id,
				hostname: typeof meta.hostname === "string" ? meta.hostname.slice(0, 128) : undefined,
				cwd: typeof meta.cwd === "string" ? meta.cwd.slice(0, 512) : undefined,
				name: typeof meta.name === "string" ? meta.name.slice(0, 128) : undefined,
				client: typeof meta.client === "string" ? meta.client.slice(0, 64) : undefined,
				passcode: chosen || genPasscode(),
				maxBufferItems: this.maxBufferItems,
			});
			this.sessions.set(meta.id, session);
		} else {
			if (typeof meta.hostname === "string") session.hostname = meta.hostname.slice(0, 128);
			if (typeof meta.cwd === "string") session.cwd = meta.cwd.slice(0, 512);
			if (typeof meta.name === "string") session.title = meta.name.slice(0, 128) || session.title;
			if (typeof meta.client === "string") session.client = meta.client.slice(0, 64);
			// Server-generated passcodes stay stable for the life of the session
			// record so the phone's code keeps working across pi restarts.
			// An explicit operator passcode from the extension may rotate it.
			if (chosen && chosen !== session.passcode) {
				session.passcode = chosen;
				session.pcFailures = 0;
				session.pcLockUntil = 0;
			}
		}
		session.online = true;
		session.state = "idle";
		session.touch();
		return { ok: true, session };
	}

	/** Mark extension disconnected; returns the session (or undefined). */
	markOffline(session) {
		if (!session) return;
		session.online = false;
		session.tool = null;
		session.touch();
	}

	/** Drop sessions offline longer than the grace period. Returns removed ids. */
	prune(now = Date.now()) {
		const removed = [];
		for (const session of this.sessions.values()) {
			if (!session.online && now - session.lastActivity > this.offlineGraceMs) {
				session.viewers.forEach((v) => v.onSessionRemoved?.(session.id));
				this.sessions.delete(session.id);
				removed.push(session.id);
			}
		}
		return removed;
	}
}
