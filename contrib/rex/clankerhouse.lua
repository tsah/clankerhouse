-- Clankerhouse's Rex lane: the keys that open the picker in a floating popup over the focused pane.
--
-- Load it from the Rex server's init.lua (on the machine that runs the Rex server and the Clankerhouse daemon):
--
--   dofile("/path/to/clankerhouse/contrib/rex/clankerhouse.lua")
--
-- then run `rex config reload`. Load it on every machine whose Rex server should have a picker: each server runs its own
-- launcher, so a session on this Mac opens this Mac's picker and a session on a remote host opens that host's.
--
-- Keys default to Cmd+K (jump; replaces the app's Change Session), Cmd+B (repository), Cmd+I (needs me), Cmd+E (scratch)
-- and Shift+Cmd+K (delete this session). Set a global table before the dofile to change them, `false` to leave one
-- unbound, e.g. `clankerhouse_keys = { jump = "ctrl+alt+k", delete = false }`. CLANKERHOUSE_REX_LAUNCHER, in the
-- server's environment, overrides the launcher this file finds beside itself.

local source = debug.getinfo(1, "S").source
local root = source:match("^@?(.*)/contrib/rex/[^/]+$")
local launcher = os.getenv("CLANKERHOUSE_REX_LAUNCHER") or (root and (root .. "/bin/clankerhouse-rex"))
local terminal = "com.superlogical.terminal.shell"
-- Blocks with this label prefix are popups, never a session's pane (src/multiplexer/rex.ts).
local popup_label = "clankerhouse: picker"

local function open_popup(ctx, mode)
  if not launcher then error("clankerhouse: cannot find bin/clankerhouse-rex; set CLANKERHOUSE_REX_LAUNCHER", 0) end
  local window = nil
  if ctx.block_id then
    local described = rex.session.describe_block{ block_id = ctx.block_id }
    window = described and ((described.block and described.block.window_id) or described.window_id)
  end
  local focus = table.concat({ ctx.session_id or "", window or "", ctx.block_id or "" }, " ")
  local command = { launcher, "--popup", "--focus", focus, "--client", ctx.client_id or "" }
  if mode then table.insert(command, mode) end
  local _, err = rex.session.new_layer{
    window_id = window,
    bounds = { 0.06, 0.05, 0.88, 0.9 },
    focus = true,
    layout = { block = { flavor = terminal, label = popup_label, options = { command = command } } },
  }
  if err ~= nil then error(err, 0) end
end

local actions = {
  { id = "jump", name = "clankerhouse_jump", title = "Clankerhouse: Jump", key = "cmd+k" },
  { id = "repo", name = "clankerhouse_repo", title = "Clankerhouse: New Workshop from Repository", key = "cmd+b", mode = "--repo" },
  { id = "delete", name = "clankerhouse_delete", title = "Clankerhouse: Delete This Session", key = "shift+cmd+k", mode = "--delete" },
  { id = "scratch", name = "clankerhouse_scratch", title = "Clankerhouse: Scratch Workshop", key = "cmd+e", mode = "--scratch" },
  { id = "needs_me", name = "clankerhouse_needs_me", title = "Clankerhouse: Needs Me", key = "cmd+i", mode = "--needs-me" },
}
local keys = type(clankerhouse_keys) == "table" and clankerhouse_keys or {}

for _, action in ipairs(actions) do
  rex.action{
    name = action.name,
    title = action.title,
    category = "Clankerhouse",
    run = function(ctx) open_popup(ctx, action.mode) end,
  }
  local key = keys[action.id]
  if key == nil then key = action.key end
  if key then rex.bind(key, action.name) end
end
