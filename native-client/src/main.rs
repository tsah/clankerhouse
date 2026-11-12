use std::{
    collections::{HashMap, HashSet},
    env, fs,
    io::{self, BufRead, BufReader, IsTerminal, Write},
    os::unix::net::UnixStream,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, Sender},
    },
    thread,
    time::Duration,
};

use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyModifiers};
use ratatui::{
    DefaultTerminal, Frame,
    layout::{Constraint, Layout},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, List, ListItem, ListState, Paragraph},
};
use serde::{Deserialize, Serialize};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

const CACHE_VERSION: u64 = 11;
static DELETE_REQUESTED: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Target {
    Session {
        session: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        management: Option<String>,
        #[serde(
            default,
            rename = "resourceId",
            skip_serializing_if = "Option::is_none"
        )]
        resource_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        location: Option<MultiplexerLocation>,
    },
    Window {
        session: String,
        #[serde(rename = "windowId")]
        window_id: String,
        pane: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        management: Option<String>,
        #[serde(
            default,
            rename = "resourceId",
            skip_serializing_if = "Option::is_none"
        )]
        resource_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        location: Option<MultiplexerLocation>,
    },
    Opencode {
        session: String,
        pane: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        management: Option<String>,
        #[serde(
            default,
            rename = "resourceId",
            skip_serializing_if = "Option::is_none"
        )]
        resource_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        location: Option<MultiplexerLocation>,
    },
    Directory {
        path: String,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct MultiplexerLocation {
    kind: String,
    instance_id: String,
    native_session_id: String,
    native_window_id: Option<String>,
    native_pane_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum ClankerState {
    Failed,
    Blocked,
    Working,
    Done,
    Idle,
    Unknown,
}

#[derive(Clone, Debug, Deserialize)]
struct DetailRow {
    kind: String,
    #[serde(default)]
    harness: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    title: String,
    state: ClankerState,
    target: Target,
    #[serde(default)]
    observation: Option<RuntimeObservation>,
    #[serde(default, rename = "clankerId")]
    clanker_id: Option<String>,
}

/// Why a Workshop waits on the operator, as the daemon decided it (src/needs-me.ts).
#[derive(Clone, Debug, Deserialize, PartialEq)]
struct NeedsMe {
    reason: String,
    /// Epoch milliseconds the reason has held since.
    #[serde(default)]
    since: f64,
    #[serde(default)]
    detail: Option<String>,
    #[serde(default)]
    excerpt: Option<String>,
    #[serde(default, rename = "clankerId")]
    clanker_id: Option<String>,
    /// Snoozed with Alt-S until this epoch ms (src/needs-me.ts decides whether it still holds).
    #[serde(default, rename = "snoozedUntil")]
    snoozed_until: Option<f64>,
    /// The unsettled Workshop this one waits on, by name.
    #[serde(default, rename = "waitingOn")]
    waiting_on: Option<String>,
}

impl NeedsMe {
    /// Snoozed or waiting on another Workshop: listed after everything else.
    fn deferred(&self) -> bool {
        self.snoozed_until.is_some() || self.waiting_on.is_some()
    }
}

/// How long Alt-S keeps a row down, unless its reason changes first.
const SNOOZE_MS: f64 = 86_400_000.0;

/// The hidden label Alt-S writes for the row's current reason (src/needs-me.ts parseSnooze), or None to clear it.
fn snooze_value(reason: &NeedsMe, now_ms: f64) -> Option<String> {
    (reason.snoozed_until.is_none())
        .then(|| format!("{}:{}:{}", reason.reason, reason.since.round() as i64, (now_ms + SNOOZE_MS).round() as i64))
}

#[derive(Clone, Debug, Deserialize)]
struct RuntimeObservation {
    source: String,
    confidence: String,
    state: String,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum AvailableAction {
    Open,
    Rename,
    Attach,
    Detach,
    Delete,
    Create,
}

#[derive(Clone, Debug, Deserialize)]
struct SessionRow {
    name: String,
    path: String,
    #[serde(default)]
    branch: String,
    #[serde(default)]
    flags: String,
    #[serde(default)]
    markers: Vec<String>,
    #[serde(default)]
    labels: Vec<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    project: Option<String>,
    #[serde(default)]
    age: String,
    #[serde(default)]
    recency: u64,
    target: Target,
    #[serde(default)]
    details: Vec<DetailRow>,
    #[serde(default, rename = "directorySource")]
    directory_source: String,
    #[serde(default, rename = "activitySource")]
    activity_source: String,
    #[serde(default, rename = "workshopId")]
    workshop_id: Option<String>,
    #[serde(default)]
    management: String,
    #[serde(default, rename = "availableActions")]
    available_actions: Vec<AvailableAction>,
    #[serde(default, rename = "parentWorkshopId")]
    parent_workshop_id: Option<String>,
    #[serde(default, rename = "attachmentCandidateWorkshopIds")]
    attachment_candidate_workshop_ids: Option<Vec<String>>,
    #[serde(default, rename = "needsMe")]
    needs_me: Option<NeedsMe>,
}

#[derive(Deserialize)]
struct Snapshot {
    version: u64,
    sessions: Vec<SessionRow>,
}

#[derive(Deserialize)]
struct RepositoryCache {
    version: u64,
    entries: HashMap<String, RepositoryCacheEntry>,
}

#[derive(Deserialize)]
struct RepositoryCacheEntry {
    #[serde(rename = "commonDir")]
    common_dir: String,
}

#[derive(Clone)]
struct RepositoryRow {
    name: String,
    path: String,
    common_dir: String,
    /// Milliseconds since the epoch of the newest durable "opened" or "active"
    /// activity in any checkout of this repository; 0 when never used.
    last_used: u64,
}

#[derive(Deserialize)]
struct ActivityRecord {
    path: String,
    #[serde(rename = "updatedAt")]
    updated_at: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BranchKind {
    Worktree,
    Local,
    Remote,
    Create,
}

#[derive(Clone)]
struct BranchRow {
    name: String,
    value: String,
    kind: BranchKind,
    path: String,
    recency: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    Jump,
    Repository,
    Branch,
    NewBase,
    Rename,
    Attach,
    DeleteConfirm,
}

/// What the one Workshop list (Mode::Jump) shows; Alt plus a letter switches, so plain letters stay the query.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum View {
    /// Alt-F: every target, as a tree by lineage.
    Flat,
    /// Alt-I: only the Workshops that need the operator, the freshest first.
    NeedsMe,
    /// Alt-E: the same rows, the longest waiting (eldest) first.
    Eldest,
}

impl View {
    /// One of the two sorted lists of Workshops that need the operator.
    fn waiting(self) -> bool {
        self != View::Flat
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum DeleteKind {
    Pane,
    Session,
    Worktree,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum MutationIntent {
    Open {
        target: Target,
    },
    Rename {
        session: String,
        #[serde(rename = "resourceId", skip_serializing_if = "Option::is_none")]
        resource_id: Option<String>,
        #[serde(rename = "displayName")]
        display_name: String,
    },
    Attach {
        #[serde(rename = "workshopId")]
        workshop_id: String,
        #[serde(rename = "parentWorkshopId")]
        parent_workshop_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        session: Option<String>,
    },
    Detach {
        #[serde(rename = "workshopId")]
        workshop_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        session: Option<String>,
    },
    Delete {
        kind: DeleteKind,
        session: String,
        confirmed: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        pane: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        path: Option<String>,
    },
    Create {
        repository: String,
        branch: String,
        create: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        base: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[serde(rename = "remoteRef")]
        remote_ref: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<String>,
    },
    Done {
        path: String,
    },
    Label {
        path: String,
        key: String,
        value: Option<String>,
    },
    #[serde(rename = "repository.refresh")]
    RepositoryRefresh,
}

#[derive(Clone)]
struct TreeRow {
    key: String,
    depth: usize,
    session: SessionRow,
    detail: Option<DetailRow>,
    state: ClankerState,
    contains_clanker: bool,
    has_children: bool,
    is_last: bool,
    done_group: Option<DoneGroup>,
}

/// Done Workshops folded into one summary row beneath their parent (None: among the roots).
#[derive(Clone, Debug, PartialEq)]
struct DoneGroup {
    parent: Option<String>,
    count: usize,
    expanded: bool,
}

struct TreeBuildContext<'a> {
    by_parent: &'a HashMap<Option<String>, Vec<usize>>,
    states: &'a [ClankerState],
    has_clankers: &'a [bool],
    foldable: &'a [bool],
    included: &'a HashSet<String>,
    query: &'a str,
}


struct App {
    cache_path: PathBuf,
    sessions: Vec<SessionRow>,
    rows: Vec<TreeRow>,
    expanded_lineage: HashSet<String>,
    expanded_details: HashSet<String>,
    expanded_done_groups: HashSet<Option<String>>,
    show_done: bool,
    selected: usize,
    query: String,
    unfiltered_selection: Option<String>,
    current_session: String,
    error: String,
    mutation: Option<PendingMutation>,
    delete_only: bool,
    animation_frame: usize,
    mode: Mode,
    repositories: Vec<RepositoryRow>,
    branches: Vec<BranchRow>,
    repository: Option<RepositoryRow>,
    branch_name: String,
    base: String,
    action_session: Option<SessionRow>,
    rename_name: String,
    attach_candidates: Vec<SessionRow>,
    delete_intent: Option<MutationIntent>,
    delete_label: String,
    done_pending: bool,
    delete_requested: bool,
    workshop_title: Option<String>,
    rename_title_path: Option<String>,
    worktree_delete: Option<(MutationIntent, String)>,
    reopen_path: Option<String>,
    repository_identities: HashMap<String, String>,
    /// Repository mode for a scratch Workshop (Alt-N): choosing a repository creates it at once.
    scratch: bool,
    /// What Jump mode lists: everything (Alt-F), or the Workshops that need the operator (Alt-I, Alt-E).
    view: View,
}

#[derive(Clone, Debug, PartialEq)]
enum AppCommand {
    Close,
    Submit(MutationIntent),
    CreateAndOpen(MutationIntent),
    Scratch { repository: String },
}

struct PendingMutation {
    progress: String,
    submitted: bool,
    exit_after_submit: Option<AppCommand>,
}

enum MutationUpdate {
    Submitted,
    Finished(Result<serde_json::Value, String>),
}

#[derive(Debug, PartialEq)]
enum CommandDispatch {
    Continue,
    Background(MutationIntent),
    Exit(AppCommand),
}

// Navigation stays available while a mutation runs. Only another mutation is
// refused; leaving waits for durable acceptance, never for effect completion.
fn dispatch_command(app: &mut App, command: AppCommand) -> CommandDispatch {
    match command {
        AppCommand::Submit(intent) if !matches!(intent, MutationIntent::Open { .. }) => {
            if app.mutation.is_some() {
                app.error = "An action is already running; navigation and opening remain available".into();
                return CommandDispatch::Continue;
            }
            app.mutation = Some(PendingMutation {
                progress: mutation_progress_label(&intent).into(),
                submitted: false,
                exit_after_submit: None,
            });
            CommandDispatch::Background(intent)
        }
        command => {
            if let Some(pending) = app.mutation.as_mut()
                && !pending.submitted
            {
                pending.exit_after_submit = Some(command);
                CommandDispatch::Continue
            } else {
                CommandDispatch::Exit(command)
            }
        }
    }
}

fn apply_mutation_update(app: &mut App, update: MutationUpdate) -> Option<AppCommand> {
    match update {
        MutationUpdate::Submitted => {
            let pending = app.mutation.as_mut()?;
            pending.submitted = true;
            pending.exit_after_submit.take()
        }
        MutationUpdate::Finished(result) => {
            let pending = app.mutation.take()?;
            let done_pending = std::mem::take(&mut app.done_pending);
            match result {
                Ok(outcome) => {
                    if done_pending {
                        let handled =
                            outcome.get("handled").and_then(|value| value.as_bool()) == Some(true);
                        if !handled && app.delete_intent.is_some() {
                            // Nothing took the done key, so offer the destruction it stands for.
                            // The daemon, not the projected directory source, says whether that is a worktree.
                            let worktree =
                                outcome.get("worktree").and_then(|value| value.as_bool()) == Some(true);
                            if worktree && let Some((intent, label)) = app.worktree_delete.take() {
                                app.delete_intent = Some(intent);
                                app.delete_label = label;
                            }
                            app.mode = Mode::DeleteConfirm;
                            return pending.exit_after_submit;
                        }
                        app.clear_action_mode();
                    }
                    pending.exit_after_submit.or_else(|| app.delete_only.then_some(AppCommand::Close))
                }
                Err(error) => {
                    if done_pending {
                        app.clear_action_mode();
                    }
                    // Keep a failed submission visible rather than silently closing.
                    app.error = error;
                    None
                }
            }
        }
    }
}

fn aggregate(states: impl Iterator<Item = ClankerState>) -> ClankerState {
    let states = states.collect::<Vec<_>>();
    [
        ClankerState::Failed,
        ClankerState::Blocked,
        ClankerState::Working,
        ClankerState::Done,
        ClankerState::Idle,
    ]
    .into_iter()
    .find(|state| states.contains(state))
    .unwrap_or(ClankerState::Unknown)
}

/// How pressing a reason is: clankers waiting on the operator, then finished but unseen, then failed or crashed, then
/// a label that says it is the operator's move, then Workshops to close or look at. It picks the one row of a
/// Workshop with several sessions and breaks ties of age; age itself orders the list. An unknown reason from a
/// newer daemon ranks last.
fn needs_me_rank(reason: &str) -> u8 {
    match reason {
        "asked" | "blocked" => 0,
        "finished" => 1,
        "failed" | "crashed" => 2,
        "your-move" => 3,
        _ => 4,
    }
}

/// The open Workshops that need the operator, one row each (its most pressing reason). Snoozed and waiting-on rows
/// come after everything else; otherwise age alone orders them: the freshest reason first (Alt-I), so the long
/// waiters surface only when nothing is newer, or the longest waiting first (Alt-E). A query only filters.
fn needs_me_sessions<'a>(sessions: &'a [SessionRow], query: &str, eldest_first: bool) -> Vec<&'a SessionRow> {
    let query = query.trim().to_lowercase();
    let mut chosen: Vec<&SessionRow> = Vec::new();
    for session in sessions {
        if session.needs_me.is_none()
            || !matches!(session.target, Target::Session { .. }) || (!query.is_empty() && search_score(session, &query).is_none()) {
            continue;
        }
        let order = |row: &SessionRow| row.needs_me.as_ref().map(|it| (it.deferred(), needs_me_rank(&it.reason), it.since));
        let same = chosen.iter().position(|known| session.workshop_id.is_some() && known.workshop_id == session.workshop_id);
        match same {
            Some(index) => {
                if order(session).partial_cmp(&order(chosen[index])) == Some(std::cmp::Ordering::Less) {
                    chosen[index] = session;
                }
            }
            None => chosen.push(session),
        }
    }
    chosen.sort_by(|left, right| {
        let (left, right) = (left.needs_me.as_ref().unwrap(), right.needs_me.as_ref().unwrap());
        let age = left.since.total_cmp(&right.since);
        left.deferred()
            .cmp(&right.deferred())
            .then(if eldest_first { age } else { age.reverse() })
            .then_with(|| needs_me_rank(&left.reason).cmp(&needs_me_rank(&right.reason)))
    });
    chosen
}

/// A short age: 45s, 12m, 3h, 6d.
fn short_age(milliseconds: f64) -> String {
    let seconds = (milliseconds.max(0.0) / 1000.0) as u64;
    match seconds {
        0..60 => format!("{seconds}s"),
        60..3600 => format!("{}m", seconds / 60),
        3600..86_400 => format!("{}h", seconds / 3600),
        _ => format!("{}d", seconds / 86_400),
    }
}

/// Why the row is listed and for how long, in the operator's words.
fn needs_me_status(reason: &NeedsMe, now_ms: f64) -> String {
    let status = needs_me_reason_status(reason, now_ms);
    match (&reason.waiting_on, reason.snoozed_until) {
        (Some(other), _) => format!("waiting on {other} · {status}"),
        (None, Some(_)) => format!("snoozed · {status}"),
        _ => status,
    }
}

/// What keeps a row down the needs-me lists, for the flat list's right column; empty when nothing does.
fn deferred_status(reason: &NeedsMe) -> String {
    match (&reason.waiting_on, reason.snoozed_until) {
        (Some(other), _) => format!("waiting on {other}"),
        (None, Some(_)) => "snoozed".into(),
        _ => String::new(),
    }
}

fn needs_me_reason_status(reason: &NeedsMe, now_ms: f64) -> String {
    let age = short_age(now_ms - reason.since);
    let detail = reason.detail.as_deref().unwrap_or_default();
    match reason.reason.as_str() {
        "asked" => format!("asked {age} ago"),
        "blocked" if !detail.is_empty() => format!("blocked {age} · {detail}"),
        "blocked" => format!("blocked {age}"),
        "your-move" => format!("{} {age}", if detail.is_empty() { "your move" } else { detail }),
        "finished" => format!("finished {age} ago, not seen"),
        "failed" => format!("failed {age} ago"),
        "crashed" if detail == "interrupted" => format!("interrupted {age} ago"),
        "crashed" => format!("crashed {age} ago"),
        "ready" => format!("clean, idle {age} · ready to close"),
        "stale" => format!("no activity {age}"),
        other => format!("{other} {age}"),
    }
}

fn session_state(session: &SessionRow) -> ClankerState {
    aggregate(session.details.iter().map(|detail| detail.state))
}

fn neutral_session(session: &SessionRow) -> bool {
    matches!(session.target, Target::Directory { .. })
        || session
            .details
            .iter()
            .all(neutral_detail)
}

fn subtree_state(
    index: usize,
    sessions: &[SessionRow],
    by_parent: &HashMap<Option<String>, Vec<usize>>,
    visiting: &mut HashSet<usize>,
) -> ClankerState {
    if !visiting.insert(index) {
        return ClankerState::Unknown;
    }
    let session = &sessions[index];
    let children = session
        .workshop_id
        .as_ref()
        .and_then(|id| by_parent.get(&Some(id.clone())))
        .into_iter()
        .flatten()
        .map(|child| subtree_state(*child, sessions, by_parent, visiting));
    let state = aggregate(std::iter::once(session_state(session)).chain(children));
    visiting.remove(&index);
    state
}

/// A subtree folds only when every Workshop in it is done, none is on the current lineage,
/// and nothing in it still wants attention (a live, blocked, failed or unseen-done clanker).
fn subtree_foldable(
    index: usize,
    sessions: &[SessionRow],
    by_parent: &HashMap<Option<String>, Vec<usize>>,
    states: &[ClankerState],
    current_lineage: &HashSet<usize>,
    visiting: &mut HashSet<usize>,
) -> bool {
    if !visiting.insert(index) {
        return false;
    }
    let session = &sessions[index];
    let foldable = is_done(session)
        && !current_lineage.contains(&index)
        // An unseen completion is not activity: finishing is exactly how a Workshop becomes done.
        && !matches!(states[index], ClankerState::Working | ClankerState::Blocked | ClankerState::Failed)
        && session
            .workshop_id
            .as_ref()
            .and_then(|id| by_parent.get(&Some(id.clone())))
            .into_iter()
            .flatten()
            .all(|child| subtree_foldable(*child, sessions, by_parent, states, current_lineage, visiting));
    visiting.remove(&index);
    foldable
}

fn subtree_size(
    index: usize,
    sessions: &[SessionRow],
    by_parent: &HashMap<Option<String>, Vec<usize>>,
    visiting: &mut HashSet<usize>,
) -> usize {
    if !visiting.insert(index) {
        return 0;
    }
    1 + sessions[index]
        .workshop_id
        .as_ref()
        .and_then(|id| by_parent.get(&Some(id.clone())))
        .into_iter()
        .flatten()
        .map(|child| subtree_size(*child, sessions, by_parent, visiting))
        .sum::<usize>()
}

/// The summary row stands on a placeholder session with no target and no actions, so no
/// Workshop action can reach a real Workshop through it.
fn done_group_row(group: DoneGroup, depth: usize, is_last: bool) -> TreeRow {
    TreeRow {
        key: format!("done-group:{}", group.parent.as_deref().unwrap_or("")),
        depth,
        session: SessionRow {
            name: format!("{} done", group.count),
            path: String::new(),
            branch: String::new(),
            flags: String::new(),
            markers: Vec::new(),
            labels: Vec::new(),
            title: None,
            project: None,
            age: String::new(),
            recency: 0,
            target: Target::Directory { path: String::new() },
            details: Vec::new(),
            directory_source: String::new(),
            activity_source: String::new(),
            workshop_id: None,
            management: String::new(),
            available_actions: Vec::new(),
            parent_workshop_id: None,
            attachment_candidate_workshop_ids: None,
            needs_me: None,
        },
        detail: None,
        state: ClankerState::Unknown,
        contains_clanker: false,
        has_children: false,
        is_last,
        done_group: Some(group),
    }
}

fn subtree_recency(
    index: usize,
    sessions: &[SessionRow],
    by_parent: &HashMap<Option<String>, Vec<usize>>,
    visiting: &mut HashSet<usize>,
) -> u64 {
    if !visiting.insert(index) {
        return 0;
    }
    let session = &sessions[index];
    let recency = session
        .workshop_id
        .as_ref()
        .and_then(|id| by_parent.get(&Some(id.clone())))
        .into_iter()
        .flatten()
        .map(|child| subtree_recency(*child, sessions, by_parent, visiting))
        .fold(session.recency, u64::max);
    visiting.remove(&index);
    recency
}

fn expanded_lineage_row_count(
    index: usize,
    sessions: &[SessionRow],
    by_parent: &HashMap<Option<String>, Vec<usize>>,
    visiting: &mut HashSet<usize>,
) -> usize {
    if !visiting.insert(index) {
        return 0;
    }
    let session = &sessions[index];
    let children = session
        .workshop_id
        .as_ref()
        .and_then(|id| by_parent.get(&Some(id.clone())))
        .into_iter()
        .flatten()
        .map(|child| expanded_lineage_row_count(*child, sessions, by_parent, visiting))
        .sum::<usize>();
    visiting.remove(&index);
    1 + children
}

fn subtree_has_clanker(
    index: usize,
    sessions: &[SessionRow],
    by_parent: &HashMap<Option<String>, Vec<usize>>,
    visiting: &mut HashSet<usize>,
) -> bool {
    if !visiting.insert(index) {
        return false;
    }
    let session = &sessions[index];
    let found = session.details.iter().any(|detail| detail.kind == "clanker")
        || session
            .workshop_id
            .as_ref()
            .and_then(|id| by_parent.get(&Some(id.clone())))
            .into_iter()
            .flatten()
            .any(|child| subtree_has_clanker(*child, sessions, by_parent, visiting));
    visiting.remove(&index);
    found
}

fn target_key(target: &Target) -> String {
    match target {
        Target::Session {
            session,
            resource_id,
            ..
        } => resource_id.as_ref().map_or_else(
            || format!("session:{session}"),
            |id| format!("session:{id}"),
        ),
        Target::Window {
            session,
            window_id,
            resource_id,
            ..
        } => resource_id.as_ref().map_or_else(
            || format!("window:{session}:{window_id}"),
            |id| format!("window:{id}"),
        ),
        Target::Opencode {
            session,
            pane,
            resource_id,
            ..
        } => resource_id.as_ref().map_or_else(
            || format!("opencode:{session}:{pane}"),
            |id| format!("opencode:{id}"),
        ),
        Target::Directory { path } => format!("directory:{path}"),
    }
}

fn target_is_session(target: &Target, current: &str) -> bool {
    let identities = current.split('\t').collect::<HashSet<_>>();
    matches!(target, Target::Session { session, location, .. } if identities.contains(session.as_str()) || location.as_ref().is_some_and(|location| identities.contains(location.native_session_id.as_str())))
}

fn fuzzy_score(text: &str, query: &str) -> Option<i64> {
    if query.is_empty() {
        return Some(0);
    }
    let text = text.to_lowercase().chars().collect::<Vec<_>>();
    let mut positions = Vec::new();
    let mut from = 0;
    for needle in query.to_lowercase().chars() {
        let offset = text[from..].iter().position(|value| *value == needle)?;
        let position = from + offset;
        positions.push(position);
        from = position + 1;
    }
    let span = positions.last()? - positions.first()? + 1;
    let mut score = query.chars().count() as i64 * 100 - span as i64 * 8 - positions[0] as i64 * 2;
    for (index, position) in positions.iter().enumerate() {
        if *position == 0 {
            score += 35;
        }
        if *position > 0 && "/@-_ .".contains(text[*position - 1]) {
            score += 30;
        }
        if index > 0 && *position == positions[index - 1] + 1 {
            score += 45;
        }
    }
    Some(score)
}

fn search_score(session: &SessionRow, query: &str) -> Option<i64> {
    let markers = session.markers.join(" ");
    let labels = session.labels.join(" ");
    let title = session.title.clone().unwrap_or_default();
    let project = session.project.clone().unwrap_or_default();
    let fields = [
        (&title, 180),
        (&project, 120),
        (&session.name, 180),
        (&session.branch, 140),
        (&session.path, 80),
        (&session.flags, 40),
        (&markers, 50),
        (&labels, 50),
        (&session.directory_source, 20),
    ];
    let mut total = 0;
    for term in query.to_lowercase().split_whitespace() {
        let mut best = None;
        for (field, weight) in fields {
            if let Some(score) = fuzzy_score(field, term) {
                best = Some(best.map_or(score + weight, |value: i64| value.max(score + weight)));
            }
        }
        for detail in &session.details {
            for (field, weight) in [
                (&detail.title, 160),
                (&detail.kind, 140),
                (&detail.harness, 140),
                (&detail.status, 80),
            ] {
                if let Some(score) = fuzzy_score(field, term) {
                    best = Some(best.map_or(score + weight, |value| value.max(score + weight)));
                }
            }
        }
        total += best?;
    }
    Some(total)
}

fn session_direct_search_score(session: &SessionRow, query: &str) -> Option<i64> {
    let title = session.title.clone().unwrap_or_default();
    let project = session.project.clone().unwrap_or_default();
    let labels = session.labels.join(" ");
    let fields = [(&title, 180), (&session.name, 180), (&session.branch, 140), (&project, 120), (&session.path, 80), (&labels, 50)];
    let mut total = 0;
    for term in query.to_lowercase().split_whitespace() {
        let mut best = None;
        for (field, weight) in fields {
            if !field.to_lowercase().contains(term) {
                continue;
            }
            if let Some(score) = fuzzy_score(field, term) {
                let weighted = score + weight + 1_000;
                best = Some(best.map_or(weighted, |value: i64| value.max(weighted)));
            }
        }
        total += best?;
    }
    Some(total)
}

fn detail_search_score(detail: &DetailRow, query: &str) -> Option<i64> {
    let mut total = 0;
    for term in query.to_lowercase().split_whitespace() {
        let mut best = None;
        for (field, weight) in [
            (&detail.title, 160),
            (&detail.kind, 140),
            (&detail.harness, 140),
            (&detail.status, 80),
        ] {
            if let Some(score) = fuzzy_score(field, term) {
                best = Some(best.map_or(score + weight, |value: i64| value.max(score + weight)));
            }
        }
        total += best?;
    }
    Some(total)
}

fn repository_cache(cache_path: &Path) -> Option<RepositoryCache> {
    let raw = fs::read(cache_path.with_file_name("repositories.json")).ok()?;
    let cache = serde_json::from_slice::<RepositoryCache>(&raw).ok()?;
    (cache.version == 1).then_some(cache)
}

fn repository_identities(cache_path: &Path) -> HashMap<String, String> {
    let Some(cache) = repository_cache(cache_path) else {
        return HashMap::new();
    };
    cache
        .entries
        .into_iter()
        .filter_map(|(path, entry)| {
            (!entry.common_dir.is_empty()).then_some((path, entry.common_dir))
        })
        .collect()
}

fn repository_rows(cache_path: &Path, sessions: &[SessionRow]) -> Vec<RepositoryRow> {
    let identities = repository_identities(cache_path);
    let mut repositories = HashMap::<String, RepositoryRow>::new();
    for session in sessions {
        let Some(common_dir) = identities.get(&session.path) else {
            continue;
        };
        let repository_root = common_dir
            .strip_suffix("/.git")
            .unwrap_or(common_dir)
            .to_string();
        let name = Path::new(&repository_root)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(&repository_root)
            .to_string();
        let candidate = RepositoryRow {
            name,
            path: session.path.clone(),
            common_dir: common_dir.clone(),
            last_used: 0,
        };
        let replace = repositories.get(common_dir).is_none_or(|existing| {
            let existing_main = sessions
                .iter()
                .find(|row| row.path == existing.path)
                .is_some_and(|row| matches!(row.branch.as_str(), "main" | "master"));
            let candidate_main = matches!(session.branch.as_str(), "main" | "master");
            candidate_main && !existing_main
        });
        if replace {
            repositories.insert(common_dir.clone(), candidate);
        }
    }
    let mut rows = repositories.into_values().collect::<Vec<_>>();
    rows.sort_by(|left, right| left.name.cmp(&right.name));
    rows
}

/// The git common dir of a checkout, read from its `.git` entry without
/// running git: a main checkout's `.git` directory, or the `gitdir:` a linked
/// worktree's `.git` file points into (`<common>/worktrees/<name>`).
fn checkout_common_dir(path: &Path) -> Option<String> {
    let dot_git = path.join(".git");
    let metadata = fs::metadata(&dot_git).ok()?;
    if metadata.is_dir() {
        return Some(dot_git.to_string_lossy().into_owned());
    }
    let raw = fs::read_to_string(&dot_git).ok()?;
    let gitdir = Path::new(raw.strip_prefix("gitdir:")?.trim());
    let gitdir = path.join(gitdir);
    let common = match gitdir.parent() {
        Some(parent) if parent.file_name().is_some_and(|name| name == "worktrees") => parent.parent()?,
        _ => &gitdir,
    };
    Some(common.to_string_lossy().into_owned())
}

/// Newest "opened" (Workshop created or opened) and "active" (attached and
/// focused) activity per repository common dir, from the daemon's durable
/// activity records. Clanker-report activity is ignored so a busy background
/// agent does not pin a repository to the top. Only the two relevant record
/// kinds are read, picked by file name; a path the repository cache does not
/// know is resolved from its `.git` entry, never by running git. Records for
/// checkouts that no longer exist cannot be attributed and are skipped.
fn repository_last_used(
    activity_dir: &Path,
    identities: &HashMap<String, String>,
) -> HashMap<String, u64> {
    let mut last_used = HashMap::<String, u64>::new();
    let Ok(entries) = fs::read_dir(activity_dir) else {
        return last_used;
    };
    for entry in entries.flatten() {
        let file_name = entry.file_name();
        let Some(file_name) = file_name.to_str() else {
            continue;
        };
        if !(file_name.ends_with("-opened.json") || file_name.ends_with("-active.json")) {
            continue;
        }
        let Ok(raw) = fs::read(entry.path()) else {
            continue;
        };
        let Ok(record) = serde_json::from_slice::<ActivityRecord>(&raw) else {
            continue;
        };
        let Some(common_dir) = identities
            .get(&record.path)
            .cloned()
            .or_else(|| checkout_common_dir(Path::new(&record.path)))
        else {
            continue;
        };
        let newest = last_used.entry(common_dir).or_default();
        *newest = (*newest).max(record.updated_at);
    }
    last_used
}

/// Most recently used first; never-used repositories keep name order after them.
fn order_repositories(rows: &mut [RepositoryRow], last_used: &HashMap<String, u64>) {
    for row in rows.iter_mut() {
        row.last_used = last_used.get(&row.common_dir).copied().unwrap_or(0);
    }
    rows.sort_by(|left, right| {
        right
            .last_used
            .cmp(&left.last_used)
            .then_with(|| left.name.cmp(&right.name))
    });
}

fn branch_rank(kind: BranchKind) -> u8 {
    match kind {
        BranchKind::Worktree => 0,
        BranchKind::Local => 1,
        BranchKind::Remote => 2,
        BranchKind::Create => 3,
    }
}

fn collect_branches(repository: &Path) -> Result<Vec<BranchRow>, String> {
    let worktree_output = Command::new("git")
        .args([
            "-C",
            &repository.to_string_lossy(),
            "worktree",
            "list",
            "--porcelain",
        ])
        .output()
        .map_err(|error| error.to_string())?;
    let mut worktrees = HashMap::new();
    let mut current_path = String::new();
    for line in String::from_utf8_lossy(&worktree_output.stdout).lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            current_path = path.into();
        }
        if let Some(branch) = line.strip_prefix("branch refs/heads/") {
            worktrees.insert(branch.to_string(), current_path.clone());
        }
    }
    let refs = Command::new("git")
        .args([
            "-C",
            &repository.to_string_lossy(),
            "for-each-ref",
            "--format=%(refname)\t%(refname:short)\t%(committerdate:unix)",
            "refs/heads",
            "refs/remotes",
        ])
        .output()
        .map_err(|error| error.to_string())?;
    if !refs.status.success() {
        return Err(String::from_utf8_lossy(&refs.stderr).trim().into());
    }
    let mut local = HashSet::new();
    let mut remote = HashSet::new();
    let mut rows = Vec::new();
    let refs_text = String::from_utf8_lossy(&refs.stdout);
    let parsed = refs_text
        .lines()
        .map(|line| line.split('\t').collect::<Vec<_>>())
        .collect::<Vec<_>>();
    for parts in &parsed {
        let Some(name) = parts
            .first()
            .and_then(|reference| reference.strip_prefix("refs/heads/"))
        else {
            continue;
        };
        local.insert(name.to_string());
        let path = worktrees.get(name).cloned().unwrap_or_default();
        rows.push(BranchRow {
            name: name.into(),
            value: name.into(),
            kind: if path.is_empty() {
                BranchKind::Local
            } else {
                BranchKind::Worktree
            },
            path,
            recency: parts
                .get(2)
                .and_then(|value| value.parse().ok())
                .unwrap_or(0),
        });
    }
    for parts in &parsed {
        let Some(reference) = parts
            .first()
            .and_then(|reference| reference.strip_prefix("refs/remotes/"))
        else {
            continue;
        };
        if reference.ends_with("/HEAD") {
            continue;
        }
        let name = reference
            .split_once('/')
            .map(|(_, name)| name)
            .unwrap_or(reference);
        if name.is_empty() || local.contains(name) || !remote.insert(reference.to_string()) {
            continue;
        }
        rows.push(BranchRow {
            name: reference.into(),
            value: name.into(),
            kind: BranchKind::Remote,
            path: String::new(),
            recency: parts
                .get(2)
                .and_then(|value| value.parse().ok())
                .unwrap_or(0),
        });
    }
    rows.sort_by(|left, right| {
        branch_rank(left.kind)
            .cmp(&branch_rank(right.kind))
            .then_with(|| {
                if left.kind == BranchKind::Remote {
                    right.recency.cmp(&left.recency)
                } else {
                    left.name.cmp(&right.name)
                }
            })
    });
    Ok(rows)
}

impl App {
    fn new(cache_path: PathBuf, current_session: String) -> Result<Self, String> {
        let mut app = Self {
            cache_path,
            sessions: Vec::new(),
            rows: Vec::new(),
            expanded_lineage: HashSet::new(),
            expanded_done_groups: HashSet::new(),
            show_done: false,
            expanded_details: HashSet::new(),
            selected: 0,
            query: String::new(),
            unfiltered_selection: None,
            current_session,
            error: String::new(),
            mutation: None,
            delete_only: false,
            animation_frame: 0,
            mode: Mode::Jump,
            repositories: Vec::new(),
            branches: Vec::new(),
            repository: None,
            branch_name: String::new(),
            base: "^".into(),
            action_session: None,
            rename_name: String::new(),
            attach_candidates: Vec::new(),
            delete_intent: None,
            delete_label: String::new(),
            done_pending: false,
            delete_requested: false,
            workshop_title: None,
            rename_title_path: None,
            worktree_delete: None,
            reopen_path: None,
            repository_identities: HashMap::new(),
            scratch: false,
            view: View::Flat,
        };
        app.repository_identities = repository_identities(&app.cache_path);
        let snapshot: Snapshot = serde_json::from_slice(
            &fs::read(&app.cache_path).map_err(|error| format!("Snapshot unavailable: {error}"))?,
        )
        .map_err(|error| format!("Invalid snapshot: {error}"))?;
        app.apply_snapshot(snapshot, true)?;
        app.repositories = repository_rows(&app.cache_path, &app.sessions);
        Ok(app)
    }

    fn from_snapshot(
        cache_path: PathBuf,
        current_session: String,
        snapshot: Snapshot,
    ) -> Result<Self, String> {
        let mut app = Self::new_empty(cache_path, current_session);
        app.apply_snapshot(snapshot, true)?;
        app.repositories = repository_rows(&app.cache_path, &app.sessions);
        Ok(app)
    }

    fn new_empty(cache_path: PathBuf, current_session: String) -> Self {
        let repository_identities = repository_identities(&cache_path);
        Self {
            cache_path,
            sessions: Vec::new(),
            rows: Vec::new(),
            expanded_lineage: HashSet::new(),
            expanded_done_groups: HashSet::new(),
            show_done: false,
            expanded_details: HashSet::new(),
            selected: 0,
            query: String::new(),
            unfiltered_selection: None,
            current_session,
            error: String::new(),
            mutation: None,
            delete_only: false,
            animation_frame: 0,
            mode: Mode::Jump,
            repositories: Vec::new(),
            branches: Vec::new(),
            repository: None,
            branch_name: String::new(),
            base: "^".into(),
            action_session: None,
            rename_name: String::new(),
            attach_candidates: Vec::new(),
            delete_intent: None,
            delete_label: String::new(),
            done_pending: false,
            delete_requested: false,
            workshop_title: None,
            rename_title_path: None,
            worktree_delete: None,
            reopen_path: None,
            repository_identities,
            scratch: false,
            view: View::Flat,
        }
    }

    fn confirm_current_deletion(&mut self) -> Result<(), String> {
        // Unlike presentation priority, destructive popup targeting must never
        // fall back to a native/display name that happens to resemble an ID.
        let native_id = self.current_session.split('\t').next().unwrap_or_default();
        let candidates = self.rows.iter().enumerate().filter(|(_, row)| {
            row.detail.is_none()
                && matches!(&row.session.target, Target::Session { location: Some(location), .. }
                    if location.native_session_id == native_id)
        }).map(|(index, _)| index).collect::<Vec<_>>();
        if self.current_session.is_empty() || candidates.len() != 1 {
            return Err("Cannot resolve the exact invoking Workshop for deletion".into());
        }
        let index = candidates[0];
        let row = &self.rows[index];
        let intent = delete_intent(row).ok_or("The invoking Workshop is not deletable")?;
        self.delete_only = true;
        self.selected = index;
        if !row.session.path.is_empty() {
            // The ordinary Alt-D path asks the daemon's done rule before offering destruction.
            self.delete_requested = true;
            return Ok(());
        }
        self.delete_label = delete_label(row, &intent);
        self.delete_intent = Some(intent);
        self.mode = Mode::DeleteConfirm;
        Ok(())
    }

    fn apply_snapshot(&mut self, snapshot: Snapshot, initial: bool) -> Result<(), String> {
        if snapshot.version != CACHE_VERSION {
            return Err(format!(
                "Snapshot version {} is unsupported",
                snapshot.version
            ));
        }
        let selected_key = self.rows.get(self.selected).map(|row| row.key.clone());
        self.sessions = snapshot.sessions;
        if initial {
            self.initialize_expansion();
        }
        self.rebuild(selected_key.as_deref());
        Ok(())
    }

    fn initialize_expansion(&mut self) {
        let mut by_parent: HashMap<Option<String>, Vec<usize>> = HashMap::new();
        for (index, session) in self.sessions.iter().enumerate() {
            by_parent.entry(session.parent_workshop_id.clone()).or_default().push(index);
        }
        for (index, session) in self.sessions.iter().enumerate() {
            let children = session
                .workshop_id
                .as_ref()
                .and_then(|id| by_parent.get(&Some(id.clone())))
                .map_or(0, Vec::len);
            let state = subtree_state(index, &self.sessions, &by_parent, &mut HashSet::new());
            let expanded_rows = expanded_lineage_row_count(index, &self.sessions, &by_parent, &mut HashSet::new());
            if children > 0
                && (expanded_rows < 10 || matches!(state, ClankerState::Working | ClankerState::Done))
            {
                self.expanded_lineage.insert(session.name.clone());
            }
        }
    }

    fn rebuild(&mut self, selected_key: Option<&str>) {
        if self.view.waiting() {
            self.rows = needs_me_sessions(&self.sessions, &self.query, self.view == View::Eldest)
                .into_iter()
                .map(|session| TreeRow {
                    key: target_key(&session.target),
                    depth: 0,
                    state: session_state(session),
                    contains_clanker: session.details.iter().any(|detail| detail.kind == "clanker"),
                    session: session.clone(),
                    detail: None,
                    has_children: false,
                    is_last: true,
                    done_group: None,
                })
                .collect();
            self.selected = selected_key
                .and_then(|key| self.rows.iter().position(|row| row.key == key))
                .unwrap_or(0)
                .min(self.rows.len().saturating_sub(1));
            return;
        }
        let query = self.query.trim().to_lowercase();
        let mut included = HashSet::new();
        let mut scores = HashMap::new();
        for session in &self.sessions {
            if query.is_empty() {
                included.insert(target_key(&session.target));
                continue;
            }
            if let Some(score) = search_score(session, &query) {
                included.insert(target_key(&session.target));
                scores.insert(target_key(&session.target), score);
                let mut parent = session.parent_workshop_id.as_ref();
                while let Some(parent_id) = parent {
                    let Some(parent_session) = self
                        .sessions
                        .iter()
                        .find(|candidate| candidate.workshop_id.as_ref() == Some(parent_id))
                    else {
                        break;
                    };
                    included.insert(target_key(&parent_session.target));
                    parent = parent_session.parent_workshop_id.as_ref();
                }
            }
        }
        let mut by_parent: HashMap<Option<String>, Vec<usize>> = HashMap::new();
        let id_counts = self
            .sessions
            .iter()
            .filter_map(|session| session.workshop_id.clone())
            .fold(HashMap::<String, usize>::new(), |mut counts, id| {
                *counts.entry(id).or_default() += 1;
                counts
            });
        // Compatibility sources can temporarily project more than one exact target
        // for one Workshop ID. Such an ID is not an unambiguous tree parent: keeping
        // each target as a root is preferable to rendering every child multiple times.
        let known_ids = id_counts
            .into_iter()
            .filter_map(|(id, count)| (count == 1).then_some(id))
            .collect::<HashSet<_>>();
        for (index, session) in self.sessions.iter().enumerate() {
            let parent = session
                .parent_workshop_id
                .clone()
                .filter(|id| known_ids.contains(id));
            by_parent.entry(parent).or_default().push(index);
        }
        let states = (0..self.sessions.len())
            .map(|index| subtree_state(index, &self.sessions, &by_parent, &mut HashSet::new()))
            .collect::<Vec<_>>();
        let has_clankers = (0..self.sessions.len())
            .map(|index| subtree_has_clanker(index, &self.sessions, &by_parent, &mut HashSet::new()))
            .collect::<Vec<_>>();
        let recencies = (0..self.sessions.len())
            .map(|index| subtree_recency(index, &self.sessions, &by_parent, &mut HashSet::new()))
            .collect::<Vec<_>>();
        let mut current_lineage = HashSet::new();
        let mut current = self
            .sessions
            .iter()
            .position(|session| target_is_session(&session.target, &self.current_session));
        while let Some(index) = current {
            if !current_lineage.insert(index) {
                break;
            }
            // Size defaults and manual collapse must never hide the current
            // Workshop. Reapply on refresh too, since lineage/names may change.
            self.expanded_lineage.insert(self.sessions[index].name.clone());
            current = self.sessions[index]
                .parent_workshop_id
                .as_ref()
                .and_then(|parent| {
                    self.sessions
                        .iter()
                        .position(|session| session.workshop_id.as_ref() == Some(parent))
                });
        }
        for (parent, children) in &mut by_parent {
            let roots = parent.is_none();
            children.sort_by(|left_index, right_index| {
                let left = &self.sessions[*left_index];
                let right = &self.sessions[*right_index];
                // Roots float by search relevance; lineage children keep structural
                // (current-lineage, neutral-last, recency, name) order so a descendant's incidental
                // fuzzy match against ancestor-derived text never reorders the subtree.
                let score_order = if roots {
                    let left_score = scores.get(&target_key(&left.target)).copied().unwrap_or(0);
                    let right_score = scores.get(&target_key(&right.target)).copied().unwrap_or(0);
                    right_score.cmp(&left_score)
                } else {
                    std::cmp::Ordering::Equal
                };
                score_order
                    .then_with(|| {
                        if roots {
                            current_lineage
                                .contains(right_index)
                                .cmp(&current_lineage.contains(left_index))
                        } else {
                            current_lineage
                                .contains(left_index)
                                .cmp(&current_lineage.contains(right_index))
                        }
                    })
                    .then_with(|| {
                        let neutral = |index: usize| {
                            states[index] == ClankerState::Unknown
                                && !has_clankers[index]
                                && neutral_session(&self.sessions[index])
                        };
                        if roots {
                            neutral(*left_index).cmp(&neutral(*right_index))
                        } else {
                            neutral(*right_index).cmp(&neutral(*left_index))
                        }
                    })
                    .then_with(|| {
                        if roots {
                            recencies[*right_index].cmp(&recencies[*left_index])
                        } else {
                            recencies[*left_index].cmp(&recencies[*right_index])
                        }
                    })
                    .then_with(|| left.name.cmp(&right.name))
            });
        }
        // Search and Alt-. show every done Workshop; otherwise wholly done subtrees fold away.
        let fold = query.is_empty() && !self.show_done;
        let foldable = (0..self.sessions.len())
            .map(|index| {
                fold && subtree_foldable(index, &self.sessions, &by_parent, &states, &current_lineage, &mut HashSet::new())
            })
            .collect::<Vec<_>>();
        let mut rows = Vec::new();
        let context = TreeBuildContext {
            by_parent: &by_parent,
            states: &states,
            has_clankers: &has_clankers,
            foldable: &foldable,
            included: &included,
            query: &query,
        };
        self.append_children(None, 0, &context, &mut rows);
        let root_starts = rows
            .iter()
            .enumerate()
            .filter_map(|(index, row)| (row.depth == 0).then_some(index))
            .collect::<Vec<_>>();
        self.rows = root_starts
            .iter()
            .enumerate()
            .flat_map(|(index, start)| {
                let end = root_starts.get(index + 1).copied().unwrap_or(rows.len());
                rows[*start..end].iter().rev().cloned()
            })
            .collect();
        // A selected Workshop that just folded away hands the selection to its done group.
        let absorbing_group = selected_key.and_then(|key| {
            let mut index = self.sessions.iter().position(|session| target_key(&session.target) == key)?;
            if !foldable[index] {
                return None;
            }
            loop {
                let parent = self.sessions[index].parent_workshop_id.clone().filter(|id| known_ids.contains(id));
                match parent.as_ref().and_then(|id| self.sessions.iter().position(|session| session.workshop_id.as_ref() == Some(id))) {
                    Some(parent_index) if foldable[parent_index] => index = parent_index,
                    _ => return Some(format!("done-group:{}", parent.as_deref().unwrap_or(""))),
                }
            }
        });
        self.selected = selected_key
            .and_then(|key| self.rows.iter().position(|row| row.key == key))
            .or_else(|| absorbing_group.and_then(|key| self.rows.iter().position(|row| row.key == key)))
            .or_else(|| {
                self.rows.iter().position(|row| {
                    row.detail.is_none()
                        && target_is_session(&row.session.target, &self.current_session)
                })
            })
            .unwrap_or(0)
            .min(self.rows.len().saturating_sub(1));
    }

    fn append_children(
        &self,
        parent: Option<String>,
        depth: usize,
        context: &TreeBuildContext<'_>,
        rows: &mut Vec<TreeRow>,
    ) {
        let visible = context
            .by_parent
            .get(&parent)
            .into_iter()
            .flatten()
            .filter(|index| {
                context
                    .included
                    .contains(&target_key(&self.sessions[**index].target))
            })
            .copied()
            .collect::<Vec<_>>();
        let folded = visible.iter().copied().filter(|index| context.foldable[*index]).collect::<Vec<_>>();
        let group = (!folded.is_empty()).then(|| DoneGroup {
            parent: parent.clone(),
            count: folded
                .iter()
                .map(|index| subtree_size(*index, &self.sessions, context.by_parent, &mut HashSet::new()))
                .sum(),
            expanded: self.expanded_done_groups.contains(&parent),
        });
        let visible = match &group {
            Some(group) if !group.expanded => visible.into_iter().filter(|index| !context.foldable[*index]).collect(),
            _ => visible,
        };
        // A summary sits where the oldest sibling would: first beneath a parent, last among roots.
        let roots = parent.is_none();
        if let Some(group) = group.clone().filter(|_| !roots) {
            rows.push(done_group_row(group, depth, visible.is_empty()));
        }
        for (position, index) in visible.iter().enumerate() {
            let session = self.sessions[*index].clone();
            let id = session.workshop_id.clone();
            let children = id
                .as_ref()
                .and_then(|id| context.by_parent.get(&Some(id.clone())))
                .map_or(0, Vec::len);
            let is_last = position + 1 == visible.len() && !(roots && group.is_some());
            rows.push(TreeRow {
                key: target_key(&session.target),
                depth,
                state: context.states[*index],
                contains_clanker: context.has_clankers[*index],
                session: session.clone(),
                detail: None,
                has_children: children > 0,
                is_last,
                done_group: None,
            });
            if self.expanded_details.contains(&session.name) || !context.query.is_empty() {
                for detail in session.details.iter().filter(|detail| {
                    !matches!(detail.kind.as_str(), "directory" | "repository" | "session")
                }) {
                    if context.query.is_empty()
                        || [
                            detail.title.as_str(),
                            detail.kind.as_str(),
                            detail.harness.as_str(),
                            detail.status.as_str(),
                        ]
                        .iter()
                        .any(|field| {
                            context
                                .query
                                .split_whitespace()
                                .all(|term| fuzzy_score(field, term).is_some())
                        })
                    {
                        rows.push(TreeRow {
                            key: detail_key(detail),
                            depth: depth + 1,
                            state: detail.state,
                            contains_clanker: detail.kind == "clanker",
                            session: session.clone(),
                            detail: Some(detail.clone()),
                            has_children: false,
                            is_last: true,
                            done_group: None,
                        });
                    }
                }
            }
            if (!context.query.is_empty() || self.expanded_lineage.contains(&session.name))
                && let Some(id) = id
            {
                self.append_children(Some(id), depth + 1, context, rows);
            }
        }
        if let Some(group) = group.filter(|_| roots) {
            rows.push(done_group_row(group, depth, true));
        }
    }

    fn move_selection(&mut self, delta: isize) {
        self.selected = self
            .selected
            .saturating_add_signed(delta)
            .min(self.active_len().saturating_sub(1));
    }

    fn update_query(&mut self, query: String) {
        if self.mode != Mode::Jump {
            self.query = query;
            self.selected = 0;
            return;
        }
        let mut key = self.rows.get(self.selected).map(|row| row.key.clone());
        if self.query.is_empty() && !query.is_empty() {
            // Searching temporarily changes selection (and its derived viewport).
            // Keep a stable anchor, not old rows: snapshots may change while filtering.
            self.unfiltered_selection = key.clone();
        } else if !self.query.is_empty() && query.is_empty() {
            key = self.unfiltered_selection.take();
        }
        let broadening = query.chars().count() < self.query.chars().count();
        self.query = query;
        self.rebuild(key.as_deref());
        if !broadening
            && !self.query.is_empty()
            && let Some((index, _)) = self
                .rows
                .iter()
                .enumerate()
                .filter_map(|(index, row)| {
                    let direct_score = if let Some(detail) = row.detail.as_ref() {
                        detail_search_score(detail, &self.query).map(|score| score + 1)
                    } else {
                        session_direct_search_score(&row.session, &self.query)
                    };
                    let score = direct_score
                        .or_else(|| search_score(&row.session, &self.query).map(|score| score - 10_000))?;
                    Some((index, score))
                })
                .max_by_key(|(_, score)| *score)
        {
            self.selected = index;
        }
    }

    fn selected(&self) -> Option<&TreeRow> {
        self.rows.get(self.selected)
    }

    fn filtered_repositories(&self) -> Vec<&RepositoryRow> {
        let query = self.query.trim().to_lowercase();
        let mut rows = self
            .repositories
            .iter()
            .filter_map(|repository| {
                let score = if query.is_empty() {
                    0
                } else {
                    [repository.name.as_str(), repository.path.as_str()]
                        .iter()
                        .filter_map(|field| fuzzy_score(field, &query))
                        .max()?
                };
                Some((repository, score))
            })
            .collect::<Vec<_>>();
        // Match quality decides under a query, so Enter takes the best match;
        // recency breaks ties (and is the whole order with no query).
        rows.sort_by(|(left, left_score), (right, right_score)| {
            right_score
                .cmp(left_score)
                .then_with(|| right.last_used.cmp(&left.last_used))
                .then_with(|| left.name.cmp(&right.name))
        });
        rows.into_iter().map(|(repository, _)| repository).collect()
    }

    fn filtered_attach_candidates(&self) -> Vec<&SessionRow> {
        let query = self.query.trim().to_lowercase();
        let mut rows = self
            .attach_candidates
            .iter()
            .filter_map(|candidate| {
                let score = if query.is_empty() {
                    0
                } else {
                    search_score(candidate, &query)?
                };
                Some((candidate, score))
            })
            .collect::<Vec<_>>();
        rows.sort_by(|(left, left_score), (right, right_score)| {
            right_score
                .cmp(left_score)
                .then_with(|| left.name.cmp(&right.name))
        });
        rows.into_iter().map(|(candidate, _)| candidate).collect()
    }

    fn filtered_branches(&self) -> Vec<BranchRow> {
        let query = self.query.trim().to_lowercase();
        let mut rows = self
            .branches
            .iter()
            .filter_map(|branch| {
                let score = if query.is_empty() {
                    0
                } else {
                    fuzzy_score(&branch.name, &query)?
                };
                Some((branch.clone(), score))
            })
            .collect::<Vec<_>>();
        rows.sort_by(|(left, left_score), (right, right_score)| {
            right_score
                .cmp(left_score)
                .then_with(|| branch_rank(left.kind).cmp(&branch_rank(right.kind)))
                .then_with(|| right.recency.cmp(&left.recency))
                .then_with(|| left.name.cmp(&right.name))
        });
        let exact = self.branches.iter().any(|branch| {
            branch.value.to_lowercase() == query || branch.name.to_lowercase() == query
        });
        let mut result = rows
            .into_iter()
            .map(|(branch, _)| branch)
            .collect::<Vec<_>>();
        if !query.is_empty() && !exact {
            result.insert(
                0,
                BranchRow {
                    name: self.query.trim().into(),
                    value: self.query.trim().into(),
                    kind: BranchKind::Create,
                    path: String::new(),
                    recency: 0,
                },
            );
        }
        result
    }

    fn active_len(&self) -> usize {
        match self.mode {
            Mode::Jump => self.rows.len(),
            Mode::Repository => self.filtered_repositories().len(),
            Mode::Branch => self.filtered_branches().len(),
            Mode::Attach => self.filtered_attach_candidates().len(),
            Mode::NewBase | Mode::Rename | Mode::DeleteConfirm => 0,
        }
    }

    /// Alt-I, Alt-E, Alt-F: the Workshop list in that view. Between views of the list the query is kept; a sorted
    /// view starts at its first row, and the flat one stays on the Workshop that was selected.
    fn set_view(&mut self, view: View) {
        let within = self.mode == Mode::Jump;
        let selected = self.selected().filter(|_| within && !view.waiting()).map(|row| target_key(&row.session.target));
        self.mode = Mode::Jump;
        self.view = view;
        self.scratch = false;
        if !within {
            self.query.clear();
        }
        self.unfiltered_selection = None;
        self.error.clear();
        self.clear_action_mode();
        self.rebuild(selected.as_deref());
        if view.waiting() {
            self.selected = 0;
        }
    }

    fn enter_repository_mode(&mut self) {
        self.scratch = false;
        if self.view.waiting() {
            // Esc from the repository step lands on the full map, not a needs-me list.
            self.view = View::Flat;
            self.rebuild(None);
        }
        if let Ok(activity_dir) = activity_dir() {
            let last_used = repository_last_used(&activity_dir, &self.repository_identities);
            order_repositories(&mut self.repositories, &last_used);
        }
        self.mode = Mode::Repository;
        self.query.clear();
        self.unfiltered_selection = None;
        self.selected = 0;
        self.error.clear();
        self.clear_action_mode();
    }

    fn enter_scratch_mode(&mut self) {
        self.enter_repository_mode();
        self.scratch = true;
    }

    fn clear_action_mode(&mut self) {
        self.action_session = None;
        self.rename_name.clear();
        self.attach_candidates.clear();
        self.delete_intent = None;
        self.delete_label.clear();
        self.done_pending = false;
        self.reopen_path = None;
        self.worktree_delete = None;
        self.rename_title_path = None;
    }

    fn enter_attach_mode(&mut self, source: SessionRow) {
        let Some(source_id) = source.workshop_id.as_ref() else {
            return;
        };
        let mut descendants = HashSet::from([source_id.clone()]);
        loop {
            let previous_len = descendants.len();
            for candidate in &self.sessions {
                if candidate
                    .parent_workshop_id
                    .as_ref()
                    .is_some_and(|parent| descendants.contains(parent))
                    && let Some(id) = candidate.workshop_id.as_ref()
                {
                    descendants.insert(id.clone());
                }
            }
            if descendants.len() == previous_len {
                break;
            }
        }
        let projected_candidates = source
            .attachment_candidate_workshop_ids
            .as_ref()
            .map(|ids| ids.iter().cloned().collect::<HashSet<_>>());
        let source_repository = self.repository_identities.get(&source.path);
        self.attach_candidates = self
            .sessions
            .iter()
            .filter(|candidate| {
                let allowed_by_projection = candidate.workshop_id.as_ref().is_some_and(|id| {
                    projected_candidates.as_ref().is_some_and(|ids| ids.contains(id))
                });
                let legacy_same_repository = projected_candidates.is_none()
                    && source_repository.is_some_and(|common_dir| {
                        self.repository_identities.get(&candidate.path) == Some(common_dir)
                    });
                (allowed_by_projection || legacy_same_repository)
                    && candidate.workshop_id.as_ref().is_some_and(|id| {
                        !descendants.contains(id) && source.parent_workshop_id.as_ref() != Some(id)
                    })
            })
            .cloned()
            .collect();
        self.action_session = Some(source);
        self.mode = Mode::Attach;
        self.query.clear();
        self.unfiltered_selection = None;
        self.selected = 0;
    }
}

impl TreeRow {
    fn target(&self) -> Target {
        self.detail
            .as_ref()
            .map(|detail| detail.target.clone())
            .unwrap_or_else(|| self.session.target.clone())
    }

    fn allows(&self, action: AvailableAction) -> bool {
        self.session.available_actions.contains(&action)
    }
}

/// Enter on a needs-me row (Alt-I, Alt-E) lands on the clanker that needs attention, when it is still on screen.
fn needs_me_target(session: &SessionRow) -> Target {
    session
        .needs_me
        .as_ref()
        .and_then(|reason| reason.clanker_id.as_ref())
        .and_then(|id| session.details.iter().find(|detail| detail.clanker_id.as_ref() == Some(id)))
        .map(|detail| detail.target.clone())
        .filter(|target| matches!(target, Target::Window { .. } | Target::Opencode { .. }))
        .unwrap_or_else(|| session.target.clone())
}

fn detail_key(detail: &DetailRow) -> String {
    let evidence = detail
        .observation
        .as_ref()
        .filter(|_| detail.kind == "observation")
        .map(|observation| format!(":{}:{}", observation.source, observation.confidence))
        .unwrap_or_default();
    format!("{}:{}{}", target_key(&detail.target), detail.kind, evidence)
}

fn session_name(target: &Target) -> Option<&str> {
    match target {
        Target::Session { session, .. }
        | Target::Window { session, .. }
        | Target::Opencode { session, .. } => Some(session),
        Target::Directory { .. } => None,
    }
}

fn rename_intent(session_row: &SessionRow, display_name: &str) -> Option<MutationIntent> {
    let display_name = display_name.trim();
    if !session_row
        .available_actions
        .contains(&AvailableAction::Rename)
        || display_name.is_empty()
        || display_name.chars().count() > 256
    {
        return None;
    }
    let Target::Session {
        session,
        resource_id,
        ..
    } = &session_row.target
    else {
        return None;
    };
    Some(MutationIntent::Rename {
        session: session.clone(),
        resource_id: resource_id.clone(),
        display_name: display_name.into(),
    })
}

fn detach_intent(row: &TreeRow) -> Option<MutationIntent> {
    if row.detail.is_some() || !row.allows(AvailableAction::Detach) {
        return None;
    }
    Some(MutationIntent::Detach {
        workshop_id: row.session.workshop_id.clone()?,
        session: session_name(&row.session.target).map(str::to_string),
    })
}

fn delete_intent(row: &TreeRow) -> Option<MutationIntent> {
    if row.detail.is_none() && row.session.directory_source == "worktree" {
        let session = match &row.session.target {
            Target::Directory { .. } => row.session.name.clone(),
            Target::Session { session, .. } => session.clone(),
            _ => return None,
        };
        return Some(MutationIntent::Delete {
            kind: DeleteKind::Worktree,
            session,
            confirmed: true,
            pane: None,
            path: Some(row.session.path.clone()),
        });
    }
    if !row.allows(AvailableAction::Delete) {
        return None;
    }
    match row.detail.as_ref().map(|detail| &detail.target) {
        Some(Target::Window { session, pane, .. })
        | Some(Target::Opencode { session, pane, .. }) => Some(MutationIntent::Delete {
            kind: DeleteKind::Pane,
            session: session.clone(),
            confirmed: true,
            pane: Some(pane.clone()),
            path: None,
        }),
        Some(_) => None,
        None => {
            let Target::Session { session, .. } = &row.session.target else {
                return None;
            };
            Some(MutationIntent::Delete {
                kind: DeleteKind::Session,
                session: session.clone(),
                confirmed: true,
                pane: None,
                path: None,
            })
        }
    }
}

fn delete_label(row: &TreeRow, intent: &MutationIntent) -> String {
    match intent {
        MutationIntent::Delete {
            kind: DeleteKind::Worktree,
            ..
        } => format!(
            "Destroy worktree '{}'?",
            if row.session.branch.is_empty() {
                row.session.path.as_str()
            } else {
                row.session.branch.as_str()
            }
        ),
        MutationIntent::Delete {
            kind: DeleteKind::Pane,
            pane,
            ..
        } => format!(
            "Destroy exact pane '{}'?",
            row.detail
                .as_ref()
                .map(|detail| detail.title.as_str())
                .filter(|title| !title.is_empty())
                .or_else(|| pane.as_deref())
                .unwrap_or("unknown")
        ),
        MutationIntent::Delete {
            kind: DeleteKind::Session,
            session,
            ..
        } => format!("Destroy exact session '{session}'?"),
        _ => String::new(),
    }
}

/// Mirrors `branchFromTitle` in src/labels.ts: branch-shaped input is kept verbatim, free text
/// becomes a lowercase dash-separated slug cut at a word boundary.
fn branch_from_title(title: &str) -> Option<String> {
    let trimmed = title.trim();
    let mut characters = trimmed.chars();
    if characters.next().is_some_and(|first| first.is_ascii_alphanumeric())
        && characters.all(|character| character.is_ascii_alphanumeric() || "._/-".contains(character))
    {
        return Some(trimmed.to_string());
    }
    let mut slug = String::new();
    for character in trimmed.to_lowercase().chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character);
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_end_matches('-').to_string();
    if slug.is_empty() {
        return None;
    }
    if slug.len() <= 50 {
        return Some(slug);
    }
    let cut = &slug[..50];
    let cut = match cut.rfind('-') {
        Some(boundary) if boundary >= 20 => &cut[..boundary],
        _ => cut,
    };
    Some(cut.trim_end_matches('-').to_string())
}

