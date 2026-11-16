-- Clankerhouse's Rex lane: the keys that open the picker in a floating popup over the focused pane.
--
-- Load it from the Rex server's init.lua (on the machine that runs the Rex server and the Clankerhouse daemon):
--
--   dofile("/path/to/clankerhouse/contrib/rex/clankerhouse.lua")
--
-- then run `rex config reload`. CLANKERHOUSE_REX_LAUNCHER, in the server's environment, overrides the launcher this file
-- finds beside itself. CLANKERHOUSE_REX_KEYS=off defines the actions without binding any keys.

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
  { name = "clankerhouse_jump", title = "Clankerhouse: Jump", key = "alt+k" },
  { name = "clankerhouse_repo", title = "Clankerhouse: New Workshop from Repository", key = "alt+b", mode = "--repo" },
  { name = "clankerhouse_delete", title = "Clankerhouse: Delete This Session", key = "alt+d", mode = "--delete" },
  { name = "clankerhouse_scratch", title = "Clankerhouse: Scratch Workshop", key = "alt+n", mode = "--scratch" },
  { name = "clankerhouse_needs_me", title = "Clankerhouse: Needs Me", key = "alt+i", mode = "--needs-me" },
}

for _, action in ipairs(actions) do
  rex.action{
    name = action.name,
    title = action.title,
    category = "Clankerhouse",
    run = function(ctx) open_popup(ctx, action.mode) end,
  }
  if os.getenv("CLANKERHOUSE_REX_KEYS") ~= "off" then rex.bind(action.key, action.name) end
end
