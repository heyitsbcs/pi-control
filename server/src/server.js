import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { Registry } from "./registry.js";
import { handlePiConnection } from "./pi-channel.js";
import { handleViewerConnection } from "./viewer-channel.js";
import { timingSafeEq } from "./util.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
function loadConfig() {
	const env = process.env;
	let serverKey = env.PI_REMOTE_SERVER_KEY;
	let generatedKey = false;
	if (!serverKey || serverKey.length < 16) {
		serverKey = crypto.randomBytes(32).toString("hex");
		generatedKey = true;
	}
	const config = {
		port: Number(env.PORT || 8787),
		host: env.HOST || "0.0.0.0",
		serverKey,
		generatedKey,
		maxSessions: Number(env.PI_REMOTE_MAX_SESSIONS || 32),
		maxBufferItems: Number(env.PI_REMOTE_BUFFER_ITEMS || 1000),
		offlineGraceMs: Number(env.PI_REMOTE_OFFLINE_GRACE_MS || 10 * 60 * 1000),
		tlsCert: env.PI_REMOTE_TLS_CERT || "",
		tlsKey: env.PI_REMOTE_TLS_KEY || "",
		trustProxy: /^(1|true|yes)$/i.test(env.PI_REMOTE_TRUST_PROXY || ""),
	};
	return config;
}

// ---------------------------------------------------------------------------
// Logging (minimal, structured; never logs secrets)
// ---------------------------------------------------------------------------
const log = {
	info: (fields, msg) => console.log(JSON.stringify({ level: "info", msg, ...fields })),
	warn: (fields, msg) => console.warn(JSON.stringify({ level: "warn", msg, ...fields })),
	error: (fields, msg) => console.error(JSON.stringify({ level: "error", msg, ...fields })),
};

// ---------------------------------------------------------------------------
// HTTP: API + static web UI
// ---------------------------------------------------------------------------
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const STATIC = new Map([
	["/", { file: "index.html", type: "text/html; charset=utf-8" }],
	["/index.html", { file: "index.html", type: "text/html; charset=utf-8" }],
	["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
	["/style.css", { file: "style.css", type: "text/css; charset=utf-8" }],
]);
const CSP = [
	"default-src 'none'",
	"script-src 'self'",
	"style-src 'self'",
	"connect-src 'self'",
	"img-src 'self' data:",
	"base-uri 'none'",
	"frame-ancestors 'self'",
	"form-action 'none'",
].join("; ");

function sendJson(res, status, obj, extraHeaders = {}) {
	const body = JSON.stringify(obj);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(body),
		"Cache-Control": "no-store",
		...extraHeaders,
	});
	res.end(body);
}

function bearerKey(req) {
	const h = req.headers["authorization"] || "";
	const m = /^Bearer\s+(.+)$/i.exec(h);
	return m ? m[1].trim() : "";
}

