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

vim.ui.input = function(_, callback) callback(" explain this ") end
vim.cmd("normal! ggVj")
assert(vim.fn.mode() == "V", "failed to enter visual-line mode")
clankerhouse.ask()
