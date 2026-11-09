//! Harness lifecycle hook: `clankerhouse-hook HARNESS STATE`, with the hook JSON on stdin.
//!
//! Harnesses run this synchronously on every tool call, so it must cost about a millisecond
//! however busy the machine is. It never starts another process or waits on the daemon
//! on the common path: it records the clanker state in its pane's state file and returns.
//! Multiplexer claims are written only when they change (once per session in practice),
//! and the state change is left in a spool file for the daemon to mirror.

use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::env;
use std::fs::{self, DirBuilder, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Activity only feeds recency ordering, so a busy clanker refreshes it at most this often.
const ACTIVITY_INTERVAL: Duration = Duration::from_secs(2);
/// Submitted-prompt hashes kept in the pane record for delivery acknowledgement.
const PROMPT_HISTORY: usize = 8;
/// Settled turns kept in the pane record so `clankers result` can find a generation's reply.
const TURN_HISTORY: usize = 8;
/// A claim is a rare, best-effort write; a stalled Herdr must not stall the harness.
const HERDR_TIMEOUT: Duration = Duration::from_millis(250);

fn main() {
    let args: Vec<String> = env::args().collect();
    // A hook must never fail its harness, so every outcome exits 0.
    if let Err(error) = run(&args) {
        if env::var_os("CLANKERHOUSE_HOOK_DEBUG").is_some() {
            eprintln!("clankerhouse-hook: {error}");
        }
    }
}

struct Context {
    pane: String,
    /// The hc lane: claims travel over hc's socket instead of Herdr's.
    hc: bool,
    runtime_dir: PathBuf,
    state_dir: PathBuf,
}

fn var(name: &str) -> String {
    env::var(name).map(|value| value.trim().to_string()).unwrap_or_default()
}

fn context() -> Result<Option<Context>, String> {
    let hc = var("CLANKERHOUSE_MULTIPLEXER") == "hc";
    let pane = var(if hc { "HC_TERMINAL_ID" } else { "HERDR_PANE_ID" });
    if pane.is_empty() {
        return Ok(None);
    }
    let instance = var("CLANKERHOUSE_INSTANCE");
    let slug = if instance.is_empty() {
        "-herdr".to_string()
    } else if instance == "."
        || instance == ".."
        || !instance.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
    {
        return Err(format!("invalid CLANKERHOUSE_INSTANCE: {instance}"));
    } else if instance == "default" {
        String::new()
    } else {
        format!("-{instance}")
    };
    let uid = fs::metadata("/proc/self").map_err(|e| e.to_string())?.uid();
    let runtime_root = env::var("XDG_RUNTIME_DIR").ok().filter(|v| !v.is_empty()).unwrap_or_else(|| "/tmp".into());
    let state_home = env::var("XDG_STATE_HOME")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| format!("{}/.local/state", env::var("HOME").unwrap_or_default()));
    Ok(Some(Context {
        pane,
        hc,
        runtime_dir: PathBuf::from(format!("{runtime_root}/clankerhouse-{uid}{slug}")),
        state_dir: PathBuf::from(format!("{state_home}/clankerhouse{slug}")),
    }))
}