const DONE_GRAY: Color = Color::Rgb(108, 114, 128);

/// Muted hues kept apart from the state glyph colours, so a tag never reads as a state.
const PROJECT_COLORS: [Color; 8] = [
    Color::Rgb(94, 180, 170),
    Color::Rgb(167, 139, 250),
    Color::Rgb(232, 130, 180),
    Color::Rgb(214, 188, 104),
    Color::Rgb(103, 200, 230),
    Color::Rgb(160, 190, 110),
    Color::Rgb(190, 150, 200),
    Color::Rgb(200, 160, 130),
];

/// Deeper than the project hues, so a label never reads as part of the name beside it.
const LABEL_COLORS: [Color; 6] = [
    Color::Rgb(56, 148, 160),
    Color::Rgb(128, 108, 200),
    Color::Rgb(186, 96, 140),
    Color::Rgb(170, 140, 60),
    Color::Rgb(110, 150, 70),
    Color::Rgb(168, 112, 78),
];

fn name_hash(name: &str) -> usize {
    name.bytes().fold(0x811c9dc5u32, |hash, byte| (hash ^ u32::from(byte)).wrapping_mul(0x01000193)) as usize
}

/// A project keeps one colour everywhere: it is derived from the name alone.
fn project_color(project: &str) -> Color {
    PROJECT_COLORS[name_hash(project) % PROJECT_COLORS.len()]
}

