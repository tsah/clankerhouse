// Clankerhouse on the Herdr app: the switcher as a popup, the Alt keys the app has no command for, the app's focus
// reported to the Clankerhouse machine, and the current workshop and branch. It lives at the right of the clankerhouse
// layout's tab bar; it must stay shown, because `<mod>.<command>` keys reach shown copies only. Props: { machine, launcher }: the `hc machine` running Clankerhouse, and clankerhouse-hc there.
//
// Any program on that machine can ask for a popup too (Schlop under herdr-core does): a terminal labelled popup=1 is
// opened over the whole window and labelled popup_shown=1, so the asker knows someone sees it.
//
// A popup is a terminal on that machine running `clankerhouse-hc --popup`, labelled ch_popup so Clankerhouse does not take
// it for a session. The picker's choice comes back as that terminal's ch_popup_target label.

import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { exec, focused, hc, notify, openOverlay, panes, props, nextCommand, run, spaces, terminals, theme, window } from "herdr";

const POPUPS = { jump: [], repo: ["--repo"], delete: ["--delete"], scratch: ["--scratch"] };
// The layout's Alt keys win over the popup's terminal, so pressed again while a popup is open they are passed into it:
// the picker has its own Alt-D (done or delete the selected row) and Alt-K.
const POPUP_KEYS = { jump: "alt+k", repo: "alt+b", delete: "alt+d", scratch: "alt+n" };
const HEARTBEAT_MS = 60000; // HC_FOCUS_STALE_MS in src/multiplexer/hc.ts allows three of these.
const TICK_MS = 150;
const REQUEST_POLL_MS = 500;
const NAME_SYNC_MS = 2000;
const POPUP_START_MS = 20000; // A popup with no terminal after this never started; the next key opens a new one.
const PANE_WAIT_TICKS = 40; // A new session's pane appears once the app has seen and adopted its terminal.

// The picker's tag colours (native-client/src/main.rs: PROJECT_COLORS, LABEL_COLORS, name_hash), so a project or
// label looks the same in the top bar as in Alt-K.
const PROJECT_COLORS = ["#5eb4aa", "#a78bfa", "#e882b4", "#d6bc68", "#67c8e6", "#a0be6e", "#be96c8", "#c8a082"];
const LABEL_COLORS = ["#3894a0", "#806cc8", "#ba608c", "#aa8c3c", "#6e9646", "#a8704e"];
const DONE_GRAY = "#6c7280";
const ROW_REFRESH_MS = 15000;
// FNV-1a over the name's UTF-8 bytes; the app has no TextEncoder.
const utf8 = (text) => [...text].flatMap((character) => {
  const code = character.codePointAt(0);
  if (code < 0x80) return [code];
  if (code < 0x800) return [0xc0 | (code >> 6), 0x80 | (code & 63)];
  if (code < 0x10000) return [0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63)];
  return [0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63)];
});
const nameHash = (name) => utf8(name).reduce((hash, byte) => Math.imul(hash ^ byte, 0x01000193) >>> 0, 0x811c9dc5);
const labelColor = (label) => (label === "done" ? DONE_GRAY : LABEL_COLORS[nameHash(label) % LABEL_COLORS.length]);
const projectColor = (project) => PROJECT_COLORS[nameHash(project) % PROJECT_COLORS.length];
const dimmed = (hex, percent) => `#${[1, 3, 5].map((at) => Math.floor((parseInt(hex.slice(at, at + 2), 16) * percent) / 100).toString(16).padStart(2, "0")).join("")}`;

const local = (machine, address) => (address?.startsWith(`${machine}/`) ? address.slice(machine.length + 1) : null);

