export interface ProjectionRevision {
  source: string
  sequence: number
}

export interface ProjectionSnapshot<T> {
  version: number
  revision: ProjectionRevision
  generatedAt: number
  sessions: T[]
}

const validRevision = (value: unknown): value is ProjectionRevision => {
  if (!value || typeof value !== "object") return false
  const revision = value as Partial<ProjectionRevision>
  return typeof revision.source === "string"
    && revision.source.length > 0
    && Number.isSafeInteger(revision.sequence)
    && Number(revision.sequence) >= 0
}

export const parseProjectionSnapshot = <T>(value: unknown, expectedVersion: number): ProjectionSnapshot<T> | undefined => {
  if (!value || typeof value !== "object") return undefined
  const candidate = value as Partial<ProjectionSnapshot<T>>
  if (candidate.version !== expectedVersion || !Array.isArray(candidate.sessions)) return undefined

  const generatedAt = Number(candidate.generatedAt ?? 0)
  if (!Number.isFinite(generatedAt) || generatedAt < 0) return undefined
  const revision = candidate.revision ?? { source: "legacy", sequence: Math.floor(generatedAt) }
  if (!validRevision(revision)) return undefined

  return {
    version: expectedVersion,
    revision,
    generatedAt,
    sessions: candidate.sessions,
  }
}

export const advanceProjection = <T>(
  previous: ProjectionSnapshot<T> | undefined,
  sessions: readonly T[],
  version: number,
  source: string,
  generatedAt = Date.now(),
): ProjectionSnapshot<T> => ({
  version,
  revision: {
    source,
    sequence: previous?.version === version && previous.revision.source === source
      ? previous.revision.sequence + 1
      : 1,
  },
  generatedAt,
  sessions: [...sessions],
})

export const shouldApplyProjection = (current: ProjectionRevision | undefined, next: ProjectionRevision) =>
  !current || next.source === "legacy" || next.source !== current.source || next.sequence > current.sequence
