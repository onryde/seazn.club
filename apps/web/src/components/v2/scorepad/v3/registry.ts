// v3 skin-registry lane — R1 chassis (Task 2). Sits BESIDE the legacy
// registry (../registry.tsx's `resolveScorePad`/`RESOLUTION_KIND`), which
// keeps rendering every sport unchanged through R1. This file is the FIRST
// production code that ties the pad registry to the engine's own module
// list (`builtinModules`) — the legacy `RESOLUTION_KIND` table is
// hand-written and carries no such import, so a 12th engine sport shipping
// today would silently land on "universal" there with nobody having
// decided that was right (see ../registry.tsx's header). `resolvePad`
// below refuses that: an unowned key throws instead of guessing.
//
// R1 converts NO sport: `V3_SKINS` stays empty and `LEGACY_SPORTS` names
// every engine key, so every real call resolves "legacy" today. A later
// wave moves one sport at a time by adding it to `V3_SKINS` (and, in the
// same change, removing it from `LEGACY_SPORTS` — see the totality test,
// which fails a key present in both just as loudly as a key in neither).
//
// R2/task E — cricket is the first sport moved, and it fixes `V3_SKINS`'s
// VALUE type for good: a FACTORY, `(t: TFn) => SkinDefV3`, never an
// already-built `SkinDefV3`. cricket.tsx's own header explains why cricket
// specifically needs one (`ScorebugSpec.context`/`WhoLine.name`/
// `DockSpec.title` are pre-resolved text, and no `SkinDefV3` method itself
// receives `t`) — but the shape here is uniform for every sport this map
// will ever hold, whether or not that sport's own factory happens to use
// its `t`, so a future wave has one pattern to copy, not a decision to
// re-litigate. This is load-bearing, not stylistic: `V3_SKINS` is built at
// MODULE-EVALUATION time, before any request has picked a locale, so it
// can never correctly hold an already-resolved skin — baking one in here
// would freeze `ScorebugSpec.context` et al. at whatever locale happened
// to be active the first time this module loaded, forever, for every
// user, while every OTHER string around it (tile labels, sheet titles —
// resolved by the chassis itself, per render, from its OWN `t`) kept
// tracking the real one. `resolvePad(key, t)` is what actually calls the
// factory, with a real translator its OWN caller supplies —
// `../registry.tsx`'s `ScorePad`, which builds one from its live
// `useMsg()` the same way `pad-host.tsx` already does for the chassis's
// own `t` prop (`useCallback((key, vars) => msg(key as MessageKey, vars),
// [msg])`) — so a locale switch that re-renders `ScorePad` rebuilds the
// skin against the NEW translator on the very next call, never a stale
// one.
//
// The corollary this file's type now enforces on its own: an
// ALREADY-CALLED skin (a bare `SkinDefV3` object) is not a valid
// `V3_SKINS` entry — assigning one is a tsc error (an object has no call
// signature to satisfy `(t: TFn) => SkinDefV3`), not a runtime surprise
// the first time `PadHostV3` calls `skin.scorebug(view)` on something
// that turns out not to be a function. `__tests__/registry-totality.test.ts`
// pins this with a `@ts-expect-error` case.
import { builtinModules } from "@seazn/engine/sports";
import type { TFn } from "./context-strip";
import type { SkinDefV3 } from "./types";
import { badmintonSkinV3 } from "./skins/badminton";
import { boardgameSkinV3 } from "./skins/boardgame";
import { carromSkinV3 } from "./skins/carrom";
import { cricketSkinV3 } from "./skins/cricket";
import { footballSkinV3 } from "./skins/football";
import { genericSkinV3 } from "./skins/generic";
import { hockeySkinV3 } from "./skins/hockey";
import { icehockeySkinV3 } from "./skins/icehockey";
import { tabletennisSkinV3 } from "./skins/tabletennis";
import { tennisSkinV3 } from "./skins/tennis";
import { volleyballSkinV3 } from "./skins/volleyball";