/// A label keeps one colour everywhere too; "done" is gray like the row it grays out.
fn label_color(label: &str) -> Color {
    if label == "done" { DONE_GRAY } else { LABEL_COLORS[name_hash(label) % LABEL_COLORS.len()] }
}

/// The root of a lineage names its project as a tag; the rows beneath it only carry the colour.
fn root_project(row: &TreeRow) -> Option<&str> {
    // A row already named after its project, such as the main checkout, needs no tag.
    let shown = row.session.title.as_deref().unwrap_or(&row.session.name);
    row.session.project.as_deref().filter(|project| row.detail.is_none() && row.depth == 0 && *project != shown)
}

/// The project tag already names the project, so an untitled root drops the "project@" prefix.
fn name_without_project(session: &SessionRow) -> &str {
    session
        .project
        .as_deref()
        .and_then(|project| session.name.strip_prefix(project))
        .and_then(|rest| rest.strip_prefix('@'))
        .filter(|rest| !rest.is_empty())
        .unwrap_or(&session.name)
}

/// A faded row keeps its project's hue: the colour is darkened, not replaced.
fn dimmed(color: Color, percent: u16) -> Color {
    match color {
        Color::Rgb(red, green, blue) => {
            let scale = |value: u8| (u16::from(value) * percent / 100) as u8;
            Color::Rgb(scale(red), scale(green), scale(blue))
        }
        other => other,
    }
}

fn is_done(session: &SessionRow) -> bool {
    session.labels.iter().any(|label| label == "done")
}

/// A Workshop's name carries its project's colour. A done Workshop is grayed out whatever its
/// age; otherwise a row fades as it goes unvisited.
/// Detail rows and the state glyph keep their own colours, so a live clanker still stands out.
fn row_name_style(row: &TreeRow, current: bool, now: u64) -> Style {
    if row.detail.is_some() {
        return Style::default();
    }
    if is_done(&row.session) {
        return Style::default().fg(DONE_GRAY);
    }
    let project = row.session.project.as_deref().map(project_color);
    let fade = if current { None } else { fade_color(row.session.recency, now) };
    match (project, fade) {
        (Some(color), None) => Style::default().fg(color),
        (Some(color), Some(fade)) => Style::default().fg(dimmed(color, if fade == DONE_GRAY { 55 } else { 75 })),
        (None, Some(fade)) => Style::default().fg(fade),
        (None, None) => Style::default(),
    }
}

/// Rows left alone for days recede without moving: under a day is normal, then two steps of dimming.
fn fade_color(last_seen: u64, now: u64) -> Option<Color> {
    if last_seen == 0 {
        return None;
    }
    match now.saturating_sub(last_seen) / 86_400 {
        0 => None,
        1..=2 => Some(Color::Rgb(160, 166, 178)),
        _ => Some(DONE_GRAY),
    }
}

fn state_glyph(state: ClankerState, frame: usize) -> (&'static str, Color) {
    match state {
        ClankerState::Failed => ("×", Color::Rgb(248, 113, 113)),
        ClankerState::Blocked => ("▲", Color::Rgb(248, 113, 113)),
        // The only glyph that moves: motion means something is running.
        ClankerState::Working => (["◐", "◓", "◑", "◒"][(frame / 2) % 4], Color::Rgb(251, 146, 60)),
        ClankerState::Done => ("✓", Color::Rgb(74, 222, 128)),
        ClankerState::Idle => ("✓", Color::Rgb(96, 165, 250)),
        ClankerState::Unknown => ("·", Color::LightMagenta),
    }
}

fn mutation_progress_label(intent: &MutationIntent) -> &'static str {
    match intent {
        MutationIntent::Rename { .. } => "Renaming session…",
        MutationIntent::Attach { .. } => "Attaching Workshop…",
        MutationIntent::Detach { .. } => "Detaching Workshop…",
        MutationIntent::Delete { .. } => "Deleting target…",
        MutationIntent::Done { .. } => "Marking Workshop done…",
        MutationIntent::Label { .. } => "Updating Workshop label…",
        MutationIntent::Create { .. } => "Creating Workshop…",
        MutationIntent::Open { .. } => "Opening target…",
        MutationIntent::RepositoryRefresh => "Refreshing repositories…",
    }
}

fn uses_neutral_glyph(row: &TreeRow) -> bool {
    if let Some(detail) = &row.detail {
        return row.state == ClankerState::Unknown && neutral_detail(detail);
    }
    row.state == ClankerState::Unknown
        && !row.contains_clanker
        && neutral_session(&row.session)
}

fn neutral_detail(detail: &DetailRow) -> bool {
    matches!(detail.kind.as_str(), "directory" | "repository" | "session" | "window")
        || (detail.kind == "observation"
            && detail.observation.as_ref().is_some_and(|observation| {
                observation.source == "process"
                    && observation.confidence == "observed"
                    && observation.state == "present"
            }))
}

fn row_glyph(row: &TreeRow, _current_session: &str, frame: usize) -> (&'static str, Color) {
    if uses_neutral_glyph(row) {
        ("○", Color::Rgb(148, 163, 184))
    } else {
        state_glyph(row.state, frame)
    }
}

fn ellipsize(value: &str, width: usize) -> String {
    if UnicodeWidthStr::width(value) <= width {
        return value.to_string();
    }
    if width == 0 {
        return String::new();
    }
    let mut result = String::new();
    let mut used = 0;
    for character in value.chars() {
        let character_width = character.width().unwrap_or(0);
        if used + character_width + 1 > width {
            break;
        }
        result.push(character);
        used += character_width;
    }
    result.push('…');
    result
}

fn inline_summary(session: &SessionRow, max_width: usize) -> String {
    let details = session
        .details
        .iter()
        .filter(|detail| !matches!(detail.kind.as_str(), "directory" | "repository" | "session"))
        .collect::<Vec<_>>();
    let mut labels = Vec::new();
    let mut used = 0;
    for detail in &details {
        if labels.len() >= 3 {
            break;
        }
        let raw = if detail.kind == "window" {
            if detail.title.is_empty() {
                "window"
            } else {
                &detail.title
            }
        } else if !detail.harness.is_empty() {
            &detail.harness
        } else {
            &detail.kind
        };
        let separator = usize::from(!labels.is_empty()) * 2;
        let remaining = max_width.saturating_sub(used + separator);
        if remaining == 0 {
            break;
        }
        let label = ellipsize(raw, remaining.min(18));
        used += separator + label.width();
        labels.push(label);
    }
    while labels.len() < details.len() {
        let hidden = details.len() - labels.len();
        let tail_width = 2 + format!("+{hidden}").width();
        if used + tail_width <= max_width {
            break;
        }
        let Some(removed) = labels.pop() else { break };
        used = used.saturating_sub(removed.width() + usize::from(!labels.is_empty()) * 2);
    }
    let hidden = details.len() - labels.len();
    let mut summary = labels.join("  ");
    if hidden > 0 {
        if !summary.is_empty() {
            summary.push_str("  ");
        }
        summary.push_str(&format!("+{hidden}"));
    }
    summary
}

fn session_meta(session: &SessionRow, current: bool) -> String {
    let meta = if matches!(session.target, Target::Directory { .. }) {
        [session.activity_source.as_str(), session.age.as_str()]
            .into_iter()
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    } else {
        [
            (session.management == "unmanaged").then_some("unmanaged"),
            (session.flags == "dirty").then_some("dirty"),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" ")
    };
    [current.then_some("current"), (!meta.is_empty()).then_some(meta.as_str())]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" · ")
}

