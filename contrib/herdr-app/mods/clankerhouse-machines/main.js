// Alt-M in the clankerhouse layout: the machines added to this app (`hc machine ls`), to make one the current
// Clankerhouse machine. Choosing a row writes it to the shared clankerhouse.machine, which the clankerhouse mod reads for
// every key, report and count, and shows that machine's first space if it has one. A machine that is not connected is
// listed with its state and cannot be chosen. Props: { current, over, fallback }: the current machine, the terminal
// focused when the list opened, and the layout's props.machine.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { closeOverlay, hc, notify, props, run, spaces, theme } from "herdr";
import * as herdr from "herdr";

const CURRENT_MACHINE = "clankerhouse.machine"; // As in mods/clankerhouse/main.js.
const STATES = { connected: null, needs_login: "needs login", unreachable: "unreachable", asleep: "asleep" };

// One row per added machine, plus the layout's fallback when it is not among them. hc's own list beats machines(),
// which knows only whether a machine's layout loaded.
export function machineRows(listed, known, fallback) {
  const rows = new Map();
  for (const m of listed ?? []) {
    if (!m?.name || m.temporary) continue;
    rows.set(m.name, { name: m.name, state: m.state ?? "unknown", why: m.why ?? null });
  }
  for (const m of known ?? []) {
    if (m?.name && !rows.has(m.name)) rows.set(m.name, { name: m.name, state: m.layout === "unavailable" ? "unreachable" : "unknown", why: null });
  }
  if (fallback && !rows.has(fallback)) rows.set(fallback, { name: fallback, state: "not added", why: `hc machine add … --name ${fallback}` });
  return [...rows.values()];
}

export const stateText = (row) => (row.state in STATES ? STATES[row.state] : row.state);

export default class Machines extends View {
  init(_props, cx) {
    this.rows = null;
    this.at = 0;
    this.filter = "";
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Switch Clankerhouse to a machine…" });
    this.input.on("change", (_e, cx) => { this.filter = this.input.value(); this.at = 0; cx.notify(); });
    this.input.on("submit", () => this.choose(this.shown()[this.at]));
    this.input.focus();
    cx.spawn(async (cx) => {
      let listed = [];
      try {
        const got = await hc(["machine", "ls", "--json"]);
        if (got.code === 0) listed = JSON.parse(got.stdout).machines ?? [];
        else this.error = (got.stderr || got.stdout).trim();
      } catch (error) {
        this.error = String(error?.message ?? error);
      }
      let known = [];
      try { known = typeof herdr.machines === "function" ? herdr.machines() : []; } catch {}
      this.rows = machineRows(listed, known, props()?.fallback);
      const current = this.rows.findIndex((row) => row.name === props()?.current);
      this.at = Math.max(current, 0);
      cx.notify();
    });
  }

  shown() {
    const filter = this.filter.toLowerCase();
    return (this.rows ?? []).filter((row) => row.name.toLowerCase().includes(filter));
  }

  close() {
    closeOverlay(props().overlay);
  }

  choose(row) {
    if (!row) return;
    if (row.state !== "connected") {
      notify({ title: `${row.name} is ${stateText(row)}`, body: row.why ?? "Check `hc machine ls`; the list keeps it until it connects.", level: "error" });
      return;
    }
    this.close();
    if (typeof herdr.setShared === "function") herdr.setShared(CURRENT_MACHINE, { machine: row.name, over: props()?.over ?? null });
    const space = spaces().find((s) => s.machine === row.name);
    if (space && !space.active) run("space.select", { id: space.id });
    if (!space) notify({ title: `Clankerhouse is on ${row.name}`, body: "No space there yet: Alt-K opens its Workshops." });
  }

  render(cx) {
    const t = theme();
    const rows = this.shown();
    if (this.at >= rows.length) this.at = Math.max(rows.length - 1, 0);
    return v_flex().id("clankerhouse-machines").track_focus(this.handle).w_full().min_h(0).p(18).gap(10).bg(t.popover).text_size(13)
      .on_key_down((e, cx) => {
        if (e.key === "escape") this.close();
        else if (e.key === "down" && rows.length) this.at = (this.at + 1) % rows.length;
        else if (e.key === "up" && rows.length) this.at = (this.at + rows.length - 1) % rows.length;
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(Input.new(this.input))
      .when(this.rows === null, (el) => el.child(div().text_color(t.muted).child("Reading machines…")))
      .when(this.rows !== null && !rows.length, (el) => el.child(div().text_color(t.muted).child(this.error ?? "No machines: hc machine add user@host --name NAME --session clankerhouse")))
      .children(rows.map((row, index) => {
        const state = stateText(row);
        return h_flex().id(`machine-${row.name}`).px(10).py(6).gap(10).rounded(6).items_center()
          .when(index === this.at, (el) => el.bg(t.selection ?? t.border))
          .on_click(() => this.choose(row))
          .child(div().flex_1().truncate().text_color(state ? t.muted : t.foreground).child(row.name))
          .when(row.name === props()?.current, (el) => el.child(div().flex_none().text_color(t.muted).child("current")))
          .when(Boolean(state), (el) => el.child(div().flex_none().text_color(t.muted).child(state)));
      }));
  }
}
