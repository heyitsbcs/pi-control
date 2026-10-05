/**
 * Per-IP rate limiter for WebSocket handshakes (brute-force / scanning guard).
 * Module-level state is shared by the /ws/pi and /ws/viewer channels.
 */

const LIMITS = {
	viewer: { max: 20, windowMs: 60_000 },
	pi: { max: 60, windowMs: 60_000 },
};

const state = new Map(); // ip -> { count, resetAt }

function tryHandshake(channel, ip) {
	const limit = LIMITS[channel] || LIMITS.viewer;
	const key = (ip || "unknown") + "|" + channel;
	const now = Date.now();
	let e = state.get(key);
	if (!e || now > e.resetAt) {
		e = { count: 0, resetAt: now + limit.windowMs };
		state.set(key, e);
		// Opportunistic prune of expired buckets.
		if (state.size > 1024) {
			for (const [k, v] of state) if (now > v.resetAt) state.delete(k);
		}
	}
	e.count += 1;
	return e.count <= limit.max;
}

export { tryHandshake };
