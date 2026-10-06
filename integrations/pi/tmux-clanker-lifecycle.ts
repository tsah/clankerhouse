import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type State = "blocked" | "working" | "done" | "idle" | "unknown";
type Delivery = "steer" | "followUp";

interface ClankerResult {
	generation: number;
	timestamp: number;
	status: number;
	stopReason: string;
	errorMessage: string;
	reply: string;
}

interface PersistedReport {
	clankerId?: string;
	harnessSessionId?: string;
	recoveryAttemptId?: string;
	generation?: number;
	settledGeneration?: number;
	result?: ClankerResult;
	results?: ClankerResult[];
}

// Pane address: the innermost runtime that spawned this process. CLANKERHOUSE_MULTIPLEXER overrides.
const inferredHerdr = process.env.HERDR_ENV?.trim() === "1" && Boolean(process.env.HERDR_PANE_ID?.trim());
const requestedMultiplexer = process.env.CLANKERHOUSE_MULTIPLEXER?.trim().toLowerCase();
if (requestedMultiplexer && requestedMultiplexer !== "tmux" && requestedMultiplexer !== "herdr") throw new Error(`Unsupported CLANKERHOUSE_MULTIPLEXER: ${requestedMultiplexer}`);
const multiplexerKind = (requestedMultiplexer || (inferredHerdr ? "herdr" : "tmux")) as "tmux" | "herdr";
const pane = (multiplexerKind === "herdr" ? process.env.HERDR_PANE_ID?.trim() : process.env.TMUX_PANE?.trim()) || "";
const clankersCli = process.env.CLANKERHOUSE_CLANKERS?.trim() || "clankers";
const sessionless = process.argv.includes("--no-session");
const requestedInstance = process.env.CLANKERHOUSE_INSTANCE?.trim() || "";
if (requestedInstance && (requestedInstance === "." || requestedInstance === ".." || !/^[A-Za-z0-9._-]+$/.test(requestedInstance))) throw new Error(`Invalid CLANKERHOUSE_INSTANCE: ${requestedInstance}`);
const instanceSlug = requestedInstance
	? (["default", "tmux"].includes(requestedInstance) ? "" : `-${requestedInstance}`)
	: (multiplexerKind === "tmux" ? "" : `-${multiplexerKind}`);
const runtimeRoot = join(process.env.XDG_RUNTIME_DIR || "/tmp", `clankerhouse-${process.getuid?.() || 0}${instanceSlug}`);
const stateDirectory = join(runtimeRoot, "clanker-state");
const socketDirectory = join(runtimeRoot, "clanker-sockets");
const stateFile = pane ? join(stateDirectory, `${pane.replace(/[^A-Za-z0-9_.%-]/g, "_")}.json`) : "";
const daemonSocketPath = join(runtimeRoot, "daemon.sock");
const daemonAvailable = Boolean(pane && existsSync(daemonSocketPath));
const clankersEnv = { ...process.env, CLANKERHOUSE_MULTIPLEXER: multiplexerKind };

let reportSeq = Date.now() * 1000;
let reportInFlight = false;
let queuedReport: Record<string, unknown> | undefined;

function sendReport(record: Record<string, unknown>): Promise<void> {
	return new Promise((resolve) => {
		const request = { version: 1, id: `pi:${process.pid}:${record.seq}`, method: "observation.report", params: record };
		const socket = createConnection(daemonSocketPath);
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve();
		};
		socket.setTimeout(500, finish);
		socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
		socket.once("data", finish);
		socket.once("error", finish);
		socket.once("end", finish);
		socket.once("close", finish);
	});
}

async function drainReports() {
	if (reportInFlight) return;
	reportInFlight = true;
	try {
		while (queuedReport) {
			const next = queuedReport;
			queuedReport = undefined;
			await sendReport(next);
		}
	} finally {
		reportInFlight = false;
		if (queuedReport) void drainReports();
	}
}

