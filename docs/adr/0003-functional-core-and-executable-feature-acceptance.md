# ADR-0003: Functional core and executable feature acceptance

- Status: Accepted
- Date: 2026-08-15

## Context

Clankerhouse crosses durable state, multiplexers, processes, Git, systemd, a Unix socket, a TypeScript daemon, a native TUI, and several harness integrations. Component tests can all pass while product behavior is wrong at a boundary: a projection can render one Workshop twice, or a daemon can open the correct target for the wrong client.

Effect provides typed composition, services, Layers, scopes, retries, and test clocks, but Effect alone does not make code functional or testable. Domain decisions must not depend on live commands, ambient environment, wall-clock time, or mutable singleton state.

## Decision

Clankerhouse uses a functional core with an Effect-based imperative shell.

The functional core consists of ordinary deterministic TypeScript functions. Inputs are validated observations, intents, and durable state. Outputs are decisions, plans, events, invariant violations, or new state. Core functions do not execute multiplexer, filesystem, Git, process, socket, database, or clock effects.

New or materially refactored orchestration uses Effect services and Layers for those capabilities. Production Layers call real adapters. Unit tests call the core directly and use deterministic test Layers/TestClock for Effect use-case orchestration. Adapter contract tests validate translation at each boundary. Existing async adapters are migrated incrementally; accepting this ADR does not claim that every legacy shell, notably the current Recovery controller, has already been converted to Effect.

The first explicit diagnostic core is `src/diagnostics.ts`; the authoritative projection comparator is exported from `src/model.ts`; and `src/recovery/planner.ts` extracts one-Clanker Recovery decisions from the async controller. Existing pure projection, tree, Recovery admission/campaign, protocol parsing, and mutation-stage functions remain core seams. New behavior must deepen these seams rather than add policy to `src/daemon.ts`, shell scripts, or the native renderer.

Every product feature is recorded in `docs/features.json` and must have:

1. unit coverage when it contains core policy;
2. at least one standalone end-to-end scenario using real product adapters;
3. manual-agent judgement steps.

`scripts/check-feature-coverage` enforces the traceability rules. The repository-level `./test` script is the sole complete automated entrypoint. Existing package QA commands remain compatibility aliases.

Project Agent Skills under `.agents/skills/` provide complete manual QA and read-only-first troubleshooting to both Pi and OpenCode. Automated assertions provide evidence; the agent judges semantic and visual correctness against the feature catalogue.

## Standalone environment rule

End-to-end scenarios isolate `HOME`, all XDG directories, multiplexer server sockets, installation prefixes, Git repositories, databases, runtime sockets, and harness fixtures. They may fake external harness programs and host signals, but not the Clankerhouse seam under test. A host-adapter scenario may use a uniquely named disposable systemd scope in the current user manager when systemd itself is the seam under test; it must not address any installed Clankerhouse unit. No standalone scenario may inspect or mutate the live installation.

## Consequences

- Core policy is fast and deterministic to test.
- Effect programs become orchestration rather than hidden policy.
- Cross-component regressions require standalone scenarios as well as unit tests.
- Feature work is incomplete until catalogue coverage is updated.
- Full acceptance is slower, so `./test --unit` and `./test --standalone` remain available while local/release acceptance uses `./test`. CI may run the portable unit profile plus explicitly provisioned adapter suites until its runner provides every required host capability; that narrower CI result is not a release acceptance.
- The native renderer and TypeScript daemon must consume the same domain contract and satisfy the feature scenarios at their socket boundary.
