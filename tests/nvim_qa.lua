local repo = assert(vim.env.CLANKERHOUSE_NVIM_QA_REPO)
local root = assert(vim.env.CLANKERHOUSE_NVIM_QA_ROOT)

vim.opt.runtimepath:prepend(repo)
vim.cmd.edit(vim.fn.fnameescape(root .. "/project/example.lua"))
vim.api.nvim_win_set_cursor(0, { 2, 0 })

local clankerhouse = require("clankerhouse")
clankerhouse.setup({ mappings = { ask = "<leader>oa" } })
assert(vim.fn.exists(":ClankerAsk") == 2, "ClankerAsk command was not registered")
assert(vim.fn.maparg("<leader>oa", "n") ~= "", "normal-mode ask mapping was not registered")
assert(vim.fn.maparg("<leader>oa", "v") ~= "", "visual-mode ask mapping was not registered")
assert(vim.fn.maparg("<leader>oa", "n", false, true).desc == "Clanker: ask nearest", "ask mapping did not describe nearest selection")

vim.ui.input = function(_, callback) callback(" explain this ") end
vim.ui.select = function() error("nearest clanker selection unexpectedly opened a picker") end
vim.cmd("normal! ggVj")
assert(vim.fn.mode() == "V", "failed to enter visual-line mode")
clankerhouse.ask()
vim.cmd("ClankerFocus")

vim.env.CLANKERHOUSE_NVIM_QA_ONLY_SELF = "1"
local self_notice
vim.notify = function(message) self_notice = tostring(message) end
clankerhouse.ask()
assert(self_notice and self_notice:match("No other current%-workshop clanker"), "the invoking pane was not excluded")
self_notice = nil
vim.cmd("ClankerChoose")
assert(self_notice and self_notice:match("No other current%-workshop clanker"), "ClankerChoose offered the invoking pane")

vim.env.CLANKERHOUSE_NVIM_QA_ONLY_SELF = nil
vim.env.CLANKERHOUSE_NVIM_QA_BROKEN_OBSERVE = "1"
local picker_opened = false
vim.ui.select = function(_, _, callback) picker_opened = true; callback(nil) end
clankerhouse.ask()
assert(picker_opened, "unresolved proximity silently chose the first Clanker")