fn safe_name(pane: &str) -> String {
    pane.chars().map(|c| if c.is_ascii_alphanumeric() || "_.%-".contains(c) { c } else { '_' }).collect()
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn private_dir(path: &Path) -> Result<(), String> {
    if path.is_dir() {
        return Ok(());
    }
    DirBuilder::new().recursive(true).mode(0o700).create(path).map_err(|e| format!("{}: {e}", path.display()))
}

/// Replace `target` atomically so readers never see a partial record.
fn write_atomic(target: &Path, contents: &[u8]) -> Result<(), String> {
    let temporary = target.with_extension(format!("{}.tmp", std::process::id()));
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(|e| format!("{}: {e}", temporary.display()))?;
    file.write_all(contents).map_err(|e| e.to_string())?;
    drop(file);
    fs::rename(&temporary, target).map_err(|e| e.to_string())
}

fn text(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn run(args: &[String]) -> Result<(), String> {
    let harness = args.get(1).map(String::as_str).unwrap_or_default();
    if !matches!(harness, "claude" | "pi" | "codex" | "opencode") {
        return Ok(());
    }
    let mut state = match args.get(2).map(String::as_str).unwrap_or_default() {
        "release" => "unknown",
        s @ ("working" | "idle" | "done" | "blocked" | "unknown") => s,
        _ => return Ok(()),
    }
    .to_string();
    let Some(ctx) = context()? else { return Ok(()) };

    // Always drain stdin so a harness writing the hook payload never blocks on a full pipe.
    let mut input = String::new();
    let _ = std::io::stdin().read_to_string(&mut input);
    let payload: Value = serde_json::from_str(input.trim()).unwrap_or(Value::Null);
    let session_id = payload
        .get("session_id")
        .or_else(|| payload.get("sessionID"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let hook_event = payload.get("hook_event_name").and_then(Value::as_str).map(str::to_string);
    let expected_session = var("CLANKER_SESSION_ID");
    let env_clanker = var("CLANKER_ID");

    let reports = ctx.runtime_dir.join("clanker-state");
    private_dir(&reports)?;
    let target = reports.join(format!("{}.json", safe_name(&ctx.pane)));
    let stored: Value = fs::read(&target).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or(Value::Null);

    // The pane claim is authoritative for identity. Reading it is a Multiplexer round trip,
    // so reuse the stored identity while the same harness session keeps reporting.
    let same_pane = text(&stored, "pane") == ctx.pane && text(&stored, "harness") == harness;
    let stored_id = text(&stored, "clankerId");
    let continuing = same_pane
        && !stored_id.is_empty()
        && hook_event.as_deref() != Some("SessionStart")
        && ((!session_id.is_empty() && text(&stored, "harnessSessionId") == session_id)
            || (!env_clanker.is_empty() && env_clanker == stored_id));
    let mut claims: BTreeMap<&str, Option<String>> = BTreeMap::new();
    let clanker_id = if continuing {
        stored_id
    } else {
        match read_claim(&ctx, "clankerId") {
            Some(id) => id,
            None => {
                let id = if env_clanker.is_empty() { generated_clanker_id() } else { env_clanker.clone() };
                claims.insert("clankerId", Some(id.clone()));
                id
            }
        }
    };

    let previous = if !stored.is_null() && same_pane && text(&stored, "clankerId") == clanker_id { stored } else { Value::Null };
    if harness == "claude" && state == "done" && hook_event.as_deref() == Some("Stop") {
        // Stop ends the foreground response, not necessarily the session's work.
        // https://code.claude.com/docs/en/hooks#stop-input
        let busy = payload.get("background_tasks").and_then(Value::as_array).is_some_and(|tasks| {
            tasks.iter().any(|task| matches!(task.get("status").and_then(Value::as_str), Some("running" | "pending")))
        });
        if busy {
            state = "working".into();
        }
    }
    // The messaging socket does not deduplicate, so a sender retries an unacknowledged message
    // with the same id; a copy this session already took is blocked here instead of run twice.
    if hook_event.as_deref() == Some("UserPromptSubmit") {
        let prompt = payload.get("prompt").and_then(Value::as_str).unwrap_or_default();
        if redelivered(prompt, previous.get("prompts").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default()) {
            println!("{}", json!({ "decision": "block", "reason": "clankerhouse: this message was already delivered" }));
            return Ok(());
        }
    }
    let previous_state = text(&previous, "state");
    let mut generation = previous.get("generation").and_then(Value::as_u64).unwrap_or(0);
    let mut settled = previous.get("settledGeneration").and_then(Value::as_u64).unwrap_or(0);
    let mut started_at = previous.get("generationStartedAt").cloned().unwrap_or(Value::Null);
    let prompt_id = text(&payload, "prompt_id");
    let previous_prompt_id = text(&previous, "promptId");
    if (hook_event.as_deref() == Some("UserPromptSubmit")
        && !joins_running_turn(&previous_state, &previous_prompt_id, &prompt_id))
        || (state == "working" && previous_state != "working" && previous_state != "blocked")
    {
        generation += 1;
        started_at = json!(now_ms());
    }
    if generation == 0 && state != "idle" && state != "unknown" {
        generation = 1;
    }
    if state == "done" {
        settled = generation;
    }
    let or_previous = |value: &str, key: &str| if value.is_empty() { previous.get(key).cloned().unwrap_or(Value::Null) } else { json!(value) };
    // Queued sends are acknowledged by the message ids tagged in the prompt that started a turn
    // (or, for untagged sends from older clients, by its hash), so the
    // last few submissions stay in the record across the hooks that rewrite it.
    let mut prompts: Vec<Value> = previous.get("prompts").and_then(Value::as_array).cloned().unwrap_or_default();
    if hook_event.as_deref() == Some("UserPromptSubmit") {
        if let Some(prompt) = payload.get("prompt").and_then(Value::as_str) {
            let ids = message_ids(prompt);
            if ids.is_empty() {
                prompts.push(json!({ "sha256": prompt_sha256(prompt), "generation": generation }));
            } else {
                prompts.push(json!({ "sha256": prompt_sha256(prompt), "generation": generation, "messageIds": ids }));
            }
            let excess = prompts.len().saturating_sub(PROMPT_HISTORY);
            prompts.drain(..excess);
        }
    }
    // A Claude reply lives in its session transcript; each settled turn's time window
    // locates it there without the hook reading the transcript.
    let transcript = text(&payload, "transcript_path");
    let mut turns: Vec<Value> = previous.get("turns").and_then(Value::as_array).cloned().unwrap_or_default();
    if state == "done" && generation > 0 {
        turns.retain(|turn| turn.get("generation").and_then(Value::as_u64) != Some(generation));
        turns.push(json!({ "generation": generation, "startedAt": started_at, "settledAt": now_ms() }));
        let excess = turns.len().saturating_sub(TURN_HISTORY);
        turns.drain(..excess);
    }
    let messaging_socket = if harness == "claude" { var("CLAUDE_CODE_MESSAGING_SOCKET") } else { String::new() };
    let wrapper_incarnation = var("CLANKERHOUSE_HARNESS_INCARNATION");
    let record = json!({
        "harness": harness,
        "clankerId": clanker_id,
        "harnessSessionId": or_previous(&session_id, "harnessSessionId"),
        "state": state,
        "pane": ctx.pane,
        "generation": generation,
        "settledGeneration": settled,
        "updatedAt": now_ms(),
        "hookEvent": hook_event,
        "promptSha256": prompts.last().and_then(|prompt| prompt.get("sha256")).cloned().unwrap_or(Value::Null),
        "promptGeneration": prompts.last().and_then(|prompt| prompt.get("generation")).cloned().unwrap_or(Value::Null),
        "prompts": prompts,
        "generationStartedAt": started_at,
        // Claude's id for the running turn; a prompt absorbed mid-turn carries the same one.
        // Every submitted prompt replaces it, so a prompt without one never matches a stale id.
        "promptId": if hook_event.as_deref() == Some("UserPromptSubmit") {
            if prompt_id.is_empty() { Value::Null } else { json!(prompt_id) }
        } else {
            or_previous(&prompt_id, "promptId")
        },
        "turns": turns,
        "transcriptPath": or_previous(&transcript, "transcriptPath"),
        // Set by the harness lifecycle wrapper per harness launch; senders fence queued mail on it.
        // A clanker launched by hand has no wrapper, and its messaging socket is per process.
        "incarnation": or_previous(&if wrapper_incarnation.is_empty() { messaging_socket.clone() } else { wrapper_incarnation }, "incarnation"),
        // Claude's own cross-session inbox; clankerhouse delivers messages through it.
        "messagingSocket": or_previous(&messaging_socket, "messagingSocket"),
    });
    write_atomic(&target, record.to_string().as_bytes())?;
    if hook_event.as_deref() == Some("UserPromptSubmit")
        && payload.get("prompt").and_then(Value::as_str).is_some_and(restart_tagged)
    {
        // Claude records the interrupt as the user declining the running tool, and the message
        // then reads as a peer overriding the user. Say what actually happened.
        println!("{}", json!({ "hookSpecificOutput": { "hookEventName": "UserPromptSubmit", "additionalContext": RESTART_CONTEXT } }));
    }

    // Everything below is a side effect of the durable record above.
    let fresh = previous.is_null() || previous_state == "unknown";
    if fresh {
        claims.insert("harness", Some(harness.to_string()));
    }
    if !session_id.is_empty() && (fresh || text(&previous, "harnessSessionId") != session_id) {
        claims.insert("harnessSessionId", Some(session_id.clone()));
    }
    let foreign_session = !session_id.is_empty() && !expected_session.is_empty() && expected_session != session_id;
    if state == "unknown" && !foreign_session {
        claims.insert("harness", None);
    }
    if !claims.is_empty() {
        write_claims(&ctx, &claims);
    }
    mark_activity(&ctx, &payload);

    // Mirroring the state into the Multiplexer is the daemon's job, so it is spooled rather than
    // run here. The daemon applies the newest request per pane; settle points are always re-sent
    // so a mirror that missed one catches up once per turn.
    let changed = previous.is_null()
        || previous_state != state
        || text(&previous, "harnessSessionId") != session_id;
    if !session_id.is_empty() && !foreign_session && (changed || state == "done" || state == "idle") {
        let spool = ctx.runtime_dir.join("hook-events");
        private_dir(&spool)?;
        let request = json!({
            "pane": ctx.pane,
            "harness": harness,
            "clankerId": clanker_id,
            "harnessSessionId": session_id,
            "state": state,
            "generation": generation,
            "updatedAt": now_ms(),
        });
        write_atomic(&spool.join(format!("{}.json", safe_name(&ctx.pane))), request.to_string().as_bytes())?;
    }
    Ok(())
}

fn generated_clanker_id() -> String {
    let mut bytes = [0u8; 16];
    if let Ok(mut random) = fs::File::open("/dev/urandom") {
        let _ = random.read_exact(&mut bytes);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("clanker-{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
}

fn herdr_token(key: &str) -> &'static str {
    match key {
        "clankerId" => "ch_clanker_id",
        "harness" => "ch_harness",
        "harnessSessionId" => "ch_harness_session",
        other => unreachable!("unknown claim {other}"),
    }
}

fn herdr_socket() -> PathBuf {
    if let Ok(path) = env::var("HERDR_SOCKET_PATH") {
        if !path.is_empty() {
            return PathBuf::from(path);
        }
    }
    let config = env::var("XDG_CONFIG_HOME")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| format!("{}/.config", env::var("HOME").unwrap_or_default()));
    match env::var("HERDR_SESSION").ok().filter(|v| !v.is_empty()) {
        Some(session) => PathBuf::from(format!("{config}/herdr/sessions/{session}/herdr.sock")),
        None => PathBuf::from(format!("{config}/herdr/herdr.sock")),
    }
}

fn herdr_request(method: &str, params: Value) -> Option<Value> {
    let mut stream = UnixStream::connect(herdr_socket()).ok()?;
    stream.set_read_timeout(Some(HERDR_TIMEOUT)).ok()?;
    stream.set_write_timeout(Some(HERDR_TIMEOUT)).ok()?;
    let request = json!({ "id": "1", "method": method, "params": params });
    stream.write_all(format!("{request}\n").as_bytes()).ok()?;
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line).ok()?;
    let response: Value = serde_json::from_str(&line).ok()?;
    if response.get("error").is_some() { None } else { response.get("result").cloned() }
}

/// hc's JSON-RPC socket, named by the terminal this hook runs in. Same deadline as Herdr's: the hook never waits.
fn hc_request(method: &str, params: Value) -> Option<Value> {
    let mut stream = UnixStream::connect(var("HC_TERMINAL_SOCKET")).ok()?;
    stream.set_read_timeout(Some(HERDR_TIMEOUT)).ok()?;
    stream.set_write_timeout(Some(HERDR_TIMEOUT)).ok()?;
    let request = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
    stream.write_all(format!("{request}\n").as_bytes()).ok()?;
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line).ok()?;
    let response: Value = serde_json::from_str(&line).ok()?;
    response.get("result").cloned()
}

fn read_claim(ctx: &Context, key: &str) -> Option<String> {
    if ctx.hc {
        let result = hc_request("terminal.get", json!({ "terminal": ctx.pane }))?;
        let value = result.get("labels")?.get(herdr_token(key))?.as_str()?.to_string();
        return if value.is_empty() { None } else { Some(value) };
    }
    let value = herdr_request("pane.get", json!({ "pane_id": ctx.pane }))?
        .get("pane")?
        .get("tokens")?
        .get(herdr_token(key))?
        .as_str()?
        .to_string();
    if value.is_empty() { None } else { Some(value) }
}

fn pane_path(ctx: &Context) -> Option<PathBuf> {
    if ctx.hc {
        let terminal = hc_request("terminal.get", json!({ "terminal": ctx.pane }))?;
        let path = terminal.get("foreground").and_then(|f| f.get("cwd")).or(terminal.get("cwd"))?.as_str()?;
        return if path.is_empty() { None } else { Some(PathBuf::from(path)) };
    }
    let result = herdr_request("pane.get", json!({ "pane_id": ctx.pane }))?;
    let pane = result.get("pane")?;
    let path = ["foreground_cwd", "cwd"].iter().find_map(|key| pane.get(*key)?.as_str().filter(|v| !v.is_empty()).map(str::to_string))?;
    if path.is_empty() { None } else { Some(PathBuf::from(path)) }
}

fn write_claims(ctx: &Context, claims: &BTreeMap<&str, Option<String>>) {
    if ctx.hc {
        // An empty value removes a label.
        let labels: Map<String, Value> =
            claims.iter().map(|(key, value)| (herdr_token(key).to_string(), json!(value.clone().unwrap_or_default()))).collect();
        hc_request("terminal.label", json!({ "terminal": ctx.pane, "labels": labels }));
        return;
    }
    let tokens: Map<String, Value> =
        claims.iter().map(|(key, value)| (herdr_token(key).to_string(), json!(value))).collect();
    herdr_request("pane.report_metadata", json!({ "pane_id": ctx.pane, "source": "clankerhouse", "tokens": tokens }));
}

fn mark_activity(ctx: &Context, payload: &Value) {
    // Claude names its working directory in every payload; only other callers pay for
    // asking the Multiplexer where the pane is.
    let cwd = payload
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|cwd| !cwd.is_empty())
        .map(PathBuf::from)
        .or_else(|| pane_path(ctx))
        .or_else(|| env::current_dir().ok());
    let Some(path) = cwd.and_then(|path| fs::canonicalize(&path).ok().or(Some(path))) else { return };
    let path = path.to_string_lossy().to_string();
    let directory = ctx.state_dir.join("activity");
    let target = directory.join(format!("{}-clanker.json", sha256_hex(path.as_bytes())));
    let recent = fs::metadata(&target)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age < ACTIVITY_INTERVAL);
    if recent || fs::create_dir_all(&directory).is_err() {
        return;
    }
    let record = json!({ "path": path, "source": "clanker", "updatedAt": now_ms() });
    let _ = write_atomic(&target, record.to_string().as_bytes());
}

