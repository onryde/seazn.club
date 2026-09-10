// Task 5d — closes the delay-compensation seam (owner-approved W1 scope
// change, 2026-09-09 ledger; Task 1's brief had deliberately left this to
// R2, then the owner pulled it forward once the seam was shown to be
// inert). `use-live-fixture.ts` already accepts `delayMs` and exposes
// `presentationNowOffsetMs`; `overlay-stage.tsx` already threads it into
// `useOverlayClock`. The one missing piece was a caller — nothing ever set
// `delayMs` above 0. This file is that caller's parser.
//
// Same stance as `resolveTheme` (`theme-registry.ts`): `?delay=` is typed
// into an OBS Browser Source URL by a human mid-broadcast, under time
// pressure, so an unparseable or out-of-range value falls back to a safe
// default and NEVER throws — "A 404 or an exception here would take a club
// off air over a query string" (`resolveTheme`'s own doc comment; this
// route's `page.tsx` follows the identical precedent for `?style=`/`?lang=`
// rather than inventing a second one for `?delay=`).
//
// Plain function, not zod: `?style=`/`?lang=` (this route's other two query
// params) are both resolved by hand-written functions with no schema either
// — `resolveTheme`, `toLocale` — and this is not part of any OpenAPI-
// generated contract (unlike `lib/stream-url.ts`'s `streamUrlSchema`, which
// is embedded in `PutFixtureStream` and has to dodge the
// `z.preprocess()`-not-`.transform()` `openapi:gen` crash for that reason).
// A route query param with no schema to join has nothing to gain from zod
// here and every reason to match its two siblings.

/** No `?delay=`, or an unparseable/out-of-range one, presents live (0 ms
 *  behind wall time) — the pre-Task-5d behaviour every existing caller
 *  already gets. */
export const DEFAULT_DELAY_MS = 0;

/**
 * Upper bound: 5 minutes (300_000 ms). A presentation delay a broadcaster
 * would plausibly dial in tops out at tens of seconds (enough to let a
 * VAR-style review resolve before the picture airs); 5 minutes is generous
 * headroom above any real use, chosen as a backstop against a mistyped
 * `?delay=99999999` rather than a value anyone is expected to reach. It
 * bounds `useLiveFixture`'s snapshot buffer too: at the 15 s poll interval
 * (`POLL_MS`) the buffer holds at most `DELAY_MAX_MS / POLL_MS` (= 20)
 * pending snapshots, not an unbounded one held open for hours by a typo.
 */
export const DELAY_MAX_MS = 300_000;

/**
 * Resolves the raw `?delay=` query value into the whole-millisecond
 * `delayMs` `useLiveFixture` takes. The full parse table (Task 5d brief):
 *
 * | input                | resolves to        |
 * |----------------------|---------------------|
 * | absent                | `DEFAULT_DELAY_MS` |
 * | `""` (empty)           | `DEFAULT_DELAY_MS` |
 * | `"0"`                  | 0                   |
 * | negative (`"-500"`)    | `DEFAULT_DELAY_MS` |
 * | `"NaN"`                | `DEFAULT_DELAY_MS` |
 * | non-numeric junk       | `DEFAULT_DELAY_MS` |
 * | fractional (`"2500.9"`)| 2500 (truncated)    |
 * | > `DELAY_MAX_MS`       | `DEFAULT_DELAY_MS` |
 * | in range, whole        | itself              |
 *
 * A RESOLVED VALUE IS NOT A GUARANTEED WAIT (review MINOR 2, 2026-09-10).
 * `useLiveFixture` drains its buffer on a fixed `DRAIN_MS` (1 000 ms) tick, so
 * what a resolved `delayMs` buys is `[delayMs, delayMs + DRAIN_MS)` — every
 * value in this table under a second holds for a full second, and `?delay=250`
 * is four times what the operator typed. That is documented rather than
 * rounded or refused here: an OBS operator plans scene timing against the
 * number they typed, and rewriting 250 to 1 000 would replace one discrepancy
 * with a second, invisible one. Sub-second is not a real use case — every
 * genuine `?delay=` is seconds of broadcast latency — and if it becomes one
 * the fix is a shorter `DRAIN_MS`, not a rounded `delayMs`.
 *
 * `Number()`, not `parseFloat()`: `parseFloat` accepts a numeric PREFIX
 * (`"5000abc"` → 5000), which would silently honour a fat-fingered value a
 * broadcaster never intended; `Number()` requires the whole string to be
 * numeric, so trailing junk falls back like any other unparseable input.
 */
export function resolveDelayMs(delayParam: string | undefined): number {
  if (delayParam === undefined || delayParam.trim() === "") return DEFAULT_DELAY_MS;
  const parsed = Number(delayParam);
  if (!Number.isFinite(parsed)) return DEFAULT_DELAY_MS;
  const truncated = Math.trunc(parsed);
  if (truncated < 0 || truncated > DELAY_MAX_MS) return DEFAULT_DELAY_MS;
  return truncated;
}
