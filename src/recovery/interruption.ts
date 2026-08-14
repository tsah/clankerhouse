export type InterruptedWorkClass = "settled" | "interrupted_read_only" | "interrupted_expensive" | "interrupted_external" | "unknown"

export interface InterruptedWorkObservation {
  tool?: string
  command?: string
  lastSettledGeneration?: number
  currentGeneration?: number
}

const externalEffect = /\b(git\s+push|deploy|release|publish|terraform\s+apply|kubectl\s+(apply|delete)|aws\s+.*(?:create|delete|put|update)|curl\s+.*(?:-X\s*(?:POST|PUT|PATCH|DELETE)|--request\s*(?:POST|PUT|PATCH|DELETE)))\b/i
const expensive = /\b(pytest|jest|vitest|cargo\s+test|npm\s+(?:test|run\s+(?:test|lint|build))|bun\s+(?:test|run\s+(?:test|lint|build))|task\/test|integration|lint|build|testcontainers)\b/i
const readOnly = /^(?:git\s+(?:status|diff|log|show)|(?:rg|grep|find|ls|pwd)\b)/i

export const classifyInterruptedWork = (observation: InterruptedWorkObservation): InterruptedWorkClass => {
  if (!observation.tool && observation.lastSettledGeneration !== undefined && observation.lastSettledGeneration === observation.currentGeneration) return "settled"
  const command = observation.command?.trim()
  if (!command) return "unknown"
  if (externalEffect.test(command)) return "interrupted_external"
  if (expensive.test(command)) return "interrupted_expensive"
  if (readOnly.test(command)) return "interrupted_read_only"
  return "unknown"
}
