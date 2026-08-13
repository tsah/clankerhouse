// tmux 3.6 sanitizes literal control characters in -F format arguments.
// Ask tmux to emit the printable two-character sequence "\\t" instead, while
// accepting real tabs from test doubles and older integrations.
export const tmuxFields = (...fields: string[]) => fields.join("\\t")

export const parseTmuxFields = (line: string) => line.includes("\\t") ? line.split("\\t") : line.split("\t")

export const parseTmuxRows = (output: string) => output.split("\n").filter(Boolean).map(parseTmuxFields)
