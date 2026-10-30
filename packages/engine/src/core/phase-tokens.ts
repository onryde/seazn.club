// X-PH-1 (pad wave P4.2) - the phases in which a match is OVER, declared once.
//
// Every sport module's state carries a `phase`; `done` (decided), `final` (locked by core.finalize) and `abandoned`
// (a core.abandon that leaves the match without a result) are the three in which nothing more is accepted. Seven engine
// files (14 sites) and nine ScoringPad skins each used to spell the three out; they read this set instead, so a phase added
// later is added here.
//
// Cricket's union has no `abandoned` (an abandon decides: `done`), so cricket's own `done`/`final` tests are NOT this
// set and stay in cricket.ts. A module whose union is a SUBSET of these tokens may test a subset; none may test a
// superset. Phone-safe: no imports, no strings meant for display.

const TOKENS = new Set<string>(["done", "final", "abandoned"]);
// `Object.freeze` alone leaves a Set's own methods working, so the three own mutators refuse as well. (A call through
// `Set.prototype.add.call(POST_PHASES, x)` bypasses them; nothing does that, and the type is ReadonlySet.)
for (const method of ["add", "delete", "clear"] as const) {
  Object.defineProperty(TOKENS, method, {
    value: () => {
      throw new TypeError(`POST_PHASES is frozen: ${method} refused`);
    },
  });
}

/** The phases in which a match is over: `done`, `final`, `abandoned`. Frozen. */
export const POST_PHASES: ReadonlySet<string> = Object.freeze(TOKENS);
