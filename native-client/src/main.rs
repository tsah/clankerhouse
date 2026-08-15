use std::{
    collections::{HashMap, HashSet},
    env, fs,
    io::{self, BufRead, BufReader, Write},
    os::unix::net::UnixStream,
    path::{Path, PathBuf},
    process::Command,
    sync::mpsc::{self, Receiver, Sender},
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

const CACHE_VERSION: u64 = 10;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Target {
    TmuxSession {
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
    TmuxWindow {
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
    #[serde(default)]
    frecency: f64,
    #[serde(default, rename = "workshopId")]
    workshop_id: Option<String>,
    #[serde(default)]
    management: String,
    #[serde(default, rename = "availableActions")]
    available_actions: Vec<AvailableAction>,
    #[serde(default, rename = "parentWorkshopId")]
    parent_workshop_id: Option<String>,
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

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum DeleteKind {
    Pane,
    Session,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum MutationIntent {
    Open {
        target: Target,
        #[serde(skip_serializing_if = "Option::is_none")]
        client: Option<String>,
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
    },
    Create {
        repository: String,
        branch: String,
        create: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        base: Option<String>,
    },
}

#[derive(Clone)]
struct TreeRow {
    key: String,
    depth: usize,
    session: SessionRow,
    detail: Option<DetailRow>,
    state: ClankerState,
    has_children: bool,
    is_last: bool,
}

struct TreeBuildContext<'a> {
    by_parent: &'a HashMap<Option<String>, Vec<usize>>,
    states: &'a [ClankerState],
    included: &'a HashSet<String>,
    query: &'a str,
}

struct App {
    cache_path: PathBuf,
    sessions: Vec<SessionRow>,
    rows: Vec<TreeRow>,
    expanded_lineage: HashSet<String>,
    expanded_details: HashSet<String>,
    selected: usize,
    query: String,
    current_session: String,
    tmux_client: Option<String>,
    error: String,
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
    repository_identities: HashMap<String, String>,
}

#[derive(Clone, Debug, PartialEq)]
enum AppCommand {
    Close,
    Submit(MutationIntent),
    CreateAndOpen(MutationIntent),
}

fn state_rank(state: ClankerState) -> u8 {
    match state {
        ClankerState::Blocked => 0,
        ClankerState::Working => 1,
        ClankerState::Done => 2,
        ClankerState::Failed => 3,
        ClankerState::Idle => 4,
        ClankerState::Unknown => 5,
    }
}

fn aggregate(states: impl Iterator<Item = ClankerState>) -> ClankerState {
    states
        .min_by_key(|state| state_rank(*state))
        .unwrap_or(ClankerState::Unknown)
}

fn session_state(session: &SessionRow) -> ClankerState {
    let has_live_clanker = session
        .details
        .iter()
        .any(|detail| detail.kind == "clanker" && detail.state != ClankerState::Unknown);
    aggregate(
        session
            .details
            .iter()
            .filter(|detail| {
                !has_live_clanker || detail.kind != "incident" || detail.status != "lost on reboot"
            })
            .map(|detail| detail.state),
    )
}

fn neutral_session(session: &SessionRow) -> bool {
    const NEUTRAL_KINDS: [&str; 4] = ["directory", "repository", "session", "window"];
    matches!(session.target, Target::Directory { .. })
        || session
            .details
            .iter()
            .all(|detail| NEUTRAL_KINDS.contains(&detail.kind.as_str()))
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

fn subtree_sort_rank(session: &SessionRow, state: ClankerState) -> u8 {
    if neutral_session(session) && state == ClankerState::Unknown {
        6
    } else {
        state_rank(state)
    }
}

fn target_key(target: &Target) -> String {
    match target {
        Target::TmuxSession {
            session,
            resource_id,
            ..
        } => resource_id.as_ref().map_or_else(
            || format!("session:{session}"),
            |id| format!("session:{id}"),
        ),
        Target::TmuxWindow {
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
    matches!(target, Target::TmuxSession { session, location, .. } if identities.contains(session.as_str()) || location.as_ref().is_some_and(|location| identities.contains(location.native_session_id.as_str())))
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
    let fields = [
        (&session.name, 180),
        (&session.branch, 140),
        (&session.path, 80),
        (&session.flags, 40),
        (&markers, 50),
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

fn repository_identities(cache_path: &Path) -> HashMap<String, String> {
    let path = cache_path.with_file_name("repositories.json");
    let Ok(raw) = fs::read(path) else {
        return HashMap::new();
    };
    let Ok(cache) = serde_json::from_slice::<RepositoryCache>(&raw) else {
        return HashMap::new();
    };
    if cache.version != 1 {
        return HashMap::new();
    }
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
        let repository_path = common_dir
            .strip_suffix("/.git")
            .unwrap_or(common_dir)
            .to_string();
        let name = Path::new(&repository_path)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(&repository_path)
            .to_string();
        let candidate = RepositoryRow {
            name,
            path: repository_path,
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
        if name.is_empty() || local.contains(name) || !remote.insert(name.to_string()) {
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
            expanded_details: HashSet::new(),
            selected: 0,
            query: String::new(),
            current_session,
            tmux_client: None,
            error: String::new(),
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
            repository_identities: HashMap::new(),
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
            expanded_details: HashSet::new(),
            selected: 0,
            query: String::new(),
            current_session,
            tmux_client: None,
            error: String::new(),
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
            repository_identities,
        }
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
        let child_counts = self
            .sessions
            .iter()
            .filter_map(|session| session.parent_workshop_id.as_ref())
            .fold(HashMap::<String, usize>::new(), |mut counts, parent| {
                *counts.entry(parent.clone()).or_default() += 1;
                counts
            });
        for session in &self.sessions {
            let children = session
                .workshop_id
                .as_ref()
                .and_then(|id| child_counts.get(id))
                .copied()
                .unwrap_or(0);
            let state = session_state(session);
            if children > 0
                && (children <= 3
                    || matches!(
                        state,
                        ClankerState::Failed | ClankerState::Working | ClankerState::Done
                    ))
            {
                self.expanded_lineage.insert(session.name.clone());
            }
        }
    }

    fn rebuild(&mut self, selected_key: Option<&str>) {
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
        let mut current_lineage = HashSet::new();
        let mut current = self
            .sessions
            .iter()
            .position(|session| target_is_session(&session.target, &self.current_session));
        while let Some(index) = current {
            if !current_lineage.insert(index) {
                break;
            }
            current = self.sessions[index]
                .parent_workshop_id
                .as_ref()
                .and_then(|parent| {
                    self.sessions
                        .iter()
                        .position(|session| session.workshop_id.as_ref() == Some(parent))
                });
        }
        for children in by_parent.values_mut() {
            children.sort_by(|left_index, right_index| {
                let left = &self.sessions[*left_index];
                let right = &self.sessions[*right_index];
                let left_score = scores.get(&target_key(&left.target)).copied().unwrap_or(0);
                let right_score = scores.get(&target_key(&right.target)).copied().unwrap_or(0);
                right_score
                    .cmp(&left_score)
                    .then_with(|| {
                        current_lineage
                            .contains(right_index)
                            .cmp(&current_lineage.contains(left_index))
                    })
                    .then(
                        subtree_sort_rank(left, states[*left_index])
                            .cmp(&subtree_sort_rank(right, states[*right_index])),
                    )
                    .then(right.recency.cmp(&left.recency))
                    .then_with(|| right.frecency.total_cmp(&left.frecency))
                    .then_with(|| left.name.cmp(&right.name))
            });
        }
        let mut rows = Vec::new();
        let context = TreeBuildContext {
            by_parent: &by_parent,
            states: &states,
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
        self.selected = selected_key
            .and_then(|key| self.rows.iter().position(|row| row.key == key))
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
        for (position, index) in visible.iter().enumerate() {
            let session = self.sessions[*index].clone();
            let id = session.workshop_id.clone();
            let children = id
                .as_ref()
                .and_then(|id| context.by_parent.get(&Some(id.clone())))
                .map_or(0, Vec::len);
            let is_last = position + 1 == visible.len();
            rows.push(TreeRow {
                key: target_key(&session.target),
                depth,
                state: context.states[*index],
                session: session.clone(),
                detail: None,
                has_children: children > 0,
                is_last,
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
                            key: format!("{}:{}", target_key(&detail.target), detail.kind),
                            depth: depth + 1,
                            state: detail.state,
                            session: session.clone(),
                            detail: Some(detail.clone()),
                            has_children: false,
                            is_last: true,
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
        let key = self.rows.get(self.selected).map(|row| row.key.clone());
        self.query = query;
        self.rebuild(key.as_deref());
        if !self.query.is_empty()
            && let Some((index, _)) = self
                .rows
                .iter()
                .enumerate()
                .filter_map(|(index, row)| {
                    search_score(&row.session, &self.query).map(|score| (index, score))
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
        rows.sort_by(|(left, left_score), (right, right_score)| {
            right_score
                .cmp(left_score)
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

    fn enter_repository_mode(&mut self) {
        self.mode = Mode::Repository;
        self.query.clear();
        self.selected = 0;
        self.error.clear();
        self.clear_action_mode();
    }

    fn clear_action_mode(&mut self) {
        self.action_session = None;
        self.rename_name.clear();
        self.attach_candidates.clear();
        self.delete_intent = None;
        self.delete_label.clear();
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
        let source_repository = self.repository_identities.get(&source.path);
        self.attach_candidates = self
            .sessions
            .iter()
            .filter(|candidate| {
                let same_repository = source_repository.is_some_and(|common_dir| {
                    self.repository_identities.get(&candidate.path) == Some(common_dir)
                });
                same_repository
                    && candidate.workshop_id.as_ref().is_some_and(|id| {
                        !descendants.contains(id) && source.parent_workshop_id.as_ref() != Some(id)
                    })
            })
            .cloned()
            .collect();
        self.action_session = Some(source);
        self.mode = Mode::Attach;
        self.query.clear();
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

fn session_name(target: &Target) -> Option<&str> {
    match target {
        Target::TmuxSession { session, .. }
        | Target::TmuxWindow { session, .. }
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
    let Target::TmuxSession {
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
    if !row.allows(AvailableAction::Delete) {
        return None;
    }
    match row.detail.as_ref().map(|detail| &detail.target) {
        Some(Target::TmuxWindow { session, pane, .. })
        | Some(Target::Opencode { session, pane, .. }) => Some(MutationIntent::Delete {
            kind: DeleteKind::Pane,
            session: session.clone(),
            confirmed: true,
            pane: Some(pane.clone()),
        }),
        Some(_) => None,
        None => {
            let Target::TmuxSession { session, .. } = &row.session.target else {
                return None;
            };
            Some(MutationIntent::Delete {
                kind: DeleteKind::Session,
                session: session.clone(),
                confirmed: true,
                pane: None,
            })
        }
    }
}

fn delete_label(row: &TreeRow, intent: &MutationIntent) -> String {
    match intent {
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

fn state_glyph(state: ClankerState, frame: usize) -> (&'static str, Color) {
    const WORKING_GLYPHS: [&str; 8] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"];
    match state {
        ClankerState::Failed => ("×", Color::Rgb(248, 113, 113)),
        ClankerState::Blocked => ("!", Color::Rgb(248, 113, 113)),
        ClankerState::Working => (
            WORKING_GLYPHS[frame % WORKING_GLYPHS.len()],
            Color::Rgb(251, 146, 60),
        ),
        ClankerState::Done => ("✓", Color::Rgb(74, 222, 128)),
        ClankerState::Idle => ("○", Color::Rgb(96, 165, 250)),
        ClankerState::Unknown => ("?", Color::LightMagenta),
    }
}

fn uses_neutral_glyph(row: &TreeRow) -> bool {
    const NEUTRAL_KINDS: [&str; 4] = ["directory", "repository", "session", "window"];
    if let Some(detail) = &row.detail {
        return NEUTRAL_KINDS.contains(&detail.kind.as_str());
    }
    matches!(row.session.target, Target::Directory { .. })
        || row
            .session
            .details
            .iter()
            .all(|detail| NEUTRAL_KINDS.contains(&detail.kind.as_str()))
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

fn session_meta(session: &SessionRow) -> String {
    if matches!(session.target, Target::Directory { .. }) {
        return [session.activity_source.as_str(), session.age.as_str()]
            .into_iter()
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
    }
    [
        (session.management == "unmanaged").then_some("unmanaged"),
        (session.flags == "dirty").then_some("dirty"),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" ")
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
                "Clankerhouse · Open or create branch",
                "Alt-K jump · Enter choose · Esc back",
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
                        BranchKind::Create => "create new branch".into(),
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
                        "Clankerhouse · Rename tmux session",
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
                        Span::styled("  Session: ", Style::default().fg(Color::LightCyan)),
                        Span::raw(format!("{}_", app.rename_name)),
                    ]),
                    Line::from(""),
                    Line::from(Span::styled(
                        "  Canonical Workshop and Clanker identities are unchanged",
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
                    Line::from("  Press y to confirm or n/Esc to cancel."),
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
    let height = areas[1].height.saturating_sub(2) as usize;
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
    frame.render_widget(
        Line::from(vec![
            Span::styled(
                "Clankerhouse · Jump",
                Style::default()
                    .fg(Color::LightCyan)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                "  Alt-K branches · Alt-R/A/L/D actions · ←/→ expand · Enter open · Esc close",
                Style::default().fg(Color::DarkGray),
            ),
        ]),
        areas[0],
    );
    let height = areas[1].height.saturating_sub(2) as usize;
    let start = app
        .selected
        .saturating_sub(height / 2)
        .min(app.rows.len().saturating_sub(height));
    let end = (start + height).min(app.rows.len());
    let items = app.rows[start..end]
        .iter()
        .rev()
        .map(|row| {
            let (glyph, color) = if uses_neutral_glyph(row) {
                ("○", Color::Rgb(148, 163, 184))
            } else {
                state_glyph(row.state, app.animation_frame)
            };
            let branch = if row.depth == 0 {
                ""
            } else if row.is_last {
                "└─"
            } else {
                "├─"
            };
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
                .unwrap_or(&row.session.name);
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
            let meta = row
                .detail
                .as_ref()
                .map_or_else(|| session_meta(&row.session), |_| detail_meta);
            let summary = if row.detail.is_none() && app.query.is_empty() {
                inline_summary(&row.session, 24)
            } else {
                String::new()
            };
            let right = [summary.as_str(), meta.as_str()]
                .into_iter()
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
                .join("  ");
            let content_width = areas[1].width.saturating_sub(5) as usize;
            let fixed_width = 3
                + prefix.width()
                + if right.is_empty() {
                    0
                } else {
                    right.width() + 2
                };
            let rendered_name = ellipsize(name, content_width.saturating_sub(fixed_width).max(4));
            let occupied = 3 + prefix.width() + rendered_name.width() + right.width();
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
            spans.extend([
                Span::raw(rendered_name),
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
        areas[1],
        &mut state,
    );
    let footer = if app.error.is_empty() {
        app.selected()
            .map(|row| row.session.path.as_str())
            .unwrap_or("No matches")
    } else {
        &app.error
    };
    frame.render_widget(
        Paragraph::new(footer).style(Style::default().fg(if app.error.is_empty() {
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
            Span::raw(format!("  {} targets", app.rows.len())),
        ]),
        areas[3],
    );
}

fn handle_key(app: &mut App, key: KeyEvent) -> Option<AppCommand> {
    app.error.clear();

    if app.mode == Mode::DeleteConfirm {
        match key.code {
            KeyCode::Char('y') => {
                let intent = app.delete_intent.take()?;
                app.mode = Mode::Jump;
                app.clear_action_mode();
                return Some(AppCommand::Submit(intent));
            }
            KeyCode::Char('n') | KeyCode::Esc => {
                app.mode = Mode::Jump;
                app.clear_action_mode();
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

    if key.code == KeyCode::Char('k') && key.modifiers.contains(KeyModifiers::ALT) {
        app.enter_repository_mode();
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
                    app.branch_name = branch.value;
                    app.base = "^".into();
                    app.mode = Mode::NewBase;
                } else {
                    return Some(AppCommand::CreateAndOpen(MutationIntent::Create {
                        repository: app.repository.as_ref()?.path.clone(),
                        branch: branch.value,
                        create: false,
                        base: None,
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
        match key.code {
            KeyCode::Char('r') => {
                let row = app.selected()?.clone();
                if !row.allows(AvailableAction::Rename)
                    || !matches!(row.session.target, Target::TmuxSession { .. })
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
                let intent = delete_intent(&row)?;
                app.delete_label = delete_label(&row, &intent);
                app.delete_intent = Some(intent);
                app.mode = Mode::DeleteConfirm;
                return None;
            }
            _ => return None,
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
                    client: app.tmux_client.clone(),
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

fn rpc(
    socket_path: &Path,
    method: &str,
    params: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let mut stream = UnixStream::connect(socket_path).map_err(|error| error.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
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

fn daemon_mutation(
    socket_path: &Path,
    intent: &MutationIntent,
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

fn runtime_root() -> PathBuf {
    let base = env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| "/tmp".into());
    let uid = unsafe { libc_getuid() };
    PathBuf::from(base).join(format!("clankerhouse-{uid}"))
}

unsafe extern "C" {
    #[link_name = "getuid"]
    fn libc_getuid() -> u32;
}

fn run(
    mut terminal: DefaultTerminal,
    mut app: App,
    snapshots: Receiver<Snapshot>,
    socket_path: &Path,
) -> io::Result<AppCommand> {
    loop {
        terminal.draw(|frame| draw(frame, &mut app))?;
        if event::poll(Duration::from_millis(100))?
            && let Event::Key(key) = event::read()?
            && let Some(command) = handle_key(&mut app, key)
        {
            match command {
                AppCommand::Submit(intent) if !matches!(intent, MutationIntent::Open { .. }) => {
                    if let Err(error) = daemon_mutation(socket_path, &intent) {
                        app.error = error;
                    }
                }
                command => return Ok(command),
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

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let current_session = env::var("CLANKERHOUSE_CURRENT_SESSION")
        .ok()
        .filter(|session| !session.is_empty())
        .or_else(|| {
            env::var_os("TMUX").and_then(|_| {
                let output = Command::new("tmux")
                    .args(["display-message", "-p", "#{session_id}\t#{session_name}"])
                    .output()
                    .ok()?;
                output
                    .status
                    .success()
                    .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
                    .filter(|session| !session.is_empty())
            })
        })
        .unwrap_or_default();
    let tmux_client = env::var("CLANKERHOUSE_TMUX_CLIENT")
        .ok()
        .filter(|client| !client.is_empty())
        .or_else(|| {
            env::var_os("TMUX").and_then(|_| {
                let output = Command::new("tmux")
                    .args(["display-message", "-p", "#{client_name}"])
                    .output()
                    .ok()?;
                output
                    .status
                    .success()
                    .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
                    .filter(|client| !client.is_empty())
            })
        });
    let runtime = runtime_root();
    let socket_path = runtime.join("daemon.sock");
    let cache_path = runtime.join("state.json");
    let mut app = match socket_snapshot(&socket_path) {
        Ok(snapshot) => App::from_snapshot(cache_path, current_session, snapshot),
        Err(_) => App::new(cache_path, current_session),
    }
    .map_err(io::Error::other)?;
    app.tmux_client = tmux_client;
    if env::args().any(|argument| argument == "--check") {
        let tmux_sessions = app
            .sessions
            .iter()
            .filter(|row| matches!(row.target, Target::TmuxSession { .. }))
            .count();
        let directory_resources = app
            .sessions
            .iter()
            .filter(|row| matches!(row.target, Target::Directory { .. }))
            .count();
        println!(
            "Native snapshot ready: {tmux_sessions} tmux sessions, {directory_resources} directory resources, {} visible targets",
            app.rows.len()
        );
        return Ok(());
    }
    if env::var("CLANKERHOUSE_MODE").as_deref() == Ok("spawn") {
        app.enter_repository_mode();
    }
    let (snapshot_sender, snapshot_receiver) = mpsc::channel();
    let subscription_path = socket_path.clone();
    thread::spawn(move || subscribe_loop(subscription_path, snapshot_sender));
    let terminal = ratatui::init();
    let open_client = app.tmux_client.clone();
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
                &MutationIntent::Open {
                    target,
                    client: open_client,
                },
            )
            .map(|_| ())
            .map_err(|error| io::Error::other(error).into())
        }
        AppCommand::CreateAndOpen(_) => unreachable!("create flow emitted a non-create intent"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
            "version": 10,
            "sessions": [{
                "name": "workshop", "path": "/tmp/workshop", "target": {"type": "tmux_session", "session": "workshop"},
                "details": [{"kind": "clanker", "state": "working", "target": {"type": "tmux_window", "session": "workshop", "windowId": "@1", "pane": "%1"}}]
            }]
        }"#).unwrap();
        assert_eq!(snapshot.sessions.len(), 1);
        assert_eq!(session_state(&snapshot.sessions[0]), ClankerState::Working);
    }

    #[test]
    fn parses_and_keys_managed_targets_by_stable_identity() {
        let target: Target = serde_json::from_str(r#"{
            "type":"tmux_session",
            "session":"mutable-name",
            "management":"managed",
            "resourceId":"mux-session-1",
            "location":{"kind":"tmux","instanceId":"server","nativeSessionId":"$1","nativeWindowId":null,"nativePaneId":null}
        }"#).unwrap();
        assert_eq!(target_key(&target), "session:mux-session-1");
        assert!(target_is_session(&target, "$1\told-name"));
        assert!(
            serde_json::to_string(&target)
                .unwrap()
                .contains("mux-session-1")
        );
    }

    #[test]
    fn live_clankers_supersede_old_reboot_incidents() {
        let session: SessionRow = serde_json::from_str(r#"{
            "name": "workshop", "path": "/tmp/workshop", "target": {"type": "tmux_session", "session": "workshop"},
            "details": [
                {"kind": "clanker", "state": "idle", "target": {"type": "tmux_window", "session": "workshop", "windowId": "@1", "pane": "%1"}},
                {"kind": "incident", "status": "lost on reboot", "state": "failed", "target": {"type": "tmux_session", "session": "workshop"}}
            ]
        }"#).unwrap();
        assert_eq!(session_state(&session), ClankerState::Idle);
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
        assert_eq!(rows[0].path, "/repo");
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
        fs::write(&cache_path, r#"{"version":10,"sessions":[{"name":"kept","path":"/repo","target":{"type":"directory","path":"/repo"}}]}"#).unwrap();
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
        fs::write(root.join("state.json"), r#"{"version":10,"sessions":[]}"#).unwrap();
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
            "name":"workshop","path":"/repo","target":{"type":"tmux_session","session":"workshop"},
            "details":[
                {"kind":"clanker","harness":"opencode","state":"working","target":{"type":"tmux_window","session":"workshop","windowId":"@1","pane":"%1"}},
                {"kind":"clanker","harness":"claude","state":"idle","target":{"type":"tmux_window","session":"workshop","windowId":"@2","pane":"%2"}},
                {"kind":"window","title":"shell","state":"idle","target":{"type":"tmux_window","session":"workshop","windowId":"@3","pane":"%3"}}
            ]
        }"#).unwrap();
        assert_eq!(inline_summary(&session, 15), "opencode  +2");
        assert_eq!(inline_summary(&session, 40), "opencode  claude  shell");
    }

    #[test]
    fn state_priority_matches_bottom_up_action_order() {
        assert!(state_rank(ClankerState::Blocked) < state_rank(ClankerState::Working));
        assert!(state_rank(ClankerState::Working) < state_rank(ClankerState::Done));
        assert!(state_rank(ClankerState::Done) < state_rank(ClankerState::Failed));
        assert!(state_rank(ClankerState::Failed) < state_rank(ClankerState::Idle));
        assert!(state_rank(ClankerState::Idle) < state_rank(ClankerState::Unknown));
    }

    #[test]
    fn lineage_uses_its_most_actionable_descendant_state() {
        let sessions: Vec<SessionRow> = serde_json::from_str(r#"[
            {"name":"parent","path":"/parent","workshopId":"parent","target":{"type":"tmux_session","session":"parent"}},
            {"name":"child","path":"/child","workshopId":"child","parentWorkshopId":"parent","target":{"type":"tmux_session","session":"child"},"details":[{"kind":"clanker","state":"blocked","target":{"type":"tmux_window","session":"child","windowId":"@1","pane":"%1"}}]}
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
    fn jump_rows_follow_the_exact_bottom_up_priority_contract() {
        let root = env::temp_dir().join(format!(
            "clankerhouse-native-sort-test-{}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let row = |name: &str, state: &str| {
            format!(
                r#"{{"name":"{name}","path":"/{name}","target":{{"type":"tmux_session","session":"{name}"}},"details":[{{"kind":"clanker","state":"{state}","target":{{"type":"tmux_window","session":"{name}","windowId":"@1","pane":"%1"}}}}]}}"#
            )
        };
        let sessions = [
            row("failed", "failed"), row("ready", "done"), row("idle", "idle"), row("unknown", "unknown"),
            r#"{"name":"neutral","path":"/neutral","target":{"type":"directory","path":"/neutral"},"details":[{"kind":"directory","state":"unknown","target":{"type":"directory","path":"/neutral"}}]}"#.into(),
            r#"{"name":"working-parent","path":"/working-parent","workshopId":"working-parent","target":{"type":"tmux_session","session":"working-parent"}}"#.into(),
            r#"{"name":"working-child","path":"/working-child","workshopId":"working-child","parentWorkshopId":"working-parent","target":{"type":"tmux_session","session":"working-child"},"details":[{"kind":"clanker","state":"working","target":{"type":"tmux_window","session":"working-child","windowId":"@2","pane":"%2"}}]}"#.into(),
            r#"{"name":"blocked-parent","path":"/blocked-parent","workshopId":"blocked-parent","target":{"type":"tmux_session","session":"blocked-parent"}}"#.into(),
            r#"{"name":"blocked-child","path":"/blocked-child","workshopId":"blocked-child","parentWorkshopId":"blocked-parent","target":{"type":"tmux_session","session":"blocked-child"},"details":[{"kind":"clanker","state":"blocked","target":{"type":"tmux_window","session":"blocked-child","windowId":"@3","pane":"%3"}}]}"#.into(),
        ];
        fs::write(
            root.join("state.json"),
            format!(r#"{{"version":10,"sessions":[{}]}}"#, sessions.join(",")),
        )
        .unwrap();
        let app = App::new(root.join("state.json"), String::new()).unwrap();
        let roots = app
            .rows
            .iter()
            .filter(|row| row.depth == 0)
            .map(|row| (row.session.name.as_str(), row.state))
            .collect::<Vec<_>>();
        assert_eq!(
            roots,
            vec![
                ("blocked-parent", ClankerState::Blocked),
                ("working-parent", ClankerState::Working),
                ("ready", ClankerState::Done),
                ("failed", ClankerState::Failed),
                ("idle", ClankerState::Idle),
                ("unknown", ClankerState::Unknown),
                ("neutral", ClankerState::Unknown),
            ]
        );
        fs::remove_dir_all(root).unwrap();
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

    fn alt(character: char) -> KeyEvent {
        KeyEvent::new(KeyCode::Char(character), KeyModifiers::ALT)
    }

    #[test]
    fn rename_mode_constructs_a_typed_intent_with_stable_resource_id() {
        let mut app = app_with_sessions(
            r#"[{"name":"display","path":"/repo","resourceId":"resource-1","availableActions":["open","rename"],"target":{"type":"tmux_session","session":"native-name","resourceId":"resource-1"}}]"#,
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
                {"name":"parent","path":"/parent","workshopId":"parent-id","availableActions":["open","attach"],"target":{"type":"tmux_session","session":"parent-native"}},
                {"name":"source","path":"/source","workshopId":"source-id","parentWorkshopId":"parent-id","availableActions":["open","attach","detach"],"target":{"type":"tmux_session","session":"source-native"}},
                {"name":"child","path":"/child","workshopId":"child-id","parentWorkshopId":"source-id","availableActions":["open","attach"],"target":{"type":"tmux_session","session":"child-native"}},
                {"name":"candidate","path":"/candidate","workshopId":"candidate-id","availableActions":["open","attach"],"target":{"type":"tmux_session","session":"candidate-native"}},
                {"name":"outsider","path":"/outsider","workshopId":"outsider-id","availableActions":["open","attach"],"target":{"type":"tmux_session","session":"outsider-native"}}
            ]"#,
        );
        for path in ["/parent", "/source", "/child", "/candidate"] {
            app.repository_identities
                .insert(path.into(), "/repo/.git".into());
        }
        app.repository_identities
            .insert("/outsider".into(), "/other/.git".into());
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
    fn delete_requires_confirmation_and_preserves_exact_selected_scope() {
        let mut app = app_with_sessions(
            r#"[{"name":"display","path":"/repo","availableActions":["open","delete"],"target":{"type":"tmux_session","session":"native-session"},"details":[{"kind":"clanker","title":"worker","state":"idle","target":{"type":"tmux_window","session":"native-session","windowId":"@2","pane":"%7"}}]}]"#,
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
            }))
        );

        app.selected = app
            .rows
            .iter()
            .position(|row| row.detail.is_none())
            .unwrap();
        assert_eq!(handle_key(&mut app, alt('d')), None);
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
            }))
        );
    }

    #[test]
    fn projected_actions_gate_exact_open_and_destructive_keys() {
        let mut app = app_with_sessions(
            r#"[{"name":"blocked","path":"/repo","workshopId":"workshop-id","target":{"type":"tmux_session","session":"native-session"},"details":[{"kind":"window","title":"shell","state":"idle","target":{"type":"tmux_window","session":"native-session","windowId":"@9","pane":"%9"}}]}]"#,
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
                target: Target::TmuxWindow {
                    session: "native-session".into(),
                    window_id: "@9".into(),
                    pane: "%9".into(),
                    management: None,
                    resource_id: None,
                    location: None,
                },
                client: None,
            }))
        );
    }

    #[test]
    fn branch_selection_constructs_daemon_create_intent() {
        let mut app = app_with_sessions("[]");
        app.mode = Mode::Branch;
        app.repository = Some(RepositoryRow {
            name: "repo".into(),
            path: "/repo".into(),
        });
        app.branches = vec![BranchRow {
            name: "feature".into(),
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
            }))
        );
    }

    #[test]
    fn ambiguous_workshop_ids_do_not_duplicate_child_targets() {
        let mut app = app_with_sessions(
            r#"[
                {"name":"legacy-parent","path":"/legacy","workshopId":"parent-id","target":{"type":"directory","path":"/legacy"}},
                {"name":"live-parent","path":"/live","workshopId":"parent-id","target":{"type":"tmux_session","session":"live-parent"}},
                {"name":"child","path":"/child","workshopId":"child-id","parentWorkshopId":"parent-id","availableActions":["open"],"target":{"type":"tmux_session","session":"child-native"}}
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

        app.tmux_client = Some("/dev/pts/9".into());
        app.selected = app
            .rows
            .iter()
            .position(|row| row.key == "session:child-native")
            .unwrap();
        assert_eq!(
            handle_key(&mut app, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            Some(AppCommand::Submit(MutationIntent::Open {
                target: Target::TmuxSession {
                    session: "child-native".into(),
                    management: None,
                    resource_id: None,
                    location: None,
                },
                client: Some("/dev/pts/9".into()),
            }))
        );
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
            r#"{"version":10,"sessions":[
                {"name":"working","path":"/working","target":{"type":"tmux_session","session":"working"},"details":[{"kind":"clanker","state":"working","target":{"type":"tmux_window","session":"working","windowId":"@1","pane":"%1"}}]},
                {"name":"current","path":"/current","target":{"type":"tmux_session","session":"current"},"details":[{"kind":"clanker","state":"idle","target":{"type":"tmux_window","session":"current","windowId":"@2","pane":"%2"}}]}
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
        fs::remove_dir_all(root).unwrap();
    }
}
