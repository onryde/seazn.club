// @seazn/engine/scheduling — fixture generation algorithms (spec 03 §1).
//
// *** THIS BARREL IS SERVER-ONLY. A `"use client"` FILE MUST NEVER IMPORT IT. ***
//
// It re-exports `build.ts` (below), which reaches `placement-client.ts`, which
// imports `@grpc/grpc-js`, which needs `net`/`tls`/`http2`/`dns`/`fs`. None of
// those exist in a browser, so `next build` dies with
// `Module not found: dns` — an error that names nothing near the real cause.
//
// **A dynamic import does NOT protect you.** `build.ts` imports
// `placement-client.ts` via `await import(...)`, and that looks like it keeps
// it out of the bundle. It does not: a bundler still resolves and compiles a
// dynamic import, it merely puts the result in a separate chunk. The chunk
// still has to build. (That dynamic import exists for TEST MOCKING — see the
// comment at its call site — not for bundle safety. It never provided any.)
//
// This is not hypothetical. It shipped: `bracket-panel.tsx` and `slideshow.tsx`
// imported this barrel purely for bracket GEOMETRY helpers and dragged a gRPC
// client into the browser bundle with them. The production build was broken
// from the cutover until Task 11 found it — and it was found only because E2E
// needs a prod build, which nothing in the programme had ever run.
//
// SO: client components import a LEAF, never this file. The leaves exist for
// exactly this reason and are declared in `packages/engine/package.json`:
//
//     @seazn/engine/scheduling/bracket-layout   geometry, zero imports
//     @seazn/engine/scheduling/capacity         D2 precheck; imports only rest-floor
//     @seazn/engine/scheduling/grid-step
//     @seazn/engine/scheduling/health           D3 health score; zero imports
//     @seazn/engine/scheduling/rest-floor
//     @seazn/engine/scheduling/tz
//
// Need something client-side that has no leaf yet? ADD ONE — a module with no
// server-only imports of its own — and export it from `package.json`. Do not
// widen a client component's reach to this barrel.
//
// Nothing enforces this mechanically today. `tsc`, `vitest`, `eslint` and the
// drift gates are all blind to it; only a full `next build` catches it, and
// that runs on PULL REQUESTS only, so a local merge pushed straight to `main`
// skips it entirely.

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
// The repair domain and the component graph beneath the decomposed driver.
// Both solver-agnostic; the z3 encoder they used to feed is gone.
export * from "./repair-domain.ts";
export * from "./repair-decompose.ts";
export * from "./repair-minimality.ts";
// The decomposed CP-SAT driver (C9). Free to name here for the same reason
// `repair-decompose.ts` is: it names no z3 at all, and `build.ts`'s own
// dynamic import already keeps `placement-client.ts`'s gRPC dependency out of
// a client bundle.
export * from "./repair-decompose-cpsat.ts";
