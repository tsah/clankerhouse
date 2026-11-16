-- Clankerhouse's Rex lane observation: every session, window and block on the server, with each
-- terminal's processes and program status, in one round trip. Prints one JSON document.
local terminal = "com.superlogical.terminal"
local function call(method, args)
  local result, err = rex.call(method, args or {})
  if result == nil then error(method .. ": " .. tostring(err), 0) end
  return result
end
local status = call("server.status")
local out = { host_id = status.host_id, instance_id = status.instance_id, pid = status.pid, sessions = {} }
-- A connection reads a session's view only once it is attached to that session.
local list = call("session.list")
for _, entry in ipairs(list.sessions or {}) do
  rex.session.attach{ session_id = entry.session_id }
  local view = rex.call("session.view", { session_id = entry.session_id })
  if view ~= nil then
    local session = { session_id = view.session_id, label = view.label, active_window_id = view.active_window_id, windows = {} }
    for _, window in ipairs(view.windows or {}) do
      local w = { window_id = window.window_id, label = window.label, focused_block_id = window.focused_block_id, blocks = {} }
      for _, layer in ipairs(window.layers or {}) do
        for _, block in ipairs(layer.blocks or {}) do
          local b = { block_id = block.block_id, label = block.label, creator = block.creator_name, layer = layer.kind }
          if block.creator_name == terminal then
            local args = { session_id = view.session_id, block_id = block.block_id }
            b.process = rex.block.call(terminal, "process", args)
            b.program_status = rex.block.call(terminal, "program_status", args)
            local title = rex.block.call(terminal, "title", args)
            b.title = title and title.title or ""
          end
          table.insert(w.blocks, b)
        end
      end
      table.insert(session.windows, w)
    end
    table.insert(out.sessions, session)
  end
end
-- Which sessions each app shows: the picker marks them attached.
out.clients = {}
local clients = rex.call("client.list", {})
for _, client in ipairs((clients and clients.clients) or {}) do
  local kind = client.info and client.info.kind
  if kind == "app" or kind == "ios" then
    local inspected = rex.call("client.inspect", { client_id = client.client_id })
    local ids = inspected and inspected.client and inspected.client.session_ids or {}
    table.insert(out.clients, { client_id = client.client_id, kind = kind, session_ids = ids })
  end
end
print(rex.json.encode(out))
