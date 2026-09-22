"use client";

// "Some of this competition is still invisible to the public" — the banner, and
// the one control that fixes it.
//
// WHY IT EXISTS. `public_fixtures_v` (V401__fixture_stream_url.sql) returns NULL
// for `scheduled_at`, `venue` and `court_label` on every fixture whose division
// is still at `status = 'setup'`. So a fully placed competition board shows the
// ORGANISER real times while the public hub shows "Time TBD" for every match,
// and nothing anywhere said so. The only control that moved a division out of
// setup was the single-division Publish button (`schedule-board.tsx`), which
// renders only when `single` is non-null — i.e. never on a nine-division
// competition board. There was no publish path at all, and no symptom either.
//
// SHAPE. Owner-approved "Option A: a banner above the board" (per-chip dots on
// the legend were considered and REJECTED — do not reintroduce them). One
// sentence carrying the count AND the consequence, one trailing button, and —
// after a call returns — the outcome, naming every division that did not go
// live and why. The conflict rows under a blocked division are rendered by
// `ConflictList`, the same component the gate dialog uses, so a code reads
// identically wherever the organiser meets it.
import { useMsg, usePlural } from "@/components/i18n/dict-provider";
import type { FeedLabelPair } from "@/lib/schedule-board";
import { ConflictList } from "./conflict-list";
import type {
  BoardDivision,
  BoardFixture,
  PublishAllDivisionResult,
  PublishAllOutcome,
} from "./types";

/**
 * The divisions Publish all would actually release — and, equivalently, the
 * ones whose matches the public currently cannot see times for.
 *
 * TWO conditions, and the second is an owner ruling (2026-09-22), not a nicety.
 *
 * `status === "setup"` is V401's own key: `public_fixtures_v` NULLs
 * `scheduled_at`/`venue`/`court_label` on exactly that value, and division
 * status is forward-only (setup → scheduled → active → completed) so nothing
 * later can fall back into it.
 *
 * AT LEAST ONE FIXTURE is the ruling. Leaving setup is irreversible in effect:
 * the view stops redacting that division for ever, so any fixture added to it
 * afterwards goes public the moment it is placed, with no second publish to
 * gate it. A bulk button must not arm a division the organiser has not built
 * yet — so the server skips an empty one, and this count has to use the SAME
 * rule or the banner promises a release that never happens ("3 of 9" followed
 * by a report of 2, and an organiser hunting a third candidate that never
 * existed).
 *
 * It also makes the banner's own sentence truer rather than weaker: the
 * consequence it states is "the public still sees Time TBD on their matches",
 * which is simply not a fact about a division that has no matches.
 *
 * `fixtures` is the UNFILTERED board (`actions.board` — the page loads every
 * fixture of every division of the competition, `listDivisionFixturesForBoard`
 * filtering on nothing but `division_id`, and the legend filter never touches
 * it). No new plumbing: the component already holds this for its conflict rows.
 */
export function unreleasedDivisions(
  divisions: BoardDivision[],
  fixtures: BoardFixture[],
): BoardDivision[] {
  const populated = new Set(fixtures.map((f) => f.division_id));
  return divisions.filter((d) => d.status === "setup" && populated.has(d.id));
}

/**
 * Whether the board shows the banner at all.
 *
 * Takes the board's OWN `single` rather than re-deriving `divisions.length === 1`
 * — two copies of that rule is how a surface starts appearing on a board it was
 * never meant for. `competitionId` is in here because it is not decoration: with
 * no competition id there is nothing to POST to, and a button that cannot act is
 * worse than no button.
 */
export function shouldShowUnreleasedBanner(input: {
  /** `null` on the COMPETITION board — the only board this belongs on. The
   *  single-division board already has its own Publish button. */
  single: BoardDivision | null;
  canEdit: boolean;
  competitionId: string | null | undefined;
  divisions: BoardDivision[];
  /** The UNFILTERED board. Required, not optional: the whole point of the
   *  2026-09-22 ruling is that a division with no fixtures is not a candidate,
   *  and an optional argument would let a call site keep the old, wider rule
   *  by omission — silently, and exactly where it matters most. */
  fixtures: BoardFixture[];
}): boolean {
  if (input.single !== null) return false;
  if (!input.canEdit) return false;
  if (!input.competitionId) return false;
  // Through `unreleasedDivisions`, never a second copy of the rule: a board
  // that counted candidates one way and decided whether to show the button
  // another is how "Publish all" ends up on a competition it can do nothing
  // for. If every setup division is empty this is 0 and the banner does not
  // render at all — a button that publishes nothing is worse than no button.
  return unreleasedDivisions(input.divisions, input.fixtures).length > 0;
}

/**
 * The outcome split into the three things an organiser can DO about it.
 *
 * `needsAck` is deliberately the narrow bucket: only a refusal the server
 * itself marked non-blocking can be cleared by re-sending with
 * `acknowledge_warnings: true`. Anything else that did not publish — a blocking
 * refusal, or (shape-wise possible, contract-wise not expected) a bare
 * `published: false` with no refusal at all — lands in `blocked`, because none
 * of them has a way through and offering one would be a promise the server
 * cannot keep.
 */