/// Message ids a clankerhouse sender tagged into a prompt as `[clankerhouse msg-... from ...]`. Claude
/// may wrap long input in `<pasted_content>`, so ids are found anywhere in the text.
fn message_ids(prompt: &str) -> Vec<String> {
    const TAG: &str = "[clankerhouse ";
    let mut ids = Vec::new();
    let mut rest = prompt;
    while let Some(at) = rest.find(TAG) {
        rest = &rest[at + TAG.len()..];
        let Some(end) = rest.find(']') else { break };
        // `[clankerhouse <id> from <sender>]`: the id is the first word.
        let id = rest[..end].split_whitespace().next().unwrap_or_default();
        if id.starts_with("msg-") && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') && !ids.iter().any(|seen| seen == id) {
            ids.push(id.to_string());
        }
        rest = &rest[end..];
        if ids.len() >= 8 {
            break;
        }
    }
    ids
}

/// A prompt Claude takes at a tool boundary of the running turn (a steer through its messaging
/// socket, text typed while it works, or an `<hc from=...>` note pasted by hc) reports that turn's
/// `prompt_id`. It joins the running generation instead of starting one, so the turn's start time,
/// its reply in `clankers result`, and the generation a message started stay together. Without a
/// `prompt_id` on both sides every submitted prompt starts a generation, as before.
fn joins_running_turn(previous_state: &str, previous_prompt_id: &str, prompt_id: &str) -> bool {
    matches!(previous_state, "working" | "blocked") && !prompt_id.is_empty() && prompt_id == previous_prompt_id
}

