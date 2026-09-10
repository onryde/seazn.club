// Driving a stateful client island without a DOM — shared test harness.
//
// vitest runs `environment: "node"` here and the workspace has no jsdom, so a
// `useState` component cannot be clicked: calling it directly throws "Invalid
// hook call". That leaves the JOIN between a component's state and whatever it
// posts unwitnessed by every other layer — the class of bug where one token
// ("event_pass" for `passKey`; the generic error key for `extraOrgsErrorKey`)
// passes every suite AND `tsc`, and only a human clicking would notice.
//
// So this supplies React's hook dispatcher itself. `useState` is one slot of
// `internals.H`; it needs a cursor, an array of cells, and a re-render on `set`.
// `useEffect`, `useMemo` and `useContext` are here too — an island that FETCHES
// its data on mount (the create-org form's billing groups) renders an empty
// shell without effects, so every assertion about what it draws would be
// vacuous, and `useMsg` reads a context to find its copy. It is deliberately
// NOT a general React renderer — it renders one function component one level
// deep and returns the element tree, which is all a click needs.
//
// Why this rather than adding jsdom: jsdom is a dependency for every suite in
// the workspace and a build-time cost forever, to cover a handful of lines.
// This is ~40 test-only lines that touch nothing else.
//
// How it fails when React changes: `react` is pinned to an exact version
// (package.json "react": "19.2.4", no caret). If a future upgrade moves the
// dispatcher slot, the guard below throws with a message naming this file, and
// every test using it reds — loudly, not silently.
//
// Extracted from pass-upgrade.test.tsx (v17 #294) when the Add-ons control
// (v17 gap #293) needed the same thing, rather than copied: two hand-maintained
// copies of a dispatcher shim is precisely the drift this repo keeps a
// duplicate-resolver test about.
import { isValidElement, type ReactElement, type ReactNode } from "react";
import * as ReactRuntime from "react";

type Cell = unknown;
type Deps = unknown[] | undefined;

interface HookDispatcher {
  useState: (initial: Cell) => [Cell, (next: Cell) => void];
  /** Mount/update effects. Collected during render and run after it, exactly
   *  as React does — a component that LOADS its data in an effect (the create-
   *  org form's billing groups) renders an empty shell without this, and every
   *  assertion about what it draws afterwards would be vacuous. */
  useEffect: (create: () => void | (() => void), deps: Deps) => void;
  /** Same machinery as `useEffect`, its own cell list, committed BEFORE the
   *  passive ones — React's own order. Added for `OverlayStage`, whose canvas
   *  scale is a `useLayoutEffect`: without a slot here the dispatcher hands
   *  back `undefined` and the component cannot be driven at all, which is why
   *  the overlay's delay behaviour could only ever be asserted through
   *  `renderToStaticMarkup` (one frozen instant, no timers, no effects) — and
   *  a delay is a thing that happens over TIME. Nothing else in the repo calls
   *  `useLayoutEffect` under this harness today, so this is purely additive. */
  useLayoutEffect: (create: () => void | (() => void), deps: Deps) => void;
  /** Memoised by `deps`, exactly like `useEffect` below — NOT straight through.
   *  "A cache, never a behaviour" is false the moment a memo result becomes a
   *  `useEffect` dependency, which is the ordinary React idiom: recomputing it
   *  every render hands the effect a new identity every render, so the effect
   *  re-runs every render — and if it sets state, that is an infinite loop.
   *  A harness that re-runs what production runs once is not a harness. */
  useMemo: (create: () => Cell, deps: Deps) => Cell;
  /** Memoised by `deps` like `useMemo`, and kept in its own cell list. Only the
   *  identity is memoised: the function returned on a render whose deps changed
   *  must be the NEW one, or it closes over stale state for ever. */
  useCallback: (fn: Cell, deps: Deps) => Cell;
  /** The SAME mutable box on every render. A component's in-flight guard is a
   *  ref precisely because state is read through a closure a second click can
   *  beat; a box minted per render would let every such guard pass untested. */
  useRef: (initial: Cell) => { current: Cell };
  /** A whole console's state in one cell. The AI consoles hold theirs in a
   *  reducer, so without this they cannot be driven at all — and the gate that
   *  decides whether a paid run may be POSTed is a line INSIDE one of their
   *  callbacks, invisible to every static render. `dispatch` is stable, the way
   *  React's is: it is the canonical stable `useEffect` dependency, and a fresh
   *  identity per render would re-fire every effect keyed on it. */
  useReducer: (
    reducer: (state: Cell, action: Cell) => Cell,
    initialArg: Cell,
    init?: (arg: Cell) => Cell,
  ) => [Cell, (action?: Cell) => void];
  /** The context's DEFAULT value — there is no provider tree here. That is the
   *  production path for the copy hooks (`useMsg` falls back to the English
   *  catalog outside a `DictProvider`), so the sentences a test reads are the
   *  shipped English ones. */
  useContext: (context: { _currentValue: Cell }) => Cell;
  /** Always the SERVER snapshot, never `subscribe`/`getSnapshot` — this
   *  environment has no `window` (`environment: "node"`, no jsdom), and a
   *  browser-backed store (`v3/scorebug.tsx`'s `useIsPhone`, a `matchMedia`
   *  subscription) would throw reading it. Real React does the same thing
   *  during SSR — `getServerSnapshot` exists precisely so a store can be read
   *  with no live browser underneath — so this mirrors production's own
   *  pre-hydration behaviour rather than inventing a harness-only rule. A
   *  component whose CLICK WIRING this harness exists to test never depends
   *  on which snapshot a browser-only store returns; one that started to
   *  would need a real renderer, not this one. */
  useSyncExternalStore: (
    subscribe: (onChange: () => void) => () => void,
    getSnapshot: () => Cell,
    getServerSnapshot?: () => Cell,
  ) => Cell;
}