/**
 * Sport key -> v3 skin FACTORY. Empty through R1; populated sport-by-sport
 * from R2 — cricket, here, first. See this file's header for why a factory
 * rather than an already-built `SkinDefV3`.
 *
 * Built with `Object.create(null)` rather than `{}` (Task 11 fix batch,
 * deferred from Task 2's review): a plain object literal inherits
 * `Object.prototype`, so `"constructor" in V3_SKINS` and
 * `V3_SKINS["constructor"]` both resolve truthy even though no such key
 * was ever inserted — `resolvePad("constructor")` would silently return
 * `{ lane: "v3", skin: Object }` instead of throwing. A null-prototype
 * object has no inherited properties, so both the `in` check below (and
 * in `__tests__/registry-totality.test.ts`) and `V3_SKINS[key]` read only
 * OWN properties, same as `Object.hasOwn` would give — with zero change
 * to real-key behaviour (assignment/lookup for an actual sport key is
 * unaffected by the prototype).
 */
export const V3_SKINS: Partial<Record<string, (t: TFn) => SkinDefV3>> = Object.create(null);
// ALPHABETICAL BY KEY, from R6 on — and the ordering is a working agreement,
// not a tidy-up. R6 (hockey + ice hockey) and R7 (boardgame, carrom, generic)
// insert into this literal and into `CONVERTED_SPORTS` below CONCURRENTLY, on
// separate branches; wave order gave two appends to the same last line and a
// conflict a human had to think about, where a sorted list gives each new key
// exactly one correct slot. Every entry keeps the provenance note its own wave
// wrote — the entries moved, nothing else did.
//
// EVERY VALUE IS THE FACTORY, never `xSkinV3(t)`: an already-called skin is a
// plain object with no call signature, which this map's own value type rejects
// at compile time (see this file's header, and
// `__tests__/registry-totality.test.ts`'s `@ts-expect-error` pin).

// R5/C1 — badminton, the fourth conversion and the FIRST of the three sports
// that share `sports/setbased`'s kernel.
V3_SKINS.badminton = badmintonSkinV3;
// R7/A2 — boardgame, the eighth conversion, and the second of the two sports
// that had been left on `../registry.tsx`'s `RESOLUTION_KIND: "universal"`
// lane after A1. The FACTORY, never `boardgameSkinV3(t)`, same reason as
// every entry here.
V3_SKINS.boardgame = boardgameSkinV3;
// R7/A3 — carrom, the eleventh and LAST conversion, and the sport that
// closes out `../registry.tsx`'s `RESOLUTION_KIND: "universal"` lane
// entirely: every engine sport now resolves to a v3 skin, and
// `LEGACY_SPORTS` (below) is empty from this line on.
V3_SKINS.carrom = carromSkinV3;
// R2 — cricket, the first conversion.
V3_SKINS.cricket = cricketSkinV3;
// R3/task B2 — football, the second conversion.
V3_SKINS.football = footballSkinV3;
// R7/A1 — generic, the seventh conversion. NOT a fallback: `generic` is a
// first-class, user-selectable catalog entry ("Generic"), and therefore the
// scoring surface for every sport this engine does not model. It is also the
// first conversion whose VARIANT changes the pad — `padSpec` branches on
// `cfg.resultMode` — so `skins/generic.tsx` builds two boards from one skin.
// The FACTORY, never `genericSkinV3(t)`, same reason as every entry above.
V3_SKINS.generic = genericSkinV3;
// R6 — field hockey, and the FIRST skin in the programme to declare
// `SkinDefV3.clock()`. Declaring it is the single switch that mounts
// `PadClockBar` and turns on `at` stamping in `pad-host.tsx`'s `send` gateway,
// so R6/task A's seam is unreachable in the product until this line and the
// next one exist. Both period-kernel sports flip in ONE change: they share
// `skins/period-shared.ts`, and a half-flipped pair would leave the shared
// module carrying a sport that never reaches it.
V3_SKINS.hockey = hockeySkinV3;
// R6 — ice hockey, the second of the period-kernel pair. See hockey above.
V3_SKINS.icehockey = icehockeySkinV3;
// R5/C2 — table tennis, the fifth conversion and the SECOND of the three
// `sports/setbased` sports.
V3_SKINS.tabletennis = tabletennisSkinV3;
// R4 — tennis, the third conversion.
V3_SKINS.tennis = tennisSkinV3;
// R5/C3 — volleyball, the sixth conversion and the THIRD and LAST of the three
// `sports/setbased` sports. `skins/racquet-skin.tsx` (v2) is now unreferenced
// by any sport and is deleted in that wave's own follow-up task, not here.
V3_SKINS.volleyball = volleyballSkinV3;

