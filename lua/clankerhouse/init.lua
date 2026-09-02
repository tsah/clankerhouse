local M = {}

local selected_clanker

local function notify(message, level)
  vim.notify(tostring(message), level or vim.log.levels.INFO, { title = "clankers" })
end

local function run(args, input)
  local command = { "clankers" }
  vim.list_extend(command, args)
  local ok, process = pcall(vim.system, command, { text = true, stdin = input })
  if not ok then
    return { code = 127, stdout = "", stderr = tostring(process) }
  end
  return process:wait()
end

local function git_root(path)
  local result = vim.system({ "git", "-C", path, "rev-parse", "--show-toplevel" }, { text = true }):wait()
  return result.code == 0 and vim.trim(result.stdout) or vim.fn.fnamemodify(path, ":p")
end

local function project_anchor()
  local name = vim.api.nvim_buf_get_name(0)
  local directory = name ~= "" and vim.fn.fnamemodify(name, ":p:h") or vim.fn.getcwd()
  return git_root(directory)
end

local function list_clankers()
  local result = run({ "list", "--cwd", project_anchor() })
  if result.code ~= 0 then
    return nil, vim.trim(result.stderr) ~= "" and vim.trim(result.stderr) or "clankers list failed"
  end
  local ok, rows = pcall(vim.json.decode, result.stdout)
  if not ok or type(rows) ~= "table" then
    return nil, "Clankerhouse returned invalid clanker metadata"
  end
  return rows
end

local function send_targets(required_delivery)
  local rows, err = list_clankers()
  if not rows then return nil, err end

  local targets = {}
  for _, row in ipairs(rows) do
    local capabilities = row.capabilities
    local supports_delivery = required_delivery == nil
    for _, delivery in ipairs(capabilities and capabilities.deliveryModes or {}) do
      if delivery == required_delivery then supports_delivery = true; break end
    end
    if capabilities and capabilities.send and supports_delivery then table.insert(targets, row) end
  end
  return targets, nil, rows
end

local pane_address_env

local function decode_result(args)
  local result = run(args)
  if result.code ~= 0 then return nil end
  local ok, value = pcall(vim.json.decode, result.stdout)
  return ok and type(value) == "table" and value or nil
end

local function invoking_pane()
  if pane_address_env == nil then
    local result = run({ "mux", "pane-address-env" })
    pane_address_env = result.code == 0 and vim.trim(result.stdout) or false
  end
  if not pane_address_env or pane_address_env == "" then return nil end
  local pane = vim.env[pane_address_env]
  return pane and vim.trim(pane) ~= "" and vim.trim(pane) or nil
end

-- Capture only the caller identity before opening an input UI. Herdr focus is
-- server-global, so the Adapter's pane-address environment is more authoritative
-- than whatever happens to be focused when the user finishes typing.
local function capture_origin()
  local pane_id = invoking_pane()
  if pane_id then return { nativePaneId = pane_id } end
  return decode_result({ "mux", "current-location" })
end

-- Refresh topology after the prompt, then resolve the captured caller into it so
-- candidate positions and the target list are observed at nearly the same time.
local function proximity_context(origin)
  local snapshot = decode_result({ "mux", "observe" })
  local positions = {}
  local location

  for _, session in ipairs(snapshot and snapshot.sessions or {}) do
    for window_order, window in ipairs(session.windows or {}) do
      local window_index = tonumber(window.index) or window_order
      for pane_order, pane in ipairs(window.panes or {}) do
        local position = {
          sessionId = session.id,
          windowId = window.id,
          windowIndex = window_index,
          paneIndex = tonumber(pane.index) or pane_order,
        }
        positions[pane.id] = position
        if origin and origin.nativePaneId and pane.id == origin.nativePaneId then
          location = {
            nativeSessionId = session.id,
            nativeWindowId = window.id,
            nativePaneId = pane.id,
          }
        end
      end
    end
  end

  if not location then location = origin end
  local rankable = location and location.nativeSessionId and location.nativeWindowId
    and location.nativePaneId and positions[location.nativePaneId] ~= nil
  return { location = location, positions = positions, rankable = rankable == true }
