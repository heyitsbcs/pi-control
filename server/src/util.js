import crypto from "node:crypto";

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 256 * 1024;
export const MAX_ITEM_TEXT_BYTES = 200 * 1024;
export const MAX_SCROLLBACK_ITEMS = 2000;
export const MAX_INPUT_TEXT_CHARS = 16_000;
export const HANDSHAKE_TIMEOUT_MS = 10_000;
export const PASSCODE_LENGTH = 6;
export const PASSCODE_LOCK_FAILURES = 5;
export const PASSCODE_LOCK_MS = 60_000;
export const MAX_VIEWERS_PER_SESSION = 8;

// Unambiguous Crockford-style alphabet (no 0/O/1/I/l/U).
const PASSCODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

export function genPasscode(length = PASSCODE_LENGTH, alphabet = PASSCODE_ALPHABET) {
	const bytes = crypto.randomBytes(length);
	let out = "";
	for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
	return out;
}

export function genId(prefix = "") {
	return prefix + crypto.randomBytes(5).toString("hex");
}

export function timingSafeEq(a, b) {
	const ba = Buffer.from(String(a), "utf8");
	const bb = Buffer.from(String(b), "utf8");
	if (ba.length !== bb.length) {
		// Compare against self to keep timing uniform, then fail.
		crypto.timingSafeEqual(ba, ba);
		return false;
	}
	return crypto.timingSafeEqual(ba, bb);
}

export function truncateText(text, maxChars) {
	if (text.length <= maxChars) return text;
	return text.slice(0, maxChars) + "…";
}

/** Parse one WS frame (string) as a JSON object with a bounded byte size. */
export function parseFrame(raw, maxBytes = MAX_FRAME_BYTES) {
	if (Buffer.byteLength(raw, "utf8") > maxBytes) {
		return { error: "frame_too_large" };
	}
	try {
		const obj = JSON.parse(raw);
		if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
			return { error: "bad_frame" };
		}
		return { value: obj };
	} catch {
		return { error: "bad_frame" };
	}
}

const ROLES = new Set(["user", "assistant", "tool", "system", "info"]);
const KINDS = new Set(["text", "tool_call", "tool_result", "error", "compaction"]);
const STATES = new Set(["idle", "running", "waiting_user"]);

function isPlainObject(v) {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate/coerce a transcript item. Returns the sanitized item or null.
 * text is clamped to MAX_ITEM_TEXT_BYTES (bytes).
 */
export function sanitizeItem(raw) {
	if (!isPlainObject(raw)) return null;
	if (typeof raw.id !== "string" || raw.id.length === 0 || raw.id.length > 128) return null;
	if (typeof raw.text !== "string") return null;
	if (!ROLES.has(raw.role)) return null;
	if (raw.kind !== undefined && !KINDS.has(raw.kind)) return null;
	const item = {
		id: raw.id,
		role: raw.role,
		kind: raw.kind ?? "text",
		text: raw.text,
		ts: typeof raw.ts === "number" && Number.isFinite(raw.ts) ? raw.ts : Date.now(),
	};
	if (typeof raw.title === "string" && raw.title.length > 0 && raw.title.length <= 200) {
		item.title = raw.title;
	}
	if (Buffer.byteLength(item.text, "utf8") > MAX_ITEM_TEXT_BYTES) {
		// Truncate safely on a UTF-8 boundary.
		const buf = Buffer.from(item.text, "utf8").subarray(0, MAX_ITEM_TEXT_BYTES);
		item.text = buf.toString("utf8").replace(/\uFFFD$/, "") + "…";
	}
	return item;
}

export function isValidItemArray(arr) {
	return Array.isArray(arr) && arr.every(isPlainObject);
}

/** Best-effort WS send; safe to call after close. */
export function sendSafe(ws, payload) {
	try {
		if (ws && ws.readyState === 1) ws.send(payload);
	} catch {
		/* ignore */
	}
}

export { isPlainObject, STATES };
