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
| `./pad` | the scoring pad's rule facts, declared once beside the fold: per-sport record types and `padSpec` lookups; phone-safe |
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
| `./phone-subpaths.json` | a data file, not a module: the phone-safe subpaths and the pinned closure (see below) |

Importing a subpath registers nothing: the sport registry is filled only by an explicit `registerBuiltins(registry)`.

### Phone-safe subpaths

The phone-safe subpaths are `./core`, `./sport`, `./sports`, `./sports/*` and `./pad`. They are listed in `phone-subpaths.json` (also exported as
`./phone-subpaths.json`, and shipped in the package), which pins the closure too: `closure.modules` is the sorted set of modules those
subpaths reach by value import. Its entries are `src/` paths, the workspace's own; the package ships their compiled twins, the `.js` file
of the same name under `dist/`.

`pnpm boundary` (run in CI) walks that closure statically, on the workspace source, and fails on any of:

- an import of a Node builtin (`node:fs`, `path`, `fs/promises`, ...), by `import`, `export ... from`, `import()` or `require()`;
- a use of the Node globals `process`, `Buffer`, `__dirname` or `__filename`: the bare name, `globalThis.` / `global.` / `window.` /
  `self.` followed by `process` or `Buffer` (dotted, or by a quoted or backtick name in brackets), or `const { process: p } = globalThis`.
  The rule reads names and does not resolve scopes, so a binding of the name (`const process = ...`, a parameter called `process`) is
  refused as well. Only a property position is allowed: `x.process`, `x?.process`, an object key and a type member;
- an import of anything under `src/scheduling/`, of a file that does not exist, or of a path that leaves `src/`;
- an `import()` or `require()` whose module is not exactly one string literal (a variable, a template, `"./" + x`);
- an import of the engine by its own package name (the walk follows relative paths, so that edge would be invisible);
- an import of a package that `package.json` declares neither as a dependency nor as a required peer;
- a closure that no longer equals `closure.modules` (a new module on a phone is a reviewed change: re-pin it in the same commit).

Not checked, so do not rely on the gate for them: `eval`, `new Function`, `Reflect.get(globalThis, "process")`, an alias
(`const g = globalThis; g.process`), a computed global lookup, a type query of a module (`typeof import("node:fs")`, which loads
nothing), and anything the platform defines at run time. The walk reads the code with the TypeScript parser's idea of what is a string, a
comment or a regular expression, then matches text; it does not type-check or run anything.

Nothing is executed on Hermes. The packed-tarball proof (`pnpm pack:proof`, rn leg) bundles an entry that imports the phone subpaths from
the packed tarball with Metro, requires the development bundle to hold exactly the modules the walk found (their `dist/` twins), and
compiles the production bundle with `hermesc`: a bundle Hermes accepts, not one it has run. The types leg compiles the declarations
with `@types/node` present (`types: ["node"]`), so it cannot see a `.d.ts` that leaks a Node type.

## Peer dependencies

- `zod` is required (`^4.4.3`). The consumer owns the one zod instance the schemas are built with.
- `fast-check` and `vitest` are optional. Only `./testkit` loads them (its conformance suite runs under vitest), so
  install them if you import it and skip them otherwise.

## What ships

`dist/` (compiled `.js`, `.d.ts` and source maps that carry their sources), `rules/` (the rules reference tables) and `phone-subpaths.json`.