export type Props = Record<string, unknown>;

/** Props of an element, typed for the `find`/`filter` idiom below. */
export const propsOf = (el: ReactElement): Props => el.props as Props;

/** Every element in a returned tree, so handlers can be found and invoked. */
export function walk(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  out.push(node);
  return walk((node.props as { children?: ReactNode }).children, out);
}

/** Every STRING rendered anywhere in a tree, joined. Lets a test assert on the
 *  sentence a customer actually reads rather than on a dictionary key — which
 *  is the difference between pinning copy and pinning a lookup. */
export function textOf(node: ReactNode): string {
  const out: string[] = [];
  const visit = (n: ReactNode) => {
    if (n === null || n === undefined || typeof n === "boolean") return;
    if (typeof n === "string" || typeof n === "number") {
      out.push(String(n));
      return;
    }
    if (Array.isArray(n)) {
      for (const child of n) visit(child);
      return;
    }
    if (!isValidElement(n)) return;
    visit((n.props as { children?: ReactNode }).children);
  };
  visit(node);
  return out.join(" ");
}

/**
 * React's own dependency rule, shared by `useEffect` and `useMemo` so the two
 * cannot drift: no previous record re-runs; an absent `deps` on either side
 * re-runs every render; otherwise a positional `Object.is` over the array.
 */
function depsChanged(before: { deps: Deps } | undefined, deps: Deps): boolean {
  if (!before) return true;
  if (deps === undefined || before.deps === undefined) return true;
  if (deps.length !== before.deps.length) return true;
  return deps.some((d, i) => !Object.is(d, (before.deps as unknown[])[i]));
}