function buildHandler(registry, config) {
	return async (req, res) => {
		const url = new URL(req.url, "http://localhost");
		res.setHeader("Content-Security-Policy", CSP);
		res.setHeader("X-Content-Type-Options", "nosniff");
		res.setHeader("Referrer-Policy", "no-referrer");
		if (config.tlsCert) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");

		const trySend = (status, obj) => {
			if (!res.headersSent) sendJson(res, status, obj);
		};

		try {
			if (req.method === "GET" && url.pathname === "/api/health") {
				trySend(200, { ok: true, version: VERSION, sessions: registry.count });
				return;
			}

			if (req.method === "GET" && url.pathname === "/api/sessions") {
				if (!timingSafeEq(bearerKey(req), config.serverKey)) {
					trySend(401, { error: "unauthorized" });
					return;
				}
				trySend(200, { sessions: registry.list().map((s) => s.summary()) });
				return;
			}

			const sessionMatch = /^\/api\/sessions\/([A-Za-z0-9._-]+)$/.exec(url.pathname);
			if (req.method === "GET" && sessionMatch) {
				if (!timingSafeEq(bearerKey(req), config.serverKey)) {
					trySend(401, { error: "unauthorized" });
					return;
				}
				const s = registry.get(sessionMatch[1]);
				if (!s) {
					trySend(404, { error: "not_found" });
					return;
				}
				trySend(200, { session: s.summary() });
				return;
			}

			if (req.method === "GET") {
				const entry = STATIC.get(url.pathname);
				if (entry) {
					const file = path.join(PUBLIC_DIR, entry.file);
					const data = await fs.promises.readFile(file);
					res.writeHead(200, {
						"Content-Type": entry.type,
						"Content-Length": data.length,
						"Cache-Control": "no-cache",
					});
					res.end(data);
					return;
				}
				trySend(404, { error: "not_found" });
				return;
			}

			trySend(405, { error: "method_not_allowed" });
		} catch (err) {
			log.error({ err: String(err), path: url.pathname }, "http error");
			trySend(500, { error: "internal" });
		}
	};
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
	const config = loadConfig();
	const registry = new Registry({
		maxSessions: config.maxSessions,
		maxBufferItems: config.maxBufferItems,
		offlineGraceMs: config.offlineGraceMs,
		serverKey: config.serverKey,
	});

	const httpModule = config.tlsCert && config.tlsKey ? https : http;
	const server = httpModule.createServer(buildHandler(registry, config));
	if (config.tlsCert && config.tlsKey) {
		server.on("tlsclienterror", (err) => log.error({ err: String(err) }, "tls client error"));
	}

	const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
	server.on("upgrade", (req, socket, head) => {
		const url = new URL(req.url, "http://localhost");
		if (url.pathname === "/ws/pi" || url.pathname === "/ws/viewer") {
			wss.handleUpgrade(req, socket, head, (ws) => {
				// Only trust X-Forwarded-For when running behind a proxy
				// (otherwise a direct client can spoof their source IP to
				// evade per-IP rate limits).
				const forwarded = config.trustProxy ? req.headers["x-forwarded-for"] : undefined;
				const ip = (forwarded || req.socket.remoteAddress || "").split(",")[0].trim();
				if (url.pathname === "/ws/pi") {
					handlePiConnection(ws, registry, { log, ip });
				} else {
					handleViewerConnection(ws, registry, ip, { log });
				}
			});
		} else {
			socket.destroy();
		}
	});
	wss.on("error", (err) => log.error({ err: String(err) }, "wss error"));

	// Prune offline sessions past the grace period.
	const pruneTimer = setInterval(() => {
		const removed = registry.prune();
		for (const id of removed) log.warn({ sessionId: id }, "pruned offline session");
	}, 30_000);
	pruneTimer.unref?.();

	// WebSocket keepalive (terminate unresponsive peers).
	const setAlive = (ws) => {
		ws.isPiControlAlive = true;
		ws.on("pong", () => {
			ws.isPiControlAlive = true;
		});
	};
	wss.on("connection", (ws) => setAlive(ws));
	const hb = setInterval(() => {
		for (const client of wss.clients) {
			if (client.isPiControlAlive === false) {
				client.terminate();
				continue;
			}
			client.isPiControlAlive = false;
			client.ping();
		}
	}, 30_000);
	hb.unref?.();

	server.on("error", (err) => {
		if (err.code === "EADDRINUSE") {
			log.error({ port: config.port }, "port in use");
			process.exit(1);
		}
		throw err;
	});

	server.listen(config.port, config.host, () => {
		const scheme = config.tlsCert ? "wss" : "ws";
		log.info({ port: config.port, tls: Boolean(config.tlsCert) }, "pi-control server listening");
		console.log("");
		console.log(`  Pi control server`);
		console.log(`  Web UI:    http${config.tlsCert ? "s" : ""}://<host>:${config.port}/`);
		console.log(`  Ext WS:    ${scheme}://<host>:${config.port}/ws/pi`);
		console.log(`  Viewer WS: ${scheme}://<host>:${config.port}/ws/viewer`);
		if (config.generatedKey) {
			console.log("");
			console.log(`  GENERATED server key (set PI_REMOTE_SERVER_KEY to control this):`);
			console.log(`    ${config.serverKey}`);
		} else {
			console.log(`  server key: set (PI_REMOTE_SERVER_KEY)`);
		}
		console.log("");
	});

	const shutdown = () => {
		log.info({}, "shutting down");
		clearInterval(pruneTimer);
		for (const client of wss.clients) {
			try {
				client.close(1001, "server shutting down");
			} catch {
				/* ignore */
			}
		}
		server.close(() => process.exit(0));
		setTimeout(() => process.exit(0), 3_000).unref?.();
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

main();
