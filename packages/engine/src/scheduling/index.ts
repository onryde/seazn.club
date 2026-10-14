// @seazn/engine/scheduling — fixture generation algorithms (spec 03 §1).
//
// This barrel is NO LONGER server-only (engine-split D11; recorded decision D32h). It used to carry the warning
// "A `use client` FILE MUST NEVER IMPORT IT", because it re-exported `build.ts`, which reached `placement-client.ts`,
// which imports `@grpc/grpc-js`, which needs `net`/`tls`/`http2`/`dns`/`fs`. None of those exist in a browser, so `next build`
// died with `Module not found: dns` — an error that names nothing near the real cause. Since the solver port, `build.ts` asks
// an injected solver and imports no client: the gRPC client lives in `@seazn/scheduler`, and THAT is what a `"use client"`
// file must never import (`apps/web/src/lib/__tests__/client-graph-no-server-barrel.test.ts` derives the forbidden list from
// both packages' `exports` and fails on a chain that reaches it). This barrel is no longer on that list.
//
// **A dynamic import did NOT protect you** (the old arrangement, kept as the lesson). `build.ts` used to import the client via
// `await import(...)`, and that looked like it kept it out of the bundle. It did not: a bundler still resolves and compiles a
// dynamic import, it merely puts the result in a separate chunk, and the chunk still has to build. (That dynamic import
// existed for TEST MOCKING, not for bundle safety — and `@seazn/scheduler`'s adapter keeps the same one for the same reason.)
//
// STILL PREFER A LEAF in client code. The barrel is safe to import now, but it re-exports the whole solver, and the leaves
// ship only what a page needs; they are declared in `packages/engine/package.json`:
//
//     @seazn/engine/scheduling/bracket-layout   geometry, zero imports
//     @seazn/engine/scheduling/capacity         D2 precheck; imports only rest-floor
//     @seazn/engine/scheduling/grid-step
//     @seazn/engine/scheduling/health           D3 health score; zero imports
//     @seazn/engine/scheduling/rest-floor
//     @seazn/engine/scheduling/tz
//
// Need something client-side that has no leaf yet? ADD ONE — a module with no heavy imports of its own — and export it from
// `package.json`.

export * from "./roundrobin.ts";
export * from "./swiss.ts";
export * from "./bracket.ts";
export * from "./calendar.ts";
export * from "./constraints.ts";
export * from "./report.ts";
export * from "./americano.ts";
export * from "./feedgraph.ts";
export * from "./bracket-layout.ts";
export * from "./participants.ts";
export * from "./tz.ts";
// D2 capacity pre-check. Also reachable as `@seazn/engine/scheduling/capacity`,
// a leaf (imports only rest-floor.ts), for the same bundle reason as
// `grid-step`/`rest-floor` above — the setup card computes this client-side.
export * from "./capacity.ts";
// D3 schedule health score. Also reachable as `@seazn/engine/scheduling/health`,
// a leaf (imports NOTHING at all), for the same bundle reason as `capacity`
// above — the health panel's adapter computes fixture shaping client-side.
export * from "./health.ts";
// The build solver (this plan). Pure metrics first — no z3 anywhere in here.
export * from "./build-objectives.ts";
// The grid step both the solver and the BOARD are built from. Also reachable
// as `@seazn/engine/scheduling/grid-step`, which is how the browser takes it:
// a leaf import, so the schedule page does not ship the solvers.
export * from "./grid-step.ts";
// The rest floor the solver, the verifier and BOTH organiser panels resolve
// through. Also reachable as `@seazn/engine/scheduling/rest-floor`, a leaf, for
// the same bundle reason as `grid-step` above.
export * from "./rest-floor.ts";
export * from "./build-grid.ts";
// The control loop. It solves through the placement service — the boolean
// model it used to drive, and the LNS fallback over that model, went with the
// solver in C8.
export * from "./build.ts";
// The solver and logger ports `buildSchedule` and `repairDecomposedCpsat` take
// (engine-split D11, D25): the request/outcome types, `PlacementSolver`,
// `EngineLogger`, and `silentLogger`. Nothing here opens a socket or reads env.
export * from "./solver-port.ts";
// The repair domain and the component graph beneath the decomposed driver.
// Both solver-agnostic; the z3 encoder they used to feed is gone.
export * from "./repair-domain.ts";
export * from "./repair-decompose.ts";
export * from "./repair-minimality.ts";
// The decomposed CP-SAT driver (C9). Free to name here for the same reason
// `repair-decompose.ts` is: it names no z3 at all, and, since D11, it reaches a
// solver only through the injected `PlacementSolver` port.
export * from "./repair-decompose-cpsat.ts";
// P9 pass 2: candidate courts for a stage (tags ⊇ required, archived
// excluded, id order preserved) — the ONE function both the build-input
// assembly and validateScheduleIn filter through. Pure, zero imports.
export * from "./candidate-courts.ts";
export * from "./court-windows.ts";
