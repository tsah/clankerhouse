use std::{
    collections::{HashMap, HashSet},
    env, fs,
    io::{self},
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, SystemTime},
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

#[derive(Clone, Deserialize, Serialize)]
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
        #[serde(rename = "pane")]
        _pane: String,
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

#[derive(Clone, Deserialize, Serialize)]
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

#[derive(Clone, Deserialize)]
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

#[derive(Clone, Deserialize)]
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

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Jump,
    Repository,
    Branch,
    NewBase,
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
    cache_modified: Option<SystemTime>,
    sessions: Vec<SessionRow>,
    rows: Vec<TreeRow>,
    expanded_lineage: HashSet<String>,
    expanded_details: HashSet<String>,
    selected: usize,
    query: String,
    current_session: String,
    error: String,
    animation_frame: usize,
    mode: Mode,
    repositories: Vec<RepositoryRow>,
    branches: Vec<BranchRow>,
    repository: Option<RepositoryRow>,
    branch_name: String,
    base: String,
}

enum AppExit {
    Close,
    Open(Target),
    OpenBranch {
        repository: String,
        branch: String,
        create: bool,
        base: String,
    },
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

fn repository_rows(cache_path: &Path, sessions: &[SessionRow]) -> Vec<RepositoryRow> {
    let path = cache_path.with_file_name("repositories.json");
    let Ok(raw) = fs::read(path) else {
        return Vec::new();
    };
    let Ok(cache) = serde_json::from_slice::<RepositoryCache>(&raw) else {
        return Vec::new();
    };
    if cache.version != 1 {
        return Vec::new();
    }
    let mut repositories = HashMap::<String, RepositoryRow>::new();
    for session in sessions {
        let Some(entry) = cache.entries.get(&session.path) else {
            continue;
        };
        if entry.common_dir.is_empty() {
            continue;
        }
        let repository_path = entry
            .common_dir
            .strip_suffix("/.git")
            .unwrap_or(&entry.common_dir)
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
        let replace = repositories.get(&entry.common_dir).is_none_or(|existing| {
            let existing_main = sessions
                .iter()
                .find(|row| row.path == existing.path)
                .is_some_and(|row| matches!(row.branch.as_str(), "main" | "master"));
            let candidate_main = matches!(session.branch.as_str(), "main" | "master");
            candidate_main && !existing_main
        });
        if replace {
            repositories.insert(entry.common_dir.clone(), candidate);
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
            cache_modified: None,
            sessions: Vec::new(),
            rows: Vec::new(),
            expanded_lineage: HashSet::new(),
            expanded_details: HashSet::new(),
            selected: 0,
            query: String::new(),
            current_session,
            error: String::new(),
            animation_frame: 0,
            mode: Mode::Jump,
            repositories: Vec::new(),
            branches: Vec::new(),
            repository: None,
            branch_name: String::new(),
            base: "^".into(),
        };
        app.reload(true)?;
        app.repositories = repository_rows(&app.cache_path, &app.sessions);
        Ok(app)
    }

    fn reload(&mut self, initial: bool) -> Result<(), String> {
        let metadata = fs::metadata(&self.cache_path)
            .map_err(|error| format!("Snapshot unavailable: {error}"))?;
        let modified = metadata.modified().ok();
        if !initial && modified == self.cache_modified {
            return Ok(());
        }
        let snapshot: Snapshot =
            serde_json::from_slice(&fs::read(&self.cache_path).map_err(|error| error.to_string())?)
                .map_err(|error| format!("Invalid snapshot: {error}"))?;
        if snapshot.version != CACHE_VERSION {
            return Err(format!(
                "Snapshot version {} is unsupported",
                snapshot.version
            ));
        }
        let selected_key = self.rows.get(self.selected).map(|row| row.key.clone());
        self.sessions = snapshot.sessions;
        self.cache_modified = modified;
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
        let known_ids = self
            .sessions
            .iter()
            .filter_map(|session| session.workshop_id.clone())
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
            Mode::NewBase => 0,
        }
    }

    fn enter_repository_mode(&mut self) {
        self.mode = Mode::Repository;
        self.query.clear();
        self.selected = 0;
        self.error.clear();
    }
}