end

local function score_less(left, right)
  for index = 1, #left do
    if left[index] ~= right[index] then return left[index] < right[index] end
  end
  return false
end

local function at_current_position(row, context)
  local position = context and context.positions[row.pane]
  if not position then return row end
  return vim.tbl_extend("force", {}, row, {
    sessionId = position.sessionId,
    window = position.windowId,
  })
end

-- Multiplexer-neutral equivalent of the historical tmux proximity search:
-- window/tab tier, session/workspace tier, then index distance inside the tier.
local function nearest(rows, context)
  local origin = context.location
  if not origin or not context.rankable then return nil end
  local origin_position = context.positions[origin.nativePaneId]
  local closest, closest_score

  for _, row in ipairs(rows) do
    local position = context.positions[row.pane]
    if position then
      local session_id = position.sessionId
      local window_id = position.windowId
      local same_session = session_id == origin.nativeSessionId
      local tier = same_session and window_id == origin.nativeWindowId and 1
        or same_session and 2
        or 3
      local window_distance = math.abs(position.windowIndex - origin_position.windowIndex)
      local pane_distance = math.abs(position.paneIndex - origin_position.paneIndex)
      local score = { tier, window_distance, pane_distance }
      if not closest_score or score_less(score, closest_score) then
        closest, closest_score = at_current_position(row, context), score
      end
    end
  end
  return closest
end

local function choose(callback, require_send, prefer_nearest, origin, exclude_origin, required_delivery)
  local rows, err, all
  if require_send then
    rows, err, all = send_targets(required_delivery)
  else
    rows, err = list_clankers()
  end
  if not rows then notify(err, vim.log.levels.ERROR); return end

  origin = origin or ((prefer_nearest or exclude_origin) and capture_origin() or nil)
  local context = prefer_nearest and proximity_context(origin) or nil
  local excluded_invoker = false
  if prefer_nearest or exclude_origin then
    local origin_pane = origin and origin.nativePaneId
    if origin_pane then
      local candidates = {}
      for _, row in ipairs(rows) do
        if row.pane == origin_pane then excluded_invoker = true else table.insert(candidates, row) end
      end
      rows = candidates
    end
  end

  if selected_clanker then
    for _, row in ipairs(rows) do
      if row.id == selected_clanker then callback(at_current_position(row, context)); return end
    end
    selected_clanker = nil
  end

  if #rows == 0 then
    local message = require_send and (excluded_invoker
        and "No other current-workshop clanker advertises native send"
        or "No current-workshop clanker advertises native send")
      or "No clankers found for the current workshop"
    if require_send and not excluded_invoker and all and #all > 0 then message = message .. " (no verified transport is available in this runtime)" end
    notify(message, require_send and vim.log.levels.ERROR or vim.log.levels.WARN)
    return
  end
  if #rows == 1 then callback(at_current_position(rows[1], context)); return end

  if prefer_nearest then
    local row = nearest(rows, context)
    if row then callback(row); return end
  end

  vim.ui.select(rows, {
    prompt = require_send and "Native Clankerhouse clanker" or "Current-workshop clanker",
    format_item = function(row)
      return string.format("%s - %s - %s", row.harness, row.name, row.id)
    end,
  }, function(row)
    if row then selected_clanker = row.id; callback(row) end
  end)
end

local function selection()
  local name = vim.api.nvim_buf_get_name(0)
  if name == "" then return nil end

  local first, last
  if vim.fn.mode():match("^[vV\22]") then
    first, last = vim.fn.line("v"), vim.fn.line(".")
  else
    first = vim.fn.line(".")
    last = first
  end
  if first > last then first, last = last, first end
  return { path = vim.fn.fnamemodify(name, ":p"), first = first, last = last }
end

local function reference(first, last)
  local name = vim.api.nvim_buf_get_name(0)
  local path = name ~= "" and vim.fn.fnamemodify(name, ":p") or "[No Name]"
  return string.format("%s:%d-%d", path, first, last)
end

local function range(args)
  local first = args.range > 0 and args.line1 or vim.fn.line(".")
  return first, args.range > 0 and args.line2 or first
