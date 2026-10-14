// The ONE import site for chessground.
//
// WHY THIS FILE EXISTS — DO NOT INLINE IT. chessground is GPL-3.0-or-later
// and we ship it to every visitor's browser, which is distribution of a
// combined work (design 2026-10-09 §9; the owner accepted the licence on
// 2026-10-09 after being told, and no legal advice was given or implied).
// The mitigation the design REQUIRES is that chessground stays isolated and
// unmodified: its own async chunk, consumed as a library through this
// boundary, never vendored into the repo and never patched. `board.tsx` is
// our own thin wrapper above it. Importing chessground anywhere else, or
// copying its source in, widens the combined work and is a licence change
// dressed up as a refactor — `__tests__/licence-isolation.test.ts` fails if
// either happens.
//
// The dynamic `import()` is also what gives it its own chunk under Next
// 16.3's Turbopack build: a static import from a client component would be
// folded into the route's first-load bundle. Mounted via
// `dynamic(() => import("./board"), { ssr: false })` in `room-shell.tsx` —
// chessground touches `document` at construction, so it must never render
// on the server.
//
// The stylesheets are chessground's own, unmodified: the base layout, and
// the cburnett piece set (Colin M.L. Burnett, GPLv2+, as shipped inside the
// package). The board colours are ours (`board.tsx`), drawn over the base
// stylesheet, not by editing it. This module is reachable only through
// `board.tsx`, which is reachable only through the `ssr: false` dynamic
// import, so these stylesheets ride in the board's chunk too.
import "chessground/assets/chessground.base.css";
import "chessground/assets/chessground.cburnett.css";

export type BoardModule = { Chessground: typeof import("chessground").Chessground };

export async function loadBoard(): Promise<BoardModule> {
  const mod = await import("chessground");
  return { Chessground: mod.Chessground };
}
