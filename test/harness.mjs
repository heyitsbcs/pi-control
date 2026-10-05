#!/usr/bin/env node
/**
 * pi-control server end-to-end test harness.
 *
 * Spawns the server on a random port, then drives:
 *   - a fake Pi extension over /ws/pi  (output: scrollback, items, status)
 *   - a fake phone viewer over /ws/viewer (input: commands, abort)
 *
 * Usage: node test/harness.mjs
 * Exit code 0 = all pass.
 */

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const PORT = 18787 + Math.floor(Math.random() * 2000);
const KEY = "test-server-key-0123456789abcdef0123456789abcdef";
const BASE = `http://127.0.0.1:${PORT}`;
const WS_BASE = `ws://127.0.0.1:${PORT}`;

// ---------------------------------------------------------------------------
// Tiny test framework
// ---------------------------------------------------------------------------
const results = [];
async function test(name, fn) {
	try {
		await fn();
		results.push({ name, ok: true });
		console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
	} catch (err) {
		results.push({ name, ok: false, err: String(err?.message || err) });
		console.log(`  \x1b[31mFAIL\x1b[0m ${name} — ${err?.message || err}`);
	}
}
function assert(cond, msg) {
	if (!cond) throw new Error(msg || "assertion failed");
}
function assertEq(actual, expected, msg) {
	if (actual !== expected) {
		throw new Error(`${msg || "mismatch"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
	}
}

// ---------------------------------------------------------------------------
// WS client helper
// ---------------------------------------------------------------------------
class WsClient {
	constructor(url, { name } = {}) {
		this.name = name || "client";
		this.url = url;
		this.ws = null;
		this.queue = [];
		this.waiters = [];
		this.closed = null;
	}
	connect() {
		return new Promise((resolve, reject) => {
			this.ws = new WebSocket(this.url);
			this.ws.onopen = () => resolve();
			this.ws.onerror = () => reject(new Error(`${this.name}: ws error`));
			this.ws.onclose = (ev) => {
				this.closed = { code: ev.code, reason: ev.reason };
				for (const w of this.waiters.splice(0)) w.reject(new Error(`${this.name}: closed ${ev.code} ${ev.reason}`));
			};
			this.ws.onmessage = (ev) => {
				let msg;
				try { msg = JSON.parse(ev.data); } catch { return; }
				if (this.waiters.length) this.waiters.shift().resolve(msg);
				else this.queue.push(msg);
			};
		});
	}
	send(obj) {
		this.ws.send(JSON.stringify(obj));
	}
	/** Receive next message of type(s); ignores others; timeout ms. */
	async recv(types, timeoutMs = 4000) {
		const want = Array.isArray(types) ? types : [types];
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			if (this.queue.length) {
				const [next, ...rest] = this.queue;
				this.queue = rest;
				if (want.includes(next.type)) return next;
				continue; // drop non-matching
			}
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw new Error(`${this.name}: timeout waiting for ${want.join("/")}`);
			const msg = await new Promise((resolve, reject) => {
				const t = setTimeout(() => reject(new Error(`${this.name}: timeout waiting for ${want.join("/")}`)), remaining);
				this.waiters.push({
					resolve: (m) => { clearTimeout(t); resolve(m); },
					reject: (e) => { clearTimeout(t); reject(e); },
				});
			});
			if (want.includes(msg.type)) return msg;
		}
	}
	close() {
		try { this.ws?.close(); } catch { /* ignore */ }
	}
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------
const server = spawn("node", ["src/server.js"], {
	cwd: new URL("../server", import.meta.url).pathname,
	env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", PI_REMOTE_SERVER_KEY: KEY, PI_REMOTE_OFFLINE_GRACE_MS: "4000" },
	stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => { serverLog += d; });
server.stderr.on("data", (d) => { serverLog += d; });

async function waitForHealth() {
	for (let i = 0; i < 50; i++) {
		try {
			const res = await fetch(`${BASE}/api/health`);
			if (res.ok) return (await res.json());
		} catch { /* not up yet */ }
		await delay(100);
	}
	throw new Error("server did not start:\n" + serverLog);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
async function main() {
	console.log(`\npi-control test harness — server on :${PORT}\n`);
	const health = await waitForHealth();
	assert(health.ok === true, "health ok");

	// --- HTTP API -----------------------------------------------------------
	await test("GET /api/health returns ok", async () => {
		assertEq(health.ok, true);
		assert(health.version, "version present");
	});

	await test("GET /api/sessions without key -> 401", async () => {
		const res = await fetch(`${BASE}/api/sessions`);
		assertEq(res.status, 401);
	});

	await test("GET /api/sessions with wrong key -> 401", async () => {
		const res = await fetch(`${BASE}/api/sessions`, {
			headers: { Authorization: "Bearer wrong-key-0123456789abcdef0123456789abcdef" },
		});
		assertEq(res.status, 401);
	});

	// --- Extension auth ------------------------------------------------------
	let passcode = null;
	const SESSION = { id: "test-session-abc123", hostname: "harness.local", cwd: "/tmp/demo", name: "harness session" };

	let ext = null;
	await test("extension auth with bad key rejected", async () => {
		const c = new WsClient(`${WS_BASE}/ws/pi`, { name: "bad-ext" });
		await c.connect();
		c.send({ type: "auth", protocol: 1, key: "bad-key-0123456789", session: SESSION });
		const msg = await c.recv("auth_error");
		assertEq(msg.error, "bad_key");
		await delay(200);
		assert(c.closed, "connection should close after bad key");
	});

	await test("extension auth with correct key -> auth_ok + passcode", async () => {
		ext = new WsClient(`${WS_BASE}/ws/pi`, { name: "ext" });
		await ext.connect();
		ext.send({ type: "auth", protocol: 1, key: KEY, session: SESSION });
		const ok = await ext.recv("auth_ok");
		passcode = ok.session.passcode;
		assertEq(ok.session.id, SESSION.id);
		assertEq(passcode.length, 6, "passcode length");
		assert(/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]+$/.test(passcode), "passcode alphabet");
	});
	await test("GET /api/sessions lists the linked session", async () => {
		const res = await fetch(`${BASE}/api/sessions`, { headers: { Authorization: "Bearer " + KEY } });
		assertEq(res.status, 200);
		const data = await res.json();
		assertEq(data.sessions.length, 1);
		assertEq(data.sessions[0].id, SESSION.id);
		assertEq(data.sessions[0].title, "harness session");
	});

	await test("GET /api/sessions/:id returns detail; unknown -> 404", async () => {
		const res = await fetch(`${BASE}/api/sessions/${SESSION.id}`, { headers: { Authorization: "Bearer " + KEY } });
		assertEq(res.status, 200);
		const res404 = await fetch(`${BASE}/api/sessions/nope-123`, { headers: { Authorization: "Bearer " + KEY } });
		assertEq(res404.status, 404);
	});

	// --- Viewer auth ---------------------------------------------------------
	await test("viewer with unknown session rejected", async () => {
		const c = new WsClient(`${WS_BASE}/ws/viewer`, { name: "viewer-unknown" });
		await c.connect();
		c.send({ type: "auth", protocol: 1, session: "does-not-exist", code: "ABCDEF" });
		const msg = await c.recv("auth_error");
		assertEq(msg.error, "unknown_session");
	});

	await test("viewer with wrong passcode rejected", async () => {
		const c = new WsClient(`${WS_BASE}/ws/viewer`, { name: "viewer-wrong" });
		await c.connect();
		c.send({ type: "auth", protocol: 1, session: SESSION.id, code: "ZZZZZZ" });
		const msg = await c.recv("auth_error");
		assertEq(msg.error, "bad_passcode");
	});

	let viewer = null;
	await test("viewer with correct passcode -> auth_ok + history", async () => {
		viewer = new WsClient(`${WS_BASE}/ws/viewer`, { name: "viewer" });
		await viewer.connect();
		viewer.send({ type: "auth", protocol: 1, session: SESSION.id, code: passcode });
		const ok = await viewer.recv("auth_ok");
		assertEq(ok.session.id, SESSION.id);
		assert(Array.isArray(ok.history), "history is array");
		assert(ok.status && typeof ok.status.online === "boolean", "status.online present");
	});

	await test("passcode is case-insensitive (lowercase of generated code works)", async () => {
		const c = new WsClient(`${WS_BASE}/ws/viewer`, { name: "viewer-case" });
		await c.connect();
		c.send({ type: "auth", protocol: 1, session: SESSION.id, code: passcode.toLowerCase() });
		const ok = await c.recv("auth_ok");
		assertEq(ok.session.id, SESSION.id, "lowercase passcode authenticates");
	});

	// --- Output: scrollback, items, status -----------------------------------
	await test("extension scrollback reaches viewer (resync + items)", async () => {
		ext.send({
			type: "scrollback",
			reset: true,
			items: [
				{ id: "u1", role: "user", kind: "text", text: "hello pi", ts: 1 },
				{ id: "a1", role: "assistant", kind: "text", text: "Hi there!", ts: 2 },
				{ id: "t1", role: "tool", kind: "tool_call", title: "bash", text: "ls -la", ts: 3 },
			],
		});
		const resync = await viewer.recv("resync");
		assert(resync, "got resync");
		const i1 = await viewer.recv("item");
		assertEq(i1.item.id, "u1");
		const i2 = await viewer.recv("item");
		assertEq(i2.item.id, "a1");
		const i3 = await viewer.recv("item");
		assertEq(i3.item.id, "t1");
		assertEq(i3.item.title, "bash");
	});

	await test("streaming item updates replace by id", async () => {
		ext.send({ type: "item", item: { id: "a2", role: "assistant", kind: "text", text: "Let me ", ts: 4 } });
		await delay(100);
		ext.send({ type: "item", item: { id: "a2", role: "assistant", kind: "text", text: "Let me check that file.", ts: 5 } });
		const first = await viewer.recv("item");
		assertEq(first.item.id, "a2");
		const second = await viewer.recv("item");
		assertEq(second.item.id, "a2");
		assertEq(second.item.text, "Let me check that file.");
	});

	await test("status frames reach viewer", async () => {
		ext.send({ type: "status", state: "running", model: "test/model-x", tool: "bash" });
		const st = await viewer.recv("status");
		assertEq(st.state, "running");
		assertEq(st.model, "test/model-x");
		assertEq(st.tool, "bash");
		assertEq(st.online, true);
	});

	await test("invalid item rejected, connection survives", async () => {
		ext.send({ type: "item", item: { id: 42, role: "bogus", text: "nope" } });
		const err = await ext.recv("error");
		assertEq(err.code, "bad_item");
		// connection still alive:
		ext.send({ type: "hb", n: 1 });
		const hb = await ext.recv("hb");
		assertEq(hb.n, 1);
	});

	await test("malformed JSON frame produces error, not a crash", async () => {
		ext.ws.send("this is not json");
		const err = await ext.recv("error");
		assert(["bad_frame", "frame_too_large"].includes(err.code), "got a frame error");
	});

	// --- Input: commands from phone ------------------------------------------
	await test("viewer user_message -> extension remote_input + viewer echo", async () => {
		viewer.send({ type: "command", action: "user_message", text: "please say hi", deliverAs: "followUp" });
		const echo = await viewer.recv("echo");
		assertEq(echo.action, "user_message");
		assertEq(echo.text, "please say hi");
		assertEq(echo.deliverAs, "followUp");
		const remote = await ext.recv("remote_input");
		assertEq(remote.text, "please say hi");
		assertEq(remote.deliverAs, "followUp");
		assert(remote.id, "has id");
	});

	await test("viewer steer command preserves deliverAs", async () => {
		viewer.send({ type: "command", action: "user_message", text: "stop, do this", deliverAs: "steer" });
		await viewer.recv("echo");
		const remote = await ext.recv("remote_input");
		assertEq(remote.deliverAs, "steer");
	});

	await test("viewer abort -> extension remote_abort", async () => {
		viewer.send({ type: "command", action: "abort" });
		const echo = await viewer.recv("echo");
		assertEq(echo.action, "abort");
		const remote = await ext.recv("remote_abort");
		assert(remote.id, "has id");
	});

	await test("viewer request_scrollback -> extension", async () => {
		viewer.send({ type: "request_scrollback" });
		const msg = await ext.recv("request_scrollback");
		assert(msg, "got request_scrollback");
	});

	await test("oversized command rejected", async () => {
		viewer.send({ type: "command", action: "user_message", text: "x".repeat(20_000), deliverAs: "followUp" });
		const err = await viewer.recv("error");
		assertEq(err.code, "bad_command");
	});

	// --- Liveness -------------------------------------------------------------
	await test("extension disconnect -> viewer sees offline; relink -> online", async () => {
		ext.close();
		const off = await viewer.recv("status");
		assertEq(off.online, false);
		await delay(300);
		const ext2 = new WsClient(`${WS_BASE}/ws/pi`, { name: "ext2" });
		await ext2.connect();
		ext2.send({ type: "auth", protocol: 1, key: KEY, session: SESSION });
		await ext2.recv("auth_ok");
		const on = await viewer.recv("status");
		assertEq(on.online, true);
		// viewer still attached after relink (passcode stable)
		viewer.send({ type: "command", action: "abort" });
		await ext2.recv("remote_abort");
		ext2.close();
		await delay(200);
	});

	// --- Passcode lockout (run last: locks the session) -----------------------
	await test("repeated wrong passcodes lock the session for 60s", async () => {
		// Note: an earlier test already recorded one wrong-code failure.
		let bad = 0;
		let lockedSeen = false;
		for (let i = 0; i < 8 && !lockedSeen; i++) {
			const c = new WsClient(`${WS_BASE}/ws/viewer`, { name: "lock" + i });
			await c.connect();
			c.send({ type: "auth", protocol: 1, session: SESSION.id, code: "WRONG" + i });
			const msg = await c.recv("auth_error");
			if (msg.error === "bad_passcode") bad++;
			if (msg.error === "locked") lockedSeen = true;
			assert(["bad_passcode", "locked"].includes(msg.error), "unexpected error " + msg.error);
		}
		assert(bad >= 3, "saw several bad_passcode rejections");
		assert(lockedSeen, "session locked after repeated failures");
		// even the correct passcode is rejected while locked
		const c = new WsClient(`${WS_BASE}/ws/viewer`, { name: "lock-final" });
		await c.connect();
		c.send({ type: "auth", protocol: 1, session: SESSION.id, code: passcode });
		const msg = await c.recv("auth_error");
		assertEq(msg.error, "locked", "correct passcode rejected while locked");
	});

	// --- Extension-supplied passcode --------------------------------------------
	await test("extension-supplied passcode is used as the session code", async () => {
		const c = new WsClient(`${WS_BASE}/ws/pi`, { name: "ext-pc" });
		await c.connect();
		c.send({ type: "auth", protocol: 1, key: KEY, session: { ...SESSION, id: SESSION.id + "-pc", passcode: "HARNESS42" } });
		const ok = await c.recv("auth_ok");
		assertEq(ok.session.passcode, "HARNESS42", "configured passcode echoed");
		c.close();
	});

	await test("invalid extension-supplied passcode rejected (too short / whitespace)", async () => {
		for (const bad of ["ab", "has space"]) {
			const c = new WsClient(`${WS_BASE}/ws/pi`, { name: "ext-badpc" });
			await c.connect();
			c.send({ type: "auth", protocol: 1, key: KEY, session: { ...SESSION, id: SESSION.id + "-bad", passcode: bad } });
			const msg = await c.recv("auth_error");
			assertEq(msg.error, "bad_passcode");
			await delay(200);
			assert(c.closed, "connection should close after bad_passcode");
		}
	});

	// --- Summary ----------------------------------------------------------------
	const failed = results.filter((r) => !r.ok);
	console.log(`\n${results.length - failed.length}/${results.length} passed`);
	if (failed.length) {
		console.log("\nFailures:");
		for (const f of failed) console.log(` - ${f.name}: ${f.err}`);
	}
	if (serverLog.trim()) {
		console.log("\n--- server log (last 20 lines) ---");
		console.log(serverLog.trim().split("\n").slice(-20).join("\n"));
	}
	server.kill("SIGTERM");
	await delay(300);
	process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
	console.error("HARNESS ERROR:", err);
	server.kill("SIGTERM");
	process.exit(1);
});