impl TreeRow {
    fn target(&self) -> Target {
        self.detail
            .as_ref()
            .map(|detail| detail.target.clone())
            .unwrap_or_else(|| self.session.target.clone())
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
                "  Alt-K branches · ←/→ expand · Enter open · Esc close",
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

fn open_target(target: Target, root: &Path) -> io::Error {
    let encoded = serde_json::to_string(&target).expect("target serialization must succeed");
    let mut command = Command::new(root.join("bin/clankers"));
    command.args(["target", "open", "--json", &encoded]);
    command.exec()
}

fn open_branch(
    repository: &str,
    branch: &str,
    create: bool,
    base: &str,
    root: &Path,
) -> Result<Target, String> {
    let mut command = Command::new("wt");
    command.args(["-C", repository, "switch"]);
    if create {
        command.arg("--create");
    }
    command.args([branch, "--no-cd", "--format", "json"]);
    if create && !base.is_empty() {
        command.args(["--base", base]);
    }
    let switched = command.output().map_err(|error| error.to_string())?;
    if !switched.status.success() {
        return Err(String::from_utf8_lossy(&switched.stderr).trim().into());
    }
    let value: serde_json::Value =
        serde_json::from_slice(&switched.stdout).map_err(|error| error.to_string())?;
    let path = value
        .get("path")
        .and_then(|path| path.as_str())
        .ok_or_else(|| "Worktrunk did not return a worktree path".to_string())?;
    let created = Command::new(root.join("bin/clankers"))
        .args(["workshop", "ensure", "--cwd", path])
        .output()
        .map_err(|error| error.to_string())?;
    if !created.status.success() {
        return Err(String::from_utf8_lossy(&created.stderr).trim().into());
    }
    let session = String::from_utf8_lossy(&created.stdout).trim().to_string();
    if session.is_empty() {
        return Err("Session creation did not return a session name".into());
    }
    Ok(Target::TmuxSession {
        session,
        management: None,
        resource_id: None,
        location: None,
    })
}

fn handle_key(app: &mut App, key: KeyEvent) -> Option<AppExit> {
    app.error.clear();
    if key.code == KeyCode::Char('k') && key.modifiers.contains(KeyModifiers::ALT) {
        app.enter_repository_mode();
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
                return Some(AppExit::OpenBranch {
                    repository: app.repository.as_ref()?.path.clone(),
                    branch: app.branch_name.clone(),
                    create: true,
                    base: app.base.clone(),
                });
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
    if app.mode == Mode::Repository || app.mode == Mode::Branch {
        match key.code {
            KeyCode::Esc => {
                if !app.query.is_empty() {
                    app.query.clear();
                    app.selected = 0;
                } else if app.mode == Mode::Branch {
                    app.enter_repository_mode();
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
            KeyCode::Enter => {
                let branch = app.filtered_branches().get(app.selected).cloned()?;
                if branch.kind == BranchKind::Create {
                    app.branch_name = branch.value;
                    app.base = "^".into();
                    app.mode = Mode::NewBase;
                } else {
                    return Some(AppExit::OpenBranch {
                        repository: app.repository.as_ref()?.path.clone(),
                        branch: branch.value,
                        create: false,
                        base: String::new(),
                    });
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
    match key.code {
        KeyCode::Esc if !app.query.is_empty() => app.update_query(String::new()),
        KeyCode::Esc => return Some(AppExit::Close),
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
            if let Some(row) = app.selected() {
                return Some(AppExit::Open(row.target()));
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

fn runtime_root() -> PathBuf {
    let base = env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| "/tmp".into());
    let uid = unsafe { libc_getuid() };
    PathBuf::from(base).join(format!("clankerhouse-{uid}"))
}

unsafe extern "C" {
    #[link_name = "getuid"]
    fn libc_getuid() -> u32;
}

fn run(mut terminal: DefaultTerminal, mut app: App) -> io::Result<AppExit> {
    loop {
        terminal.draw(|frame| draw(frame, &mut app))?;
        if event::poll(Duration::from_millis(100))?
            && let Event::Key(key) = event::read()?
            && let Some(exit) = handle_key(&mut app, key)
        {
            return Ok(exit);
        }
        match app.reload(false) {
            Ok(()) => app.error.clear(),
            Err(error) if app.sessions.is_empty() => app.error = error,
            Err(_) => {}
        }
        app.animation_frame = (app.animation_frame + 1) % 40;
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = env::var("CLANKERHOUSE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .to_path_buf()
        });
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
    let mut app =
        App::new(runtime_root().join("state.json"), current_session).map_err(io::Error::other)?;
    if env::args().any(|argument| argument == "--check") {
        println!(
            "Native snapshot ready: {} sessions, {} targets",
            app.sessions.len(),
            app.rows.len()
        );
        return Ok(());
    }
    if env::var("CLANKERHOUSE_MODE").as_deref() == Ok("spawn") {
        app.enter_repository_mode();
    }
    let terminal = ratatui::init();
    let result = run(terminal, app);
    ratatui::restore();
    match result? {
        AppExit::Close => Ok(()),
        AppExit::Open(target) => Err(open_target(target, &root).into()),
        AppExit::OpenBranch {
            repository,
            branch,
            create,
            base,
        } => {
            let target = open_branch(&repository, &branch, create, &base, &root)
                .map_err(io::Error::other)?;
            Err(open_target(target, &root).into())
        }
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
            {"name":"main","path":"/repo/main","branch":"main","target":{"type":"directory","path":"/repo/main"}},
            {"name":"feature","path":"/repo/feature","branch":"feature","target":{"type":"directory","path":"/repo/feature"}}
        ]"#).unwrap();
        let rows = repository_rows(&cache_path, &sessions);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].path, "/repo");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn transient_snapshot_removal_keeps_the_last_good_rows() {
        let root = env::temp_dir().join(format!(
            "clankerhouse-native-reload-test-{}",
            std::process::id()
        ));
        let cache_path = root.join("state.json");
        fs::create_dir_all(&root).unwrap();
        fs::write(&cache_path, r#"{"version":10,"sessions":[{"name":"kept","path":"/repo","target":{"type":"directory","path":"/repo"}}]}"#).unwrap();
        let mut app = App::new(cache_path.clone(), String::new()).unwrap();

        fs::remove_file(&cache_path).unwrap();
        assert!(app.reload(false).is_err());
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