fn draw_flat_picker(frame: &mut Frame, app: &App, areas: &[ratatui::layout::Rect]) {
    let (title, help, rows, footer): (&str, &str, Vec<(String, String)>, String) = match app.mode {
        Mode::Repository => {
            let rows = app
                .filtered_repositories()
                .into_iter()
                .map(|repository| (repository.name.clone(), repository.path.clone()))
                .collect();
            (
                if app.scratch { "Clankerhouse · Scratch workshop" } else { "Clankerhouse · Open or create branch" },
                if app.scratch { "Alt-K jump · Enter create off the fresh default branch · Esc back" } else { "Alt-K jump · Enter choose · Esc back" },
                rows,
                app.filtered_repositories()
                    .get(app.selected)
                    .map(|repository| repository.path.clone())
                    .unwrap_or_else(|| "Select a repository".into()),
            )
        }
        Mode::Branch => {
            let rows = app
                .filtered_branches()
                .into_iter()
                .map(|branch| {
                    let meta = match branch.kind {
                        BranchKind::Worktree => format!("worktree · {}", branch.path),
                        BranchKind::Local => "local".into(),
                        BranchKind::Remote => "remote".into(),
                        BranchKind::Create => "create new workshop with this title".into(),
                    };
                    (branch.name, meta)
                })
                .collect();
            (
                "Clankerhouse · Branch",
                "Alt-K repositories · Enter open · Esc back",
                rows,
                app.repository
                    .as_ref()
                    .map(|repository| repository.path.clone())
                    .unwrap_or_default(),
            )
        }
        Mode::Attach => {
            let rows = app
                .filtered_attach_candidates()
                .into_iter()
                .map(|candidate| {
                    (
                        candidate.name.clone(),
                        [candidate.branch.as_str(), candidate.path.as_str()]
                            .into_iter()
                            .filter(|value| !value.is_empty())
                            .collect::<Vec<_>>()
                            .join(" · "),
                    )
                })
                .collect();
            (
                "Clankerhouse · Choose parent Workshop",
                "Enter attach · Esc cancel",
                rows,
                app.filtered_attach_candidates()
                    .get(app.selected)
                    .map(|candidate| candidate.path.clone())
                    .unwrap_or_else(|| "No valid parent Workshops match".into()),
            )
        }
        Mode::Rename => {
            frame.render_widget(
                Line::from(vec![
                    Span::styled(
                        "Clankerhouse · Rename session",
                        Style::default()
                            .fg(Color::LightCyan)
                            .add_modifier(Modifier::BOLD),
                    ),
                    Span::styled(
                        "  Enter rename · Esc cancel",
                        Style::default().fg(Color::DarkGray),
                    ),
                ]),
                areas[0],
            );
            frame.render_widget(
                Paragraph::new(vec![
                    Line::from(""),
                    Line::from(vec![
                        Span::styled(
                            if app.rename_title_path.is_some() { "  Title: " } else { "  Session: " },
                            Style::default().fg(Color::LightCyan),
                        ),
                        Span::raw(format!("{}_", app.rename_name)),
                    ]),
                    Line::from(""),
                    Line::from(Span::styled(
                        if app.rename_title_path.is_some() {
                            "  Shown here and as the workspace name; the branch is unchanged. Empty clears it"
                        } else {
                            "  Canonical Workshop and Clanker identities are unchanged"
                        },
                        Style::default().fg(Color::DarkGray),
                    )),
                ])
                .block(Block::default().borders(Borders::ALL)),
                areas[1],
            );
            frame.render_widget(
                Paragraph::new(app.error.as_str()).style(Style::default().fg(Color::LightYellow)),
                areas[2],
            );
            return;
        }
        Mode::DeleteConfirm => {
            frame.render_widget(
                Line::from(Span::styled(
                    "Clankerhouse · Confirm deletion",
                    Style::default()
                        .fg(Color::LightRed)
                        .add_modifier(Modifier::BOLD),
                )),
                areas[0],
            );
            frame.render_widget(
                Paragraph::new(vec![
                    Line::from(""),
                    Line::from(Span::styled(
                        format!("  {}", app.delete_label),
                        Style::default().fg(Color::LightRed),
                    )),
                    Line::from(""),
                    Line::from(if app.reopen_path.is_some() {
                        "  Press y to confirm, u to reopen (clear done), or n/Esc to cancel."
                    } else {
                        "  Press y to confirm or n/Esc to cancel."
                    }),
                ])
                .block(Block::default().borders(Borders::ALL)),
                areas[1],
            );
            frame.render_widget(
                Paragraph::new(app.error.as_str()).style(Style::default().fg(Color::LightYellow)),
                areas[2],
            );
            return;
        }
        Mode::NewBase => {
            frame.render_widget(
                Line::from(vec![
                    Span::styled(
                        "Clankerhouse · New branch",
                        Style::default()
                            .fg(Color::LightCyan)
                            .add_modifier(Modifier::BOLD),
                    ),
                    Span::styled(
                        "  Enter create · Esc branches",
                        Style::default().fg(Color::DarkGray),
                    ),
                ]),
                areas[0],
            );
            frame.render_widget(
                Paragraph::new(vec![
                    Line::from(""),
                    Line::from(vec![
                        Span::styled("  Title:  ", Style::default().fg(Color::DarkGray)),
                        Span::raw(app.workshop_title.as_deref().unwrap_or("(same as branch)")),
                    ]),
                    Line::from(vec![
                        Span::styled("  Branch: ", Style::default().fg(Color::DarkGray)),
                        Span::raw(&app.branch_name),
                    ]),
                    Line::from(vec![
                        Span::styled("  Base:   ", Style::default().fg(Color::LightCyan)),
                        Span::raw(format!("{}_", app.base)),
                    ]),
                    Line::from(""),
                    Line::from(Span::styled(
                        "  Worktrunk will create the branch, worktree, and setup hooks",
                        Style::default().fg(Color::DarkGray),
                    )),
                ])
                .block(Block::default().borders(Borders::ALL)),
                areas[1],
            );
            frame.render_widget(
                Paragraph::new(app.error.as_str()).style(Style::default().fg(Color::LightYellow)),
                areas[2],
            );
            return;
        }
        Mode::Jump => return,
    };
    frame.render_widget(
        Line::from(vec![
            Span::styled(
                title,
                Style::default()
                    .fg(Color::LightCyan)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(format!("  {help}"), Style::default().fg(Color::DarkGray)),
        ]),
        areas[0],
    );
    let height = usize::from(areas[1].height.saturating_sub(2));
    let start = app
        .selected
        .saturating_sub(height / 2)
        .min(rows.len().saturating_sub(height));
    let end = (start + height).min(rows.len());
    let items = rows[start..end]
        .iter()
        .rev()
        .map(|(name, meta)| {
            let available = areas[1].width.saturating_sub(meta.width() as u16 + 7) as usize;
            ListItem::new(Line::from(vec![
                Span::raw("  "),
                Span::raw(ellipsize(name, available)),
                Span::raw("  "),
                Span::styled(meta, Style::default().fg(Color::DarkGray)),
            ]))
        })
        .collect::<Vec<_>>();
    let mut state = ListState::default().with_selected(Some(end.saturating_sub(app.selected + 1)));
    frame.render_stateful_widget(
        List::new(items)
            .block(Block::default().borders(Borders::ALL))
            .highlight_style(Style::default().bg(Color::Rgb(30, 58, 95)).fg(Color::White))
            .highlight_symbol("›"),
        areas[1],
        &mut state,
    );
    frame.render_widget(
        Paragraph::new(if app.error.is_empty() {
            footer.as_str()
        } else {
            app.error.as_str()
        })
        .style(Style::default().fg(if app.error.is_empty() {
            Color::DarkGray
        } else {
            Color::LightYellow
        })),
        areas[2],
    );
    frame.render_widget(
        Line::from(vec![
            Span::styled("> ", Style::default().fg(Color::LightCyan)),
            Span::raw(&app.query),
            Span::raw("_"),
            Span::raw(format!("  {} targets", rows.len())),
        ]),
        areas[3],
    );
}

fn draw(frame: &mut Frame, app: &mut App) {
    let areas = Layout::vertical([
        Constraint::Length(1),
        Constraint::Min(1),
        Constraint::Length(1),
        Constraint::Length(1),
    ])
    .split(frame.area());
    if app.mode != Mode::Jump {
        draw_flat_picker(frame, app, &areas);
        return;
    }
    if app.view.waiting() {
        draw_needs_me(frame, app, &areas);
        return;
    }
    frame.render_widget(
        Line::from(vec![
            Span::styled(
                "Clankerhouse · Flat",
                Style::default()
                    .fg(Color::LightCyan)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                "  Alt-I needs me · Alt-E eldest · Alt-K branches · Alt-R/A/L/D/S actions · ←/→ expand · Alt-. done · Enter open · Esc close",
                Style::default().fg(Color::DarkGray),
            ),
        ]),
        areas[0],
    );
    let list_area = areas[1];
    let height = list_area.height.saturating_sub(2) as usize;
    let start = app
        .selected
        .saturating_sub(height / 2)
        .min(app.rows.len().saturating_sub(height));
    let end = (start + height).min(app.rows.len());
    let now = std::time::UNIX_EPOCH.elapsed().map_or(0, |elapsed| elapsed.as_secs());
    let items = app.rows[start..end]
        .iter()
        .rev()
        .map(|row| {
            let (glyph, color) = row_glyph(row, &app.current_session, app.animation_frame);
            let branch = if row.depth == 0 {
                ""
            } else if row.is_last {
                "└─"
            } else {
                "├─"
            };
            if let Some(group) = &row.done_group {
                let prefix = format!("{}{}{} ", "  ".repeat(row.depth), branch, if group.expanded { "▾" } else { "▸" });
                let status = Span::styled(" ✓ ", Style::default().fg(DONE_GRAY));
                let lineage = Span::styled(prefix, Style::default().fg(Color::DarkGray));
                let mut spans = if row.depth == 0 { vec![status, lineage] } else { vec![lineage, status] };
                spans.push(Span::styled(
                    row.session.name.clone(),
                    Style::default().fg(DONE_GRAY).add_modifier(Modifier::ITALIC),
                ));
                return ListItem::new(Line::from(spans));
            }
            let expand = if row.detail.is_some() {
                "·"
            } else if row.has_children {
                if app.expanded_lineage.contains(&row.session.name) {
                    "▾"
                } else {
                    "▸"
                }
            } else if app.expanded_details.contains(&row.session.name) {
                "▾"
            } else {
                " "
            };
            let name = row
                .detail
                .as_ref()
                .map(|detail| {
                    if detail.kind == "window" {
                        detail.title.as_str()
                    } else if !detail.harness.is_empty() {
                        detail.harness.as_str()
                    } else {
                        detail.kind.as_str()
                    }
                })
                .unwrap_or_else(|| {
                    row.session.title.as_deref().unwrap_or_else(|| if root_project(row).is_some() { name_without_project(&row.session) } else { &row.session.name })
                });
            let detail_meta = row
                .detail
                .as_ref()
                .map(|detail| {
                    if !detail.status.is_empty() {
                        detail.status.clone()
                    } else {
                        format!("{:?}", detail.state).to_lowercase()
                    }
                })
                .unwrap_or_default();
            let prefix = format!("{}{}{} ", "  ".repeat(row.depth), branch, expand);
            let current = row.detail.is_none()
                && target_is_session(&row.session.target, &app.current_session);
            let meta = row
                .detail
                .as_ref()
                .map_or_else(|| session_meta(&row.session, current), |_| detail_meta);
            let summary = if row.detail.is_none() && app.query.is_empty() {
                inline_summary(&row.session, 24)
            } else {
                String::new()
            };
            let titled_branch = if row.detail.is_none() && row.session.title.is_some() {
                row.session.branch.as_str()
            } else {
                ""
            };
            // Snoozed, or waiting on another Workshop: said here too, where Alt-S works as in the needs-me views.
            let deferred = row.session.needs_me.as_ref().filter(|_| row.detail.is_none()).map(deferred_status).unwrap_or_default();
            let right = [summary.as_str(), deferred.as_str(), titled_branch, meta.as_str()]
                .into_iter()
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
                .join("  ");
            let done = is_done(&row.session);
            let mut tag_spans = Vec::new();
            if let Some(project) = root_project(row) {
                tag_spans.push(Span::styled(format!(" {project}"), Style::default().fg(if done { DONE_GRAY } else { project_color(project) })));
            }
            if row.detail.is_none() {
                tag_spans.extend(row.session.labels.iter().map(|label| {
                    let color = label_color(label);
                    Span::styled(format!(" {label}"), Style::default().fg(if done { dimmed(color, 70) } else { color }))
                }));
            }
            let tags_width = tag_spans.iter().map(Span::width).sum::<usize>();
            let content_width = list_area.width.saturating_sub(5) as usize;
            let fixed_width = 3
                + prefix.width()
                + tags_width
                + if right.is_empty() {
                    0
                } else {
                    right.width() + 2
                };
            let rendered_name = ellipsize(name, content_width.saturating_sub(fixed_width).max(4));
            let occupied =
                3 + prefix.width() + rendered_name.width() + tags_width + right.width();
            let spacing = if right.is_empty() {
                0
            } else {
                content_width.saturating_sub(occupied).max(2)
            };
            let status = Span::styled(format!(" {glyph} "), Style::default().fg(color));
            let lineage = Span::styled(prefix, Style::default().fg(Color::DarkGray));
            let mut spans = if row.depth == 0 {
                vec![status, lineage]
            } else {
                vec![lineage, status]
            };
            let name_style = row_name_style(row, current, now);
            spans.push(Span::styled(rendered_name, name_style));
            spans.extend(tag_spans);
            spans.extend([
                Span::raw(" ".repeat(spacing)),
                Span::styled(right, Style::default().fg(Color::DarkGray)),
            ]);
            ListItem::new(Line::from(spans))
        })
        .collect::<Vec<_>>();
    let mut state = ListState::default().with_selected(Some(end.saturating_sub(app.selected + 1)));
    frame.render_stateful_widget(
        List::new(items)
            .block(Block::default().borders(Borders::ALL))
            .highlight_style(Style::default().bg(Color::Rgb(30, 58, 95)).fg(Color::White))
            .highlight_symbol("›"),
        list_area,
        &mut state,
    );
    let (footer, footer_color) = if !app.error.is_empty() {
        (app.error.clone(), Color::LightYellow)
    } else if let Some(pending) = &app.mutation {
        let (glyph, color) = state_glyph(ClankerState::Working, app.animation_frame);
        (format!("{glyph} {} · navigation available", pending.progress), color)
    } else {
        (
            app.selected()
                .map(|row| match &row.done_group {
                    Some(group) if group.expanded => format!("{} done Workshops shown · ← fold · Alt-. all done", group.count),
                    Some(group) => format!("{} done Workshops folded · → show · Alt-. all done", group.count),
                    None => row.session.path.clone(),
                })
                .unwrap_or_else(|| "No matches".into()),
            Color::DarkGray,
        )
    };
    frame.render_widget(
        Paragraph::new(footer).style(Style::default().fg(footer_color)),
        areas[2],
    );
    let (needing, open) = needs_me_counts(&app.sessions);
    frame.render_widget(
        Line::from(vec![
            Span::styled("> ", Style::default().fg(Color::LightCyan)),
            Span::raw(&app.query),
            Span::raw("_"),
            Span::raw(format!("  {} targets · {needing} need you · {open} open", app.rows.iter().filter(|row| row.done_group.is_none()).count())),
        ]),
        areas[3],
    );
}

fn needs_me_glyph(reason: &str) -> (&'static str, Color) {
    match reason {
        "asked" | "your-move" => ("?", Color::LightYellow),
        "blocked" => ("■", Color::Rgb(248, 113, 113)),
        "finished" => ("✓", Color::Rgb(74, 222, 128)),
        "failed" | "crashed" => ("✗", Color::Rgb(248, 113, 113)),
        _ => ("·", Color::Rgb(148, 163, 184)),
    }
}

/// `N need you · M open`: open means a live session, a Workshop counts once, and a snoozed or waiting-on one does
/// not count as needing you (needsMeCounts in src/needs-me.ts).
fn needs_me_counts(sessions: &[SessionRow]) -> (usize, usize) {
    let open = sessions
        .iter()
        .filter(|session| matches!(session.target, Target::Session { .. }))
        .map(|session| session.workshop_id.clone().unwrap_or_else(|| session.path.clone()))
        .collect::<HashSet<_>>();
    let needing = needs_me_sessions(sessions, "", false).into_iter().filter(|session| session.needs_me.as_ref().is_some_and(|reason| !reason.deferred())).count();
    (needing, open.len())
}

/// One needs-me row (Alt-I, Alt-E): the flat row's name, project and label tags, why it is listed on the right, and the clanker's
/// own words on a second line when there are any.
fn needs_me_item(row: &TreeRow, width: usize, now_ms: f64, current: bool) -> ListItem<'static> {
    let session = &row.session;
    let reason = session.needs_me.as_ref();
    let (glyph, color) = needs_me_glyph(reason.map_or("", |reason| reason.reason.as_str()));
    let shown = session.title.as_deref().unwrap_or_else(|| name_without_project(session)).to_string();
    let done = is_done(session);
    let mut tags = Vec::new();
    if let Some(project) = session.project.as_deref().filter(|project| *project != shown) {
        tags.push(Span::styled(format!(" {project}"), Style::default().fg(if done { DONE_GRAY } else { project_color(project) })));
    }
    tags.extend(session.labels.iter().map(|label| {
        let color = label_color(label);
        Span::styled(format!(" {label}"), Style::default().fg(if done { dimmed(color, 70) } else { color }))
    }));
    let status = reason.map(|reason| needs_me_status(reason, now_ms)).unwrap_or_default();
    let tags_width = tags.iter().map(Span::width).sum::<usize>();
    let fixed = 3 + tags_width + status.width() + 2;
    let name = ellipsize(&shown, width.saturating_sub(fixed).max(4));
    let spacing = width.saturating_sub(3 + name.width() + tags_width + status.width()).max(2);
    let mut first = vec![
        Span::styled(format!(" {glyph} "), Style::default().fg(color)),
        Span::styled(name, row_name_style(row, current, (now_ms / 1000.0) as u64)),
    ];
    first.extend(tags);
    first.extend([Span::raw(" ".repeat(spacing)), Span::styled(status, Style::default().fg(Color::Gray))]);
    let mut lines = vec![Line::from(first)];
    if let Some(excerpt) = reason.and_then(|reason| reason.excerpt.as_deref()).filter(|excerpt| !excerpt.is_empty()) {
        lines.push(Line::from(Span::styled(
            format!("      “{}”", ellipsize(excerpt, width.saturating_sub(9))),
            Style::default().fg(Color::DarkGray).add_modifier(Modifier::ITALIC),
        )));
    }
    ListItem::new(lines)
}

fn needs_me_height(row: &TreeRow) -> usize {
    1 + usize::from(row.session.needs_me.as_ref().and_then(|reason| reason.excerpt.as_deref()).is_some_and(|excerpt| !excerpt.is_empty()))
}

fn draw_needs_me(frame: &mut Frame, app: &App, areas: &[ratatui::layout::Rect]) {
    frame.render_widget(
        Line::from(vec![
            Span::styled(
                if app.view == View::Eldest { "Clankerhouse · Waiting longest" } else { "Clankerhouse · Needs me" },
                Style::default().fg(Color::LightCyan).add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                if app.view == View::Eldest {
                    "  eldest first · Alt-I freshest · Alt-F flat · Alt-S snooze · Alt-D done · Enter jump · Esc close"
                } else {
                    "  freshest first · Alt-E eldest · Alt-F flat · Alt-S snooze · Alt-D done · Enter jump · Esc close"
                },
                Style::default().fg(Color::DarkGray),
            ),
        ]),
        areas[0],
    );
    let list_area = areas[1];
    let now_ms = std::time::UNIX_EPOCH.elapsed().map_or(0.0, |elapsed| elapsed.as_millis() as f64);
    let width = list_area.width.saturating_sub(4) as usize;
    let block = Block::default().borders(Borders::ALL);
    if app.rows.is_empty() {
        let message = if app.query.is_empty() { "Caught up: nothing needs you." } else { "No matches" };
        frame.render_widget(Paragraph::new(format!(" {message}")).style(Style::default().fg(Color::Gray)).block(block), list_area);
    } else {
        // Rows grow upward from the prompt, as in the flat list; keep the selected one in view whatever the rows' heights.
        let available = list_area.height.saturating_sub(2) as usize;
        let selected = app.selected.min(app.rows.len() - 1);
        let mut start = 0;
        while start < selected && app.rows[start..=selected].iter().map(needs_me_height).sum::<usize>() > available {
            start += 1;
        }
        let mut end = selected + 1;
        let mut used = app.rows[start..end].iter().map(needs_me_height).sum::<usize>();
        while end < app.rows.len() && used + needs_me_height(&app.rows[end]) <= available {
            used += needs_me_height(&app.rows[end]);
            end += 1;
        }
        let items = app.rows[start..end]
            .iter()
            .rev()
            .map(|row| needs_me_item(row, width, now_ms, target_is_session(&row.session.target, &app.current_session)))
            .collect::<Vec<_>>();
        let mut state = ListState::default().with_selected(Some(end - selected - 1));
        frame.render_stateful_widget(
            List::new(items)
                .block(block)
                .highlight_style(Style::default().bg(Color::Rgb(30, 58, 95)).fg(Color::White))
                .highlight_symbol("›"),
            list_area,
            &mut state,
        );
    }
    let (footer, footer_color) = if !app.error.is_empty() {
        (app.error.clone(), Color::LightYellow)
    } else if let Some(pending) = &app.mutation {
        let (glyph, color) = state_glyph(ClankerState::Working, app.animation_frame);
        (format!("{glyph} {} · navigation available", pending.progress), color)
    } else {
        (app.selected().map(|row| row.session.path.clone()).unwrap_or_default(), Color::DarkGray)
    };
    frame.render_widget(Paragraph::new(footer).style(Style::default().fg(footer_color)), areas[2]);
    let (needing, open) = needs_me_counts(&app.sessions);
    frame.render_widget(
        Line::from(vec![
            Span::styled("> ", Style::default().fg(Color::LightCyan)),
            Span::raw(&app.query),
            Span::raw("_"),
            Span::raw(format!("  {needing} need you · {open} open")),
        ]),
        areas[3],
    );
}

fn handle_key(app: &mut App, key: KeyEvent) -> Option<AppCommand> {
    app.error.clear();
    if app.mutation.is_some()
        && key.modifiers.contains(KeyModifiers::ALT)
        && matches!(key.code, KeyCode::Char('r' | 'a' | 'l' | 'd'))
    {
        app.error = "An action is already running; navigation and opening remain available".into();
        return None;
    }

    if app.mode == Mode::DeleteConfirm {
        match key.code {
            KeyCode::Char('y' | 'Y') => {
                let intent = app.delete_intent.take()?;
                app.mode = Mode::Jump;
                app.clear_action_mode();
                return Some(AppCommand::Submit(intent));
            }
            KeyCode::Char('u' | 'U') if app.reopen_path.is_some() => {
                let path = app.reopen_path.take()?;
                app.mode = Mode::Jump;
                app.clear_action_mode();
                return Some(AppCommand::Submit(MutationIntent::Label {
                    path,
                    key: "status".into(),
                    value: None,
                }));
            }
            KeyCode::Char('n' | 'N') | KeyCode::Esc => {
                app.mode = Mode::Jump;
                app.clear_action_mode();
                if app.delete_only {
                    return Some(AppCommand::Close);
                }
            }
            _ => {}
        }
        return None;
    }

    if app.mode == Mode::Rename {
        match key.code {
            KeyCode::Esc => {
                app.mode = Mode::Jump;
                app.clear_action_mode();
            }
            KeyCode::Backspace => {
                app.rename_name.pop();
            }
            KeyCode::Enter if app.rename_title_path.is_some() => {
                let title = app.rename_name.trim().to_string();
                if title.chars().count() > 80 {
                    app.error = "A title is at most 80 characters".into();
                    return None;
                }
                let path = app.rename_title_path.take()?;
                app.mode = Mode::Jump;
                app.clear_action_mode();
                // An empty title clears it, returning the row to its branch name.
                return Some(AppCommand::Submit(MutationIntent::Label {
                    path,
                    key: "title".into(),
                    value: (!title.is_empty()).then_some(title),
                }));
            }
            KeyCode::Enter => {
                let intent = rename_intent(app.action_session.as_ref()?, &app.rename_name)?;
                app.mode = Mode::Jump;
                app.clear_action_mode();
                return Some(AppCommand::Submit(intent));
            }
            KeyCode::Char(character)
                if !key
                    .modifiers
                    .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
            {
                app.rename_name.push(character);
            }
            _ => {}
        }
        return None;
    }

    if app.mode == Mode::NewBase {
        match key.code {
            KeyCode::Esc => {
                app.mode = Mode::Branch;
                app.query = app.branch_name.clone();
                app.selected = 0;
            }
            KeyCode::Backspace => {
                app.base.pop();
            }
            KeyCode::Enter if !app.branch_name.is_empty() => {
                return Some(AppCommand::CreateAndOpen(MutationIntent::Create {
                    repository: app.repository.as_ref()?.path.clone(),
                    branch: app.branch_name.clone(),
                    create: true,
                    base: (!app.base.is_empty()).then(|| app.base.clone()),
                    remote_ref: None,
                    title: app.workshop_title.clone(),
                }));
            }
            KeyCode::Char(character)
                if !key
                    .modifiers
                    .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
            {
                app.base.push(character)
            }
            _ => {}
        }
        return None;
    }

    // The list's views, from any mode: Alt-I the Workshops that need the operator, freshest first; Alt-E the same
    // rows, eldest first; Alt-F everything. Alt-K in a needs-me view is Alt-F, as it was before the views merged.
    if key.modifiers.contains(KeyModifiers::ALT) {
        let view = match key.code {
            KeyCode::Char('i') => Some(View::NeedsMe),
            KeyCode::Char('e') => Some(View::Eldest),
            KeyCode::Char('f') => Some(View::Flat),
            KeyCode::Char('k') if app.view.waiting() && app.mode == Mode::Jump => Some(View::Flat),
            _ => None,
        };
        if let Some(view) = view {
            app.set_view(view);
            return None;
        }
    }
    // Alt-B as outside the picker: the branch flow's repository step. Alt-K does the same.
    if matches!(key.code, KeyCode::Char('k') | KeyCode::Char('b')) && key.modifiers.contains(KeyModifiers::ALT) {
        app.enter_repository_mode();
        return None;
    }
    if key.code == KeyCode::Char('n') && key.modifiers.contains(KeyModifiers::ALT) {
        app.enter_scratch_mode();
        return None;
    }
    if app.mode == Mode::Repository || app.mode == Mode::Branch || app.mode == Mode::Attach {
        match key.code {
            KeyCode::Esc => {
                if !app.query.is_empty() {
                    app.query.clear();
                    app.selected = 0;
                } else if app.mode == Mode::Branch {
                    app.enter_repository_mode();
                } else if app.mode == Mode::Attach {
                    app.mode = Mode::Jump;
                    app.clear_action_mode();
                } else {
                    app.mode = Mode::Jump;
                    app.selected = 0;
                }
            }
            KeyCode::Up => app.move_selection(1),
            KeyCode::Down => app.move_selection(-1),
            KeyCode::Backspace => {
                let mut query = app.query.clone();
                query.pop();
                app.update_query(query);
            }
            KeyCode::Enter if app.mode == Mode::Repository => {
                let repository = app
                    .filtered_repositories()
                    .get(app.selected)
                    .cloned()
                    .cloned()?;
                if app.scratch {
                    return Some(AppCommand::Scratch { repository: repository.path });
                }
                match collect_branches(Path::new(&repository.path)) {
                    Ok(branches) => {
                        app.repository = Some(repository);
                        app.branches = branches;
                        app.mode = Mode::Branch;
                        app.query.clear();
                        app.selected = 0;
                    }
                    Err(error) => app.error = error,
                }
            }
            KeyCode::Enter if app.mode == Mode::Attach => {
                let source = app.action_session.as_ref()?;
                if !source.available_actions.contains(&AvailableAction::Attach) {
                    return None;
                }
                let parent_id = app
                    .filtered_attach_candidates()
                    .get(app.selected)?
                    .workshop_id
                    .clone()?;
                let intent = MutationIntent::Attach {
                    workshop_id: source.workshop_id.clone()?,
                    parent_workshop_id: parent_id,
                    session: session_name(&source.target).map(str::to_string),
                };
                app.mode = Mode::Jump;
                app.query.clear();
                app.clear_action_mode();
                return Some(AppCommand::Submit(intent));
            }
            KeyCode::Enter => {
                let branch = app.filtered_branches().get(app.selected).cloned()?;
                if branch.kind == BranchKind::Create {
                    // What was typed is the Workshop's title; its branch is derived from it.
                    let Some(derived) = branch_from_title(&branch.value) else {
                        app.error = "Type a title with at least one letter or digit".into();
                        return None;
                    };
                    let taken = app.branches.iter().map(|known| known.value.as_str()).collect::<HashSet<_>>();
                    let mut name = derived.clone();
                    let mut suffix = 2;
                    while taken.contains(name.as_str()) {
                        name = format!("{derived}-{suffix}");
                        suffix += 1;
                    }
                    app.workshop_title = (branch.value.trim() != name).then(|| branch.value.trim().to_string());
                    app.branch_name = name;
                    app.base = "^".into();
                    app.mode = Mode::NewBase;
                } else {
                    return Some(AppCommand::CreateAndOpen(MutationIntent::Create {
                        repository: app.repository.as_ref()?.path.clone(),
                        branch: branch.value,
                        create: false,
                        base: None,
                        remote_ref: (branch.kind == BranchKind::Remote).then_some(branch.name),
                        title: None,
                    }));
                }
            }
            KeyCode::Char(character)
                if !key
                    .modifiers
                    .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
            {
                let mut query = app.query.clone();
                query.push(character);
                app.update_query(query);
            }
            _ => {}
        }
        return None;
    }

    if key.modifiers.contains(KeyModifiers::ALT) {
        // A needs-me list has no done fold to toggle.
        if key.code == KeyCode::Char('.') && app.view.waiting() {
            return None;
        }
        if key.code == KeyCode::Char('.') {
            app.show_done = !app.show_done;
            let key = app.selected().map(|row| row.key.clone());
            app.rebuild(key.as_deref());
            return None;
        }
        // A done group stands for many Workshops; no single-Workshop action applies to it.
        if app.selected().is_some_and(|row| row.done_group.is_some()) {
            return None;
        }
        // Alt-S, in every view: down the needs-me lists for a day, or until something new; again to take it back.
        if key.code == KeyCode::Char('s') {
            let row = app.selected()?;
            let Some(reason) = row.session.needs_me.as_ref().filter(|_| row.detail.is_none() && !row.session.path.is_empty()) else {
                app.error = "Nothing to snooze: this row does not need you".into();
                return None;
            };
            let now_ms = std::time::UNIX_EPOCH.elapsed().map_or(0.0, |elapsed| elapsed.as_millis() as f64);
            return Some(AppCommand::Submit(MutationIntent::Label {
                path: row.session.path.clone(),
                key: "_snooze".into(),
                value: snooze_value(reason, now_ms),
            }));
        }
        match key.code {
            KeyCode::Char('r') => {
                let row = app.selected()?.clone();
                if row.detail.is_none()
                    && row.allows(AvailableAction::Rename)
                    && row.session.workshop_id.is_some()
                    && !row.session.path.is_empty()
                {
                    // A Workshop is renamed by its title; the branch and identity stay put.
                    app.rename_name = row.session.title.clone().unwrap_or_default();
                    app.rename_title_path = Some(row.session.path.clone());
                    app.action_session = Some(row.session);
                    app.mode = Mode::Rename;
                    return None;
                }
                if !row.allows(AvailableAction::Rename)
                    || !matches!(row.session.target, Target::Session { .. })
                {
                    return None;
                }
                app.rename_name = row.session.name.clone();
                app.action_session = Some(row.session);
                app.mode = Mode::Rename;
                return None;
            }
            KeyCode::Char('a') => {
                let row = app.selected()?.clone();
                if row.detail.is_none()
                    && row.allows(AvailableAction::Attach)
                    && row.session.workshop_id.is_some()
                {
                    app.enter_attach_mode(row.session);
                }
                return None;
            }
            KeyCode::Char('l') => {
                let intent = detach_intent(app.selected()?)?;
                return Some(AppCommand::Submit(intent));
            }
            KeyCode::Char('d') => {
                let row = app.selected()?.clone();
                let Some(intent) = delete_intent(&row) else {
                    app.error = "Nothing to delete: target has no live pane or session".into();
                    return None;
                };
                app.delete_label = delete_label(&row, &intent);
                // A Workshop row first offers Alt-D to the daemon's done rule; the destroy
                // confirmation follows only when that leaves the key unhandled.
                let done = (row.detail.is_none() && !row.session.path.is_empty())
                    .then(|| MutationIntent::Done { path: row.session.path.clone() });
                if done.is_some()
                    && let MutationIntent::Delete { kind: DeleteKind::Session, session, .. } = &intent
                {
                    let worktree = MutationIntent::Delete {
                        kind: DeleteKind::Worktree,
                        session: session.clone(),
                        confirmed: true,
                        pane: None,
                        path: Some(row.session.path.clone()),
                    };
                    app.worktree_delete = Some((worktree.clone(), delete_label(&row, &worktree)));
                }
                app.delete_intent = Some(intent);
                if done.is_some() && row.session.labels.iter().any(|label| label == "done") {
                    app.reopen_path = Some(row.session.path.clone());
                }
                if let Some(done) = done {
                    app.done_pending = true;
                    return Some(AppCommand::Submit(done));
                }
                app.mode = Mode::DeleteConfirm;
                return None;
            }
            _ => return None,
        }
    }

    if app.view.waiting() {
        match key.code {
            // No lineage or details to unfold in a needs-me list.
            KeyCode::Left | KeyCode::Right => return None,
            KeyCode::Enter => {
                let row = app.selected()?;
                return row
                    .allows(AvailableAction::Open)
                    .then(|| AppCommand::Submit(MutationIntent::Open { target: needs_me_target(&row.session) }));
            }
            _ => {}
        }
    }

    match key.code {
        KeyCode::Esc if !app.query.is_empty() => app.update_query(String::new()),
        KeyCode::Esc => return Some(AppCommand::Close),
        KeyCode::Up => app.move_selection(1),
        KeyCode::Down => app.move_selection(-1),
        KeyCode::Backspace => {
            let mut query = app.query.clone();
            query.pop();
            app.update_query(query);
        }
        KeyCode::Right | KeyCode::Enter
            if let Some(group) = app.selected().and_then(|row| row.done_group.clone()) =>
        {
            app.expanded_done_groups.insert(group.parent);
            let key = app.selected().map(|row| row.key.clone());
            app.rebuild(key.as_deref());
        }
        KeyCode::Left if let Some(group) = app.selected().and_then(|row| row.done_group.clone()) => {
            app.expanded_done_groups.remove(&group.parent);
            let key = app.selected().map(|row| row.key.clone());
            app.rebuild(key.as_deref());
        }
        KeyCode::Right => {
            if let Some(row) = app.selected().cloned().filter(|row| row.detail.is_none()) {
                if row.has_children && !app.expanded_lineage.contains(&row.session.name) {
                    app.expanded_lineage.insert(row.session.name.clone());
                } else {
                    app.expanded_details.insert(row.session.name.clone());
                }
                app.rebuild(Some(&row.key));
            }
        }
        KeyCode::Left => {
            if let Some(row) = app.selected().cloned() {
                if row.detail.is_some() {
                    if let Some(index) = app
                        .rows
                        .iter()
                        .position(|candidate| candidate.key == target_key(&row.session.target))
                    {
                        app.selected = index;
                    }
                } else if app.expanded_details.remove(&row.session.name)
                    || app.expanded_lineage.remove(&row.session.name)
                {
                    app.rebuild(Some(&row.key));
                }
            }
        }
        KeyCode::Enter => {
            if let Some(row) = app.selected()
                && row.allows(AvailableAction::Open)
            {
                return Some(AppCommand::Submit(MutationIntent::Open {
                    target: row.target(),
                }));
            }
        }
        KeyCode::Char(character)
            if !key
                .modifiers
                .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
        {
            let mut query = app.query.clone();
            query.push(character);
            app.update_query(query);
        }
        _ => {}
    }
    None
}

