# ADR-0005: Continuously Reconcile the External Herd

## Status

Accepted

## Context

Clankerhouse is inspired by a better herdr: users create or absorb a Workshop, freely add and remove tmux windows and panes, and start or stop Pi, OpenCode, or other supported harnesses directly. Existing behavior made initial Absorption and Clankerhouse launch privileged paths. New topology remained unmanaged, OpenCode suppressed lifecycle state without a preallocated Clanker ID, and some adapters manufactured identity or Recovery declarations while reporting lifecycle events.

This confused internal correlation with authority over runtime state. It also made Clankerhouse's view depend on how a harness was launched rather than what currently existed.

## Decision

Absorption establishes a Workshop-scoped Herd Reconciliation process. Clankerhouse continuously consumes external topology, process, lifecycle, host, and recovery Observations and maps them to stable internal Workshop, Terminal, and Clanker records.

Harness adapters report lifecycle reality whether or not Clankerhouse launched the process. Internal Clanker IDs are correlation tags, not prerequisites for observation and not evidence of current state. Identity-bearing claims require validation before they become actionable, while pane-addressed identity-free lifecycle reports may establish observed harness state when corroborated by a matching current process.

OpenCode's lifecycle stream is service-global, so its plugin process cannot establish a pane address from inherited environment. OpenCode state is correlated from the selected root session in process arguments or a unique current directory and pane-title match, then read from the local service API. A pane-addressed OpenCode lifecycle report is usable only when its harness session also matches independent selected-session evidence.

A supported harness started in an absorbed Workshop becomes recoverable while observed active. A graceful harness exit or manual removal while the host and Multiplexer remain healthy cancels recoverable intent. Disappearance associated with process failure, Multiplexer loss, or host loss may trigger recovery. Recovery consumes the same validated Observation model as projection and never treats raw tmux claims as current truth.

Starting a Workshop or Clanker through Clankerhouse remains a convenience that records intent before execution. It does not create a separate class of runtime entity.

## Consequences

- New windows, panes, and supported harnesses in absorbed Workshops must appear without another Absorption action.
- Manually and programmatically started harnesses follow one observation, correlation, monitoring, and recovery path.
- Adapters must not invent owned runtime state or make observation conditional on pre-existing Clanker identity.
- Stable internal identity, Display Names, and recovery intent remain durable, but external systems remain authoritative about current topology, process presence, and lifecycle state.
- Normal stop, process failure, Multiplexer loss, and host loss must be distinguished before changing recoverable intent.
- Compatibility stores and raw tmux metadata cannot remain independent identity or Recovery authorities.