export default class Clankerhouse extends View {
  init(_props, cx) {
    this.popup = null;
    this.reported = null;
    this.reporting = false;
    this.branches = new Map(); // cwd on the machine -> its branch, for panes the app reports none for.
    this.rows = new Map(); // cwd on the machine -> { row, at }: the picker's row for the session holding it.
    this.requests = new Set(); // popup=1 terminals already opened here.
    // terminals() changing does not re-render this block, so requests are polled.
    cx.timer.every(REQUEST_POLL_MS, (cx) => this.openRequests(cx));
    cx.timer.every(NAME_SYNC_MS, () => this.syncSpaceNames());
    cx.timer.every(ROW_REFRESH_MS, (cx) => cx.notify());
    cx.timer.every(HEARTBEAT_MS, (cx) => { this.reported = null; this.branches.clear(); this.reportFocus(cx); cx.notify(); });
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (POPUPS[command]) this.openPopup(command, cx);
        else if (command === "tab_left") this.moveTab(-1);
        else if (command === "tab_right") this.moveTab(1);
        else if (command === "open_pr") this.openPr(cx);
      }
    });
  }

  fail(title, error) {
    notify({ title, body: String(error?.message ?? error), level: "error" });
  }

  reportFocus(cx) {
    const { machine, launcher } = props() ?? {};
    const terminal = local(machine, focused()?.terminal);
    if (!terminal || terminal === this.reported || this.reporting) return;
    this.reporting = true;
    cx.spawn(async (cx) => {
      try {
        await exec(launcher, ["--report-focus", terminal], { on: machine });
        this.reported = terminal;
      } catch {
        // The machine is away; the next focus change or heartbeat tries again.
      }
      this.reporting = false;
      this.reportFocus(cx);
    });
  }

  // A popup this mod thinks is open but that is gone (its terminal ended unseen, or it never started) would
  // swallow every popup key from then on, forwarded to nothing.
  popupGone() {
    if (!this.popupAddress) return Date.now() - this.popupStarted > POPUP_START_MS;
    return !terminals().some((t) => t.address === this.popupAddress && t.state === "live");
  }

  openPopup(mode, cx) {
    if (this.popup && this.popupGone()) this.popup = this.popupAddress = null;
    if (this.popup) {
      const address = this.popupAddress;
      if (address) cx.spawn(async () => { await hc(["keys", address, POPUP_KEYS[mode]]).catch(() => {}); });
      return;
    }
    const { machine, launcher } = props() ?? {};
    this.popup = mode;
    this.popupStarted = Date.now();
    cx.spawn(async (cx) => {
      try {
        for (const stale of terminals().filter((t) => t.labels?.ch_popup && t.address.startsWith(`${machine}/`))) {
          await hc(["kill", stale.address]);
          await hc(["rm", stale.address]);
        }
        const started = await hc(["run", "--on", machine, "--bg", "--json", "--no-parent", "--no-notify", "--label", "ch_popup=1", "--", launcher, "--popup", ...POPUPS[mode]]);
        if (started.code !== 0) throw new Error(started.stderr || started.stdout);
        const created = JSON.parse(started.stdout);
        const address = created.terminal?.address ?? created.address;
        this.popupAddress = address;
        openOverlay({ kind: "dialog", modal: true, width: 0.9, height: 0.8, layout: { type: "block", content: { terminal: address } } });
        cx.timer.after(TICK_MS, (cx) => this.watchPopup(address, cx));
      } catch (error) {
        this.popup = this.popupAddress = null;
        this.fail("Clankerhouse popup did not open", error);
      }
    });
  }

  // The overlay closes itself when its terminal ends; what is left is reading the choice. A failed check is
  // retried: a watch that stopped would leave the popup marked open.
  watchPopup(address, cx) {
    cx.spawn(async (cx) => {
      let record;
      try {
        const got = await hc(["get", "--json", address]);
        const terminal = got.code === 0 ? JSON.parse(got.stdout) : null;
        record = terminal?.terminal ?? terminal;
      } catch {
        return cx.timer.after(TICK_MS * 4, (cx) => this.watchPopup(address, cx));
      }
      if (record?.state === "live") return cx.timer.after(TICK_MS, (cx) => this.watchPopup(address, cx));
      if (this.popupAddress === address) this.popup = this.popupAddress = null;
      const target = record?.labels?.ch_popup_target;
      try {
        if (record?.exit_code) {
          // The error is what the popup printed last; a toast shows only its first lines.
          const output = await hc(["read", address, "--lines", "12"]);
          this.fail("Clankerhouse popup failed", output.stdout.trim().split("\n").filter((line) => line.trim()).slice(-3).reverse().join("\n"));
        }
        await hc(["rm", address]);
      } catch {
        // Cleanup only: the next popup removes a leftover ch_popup terminal.
      }
      if (target) this.showTerminal(`${props().machine}/${target}`, PANE_WAIT_TICKS, cx);
    });
  }

  showTerminal(terminal, ticks, cx) {
    if (panes().some((p) => p.terminal === terminal)) return run("pane.focus", { terminal });
    if (ticks > 0) return cx.timer.after(TICK_MS, (cx) => this.showTerminal(terminal, ticks - 1, cx));
    // Older than the herdr.space labels, or not adopted: give it a tab here.
    run("terminal.keep", { terminal });
  }

  moveTab(by) {
    const space = spaces().find((s) => s.active);
    const tab = space?.tabs.find((t) => t.active);
    if (!tab) return;
    run("tab.move", { id: tab.id, index: Math.min(Math.max(tab.index + by, 1), space.tabs.length) });
  }

  openPr(cx) {
    const { machine } = props() ?? {};
    const place = focused();
    if (!place?.cwd) return;
    cx.spawn(async () => {
      try {
        const pr = await exec("gh", ["pr", "view", "--json", "url", "--jq", ".url"], { cwd: place.cwd, on: local(machine, place.terminal) ? machine : null });
        if (pr.code !== 0) return this.fail("No pull request here", pr.stderr);
        await exec(window().platform === "macos" ? "open" : "xdg-open", [pr.stdout.trim()]);
      } catch (error) {
        this.fail("Could not open the pull request", error);
      }
    });
  }

  // The app knows the branch of local panes only; ask the machine for the others, once per folder and heartbeat.
  branch(pane, cx) {
    if (pane?.branch) return pane.branch;
    const { machine } = props() ?? {};
    if (!pane?.cwd || !local(machine, pane.terminal)) return null;
    if (!this.branches.has(pane.cwd)) {
      this.branches.set(pane.cwd, null);
      cx.spawn(async (cx) => {
        try {
          const git = await exec("git", ["branch", "--show-current"], { cwd: pane.cwd, on: machine });
          if (git.code === 0 && git.stdout.trim()) { this.branches.set(pane.cwd, git.stdout.trim()); cx.notify(); }
        } catch {
          // The machine is away; the heartbeat clears the cache and tries again.
        }
      });
    }
    return this.branches.get(pane.cwd);
  }

  // The Alt-K row (title, project, labels) of the focused pane's session, refreshed every ROW_REFRESH_MS.
  sessionRow(pane, cx) {
    const { machine, launcher } = props() ?? {};
    if (!pane?.cwd || !local(machine, pane.terminal)) return null;
    const cached = this.rows.get(pane.cwd);
    if (!cached || (!cached.loading && Date.now() - cached.at > ROW_REFRESH_MS)) {
      this.rows.set(pane.cwd, { row: cached?.row ?? null, at: Date.now(), loading: true });
      cx.spawn(async (cx) => {
        let row = cached?.row ?? null;
        try {
          const got = await exec(launcher, ["--session-row", pane.cwd], { on: machine });
          if (got.code === 0) row = JSON.parse(got.stdout);
        } catch {
          // The machine is away; the next refresh tries again.
        }
        this.rows.set(pane.cwd, { row, at: Date.now(), loading: false });
        cx.notify();
      });
    }
    return this.rows.get(pane.cwd)?.row ?? null;
  }

  // A Clankerhouse session is a space here, but the app names a space after its folder; a Workshop's title
  // (set at creation or renamed in the picker) lives on its terminals as ch_session_name. Mirror it.
  syncSpaceNames() {
    const { machine } = props() ?? {};
    const wanted = new Map();
    for (const t of terminals()) {
      const space = t.labels?.["herdr.space"], name = t.labels?.ch_session_name;
      if (space && name && local(machine, t.address)) wanted.set(`${machine}/${space}`, name);
    }
    for (const space of spaces()) {
      const name = wanted.get(space.id);
      if (name && space.name !== name) run("space.rename", { id: space.id, name });
    }
  }

  openRequests(cx) {
    const { machine } = props() ?? {};
    const live = terminals().filter((t) => t.labels?.popup && t.state === "live" && local(machine, t.address));
    this.requests = new Set([...this.requests].filter((address) => live.some((t) => t.address === address)));
    const fresh = live.filter((t) => !t.labels.popup_shown && !this.requests.has(t.address));
    if (!fresh.length) return;
    for (const t of fresh) this.requests.add(t.address);
    cx.spawn(async () => {
      for (const t of fresh) {
        openOverlay({ kind: "dialog", modal: true, frame: "none", width: 1, height: 1, layout: { type: "block", content: { terminal: t.address } } });
        await hc(["label", t.address, "popup_shown=1"]);
      }
    });
  }

  render(cx) {
    this.reportFocus(cx);
    const t = theme();
    const space = spaces().find((s) => s.active);
    const pane = panes().find((p) => p.focused);
    const row = this.sessionRow(pane, cx);
    const branch = row?.branch || this.branch(pane, cx) || space?.branch;
    const done = Boolean(row?.labels?.includes("done"));
    // As in the picker: an untitled session drops its "project@" prefix, because the project tag names it.
    const name = row ? (row.title ?? (row.project && row.name.startsWith(`${row.project}@`) ? row.name.slice(row.project.length + 1) : row.name)) : space?.name;
    const tag = (text, color) => div().flex_none().text_color(done ? dimmed(color, 70) : color).child(text);
    const label = (icon, text) => h_flex().min_w(0).gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13).flex_none()).child(div().truncate().child(text));
    return h_flex().size_full().min_w(0).px(14).gap(14).justify_end().items_center().bg(t.chrome).border_b(1).border_color(t.border).text_size(12.4).text_color(t.muted)
      .child(h_flex().min_w(0).gap(7).items_center()
        .when(Boolean(name), (el) => el.child(div().min_w(0).truncate().text_color(done ? DONE_GRAY : t.foreground).child(name)))
        .when(Boolean(row?.project && row.project !== name), (el) => el.child(tag(row.project, projectColor(row.project))))
        .children((row?.labels ?? []).map((text) => tag(text, labelColor(text)))))
      .when(Boolean(branch), (el) => el.child(label("git-branch", branch)));
  }
}