end

local function contents(first, last)
  return table.concat(vim.api.nvim_buf_get_lines(0, first - 1, last, false), "\n")
end

local function send(text, follow_up, origin)
  choose(function(row)
    local args = { "send", row.id }
    if follow_up then vim.list_extend(args, { "--delivery", "follow-up" }) end
    local result = run(args, text)
    if result.code ~= 0 then
      notify(vim.trim(result.stderr), vim.log.levels.ERROR)
    else
      notify((follow_up and "Sent native follow-up to " or "Sent native message to ") .. row.name)
    end
  end, true, true, origin, false, follow_up and "followUp" or nil)
end

function M.ask()
  local selected = selection()
  local origin = capture_origin()
  if vim.fn.mode():match("^[vV\22]") then vim.cmd("normal! \27") end
  vim.ui.input({ prompt = "Ask clanker: " }, function(input)
    local message = input and vim.trim(input) or ""
    if message == "" then return end
    if selected then message = string.format("%s:%d-%d %s", selected.path, selected.first, selected.last, message) end
    send(message, false, origin)
  end)
end

M.ask_this = M.ask

local commands = {
  Ask = function() M.ask() end,
  Choose = function()
    selected_clanker = nil
    choose(function(row) selected_clanker = row.id; notify("Clanker: " .. row.name) end, true, false, capture_origin(), true)
  end,
  SendReference = function(args)
    local first, last = range(args)
    send(reference(first, last), false)
  end,
  SendContents = function(args)
    local first, last = range(args)
    send(contents(first, last), false)
  end,
  AppendContext = function(args)
    local first, last = range(args)
    send(reference(first, last) .. "\n" .. contents(first, last), true)
  end,
  Focus = function()
    choose(function(row)
      if not row.sessionId or not row.window or not row.pane then
        notify("Clankerhouse returned incomplete Multiplexer location metadata", vim.log.levels.ERROR)
        return
      end
      local result = run({
        "mux", "focus",
        "--session", row.sessionId,
        "--window", row.window,
        "--pane", row.pane,
      })
      if result.code ~= 0 then notify(vim.trim(result.stderr), vim.log.levels.ERROR) end
    end, false, true)
  end,
  Spawn = function(args)
    vim.ui.select({ "pi", "claude", "opencode", "codex" }, { prompt = "Harness" }, function(harness)
      if not harness then return end
      local prompt = args.args ~= "" and args.args or "Ready for Neovim context."
      local result = run({ "spawn", "--workshop", project_anchor(), "--name", harness, "--harness", harness, "--prompt", prompt })
      if result.code ~= 0 then notify(vim.trim(result.stderr), vim.log.levels.ERROR) end
    end)
  end,
}

local mapping_modes = {
  ask = { "n", "v" },
  send_reference = "n",
  send_contents = "v",
  send_buffer = "n",
  focus = "n",
}

local mapping_rhs = {
  ask = M.ask,
  send_reference = "<cmd>ClankerSendReference<cr>",
  send_contents = ":ClankerSendContents<cr>",
  send_buffer = "<cmd>%ClankerSendContents<cr>",
  focus = "<cmd>ClankerFocus<cr>",
}

local mapping_descriptions = {
  ask = "Clanker: ask nearest",
  send_reference = "Clanker: send reference",
  send_contents = "Clanker: send contents",
  send_buffer = "Clanker: send buffer",
  focus = "Clanker: focus nearest",
}

function M.setup(options)
  options = options or {}
  for suffix, callback in pairs(commands) do
    local command_options = { force = true }
    if suffix == "SendReference" or suffix == "SendContents" or suffix == "AppendContext" then command_options.range = true end
    if suffix == "Spawn" then command_options.nargs = "*" end
    vim.api.nvim_create_user_command("Clanker" .. suffix, callback, command_options)
  end

  for name, lhs in pairs(options.mappings or {}) do
    if lhs and mapping_rhs[name] then
      vim.keymap.set(mapping_modes[name], lhs, mapping_rhs[name], { desc = mapping_descriptions[name] })
    end
  end
end

return M
