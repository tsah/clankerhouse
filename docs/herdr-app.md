# Clankerhouse on the Herdr desktop app

The Herdr TUI experience on the desktop app: a clean full-window terminal, no sidebar, the Clankerhouse switcher as a popup, and
the same Alt keys. The app runs on your laptop (Omarchy now, macOS later), and Clankerhouse and every clanker stay on the boxes
(puffin, and any other you add), in the hc lane. Herdr TUI remains the default multiplexer; nothing here moves live sessions.

**Each box is its own herd.** Every box runs its own Clankerhouse: daemon, registry, Workshops, hooks. The app follows the box
you are looking at and gives you that box's Clankerhouse. Nothing is shared across boxes: Alt-K, Alt-I and the `N need you · M
open` count show one box at a time, and there is no needs-me list across all of them.

Test status is in [herdr-core-eval.md](herdr-core-eval.md) under "Desktop app path". Real ssh, Hyprland and macOS are not yet
verified.

## How it fits together

- `contrib/herdr-app/layouts/clankerhouse.json`: the bare layout.
- `contrib/herdr-app/mods/clankerhouse/`: runs the popups, sends the keys the app has no command for, and reports focus to the
  current machine.
- `contrib/herdr-app/mods/clankerhouse-machines/`: the Alt-M machine list.
- `contrib/herdr-app/keys.clankerhouse.json`: the Alt keys, only while this layout is shown.
- `clankerhouse-hc --popup` on the current machine: the picker, exiting after a choice. The mod then moves focus.
- Clanker terminals carry `herdr.space` and `herdr.tab` labels, so each gets a space and a tab in the app by itself. A session is a
  space, and a window is a tab.

## Setup

### 1. On each box

Start the lane (it runs beside the Herdr TUI lane; the daemon is the `clankerhouse-daemon-hc` user unit):

```bash
clankerhouse-hc --ensure-server
```

### 2. Install the app

Install it on the laptop, then start it once so it writes `~/.config/herdr-app`:

```bash
curl -fsSL https://releases.herdr.dev/app/install.sh | sh
```

- **Omarchy:** needs a Wayland session with Vulkan, which Omarchy has. Upstream issue #123 (no input when the compositor advertises
  more than one `wl_seat`) should not apply to a stock Hyprland.
- **macOS:** Apple Silicon only. It installs to `~/Applications/Herdr.app` and links `~/.local/bin/herdr-app`.

### 3. Add puffin as a machine

Your ssh key must reach puffin without a prompt, and `hc` must be on puffin's non-interactive `PATH`.

```bash
hc machine add tsah@puffin --name puffin --session clankerhouse
hc machine ls
```

`--session clankerhouse` matters: without it the app connects to puffin's default session and sees none of the lane, and
Alt-K/B/D fail with a notification naming the session they ran in. `hc machine` cannot change a session in place: `hc machine
rm puffin`, then add it again.

### 4. Install the config

From a checkout on the laptop:

```bash
contrib/herdr-app/install --machine puffin --launcher clankerhouse-hc
herdr-app do layout.switch --name clankerhouse
herdr-app check ~/.config/herdr-app/mods/clankerhouse
herdr-app check ~/.config/herdr-app/mods/clankerhouse-machines
```

`--machine` is only the fallback, used until a terminal on some machine has been focused. Re-run the installer after pulling, so
the app gets the new mods; adding a box does not need it.

The installer needs `python3`. It replaces only the `layout:clankerhouse` section of `keys.json` and keeps the old file as
`keys.json.pre-clankerhouse`. On macOS it also sets `option_as_alt` to `on`, drops the layout's custom title bar, and removes
`alt-left` and `alt-right` from the `terminal` section (a `terminal` key beats a layout key).

Check `herdr-app status` for errors. To back out, `ctrl-shift-l` switches layouts, and `ctrl-alt-shift-escape` always resets.

## More than one box

### Add a box

1. On the new box: a normal Clankerhouse install (see the README) and the hc lane, as in step 1: `clankerhouse-hc
   --ensure-server`, which starts the `clankerhouse-daemon-hc` unit. `hc` must be on its non-interactive `PATH`.
2. On the laptop, add it with the lane's session, as in step 3:

   ```bash
   hc machine add user@host --name NAME --session clankerhouse
   ```

The same `--session clankerhouse` rule applies. No reinstall of the app config is needed.

### Which box is current

- **The focused terminal decides.** A terminal's address names its machine (`heron/t3` is on `heron`). Alt-K, Alt-B, Alt-D,
  Alt-N, Alt-I, Alt-G, focus reporting and the count all go to that machine. Leftover `ch_popup` terminals are cleaned up on that
  machine only.
- **Alt-M picks one from a list**: every machine `hc machine ls` shows, the current one marked. Up/Down or type to filter, Enter
  or click to switch, Esc to close. A machine that is not connected is listed with its state (`unreachable`, `needs login`) and
  cannot be chosen. Choosing one shows its first space if it has one; with none, it still becomes current, so Alt-K opens its
  list. The choice holds until you focus another terminal, which then decides again.
- **With nothing focused**, or a pane local to the app, the last machine stays current, else the installer's `--machine`.
- **The top bar** shows the current machine, then its `N need you · M open`. A box's count is shown only once that box has
  answered; another box's count is never shown in its place.
- Space names from Workshop titles are kept up to date on every machine, and a popup asked for by any machine opens.
- **Focus reported to the box you left** goes stale there after 3 minutes, as when the window closes.


The same Alt chords as `~/.config/herdr/config.toml`, 1:1. On macOS, press Option for Alt.

| Key | TUI | App |
|---|---|---|
| Alt-K | Clankerhouse: the one Workshop list, flat | Same, as a popup |
| Alt-B | Open or create branch | Same, as a popup |
| Alt-D | Delete current session | Same, as a popup; in the picker, Done or delete the selected row |
| Alt-N | Scratch workshop | Same, as a popup |
| Alt-I | The same list in its needs-me view: the Workshops waiting on you, freshest first | Same, as a popup |
| Alt-E, Alt-F | In the open list only: eldest first, and flat | Pass-through to the popup |
| Alt-O | Go to | App's picker (`mod.open:picker`) |
| Alt-G | Open current PR | `gh` on the current machine, opened in the laptop's browser |
| Alt-M | (none: the TUI runs on one box) | The machine list: switch the current machine |
| Alt-Enter | Split, new pane below | `pane.split:down` |
| Alt-Shift-Enter | Split, new pane right | `pane.split:right` |
| Alt-W | Close pane | `pane.close` |
| Ctrl-Alt-arrows | Focus pane | `pane.go` |
| Alt-T | New tab | `tab.new` |
| Alt-Left / Alt-Right | Previous / next tab | `tab.prev` / `tab.next` |
| Alt-Shift-Left / Right | Move tab | The mod, via `tab.move` |
| Alt-1..9 | Switch tab | `tab.select` |
| Alt-Up / Alt-Down | Previous / next workspace | `space.prev` / `space.next` |

**Could not be mirrored:**

| Key | Why | What happens instead |
|---|---|---|
| Alt-J (copy mode) | The app has no copy mode | Passes to the program. Use the mouse and scrollback. |
| Ctrl-Alt-Shift-arrows (resize) | The app has no split-resize command (upstream #117) | Unbound. Drag the divider. |
| `ctrl+b` prefix chords | Out of scope: Alt keys only | `ctrl+b` reaches the program |

## Key conflicts

**Omarchy / Hyprland** (checked against `basecamp/omarchy` at bda3aaf): no mirrored chord is claimed. The near misses:

- **Right Alt with dictation enabled.** Omarchy binds `ALT + Alt_R` to push-to-talk when a dictation backend is installed. Use left
  Alt for the chords, or check that this does not fire.
- Omarchy keeps `ALT + TAB`, `CTRL + ALT + TAB` and `CTRL + ALT + DELETE`. None of them is a TUI chord.
- Your own `~/.config/hypr` overrides were not checked.

**herdr-app defaults** that the layout overrides, only while it is shown:

| Key | App default | Now |
|---|---|---|
| Alt-1..9 | `space.select` | `tab.select` |
| Alt-Left / Alt-Right | `pane.go` | `tab.prev` / `tab.next` |
| Alt-Up / Alt-Down | `agent.prev` / `agent.next` | `space.prev` / `space.next` |
| Alt-K, Alt-J | `pane.go` | Popup; pass-through |
| Alt-H, Alt-L, Alt-Shift-H/J/K/L, Alt-[, Alt-] | Pane and tab moves | Pass-through, as in the TUI |
| Alt-S | Snooze the selected row in the list | Pass-through to the popup |
| Alt-E, Alt-F | The list's eldest-first and flat views | Pass-through to the popup |

**Alt-M was checked free** on 2026-11-12 in every layer: the app's defaults (Alt binds 1-9, H/J/K/L, Shift-H/J/K/L, `[`, `]`,
arrows), the Herdr TUI config and the Clankerhouse managed block (K, B, D, N, I, G, O, T, W, J, Enter, arrows, 1-9), this
layout's keys and pass-throughs (H, J, L, Shift-H/J/K/L, `[`, `]`, S, E, F), and the picker's own Alt keys (I, E, F, K, B, N, S,
R, A, L, D, `.`). Omarchy's binds were not re-checked for it.

The app's Ctrl-Shift defaults stay, so `ctrl-shift-p` still opens the palette. Mod commands such as `clankerhouse.jump` are not
listed in the palette: `commands()` is documented as leaving them out, and that was not checked in the palette itself.

**macOS:**

- `option_as_alt: on` means Option no longer types characters in the terminal, on any keyboard layout. The default `auto` only
  applies to US and ABC layouts, so it would break the chords on other layouts. To keep Option typing, set it back to `auto` and
  accept that.
- Option-Left and Option-Right lose word motion in the shell, because they are tab keys here.
- Ctrl-Option-arrows are free on stock macOS, but window managers such as Rectangle commonly claim them.

**Non-Latin layouts** (Hebrew, for example): whether a chord matches by key position or by character was not tested.

## Things to know

- **Do not take core updates for a remote machine.** The app offers them ("herdr-core 0.1.15 is ready"). `hc machine update`
  restarts hc on that box, under every clanker there. Updates to the laptop's own core are fine, as long as every box still
  connects.
- **Closing the window leaves everything running.** After 3 minutes each box treats the reported focus as stale.
- **Adoption turns on hc keep.** If a holder is lost, a clanker's terminal becomes a shell at the same address. The harness is not
  re-run, and its claims stay on the terminal.
- **Status.** With no sidebar, you learn of agents through toasts and sounds, and in the switcher. The top bar's right end shows
  the current machine and its `N need you · M open`, the count of the list's needs-me views (Alt-I, Alt-E), refreshed with the
  focused session's row (on focus and every 15 seconds).
- **A popup left open when the app dies** stays on its box as a terminal labelled `ch_popup`. The next popup on that box removes
  it, and Clankerhouse never shows it.
- **Esc in the switcher goes back a level first.** Press it again to close, as in the TUI.