const RESTART_CONTEXT: &str = "clankerhouse interrupted your previous turn in order to deliver this message (the sender asked for a restart). The interruption came from clankerhouse, not from the user declining your work.";

/// A clankerhouse message sent with `--delivery restart`: its opening tag ends `, restart]`.
fn restart_tagged(prompt: &str) -> bool {
    let Some(rest) = prompt.trim_start().strip_prefix("[clankerhouse msg-") else { return false };
    rest.find(']').is_some_and(|end| rest[..end].ends_with(", restart"))
}

/// A clankerhouse message (a prompt that opens with its tag) whose ids were all taken before.
fn redelivered(prompt: &str, prompts: &[Value]) -> bool {
    if !prompt.trim_start().starts_with("[clankerhouse msg-") {
        return false;
    }
    let ids = message_ids(prompt);
    !ids.is_empty()
        && ids.iter().all(|id| {
            prompts.iter().any(|seen| seen.get("messageIds").and_then(Value::as_array).is_some_and(|taken| taken.iter().any(|t| t.as_str() == Some(id))))
        })
}

/// Hash of a submitted prompt, normalized as `promptSha256` in `src/orchestration.ts` is:
/// CRLF folded to LF and surrounding ASCII whitespace removed.
fn prompt_sha256(prompt: &str) -> String {
    sha256_hex(prompt.replace("\r\n", "\n").trim_matches(|c: char| c.is_ascii_whitespace()).as_bytes())
}