fn rpc_with_timeout(
    socket_path: &Path,
    method: &str,
    params: Option<serde_json::Value>,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let mut stream = UnixStream::connect(socket_path).map_err(|error| error.to_string())?;
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|error| error.to_string())?;
    let id = format!("native-{}-{}", std::process::id(), method);
    let mut request = serde_json::json!({"version": 1, "id": id, "method": method});
    if let Some(params) = params {
        request["params"] = params;
    }
    writeln!(stream, "{request}").map_err(|error| error.to_string())?;
    let mut line = String::new();
    BufReader::new(stream)
        .read_line(&mut line)
        .map_err(|error| error.to_string())?;
    let response: serde_json::Value =
        serde_json::from_str(&line).map_err(|error| error.to_string())?;
    if response.get("ok").and_then(|value| value.as_bool()) != Some(true) {
        return Err(response
            .pointer("/error/message")
            .and_then(|value| value.as_str())
            .unwrap_or("daemon request failed")
            .into());
    }
    response
        .get("result")
        .cloned()
        .ok_or_else(|| "daemon response omitted result".into())
}

fn rpc(
    socket_path: &Path,
    method: &str,
    params: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    rpc_with_timeout(socket_path, method, params, Duration::from_secs(5))
}

fn server_health(socket_path: &Path, expected_owner: &str) -> Result<(), String> {
    let health = rpc_with_timeout(
        socket_path,
        "server.health",
        None,
        Duration::from_millis(750),
    )?;
    let healthy = health
        .get("healthy")
        .and_then(serde_json::Value::as_bool)
        == Some(true);
    let owner = health
        .get("owner")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    if healthy && owner == expected_owner {
        Ok(())
    } else {
        Err(format!(
            "daemon health owner mismatch: expected {expected_owner}, observed {owner}"
        ))
    }
}

fn socket_snapshot(socket_path: &Path) -> Result<Snapshot, String> {
    serde_json::from_value(rpc(socket_path, "snapshot.get", None)?)
        .map_err(|error| error.to_string())
}

fn subscribe_loop(socket_path: PathBuf, sender: Sender<Snapshot>) {
    let mut delay = Duration::from_millis(50);
    loop {
        match UnixStream::connect(&socket_path) {
            Ok(mut stream) => {
                let request = serde_json::json!({"version": 1, "id": "native-subscribe", "method": "snapshots.subscribe"});
                if writeln!(stream, "{request}").is_ok() {
                    delay = Duration::from_millis(50);
                    for line in BufReader::new(stream).lines() {
                        let Ok(line) = line else { break };
                        let Ok(message) = serde_json::from_str::<serde_json::Value>(&line) else {
                            break;
                        };
                        if message.get("event").and_then(|value| value.as_str()) == Some("snapshot")
                            && let Ok(snapshot) =
                                serde_json::from_value::<Snapshot>(message["snapshot"].clone())
                            && sender.send(snapshot).is_err()
                        {
                            return;
                        }
                    }
                }
            }
            Err(_) => {}
        }
        thread::sleep(delay);
        delay = (delay * 2).min(Duration::from_secs(2));
    }
}

fn rpc_retry(
    socket_path: &Path,
    method: &str,
    params: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let mut last_error = String::new();
    for attempt in 0..40 {
        match rpc(socket_path, method, params.clone()) {
            Ok(value) => return Ok(value),
            Err(error) => last_error = error,
        }
        thread::sleep(Duration::from_millis((25 * (attempt + 1)).min(500)));
    }
    Err(last_error)
}

/// Creates a scratch Workshop in `repository` with its harness running, through the CLI that owns
/// spawning, and returns the harness's window to open.
fn spawn_scratch(repository: &str) -> Result<Target, String> {
    let bin = env::var("CLANKERHOUSE_BIN_DIR").map_err(|_| "CLANKERHOUSE_BIN_DIR is not set".to_string())?;
    let harness = env::var("CLANKERHOUSE_SCRATCH_HARNESS").unwrap_or_else(|_| "claude".into());
    eprintln!("Creating a scratch Workshop in {repository}…");
    let output = Command::new(Path::new(&bin).join("clankers"))
        .args(["workshop", "spawn", "--scratch", "--no-parent", "--harness", &harness])
        .current_dir(repository)
        .env_remove("ANTHROPIC_API_KEY")
        .output()
        .map_err(|error| format!("Unable to run clankers: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!("Scratch Workshop failed: {}", if stderr.trim().is_empty() { stdout.trim() } else { stderr.trim() }));
    }
    scratch_target(&String::from_utf8_lossy(&output.stdout))
}

fn scratch_target(spawned: &str) -> Result<Target, String> {
    let value: serde_json::Value = serde_json::from_str(spawned).map_err(|error| format!("clankers returned no spawn result: {error}"))?;
    let text = |key: &str| value.get(key).and_then(|field| field.as_str()).map(str::to_string);
    let session = text("session").ok_or("clankers did not name the scratch session")?;
    Ok(match (text("window"), text("pane")) {
        (Some(window_id), Some(pane)) => Target::Window { session, window_id, pane, management: None, resource_id: None, location: None },
        _ => Target::Session { session, management: None, resource_id: None, location: None },
    })
}

fn daemon_mutation(
    socket_path: &Path,
    intent: &MutationIntent,
) -> Result<serde_json::Value, String> {
    daemon_mutation_with_submission(socket_path, intent, || {})
}

fn daemon_mutation_with_submission(
    socket_path: &Path,
    intent: &MutationIntent,
    on_submitted: impl FnOnce(),
) -> Result<serde_json::Value, String> {
    let key = format!(
        "native-{}-{}",
        std::process::id(),
        std::time::UNIX_EPOCH
            .elapsed()
            .unwrap_or_default()
            .as_nanos()
    );
    let submitted = rpc_retry(
        socket_path,
        "mutation.submit",
        Some(serde_json::json!({"idempotencyKey": key, "intent": intent})),
    )?;
    let operation_id = submitted
        .pointer("/operation/operationId")
        .and_then(|value| value.as_str())
        .ok_or("daemon omitted operation id")?
        .to_string();
    if submitted.pointer("/operation/state").and_then(serde_json::Value::as_str) == Some("failed") {
        return Err(submitted.pointer("/operation/error").and_then(serde_json::Value::as_str)
            .unwrap_or("daemon operation failed").into());
    }
    on_submitted();
    for _ in 0..1200 {
        let operation = rpc_retry(
            socket_path,
            "operation.status",
            Some(serde_json::json!({"operationId": operation_id})),
        )?;
        match operation.get("state").and_then(|value| value.as_str()) {
            Some("succeeded") => {
                return Ok(operation
                    .get("result")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null));
            }
            Some("failed") => {
                return Err(operation
                    .get("error")
                    .and_then(|value| value.as_str())
                    .unwrap_or("daemon operation failed")
                    .into());
            }
            _ => thread::sleep(Duration::from_millis(25)),
        }
    }
    Err("daemon operation timed out".into())
}

fn refresh_repository_cache_if_unavailable(
    socket_path: &Path,
    cache_path: &Path,
) -> Result<bool, String> {
    if repository_cache(cache_path).is_some() {
        return Ok(false);
    }
    daemon_mutation(socket_path, &MutationIntent::RepositoryRefresh)?;
    if repository_cache(cache_path).is_none() {
        return Err("daemon repository refresh completed without writing repositories.json".into());
    }
    Ok(true)
}

fn instance_suffix(environment: &HashMap<String, String>) -> Result<String, String> {
    let instance = environment
        .get("CLANKERHOUSE_INSTANCE")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());
    if let Some(instance) = instance
        && (matches!(instance, "." | "..")
            || !instance.chars().all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')))
    {
        return Err(format!("Invalid CLANKERHOUSE_INSTANCE: {instance}"));
    }
    Ok(match instance {
        Some("default") => String::new(),
        Some(other) => format!("-{other}"),
        None => "-herdr".to_string(),
    })
}

fn runtime_root_from(environment: &HashMap<String, String>, uid: u32) -> Result<PathBuf, String> {
    if let Some(explicit) = environment
        .get("CLANKERHOUSE_RUNTIME_DIR")
        .filter(|path| !path.trim().is_empty())
    {
        return Ok(PathBuf::from(explicit));
    }
    let suffix = instance_suffix(environment)?;
    let base = environment
        .get("XDG_RUNTIME_DIR")
        .filter(|path| !path.is_empty())
        .map(String::as_str)
        .unwrap_or("/tmp");
    Ok(PathBuf::from(base).join(format!("clankerhouse-{uid}{suffix}")))
}

/// Mirrors src/activity.ts: $XDG_STATE_HOME/clankerhouse<instance>/activity.
fn activity_dir_from(environment: &HashMap<String, String>) -> Result<PathBuf, String> {
    let state_home = environment
        .get("XDG_STATE_HOME")
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            environment
                .get("HOME")
                .map(|home| Path::new(home).join(".local/state"))
        })
        .ok_or_else(|| "No state home".to_string())?;
    Ok(state_home
        .join(format!("clankerhouse{}", instance_suffix(environment)?))
        .join("activity"))
}

fn activity_dir() -> Result<PathBuf, String> {
    activity_dir_from(&env::vars().collect())
}

fn runtime_root() -> Result<PathBuf, String> {
    if let Some(explicit) = env::var_os("CLANKERHOUSE_RUNTIME_DIR").filter(|path| !path.is_empty()) {
        return Ok(PathBuf::from(explicit));
    }
    runtime_root_from(&env::vars().collect(), unsafe { libc_getuid() })
}

unsafe extern "C" {
    #[link_name = "getuid"]
    fn libc_getuid() -> u32;
}

fn coalesce_escape_prefix(first: KeyEvent, second: KeyEvent) -> (KeyEvent, Option<KeyEvent>) {
    if first.code == KeyCode::Esc
        && first.modifiers.is_empty()
        && second.code == KeyCode::Char('d')
        && second.modifiers.is_empty()
    {
        return (
            KeyEvent::new(KeyCode::Char('d'), KeyModifiers::ALT),
            None,
        );
    }
    (first, Some(second))
}

fn handle_external_requests(app: &mut App) -> Option<AppCommand> {
    // Consume duplicate triggers while an action is running; do not surprise the
    // user with a delayed destructive confirmation after it completes.
    let requested = DELETE_REQUESTED.swap(false, Ordering::SeqCst) | std::mem::take(&mut app.delete_requested);
    if requested && app.mutation.is_none() {
        return handle_key(
            app,
            KeyEvent::new(KeyCode::Char('d'), KeyModifiers::ALT),
        );
    }
    None
}

fn run(
    mut terminal: DefaultTerminal,
    mut app: App,
    snapshots: Receiver<Snapshot>,
    socket_path: &Path,
) -> io::Result<AppCommand> {
    let mut pending_key = None;
    let (mutation_sender, mutation_receiver) = mpsc::channel::<MutationUpdate>();
    loop {
        while let Ok(update) = mutation_receiver.try_recv() {
            if let Some(command) = apply_mutation_update(&mut app, update) {
                return Ok(command);
            }
        }
        terminal.draw(|frame| draw(frame, &mut app))?;
        let mut command = handle_external_requests(&mut app);
        let mut key = pending_key.take();
        if key.is_none() && event::poll(Duration::from_millis(100))?
            && let Event::Key(observed) = event::read()?
        {
            key = Some(observed);
        }
        if let Some(observed) = key
            && command.is_none()
        {
            let mut effective = observed;
            if observed.code == KeyCode::Esc && observed.modifiers.is_empty()
                && event::poll(Duration::from_millis(40))?
                && let Event::Key(next) = event::read()?
            {
                (effective, pending_key) = coalesce_escape_prefix(observed, next);
            }
            command = handle_key(&mut app, effective);
        }
        if let Some(command) = command {
            match dispatch_command(&mut app, command) {
                CommandDispatch::Background(intent) => {
                    let sender = mutation_sender.clone();
                    let mutation_socket_path = socket_path.to_path_buf();
                    thread::spawn(move || {
                        let result = daemon_mutation_with_submission(&mutation_socket_path, &intent, || {
                            let _ = sender.send(MutationUpdate::Submitted);
                        });
                        let _ = sender.send(MutationUpdate::Finished(result));
                    });
                }
                CommandDispatch::Exit(command) => return Ok(command),
                CommandDispatch::Continue => {}
            }
        }
        while let Ok(snapshot) = snapshots.try_recv() {
            if let Err(error) = app.apply_snapshot(snapshot, false) {
                app.error = error;
            }
        }
        app.animation_frame = (app.animation_frame + 1) % 40;
    }
}

const USAGE: &str = "Usage: clankerhouse-native [--dump-tree | --check | --delete-current | --server-health OWNER]

The Clankerhouse picker. Without an option it draws on the terminal and needs one; launch it through
clankerhouse-hc or clankerhouse-herdr. The options print and exit without a terminal:
  --dump-tree             the flat list's rows as JSON
  --check                 count the daemon snapshot's sessions
  --delete-current        confirm deleting CLANKERHOUSE_CURRENT_SESSION (draws; needs a terminal)
  --server-health OWNER   exit 0 when the daemon is healthy and owned by OWNER
