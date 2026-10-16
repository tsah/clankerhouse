//! Harness lifecycle hook: `clankerhouse-hook HARNESS STATE`, with the hook JSON on stdin.
//!
//! Harnesses run this synchronously on every tool call, so it must cost about a millisecond
//! however busy the machine is. It never starts another process or waits on the daemon
//! on the common path: it records the clanker state in its pane's state file and returns.
//! Multiplexer claims are written only when they change (once per session in practice),
//! and the Recovery attestation is left in a spool file for the daemon to apply.

use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::env;
use std::fs::{self, DirBuilder, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Activity only feeds recency ordering, so a busy clanker refreshes it at most this often.
const ACTIVITY_INTERVAL: Duration = Duration::from_secs(2);
/// Submitted-prompt hashes kept in the pane record for delivery acknowledgement.
const PROMPT_HISTORY: usize = 8;
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

#[derive(Clone, Copy, PartialEq)]
enum Mux {
    Tmux,
    Herdr,
}

struct Context {
    mux: Mux,
    pane: String,
    runtime_dir: PathBuf,
    state_dir: PathBuf,
}

fn var(name: &str) -> String {
    env::var(name).map(|value| value.trim().to_string()).unwrap_or_default()
}

fn context() -> Result<Option<Context>, String> {
    let requested = var("CLANKERHOUSE_MULTIPLEXER").to_lowercase();
    let mux = match requested.as_str() {
        "tmux" => Mux::Tmux,
        "herdr" => Mux::Herdr,
        "" if var("HERDR_ENV") == "1" && !var("HERDR_PANE_ID").is_empty() => Mux::Herdr,
        "" => Mux::Tmux,
        other => return Err(format!("unsupported CLANKERHOUSE_MULTIPLEXER: {other}")),
    };
    let pane = var(if mux == Mux::Herdr { "HERDR_PANE_ID" } else { "TMUX_PANE" });
    if pane.is_empty() {
        return Ok(None);
    }
    let instance = var("CLANKERHOUSE_INSTANCE");
    let slug = if instance.is_empty() {
        if mux == Mux::Herdr { "-herdr".to_string() } else { String::new() }
    } else if instance == "."
        || instance == ".."
        || !instance.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
    {
        return Err(format!("invalid CLANKERHOUSE_INSTANCE: {instance}"));
    } else if instance == "default" || instance == "tmux" {
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
        mux,
        pane,
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
    let attempt = var("CLANKER_RECOVERY_ATTEMPT");
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
    let previous_state = text(&previous, "state");
    let mut generation = previous.get("generation").and_then(Value::as_u64).unwrap_or(0);
    let mut settled = previous.get("settledGeneration").and_then(Value::as_u64).unwrap_or(0);
    if hook_event.as_deref() == Some("UserPromptSubmit")
        || (state == "working" && previous_state != "working" && previous_state != "blocked")
    {
        generation += 1;
    }
    if generation == 0 && state != "idle" && state != "unknown" {
        generation = 1;
    }
    if state == "done" {
        settled = generation;
    }
    let or_previous = |value: &str, key: &str| if value.is_empty() { previous.get(key).cloned().unwrap_or(Value::Null) } else { json!(value) };
    // Queued sends are acknowledged by the hash of the prompt that started a turn, so the
    // last few submissions stay in the record across the hooks that rewrite it.
    let mut prompts: Vec<Value> = previous.get("prompts").and_then(Value::as_array).cloned().unwrap_or_default();
    if hook_event.as_deref() == Some("UserPromptSubmit") {
        if let Some(prompt) = payload.get("prompt").and_then(Value::as_str) {
            prompts.push(json!({ "sha256": prompt_sha256(prompt), "generation": generation }));
            let excess = prompts.len().saturating_sub(PROMPT_HISTORY);
            prompts.drain(..excess);
        }
    }
    let record = json!({
        "harness": harness,
        "clankerId": clanker_id,
        "harnessSessionId": or_previous(&session_id, "harnessSessionId"),
        "recoveryAttemptId": or_previous(&attempt, "recoveryAttemptId"),
        "state": state,
        "pane": ctx.pane,
        "generation": generation,
        "settledGeneration": settled,
        "updatedAt": now_ms(),
        "hookEvent": hook_event,
        "promptSha256": prompts.last().and_then(|prompt| prompt.get("sha256")).cloned().unwrap_or(Value::Null),
        "promptGeneration": prompts.last().and_then(|prompt| prompt.get("generation")).cloned().unwrap_or(Value::Null),
        "prompts": prompts,
    });
    write_atomic(&target, record.to_string().as_bytes())?;

    // Everything below is a side effect of the durable record above.
    let fresh = previous.is_null() || previous_state == "unknown";
    if fresh {
        claims.insert("harness", Some(harness.to_string()));
    }
    if !session_id.is_empty() && (fresh || text(&previous, "harnessSessionId") != session_id) {
        claims.insert("harnessSessionId", Some(session_id.clone()));
    }
    if !attempt.is_empty() && (fresh || text(&previous, "recoveryAttemptId") != attempt) {
        claims.insert("recoveryAttemptId", Some(attempt.clone()));
    }
    let foreign_session = !session_id.is_empty() && !expected_session.is_empty() && expected_session != session_id;
    if state == "unknown" && !foreign_session {
        claims.insert("harness", None);
    }
    if !claims.is_empty() {
        write_claims(&ctx, &claims);
    }
    mark_activity(&ctx, &payload);

    // Recovery attestation needs the daemon's registry, so it is spooled rather than run here.
    // The daemon applies the newest request per pane; settle points are always re-sent so a
    // failed adoption is retried once per turn.
    let changed = previous.is_null()
        || previous_state != state
        || text(&previous, "harnessSessionId") != session_id
        || text(&previous, "recoveryAttemptId") != attempt;
    if !session_id.is_empty() && !foreign_session && (changed || state == "done" || state == "idle") {
        let spool = ctx.runtime_dir.join("hook-events");
        private_dir(&spool)?;
        let request = json!({
            "pane": ctx.pane,
            "clankerId": clanker_id,
            "harnessSessionId": session_id,
            "state": state,
            "recoveryAttemptId": if attempt.is_empty() { Value::Null } else { json!(attempt) },
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

fn tmux_option(key: &str) -> &'static str {
    match key {
        "clankerId" => "@clankerhouse_clanker_id",
        "harness" => "@dotfiles_harness",
        "harnessSessionId" => "@clankerhouse_harness_session_id",
        _ => "@clankerhouse_recovery_attempt",
    }
}

fn herdr_token(key: &str) -> &'static str {
    match key {
        "clankerId" => "ch_clanker_id",
        "harness" => "ch_harness",
        "harnessSessionId" => "ch_harness_session",
        _ => "ch_recovery_attempt",
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

fn read_claim(ctx: &Context, key: &str) -> Option<String> {
    let value = match ctx.mux {
        Mux::Herdr => herdr_request("pane.get", json!({ "pane_id": ctx.pane }))?
            .get("pane")?
            .get("tokens")?
            .get(herdr_token(key))?
            .as_str()?
            .to_string(),
        Mux::Tmux => {
            let output = Command::new("tmux")
                .args(["show-option", "-p", "-qv", "-t", &ctx.pane, tmux_option(key)])
                .stdin(Stdio::null())
                .stderr(Stdio::null())
                .output()
                .ok()?;
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        }
    };
    if value.is_empty() { None } else { Some(value) }
}

fn pane_path(ctx: &Context) -> Option<PathBuf> {
    let path = match ctx.mux {
        Mux::Herdr => {
            let result = herdr_request("pane.get", json!({ "pane_id": ctx.pane }))?;
            let pane = result.get("pane")?;
            ["foreground_cwd", "cwd"].iter().find_map(|key| pane.get(*key)?.as_str().filter(|v| !v.is_empty()).map(str::to_string))?
        }
        Mux::Tmux => {
            let output = Command::new("tmux")
                .args(["display-message", "-p", "-t", &ctx.pane, "#{pane_current_path}"])
                .stdin(Stdio::null())
                .stderr(Stdio::null())
                .output()
                .ok()?;
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        }
    };
    if path.is_empty() { None } else { Some(PathBuf::from(path)) }
}

fn write_claims(ctx: &Context, claims: &BTreeMap<&str, Option<String>>) {
    match ctx.mux {
        Mux::Herdr => {
            let tokens: Map<String, Value> =
                claims.iter().map(|(key, value)| (herdr_token(key).to_string(), json!(value))).collect();
            herdr_request("pane.report_metadata", json!({ "pane_id": ctx.pane, "source": "clankerhouse", "tokens": tokens }));
        }
        Mux::Tmux => {
            for (key, value) in claims {
                let mut command = Command::new("tmux");
                match value {
                    Some(value) => command.args(["set-option", "-p", "-t", &ctx.pane, tmux_option(key), value]),
                    None => command.args(["set-option", "-p", "-u", "-t", &ctx.pane, tmux_option(key)]),
                };
                let _ = command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
            }
        }
    }
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
    use super::{prompt_sha256, sha256_hex};

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
