// Spectator surface W1, Task 10 — the court-slab scorebug at the top of the
// match centre (W0 option A). Classes copied from `live-score.tsx:143` (the
// court card shell) and its score type scale — phone `text-2xl`, `md:text-4xl`
// (the brief's own token sheet; the legacy scoreboard used a single
// `text-5xl sm:text-6xl` because it never had a tab rail competing for the
// fold). Every `Msg` (`statusLine`) is resolved client-side via `t()` — the
// document carries a dictionary key + params, never pre-rendered copy, so a
// live poll/realtime push that changes which sentence applies re-resolves it
// in the viewer's own locale on the same tick, the same reasoning
// `renderDecidedOutcome` already established for the legacy scoreboard.
//
// Review fix round 1 (IMPORTANT 4, 5):
// - The freshness line derives from `header.updatedAt` (the document's OWN
//   timestamp) ticked every second by `useNow()`, not the hook's `updatedAt`
//   (which resets to `Date.now()` on every render-causing event and so could
//   only ever read "0s ago"). This also means no `Date.now()` call happens
//   during render any more (it moves into `useNow`'s effect and one-time
//   lazy `useState` initializer), which incidentally clears the
//   `react-hooks/purity` warning this file used to carry and document.
// - The status chip switches EXHAUSTIVELY on `header.status` (a real
//   `switch`, `never`-checked in `default` — see `statusChip` below) —
//   `in_play` → the LIVE pill, `decided` → the result chip, `scheduled` →
//   the same chip with different text, `other` (postponed/abandoned/
//   walkover/cancelled) → NO chip at all (the server's own
//   `header.statusLine` Msg is expected to name the reason — a later task's
//   copy, not this component's job to guess at). `header.live` no longer
//   selects which chip renders; it is read ONLY to decide whether the live
//   pill's dot pulses (a fixture can be `in_play` with play temporarily
//   stopped — a rain delay, a drinks break — without that meaning "not
//   live" in the status-enum sense).
//
// Review fix round 2 (Task 10 deferred minors):
// - The freshness line is shown ONLY while `header.status === "in_play"` —
//   a decided or scheduled fixture's `updatedAt` is whenever the document
//   was last (re)built, not a "how stale is the live score" signal, and
//   left unconditional it could read something absurd like "Updated
//   47231s ago" on a page that finished hours ago.
// - `Date.parse` is guarded with `Number.isFinite`: a malformed
//   `header.updatedAt` now reads "Updated 0s ago" rather than the
//   `Math.floor(NaN / 1000)` → `NaN` this would otherwise produce.
// - `suppressHydrationWarning` on the freshness `<p>` — its text is a
//   function of wall-clock time, so the server-rendered and first-client-
//   render values can legitimately differ by the seconds the network round
//   trip took; that is expected drift, not the corruption
//   `suppressHydrationWarning` normally papers over on OTHER attributes.
import { EntityLogo } from "@/components/ui/entity-logo";
import type { Dict as PublicDict } from "@/lib/i18n-constants";
import { lookup, t } from "@/lib/i18n-runtime";
import type { MatchCentreHeaderT } from "@/server/public-site/match-centre-schema";
import { useNow } from "./use-now";

export interface CourtCardProps {
  header: MatchCentreHeaderT;
  dict: PublicDict;
}

/** Exhaustive on `header.status` — a `never` check in `default` means a new
 *  status value added to the schema fails to COMPILE here rather than
 *  silently falling through to "no chip". */
function statusChip(status: MatchCentreHeaderT["status"], dict: PublicDict): { testId: string; text: string } | null {
  switch (status) {
    case "in_play":
      return { testId: "mc-live-pill", text: t(dict, "matchCentre.status.live") };
    case "decided":
      return { testId: "mc-result-chip", text: t(dict, "matchCentre.status.decided") };
    case "scheduled":
      return { testId: "mc-result-chip", text: t(dict, "matchCentre.status.scheduled") };
    case "other":
      // No chip — `header.statusLine` below is expected to name the reason
      // (postponed/abandoned/walkover/cancelled), a later task's copy.
      return null;
    default: {
      // Review round 2 minor — the `never` check stays for its COMPILE-time
      // exhaustiveness guarantee, but must never itself become the runtime
      // return value: `_exhaustive` is a `string` at runtime (whatever
      // unrecognised status arrived), and returning it as if it were a
      // `{ testId, text }` chip would render a `<p data-testid={undefined}>`
      // with no visible text — a broken chip, not "no chip".
      const _exhaustive: never = status;
      void _exhaustive;
      return null;
    }
  }
}