For the needs-me list without a terminal: clankers needs-me [--json] [--eldest | --flat]";

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let arguments = env::args().collect::<Vec<_>>();
    if arguments.iter().skip(1).any(|argument| argument == "--help" || argument == "-h") {
        println!("{USAGE}");
        return Ok(());
    }
    let runtime = runtime_root().map_err(io::Error::other)?;
    let socket_path = runtime.join("daemon.sock");
    if let Some(index) = arguments.iter().position(|argument| argument == "--server-health") {
        let expected_owner = arguments
            .get(index + 1)
            .ok_or_else(|| io::Error::other("--server-health requires EXPECTED_OWNER"))?;
        return server_health(&socket_path, expected_owner)
            .map_err(|error| io::Error::other(error).into());
    }

    let current_session = env::var("CLANKERHOUSE_CURRENT_SESSION")
        .ok()
        .filter(|session| !session.is_empty())
        .unwrap_or_default();
    let cache_path = runtime.join("state.json");
    let dump_tree = arguments.iter().any(|argument| argument == "--dump-tree");
    let check = arguments.iter().any(|argument| argument == "--check");
    let delete_current = arguments.iter().any(|argument| argument == "--delete-current");
    let authoritative_snapshot = socket_snapshot(&socket_path);
    if delete_current && authoritative_snapshot.is_err() {
        return Err(io::Error::other("Deletion confirmation requires a live daemon snapshot").into());
    }
    let repository_cache_error = if dump_tree || check || delete_current || authoritative_snapshot.is_err() {
        None
    } else {
        refresh_repository_cache_if_unavailable(&socket_path, &cache_path).err()
    };
    let mut app = match authoritative_snapshot {
        Ok(snapshot) => App::from_snapshot(cache_path, current_session, snapshot),
        Err(_) => App::new(cache_path, current_session),
    }
    .map_err(io::Error::other)?;
    if let Some(error) = repository_cache_error {
        app.error = format!("Unable to refresh repositories: {error}");
    }
    if dump_tree {
        let rows = app
            .rows
            .iter()
            .enumerate()
            .map(|(index, row)| {
                serde_json::json!({
                    "index": index,
                    "selected": index == app.selected,
                    "key": row.key,
                    "depth": row.depth,
                    "name": row.session.name,
                    "path": row.session.path,
                    "workshopId": row.session.workshop_id,
                    "parentWorkshopId": row.session.parent_workshop_id,
                    "detailKind": row.detail.as_ref().map(|detail| detail.kind.as_str()),
                    "state": format!("{:?}", row.state).to_lowercase(),
                    "target": row.target(),
                })
            })
            .collect::<Vec<_>>();
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({ "version": 1, "rows": rows }))?
        );
        return Ok(());
    }
    if check {
        let sessions = app
            .sessions
            .iter()
            .filter(|row| matches!(row.target, Target::Session { .. }))
            .count();
        let directory_resources = app
            .sessions
            .iter()
            .filter(|row| matches!(row.target, Target::Directory { .. }))
            .count();
        println!(
            "Native snapshot ready: {sessions} sessions, {directory_resources} directory resources, {} visible targets",
            app.rows.len()
        );
        return Ok(());
    }
    if delete_current {
        app.confirm_current_deletion().map_err(io::Error::other)?;
    } else if env::var("CLANKERHOUSE_MODE").as_deref() == Ok("spawn") {
        app.enter_repository_mode();
    } else if env::var("CLANKERHOUSE_MODE").as_deref() == Ok("scratch") {
        app.enter_scratch_mode();
    } else if env::var("CLANKERHOUSE_MODE").as_deref() == Ok("needs-me") {
        app.set_view(View::NeedsMe);
    }
    // Without a terminal ratatui::init panics; say what to use instead.
    if !io::stdout().is_terminal() {
        return Err(io::Error::other("The picker needs a terminal. For the needs-me list without one: clankers needs-me [--json] [--eldest | --flat]").into());
    }
    let (snapshot_sender, snapshot_receiver) = mpsc::channel();
    let subscription_path = socket_path.clone();
    thread::spawn(move || subscribe_loop(subscription_path, snapshot_sender));
    let _delete_signal = unsafe {
        signal_hook::low_level::register(signal_hook::consts::SIGUSR1, || {
            DELETE_REQUESTED.store(true, Ordering::SeqCst);
        })?
    };
    let terminal = ratatui::init();
    let result = run(terminal, app, snapshot_receiver, &socket_path);
    ratatui::restore();
    match result? {
        AppCommand::Close => Ok(()),
        AppCommand::Submit(intent) => daemon_mutation(&socket_path, &intent)
            .map(|_| ())
            .map_err(|error| io::Error::other(error).into()),
        AppCommand::CreateAndOpen(intent @ MutationIntent::Create { .. }) => {
            let result = daemon_mutation(&socket_path, &intent).map_err(io::Error::other)?;
            let target: Target = serde_json::from_value(
                result
                    .get("target")
                    .cloned()
                    .ok_or_else(|| io::Error::other("daemon omitted created target"))?,
            )?;
            daemon_mutation(
                &socket_path,
                &MutationIntent::Open { target },
            )
            .map(|_| ())
            .map_err(|error| io::Error::other(error).into())
        }
        AppCommand::CreateAndOpen(_) => unreachable!("create flow emitted a non-create intent"),
        AppCommand::Scratch { repository } => {
            let target = spawn_scratch(&repository).map_err(io::Error::other)?;
            daemon_mutation(&socket_path, &MutationIntent::Open { target })
                .map(|_| ())
                .map_err(|error| io::Error::other(error).into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mutation_progress_describes_detach_while_the_daemon_runs() {
        let intent = MutationIntent::Detach {
            workshop_id: "workshop-id".into(),
            session: Some("workshop".into()),
        };

        assert_eq!(mutation_progress_label(&intent), "Detaching Workshop…");
    }

    #[test]
    fn state_glyphs_match_herdr_symbols() {
        assert_eq!(state_glyph(ClankerState::Blocked, 0).0, "▲");
        assert_eq!(state_glyph(ClankerState::Working, 0).0, "◐");
        assert_eq!(state_glyph(ClankerState::Working, 2).0, "◓");
        assert_eq!(state_glyph(ClankerState::Working, 8).0, "◐");
        assert_eq!(state_glyph(ClankerState::Done, 0).0, state_glyph(ClankerState::Done, 5).0);
        assert_eq!(state_glyph(ClankerState::Done, 0).0, "✓");
        assert_eq!(state_glyph(ClankerState::Idle, 0).0, "✓");
        assert_eq!(state_glyph(ClankerState::Unknown, 0).0, "·");
        assert_eq!(state_glyph(ClankerState::Failed, 0).0, "×");
    }

    #[test]
    fn fuzzy_search_rewards_contiguous_word_matches() {
        assert!(
            fuzzy_score("clankerhouse-native", "native").unwrap()
                > fuzzy_score("not_a_tiny_interleaved_value", "native").unwrap()
        );
        assert!(fuzzy_score("clankerhouse", "xyz").is_none());
    }

    #[test]
    fn parses_the_existing_snapshot_contract() {
        let snapshot: Snapshot = serde_json::from_str(r#"{
            "version": 11,
            "sessions": [{
                "name": "workshop", "path": "/tmp/workshop", "target": {"type": "session", "session": "workshop"},
                "details": [{"kind": "clanker", "state": "working", "target": {"type": "window", "session": "workshop", "windowId": "@1", "pane": "%1"}, "observation": {"source": "lifecycle", "confidence": "attested", "state": "working", "observedAt": 10}}]
            }]
        }"#).unwrap();
        assert_eq!(snapshot.sessions.len(), 1);
        assert_eq!(session_state(&snapshot.sessions[0]), ClankerState::Working);
    }

    #[test]
    fn process_presence_is_neutral_but_rejected_lifecycle_evidence_is_unknown() {
        let sessions: Vec<SessionRow> = serde_json::from_str(r#"[
            {"name":"observed","path":"/tmp/observed","target":{"type":"session","session":"observed"},"details":[{"kind":"observation","harness":"opencode","state":"unknown","target":{"type":"window","session":"observed","windowId":"@1","pane":"%1"},"observation":{"source":"process","confidence":"observed","state":"present","observedAt":10}}]},
            {"name":"rejected","path":"/tmp/rejected","target":{"type":"session","session":"rejected"},"details":[{"kind":"observation","harness":"pi","state":"unknown","target":{"type":"window","session":"rejected","windowId":"@2","pane":"%2"},"observation":{"source":"lifecycle","confidence":"rejected","state":"done","observedAt":10}}]}
        ]"#).unwrap();
        assert!(neutral_session(&sessions[0]));
        assert!(!neutral_session(&sessions[1]));
    }

    #[test]
    fn parses_and_keys_managed_targets_by_stable_identity() {
        let target: Target = serde_json::from_str(r#"{
            "type":"session",
            "session":"mutable-name",
            "management":"managed",
            "resourceId":"mux-session-1",
            "location":{"kind":"herdr","instanceId":"server","nativeSessionId":"w1","nativeWindowId":null,"nativePaneId":null}
        }"#).unwrap();
        assert_eq!(target_key(&target), "session:mux-session-1");
        assert!(target_is_session(&target, "w1"));
        assert!(
            serde_json::to_string(&target)
                .unwrap()
                .contains("mux-session-1")
        );
    }

    #[test]
    fn failed_lineage_with_fewer_than_ten_rows_starts_expanded() {
        let snapshot: Snapshot = serde_json::from_str(r#"{
            "version": 11,
            "sessions": [
                {
                    "name": "failed-root", "path": "/tmp/root", "workshopId": "root",
                    "target": {"type": "directory", "path": "/tmp/root"}
                },
                {
                    "name": "failed-child", "path": "/tmp/failed", "workshopId": "failed-child", "parentWorkshopId": "root",
                    "target": {"type": "directory", "path": "/tmp/failed"},
                    "details": [{"kind": "clanker", "status": "failed", "state": "failed", "target": {"type": "directory", "path": "/tmp/failed"}}]
                },
                {
                    "name": "neutral-child", "path": "/tmp/neutral", "workshopId": "neutral-child", "parentWorkshopId": "root",
                    "target": {"type": "directory", "path": "/tmp/neutral"}
                }
            ]
        }"#).unwrap();
        let app = App::from_snapshot(PathBuf::from("/tmp/unused"), String::new(), snapshot).unwrap();

        assert!(app.expanded_lineage.contains("failed-root"));
        assert_eq!(app.rows.iter().map(|row| row.session.name.as_str()).collect::<Vec<_>>(), vec!["failed-child", "neutral-child", "failed-root"]);
        let root = app.rows.iter().find(|row| row.session.name == "failed-root").unwrap();
        assert_eq!(row_glyph(root, "", 0), ("×", Color::Rgb(248, 113, 113)));
    }

    #[test]
    fn missing_and_invalid_repository_caches_are_regenerated_through_the_daemon() {
        let root = env::temp_dir().join(format!(
            "clankerhouse-native-repository-refresh-test-{}",
            std::process::id()
        ));
        let cache_path = root.join("state.json");
        let socket_path = root.join("daemon.sock");
        fs::create_dir_all(&root).unwrap();
        let listener = std::os::unix::net::UnixListener::bind(&socket_path).unwrap();
        let server_root = root.clone();
        let server = thread::spawn(move || {
            for _ in 0..4 {
                let (mut stream, _) = listener.accept().unwrap();
                let mut line = String::new();
                BufReader::new(stream.try_clone().unwrap())
                    .read_line(&mut line)
                    .unwrap();
                let request: serde_json::Value = serde_json::from_str(&line).unwrap();
                let result = match request["method"].as_str().unwrap() {
                    "mutation.submit" => {
                        assert_eq!(request["params"]["intent"]["type"], "repository.refresh");
                        serde_json::json!({
                            "operation": { "operationId": "refresh-operation" },
                            "replayed": false
                        })
                    }
                    "operation.status" => {
                        fs::write(
                            server_root.join("repositories.json"),
                            r#"{"version":1,"entries":{"/repo":{"commonDir":"/repo/.git"}}}"#,
                        )
                        .unwrap();
                        serde_json::json!({
                            "operationId": "refresh-operation",
                            "state": "succeeded",
                            "result": { "repositories": [] }
                        })
                    }
                    method => panic!("unexpected daemon method {method}"),
                };
                let response = serde_json::json!({
                    "version": 1,
                    "id": request["id"],
                    "ok": true,
                    "result": result
                });
                writeln!(stream, "{response}").unwrap();
            }
        });

        assert_eq!(
            refresh_repository_cache_if_unavailable(&socket_path, &cache_path),
            Ok(true)
        );
        assert_eq!(
            repository_identities(&cache_path).get("/repo"),
            Some(&"/repo/.git".to_string())
        );

        fs::write(root.join("repositories.json"), "not json").unwrap();
        assert_eq!(
            refresh_repository_cache_if_unavailable(&socket_path, &cache_path),
            Ok(true)
        );
        server.join().unwrap();
        assert_eq!(
            repository_identities(&cache_path).get("/repo"),
            Some(&"/repo/.git".to_string())
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_valid_empty_repository_cache_does_not_trigger_regeneration() {
        let root = env::temp_dir().join(format!(
            "clankerhouse-native-empty-repository-cache-test-{}",
            std::process::id()
        ));
        let cache_path = root.join("state.json");
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("repositories.json"),
            r#"{"version":1,"entries":{}}"#,
        )
        .unwrap();

        assert_eq!(
            refresh_repository_cache_if_unavailable(&root.join("missing.sock"), &cache_path),
            Ok(false)
        );
        fs::remove_dir_all(root).unwrap();
    }

    fn repository_row(name: &str, path: &str, common_dir: &str) -> RepositoryRow {
        RepositoryRow {
            name: name.into(),
            path: path.into(),
            common_dir: common_dir.into(),
            last_used: 0,
        }
    }

    fn names(rows: &[&RepositoryRow]) -> Vec<String> {
        rows.iter().map(|row| row.name.clone()).collect()
    }

    #[test]
    fn repository_last_used_reads_opened_and_active_activity_per_repository() {
        let root = env::temp_dir().join(format!(
            "clankerhouse-native-repo-activity-test-{}",
            std::process::id()
        ));
        let activity = root.join("activity");
        let beta = root.join("beta");
        let beta_feature = root.join("beta.feature");
        fs::create_dir_all(&activity).unwrap();
        fs::create_dir_all(beta.join(".git/worktrees/beta.feature")).unwrap();
        fs::create_dir_all(&beta_feature).unwrap();
        fs::write(
            beta_feature.join(".git"),
            format!("gitdir: {}\n", beta.join(".git/worktrees/beta.feature").display()),
        )
        .unwrap();
        let write = |file: &str, path: &str, at: u64| {
            fs::write(
                activity.join(file),
                format!(r#"{{"path":"{path}","source":"x","updatedAt":{at}}}"#),
            )
            .unwrap()
        };
        // Cached paths map through the repository cache; the newest record wins.
        write("a-opened.json", "/alpha/main", 100);
        write("b-active.json", "/alpha-feature", 300);
        // Uncached checkouts resolve from their .git entry, linked or main.
        write("c-opened.json", &beta.to_string_lossy(), 200);
        write("d-active.json", &beta_feature.to_string_lossy(), 250);
        // Clanker reports and vanished checkouts are ignored; junk is skipped.
        write("e-clanker.json", &beta.to_string_lossy(), 900);
        write("f-opened.json", "/elsewhere/gone", 950);
        fs::write(activity.join("g-active.json"), "not json").unwrap();
        let identities = HashMap::from([
            ("/alpha/main".to_string(), "/alpha/.git".to_string()),
            ("/alpha-feature".to_string(), "/alpha/.git".to_string()),
        ]);

        let last_used = repository_last_used(&activity, &identities);

        assert_eq!(
            last_used,
            HashMap::from([
                ("/alpha/.git".to_string(), 300),
                (beta.join(".git").to_string_lossy().into_owned(), 250),
            ])
        );
        assert!(repository_last_used(&root.join("missing"), &identities).is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn repositories_sort_by_last_used_with_unused_in_name_order_after() {
        let mut app = app_with_sessions("[]");
        app.repositories = vec![
            repository_row("alpha", "/alpha", "/alpha/.git"),
            repository_row("beta", "/beta", "/beta/.git"),
            repository_row("gamma", "/gamma", "/gamma/.git"),
            repository_row("delta", "/delta", "/delta/.git"),
        ];
        let last_used = HashMap::from([
            ("/gamma/.git".to_string(), 100),
            ("/beta/.git".to_string(), 500),
        ]);
        order_repositories(&mut app.repositories, &last_used);

        assert_eq!(
            names(&app.filtered_repositories()),
            ["beta", "gamma", "alpha", "delta"]
        );

        // Under a query, match quality ranks first: the exact name beats a more
        // recently used repository that merely contains it.
        app.repositories.push(repository_row("xalpha", "/xalpha", "/xalpha/.git"));
        app.repositories.last_mut().unwrap().last_used = 900;
        app.query = "alpha".into();
        assert_eq!(names(&app.filtered_repositories()), ["alpha", "xalpha"]);

        // Equally good matches keep recency order.
        app.repositories.push(repository_row("alphb", "/alphb", "/alphb/.git"));
        app.repositories.last_mut().unwrap().last_used = 50;
        app.query = "alph".into();
        assert_eq!(names(&app.filtered_repositories()), ["alphb", "alpha", "xalpha"]);
    }

    #[test]
    fn activity_dir_matches_the_daemon_state_layout() {
        let environment = |pairs: &[(&str, &str)]| {
            pairs
                .iter()
                .map(|(key, value)| (key.to_string(), value.to_string()))
                .collect::<HashMap<_, _>>()
        };
        assert_eq!(
            activity_dir_from(&environment(&[("HOME", "/home/u")])),
            Ok(PathBuf::from("/home/u/.local/state/clankerhouse-herdr/activity"))
        );
        assert_eq!(
            activity_dir_from(&environment(&[
                ("HOME", "/home/u"),
                ("XDG_STATE_HOME", "/state"),
                ("CLANKERHOUSE_INSTANCE", "hc"),
            ])),
            Ok(PathBuf::from("/state/clankerhouse-hc/activity"))
        );
        assert_eq!(
            activity_dir_from(&environment(&[
                ("HOME", "/home/u"),
                ("CLANKERHOUSE_INSTANCE", "default"),
            ])),
            Ok(PathBuf::from("/home/u/.local/state/clankerhouse/activity"))
        );
    }

    #[test]
    fn repository_cache_deduplicates_worktrees() {
        let root = env::temp_dir().join(format!("clankerhouse-native-test-{}", std::process::id()));
        let cache_path = root.join("state.json");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("repositories.json"), r#"{"version":1,"entries":{"/repo/main":{"commonDir":"/repo/.git"},"/repo/feature":{"commonDir":"/repo/.git"}}}"#).unwrap();
        let sessions: Vec<SessionRow> = serde_json::from_str(r#"[
            {"name":"main","path":"/repo/main","branch":"main","availableActions":["open","create"],"target":{"type":"directory","path":"/repo/main"}},
            {"name":"feature","path":"/repo/feature","branch":"feature","availableActions":["open","create"],"target":{"type":"directory","path":"/repo/feature"}}
        ]"#).unwrap();
        let rows = repository_rows(&cache_path, &sessions);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].name, "repo");
        assert_eq!(rows[0].path, "/repo/main");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn transient_socket_failure_keeps_the_last_good_rows() {
        let root = env::temp_dir().join(format!(
            "clankerhouse-native-reload-test-{}",
            std::process::id()
        ));
        let cache_path = root.join("state.json");
        fs::create_dir_all(&root).unwrap();
        fs::write(&cache_path, r#"{"version":11,"sessions":[{"name":"kept","path":"/repo","target":{"type":"directory","path":"/repo"}}]}"#).unwrap();
        let mut app = App::new(cache_path.clone(), String::new()).unwrap();

        fs::remove_file(&cache_path).unwrap();
        assert!(
            app.apply_snapshot(
                Snapshot {
                    version: 99,
                    sessions: Vec::new()
                },
                false
            )
            .is_err()
        );
        assert_eq!(app.sessions.len(), 1);
        assert_eq!(app.sessions[0].name, "kept");

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unmatched_branch_query_offers_creation() {
        let root = env::temp_dir().join(format!(
            "clankerhouse-native-branch-test-{}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("state.json"), r#"{"version":11,"sessions":[]}"#).unwrap();
        let mut app = App::new(root.join("state.json"), String::new()).unwrap();
        app.mode = Mode::Branch;
        app.branches = vec![BranchRow {
            name: "main".into(),
            value: "main".into(),
            kind: BranchKind::Local,
            path: String::new(),
            recency: 0,
        }];
        app.query = "feature".into();
        let rows = app.filtered_branches();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].kind, BranchKind::Create);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn inline_summary_reports_hidden_details() {
        let session: SessionRow = serde_json::from_str(r#"{
            "name":"workshop","path":"/repo","target":{"type":"session","session":"workshop"},
            "details":[
                {"kind":"clanker","harness":"opencode","state":"working","target":{"type":"window","session":"workshop","windowId":"@1","pane":"%1"}},
                {"kind":"clanker","harness":"claude","state":"idle","target":{"type":"window","session":"workshop","windowId":"@2","pane":"%2"}},
                {"kind":"window","title":"shell","state":"idle","target":{"type":"window","session":"workshop","windowId":"@3","pane":"%3"}}
            ]
        }"#).unwrap();
        assert_eq!(inline_summary(&session, 15), "opencode  +2");
        assert_eq!(inline_summary(&session, 40), "opencode  claude  shell");
    }

    #[test]
    fn jump_rows_sort_status_bearing_rows_before_neutral_then_by_last_seen() {
        let app = app_with_sessions(
            r#"[
                {"name":"working","path":"/working","recency":10,"target":{"type":"session","session":"working"},"details":[{"kind":"clanker","state":"working","target":{"type":"window","session":"working","windowId":"@1","pane":"%1"}}]},
                {"name":"failed","path":"/failed","recency":20,"target":{"type":"session","session":"failed"},"details":[{"kind":"clanker","state":"failed","target":{"type":"window","session":"failed","windowId":"@4","pane":"%4"}}]},
                {"name":"ready","path":"/ready","recency":30,"target":{"type":"session","session":"ready"},"details":[{"kind":"clanker","state":"done","target":{"type":"window","session":"ready","windowId":"@2","pane":"%2"}}]},
                {"name":"idle","path":"/idle","recency":40,"target":{"type":"session","session":"idle"},"details":[{"kind":"clanker","state":"idle","target":{"type":"window","session":"idle","windowId":"@3","pane":"%3"}}]},
                {"name":"neutral","path":"/neutral","recency":50,"target":{"type":"session","session":"neutral"}}
            ]"#,
        );
        assert_eq!(
            app.rows
                .iter()
                .filter(|row| row.depth == 0)
                .map(|row| row.session.name.as_str())
                .collect::<Vec<_>>(),
            vec!["idle", "ready", "failed", "working", "neutral"]
        );
    }

    #[test]
    fn blue_checkmark_lineages_precede_recent_grey_orbs_even_when_collapsed() {
        let mut app = app_with_sessions(
            r#"[
                {"name":"directory","path":"/directory","recency":500,"target":{"type":"directory","path":"/directory"}},
                {"name":"root","path":"/root","recency":1,"workshopId":"root","target":{"type":"session","session":"root"}},
                {"name":"idle","path":"/idle","recency":10,"parentWorkshopId":"root","target":{"type":"session","session":"idle"},"details":[{"kind":"clanker","state":"idle","target":{"type":"window","session":"idle","windowId":"@1","pane":"%1"}}]},
                {"name":"shell","path":"/shell","recency":200,"parentWorkshopId":"root","target":{"type":"session","session":"shell"}}
            ]"#,
        );
        assert_eq!(app.rows.iter().map(|row| row.session.name.as_str()).collect::<Vec<_>>(),
            vec!["idle", "shell", "root", "directory"]);
        assert_eq!(row_glyph(&app.rows[0], "", 0), ("✓", Color::Rgb(96, 165, 250)));
        assert_eq!(row_glyph(&app.rows[1], "", 0), ("○", Color::Rgb(148, 163, 184)));
        app.expanded_lineage.clear();
        app.rebuild(None);
        assert_eq!(app.rows.iter().map(|row| row.session.name.as_str()).collect::<Vec<_>>(),
            vec!["root", "directory"]);
        assert_eq!(row_glyph(&app.rows[0], "", 0), ("✓", Color::Rgb(96, 165, 250)));
    }

    #[test]
    fn lineage_sorts_by_its_most_recent_descendant() {
        let mut app = app_with_sessions(
            r#"[
                {"name":"root","path":"/root","recency":10,"workshopId":"root","target":{"type":"session","session":"root"}},
                {"name":"child","path":"/child","recency":90,"workshopId":"child","parentWorkshopId":"root","target":{"type":"session","session":"child"}},
                {"name":"other","path":"/other","recency":50,"target":{"type":"session","session":"other"}}
            ]"#,
        );
        app.expanded_lineage.insert("root".into());
        app.rebuild(None);
        assert_eq!(
            app.rows
                .iter()
                .filter(|row| row.detail.is_none())
                .map(|row| row.session.name.as_str())
                .collect::<Vec<_>>(),
            vec!["child", "root", "other"]
        );
    }

    #[test]
    fn a_direct_session_match_beats_its_incidental_detail_match() {
        let mut app = app_with_sessions(
            r#"[
                {"name":"qa-delete-final","path":"/qa-delete-final","directorySource":"worktree","target":{"type":"session","session":"qa-delete-final"},"details":[{"kind":"window","title":"final","state":"idle","target":{"type":"window","session":"qa-delete-final","windowId":"@1","pane":"%1"}}]}
            ]"#,
        );
        app.update_query("final".into());

        assert!(app.selected().unwrap().detail.is_none());
    }

    #[test]
    fn an_exact_detail_search_selects_the_matching_detail() {
        let mut app = app_with_sessions(
            r#"[
                {"name":"search-root","path":"/root","markers":["exact-hit"],"workshopId":"root","target":{"type":"session","session":"root"}},
                {"name":"search-child","path":"/child","workshopId":"child","parentWorkshopId":"root","target":{"type":"session","session":"child"},"details":[{"kind":"window","title":"exact-hit","state":"idle","target":{"type":"window","session":"child","windowId":"@1","pane":"%1"}}]}
            ]"#,
        );
        app.update_query("exact-hit".into());

        let selected = app.selected().unwrap();
        assert_eq!(selected.detail.as_ref().unwrap().title, "exact-hit");
    }

    #[test]
    fn broadening_a_lineage_search_preserves_the_match_until_cleared() {
        let mut app = app_with_sessions(
            r#"[
                {"name":"tweezr@idp-java","path":"/root","workshopId":"root","target":{"type":"session","session":"root"}},
                {"name":"tweezr@fix-coverage-hyphenation","path":"/coverage","workshopId":"coverage","parentWorkshopId":"root","target":{"type":"session","session":"coverage"}},
                {"name":"tweezr@fix-java-failed-tests","path":"/failed","workshopId":"failed","parentWorkshopId":"root","target":{"type":"session","session":"failed"}}
            ]"#,
        );
        app.selected = app.rows.iter().position(|row| row.session.name == "tweezr@idp-java").unwrap();
        let original_key = app.selected().unwrap().key.clone();
        let query = "tweezr@fix-java-failed-tests";
        for end in 1..=query.len() {
            app.update_query(query[..end].into());
        }
        assert_eq!(app.selected().unwrap().session.name, query);

        for end in (1..query.len()).rev() {
            app.update_query(query[..end].into());
            assert_eq!(app.selected().unwrap().session.name, query);
        }
        app.update_query(String::new());
        assert!(app.query.is_empty());
        assert_eq!(app.selected().unwrap().key, original_key);
    }

    fn rendered_view(app: &mut App) -> ratatui::buffer::Buffer {
        let mut terminal = ratatui::Terminal::new(ratatui::backend::TestBackend::new(100, 20)).unwrap();
        terminal.draw(|frame| draw(frame, app)).unwrap();
        terminal.backend().buffer().clone()
    }

    #[test]
    fn clearing_search_restores_the_entire_unfiltered_view() {
        let sessions = (0..50).map(|index| serde_json::json!({
            "name": format!("workshop-{index:02}"),
            "path": format!("/workshop-{index:02}"),
            "recency": 100 - index,
            "workshopId": format!("workshop-{index:02}"),
            "parentWorkshopId": if index == 26 { Some("workshop-25") } else { None },
            "target": { "type": "session", "session": format!("workshop-{index:02}") },
            "details": [{
                "kind": "window", "title": "shell", "state": "idle",
                "target": { "type": "window", "session": format!("workshop-{index:02}"),
                    "windowId": format!("@{index}"), "pane": format!("%{index}") }
            }]
        })).collect::<Vec<_>>();
        let mut app = app_with_sessions(&serde_json::to_string(&sessions).unwrap());
        app.current_session = "workshop-00".into();
        app.expanded_details.insert("workshop-25".into());
        app.rebuild(None);

        // Cover the initial view, a scrolled selection, and an expanded detail.
        for key in ["session:workshop-00", "session:workshop-40", "window:workshop-25:@25:window"] {
            app.selected = app.rows.iter().position(|row| row.key == key).unwrap();
            for query in ["workshop-49", "shell", "no-match-λ", " "] {
                for clear_with_escape in [false, true] {
                    let before = rendered_view(&mut app);
                    for character in query.chars() {
                        handle_key(&mut app, KeyEvent::new(KeyCode::Char(character), KeyModifiers::NONE));
                    }
                    if clear_with_escape {
                        handle_key(&mut app, KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
                    } else {
                        for _ in query.chars() {
                            handle_key(&mut app, KeyEvent::new(KeyCode::Backspace, KeyModifiers::NONE));
                        }
                    }
                    assert!(app.query.is_empty());
                    assert_eq!(app.selected().unwrap().key, key);
                    assert_eq!(rendered_view(&mut app), before, "query={query:?}, escape={clear_with_escape}");
                }
            }
        }
    }

    #[test]
    fn clearing_search_restores_stable_identity_after_a_snapshot_update() {
        let mut app = app_with_sessions(r#"[
            {"name":"original","path":"/original","target":{"type":"session","session":"original","resourceId":"stable-id"}},
            {"name":"result","path":"/result","target":{"type":"session","session":"result"}}
        ]"#);
        app.update_query("result".into());
        let sessions = serde_json::from_str(r#"[
            {"name":"result","path":"/result","recency":100,"target":{"type":"session","session":"result"}},
            {"name":"renamed","path":"/original","target":{"type":"session","session":"renamed","resourceId":"stable-id"}}
        ]"#).unwrap();
        app.apply_snapshot(Snapshot { version: CACHE_VERSION, sessions }, false).unwrap();
        app.update_query(String::new());
        assert_eq!(app.selected().unwrap().key, "session:stable-id");
        assert_eq!(app.selected().unwrap().session.name, "renamed");
    }

    #[test]
    fn clearing_search_falls_back_when_the_original_target_disappears() {
        let mut app = app_with_sessions(r#"[
            {"name":"original","path":"/original","target":{"type":"session","session":"original"}},
            {"name":"result","path":"/result","target":{"type":"session","session":"result"}},
            {"name":"current","path":"/current","target":{"type":"session","session":"current"}}
        ]"#);
        app.current_session = "current".into();
        app.selected = app.rows.iter().position(|row| row.session.name == "original").unwrap();
        app.update_query("result".into());
        let sessions = app.sessions.iter().filter(|row| row.name != "original").cloned().collect();
        app.apply_snapshot(Snapshot { version: CACHE_VERSION, sessions }, false).unwrap();
        app.update_query(String::new());
        assert_eq!(app.selected().unwrap().session.name, "current");
        assert!(app.rows.iter().all(|row| row.session.name != "original"));

        app.update_query("result".into());
        app.apply_snapshot(Snapshot { version: CACHE_VERSION, sessions: vec![] }, false).unwrap();
        app.update_query(String::new());
        assert!(app.selected().is_none());
    }

    #[test]
    fn lineage_uses_its_most_actionable_descendant_state() {
        let sessions: Vec<SessionRow> = serde_json::from_str(r#"[
            {"name":"parent","path":"/parent","workshopId":"parent","target":{"type":"session","session":"parent"}},
            {"name":"child","path":"/child","workshopId":"child","parentWorkshopId":"parent","target":{"type":"session","session":"child"},"details":[{"kind":"clanker","state":"blocked","target":{"type":"window","session":"child","windowId":"@1","pane":"%1"}}]}
        ]"#).unwrap();
        let mut by_parent = HashMap::new();
        by_parent.insert(None, vec![0]);
        by_parent.insert(Some("parent".into()), vec![1]);
        assert_eq!(
            subtree_state(0, &sessions, &by_parent, &mut HashSet::new()),
            ClankerState::Blocked
        );
    }

    #[test]
    fn unknown_clanker_lineage_keeps_its_glyph_and_precedes_neutral_rows() {
        let app = app_with_sessions(
            r#"[
                {"name":"neutral","path":"/neutral","target":{"type":"session","session":"neutral"},"details":[{"kind":"window","state":"unknown","target":{"type":"window","session":"neutral","windowId":"@1","pane":"%1"}}]},
                {"name":"parent","path":"/parent","workshopId":"parent","target":{"type":"session","session":"parent"},"details":[{"kind":"window","state":"unknown","target":{"type":"window","session":"parent","windowId":"@2","pane":"%2"}}]},
                {"name":"unknown","path":"/unknown","workshopId":"unknown","parentWorkshopId":"parent","target":{"type":"session","session":"unknown"},"details":[{"kind":"clanker","state":"unknown","target":{"type":"window","session":"unknown","windowId":"@3","pane":"%3"}}]}
            ]"#,
        );
        assert_eq!(
            app.rows
                .iter()
                .filter(|row| row.detail.is_none())
                .map(|row| row.session.name.as_str())
                .collect::<Vec<_>>(),
            vec!["unknown", "parent", "neutral"]
        );
        let parent = app.rows.iter().find(|row| row.session.name == "parent").unwrap();
        assert_eq!(row_glyph(parent, "", 0), ("·", Color::LightMagenta));
    }

    fn app_with_sessions(json: &str) -> App {
        App::from_snapshot(
            PathBuf::from("/nonexistent/state.json"),
            String::new(),
            Snapshot {
                version: CACHE_VERSION,
                sessions: serde_json::from_str(json).unwrap(),
            },
        )
        .unwrap()
    }

    fn apply_mutation_result(
        app: &mut App,
        result: Result<serde_json::Value, String>,
    ) -> Option<AppCommand> {
        app.mutation.get_or_insert(PendingMutation {
            progress: String::new(),
            submitted: true,
            exit_after_submit: None,
        });
        apply_mutation_update(app, MutationUpdate::Finished(result))
    }

    fn alt(character: char) -> KeyEvent {
        KeyEvent::new(KeyCode::Char(character), KeyModifiers::ALT)
    }

    /// Shared with src/needs-me.test.ts, so `clankers needs-me` lists in this picker's order.
    const NEEDS_ME_ORDER: &str = include_str!("../../src/fixtures/needs-me-order.json");
    fn needs_me_fixture() -> serde_json::Value {
        serde_json::from_str(NEEDS_ME_ORDER).unwrap()
    }
    fn needs_me_fixture_sessions() -> Vec<SessionRow> {
        serde_json::from_value(needs_me_fixture()["sessions"].clone()).unwrap()
    }
    fn needs_me_fixture_names(view: &str) -> Vec<String> {
        serde_json::from_value(needs_me_fixture()[view].clone()).unwrap()
    }

    #[test]
    fn needs_me_lists_the_freshest_first_and_the_eldest_view_reverses_it() {
        let sessions = needs_me_fixture_sessions();
        let names = |query: &str, eldest: bool| needs_me_sessions(&sessions, query, eldest).iter().map(|session| session.name.clone()).collect::<Vec<_>>();
        // One row per Workshop (its most pressing reason: crashed, not its twin's ready); working and sessionless
        // rows are not listed. Age alone orders them, whatever the reason; of the two as old as each other, the
        // label comes before the reason this picker does not know. Snoozed and waiting-on rows come last.
        let freshest = needs_me_fixture_names("freshest");
        assert_eq!(names("", false), freshest);
        assert_eq!(names("", true), needs_me_fixture_names("eldest"));
        // Typing filters without reordering.
        assert_eq!(names("e", false), freshest.iter().filter(|name| name.contains('e')).cloned().collect::<Vec<_>>());
        assert_eq!(names("late", true), ["asked late"]);
        let counts = &needs_me_fixture()["counts"];
        assert_eq!(needs_me_counts(&sessions), (counts["needsMe"].as_u64().unwrap() as usize, counts["open"].as_u64().unwrap() as usize));
    }

    #[test]
    fn needs_me_says_why_and_for_how_long() {
        let reason = |json: &str| serde_json::from_str::<NeedsMe>(json).unwrap();
        let now = 10.0 * 86_400_000.0;
        let at = |ago: f64| format!("{}", now - ago);
        assert_eq!(needs_me_status(&reason(&format!(r#"{{"reason":"asked","since":{}}}"#, at(720_000.0))), now), "asked 12m ago");
        assert_eq!(needs_me_status(&reason(&format!(r#"{{"reason":"blocked","since":{},"detail":"permission prompt"}}"#, at(3_600_000.0))), now), "blocked 1h · permission prompt");
        assert_eq!(needs_me_status(&reason(&format!(r#"{{"reason":"finished","since":{}}}"#, at(3.0 * 3_600_000.0))), now), "finished 3h ago, not seen");
        assert_eq!(needs_me_status(&reason(&format!(r#"{{"reason":"crashed","since":{},"detail":"interrupted"}}"#, at(2.0 * 86_400_000.0))), now), "interrupted 2d ago");
        assert_eq!(needs_me_status(&reason(&format!(r#"{{"reason":"your-move","since":{},"detail":"needs-input"}}"#, at(5.0 * 3_600_000.0))), now), "needs-input 5h");
        assert_eq!(needs_me_status(&reason(&format!(r#"{{"reason":"ready","since":{},"detail":"clean"}}"#, at(6.0 * 86_400_000.0))), now), "clean, idle 6d · ready to close");
        assert_eq!(needs_me_status(&reason(&format!(r#"{{"reason":"stale","since":{}}}"#, at(9.0 * 86_400_000.0))), now), "no activity 9d");
    }

    #[test]
    fn alt_i_alt_e_and_alt_f_switch_the_view_of_the_one_list() {
        let mut app = app_with_sessions(&needs_me_fixture()["sessions"].to_string());
        let everything = app.rows.len();
        let names = |app: &App| app.rows.iter().map(|row| row.session.name.clone()).collect::<Vec<_>>();
        assert_eq!(handle_key(&mut app, alt('i')), None);
        assert_eq!(app.view, View::NeedsMe);
        assert_eq!(names(&app), needs_me_fixture_names("freshest"));
        assert!(app.rows.iter().all(|row| row.depth == 0 && row.detail.is_none()));

        // Alt-E: the same rows, the longest waiting first, starting at the first row; the query carries over.
        app.selected = 3;
        assert_eq!(handle_key(&mut app, alt('e')), None);
        assert_eq!((app.view, app.selected), (View::Eldest, 0));
        assert_eq!(names(&app), needs_me_fixture_names("eldest"));
        for character in "late".chars() {
            handle_key(&mut app, KeyEvent::new(KeyCode::Char(character), KeyModifiers::NONE));
        }
        assert_eq!(names(&app), ["asked late"]);
        assert_eq!(handle_key(&mut app, alt('i')), None);
        assert_eq!((app.query.as_str(), names(&app)), ("late", vec!["asked late".to_string()]));
        // Alt-F: everything again, on the Workshop that was selected, the query still filtering.
        assert_eq!(handle_key(&mut app, alt('f')), None);
        assert_eq!((app.mode, app.view, app.query.as_str()), (Mode::Jump, View::Flat, "late"));
        assert_eq!(app.selected().map(|row| row.session.name.as_str()), Some("asked late"));
        app.update_query(String::new());
        assert_eq!(app.rows.len(), everything);
        // Plain letters are always the query, never a view switch.
        for character in ['i', 'e', 'f'] {
            handle_key(&mut app, KeyEvent::new(KeyCode::Char(character), KeyModifiers::NONE));
        }
        assert_eq!((app.view, app.query.as_str()), (View::Flat, "ief"));
        app.update_query(String::new());
        assert_eq!(handle_key(&mut app, alt('e')), None);
        assert_eq!(app.selected().map(|row| row.session.name.as_str()), Some("labelled"));
        assert_eq!(handle_key(&mut app, alt('i')), None);

        // Enter lands on the clanker that needs attention.
        app.selected = app.rows.iter().position(|row| row.session.name == "blocked early").unwrap();
        assert_eq!(
            handle_key(&mut app, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            Some(AppCommand::Submit(MutationIntent::Open {
                target: Target::Window { session: "early".into(), window_id: "@4".into(), pane: "%4".into(), management: None, resource_id: None, location: None },
            }))
        );
        // Alt-D on a row marks it Done, as on an Alt-K row.
        assert_eq!(handle_key(&mut app, alt('d')), Some(AppCommand::Submit(MutationIntent::Done { path: "/early".into() })));
        app.clear_action_mode();

        // A snapshot refresh keeps the view, and an empty list says caught up rather than vanishing.
        app.apply_snapshot(Snapshot { version: CACHE_VERSION, sessions: serde_json::from_str("[]").unwrap() }, false).unwrap();
        assert!(app.view == View::NeedsMe && app.rows.is_empty());

        app.apply_snapshot(Snapshot { version: CACHE_VERSION, sessions: needs_me_fixture_sessions() }, false).unwrap();
        // Alt-K in a needs-me view is Alt-F; in the flat list it is the branch flow.
        assert_eq!(handle_key(&mut app, alt('k')), None);
        assert_eq!((app.mode, app.view, app.rows.len()), (Mode::Jump, View::Flat, everything));
        assert_eq!(handle_key(&mut app, alt('k')), None);
        assert_eq!((app.mode, app.view), (Mode::Repository, View::Flat));

        // The views from the repository step too; Alt-B from a view leaves it.
        for (key, view) in [('i', View::NeedsMe), ('e', View::Eldest), ('f', View::Flat)] {
            app.enter_repository_mode();
            app.query = "typed".into();
            assert_eq!(handle_key(&mut app, alt(key)), None);
            assert_eq!((app.mode, app.view, app.query.as_str()), (Mode::Jump, view, ""));
        }
        assert_eq!(handle_key(&mut app, alt('e')), None);
        assert_eq!(handle_key(&mut app, alt('b')), None);
        assert_eq!((app.mode, app.view), (Mode::Repository, View::Flat));
    }

    #[test]
    fn alt_s_snoozes_and_waiting_rows_go_last() {
        let mut app = app_with_sessions(r#"[
            {"name":"snoozed","path":"/snoozed","workshopId":"w1","target":{"type":"session","session":"snoozed"},"needsMe":{"reason":"asked","since":1000,"snoozedUntil":9000}},
            {"name":"waiting","path":"/waiting","workshopId":"w2","target":{"type":"session","session":"waiting"},"needsMe":{"reason":"asked","since":2000,"waitingOn":"pr one"}},
            {"name":"stale","path":"/stale","workshopId":"w3","target":{"type":"session","session":"stale"},"needsMe":{"reason":"stale","since":3000}},
            {"name":"asked","path":"/asked","workshopId":"w4","target":{"type":"session","session":"asked"},"needsMe":{"reason":"asked","since":4000}}
        ]"#);
        // Snoozed and waiting rows do not count as needing you, and come last in both sorted views.
        assert_eq!(needs_me_counts(&app.sessions), (2, 4));
        assert_eq!(handle_key(&mut app, alt('e')), None);
        assert_eq!(app.rows.iter().map(|row| row.session.name.as_str()).collect::<Vec<_>>(), ["stale", "asked", "snoozed", "waiting"]);
        assert_eq!(handle_key(&mut app, alt('i')), None);
        let names = app.rows.iter().map(|row| row.session.name.as_str()).collect::<Vec<_>>();
        assert_eq!(names, ["asked", "stale", "waiting", "snoozed"]);
        let status = |name: &str| needs_me_status(app.rows.iter().find(|row| row.session.name == name).unwrap().session.needs_me.as_ref().unwrap(), 4000.0);
        assert_eq!(status("waiting"), "waiting on pr one · asked 2s ago");
        assert_eq!(status("snoozed"), "snoozed · asked 3s ago");

        app.selected = app.rows.iter().position(|row| row.session.name == "asked").unwrap();
        let Some(AppCommand::Submit(MutationIntent::Label { path, key, value: Some(value) })) = handle_key(&mut app, alt('s')) else {
            panic!("Alt-S snoozes the row");
        };
        assert_eq!((path.as_str(), key.as_str()), ("/asked", "_snooze"));
        assert!(value.starts_with("asked:4000:"), "{value}");
        // Again on a snoozed row takes the snooze back.
        app.selected = app.rows.iter().position(|row| row.session.name == "snoozed").unwrap();
        assert_eq!(
            handle_key(&mut app, alt('s')),
            Some(AppCommand::Submit(MutationIntent::Label { path: "/snoozed".into(), key: "_snooze".into(), value: None }))
        );

        // The flat list snoozes too and says what keeps a row down; a row that does not need you has no snooze.
        assert_eq!(handle_key(&mut app, alt('f')), None);
        assert_eq!(app.selected().map(|row| row.session.name.as_str()), Some("snoozed"));
        assert_eq!(
            handle_key(&mut app, alt('s')),
            Some(AppCommand::Submit(MutationIntent::Label { path: "/snoozed".into(), key: "_snooze".into(), value: None }))
        );
        let reason = |name: &str| app.sessions.iter().find(|session| session.name == name).unwrap().needs_me.clone().unwrap();
        assert_eq!((deferred_status(&reason("snoozed")), deferred_status(&reason("waiting")), deferred_status(&reason("asked"))), ("snoozed".into(), "waiting on pr one".into(), String::new()));
        let mut app = app_with_sessions(r#"[{"name":"working","path":"/working","workshopId":"w0","target":{"type":"session","session":"working"}}]"#);
        assert_eq!(handle_key(&mut app, alt('s')), None);
        assert_eq!(app.error, "Nothing to snooze: this row does not need you");
    }

    #[test]
    fn every_view_draws_its_name_the_other_views_keys_and_the_need_you_count() {
        let mut app = app_with_sessions(r#"[
            {"name":"snoozed","path":"/snoozed","workshopId":"w1","target":{"type":"session","session":"snoozed"},"needsMe":{"reason":"asked","since":1000,"snoozedUntil":9000}},
            {"name":"waiting","path":"/waiting","workshopId":"w2","target":{"type":"session","session":"waiting"},"needsMe":{"reason":"asked","since":2000,"waitingOn":"pr one"}},
            {"name":"asked","path":"/asked","workshopId":"w4","target":{"type":"session","session":"asked"},"needsMe":{"reason":"asked","since":4000}}
        ]"#);
        let text = |app: &mut App| {
            let buffer = rendered_view(app);
            buffer.content().chunks(100).map(|row| row.iter().map(|cell| cell.symbol()).collect::<String>()).collect::<Vec<_>>().join("\n")
        };
        let flat = text(&mut app);
        for expected in ["Clankerhouse · Flat", "Alt-I needs me · Alt-E eldest", "3 targets · 1 need you · 3 open", "waiting on pr one"] {
            assert!(flat.contains(expected), "{expected}\n{flat}");
        }
        // The snoozed row says so beside its name.
        assert!(flat.lines().any(|line| line.matches("snoozed").count() == 2), "{flat}");
        handle_key(&mut app, alt('i'));
        let needs_me = text(&mut app);
        for expected in ["Clankerhouse · Needs me", "freshest first · Alt-E eldest · Alt-F flat · Alt-S snooze", "1 need you · 3 open", "waiting on pr one · asked"] {
            assert!(needs_me.contains(expected), "{expected}\n{needs_me}");
        }
        handle_key(&mut app, alt('e'));
        let eldest = text(&mut app);
        for expected in ["Clankerhouse · Waiting longest", "eldest first · Alt-I freshest · Alt-F flat", "1 need you · 3 open"] {
            assert!(eldest.contains(expected), "{expected}\n{eldest}");
        }
    }

    #[test]
    fn alt_n_creates_a_scratch_workshop_in_the_chosen_repository() {
        let mut app = app_with_sessions("[]");
        app.repositories = vec![repository_row("repo", "/repo", "/repo/.git")];
        assert_eq!(handle_key(&mut app, alt('n')), None);
        assert_eq!((app.mode, app.scratch), (Mode::Repository, true));
        assert_eq!(
            handle_key(&mut app, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            Some(AppCommand::Scratch { repository: "/repo".into() })
        );

        // Alt-K or Alt-B back to the ordinary repository step leaves scratch mode.
        assert_eq!(handle_key(&mut app, alt('k')), None);
        assert_eq!((app.mode, app.scratch), (Mode::Repository, false));
        app.enter_scratch_mode();
        assert_eq!(handle_key(&mut app, alt('b')), None);
        assert_eq!((app.mode, app.scratch), (Mode::Repository, false));
    }

    #[test]
    fn a_scratch_spawn_opens_its_harness_window() {
        assert_eq!(
            scratch_target(r#"{"session":"scratch 11-03 09:04","window":"t9","pane":"t9","clankerId":"c"}"#),
            Ok(Target::Window { session: "scratch 11-03 09:04".into(), window_id: "t9".into(), pane: "t9".into(), management: None, resource_id: None, location: None })
        );
        assert!(scratch_target("not json").is_err());
        assert!(scratch_target(r#"{"window":"t9"}"#).is_err());
    }

    #[test]
    fn rename_mode_constructs_a_typed_intent_with_stable_resource_id() {
        let mut app = app_with_sessions(
            r#"[{"name":"display","path":"/repo","resourceId":"resource-1","availableActions":["open","rename"],"target":{"type":"session","session":"native-name","resourceId":"resource-1"}}]"#,
        );

        assert_eq!(handle_key(&mut app, alt('r')), None);
        assert_eq!(app.mode, Mode::Rename);
        app.rename_name = "  renamed  ".into();
        assert_eq!(
            handle_key(&mut app, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            Some(AppCommand::Submit(MutationIntent::Rename {
                session: "native-name".into(),
                resource_id: Some("resource-1".into()),
                display_name: "renamed".into(),
            }))
        );
        assert_eq!(app.mode, Mode::Jump);
    }

    #[test]
    fn attach_and_detach_use_projected_actions_and_stable_workshop_ids() {
        let mut app = app_with_sessions(
            r#"[
                {"name":"parent","path":"/parent","workshopId":"parent-id","availableActions":["open","attach"],"target":{"type":"session","session":"parent-native"}},
                {"name":"source","path":"/source","workshopId":"source-id","parentWorkshopId":"parent-id","attachmentCandidateWorkshopIds":["candidate-id"],"availableActions":["open","attach","detach"],"target":{"type":"session","session":"source-native"}},
                {"name":"child","path":"/child","workshopId":"child-id","parentWorkshopId":"source-id","availableActions":["open","attach"],"target":{"type":"session","session":"child-native"}},
                {"name":"candidate","path":"/candidate","workshopId":"candidate-id","availableActions":["open","attach"],"target":{"type":"session","session":"candidate-native"}},
                {"name":"outsider","path":"/outsider","workshopId":"outsider-id","availableActions":["open","attach"],"target":{"type":"session","session":"outsider-native"}}
            ]"#,
        );
        assert!(app.repository_identities.is_empty());
        app.selected = app
            .rows
            .iter()
            .position(|row| row.session.workshop_id.as_deref() == Some("source-id"))
            .unwrap();

        assert_eq!(handle_key(&mut app, alt('a')), None);
        assert_eq!(app.mode, Mode::Attach);
        assert_eq!(
            app.attach_candidates
                .iter()
                .filter_map(|row| row.workshop_id.as_deref())
                .collect::<Vec<_>>(),
            vec!["candidate-id"]
        );
        assert_eq!(
            handle_key(&mut app, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            Some(AppCommand::Submit(MutationIntent::Attach {
                workshop_id: "source-id".into(),
                parent_workshop_id: "candidate-id".into(),
                session: Some("source-native".into()),
            }))
        );

        app.selected = app
            .rows
            .iter()
            .position(|row| row.session.workshop_id.as_deref() == Some("source-id"))
            .unwrap();
        assert_eq!(
            handle_key(&mut app, alt('l')),
            Some(AppCommand::Submit(MutationIntent::Detach {
                workshop_id: "source-id".into(),
                session: Some("source-native".into()),
            }))
        );

    }

    #[test]
    fn sessionless_workshop_uses_projected_attachment_candidates() {
        let mut app = app_with_sessions(
            r#"[
                {"name":"/repo/source","path":"/repo/source","workshopId":"source-id","attachmentCandidateWorkshopIds":["candidate-id"],"availableActions":["open","create","attach"],"target":{"type":"directory","path":"/repo/source"}},
                {"name":"/repo/candidate","path":"/repo/candidate","workshopId":"candidate-id","availableActions":["open","create"],"target":{"type":"directory","path":"/repo/candidate"}}
            ]"#,
        );
        assert!(app.repository_identities.is_empty());
        app.selected = app
            .rows
            .iter()
            .position(|row| row.session.workshop_id.as_deref() == Some("source-id"))
            .unwrap();

        assert_eq!(handle_key(&mut app, alt('a')), None);
        assert_eq!(app.mode, Mode::Attach);
        assert_eq!(
            handle_key(&mut app, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            Some(AppCommand::Submit(MutationIntent::Attach {
                workshop_id: "source-id".into(),
                parent_workshop_id: "candidate-id".into(),
                session: None,
            }))
        );
    }

    #[test]
    fn delete_requires_confirmation_and_preserves_exact_selected_scope() {
        let mut app = app_with_sessions(
            r#"[{"name":"display","path":"/repo","availableActions":["open","delete"],"target":{"type":"session","session":"native-session"},"details":[{"kind":"clanker","title":"worker","state":"idle","target":{"type":"window","session":"native-session","windowId":"@2","pane":"%7"}}]}]"#,
        );
        app.expanded_details.insert("display".into());
        app.rebuild(None);
        app.selected = app
            .rows
            .iter()
            .position(|row| row.detail.is_some())
            .unwrap();

        assert_eq!(handle_key(&mut app, alt('d')), None);
        assert_eq!(app.mode, Mode::DeleteConfirm);
        assert_eq!(
            handle_key(
                &mut app,
                KeyEvent::new(KeyCode::Char('y'), KeyModifiers::NONE)
            ),
            Some(AppCommand::Submit(MutationIntent::Delete {
                kind: DeleteKind::Pane,
                session: "native-session".into(),
                confirmed: true,
                pane: Some("%7".into()),
                path: None,
            }))
        );

        app.selected = app
            .rows
            .iter()
            .position(|row| row.detail.is_none())
            .unwrap();
        // A session row asks the daemon first; a path that is not a worktree keeps session scope.
        assert_eq!(
            handle_key(&mut app, alt('d')),
            Some(AppCommand::Submit(MutationIntent::Done { path: "/repo".into() }))
        );
        apply_mutation_result(&mut app, Ok(serde_json::json!({"handled": false, "worktree": false})));
        assert_eq!(app.delete_label, "Destroy exact session 'native-session'?");
        assert_eq!(
            handle_key(
                &mut app,
                KeyEvent::new(KeyCode::Char('y'), KeyModifiers::NONE)
            ),
            Some(AppCommand::Submit(MutationIntent::Delete {
                kind: DeleteKind::Session,
                session: "native-session".into(),
                confirmed: true,
                pane: None,
                path: None,
            }))
        );
    }

    #[test]
    fn a_linked_worktree_outside_the_projected_worktree_set_is_still_a_worktree() {
        // The projection only tags dev-root directories; the daemon's answer is authoritative.
        let mut app = app_with_sessions(
            r#"[{"name":"side","path":"/elsewhere/side","branch":"side","availableActions":["open","delete"],"target":{"type":"session","session":"native-session"}}]"#,
        );

        assert_eq!(
            handle_key(&mut app, alt('d')),
            Some(AppCommand::Submit(MutationIntent::Done { path: "/elsewhere/side".into() }))
        );
        apply_mutation_result(&mut app, Ok(serde_json::json!({"handled": true, "worktree": true})));
        assert_eq!(app.mode, Mode::Jump);
        assert_eq!(app.delete_intent, None);

        assert!(handle_key(&mut app, alt('d')).is_some());
        apply_mutation_result(&mut app, Ok(serde_json::json!({"handled": false, "worktree": true})));
        assert_eq!(app.mode, Mode::DeleteConfirm);
        assert_eq!(app.delete_label, "Destroy worktree 'side'?");
        assert_eq!(
            handle_key(
                &mut app,
                KeyEvent::new(KeyCode::Char('y'), KeyModifiers::NONE)
            ),
            Some(AppCommand::Submit(MutationIntent::Delete {
                kind: DeleteKind::Worktree,
                session: "native-session".into(),
                confirmed: true,
                pane: None,
                path: Some("/elsewhere/side".into()),
            }))
        );
    }

    #[test]
    fn delete_treats_a_live_worktree_session_as_worktree_scope() {
        let mut app = app_with_sessions(
            r#"[{"name":"feature","path":"/repo/feature","branch":"feature","directorySource":"worktree","availableActions":["open","delete"],"target":{"type":"session","session":"native-session"}}]"#,
        );

        assert_eq!(
            handle_key(&mut app, alt('d')),
            Some(AppCommand::Submit(MutationIntent::Done {
                path: "/repo/feature".into(),
            }))
        );
        assert_eq!(app.mode, Mode::Jump);
        apply_mutation_result(&mut app, Ok(serde_json::json!({"handled": false})));
        assert_eq!(app.mode, Mode::DeleteConfirm);
        assert_eq!(app.delete_label, "Destroy worktree 'feature'?");
        assert_eq!(
            handle_key(
                &mut app,
                KeyEvent::new(KeyCode::Char('y'), KeyModifiers::NONE)
            ),
            Some(AppCommand::Submit(MutationIntent::Delete {
                kind: DeleteKind::Worktree,
                session: "native-session".into(),
                confirmed: true,
                pane: None,
                path: Some("/repo/feature".into()),
            }))
        );
    }

    fn deletion_fixture() -> App {
        app_with_sessions(r#"[
            {"name":"feature","path":"/repo/feature","branch":"feature","directorySource":"worktree","availableActions":["open","delete"],"target":{"type":"session","session":"native-feature","location":{"kind":"herdr","instanceId":"herdr:/qa.sock","nativeSessionId":"w1"}}},
            {"name":"survivor","path":"/repo/survivor","availableActions":["open","delete"],"target":{"type":"session","session":"native-survivor","location":{"kind":"herdr","instanceId":"herdr:/qa.sock","nativeSessionId":"w2"}}}
        ]"#)
    }

    fn confirm_fixture_delete(app: &mut App) -> AppCommand {
        app.selected = app.rows.iter().position(|row| row.session.name == "feature").unwrap();
        let done = handle_key(app, alt('d')).unwrap();
        decline_done(app, done);
        handle_key(app, KeyEvent::new(KeyCode::Char('y'), KeyModifiers::NONE)).unwrap()
    }

    // The done key was offered and nothing handled it, which is how a Workshop
    // that is already done reaches its destroy confirmation.
    fn decline_done(app: &mut App, done: AppCommand) {
        assert!(matches!(
            dispatch_command(app, done),
            CommandDispatch::Background(MutationIntent::Done { .. })
        ));
        assert_eq!(
            apply_mutation_update(
                app,
                MutationUpdate::Finished(Ok(serde_json::json!({"handled": false})))
            ),
            None
        );
        assert_eq!(app.mode, Mode::DeleteConfirm);
    }

    #[test]
    fn background_deletion_allows_search_navigation_and_open_after_acceptance() {
        let mut app = deletion_fixture();
        let command = confirm_fixture_delete(&mut app);
        assert!(matches!(dispatch_command(&mut app, command), CommandDispatch::Background(_)));
        assert_eq!(app.mode, Mode::Jump);
        for character in "survivor".chars() {
            handle_key(&mut app, KeyEvent::new(KeyCode::Char(character), KeyModifiers::NONE));
        }
        assert_eq!(app.selected().unwrap().session.name, "survivor");
        assert_eq!(apply_mutation_update(&mut app, MutationUpdate::Submitted), None);
        let command = handle_key(&mut app, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)).unwrap();
        assert!(matches!(dispatch_command(&mut app, command), CommandDispatch::Exit(AppCommand::Submit(MutationIntent::Open { .. }))));
        assert!(app.mutation.is_some(), "jump must not wait for deletion completion");
    }

    #[test]
    fn exit_waits_only_for_durable_submission_not_deletion_completion() {
        for command in [AppCommand::Close, AppCommand::Submit(MutationIntent::Open {
            target: Target::Directory { path: "/repo/survivor".into() },
        })] {
            let mut app = deletion_fixture();
            let delete = confirm_fixture_delete(&mut app);
            assert!(matches!(dispatch_command(&mut app, delete), CommandDispatch::Background(_)));
            assert_eq!(dispatch_command(&mut app, command.clone()), CommandDispatch::Continue);
            assert_eq!(apply_mutation_update(&mut app, MutationUpdate::Submitted), Some(command));
            assert!(app.mutation.is_some());
        }
    }

    #[test]
    fn background_deletion_preserves_selection_and_reports_failures() {
        let mut app = deletion_fixture();
        let command = confirm_fixture_delete(&mut app);
        dispatch_command(&mut app, command.clone());
        assert_eq!(dispatch_command(&mut app, command), CommandDispatch::Continue);
        assert!(app.error.contains("already running"));
        app.update_query("survivor".into());
        let key = app.selected().unwrap().key.clone();
        assert_eq!(dispatch_command(&mut app, AppCommand::Close), CommandDispatch::Continue);
        assert_eq!(apply_mutation_update(&mut app, MutationUpdate::Finished(Err("submission failed".into()))), None);
        assert!(app.mutation.is_none());
        assert_eq!(app.error, "submission failed");
        assert_eq!(app.selected().unwrap().key, key);
    }

    #[test]
    fn external_confirmation_pins_current_workspace_instead_of_selected_row() {
        let mut app = deletion_fixture();
        app.current_session = "w1".into();
        app.selected = app.rows.iter().position(|row| row.session.name == "survivor").unwrap();
        app.confirm_current_deletion().unwrap();
        let done = handle_external_requests(&mut app).unwrap();
        assert_eq!(done, AppCommand::Submit(MutationIntent::Done { path: "/repo/feature".into() }));
        decline_done(&mut app, done);
        assert_eq!(app.delete_label, "Destroy worktree 'feature'?");
        assert_eq!(handle_key(&mut app, KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)), Some(AppCommand::Close));
    }

    #[test]
    fn external_confirmation_refuses_missing_or_unknown_context() {
        for current in ["", "w-missing"] {
            let mut app = deletion_fixture();
            app.current_session = current.into();
            assert!(app.confirm_current_deletion().is_err());
            assert!(app.delete_intent.is_none());
        }
    }

    #[test]
    fn external_confirmation_rejects_name_aliases_and_ambiguous_native_ids() {
        let mut app = deletion_fixture();
        app.current_session = "native-feature".into();
        assert!(app.confirm_current_deletion().is_err(), "a native label is not the invoking workspace ID");
        app.current_session = "w1".into();
        let duplicate = app.rows.iter().find(|row| row.session.name == "feature").unwrap().clone();
        app.rows.push(duplicate);
        assert!(app.confirm_current_deletion().is_err());
    }

    #[test]
    fn external_confirmation_only_submits_after_yes_and_closes_after_completion() {
        let mut app = deletion_fixture();
        app.current_session = "w1".into();
        app.confirm_current_deletion().unwrap();
        let done = handle_external_requests(&mut app).unwrap();
        decline_done(&mut app, done);
        assert_eq!(handle_key(&mut app, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)), None);
        assert!(app.mutation.is_none());
        let command = handle_key(&mut app, KeyEvent::new(KeyCode::Char('y'), KeyModifiers::NONE)).unwrap();
        assert!(matches!(dispatch_command(&mut app, command), CommandDispatch::Background(MutationIntent::Delete { .. })));
        assert_eq!(apply_mutation_update(&mut app, MutationUpdate::Submitted), None);
        assert_eq!(apply_mutation_update(&mut app, MutationUpdate::Finished(Ok(serde_json::Value::Null))), Some(AppCommand::Close));
    }

    #[test]
    fn external_done_marks_the_current_workshop_and_closes_without_confirmation() {
        let mut app = deletion_fixture();
        app.current_session = "w1".into();
        app.confirm_current_deletion().unwrap();
        assert_eq!(app.mode, Mode::Jump);
        let done = handle_external_requests(&mut app).unwrap();
        assert!(matches!(dispatch_command(&mut app, done), CommandDispatch::Background(MutationIntent::Done { .. })));
        assert_eq!(
            apply_mutation_update(&mut app, MutationUpdate::Finished(Ok(serde_json::json!({"handled": true})))),
            Some(AppCommand::Close)
        );
        assert_eq!(app.delete_intent, None);
    }

    #[test]
    fn escape_prefixed_d_is_treated_as_alt_d() {
        let (key, pending) = coalesce_escape_prefix(
            KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE),
            KeyEvent::new(KeyCode::Char('d'), KeyModifiers::NONE),
        );
        assert_eq!(key, KeyEvent::new(KeyCode::Char('d'), KeyModifiers::ALT));
        assert!(pending.is_none());

        let second = KeyEvent::new(KeyCode::Char('x'), KeyModifiers::NONE);
        let (key, pending) = coalesce_escape_prefix(
            KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE),
            second,
        );
        assert_eq!(key.code, KeyCode::Esc);
        assert_eq!(pending, Some(second));
    }

    #[test]
    fn observation_keys_include_the_evidence_source() {
        let app = app_with_sessions(
            r#"[{"name":"observed","path":"/repo","target":{"type":"session","session":"observed"},"details":[{"kind":"observation","title":"pi","state":"unknown","target":{"type":"window","session":"observed","windowId":"@1","pane":"%1"},"observation":{"source":"process","confidence":"observed","state":"present"}},{"kind":"observation","title":"report","state":"unknown","target":{"type":"window","session":"observed","windowId":"@1","pane":"%1"},"observation":{"source":"lifecycle","confidence":"rejected","state":"working"}}]}]"#,
        );
        let keys = app
            .sessions[0]
            .details
            .iter()
            .map(detail_key)
            .collect::<HashSet<_>>();
        assert_eq!(keys.len(), 2);
        assert!(keys.iter().any(|key| key.ends_with(":observation:process:observed")));
        assert!(keys.iter().any(|key| key.ends_with(":observation:lifecycle:rejected")));
    }

    #[test]
    fn external_delete_signal_uses_the_normal_confirmation_path() {
        let mut app = app_with_sessions(
            r#"[{"name":"feature","path":"/repo/feature","branch":"feature","directorySource":"worktree","availableActions":["open","delete"],"target":{"type":"session","session":"native-session"}}]"#,
        );

        DELETE_REQUESTED.store(true, Ordering::SeqCst);
        assert_eq!(
            handle_external_requests(&mut app),
            Some(AppCommand::Submit(MutationIntent::Done {
                path: "/repo/feature".into(),
            }))
        );
        apply_mutation_result(&mut app, Ok(serde_json::json!({"handled": false})));

        assert_eq!(app.mode, Mode::DeleteConfirm);
        assert_eq!(app.delete_label, "Destroy worktree 'feature'?");
    }

    #[test]
    fn done_hook_that_handles_alt_d_skips_the_destroy_confirmation() {
        let mut app = app_with_sessions(
            r#"[{"name":"feature","path":"/repo/feature","branch":"feature","labels":["retro"],"directorySource":"worktree","availableActions":["open","delete"],"target":{"type":"session","session":"native-session"}}]"#,
        );

        assert!(handle_key(&mut app, alt('d')).is_some());
        apply_mutation_result(&mut app, Ok(serde_json::json!({"handled": true})));

        assert_eq!(app.mode, Mode::Jump);
        assert_eq!(app.delete_intent, None);
        assert_eq!(app.rows[0].session.labels, vec!["retro".to_string()]);
        assert_eq!(
            serde_json::to_value(MutationIntent::Done { path: "/repo/feature".into() }).unwrap(),
            serde_json::json!({"type": "done", "path": "/repo/feature"})
        );
    }

    #[test]
    fn a_done_workshop_can_be_reopened_from_the_destroy_confirmation() {
        let mut app = app_with_sessions(
            r#"[{"name":"feature","path":"/repo/feature","branch":"feature","labels":["done"],"directorySource":"worktree","availableActions":["open","delete"],"target":{"type":"session","session":"native-session"}}]"#,
        );
        select_done_group(&mut app);
        handle_key(&mut app, KeyEvent::new(KeyCode::Right, KeyModifiers::NONE));
        app.selected = app.rows.iter().position(|row| row.session.name == "feature").unwrap();

        assert!(handle_key(&mut app, alt('d')).is_some());
        apply_mutation_result(&mut app, Ok(serde_json::json!({"handled": false})));
        assert_eq!(app.mode, Mode::DeleteConfirm);
        let reopen = handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('u'), KeyModifiers::NONE),
        );
        assert_eq!(
            reopen,
            Some(AppCommand::Submit(MutationIntent::Label {
                path: "/repo/feature".into(),
                key: "status".into(),
                value: None,
            }))
        );
        assert_eq!(app.mode, Mode::Jump);
        assert_eq!(app.delete_intent, None);
        let Some(AppCommand::Submit(intent)) = reopen else { unreachable!() };
        assert_eq!(
            serde_json::to_value(intent).unwrap(),
            serde_json::json!({"type": "label", "path": "/repo/feature", "key": "status", "value": null})
        );
    }

    #[test]
    fn done_hook_failure_reports_the_error_without_offering_destruction() {
        let mut app = app_with_sessions(
            r#"[{"name":"feature","path":"/repo/feature","branch":"feature","directorySource":"worktree","availableActions":["open","delete"],"target":{"type":"session","session":"native-session"}}]"#,
        );

        assert!(handle_key(&mut app, alt('d')).is_some());
        apply_mutation_result(&mut app, Err("Workshop done hook failed with exit 2".into()));

        assert_eq!(app.mode, Mode::Jump);
        assert_eq!(app.delete_intent, None);
        assert_eq!(app.error, "Workshop done hook failed with exit 2");
    }

    #[test]
    fn delete_explains_when_selected_target_is_not_deletable() {
        let mut app = app_with_sessions(
            r#"[{"name":"sessionless","path":"/repo/sessionless","availableActions":["open","create"],"target":{"type":"directory","path":"/repo/sessionless"}}]"#,
        );

        assert_eq!(handle_key(&mut app, alt('d')), None);
        assert_eq!(app.mode, Mode::Jump);
        assert_eq!(
            app.error,
            "Nothing to delete: target has no live pane or session"
        );
    }

    #[test]
    fn delete_supports_projected_worktree_directories_without_live_sessions() {
        let mut app = app_with_sessions(
            r#"[{"name":"feature","path":"/repo/feature","branch":"feature","directorySource":"worktree","availableActions":["open","create"],"target":{"type":"directory","path":"/repo/feature"}}]"#,
        );

        assert!(handle_key(&mut app, alt('d')).is_some());
        apply_mutation_result(&mut app, Ok(serde_json::json!({"handled": false})));
        assert_eq!(app.mode, Mode::DeleteConfirm);
        assert_eq!(app.delete_label, "Destroy worktree 'feature'?");
        assert_eq!(
            handle_key(
                &mut app,
                KeyEvent::new(KeyCode::Char('y'), KeyModifiers::NONE)
            ),
            Some(AppCommand::Submit(MutationIntent::Delete {
                kind: DeleteKind::Worktree,
                session: "feature".into(),
                confirmed: true,
                pane: None,
                path: Some("/repo/feature".into()),
            }))
        );
    }

    #[test]
    fn projected_actions_gate_exact_open_and_destructive_keys() {
        let mut app = app_with_sessions(
            r#"[{"name":"blocked","path":"/repo","workshopId":"workshop-id","target":{"type":"session","session":"native-session"},"details":[{"kind":"window","title":"shell","state":"idle","target":{"type":"window","session":"native-session","windowId":"@9","pane":"%9"}}]}]"#,
        );
        assert_eq!(
            handle_key(&mut app, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            None
        );
        assert_eq!(handle_key(&mut app, alt('r')), None);
        assert_eq!(handle_key(&mut app, alt('a')), None);
        assert_eq!(handle_key(&mut app, alt('l')), None);
        assert_eq!(handle_key(&mut app, alt('d')), None);
        assert_eq!(app.mode, Mode::Jump);

        app.sessions[0].available_actions = vec![AvailableAction::Open];
        app.expanded_details.insert("blocked".into());
        app.rebuild(None);
        app.selected = app
            .rows
            .iter()
            .position(|row| row.detail.is_some())
            .unwrap();
        assert_eq!(
            handle_key(&mut app, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            Some(AppCommand::Submit(MutationIntent::Open {
                target: Target::Window {
                    session: "native-session".into(),
                    window_id: "@9".into(),
                    pane: "%9".into(),
                    management: None,
                    resource_id: None,
                    location: None,
                },
            }))
        );
    }

    #[test]
    fn branch_selection_constructs_daemon_create_intent() {
        let mut app = app_with_sessions("[]");
        app.mode = Mode::Branch;
        app.repository = Some(repository_row("repo", "/repo", "/repo/.git"));
        app.branches = vec![BranchRow {
            name: "origin/feature".into(),
            value: "feature".into(),
            kind: BranchKind::Local,
            path: String::new(),
            recency: 0,
        }];

        assert_eq!(
            handle_key(&mut app, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            Some(AppCommand::CreateAndOpen(MutationIntent::Create {
                repository: "/repo".into(),
                branch: "feature".into(),
                create: false,
                base: None,
                remote_ref: None,
                title: None,
            }))
        );

        app.branches[0].kind = BranchKind::Remote;
        assert_eq!(
            handle_key(&mut app, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            Some(AppCommand::CreateAndOpen(MutationIntent::Create {
                repository: "/repo".into(),
                branch: "feature".into(),
                create: false,
                base: None,
                remote_ref: Some("origin/feature".into()),
                title: None,
            }))
        );
    }

    #[test]
    fn a_new_workshop_is_named_by_title_and_its_branch_is_derived() {
        assert_eq!(branch_from_title("Migrate OpenCode adapter to v2").as_deref(), Some("migrate-opencode-adapter-to-v2"));
        assert_eq!(branch_from_title("fix/TWE-12_thing.v2").as_deref(), Some("fix/TWE-12_thing.v2"));
        assert_eq!(branch_from_title("  ¡¿  ").as_deref(), None);
        assert_eq!(
            branch_from_title("Rework the extraction pipeline so that retirement is durable across restarts").as_deref(),
            Some("rework-the-extraction-pipeline-so-that-retirement")
        );

        let mut app = app_with_sessions("[]");
        app.mode = Mode::Branch;
        app.repository = Some(repository_row("repo", "/repo", "/repo/.git"));
        app.branches = vec![BranchRow {
            name: "migrate-opencode-adapter".into(),
            value: "migrate-opencode-adapter".into(),
            kind: BranchKind::Local,
            path: String::new(),
            recency: 0,
        }];
        app.update_query("Migrate OpenCode adapter".into());
        app.selected = 0;
        assert_eq!(handle_key(&mut app, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)), None);
        assert_eq!(app.mode, Mode::NewBase);
        // The derived name is taken, so the new branch is suffixed rather than reusing it.
        assert_eq!(app.branch_name, "migrate-opencode-adapter-2");
        assert_eq!(
            handle_key(&mut app, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            Some(AppCommand::CreateAndOpen(MutationIntent::Create {
                repository: "/repo".into(),
                branch: "migrate-opencode-adapter-2".into(),
                create: true,
                base: Some("^".into()),
                remote_ref: None,
                title: Some("Migrate OpenCode adapter".into()),
            }))
        );
    }

    #[test]
    fn alt_r_edits_a_workshop_title_and_an_empty_title_clears_it() {
        let mut app = app_with_sessions(
            r#"[{"name":"repo@feature","path":"/repo/feature","branch":"feature","title":"Old title","workshopId":"w1","availableActions":["open","rename"],"target":{"type":"session","session":"native-session"}}]"#,
        );
        assert_eq!(handle_key(&mut app, alt('r')), None);
        assert_eq!(app.mode, Mode::Rename);
        assert_eq!(app.rename_name, "Old title");
        for _ in 0.."Old title".len() {
            handle_key(&mut app, KeyEvent::new(KeyCode::Backspace, KeyModifiers::NONE));
        }
        for character in "New title".chars() {
            handle_key(&mut app, KeyEvent::new(KeyCode::Char(character), KeyModifiers::NONE));
        }
        assert_eq!(
            handle_key(&mut app, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            Some(AppCommand::Submit(MutationIntent::Label {
                path: "/repo/feature".into(),
                key: "title".into(),
                value: Some("New title".into()),
            }))
        );

        assert_eq!(handle_key(&mut app, alt('r')), None);
        for _ in 0.."Old title".len() {
            handle_key(&mut app, KeyEvent::new(KeyCode::Backspace, KeyModifiers::NONE));
        }
        assert_eq!(
            handle_key(&mut app, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            Some(AppCommand::Submit(MutationIntent::Label {
                path: "/repo/feature".into(),
                key: "title".into(),
                value: None,
            }))
        );
    }

    #[test]
    fn the_list_shows_every_project_wherever_it_was_opened_from() {
        let mut app = app_with_sessions(r#"[
            {"name":"tweezr@feature","path":"/t/feature","project":"tweezr","target":{"type":"session","session":"tweezr@feature"}},
            {"name":"clankerhouse@retro","path":"/c/retro","project":"clankerhouse","target":{"type":"session","session":"clankerhouse@retro"}},
            {"name":"home","path":"/home/me","target":{"type":"session","session":"home"}}
        ]"#);
        app.current_session = "tweezr@feature".into();
        app.rebuild(None);
        assert_eq!(app.rows.iter().filter(|row| row.detail.is_none()).count(), 3);
        let style = |name: &str| row_name_style(app.rows.iter().find(|row| row.session.name == name).unwrap(), false, 0);
        assert_eq!(style("tweezr@feature").fg, Some(project_color("tweezr")));
        assert_eq!(style("home").fg, None);
        assert_eq!(dimmed(Color::Rgb(200, 100, 0), 75), Color::Rgb(150, 75, 0));
        assert_eq!(label_color("done"), DONE_GRAY);
        let root = app.rows.iter().find(|row| row.session.name == "tweezr@feature").unwrap();
        assert_eq!(root_project(root), Some("tweezr"));
        assert_eq!(name_without_project(&root.session), "feature");
        assert_eq!(root_project(&TreeRow { depth: 1, ..root.clone() }), None);
        assert_eq!(root_project(app.rows.iter().find(|row| row.session.name == "home").unwrap()), None);
        assert_eq!(label_color("retro"), label_color("retro"));
        assert!(LABEL_COLORS.contains(&label_color("retro")));
        // The project is searchable even when a title has replaced the "project@" name.
        let titled: SessionRow = serde_json::from_str(r#"{"name":"Fix login","title":"Fix login","path":"/t/x","branch":"fix-login","project":"tweezr","labels":["urgent"],"target":{"type":"session","session":"Fix login"}}"#).unwrap();
        for query in ["tweezr", "login", "fix-login", "urgent", "tweezr urgent"] {
            assert!(search_score(&titled, query).is_some(), "{query}");
        }
        assert!(search_score(&titled, "clankerhouse").is_none());
        for query in ["tweezr", "login", "fix-login", "urgent"] {
            assert!(session_direct_search_score(&titled, query).is_some(), "{query}");
        }
        assert_eq!(handle_key(&mut app, KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE)), None);
        assert_eq!(app.mode, Mode::Jump);
    }

    #[test]
    fn done_workshops_are_grayed_out_even_when_fresh_or_current() {
        let mut app = app_with_sessions(
            r#"[
                {"name":"finished","path":"/finished","recency":1000000,"labels":["done"],"target":{"type":"session","session":"finished"}},
                {"name":"active","path":"/active","recency":1000000,"target":{"type":"session","session":"active"}}
            ]"#,
        );
        handle_key(&mut app, alt('.'));
        let row = |name: &str| app.rows.iter().find(|row| row.session.name == name).unwrap();
        assert_eq!(row_name_style(row("finished"), false, 1_000_000), Style::default().fg(DONE_GRAY));
        assert_eq!(row_name_style(row("finished"), true, 1_000_000), Style::default().fg(DONE_GRAY));
        assert_eq!(row_name_style(row("active"), false, 1_000_000), Style::default());
    }

    const DONE_LINEAGE: &str = r#"[
        {"name":"main","path":"/main","recency":50,"workshopId":"main","target":{"type":"session","session":"main"}},
        {"name":"feat","path":"/feat","recency":40,"workshopId":"feat","parentWorkshopId":"main","target":{"type":"session","session":"feat"}},
        {"name":"old-a","path":"/old-a","recency":30,"labels":["done"],"workshopId":"old-a","parentWorkshopId":"main","target":{"type":"session","session":"old-a"}},
        {"name":"old-b","path":"/old-b","recency":20,"labels":["done"],"workshopId":"old-b","parentWorkshopId":"main","target":{"type":"session","session":"old-b"}},
        {"name":"old-b-child","path":"/old-b-child","recency":10,"labels":["done"],"workshopId":"old-b-child","parentWorkshopId":"old-b","target":{"type":"session","session":"old-b-child"}}
    ]"#;

    fn row_named<'a>(app: &'a App, name: &str) -> Option<&'a TreeRow> {
        app.rows.iter().find(|row| row.done_group.is_none() && row.detail.is_none() && row.session.name == name)
    }

    fn done_groups(app: &App) -> Vec<&TreeRow> {
        app.rows.iter().filter(|row| row.done_group.is_some()).collect()
    }

    fn select_done_group(app: &mut App) {
        app.selected = app.rows.iter().position(|row| row.done_group.is_some()).unwrap();
    }

    #[test]
    fn done_subtrees_fold_into_one_summary_row_under_their_parent() {
        let app = app_with_sessions(DONE_LINEAGE);

        for name in ["old-a", "old-b", "old-b-child"] {
            assert!(row_named(&app, name).is_none(), "{name} must be folded");
        }
        let groups = done_groups(&app);
        assert_eq!(groups.len(), 1);
        let group = groups[0];
        assert_eq!(group.done_group.as_ref().unwrap().count, 3);
        assert_eq!(group.depth, 1);
        // Rows render bottom-up: the summary sits just under its parent, above live siblings.
        let index = |key: &str| app.rows.iter().position(|row| row.key == key).unwrap();
        assert!(index(&group.key) < index(&row_named(&app, "main").unwrap().key));
        assert!(index(&group.key) > index(&row_named(&app, "feat").unwrap().key));
    }

    #[test]
    fn done_roots_fold_into_a_summary_above_every_other_root() {
        let app = app_with_sessions(
            r#"[
                {"name":"live","path":"/live","recency":10,"target":{"type":"session","session":"live"}},
                {"name":"old-a","path":"/old-a","recency":30,"labels":["done"],"target":{"type":"session","session":"old-a"}},
                {"name":"old-b","path":"/old-b","recency":20,"labels":["done"],"target":{"type":"session","session":"old-b"}}
            ]"#,
        );

        assert!(row_named(&app, "old-a").is_none());
        let group = done_groups(&app)[0];
        assert_eq!(group.done_group.as_ref().unwrap().count, 2);
        assert_eq!(group.depth, 0);
        assert_eq!(app.rows.last().unwrap().key, group.key);
    }

    #[test]
    fn a_done_workshop_stays_visible_while_anything_below_it_is_live() {
        let app = app_with_sessions(
            r#"[
                {"name":"old","path":"/old","labels":["done"],"workshopId":"old","target":{"type":"session","session":"old"}},
                {"name":"live-child","path":"/live-child","workshopId":"live-child","parentWorkshopId":"old","target":{"type":"session","session":"live-child"}}
            ]"#,
        );

        assert!(row_named(&app, "old").is_some());
        assert!(row_named(&app, "live-child").is_some());
        assert!(done_groups(&app).is_empty());
    }

    #[test]
    fn a_done_workshop_with_an_active_clanker_is_not_folded() {
        for state in ["working", "blocked", "failed"] {
            let app = app_with_sessions(&format!(
                r#"[{{"name":"old","path":"/old","labels":["done"],"target":{{"type":"session","session":"old"}},"details":[{{"kind":"clanker","state":"{state}","target":{{"type":"window","session":"old","windowId":"@1","pane":"%1"}}}}]}}]"#
            ));
            assert!(row_named(&app, "old").is_some(), "{state} clanker must stay visible");
        }
    }

    #[test]
    fn a_done_workshop_with_an_unseen_finished_clanker_still_folds() {
        let app = app_with_sessions(
            r#"[{"name":"old","path":"/old","labels":["done"],"target":{"type":"session","session":"old"},"details":[{"kind":"clanker","state":"done","target":{"type":"window","session":"old","windowId":"@1","pane":"%1"}}]}]"#,
        );

        assert!(row_named(&app, "old").is_none());
        assert_eq!(done_groups(&app)[0].done_group.as_ref().unwrap().count, 1);
    }

    #[test]
    fn the_current_workshop_is_never_folded() {
        let app = App::from_snapshot(
            PathBuf::from("/nonexistent/state.json"),
            "old-b-child".into(),
            Snapshot { version: CACHE_VERSION, sessions: serde_json::from_str(DONE_LINEAGE).unwrap() },
        )
        .unwrap();

        assert!(row_named(&app, "old-b").is_some());
        assert!(row_named(&app, "old-b-child").is_some());
        assert!(row_named(&app, "old-a").is_none());
        assert_eq!(done_groups(&app)[0].done_group.as_ref().unwrap().count, 1);
    }

    #[test]
    fn right_or_enter_expands_a_done_group_and_left_folds_it_again() {
        for open in [KeyCode::Right, KeyCode::Enter] {
            let mut app = app_with_sessions(DONE_LINEAGE);
            select_done_group(&mut app);

            assert_eq!(handle_key(&mut app, KeyEvent::new(open, KeyModifiers::NONE)), None);
            for name in ["old-a", "old-b"] {
                assert!(row_named(&app, name).is_some(), "{name} must be shown");
            }
            // The summary stays, now open, so Left can fold the group again.
            let group = app.selected().unwrap();
            assert!(group.done_group.as_ref().unwrap().expanded);

            handle_key(&mut app, KeyEvent::new(KeyCode::Left, KeyModifiers::NONE));
            assert!(row_named(&app, "old-a").is_none());
            assert!(app.selected().unwrap().done_group.is_some());
        }
    }

    #[test]
    fn a_done_group_renders_as_one_gray_row_beneath_its_parent() {
        let mut app = app_with_sessions(DONE_LINEAGE);
        select_done_group(&mut app);
        let buffer = rendered_view(&mut app);
        let lines = (0..buffer.area.height)
            .map(|y| (0..buffer.area.width).map(|x| buffer[(x, y)].symbol()).collect::<String>())
            .collect::<Vec<_>>();
        println!("{}", lines.join("\n"));

        let main = lines.iter().position(|line| line.contains(" main")).unwrap();
        assert!(lines[main + 1].contains("├─▸  ✓ 3 done"), "{}", lines[main + 1]);
        assert!(lines.iter().any(|line| line.contains("3 done Workshops folded · → show")));
        assert!(!lines.iter().any(|line| line.contains("old-a")));
        assert!(lines.iter().any(|line| line.contains("> _  2 targets")));
    }

    #[test]
    fn a_workshop_marked_done_hands_the_selection_to_the_group_that_absorbs_it() {
        let live = DONE_LINEAGE.replace(r#""name":"old-a","path":"/old-a","recency":30,"labels":["done"]"#, r#""name":"old-a","path":"/old-a","recency":30"#);
        let mut app = app_with_sessions(&live);
        app.selected = app.rows.iter().position(|row| row.session.name == "old-a").unwrap();

        app.apply_snapshot(Snapshot { version: CACHE_VERSION, sessions: serde_json::from_str(DONE_LINEAGE).unwrap() }, false).unwrap();

        let group = app.selected().unwrap().done_group.clone().unwrap();
        assert_eq!(group.parent.as_deref(), Some("main"));
        assert_eq!(group.count, 3);
    }

    #[test]
    fn search_reveals_done_workshops_without_a_summary() {
        let mut app = app_with_sessions(DONE_LINEAGE);
        app.update_query("old-b-child".into());

        assert!(row_named(&app, "old-b-child").is_some());
        assert!(done_groups(&app).is_empty());
    }

    #[test]
    fn alt_dot_shows_and_hides_every_done_workshop() {
        let mut app = app_with_sessions(DONE_LINEAGE);

        handle_key(&mut app, alt('.'));
        for name in ["old-a", "old-b", "old-b-child"] {
            assert!(row_named(&app, name).is_some(), "{name} must be shown");
        }
        assert!(done_groups(&app).is_empty());

        handle_key(&mut app, alt('.'));
        assert!(row_named(&app, "old-a").is_none());
        assert_eq!(done_groups(&app).len(), 1);
    }

    #[test]
    fn workshop_actions_never_apply_to_a_done_group() {
        for key in ['d', 'r', 'a', 'l'] {
            let mut app = app_with_sessions(DONE_LINEAGE);
            select_done_group(&mut app);
            assert_eq!(handle_key(&mut app, alt(key)), None, "Alt-{key}");
            assert_eq!(app.mode, Mode::Jump);
            assert!(app.delete_intent.is_none());
        }
    }

    #[test]
    fn rows_fade_with_age_but_never_reorder() {
        let now = 1_000_000;
        assert_eq!(fade_color(now - 3_600, now), None);
        assert!(fade_color(now - 2 * 86_400, now).is_some());
        assert_ne!(fade_color(now - 2 * 86_400, now), fade_color(now - 9 * 86_400, now));
        assert_eq!(fade_color(0, now), None);
    }

    #[test]
    fn ambiguous_workshop_ids_do_not_duplicate_child_targets() {
        let mut app = app_with_sessions(
            r#"[
                {"name":"legacy-parent","path":"/legacy","workshopId":"parent-id","target":{"type":"directory","path":"/legacy"}},
                {"name":"live-parent","path":"/live","workshopId":"parent-id","target":{"type":"session","session":"live-parent"}},
                {"name":"child","path":"/child","workshopId":"child-id","parentWorkshopId":"parent-id","availableActions":["open"],"target":{"type":"session","session":"child-native"}}
            ]"#,
        );

        let keys = app
            .rows
            .iter()
            .map(|row| row.key.as_str())
            .collect::<Vec<_>>();
        assert_eq!(keys.len(), 3);
        assert_eq!(
            keys.iter()
                .filter(|key| **key == "session:child-native")
                .count(),
            1
        );
        assert!(app.rows.iter().all(|row| row.depth == 0));

        app.selected = app
            .rows
            .iter()
            .position(|row| row.key == "session:child-native")
            .unwrap();
        assert_eq!(
            handle_key(&mut app, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            Some(AppCommand::Submit(MutationIntent::Open {
                target: Target::Session {
                    session: "child-native".into(),
                    management: None,
                    resource_id: None,
                    location: None,
                },
            }))
        );
    }

    #[test]
    fn runtime_root_defaults_to_the_herdr_instance() {
        let environment = HashMap::from([
            ("XDG_RUNTIME_DIR".to_string(), "/run/test".to_string()),
        ]);
        assert_eq!(
            runtime_root_from(&environment, 42).unwrap(),
            PathBuf::from("/run/test/clankerhouse-42-herdr")
        );

        let mut default_instance = environment.clone();
        default_instance.insert("CLANKERHOUSE_INSTANCE".into(), "default".into());
        assert_eq!(
            runtime_root_from(&default_instance, 42).unwrap(),
            PathBuf::from("/run/test/clankerhouse-42")
        );

        let mut explicit_instance = environment.clone();
        explicit_instance.insert("CLANKERHOUSE_INSTANCE".into(), "review".into());
        assert_eq!(
            runtime_root_from(&explicit_instance, 42).unwrap(),
            PathBuf::from("/run/test/clankerhouse-42-review")
        );
        explicit_instance.insert("CLANKERHOUSE_INSTANCE".into(), "../other".into());
        assert!(runtime_root_from(&explicit_instance, 42).is_err());
    }

    fn large_current_lineage_snapshot() -> Snapshot {
        let mut sessions = vec![
            serde_json::json!({"name":"root", "path":"/root", "workshopId":"root", "target":{"type":"session","session":"root"}}),
            serde_json::json!({"name":"branch", "path":"/branch", "workshopId":"branch", "parentWorkshopId":"root", "target":{"type":"session","session":"branch"}}),
            serde_json::json!({"name":"current", "path":"/current", "workshopId":"current", "parentWorkshopId":"branch", "target":{"type":"session","session":"native-current","resourceId":"current-id"}}),
            serde_json::json!({"name":"other-branch", "path":"/other-branch", "workshopId":"other-branch", "parentWorkshopId":"root", "target":{"type":"session","session":"other-branch"}}),
        ];
        for parent in ["current", "other-branch"] {
            for index in 0..12 {
                let name = format!("{parent}-child-{index}");
                sessions.push(serde_json::json!({"name":name, "path":format!("/{name}"), "parentWorkshopId":parent, "target":{"type":"session","session":name}}));
            }
        }
        serde_json::from_value(serde_json::json!({"version":CACHE_VERSION,"sessions":sessions})).unwrap()
    }

    #[test]
    fn current_workshop_is_visible_expanded_and_selected_in_large_lineages() {
        let mut app = App::from_snapshot(PathBuf::from("/nonexistent/state.json"), "native-current".into(), large_current_lineage_snapshot()).unwrap();
        assert_eq!(app.selected().unwrap().key, "session:current-id");
        assert_eq!(app.selected().unwrap().depth, 2);
        for name in ["root", "branch", "current"] {
            assert!(app.expanded_lineage.contains(name), "{name} must stay expanded");
            let row = app.rows.iter().position(|row| row.session.name == name).unwrap();
            app.selected = row;
            handle_key(&mut app, KeyEvent::new(KeyCode::Left, KeyModifiers::NONE));
            assert!(app.expanded_lineage.contains(name));
            assert!(app.rows.iter().any(|row| row.key == "session:current-id"));
        }
        assert!(!app.expanded_lineage.contains("other-branch"));
        assert!(!app.rows.iter().any(|row| row.session.name == "other-branch-child-0"));
        assert!(app.expanded_details.is_empty());
    }

    #[test]
    fn current_lineage_stays_open_after_refresh_and_search_without_stealing_selection() {
        let mut app = App::from_snapshot(PathBuf::from("/nonexistent/state.json"), "native-current".into(), large_current_lineage_snapshot()).unwrap();
        app.update_query("other-branch".into());
        app.update_query(String::new());
        assert_eq!(app.selected().unwrap().key, "session:current-id");
        let mut snapshot = large_current_lineage_snapshot();
        snapshot.sessions.iter_mut().find(|row| row.name == "branch").unwrap().name = "renamed-branch".into();
        app.apply_snapshot(snapshot, false).unwrap();
        assert!(app.expanded_lineage.contains("renamed-branch"));
        assert_eq!(app.selected().unwrap().key, "session:current-id");
        app.selected = app.rows.iter().position(|row| row.session.name == "other-branch").unwrap();
        let key = app.selected().unwrap().key.clone();
        app.apply_snapshot(large_current_lineage_snapshot(), false).unwrap();
        assert_eq!(app.selected().unwrap().key, key);
    }

    #[test]
    fn current_session_is_selected_and_sorted_first() {
        let root = env::temp_dir().join(format!(
            "clankerhouse-native-current-session-test-{}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("state.json"),
            r#"{"version":11,"sessions":[
                {"name":"working","path":"/working","target":{"type":"session","session":"working"},"details":[{"kind":"clanker","state":"working","target":{"type":"window","session":"working","windowId":"@1","pane":"%1"}}]},
                {"name":"current","path":"/current","target":{"type":"session","session":"current"},"details":[{"kind":"window","state":"unknown","target":{"type":"window","session":"current","windowId":"@2","pane":"%2"}}]}
            ]}"#,
        )
        .unwrap();

        let app = App::new(root.join("state.json"), "current".into()).unwrap();
        let roots = app
            .rows
            .iter()
            .filter(|row| row.depth == 0)
            .map(|row| row.session.name.as_str())
            .collect::<Vec<_>>();
        assert_eq!(roots, vec!["current", "working"]);
        assert_eq!(
            app.selected().map(|row| row.session.name.as_str()),
            Some("current")
        );
        assert_eq!(
            row_glyph(app.selected().unwrap(), "current", 0),
            ("○", Color::Rgb(148, 163, 184))
        );
        fs::remove_dir_all(root).unwrap();
    }
}