function tmux(args: string[]) {
	return spawnSync("tmux", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

/** tmux option name -> semantic claim key understood by `clankers mux`. */
const claimKeyForOption: Record<string, string> = {
	"@clankerhouse_clanker_id": "clankerId",
	"@dotfiles_harness": "harness",
	"@clankerhouse_harness_session_id": "harnessSessionId",
	"@clankerhouse_recovery_attempt": "recoveryAttemptId",
	"@clankerhouse_clanker_socket": "clankerSocket",
	"@clankerhouse_clanker_pid": "clankerPid",
	"@clankerhouse_clanker_capabilities": "clankerCapabilities",
};

function paneOption(name: string) {
	if (!pane) return "";
	if (multiplexerKind === "tmux") {
		const result = tmux(["show-option", "-p", "-qv", "-t", pane, name]);
		return result.status === 0 ? result.stdout.trim() : "";
	}
	const result = spawnSync(clankersCli, ["mux", "read-claim", "--pane", pane, claimKeyForOption[name] ?? name], { env: clankersEnv, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	return result.status === 0 ? result.stdout.trim() : "";
}

function setPaneOption(name: string, value: string) {
	if (!pane) return;
	if (multiplexerKind === "tmux") tmux(["set-option", "-p", "-t", pane, name, value]);
	else spawnSync(clankersCli, ["mux", "claim", "--pane", pane, claimKeyForOption[name] ?? name, value], { env: clankersEnv, stdio: "ignore" });
}

function clearPaneOptionIf(name: string, expected: string) {
	if (!pane || paneOption(name) !== expected) return;
	if (multiplexerKind === "tmux") tmux(["set-option", "-p", "-u", "-t", pane, name]);
	else spawnSync(clankersCli, ["mux", "claim", "--pane", pane, claimKeyForOption[name] ?? name, "--unset"], { env: clankersEnv, stdio: "ignore" });
}

function readPersistedReport(): PersistedReport {
	if (!stateFile) return {};
	try { return JSON.parse(readFileSync(stateFile, "utf8")) as PersistedReport; }
	catch { return {}; }
}

export function extractAssistantResult(messages: Array<any>) {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		const stopReason = typeof message.stopReason === "string" ? message.stopReason : "";
		const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : "";
		const status = stopReason === "error" || stopReason === "aborted" || errorMessage ? 1 : 0;
		const reply = Array.isArray(message.content)
			? message.content
					.filter((part: any) => part?.type === "text" && typeof part.text === "string")
					.map((part: any) => part.text)
					.join("\n")
			: "";
		return { status, stopReason, errorMessage, reply };
	}
	return { status: 1, stopReason: "no_result", errorMessage: "Clanker settled without an assistant result.", reply: "" };
}

export default function (pi: ExtensionAPI) {
	// Headless Pi subprocesses such as Agent workers inherit TMUX_PANE but do
	// not own its Terminal. Their --no-session identities are ephemeral and
	// must never replace the parent Clanker or create Recovery declarations.
	if (sessionless) return;

	const activeSubagents = new Set<string>();
	// SDK workers share the visible Pi's argv, PID and pane environment. Only
	// the TUI session owns that Terminal; decide from its session_start context
	// before reading claims, publishing lifecycle state or starting resources.
	let ownsPane = false;
	let clankerId = "";
	let generation = 0;
	let settledGeneration = 0;
	let results: ClankerResult[] = [];
	let latestResult = { status: 1, stopReason: "no_result", errorMessage: "Clanker settled without an assistant result.", reply: "" };
	let parentState: State = "idle";
	let currentContext: { isIdle(): boolean } | undefined;
	let server: Server | undefined;
	let activeSocketPath = "";
	let externalSendInFlight = false;
	let lastReportFingerprint = "";
	let harnessSessionId = process.env.CLANKER_SESSION_ID?.trim() || "";
	const recoveryAttemptId = process.env.CLANKER_RECOVERY_ATTEMPT?.trim() || "";

	const attestSession = () => {
		if (!harnessSessionId) return;
		const cli = process.env.CLANKERHOUSE_CLANKERS || "clankers";
		spawnSync(cli, ["recovery", "attest", clankerId, "--session-id", harnessSessionId, ...(recoveryAttemptId ? ["--attempt", recoveryAttemptId] : [])], { env: clankersEnv, stdio: "ignore" });
	};

	const report = (state: State, event: string) => {
		if (!ownsPane || !pane || !stateFile) return;
		const result = results.at(-1);
		const fingerprint = [state, clankerId, harnessSessionId, recoveryAttemptId, generation, settledGeneration, result?.generation ?? "", activeSubagents.size].join("\0");
		if (fingerprint === lastReportFingerprint) return;
		lastReportFingerprint = fingerprint;
		reportSeq += 1;
		const updatedAt = Date.now();
		const record = {
			source: `pi:${process.pid}`,
			seq: reportSeq,
			harness: "pi",
			clankerId,
			harnessSessionId,
			...(recoveryAttemptId ? { recoveryAttemptId } : {}),
			state,
			pane,
			generation,
			settledGeneration,
			updatedAt,
			hookEvent: event,
			result,
			results,
		};
		if (daemonAvailable) {
			queuedReport = record;
			void drainReports();
			return;
		}
		try {
			mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
			chmodSync(stateDirectory, 0o700);
			const tmp = `${stateFile}.${process.pid}.tmp`;
			writeFileSync(tmp, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
			renameSync(tmp, stateFile);

			const path = realpathSync(process.cwd());
			const activityDirectory = join(process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local", "state"), `clankerhouse${instanceSlug}`, "activity");
			mkdirSync(activityDirectory, { recursive: true });
			const target = join(activityDirectory, `${createHash("sha256").update(path).digest("hex")}-clanker.json`);
			const activityTmp = `${target}.${process.pid}.tmp`;
			writeFileSync(activityTmp, JSON.stringify({ path, source: "clanker", updatedAt }));
			renameSync(activityTmp, target);
		} catch {}
	};

	const reportParentState = (state: State, event: string) => {
		parentState = state;
		report(activeSubagents.size > 0 ? "working" : state, event);
	};
	const subagentStarted = (data: unknown) => {
		const id = (data as { id?: unknown })?.id;
		if (typeof id !== "string" || !id) return;
		activeSubagents.add(id);
		report("working", "subagent_started");
	};
	const subagentFinished = (data: unknown) => {
		const id = (data as { id?: unknown })?.id;
		if (typeof id !== "string" || !id) return;
		activeSubagents.delete(id);
		report(activeSubagents.size > 0 ? "working" : parentState, "subagent_finished");
	};
	const unsubscribeSubagentEvents = [
		pi.events.on("subagents:created", subagentStarted),
		pi.events.on("subagents:started", subagentStarted),
		pi.events.on("subagents:completed", subagentFinished),
		pi.events.on("subagents:failed", subagentFinished),
	];

	const stopSocket = () => {
		const path = activeSocketPath;
		activeSocketPath = "";
		if (server) {
			server.close();
			server = undefined;
		}
		if (path) {
			clearPaneOptionIf("@clankerhouse_clanker_socket", path);
			try { rmSync(path, { force: true }); } catch {}
		}
	};

	const sendResponse = (socket: import("node:net").Socket, payload: Record<string, unknown>) => {
		socket.end(`${JSON.stringify(payload)}\n`);
	};

	const startSocket = async () => {
		if (!pane || server) return;
		clankerId = paneOption("@clankerhouse_clanker_id") || clankerId;
		setPaneOption("@clankerhouse_clanker_id", clankerId);
		setPaneOption("@dotfiles_harness", "pi");
		if (harnessSessionId) setPaneOption("@clankerhouse_harness_session_id", harnessSessionId);
		if (recoveryAttemptId) setPaneOption("@clankerhouse_recovery_attempt", recoveryAttemptId);
		setPaneOption("@clankerhouse_clanker_pid", String(process.pid));
		setPaneOption("@clankerhouse_clanker_capabilities", "status,wait,send,result");
		mkdirSync(socketDirectory, { recursive: true, mode: 0o700 });
		chmodSync(socketDirectory, 0o700);
		// Unix-domain socket paths are limited to 107 bytes on Linux. Keep the
		// filename compact instead of embedding the (potentially long) clanker ID.
		const socketId = `${process.pid.toString(36)}-${randomUUID().slice(0, 8)}`;
		const path = join(socketDirectory, `pi-${socketId}.sock`);
		try { rmSync(path, { force: true }); } catch {}

		server = createServer((socket) => {
			socket.setEncoding("utf8");
			let input = "";
			let handled = false;
			socket.on("data", (chunk) => {
				if (handled) return;
				input += chunk;
				if (input.length > 1024 * 1024) {
					handled = true;
					return sendResponse(socket, { ok: false, error: "Request exceeded 1 MiB" });
				}
				const newline = input.indexOf("\n");
				if (newline < 0) return;
				handled = true;
				try {
					const request = JSON.parse(input.slice(0, newline)) as { version?: unknown; action?: unknown; clankerId?: unknown; text?: unknown; delivery?: unknown };
					if (request.version !== 1 || request.action !== "send") throw new Error("Unsupported Clankerhouse socket request");
					if (request.clankerId !== clankerId) throw new Error("Clanker identity mismatch");
					if (typeof request.text !== "string" || !request.text.trim()) throw new Error("Message must not be empty");
					if (request.delivery !== undefined && request.delivery !== "steer" && request.delivery !== "followUp") throw new Error("delivery must be steer or followUp");
					if (externalSendInFlight) throw new Error("Another Clankerhouse message is still awaiting settlement");
					const busy = currentContext ? !currentContext.isIdle() : parentState === "working";
					const delivery: Delivery | undefined = busy ? (request.delivery as Delivery | undefined) || "followUp" : undefined;
					const afterGeneration = settledGeneration;
					externalSendInFlight = true;
					try {
						if (delivery) pi.sendUserMessage(request.text, { deliverAs: delivery });
						else pi.sendUserMessage(request.text);
					} catch (error) {
						externalSendInFlight = false;
						throw error;
					}
					sendResponse(socket, {
						ok: true,
						clankerId,
						acceptedAt: Date.now(),
						afterGeneration,
						observedGeneration: generation,
						delivery: delivery || "immediate",
					});
				} catch (error) {
					sendResponse(socket, { ok: false, error: error instanceof Error ? error.message : String(error) });
				}
			});
		});

		await new Promise<void>((resolve, reject) => {
			const candidate = server!;
			const onError = (error: Error) => { candidate.off("listening", onListening); reject(error); };
			const onListening = () => { candidate.off("error", onError); resolve(); };
			candidate.once("error", onError);
			candidate.once("listening", onListening);
			candidate.listen(path);
		});
		chmodSync(path, 0o600);
		activeSocketPath = path;
		setPaneOption("@clankerhouse_clanker_socket", path);
	};

	pi.on("session_start", async (_event, ctx) => {
		if (!pane || ctx.mode !== "tui") return;
		ownsPane = true;
		currentContext = ctx;
		harnessSessionId = ctx.sessionManager.getSessionId();
		clankerId = paneOption("@clankerhouse_clanker_id") || process.env.CLANKER_ID?.trim() || `clanker-${randomUUID()}`;
		const persisted = readPersistedReport();
		const persistedId = persisted.clankerId;
		generation = Number(persistedId === clankerId ? persisted.generation : 0) || 0;
		settledGeneration = Number(persistedId === clankerId ? persisted.settledGeneration : 0) || 0;
		results = persistedId === clankerId && Array.isArray(persisted.results) ? persisted.results.slice(-20) : [];
		// Declare owned identity before validating a preallocated session. A
		// mismatch must remain attributable to this Pi process rather than
		// degrading into identity-free lifecycle evidence.
		setPaneOption("@clankerhouse_clanker_id", clankerId);
		setPaneOption("@dotfiles_harness", "pi");
		setPaneOption("@clankerhouse_harness_session_id", harnessSessionId);
		const expectedSessionId = process.env.CLANKER_SESSION_ID?.trim();
		if (expectedSessionId && harnessSessionId !== expectedSessionId) {
			reportParentState("blocked", "session_identity_mismatch");
			return;
		}
		await startSocket();
		attestSession();
		reportParentState("idle", "session_start");
	});
	pi.on("agent_start", (_event, ctx) => {
		currentContext = ctx;
		generation += 1;
		latestResult = { status: 1, stopReason: "no_result", errorMessage: "Clanker settled without an assistant result.", reply: "" };
		reportParentState("working", "agent_start");
	});
	pi.on("turn_start", (_event, ctx) => { currentContext = ctx; reportParentState("working", "turn_start"); });
	pi.on("tool_execution_start", (_event, ctx) => { currentContext = ctx; reportParentState("working", "tool_execution_start"); });
	pi.on("agent_end", async (event, ctx) => {
		currentContext = ctx;
		latestResult = extractAssistantResult(event.messages as Array<any>);
	});
	pi.on("agent_settled", async (_event, ctx) => {
		currentContext = ctx;
		if (generation <= settledGeneration) generation = settledGeneration + 1;
		settledGeneration = generation;
		const result: ClankerResult = { generation, timestamp: Date.now(), ...latestResult };
		results = [...results.filter((candidate) => candidate.generation !== generation), result].slice(-20);
		externalSendInFlight = false;
		reportParentState(result.status === 0 ? "done" : "blocked", "agent_settled");
	});

	pi.on("session_shutdown", async (event) => {
		for (const unsubscribe of unsubscribeSubagentEvents) unsubscribe();
		activeSubagents.clear();
		if (!ownsPane) return;
		reportParentState("unknown", "session_shutdown");
		stopSocket();
		clearPaneOptionIf("@clankerhouse_clanker_pid", String(process.pid));
		if (event.reason === "quit") {
			clearPaneOptionIf("@dotfiles_harness", "pi");
			clearPaneOptionIf("@clankerhouse_clanker_capabilities", "status,wait,send,result");
		}
		externalSendInFlight = false;
		currentContext = undefined;
		ownsPane = false;
	});
}