/**
 * Every engine sport key NOT already owned by `V3_SKINS`, computed from
 * `builtinModules` rather than hand-copied — a new engine sport lands here
 * automatically, so the totality gate (`__tests__/registry-totality.test.ts`)
 * stays meaningful instead of silently passing against a stale hardcoded
 * set. Deliberately maintained INDEPENDENTLY of `V3_SKINS` (never derived
 * as "every key not in V3_SKINS") — the totality test's own "double-owned"
 * check (a key in both) only stays a reachable mistake, worth guarding
 * against, if this set is capable of disagreeing with `V3_SKINS` in the
 * first place; deriving one from the other would make that mistake
 * structurally impossible instead of merely caught. One sport moves per
 * wave: add it to `V3_SKINS` above AND exclude it here, in the SAME
 * change — R2/task E did exactly that for cricket, R3/task B2 for football,
 * R4 for tennis, R5/C1 for badminton, R5/C2 for table tennis and R5/C3 for
 * volleyball — the third and last `sports/setbased` sibling, closing out the
 * racquet family, R7/A1 for generic — the universal renderer's first sport —
 * R7/A2 for boardgame, the universal renderer's second, and R7/A3 for
 * carrom, the universal renderer's THIRD AND LAST: `../registry.tsx`'s
 * `RESOLUTION_KIND: "universal"` lane now serves no sport at all, and
 * `LEGACY_SPORTS` below is empty.
 *
 * `CONVERTED_SPORTS` below is a LITERAL list, deliberately not
 * `Object.keys(V3_SKINS)`: deriving one from the other would make the totality
 * gate's "double-owned" check structurally impossible to fail rather than
 * merely caught, which is the whole reason the two sets are maintained apart.
 */
const CONVERTED_SPORTS: ReadonlySet<string> = new Set([
  // Alphabetical, and kept in step with `V3_SKINS` above by
  // `__tests__/registry-totality.test.ts` — a key in one set and not the other
  // fails as loudly as a key in neither. See `V3_SKINS`' own note for why the
  // order is a concurrency agreement rather than housekeeping. Now that
  // carrom (R7/A3) is the eleventh and final entry, this set names every
  // engine sport and never grows again.
  "badminton",
  "boardgame",
  "carrom",
  "cricket",
  "football",
  "generic",
  "hockey",
  "icehockey",
  "tabletennis",
  "tennis",
  "volleyball",
]);

export const LEGACY_SPORTS: ReadonlySet<string> = new Set(
  builtinModules.map((m) => m.key).filter((key) => !CONVERTED_SPORTS.has(key)),
);

export type PadLaneResolution = { lane: "v3"; skin: SkinDefV3 } | { lane: "legacy" };

/**
 * Resolve a sport key to its rendering lane. Throws on a key owned by
 * neither lane — deliberately no silent universal fallback (contrast
 * ../registry.tsx's `resolveScorePad`, which defaults an unlisted key to
 * "universal" at runtime, by design, for a different reason: this lane
 * question is meant to be a written decision from day one, not eased in).
 *
 * `t` (R2/task E): a real translator, built by the CALLER from its own
 * live locale (`../registry.tsx`'s `ScorePad`) — required, not optional,
 * so a future call site cannot forget to supply one and silently get a
 * skin built against a no-op translator instead, a mistake that would
 * otherwise surface only as raw i18n keys on screen, never a test
 * failure. Unused entirely on the "legacy" path — a legacy-lane sport's
 * factory is never looked up, so the other 10 sports (today) are
 * unaffected by this parameter existing at all.
 */
export function resolvePad(key: string, t: TFn): PadLaneResolution {
  const factory = V3_SKINS[key];
  if (factory) return { lane: "v3", skin: factory(t) };
  if (LEGACY_SPORTS.has(key)) return { lane: "legacy" };
  throw new Error(`resolvePad: "${key}" has no pad lane (not in V3_SKINS or LEGACY_SPORTS)`);
}