function hookDispatcherSlot(): { H: HookDispatcher | null } {
  const slot = (
    ReactRuntime as unknown as {
      __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?: {
        H: HookDispatcher | null;
      };
    }
  ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  if (!slot) {
    throw new Error(
      "React's hook dispatcher slot has moved — the useState harness in " +
        "components/__tests__/_hook-harness.tsx needs updating (see its comment).",
    );
  }
  return slot;
}

/**
 * Render a `useState`-only function component and keep re-rendering it as its
 * state changes, so its handlers can be invoked the way a browser would.
 *
 * @param expand how to flatten the rendered output. Defaults to `walk`; a
 *   caller passes its own when a CHILD component also has to be expanded (only
 *   safe for hookless children — expanding one that mounts a provider or a
 *   third-party widget would need a real renderer).
 */
export function renderIsland<P>(
  Component: (props: P) => ReactNode,
  initialProps: P,
  expand: (node: ReactNode) => ReactElement[] = (node) => walk(node),
) {
  const slot = hookDispatcherSlot();
  let props = initialProps;
  const cells: Cell[] = [];
  let cursor = 0;
  let output: ReactNode = null;
  // A RENDER-PHASE update: `setX(...)` called while the component's own body is
  // still running. React supports this deliberately — it is the sanctioned
  // "adjust state when a prop changes" pattern (`useBoardActions` clears its
  // optimistic overrides that way, and the schedule board re-derives its day
  // tab) — and it does NOT re-enter: it throws away the in-progress output and
  // runs the body again from the top, repeating until no set fires.
  //
  // Calling `run()` re-entrantly instead, which is what this harness used to
  // do, resets the hook cursors underneath the render that is still executing.
  // Every hook the caller reads AFTER the set then lands on the wrong cell, so
  // the component renders garbage — a board whose `useState<Density>("board")`
  // came back as neither "board" nor "agenda" nor "lanes" — while the harness
  // reports no error at all. Hence the flag and the loop in `run()`.
  let rendering = false;
  let renderPhaseUpdate = false;
  // Effects are keyed by call order like every other hook. `deps` is the
  // PREVIOUS render's array, so an effect re-runs only when its dependencies
  // change — `[]` runs once. Re-running everything on every render would put a
  // component that sets state from an effect into an infinite loop.
  const effects: { deps: Deps; cleanup: void | (() => void) }[] = [];
  let effectCursor = 0;
  // Layout effects: the SAME bookkeeping, a SEPARATE list. Every hook type
  // here is keyed by its own call order, so sharing `effects` would make each
  // list's indices depend on the other's call sites (the reason `useCallback`
  // does not share `memos` either).
  const layoutEffects: { deps: Deps; cleanup: void | (() => void) }[] = [];
  let layoutCursor = 0;
  // What THIS pass declared, held back until the pass survives. A render-phase
  // update throws its pass away, and the effect bookkeeping has to go with it:
  // recording `deps` from a discarded pass would make the surviving pass look
  // unchanged, so the effect would never run at all.
  type Queued = {
    index: number;
    deps: Deps;
    changed: boolean;
    create: () => void | (() => void);
  };
  let pending: Queued[] = [];
  let pendingLayout: Queued[] = [];
  // Memo cells, keyed by call order like every other hook — see `useMemo` on
  // HookDispatcher for why this is not a straight-through call.
  const memos: ({ deps: Deps; value: Cell } | undefined)[] = [];
  let memoCursor = 0;
  // Callback cells get their own list rather than sharing the memo one: every
  // hook type here is keyed by its OWN call order, and mixing two would make
  // each list's indices depend on the other's call sites.
  const callbacks: ({ deps: Deps; value: Cell } | undefined)[] = [];
  let callbackCursor = 0;
  // How to put the memo/callback lists back if THIS pass is discarded.
  //
  // The state hooks are the other way round and deliberately so: React QUEUES a
  // render-phase update and applies it on the re-run — that is the entire
  // mechanism, so `cells` and reducer state must survive a discarded pass.
  // `useMemo`/`useCallback` carry no queue. On the re-run React clones the hook
  // from the CURRENT (last committed) fiber, so it compares `deps` against the
  // last COMMIT, not against the pass it threw away. Keeping a discarded pass's
  // entry makes the surviving pass read "unchanged" and hand back a value
  // computed before the adjustment — closing over pre-adjustment state, for
  // ever, with nothing rendered differently to notice.
  let cacheUndo: (() => void)[] = [];
  // Ref boxes are created once and never replaced — that identity IS the hook.
  const refs: { current: Cell }[] = [];
  let refCursor = 0;
  // Reducer cells keep the state, the CURRENT reducer (a component may close a
  // fresh one over new props each render, and dispatch must use that one, not
  // the first), and the one stable dispatch this cell will ever hand back.
  const reducers: {
    state: Cell;
    reduce: (state: Cell, action: Cell) => Cell;
    dispatch: (action?: Cell) => void;
  }[] = [];
  let reducerCursor = 0;

  const dispatcher: HookDispatcher = {
    useState(initial) {
      const index = cursor++;
      if (index >= cells.length) {
        cells.push(typeof initial === "function" ? (initial as () => Cell)() : initial);
      }
      const set = (next: Cell) => {
        cells[index] =
          typeof next === "function" ? (next as (previous: Cell) => Cell)(cells[index]) : next;
        if (rendering) {
          renderPhaseUpdate = true;
          return;
        }
        run();
      };
      return [cells[index], set];
    },
    useEffect(create, deps) {
      const index = effectCursor++;
      pending.push({ index, deps, changed: depsChanged(effects[index], deps), create });
    },
    useLayoutEffect(create, deps) {
      const index = layoutCursor++;
      pendingLayout.push({ index, deps, changed: depsChanged(layoutEffects[index], deps), create });
    },
    useMemo(create, deps) {
      const index = memoCursor++;
      const before = memos[index];
      if (depsChanged(before, deps)) {
        cacheUndo.push(() => void (memos[index] = before));
        memos[index] = { deps, value: create() };
      }
      return memos[index]!.value;
    },
    useCallback(fn, deps) {
      const index = callbackCursor++;
      const before = callbacks[index];
      if (depsChanged(before, deps)) {
        cacheUndo.push(() => void (callbacks[index] = before));
        callbacks[index] = { deps, value: fn };
      }
      return callbacks[index]!.value;
    },
    useRef(initial) {
      const index = refCursor++;
      if (index >= refs.length) refs.push({ current: initial });
      return refs[index]!;
    },
    useReducer(reduce, initialArg, init) {
      const index = reducerCursor++;
      if (index >= reducers.length) {
        reducers.push({
          state: init ? init(initialArg) : initialArg,
          reduce,
          // Minted once. Reads `reducers[index]` at CALL time rather than
          // closing over the state, so a second dispatch reduces from what the
          // first produced — a dispatch that closed over the render's state
          // would silently drop every action but the last.
          dispatch: (action?: Cell) => {
            const cell = reducers[index]!;
            cell.state = cell.reduce(cell.state, action);
            if (rendering) {
              renderPhaseUpdate = true;
              return;
            }
            run();
          },
        });
      }
      const cell = reducers[index]!;
      cell.reduce = reduce;
      return [cell.state, cell.dispatch];
    },
    useContext(context) {
      return context._currentValue;
    },
    useSyncExternalStore(_subscribe, getSnapshot, getServerSnapshot) {
      return getServerSnapshot ? getServerSnapshot() : getSnapshot();
    },
  };

  function run() {
    // React's render-phase-update loop: a set fired from the component body
    // discards the output and runs the body again, never commits the
    // half-finished pass, and never runs effects for it. The bound is React's
    // own (25, then "Too many re-renders"), so an adjustment that fails to
    // converge fails LOUDLY here instead of hanging the suite.
    let passes = 0;
    do {
      renderPhaseUpdate = false;
      cursor = 0;
      effectCursor = 0;
      layoutCursor = 0;
      memoCursor = 0;
      callbackCursor = 0;
      refCursor = 0;
      reducerCursor = 0;
      pending = [];
      pendingLayout = [];
      cacheUndo = [];
      const previous = slot.H;
      slot.H = dispatcher;
      rendering = true;
      try {
        output = Component(props);
      } finally {
        rendering = false;
        slot.H = previous;
      }
      if (renderPhaseUpdate) {
        // Discarded: unwind this pass's memo/callback writes, newest first, so
        // the next pass compares against the last COMMITTED deps.
        for (let i = cacheUndo.length - 1; i >= 0; i -= 1) cacheUndo[i]!();
        cacheUndo = [];
      }
      if (++passes > 25) {
        throw new Error(
          "Too many re-renders. The component set state during render without converging " +
            "(see the render-phase-update note in _hook-harness.tsx).",
        );
      }
    } while (renderPhaseUpdate);
    // After the render, like React's commit phase — and OUTSIDE the dispatcher,
    // so an effect that calls setState re-renders through the normal path.
    // Layout effects commit BEFORE passive ones, exactly as React orders them.
    const queuedLayout = pendingLayout;
    pendingLayout = [];
    const queued = pending;
    pending = [];
    commit(queuedLayout, layoutEffects);
    commit(queued, effects);
  }

  /** Commit the surviving pass's dependency arrays first, keeping whatever
   *  cleanup the previous render left — then run only the effects whose deps
   *  actually moved. Shared by both effect kinds so the two cannot drift. */
  function commit(queued: Queued[], store: { deps: Deps; cleanup: void | (() => void) }[]) {
    for (const { index, deps } of queued) {
      store[index] = { deps, cleanup: store[index]?.cleanup };
    }
    for (const { index, changed, create } of queued) {
      if (!changed) continue;
      store[index]?.cleanup?.();
      const cleanup = create();
      const slotEntry = store[index];
      if (slotEntry) slotEntry.cleanup = cleanup;
    }
  }

  run();
  // Functions, not values: every interaction re-renders, and reading a stale
  // tree would let assertions pass against markup the user never saw.
  return {
    tree: () => expand(output),
    text: () => textOf(output),
    /** Re-render with new props, the way a parent handing down fresh data
     *  would — hook state (cells, effect cleanups, memos) carries over, so an
     *  effect keyed on a prop that changed re-runs exactly once. */
    rerender: (nextProps: P) => {
      props = nextProps;
      run();
    },
    /** Tear the island down the way React would when a parent stops
     *  rendering it (`{tab === "x" && <Island/>}` flipping false) — runs
     *  every registered effect's cleanup once, in declaration order, and
     *  nothing else (no further render). Without this, a mount-only cleanup
     *  effect (`useEffect(() => () => {...}, [])`) — the shape a
     *  flush-on-unmount fix needs — has no way to fire at all in this
     *  harness. */
    unmount: () => {
      for (const effect of layoutEffects) {
        effect?.cleanup?.();
      }
      for (const effect of effects) {
        effect?.cleanup?.();
      }
    },
  };
}

/**
 * Competition Desk W3 Task 4, fix round 1 — expand a CHILD function
 * component that itself calls hooks, from OUTSIDE a live `renderIsland`
 * render (e.g. from a custom `expand` argument, the way `expandRows`
 * (`create-org-form.test.tsx`) walks into a hookless `BillRow`). That
 * existing pattern calls the child directly as a plain function — safe only
 * because `BillRow` is hookless, so no dispatcher needs to be active. A
 * hook-using child called the same way would hit React's REAL
 * `useContext`/`useState`/etc with no dispatcher installed (`renderIsland`'s
 * own `run()` has already restored `slot.H` to whatever it was before the
 * render finished by the time a test's `expand` runs) — "Invalid hook call"
 * in real React, not a graceful degrade.
 *
 * This installs a minimal, STATELESS dispatcher — for the duration of the
 * call, then restores whatever was active before — supporting exactly the
 * READ-ONLY hooks that need no cross-render identity to stay correct:
 * `useContext` (same "no provider tree, read the DEFAULT value" contract
 * `renderIsland`'s own dispatcher documents above), and `useMemo`/
 * `useCallback` as unconditional passthroughs (`create()`/`fn` every call —
 * memoisation is a performance optimisation, never a correctness one, so
 * recomputing on a one-shot call is always safe; discovered necessary
 * because `useMsg()` itself is `useContext` THEN `useMemo` over the result,
 * not `useContext` alone — see dict-provider.tsx). Every STATEFUL hook
 * throws a clearly-labelled error rather than silently misbehaving: a child
 * that turns out to need real state (`useState`/`useEffect`/a reducer/a
 * store subscription) needs `renderIsland` on it directly, not this — this
 * helper exists for the narrow "presentational child whose only hooks are
 * plain reads" shape (`StageRail`'s own `useMsg()`, see stage-rail.tsx's
 * header for why it stays exactly that).
 */
export function expandWithHooks<P>(Component: (props: P) => ReactNode, props: P): ReactNode {
  const slot = hookDispatcherSlot();
  const previous = slot.H;
  const readOnly: HookDispatcher = {
    useState() {
      throw new Error("expandWithHooks: useState is not supported — this helper is read-only hooks (useContext/useMemo/useCallback) only.");
    },
    useEffect() {
      throw new Error("expandWithHooks: useEffect is not supported — this helper is read-only hooks (useContext/useMemo/useCallback) only.");
    },
    useLayoutEffect() {
      throw new Error("expandWithHooks: useLayoutEffect is not supported — this helper is read-only hooks (useContext/useMemo/useCallback) only.");
    },
    useMemo(create) {
      return create();
    },
    useCallback(fn) {
      return fn;
    },
    useRef() {
      throw new Error("expandWithHooks: useRef is not supported — this helper is read-only hooks (useContext/useMemo/useCallback) only.");
    },
    useReducer() {
      throw new Error("expandWithHooks: useReducer is not supported — this helper is read-only hooks (useContext/useMemo/useCallback) only.");
    },
    useContext(context) {
      return context._currentValue;
    },
    useSyncExternalStore() {
      throw new Error("expandWithHooks: useSyncExternalStore is not supported — this helper is read-only hooks (useContext/useMemo/useCallback) only.");
    },
  };
  slot.H = readOnly;
  try {
    return Component(props);
  } finally {
    slot.H = previous;
  }
}