export function partitionPublishOutcome(results: PublishAllDivisionResult[]): {
  published: PublishAllDivisionResult[];
  needsAck: PublishAllDivisionResult[];
  blocked: PublishAllDivisionResult[];
} {
  const published = results.filter((r) => r.published);
  const needsAck = results.filter((r) => !r.published && r.refusal !== undefined && !r.refusal.blocking);
  const blocked = results.filter(
    (r) => !r.published && !(r.refusal !== undefined && !r.refusal.blocking),
  );
  return { published, needsAck, blocked };
}

export function UnreleasedBanner({
  divisions,
  outcome,
  busy,
  onPublishAll,
  board,
  entrantNames,
  feedLabels,
  fixtureTitles,
}: {
  /** EVERY division on the board. The count in the sentence is chosen here,
   *  from this list, rather than handed in as a number — a test that passes the
   *  answer in cannot witness the banner counting the wrong thing. */
  divisions: BoardDivision[];
  /** The last competition-wide publish's answer, or `null` before one is made. */
  outcome: PublishAllOutcome | null;
  busy: boolean;
  onPublishAll: () => void;
  /** The UNFILTERED board (`actions.board`). Two jobs: a blocked division may
   *  well be filtered out of the legend and its conflict rows must still name
   *  their fixtures rather than degrading to "removed fixture"; and since the
   *  2026-09-22 ruling this is also what decides which divisions COUNT — an
   *  empty one is not a Publish all candidate. The legend-filtered `board`
   *  would under-count the moment an organiser filtered a division out. */
  board: BoardFixture[];
  entrantNames: Record<string, string>;
  feedLabels: Record<string, FeedLabelPair>;
  fixtureTitles?: Record<string, string>;
}) {
  const msg = useMsg();
  const plural = usePlural();

  const unreleased = unreleasedDivisions(divisions, board);
  const { published, needsAck, blocked } = partitionPublishOutcome(outcome?.results ?? []);
  // One list, ordered so the thing the organiser can act on sits first.
  const remaining = [...needsAck, ...blocked];

  return (
    <div
      data-testid="board-unreleased-banner"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5"
    >
      <span
        aria-hidden
        className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-amber-100 text-sm text-amber-700"
      >
        ⚠
      </span>
      {/* `min-w-0` here AND on every descendant that holds a `truncate`: a
          40-character division name overflows the page otherwise, and only a
          browser at 320 ever shows it. */}
      <div className="min-w-0 flex-1">
        <p data-testid="board-unreleased-headline" className="text-sm font-semibold text-amber-900">
          {plural("board.publishAll.headline", unreleased.length, { total: divisions.length })}
        </p>
      </div>
      <button
        type="button"
        data-testid="board-publish-all"
        disabled={busy}
        onClick={onPublishAll}
        className="inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-amber-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-amber-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500 disabled:cursor-not-allowed disabled:opacity-60 max-md:w-full"
      >
        {msg("board.publishAll.cta")}
      </button>

      {outcome !== null && (
        <div data-testid="board-publish-all-outcome" className="w-full min-w-0 space-y-2">
          <p className="text-xs font-medium text-amber-900">
            {published.length > 0
              ? plural("board.publishAll.publishedCount", published.length)
              : msg("board.publishAll.publishedNone")}
          </p>
          {remaining.length > 0 && (
            <>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-800">
                {msg("board.publishAll.remainingTitle")}
              </p>
              <ul className="min-w-0 space-y-2">
                {remaining.map((r) => {
                  const overridable = r.refusal !== undefined && !r.refusal.blocking;
                  return (
                    <li
                      key={r.division_id}
                      data-testid="board-publish-all-division"
                      data-division-id={r.division_id}
                      data-state={overridable ? "needs_ack" : "blocked"}
                      className="min-w-0 rounded-lg border border-amber-200 bg-white/70 p-2"
                    >
                      <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="min-w-0 truncate text-xs font-semibold text-slate-800">
                          {r.name}
                        </span>
                        <span
                          className={`shrink-0 rounded px-1 text-[10px] font-semibold ${
                            overridable ? "bg-amber-100 text-amber-800" : "bg-red-100 text-red-700"
                          }`}
                        >
                          {msg(
                            overridable ? "board.publishAll.needsAck" : "board.publishAll.blocked",
                          )}
                        </span>
                      </p>
                      {/* A blocked division owes its REASONS — "blocked" alone
                          sends the organiser hunting. Same renderer as the gate
                          dialog; a plain (non-scrolling) list, because an
                          `overflow-y-auto` region owes axe a tabindex, role and
                          name and this banner has room to grow instead. */}
                      {!overridable && (r.refusal?.conflicts.length ?? 0) > 0 && (
                        <ConflictList
                          conflicts={r.refusal?.conflicts ?? []}
                          board={board}
                          entrantNames={entrantNames}
                          feedLabels={feedLabels}
                          fixtureTitles={fixtureTitles}
                          className="mt-1.5 min-w-0 space-y-1.5"
                          testId="board-publish-all-conflict"
                          keyPrefix={`${r.division_id}-`}
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
