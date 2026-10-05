#!/usr/bin/env node
/**
 * End-to-end test: real `pi` process + pi-control extension + pi-control server.
 *
 * Run A (output + remote steer):
 *   1. Spawns the server on a random port.
 *   2. Spawns `pi -p` with the extension (PI_CONTROL_CONFIG pointing at a
 *      temp ~/.pi/agent/pi-control.json equivalent). The prompt makes the
 *      agent run `sleep 6`
 *   3. Verifies the session registers, reads the passcode, connects a
 *      phone-equivalent viewer.
 *   4. Verifies OUTPUT: user prompt, tool activity, assistant text stream
 *      to the viewer.
 *   5. Verifies INPUT (steer): a remote user_message interrupts the turn;
 *      the final assistant text follows the remote instruction.
 *   6. Verifies liveness: on pi exit the viewer sees the session go offline.
 *
 * Run B (remote abort):
 *   7. A second `pi -p` run that would sleep 30s; a remote abort stops it
 *      and the session goes offline quickly (no PONG output).
 *
 * Usage: node test/extension-e2e.mjs
 */

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const PORT = 28787 + Math.floor(Math.random() * 2000);
const KEY = "e2e-server-key-0123456789abcdef0123456789abcdef012345";
const BASE = `http://127.0.0.1:${PORT}`;
const WS_BASE = `ws://127.0.0.1:${PORT}`;
const PASSCODE = "TEST42"; // operator-chosen passcode in the extension config
const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pi-control-"));
const CONFIG_FILE = path.join(CONFIG_DIR, "pi-control.json");
fs.writeFileSync(CONFIG_FILE, JSON.stringify({
	url: WS_BASE,
	key: KEY,
	passcode: PASSCODE,
}, null, 2));

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

// --- WS client (viewer side) -------------------------------------------------
class WsClient {
	constructor(name) {
		this.name = name;
		this.ws = null;
		this.items = [];
		this.statuses = [];
	}
	connect() {
		return new Promise((resolve, reject) => {
			this.ws = new WebSocket(`${WS_BASE}/ws/viewer`);
			this.ws.onopen = resolve;
			this.ws.onerror = () => reject(new Error(`${this.name}: ws error`));
			this.ws.onmessage = (ev) => {
				let msg;
				try { msg = JSON.parse(ev.data); } catch { return; }
				if (msg.type === "item") this.items.push(msg.item);
				if (msg.type === "status") this.statuses.push(msg);
				if (msg.type === "auth_ok") {
					this.authOk = msg;
					this.items.push(...(msg.history || []));
				}
				if (msg.type === "auth_error") {
					this.authErr = msg.error || "auth_error";
				}
			};
		});
	}
	auth(sessionId, code) {
		this.send({ protocol: 1, type: "auth", session: sessionId, code });
	}
	send(obj) {
		this.ws.send(JSON.stringify(obj));
	}
	close() {
		try { this.ws?.close(); } catch { /* ignore */ }
	}
	async waitForItem(pred, timeoutMs = 90_000, what = "item") {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const hit = this.items.find(pred);
			if (hit) return hit;
			if (Date.now() > deadline) {
				const dump = this.items.slice(-8).map((i) => `[${i.role}/${i.kind}] ${i.text?.slice(0, 80)}`);
				throw new Error(`timeout waiting for ${what}\nlast items:\n  ${dump.join("\n  ")}`);
			}
			await delay(200);
		}
	}
	async waitForStatus(pred, timeoutMs = 30_000, what = "status") {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const hit = this.statuses.find(pred);
			if (hit) return hit;
			if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
			await delay(200);
		}
	}
	clear() {
		this.items = [];
		this.statuses = [];
		this.authOk = null;
	}
}