fn sha256_hex(data: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
        0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
        0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
        0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
        0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
        0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
        0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut h: [u32; 8] =
        [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    let mut message = data.to_vec();
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&((data.len() as u64) * 8).to_be_bytes());
    for chunk in message.chunks(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([chunk[4 * i], chunk[4 * i + 1], chunk[4 * i + 2], chunk[4 * i + 3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = h;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ (!e & g);
            let t1 = hh.wrapping_add(s1).wrapping_add(ch).wrapping_add(K[i]).wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        for (slot, value) in h.iter_mut().zip([a, b, c, d, e, f, g, hh]) {
            *slot = slot.wrapping_add(value);
        }
    }
    h.iter().map(|word| format!("{word:08x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::{joins_running_turn, message_ids, prompt_sha256, redelivered, restart_tagged, sha256_hex};

    #[test]
    fn only_a_prompt_with_the_running_turns_id_joins_it() {
        assert!(joins_running_turn("working", "p1", "p1"));
        assert!(joins_running_turn("blocked", "p1", "p1"));
        // After an Escape Claude fires no Stop, so the state still says working; the next prompt has a new id.
        assert!(!joins_running_turn("working", "p1", "p2"));
        assert!(!joins_running_turn("done", "p1", "p1"));
        assert!(!joins_running_turn("idle", "p1", "p1"));
        assert!(!joins_running_turn("working", "", ""));
        assert!(!joins_running_turn("working", "p1", ""));
    }

    #[test]
    fn an_hc_note_is_not_a_clankerhouse_message() {
        let note = "<hc from=\"t7 review\">Two bugs in x.rs [clankerhouse-ish]</hc>";
        assert!(message_ids(note).is_empty());
        assert!(!restart_tagged(note));
        assert!(!redelivered(note, &[]));
    }

    #[test]
    fn only_an_opening_restart_tag_counts() {
        assert!(restart_tagged("[clankerhouse msg-a from op, restart]\nnew task"));
        assert!(!restart_tagged("[clankerhouse msg-a from op]\nnew task"));
        assert!(!restart_tagged("quote [clankerhouse msg-a from op, restart]"));
    }
    use serde_json::json;

    #[test]
    fn a_message_taken_before_is_redelivered_and_others_are_not() {
        let seen = vec![json!({ "sha256": "x", "generation": 1, "messageIds": ["msg-a"] })];
        assert!(redelivered("[clankerhouse msg-a from op] hi", &seen));
        assert!(!redelivered("[clankerhouse msg-b from op] hi", &seen));
        // A human quoting a tag mid-prompt is never blocked.
        assert!(!redelivered("see [clankerhouse msg-a] above", &seen));
        assert!(!redelivered("[clankerhouse msg-a] hi", &[]));
    }

    #[test]
    fn message_ids_are_found_inline_wrapped_and_deduplicated() {
        assert_eq!(message_ids("[clankerhouse msg-ab-12] do it"), vec!["msg-ab-12"]);
        assert_eq!(message_ids("[clankerhouse msg-ab-13 from clanker-x] do it"), vec!["msg-ab-13"]);
        let wrapped = "\n\n<pasted_content id=\"7\">\n[clankerhouse msg-x1] body [clankerhouse msg-x1]\n</pasted_content id=\"7\">\n";
        assert_eq!(message_ids(wrapped), vec!["msg-x1"]);
        assert_eq!(message_ids("[clankerhouse msg-a] then [clankerhouse msg-b]"), vec!["msg-a", "msg-b"]);
        assert!(message_ids("[clankerhouse not-a-message] [clankerhouse msg-b@d]").is_empty());
        assert!(message_ids("plain prompt").is_empty());
    }

    #[test]
    fn prompt_hash_ignores_line_endings_and_surrounding_whitespace() {
        assert_eq!(prompt_sha256("abc"), sha256_hex(b"abc"));
        assert_eq!(prompt_sha256("\n  a\r\nb \t\n"), sha256_hex(b"a\nb"));
    }

    #[test]
    fn sha256_matches_known_digests() {
        assert_eq!(sha256_hex(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        let long = "/home/tsah/dev/work/tweezr/a-long-worktree-path-that-crosses-one-sha256-block-boundary";
        assert_eq!(sha256_hex(long.as_bytes()), "d7397cc501e314d699ec8a830f61465fdc77991f560bf9908dd5ba2285df7919");
    }
}
