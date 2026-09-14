// Spectator surface W2, Task 7 — the Matches hub's card, a W1 `CourtCard`
// (`match-centre/court-card.tsx`) variant: one DOM, `md` only widens. Every
// user-facing string that is not already resolved by the hub builder travels
// through `t()` — the document's own convention
// (`competition-hub-schema.ts`'s header comment: "every number in it is
// already FORMATTED and every name already RESOLVED before it is put here").
//
// The `roundLabel ?? t(dict, "matchesHub.round", …)` fallback below is a
// SAFETY NET for a data fault, not the common path. An earlier version of this
// comment said the opposite, on the strength of the schema's own wording at
// `competition-hub-schema.ts:86-89`; the code says otherwise, and the code
// wins. `roundRoleLabel` (`lib/round-role-label.ts:21-53`) returns a string for
// EVERY role kind — `plain_round` included, as `bracket.round.plain`
// ("Round {n}") — and `roundRoleFor` always returns a role. So a fixture with a
// stage always arrives with its label already resolved by the builder.
//
// What actually makes it null is a missing STAGE: `competition-hub.ts:501,515`
// hangs both fields off the same `stage`, as `stageName: stage?.name ?? ""` and
// `roundLabel: stage ? roundRoleLabel(…) : null`. So when this fires,
// `stageName` is "" too and the card shows the round on its own.
//
// It is kept rather than deleted because on that fault the round would
// otherwise vanish from the card silently, and a spectator would have no way
// to tell which round they were looking at.
//
// W3's poster icon has no DOM in W2 (design ruling R4: no "coming soon").
import Link from "next/link";
import { EntityLogo, PendingCrest } from "@/components/ui/entity-logo";
import type { Dict as PublicDict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import { fmtDate, fmtTime } from "@/lib/format";
import type { HubMatchT } from "@/server/public-site/competition-hub-schema";

export interface MatchCardProps {
  match: HubMatchT;
  dict: PublicDict;
  locale: string;
  now: number;
  /**
   * Defaults to TRUE, stated here and in the destructure below rather than
   * left to `undefined`. Whole-branch review m2 — the prop was optional with
   * no default, so an omitted `showDivision` meant NO chip, while the only
   * test helper passed `?? true` and every test therefore rendered the arm
   * the component does not default to. A Task-11 caller that omitted the prop
   * would have got a chip-less card on a multi-division hub with nothing red
   * to say so. The hub is multi-division by definition, so the chip is the
   * default; a single-division caller (the division page's own match list)
   * passes `false`.
   */
  showDivision?: boolean;
  /**
   * The crest's box, 24 unless the caller asks for 32. Stated here and in the
   * destructure below rather than left to `undefined`.
   *
   * 32 is for the Overview's live-now rail, which is the one place a card is a
   * hero rather than a row — two names, a score and the whole card. Everywhere
   * else 24 is right: in a list of forty cards the NAME is the identifier, and
   * a bigger badge costs name width on a 320px phone.
   *
   * This is the prop `compact` should have been. The brief declared a `compact`
   * whose card markup had no branch for it, so it shipped dead: the Overview
   * passed it on every rail card and got an identical card back with nothing
   * red to say so. `crestSize` has a branch — it reaches `EntityLogo`'s `size`
   * — and `match-card.test.tsx` renders both values and asserts they differ.
   */
  crestSize?: 24 | 32;
  /**
   * The "STAGE · ROUND" caption in the meta row. Defaults to TRUE, stated here
   * and in the destructure below, so every caller that does not pass it keeps
   * the caption it always had — the Matches tab and the Overview mix stages
   * and rounds in one list, and the caption is how a card says which.
   *
   * The Knockout tab passes `false` (fix round, D1): its cards sit under the
   * stage's own heading and the pressed round chip, so the caption said the
   * same thing a third time — and on a 320px phone it truncated beside the
   * status ("DOUBLE ELIMINATION · WINNERS' FI…"). Only the caption goes; the
   * status slot keeps its place at the end of the row.
   */
  showRound?: boolean;
}

export function MatchCard({
  match: m,
  dict,
  locale,
  now,
  showDivision = true,
  crestSize = 24,
  showRound = true,
}: MatchCardProps) {
  const s0 = m.header.sides[0];
  const s1 = m.header.sides[1];

  // `Δ = scheduledAt - now`. Within 24h either side: a relative sentence
  // ("Starts in 2 hours"/"Starts in 40 minutes") via `Intl.RelativeTimeFormat`
  // in the ORG's locale. Beyond that: the venue-zone date. No `scheduledAt`
  // at all: Time TBD.
  //
  // ONE decision, not two. The previous version chose the value
  // (`Math.round(Δ/3_600_000) || Math.round(Δ/60_000)`) and the unit
  // (`|Δ| >= 3_600_000 ? "hour" : "minute"`) INDEPENDENTLY, and the two
  // disagree across the whole half-hour-to-an-hour band: `Math.round(Δ/
  // 3_600_000)` is 1 for every Δ in [30min, 60min) — JS rounds .5 up — so the
  // truthy check never fell through to minutes, while the unit was still
  // "minute". Every match 30-59 minutes away read "Starts in 1 minute", and
  // a match 45 minutes past its slot read "Starts 1 minute ago". Measured:
  // 29min correct, 30/40/45/59min all "1 minute", 60min correct. That is
  // exactly the window a spectator uses to decide whether to leave for the
  // ground, and the comment this replaces cited "starts in 40 minutes" as the
  // case it protected. The unit now picks the divisor as well as the noun, so
  // the two cannot drift apart again.
  //
  // Negative Δ (a fixture past its slot still bucketed `upcoming`) keeps
  // formatting relatively — "Starts 20 minutes ago" — deliberately: the two
  // states that would otherwise reach it, `postponed` and a decided match,
  // are both caught by the branches above this line in the meta row.
  //
  // VISUAL PASS 2026-09-09, both arms found by looking at the rendered card at
  // 320 rather than by reading the markup — this line and the status slot in
  // the meta row above it are each correct alone and say the same thing twice
  // when you see them together on one card.
  //
  //  * Unscheduled printed "Time TBD" top-right AND bottom-right, 100px apart.
  //    The status slot is where Live / Ended / the kick-off time already live,
  //    so that is where TBD belongs; this line returns null and its span does
  //    not render.
  //  * Beyond 24h printed "15:00" top-right and "Sat 12 Sept 15:00" here. The
  //    time was stated twice and only the DATE was new, so that is all this
  //    returns now. Both facts survive, neither repeats.
  function startsText(): string | null {
    if (!m.scheduledAt) return null;
    const delta = Date.parse(m.scheduledAt) - now;
    if (Math.abs(delta) < 24 * 3_600_000) {
      const useHours = Math.abs(delta) >= 3_600_000;
      const when = new Intl.RelativeTimeFormat(locale, { numeric: "always" }).format(
        Math.round(delta / (useHours ? 3_600_000 : 60_000)),
        useHours ? "hour" : "minute",
      );
      return t(dict, "matchesHub.startsIn", { when });
    }
    return fmtDate(m.tz, m.scheduledAt, { weekday: "short", day: "numeric", month: "short" });
  }

  function sideRow(i: 0 | 1) {
    const side = m.header.sides[i];
    const isWinner = m.winnerIndex === i;
    // A side with nobody in it yet (`entrantId === ""`, `hubSides` in
    // `competition-hub.ts`): the engine's "Winner of R3·2", a bye, or the pair
    // and loser sentences the Knockout tab puts in a waiting slot. It gets the
    // owner-approved mock's waiting look — a "?" placeholder crest and a muted
    // italic name — instead of a crest computed from its NAME, which gave a
    // waiting pair a coloured "PN" and made it read as one confirmed player
    // (Knockout fix round 2, D3). Decided here, where every tab's card is
    // drawn, so the Matches and Overview tabs get the same rule for free.
    const entrant = side.entrantId !== "";
    return (
      <div
        key={side.entrantId || i}
        data-testid={`mh-match-side-${i}`}
        data-winner={isWinner ? "true" : undefined}
        className={`flex items-center gap-2 ${isWinner || m.header.battingIndex === i ? "font-semibold text-ink" : "text-ink"}`}
      >
        {/* `colour` is the entrant's own, and until it was passed here it was
            an inert seam in its purest form: `Side.colour` is built for every
            hub fixture (`competition-hub.ts`'s `hubSides`, and
            `match-centre-load.ts:207` for W1) and NOTHING read it, so the same
            badge-less club was a coloured tile on the Teams tab and a grey one
            on every card of the same page. `EntityLogo` owns what a colour is
            allowed to be; this card only forwards it. */}
        {entrant ? (
          <EntityLogo
            src={side.badgeUrl}
            name={side.name}
            colour={side.colour}
            size={crestSize}
          />
        ) : (
          <PendingCrest size={crestSize} />
        )}
        {/* `min-w-0` is what lets `truncate` engage on a flex item — see
            AGENTS.md, "`truncate` needs `min-w-0` on the whole ancestor
            chain". */}
        <span
          className={`min-w-0 flex-1 truncate text-[15px]${entrant ? "" : " italic text-ink-muted"}`}
          title={side.name}
        >
          {side.name}
        </span>
        <span className="shrink-0 font-display text-lg tabular-nums">
          {m.header.scoreLines[i] ?? ""}
          <span className="ml-1 text-xs text-ink-muted">{m.header.subLines[i] ?? ""}</span>
        </span>
      </div>
    );
  }

  // Bound once: the span renders only when there is something to say, so the
  // condition and the content cannot drift apart.
  const starts = startsText();

  return (
    <Link
      href={m.href}
      data-testid={`mh-match-${m.fixtureId}`}
      // `aria-label` on the wrapping `<a>` REPLACES everything inside it for
      // the accessible name, so this string is the whole of what a screen
      // reader announces for the card. `matchesHub.card.label` shipped as the
      // bare noun "Match card" in all four locales while this call already
      // passed `{home, away}` — and `interpolate()` discards vars with no
      // matching `{param}` silently — so a link list over a 40-match hub read
      // "Match card, link" forty times, with no way to tell one card from
      // another. The key now carries both names in every locale, and
      // `match-card.test.tsx` asserts the RENDERED attribute rather than the
      // call, because the call was already right.
      aria-label={t(dict, "matchesHub.card.label", { home: s0.name, away: s1.name })}
      className="block rounded-xl border border-zinc-200/80 bg-surface p-3 shadow-sm transition hover:border-accent-line"
    >
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-ink-muted">
        {showDivision ? (
          // `shrink-0 max-w-[45%] truncate` (whole-branch review m4): every
          // other item in this flex row already controls its own white space
          // — the stage/round span below is `min-w-0 truncate`, the status
          // slot is `shrink-0` — and the chip had none, so a long division
          // name ("Mixed Doubles Championship") shrank past its min-content
          // and wrapped INSIDE the pill, turning the meta row into a two-line
          // blob. The same failure AGENTS.md records for the detail dock's
          // entrant chips. The cap is a share of the row rather than a fixed
          // width so it holds at 320 and at 1280 alike.
          <span
            data-testid="mh-match-division"
            className="max-w-[45%] shrink-0 truncate rounded-full bg-accent-soft px-2 py-0.5 text-accent-strong"
          >
            {m.divisionName}
          </span>
        ) : null}
        {showRound ? (
          <span className="min-w-0 truncate">
            {[m.stageName, m.roundLabel ?? t(dict, "matchesHub.round", { round: m.roundNo })]
              .filter(Boolean)
              .join(" · ")}
          </span>
        ) : null}
        <span className="ml-auto shrink-0">
          {m.bucket === "live" ? (
            <span data-testid="mh-match-live" className="flex items-center gap-1 font-bold text-emerald-600">
              <span className="animate-live-pulse h-1.5 w-1.5 rounded-full bg-emerald-500" />
              {t(dict, "matchesHub.live")}
            </span>
          ) : m.bucket === "completed" ? (
            t(dict, "matchesHub.ended")
          ) : m.scheduledAt ? (
            fmtTime(m.tz, m.scheduledAt)
          ) : (
            t(dict, "matchesHub.timeTbd")
          )}
        </span>
      </div>
      <div className="mt-2 space-y-1">{[0, 1].map((i) => sideRow(i as 0 | 1))}</div>
      {/* `flex-wrap` (visual pass, 320): a decided card has to fit the venue
          AND the result line, and at 320 that is 288px of content in 264px of
          box — so the venue truncated to "Garon Park · …", with the ellipsis
          landing after the separator, which reads as broken rather than
          shortened. Wrapping gives the venue the whole first line and drops
          the result onto its own, both complete. It costs a line only on the
          cards that were crowded: a single-item row does not wrap, so the
          venue-less card keeps its result right-aligned exactly as it was. */}
      <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 text-xs text-ink-muted">
        <span className="min-w-0 truncate">{[m.venueName, m.courtName].filter(Boolean).join(" · ")}</span>
        {m.resultLine ? (
          <span data-testid="mh-match-result" className="shrink-0 font-medium text-ink">
            {m.resultLine}
          </span>
        ) : m.header.statusLine ? (
          // A match that was called off. The builder already puts the reason
          // here as a `Msg` — `competition-hub.ts:312-317` sets `statusLine`
          // for abandoned / cancelled / forfeited / postponed / walkover, and
          // the copy exists in all four locales — and this card was dropping
          // it, which is the inert seam in its purest form: the producer built
          // the field for exactly this case and the consumer never read it.
          //
          // Without it an abandoned match reads as an ordinary finished one
          // with its result sentence missing, and a FORFEITED match is worse:
          // `winnerIndex` is taken straight off `winner_entrant_id` and is not
          // gated on status, so one side renders in bold with nothing saying
          // why. `resultLine` cannot cover these — it is gated on
          // `status === "decided"` and these are all `other`.
          //
          // Ahead of the upcoming branch deliberately: `postponed` is NOT
          // terminal, so it sits in Upcoming carrying its OLD `scheduledAt`,
          // and "Starts in 2 hours" about a match nobody is playing is worse
          // than saying nothing.
          <span data-testid="mh-match-status" className="shrink-0 font-medium text-ink">
            {t(dict, m.header.statusLine.key, m.header.statusLine.params)}
          </span>
        ) : m.bucket === "upcoming" && starts ? (
          <span data-testid="mh-match-starts" className="shrink-0">
            {starts}
          </span>
        ) : null}
      </div>
    </Link>
  );
}