// --- Server -------------------------------------------------------------------
const server = spawn("node", ["src/server.js"], {
	cwd: path.join(ROOT, "server"),
	env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", PI_REMOTE_SERVER_KEY: KEY },
	stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

async function waitForHealth() {
	for (let i = 0; i < 50; i++) {
		try {
			const res = await fetch(`${BASE}/api/health`);
			if (res.ok) return;
		} catch { /* retry */ }
		await delay(100);
	}
	throw new Error("server did not start:\n" + serverLog);
}

async function getSessions() {
	const res = await fetch(`${BASE}/api/sessions`, { headers: { Authorization: "Bearer " + KEY } });
	const data = await res.json();
	return data.sessions || [];
}

function waitForSession(id) {
	return (async () => {
		const deadline = Date.now() + 30_000;
		for (;;) {
			const list = await getSessions();
			const s = list.find((x) => x.id === id);
			if (s) return s;
			if (Date.now() > deadline) throw new Error("session never registered");
			await delay(500);
		}
	})();
}

function waitForPiExit(pi, timeoutMs = 120_000) {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error("pi process did not exit in time")), timeoutMs);
		pi.on("exit", () => {
			clearTimeout(t);
			resolve();
		});
	});
}

let ISOLATED_HOME = null;

function startPi(prompt) {
	const pi = spawn("pi", ["-p", prompt, "-e", path.join(ROOT, "extension", "index.ts")], {
		cwd: os.tmpdir(),
		env: {
			...process.env,
			PI_CONTROL_CONFIG: CONFIG_FILE,
		HOME: ISOLATED_HOME,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	pi.out = "";
	pi.stdout.on("data", (d) => (pi.out += d));
	pi.stderr.on("data", (d) => (pi.out += d));
	return pi;
}

async function main() {
	console.log(`\npi-control extension e2e — server :${PORT}\n`);

	// Isolated $HOME so the test pi process does not load the developer's global
	// extensions (flag-registration conflicts) but still has model auth.
	ISOLATED_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pi-control-e2e-home-"));
	fs.cpSync(path.join(os.homedir(), ".pi"), path.join(ISOLATED_HOME, ".pi"), {
		recursive: true,
		filter: (src) => !src.includes("node_modules") && !src.includes("agent/extensions"),
	});
	console.log("(isolated HOME: " + ISOLATED_HOME + ")");
	await waitForHealth();
	const viewer = new WsClient("viewer");
	await viewer.connect();

	// ================= Run A: output + remote steer ===========================
	console.log("— Run A: output streaming + remote steer input —");
	const piA = startPi("Use the bash tool to run `sleep 6`. After it finishes, respond with exactly one word: PONG");
	const exitA = waitForPiExit(piA, 180_000);

	let sessionA;
	await test("A1: pi registers its session on the server", async () => {
		// wait for the first session to appear
		const deadline = Date.now() + 30_000;
		for (;;) {
			const list = await getSessions();
			if (list.length >= 1) {
				sessionA = list[0];
				return sessionA;
			}
			if (Date.now() > deadline) throw new Error("session never registered\npi out:\n" + piA.out);
			await delay(500);
		}
	});

	await test("A2: viewer authenticates with the configured passcode", async () => {
		// The only way the server knows PASSCODE is via the extension's auth
		// frame; a successful viewer auth proves the configured passcode was
		// registered server-side.
		viewer.auth(sessionA.id, PASSCODE);
		const deadline = Date.now() + 15_000;
		while (!viewer.authOk) {
			if (viewer.authErr) throw new Error(`viewer auth rejected: ${viewer.authErr}`);
			if (Date.now() > deadline) throw new Error("viewer auth_ok never received");
			await delay(200);
		}
	});

	await test("A3: viewer receives scrollback with the user prompt", async () => {
		await viewer.waitForItem(
			(i) => i.role === "user" && i.text.includes("PONG"),
			60_000,
			"user prompt item",
		);
	});

	await test("A4: tool activity streams to the viewer (bash sleep)", async () => {
		await viewer.waitForItem(
			(i) => i.role === "tool" && /sleep 6/.test(i.text || ""),
			90_000,
			"tool item (sleep 6)",
		);
	});

	await test("A5: remote steer input is injected and changes the outcome", async () => {
		// Interrupt the running turn: the remote user says PONG2 instead.
		viewer.send({
			type: "command",
			action: "user_message",
			text: "Do not run any tools. Respond with exactly one word: PONG2",
			deliverAs: "steer",
		});
		await viewer.waitForItem(
			(i) => i.role === "user" && i.text.includes("[remote]") && i.text.includes("PONG2"),
			60_000,
			"remote user item",
		);
		// Final assistant answer must follow the remote instruction.
		await viewer.waitForItem(
			(i) => i.role === "assistant" && /PONG2/.test(i.text || ""),
			90_000,
			"assistant PONG2 item",
		);
	});

	await test("A6: pi exit marks the session offline to the viewer", async () => {
		await exitA;
		await viewer.waitForStatus((s) => s.online === false, 30_000);
	});

	// ================= Run B: remote abort =====================================
	console.log("\n— Run B: remote abort —");
	const piB = startPi("Use the bash tool to run `sleep 30`. After it finishes, respond with exactly one word: PONG");
	const exitB = waitForPiExit(piB, 60_000);
	exitB.catch(() => {}); // avoid unhandled-rejection crash if never awaited

	let sessionB;
	const viewerB = new WsClient("viewerB");
	await viewerB.connect();
	await test("B1: second pi run registers a new session", async () => {
		const deadline = Date.now() + 30_000;
		for (;;) {
			const list = await getSessions();
			sessionB = list.find((x) => x.id !== sessionA.id);
			if (sessionB) return sessionB;
			if (Date.now() > deadline) throw new Error("second session never registered\npi out:\n" + piB.out);
			await delay(500);
		}
	});

	await test("B2: same configured passcode works for the new session", async () => {
		viewerB.auth(sessionB.id, PASSCODE);
		const deadline = Date.now() + 15_000;
		while (!viewerB.authOk) {
			if (viewerB.authErr) throw new Error(`viewerB auth rejected: ${viewerB.authErr}`);
			if (Date.now() > deadline) throw new Error("viewerB auth_ok never received");
			await delay(200);
		}
		assert(viewerB.authOk, "viewer auth_ok for session B");
	});

	await test("B3: remote abort interrupts the running turn", async () => {
		await viewerB.waitForItem(
			(i) => i.role === "tool" && /sleep 30/.test(i.text || ""),
			90_000,
			"tool item (sleep 30)",
		);
		viewerB.send({ type: "command", action: "abort" });
		await exitB;
		assert(!/PONG/.test(piB.out) || /abort|interrupt|stop/i.test(piB.out),
			`pi finished a full turn after abort; out:\n${piB.out.slice(-500)}`);
	});

	await test("B4: aborted session goes offline", async () => {
		await viewerB.waitForStatus((s) => s.online === false, 30_000);
	});

	// --- summary -----------------------------------------------------------------
	const failed = results.filter((r) => !r.ok);
	console.log(`\n${results.length - failed.length}/${results.length} passed`);
	if (failed.length) {
		console.log("\nFailures:");
		for (const f of failed) console.log(` - ${f.name}: ${f.err}`);
	}
	if (piA.out.trim()) {
		console.log("\n--- pi A output (tail) ---");
		console.log(piA.out.split("\n").slice(-8).join("\n"));
	}
	if (piB.out.trim()) {
		console.log("\n--- pi B output (tail) ---");
		console.log(piB.out.split("\n").slice(-8).join("\n"));
	}
	if (serverLog.trim()) {
		console.log("\n--- server log (tail) ---");
		console.log(serverLog.trim().split("\n").slice(-10).join("\n"));
	}
	viewer.close();
	viewerB.close();
	server.kill("SIGTERM");
	piA.kill("SIGTERM");
	piB.kill("SIGTERM");
	await delay(300);
	process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
	console.error("E2E ERROR:", err);
	server.kill("SIGTERM");
	process.exit(1);
});
