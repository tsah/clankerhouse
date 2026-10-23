# ADR-0005: Continuously Reconcile the External Herd

## Status

Accepted. Partly superseded by ADR-0009 (2026-10-23): recoverable intent and automatic recovery are retired. Observed harnesses now become Clanker Ledger rows, and an interrupted Clanker returns only through an explicit `clankers resume`.

## Context

Clankerhouse is inspired by a better herdr: users create or absorb a Workshop, freely add and remove multiplexer windows and panes, and start or stop Pi, OpenCode, or other supported harnesses directly. Existing behavior made initial Absorption and Clankerhouse launch privileged paths. New topology remained unmanaged, OpenCode suppressed lifecycle state without a preallocated Clanker ID, and some adapters manufactured identity or Recovery declarations while reporting lifecycle events.

This confused internal correlation with authority over runtime state. It also made Clankerhouse's view depend on how a harness was launched rather than what currently existed.

## Decision

Absorption establishes a Workshop-scoped Herd Reconciliation process. Clankerhouse continuously consumes external topology, process, and lifecycle Observations and maps them to stable internal Workshop, Terminal, and Clanker records.

Harness adapters report lifecycle reality whether or not Clankerhouse launched the process. Internal Clanker IDs are correlation tags, not prerequisites for observation and not evidence of current state. Identity-bearing claims require validation before they become actionable, while pane-addressed identity-free lifecycle reports may establish observed harness state when corroborated by a matching current process.

OpenCode's server plugin stream is service-global, so its plugin process cannot establish a pane address from inherited environment. Clankerhouse does not correlate OpenCode service sessions to panes itself: an OpenCode pane's current state is the Multiplexer's runtime agent status, which Herdr's pane-local OpenCode TUI reporter makes exact for the pane's selected root session. An identity-free pane-addressed OpenCode lifecycle report is usable only when its harness session also matches independent selected-session evidence; a report claiming owned identity follows the ordinary exact-correlation rule.

A supported harness started in an absorbed Workshop becomes recoverable while observed active. A graceful harness exit or manual removal while the host and Multiplexer remain healthy cancels recoverable intent. Disappearance associated with process failure, Multiplexer loss, or host loss may trigger recovery. Recovery consumes the same validated Observation model as projection and never treats raw multiplexer claims as current truth. *(Superseded by ADR-0009: an observed harness becomes a Clanker Ledger row instead, and nothing is relaunched automatically.)*

Starting a Workshop or Clanker through Clankerhouse remains a convenience that records intent before execution. It does not create a separate class of runtime entity.

## Consequences

- New windows, panes, and supported harnesses in absorbed Workshops must appear without another Absorption action.
- Manually and programmatically started harnesses follow one observation, correlation, monitoring, and Clanker Ledger path.
- Adapters must not invent owned runtime state or make observation conditional on pre-existing Clanker identity.
- Stable internal identity, Display Names, and Clanker Ledger records remain durable, but external systems remain authoritative about current topology, process presence, and lifecycle state.
- A Clanker that ends while its Multiplexer server keeps running must be distinguished from one lost with the Multiplexer or host before its Clanker Ledger row is closed.
- Compatibility stores and raw multiplexer metadata cannot remain independent identity authorities.
