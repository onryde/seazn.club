# @onryde/seazn-engine

The pure tournament engine behind [seazn.club](https://seazn.club): an event-sourced kernel (match events fold into
state), the sport modules built on it, competition structure and standings, fixture generation and a scheduling toolkit.
It has no effectful dependencies: no database, no network, no logger.

The source lives in the seazn.club monorepo (`packages/engine`). Design:
[docs/superpowers/specs/2026-10-13-engine-split-design.md](https://github.com/onryde/seazn.club/blob/main/docs/superpowers/specs/2026-10-13-engine-split-design.md).

## Install

Published to GitHub Packages under the `@onryde` scope. Point the scope at the registry and authenticate with a token that
can read packages:

```ini
# .npmrc
@onryde:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Code in seazn.club imports the package as `@seazn/engine`, so install it under that alias and the same specifiers work:

```sh
pnpm add @seazn/engine@npm:@onryde/seazn-engine@<version> zod
```

ESM only.

## Subpaths

Import only from these. Nothing else in the package is public.

| Subpath | What it is |
| --- | --- |
| `./core` | event kernel and shared primitives |
| `./sport` | the `SportModule` contract, the registry and the position catalog |
| `./sports` | every shipped sport module, aggregated (`builtinModules`, `registerBuiltins`) |
| `./sports/*` | one sport module, by directory name |
| `./stats` | the player statistics fold |
| `./competition` | the sport-agnostic competition engine: stages, standings, tiebreakers, progression |
| `./exports` | pure document-model builders |
| `./history` | pure undo and redo over the division ledger |
| `./import` | the pure bulk-import planner |
| `./officials` | the officials assignment pass |
| `./scheduling` | fixture generation algorithms |
| `./scheduling/bracket-layout` | two-sided bracket geometry |
| `./scheduling/calendar` | calendar slotting |
| `./scheduling/court-windows` | court availability windows |
| `./scheduling/capacity` | the capacity pre-check |
| `./scheduling/grid-step` | the schedule grid's step |
| `./scheduling/health` | the schedule health score |
| `./scheduling/rest-floor` | an entrant's rest floor |
| `./scheduling/swiss` | Swiss pairing |
| `./scheduling/tz` | time-zone arithmetic |
| `./testkit` | conformance suites and the simulation harness, for sport-module authors |

Importing a subpath registers nothing: the sport registry is filled only by an explicit `registerBuiltins(registry)`.

The phone-safe subpaths are `./core`, `./sport`, `./sports` and `./sports/*` (listed in `phone-subpaths.json`, which also pins the
closure: the modules they reach by value import). Every module of that closure imports no Node builtin and nothing from `./scheduling`,
names no `process` (the identifier, or `globalThis.process`, `global.process`, `window.process`, `self.process`), imports only packages
the engine declares as a dependency or a required peer, and never imports the engine by its own package name, so a React Native app can
import them. `pnpm boundary` walks that closure statically and fails on any of these, and when the closure no longer matches the pin
(a new module on a phone is a reviewed change). The walk reads text, so it cannot see an alias (`const g = globalThis; g.process`) or a
computed global lookup; the packed-tarball proof bundles the closure with Metro, compiles the bundle with Hermes and requires the
bundle to hold exactly the modules walked.

## Peer dependencies

- `zod` is required (`^4.4.3`). The consumer owns the one zod instance the schemas are built with.
- `fast-check` and `vitest` are optional. Only `./testkit` loads them (its conformance suite runs under vitest), so
  install them if you import it and skip them otherwise.

## What ships

`dist/` (compiled `.js`, `.d.ts` and source maps that carry their sources) and `rules/` (the rules reference tables).
