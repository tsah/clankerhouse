// Clankerhouse on the Herdr app: the switcher as a popup, the Alt keys the app has no command for, and the app's focus
// reported to the Clankerhouse machine. It lives in a 0 px block of the clankerhouse layout, because `<mod>.<command>` keys
// reach shown copies only. Props: { machine, launcher }: the `hc machine` running Clankerhouse, and clankerhouse-hc there.
//
// A popup is a terminal on that machine running `clankerhouse-hc --popup`, labelled ch_popup so Clankerhouse does not take
// it for a session. The picker's choice comes back as that terminal's ch_popup_target label.

import { View, div } from "gpui-kit";
import { exec, focused, hc, notify, openOverlay, panes, props, nextCommand, run, spaces, terminals, window } from "herdr";

const POPUPS = { jump: [], repo: ["--repo"], delete: ["--delete"] };
const HEARTBEAT_MS = 60000; // HC_FOCUS_STALE_MS in src/multiplexer/hc.ts allows three of these.
const TICK_MS = 150;
const PANE_WAIT_TICKS = 40; // A new session's pane appears once the app has seen and adopted its terminal.

const local = (machine, address) => (address?.startsWith(`${machine}/`) ? address.slice(machine.length + 1) : null);

export default class Clankerhouse extends View {
  init(_props, cx) {
    this.popup = null;
    this.reported = null;
    this.reporting = false;
    cx.timer.every(HEARTBEAT_MS, (cx) => { this.reported = null; this.reportFocus(cx); });
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

  openPopup(mode, cx) {
    if (this.popup) return;
    const { machine, launcher } = props() ?? {};
    this.popup = mode;
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
        openOverlay({ kind: "dialog", modal: true, width: 0.9, height: 0.8, layout: { type: "block", content: { terminal: address } } });
        cx.timer.after(TICK_MS, (cx) => this.watchPopup(address, cx));
      } catch (error) {
        this.popup = null;
        this.fail("Clankerhouse popup did not open", error);
      }
    });
  }

  // The overlay closes itself when its terminal ends; what is left is reading the choice.
  watchPopup(address, cx) {
    cx.spawn(async (cx) => {
      const got = await hc(["get", "--json", address]);
      const terminal = got.code === 0 ? JSON.parse(got.stdout) : null;
      const record = terminal?.terminal ?? terminal;
      if (record?.state === "live") return cx.timer.after(TICK_MS, (cx) => this.watchPopup(address, cx));
      const target = record?.labels?.ch_popup_target;
      if (record?.exit_code) {
        const output = await hc(["read", address, "--lines", "6"]);
        this.fail("Clankerhouse popup failed", output.stdout.trim());
      }
      await hc(["rm", address]);
      this.popup = null;
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

  render(cx) {
    this.reportFocus(cx);
    return div();
  }
}