/** `term.<phase>` when the dictionary names this phase, else null so the
 *  caller can fall back to the engine's own token. Deliberately NOT `t()`:
 *  that warns and returns the KEY ITSELF, which would put a raw dictionary
 *  key on a public page for any phase beyond the authored set. */
function lookupPhaseTerm(dict: PublicDict, phase: string): string | null {
  const value = lookup(dict, `term.${phase}`);
  return typeof value === "string" && value !== "" ? value : null;
}

export function CourtCard({ header, dict }: CourtCardProps) {
  const now = useNow();
  const parsedUpdatedAt = Date.parse(header.updatedAt);
  const seconds = Number.isFinite(parsedUpdatedAt) ? Math.max(0, Math.floor((now - parsedUpdatedAt) / 1000)) : 0;
  const inPlay = header.status === "in_play";
  // `lookup`, not `t`: a missing key makes `t` WARN and return the key itself,
  // which would print a raw dictionary key on the page for any phase the
  // dictionary does not name. Falling back to the engine token instead keeps an
  // unbounded phase readable — the choice `sets-tab.tsx` documents for its own
  // headers.
  //
  // The example is spelled out in prose deliberately: `match-centre-dictionary
  // .test.ts` SCANS this source for term keys and requires every one it finds
  // to exist in all four dictionaries, so naming a hypothetical phase here in
  // key form invents a key nobody should author.
  const phaseLabel =
    header.phase === null ? null : (lookupPhaseTerm(dict, header.phase) ?? header.phase);
  const chip = statusChip(header.status, dict);
  return (
    <div
      data-testid="mc-court-card"
      className="overflow-hidden rounded-2xl bg-court text-court-ink shadow-lg"
    >
      <div className="p-5 sm:p-6">
        {chip ? (
          <p
            data-testid={chip.testId}
            className={
              chip.testId === "mc-live-pill"
                ? "mb-3 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.22em] text-emerald-300"
                : "mb-3 text-[11px] font-semibold uppercase tracking-[0.22em] text-court-muted"
            }
          >
            {inPlay ? (
              <span className={`h-2 w-2 rounded-full bg-emerald-400${header.live ? " animate-live-pulse" : ""}`} />
            ) : null}
            {chip.text}
            {/* The period kernel's live pair, restored: both were dropped when
                the match centre replaced the old scorebug, because
                `suppressScorebug` (R11/C7) hid their only renderer and neither
                had a home in the new header. A hockey spectator lost the
                power-play chip outright, and the phase survived only inside
                the Periods tab.

                They sit HERE, on the chip row, rather than in a band of their
                own: both are true only while the match is live, which is
                exactly what this row already says, and the alternative
                (restoring the suppressed slab) is the duplicate court card C7
                exists to forbid.

                `phase` is the engine's raw token, resolved through `term.*`
                the way `sets-tab.tsx` resolves its column headers, and it
                falls back to the token itself so an unbounded phase (`OT3`,
                `P7`) still reads rather than printing a missing key. */}
            {!inPlay || phaseLabel === null ? null : (
              <span data-testid="mc-phase" className="font-semibold tracking-normal text-emerald-200/90">
                {phaseLabel}
              </span>
            )}
            {/* Cricket's answer to "where are we" — the live over. It sits in
                the same slot `phase` occupies for the period sports, because
                it is the same fact: the board's `LIVE · 12.3 OV` and its
                `LIVE · 2ND HALF 67'` are one composition, filled by whichever
                of the two a sport has. No sport has both today; the order is
                defined anyway so a future one does not depend on luck. */}
            {!inPlay || header.pillNote === null ? null : (
              <span
                data-testid="mc-pill-note"
                className="font-semibold tracking-normal text-emerald-200/90"
              >
                {t(dict, header.pillNote.key, header.pillNote.params)}
              </span>
            )}
            {!inPlay || header.strength === null ? null : (
              <span
                data-testid="mc-strength"
                className="rounded-full bg-amber-400/20 px-2 py-0.5 font-mono text-[11px] font-bold tracking-normal text-amber-300"
              >
                {header.strength}
              </span>
            )}
          </p>
        ) : null}
        {/* The match's identity — "8-over match · Round 1 · Garon Park".
            Beside the status pill on the board, and it wraps BELOW it here
            rather than competing for a phone's width: the pill is the thing
            that must always be readable, the meta line is context. Every part
            arrives already resolved (see `metaLine` on the schema), so this
            renders a string rather than composing copy. */}
        {header.metaLine ? (
          <p data-testid="mc-meta-line" className="-mt-1 mb-3 text-xs text-court-muted">
            {header.metaLine}
          </p>
        ) : null}
        <div className="space-y-2">
          {header.sides.map((side, i) => {
            const idx = i as 0 | 1;
            const batting = header.battingIndex === idx;
            return (
              <div
                key={side.entrantId}
                className={`flex items-baseline justify-between gap-3 tabular-nums ${batting ? "font-bold" : ""}`}
              >
                {/* `min-w-0` is what lets `truncate` engage at all: this span
                    is an item of the row-flex above, so without it the
                    automatic minimum size (`min-width: auto`,
                    css-flexbox-1 §4.5) refuses to shrink it below its content
                    and a long entrant name pushes the score off the row
                    instead of ellipsing — AGENTS.md, "`truncate` needs
                    `min-w-0` on the whole ancestor chain, not just the span".
                    Latent until now (short seeded names never reached the
                    threshold) and found by the streaming-T1 visual gate's
                    `truncate-chain` check, which reds on this span without
                    it. `(public)/shared/[orgSlug]/layout.tsx:83` already
                    pairs the two the same way. */}
                {/* THE CREST TILE, in the side's own colour.
                    `Side.colour` and `Side.badgeUrl` have been on the wire
                    since W1 (`match-centre-schema.ts:11`, populated at
                    `match-centre-load.ts:207` from `colors.home_primary`) and
                    this card read NEITHER — the inert-seam class, and the
                    second time this exact seam has been found: `EntityLogo`'s
                    own header records `Side.colour` being built for every hub
                    fixture and read by nothing, fixed then for match cards and
                    not here. The design board's court card is crest tiles in
                    team colours; this is what makes that possible. */}
                <span className="flex min-w-0 items-center gap-2.5">
                  <EntityLogo
                    src={side.badgeUrl}
                    name={side.name}
                    colour={side.colour}
                    size={32}
                  />
                  {/* The FULL name, not the three-letter `short`. A scorebug
                      that reads "SOU vs CAN" makes a spectator decode their own
                      club; the board shows "Southend Blue Blazers". `short`
                      still earns its place where the box really is too small —
                      it is not removed from the wire, just not the default
                      here. `min-w-0` + `truncate` is what keeps a long name
                      from pushing the score off the row. */}
                  <span className="min-w-0 truncate font-display text-xl font-semibold uppercase tracking-wide sm:text-2xl">
                    {side.name || side.short}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span
                    data-testid={`mc-score-${idx}`}
                    className="font-display text-2xl font-bold tabular-nums md:text-4xl"
                  >
                    {header.scoreLines[idx] ?? "—"}
                  </span>
                  {header.subLines[idx] ? (
                    <span className="ml-1.5 text-xs text-court-muted">{header.subLines[idx]}</span>
                  ) : null}
                </span>
              </div>
            );
          })}
        </div>
        {/* ONE ROW, ruled off above it — the board's composition. The chase
            sentence is the loud half (it is the thing a spectator came to
            read: "Queens need 34 from 21"), the rates are the quiet half on
            the right. They used to be two stacked muted paragraphs of
            near-equal weight, which made the sentence look like a caption.
            They wrap onto separate lines at a narrow width rather than
            competing for one. */}
        {header.statusLine || header.rateLine ? (
          <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-white/10 pt-3">
            {header.statusLine ? (
              <p data-testid="mc-status-line" className="min-w-0 text-sm font-semibold text-court-ink">
                {t(dict, header.statusLine.key, header.statusLine.params)}
              </p>
            ) : null}
            {header.rateLine ? (
              <p data-testid="mc-rate-line" className="min-w-0 text-xs text-court-muted">
                {header.rateLine}
              </p>
            ) : null}
          </div>
        ) : null}
        {inPlay ? (
          <p
            data-testid="mc-updated-at"
            // Defect round 15b: the extra `/70` opacity stacked on top of
            // `text-court-muted`'s own embedded alpha measured 4.09:1 on
            // `bg-court` — short of WCAG AA's 4.5:1 (axe SERIOUS, walkthrough
            // evidence). `text-court-muted` alone (no modifier, same token
            // `mc-status-line`/`mc-rate-line` already use unmodified above)
            // measures well above 4.5:1 — no new colour, just drop the /70.
            className="mt-3 text-[11px] text-court-muted"
            suppressHydrationWarning
          >
            {t(dict, "matchCentre.updatedAgo", { seconds })}
          </p>
        ) : null}
      </div>
      <div aria-hidden className={`h-1 ${inPlay ? "bg-emerald-400" : "bg-accent"}`} />
    </div>
  );
}
