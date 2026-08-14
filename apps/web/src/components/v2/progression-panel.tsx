"use client";

// Stage-progression proposal panel (P6/D4b task B, scope item 1). Renders on
// a `.seeding`-declared stage's fixtures tab, fed getSeedProposal's read-only
// result as a server prop (no route — stage_seed_proposals has no GET;
// server/usecases/stages.ts's getSeedProposal docstring). Destination slots
// resolve through task A's resolveSlotLabel (lib/slot-label.ts) — never a
// re-implementation.
//
// A tie is resolved PURELY through edits[], never tiePicks[]: the server
// accepts both as independent mechanisms (confirmSeedProposal, stages.ts),
// but every tie's slot(s) can equally be satisfied by an ordinary
// edit-in-place entry (its `coveredByEdit` check), so this panel sends only
// `edits[]` — one interaction pattern for the organiser (every entrant cell
// is the SAME <select>, tied or not), one payload shape to test, not two.
//
// `locale` arrives as an explicit prop from the division page (an RSC),
// never via useLocale() — useLocale() throws outside a <DictProvider>, which
// would make this component untestable with the repo's hook-harness (no
// provider tree there) for no real benefit, since the RSC already resolved
// the locale once.
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useMsg } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { resolveSlotLabel, type SlotLabelLookup } from "@/lib/slot-label";
import { seedingErrorMessage } from "@/lib/seeding-error";
import type { Locale } from "@/lib/i18n-constants";
import type { SlotLabel } from "@/server/usecases/stage-seeding";

type Msg = (key: MessageKey, vars?: Record<string, string | number>) => string;

export interface QualifierOut {
  rank: number;
  source: { stageId: string; group?: string; rank: number };
  entrantId: string;
  destinationSlot: string;
}
export interface TieOut {
  slots: string[];
  entrantIds: string[];
  reason: string;
}
export interface SeedProposal {
  id: string;
  stageId: string;
  status: "draft" | "confirmed" | "stale";
  computed: { qualifiers: QualifierOut[]; ties: TieOut[]; standingsHash: string };
}

interface FixtureLabelRow {
  id: string;
  home_slot_label?: SlotLabel | null;
  away_slot_label?: SlotLabel | null;
}

// ---------------------------------------------------------------------------
// Pure logic — exported for direct unit testing, no DOM. Mirrors
// stages-panel.tsx's generatePreconditionMessage/regenerationBlastRadius
// convention in this same package.
// ---------------------------------------------------------------------------

/** Every tie's every slot must carry an explicit edit before confirm is
 *  allowed. Mirrors confirmSeedProposal's own `coveredByEdit` check
 *  (stages.ts) — this is a UI convenience gate, not the safety net; the
 *  server re-validates and 422s SEEDING_TIE_UNRESOLVED regardless. */
export function allTiesResolved(ties: readonly TieOut[], editsBySlot: ReadonlyMap<string, string>): boolean {
  return ties.every((t) => t.slots.every((s) => Boolean(editsBySlot.get(s))));
}

/** `Map<destinationSlot, entrantId>` -> the wire `edits[]` shape
 *  (ConfirmSeedProposal, schemas.ts:3063). */
export function buildEditsPayload(
  editsBySlot: ReadonlyMap<string, string>,
): { destinationSlot: string; entrantId: string }[] {
  return [...editsBySlot.entries()].map(([destinationSlot, entrantId]) => ({ destinationSlot, entrantId }));
}

/** Destination-slot display text: look up the fixture side's OWN slot label
 *  and resolve it through task A's resolver — never a hand-built string. */
export function destinationSlotLabelText(
  destinationSlot: string,
  fixtures: readonly FixtureLabelRow[],
  lookup: SlotLabelLookup,
  fallbackKey: MessageKey,
): string {
  const [fixtureId, side] = destinationSlot.split(":");
  const fixture = fixtures.find((f) => f.id === fixtureId);
  const label = side === "home" ? fixture?.home_slot_label : fixture?.away_slot_label;
  return resolveSlotLabel(label ?? null, lookup, fallbackKey);
}

/** "Groups — Pool A, rank 1" / "League — rank 3" — the qualifier's STANDINGS
 *  origin. Distinct from the destination-slot column, which names the
 *  fixture slot it fills, not where it came from. */
export function formatQualifierSource(
  source: { stageId: string; group?: string; rank: number },
  stageNames: Record<string, string>,
  msg: Msg,
): string {
  const stage = stageNames[source.stageId] ?? "?";
  return source.group
    ? msg("progression.sourceGroupRank", { stage, group: source.group, rank: source.rank })
    : msg("progression.sourceRank", { stage, rank: source.rank });
}

/** Candidate entrants for a slot's edit-in-place select. A TIED slot offers
 *  its own tie's candidates (the ambiguity is between THOSE entrants, not
 *  the whole division); any other slot offers every division entrant — both
 *  narrowed by the SAME `usedElsewhere` exclusion (effective pick per slot,
 *  entries for THIS slot itself excluded) — softly steering away from the
 *  double-assignment the server 422s on, never itself the validation.
 *
 *  The tied branch used to skip this exclusion (review finding 1, P6/D4b
 *  task B fix round 1): two tied rows sharing a candidate pool could both
 *  offer, and a user could pick, the SAME entrant — allTiesResolved only
 *  checks slot coverage, not uniqueness, so Confirm would enable and the
 *  POST would 422 SEEDING_SLOT_DOUBLE_ASSIGNED. Applying the same filter to
 *  both branches closes it at the option list, where a real user is
 *  actually constrained.
 *
 *  A TIED slot's own COMPUTED DEFAULT is excluded from `effective` until
 *  `editsBySlot` names it explicitly (review finding, fix round 3, Critical
 *  2 — a regression THIS fix round 1 change introduced): `qualifiers`
 *  carries a provisional default for every slot, tied or not, but a tied
 *  slot renders unpicked (`value=""`, the component's own render). Seeding
 *  `effective` from that default unconditionally meant each tied row
 *  implicitly "held" its computed pick before the organiser touched
 *  anything — for the commonest real shape, a tie between exactly 2
 *  entrants across 2 slots (two teams level in a group; see
 *  stage-seeding.ts's resolveQualifiers / the `tie.entrantIds.length === 2`
 *  case), that left EXACTLY ONE option per row: the organiser could only
 *  rubber-stamp the engine's arbitrary "lots" order, never actually pick —
 *  precisely what resolveQualifiers' own doc comment says must never happen
 *  silently. A NON-tied slot keeps seeding from its default (there is only
 *  ever one candidate for it to matter against); double-assignment stays
 *  closed for tied slots too, because the first EXPLICIT pick on one row
 *  immediately narrows its sibling's pool (verified in
 *  progression-panel-logic.test.ts, not assumed). */
export function optionsForSlot(
  destinationSlot: string,
  qualifiers: readonly QualifierOut[],
  ties: readonly TieOut[],
  editsBySlot: ReadonlyMap<string, string>,
  allEntrantIds: readonly string[],
): string[] {
  const tiedSlots = new Set(ties.flatMap((t) => t.slots));
  const effective = new Map(
    qualifiers
      .filter((q) => !tiedSlots.has(q.destinationSlot) || editsBySlot.has(q.destinationSlot))
      .map((q) => [q.destinationSlot, q.entrantId] as const),
  );
  for (const [slot, id] of editsBySlot) effective.set(slot, id);
  const usedElsewhere = new Set(
    [...effective.entries()].filter(([slot]) => slot !== destinationSlot).map(([, id]) => id),
  );
  const tie = ties.find((t) => t.slots.includes(destinationSlot));
  const pool = tie ? tie.entrantIds : allEntrantIds;
  return pool.filter((id) => !usedElsewhere.has(id));
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface ProgressionPanelProps {
  stageId: string;
  stageName: string;
  /** getSeedProposal's result, server-fetched — null when nothing has been
   *  computed for this stage yet (most commonly: the source stage hasn't
   *  completed). Never fetched by this component itself — see the module
   *  docstring; a panel that POSTs on mount to discover its own state would
   *  reintroduce the exact side effect getSeedProposal exists to avoid. */
  proposal: SeedProposal | null;
  fixtures: FixtureLabelRow[];
  entrantNames: Record<string, string>;
  stageNames: Record<string, string>;
  locale: Locale;
  canEdit: boolean;
}

export function ProgressionPanel({
  stageId,
  stageName,
  proposal,
  fixtures,
  entrantNames,
  stageNames,
  locale,
  canEdit,
}: ProgressionPanelProps) {
  const msg = useMsg();
  const router = useRouter();
  const [editsBySlot, setEditsBySlot] = useState<Map<string, string>>(new Map());
  const [busy, setBusy] = useState<"recompute" | "confirm" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const allEntrantIds = useMemo(() => Object.keys(entrantNames), [entrantNames]);
  const tiedSlots = useMemo(() => new Set(proposal?.computed.ties.flatMap((t) => t.slots) ?? []), [proposal]);

  function reportError(err: unknown) {
    setError(
      err instanceof ApiV1Error ? seedingErrorMessage(locale, err.code, err.message) : msg("progression.genericError"),
    );
  }

  async function recompute() {
    setError(null);
    setNotice(null);
    setBusy("recompute");
    try {
      await apiV1(`/api/v1/stages/${stageId}/seed-proposal`, { method: "POST", json: {} });
      // A recompute produces a BRAND NEW proposal — its own qualifiers, its
      // own ties, possibly a different slot set entirely. None of that
      // carries meaning for the picks the organiser made against the OLD
      // proposal, so every local edit is discarded here rather than
      // selectively kept: a "carry the edit if the slot still exists" rule
      // would still be wrong whenever the qualifier that made the pick
      // meaningful (e.g. which entrants a tie was between) has itself
      // changed, and there is no way to tell that apart from here. Without
      // this, a stale pick either rides into `buildEditsPayload`'s edits[]
      // for a slot the new proposal doesn't have (server rejects with
      // SEEDING_EDIT_UNKNOWN_SLOT / SEEDING_SLOT_FOREIGN_FIXTURE) or
      // silently overrides a slot the new proposal DOES still name (review
      // finding, fix round 2).
      setEditsBySlot(new Map());
      router.refresh();
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(null);
    }
  }

  async function confirm() {
    if (!proposal) return;
    setError(null);
    setNotice(null);
    setBusy("confirm");
    try {
      const out = await apiV1<{ filled: number }>(`/api/v1/stages/${stageId}/seed-proposal/confirm`, {
        method: "POST",
        json: { proposalId: proposal.id, edits: buildEditsPayload(editsBySlot) },
      });
      setNotice(msg("progression.confirmedNotice", { filled: out.filled }));
      setEditsBySlot(new Map());
      router.refresh();
    } catch (err) {
      reportError(err);
      // SEEDING_ALREADY_CONFIRMED / SEEDING_PROPOSAL_STALE mean someone else
      // — another organiser, another tab — already acted on this exact
      // proposal (review finding 2, fix round 1). The draft branch below has
      // no way out except a fresh server fetch: the recompute affordance
      // only appears once `proposal.status` itself flips to "confirmed" or
      // "stale", and without a refresh the panel stays wedged, rendered as
      // "draft" and holding now-dead editsBySlot state, until a manual
      // reload. Every OTHER code is the current organiser's own fixable
      // mistake (e.g. SEEDING_TIE_UNRESOLVED) — refreshing there would only
      // discard their in-progress edits for no reason.
      if (
        err instanceof ApiV1Error &&
        (err.code === "SEEDING_ALREADY_CONFIRMED" || err.code === "SEEDING_PROPOSAL_STALE")
      ) {
        router.refresh();
      }
    } finally {
      setBusy(null);
    }
  }

  function onSlotChange(destinationSlot: string, computedEntrantId: string | undefined, value: string) {
    setEditsBySlot((prev) => {
      const next = new Map(prev);
      if (!value || value === computedEntrantId) next.delete(destinationSlot);
      else next.set(destinationSlot, value);
      return next;
    });
  }

  if (!canEdit) return null;

  if (!proposal) {
    return (
      <section className="card mb-6 p-4" data-progression-state="empty">
        <h3 className="text-sm font-semibold text-slate-800">{stageName}</h3>
        <p className="mt-2 text-sm text-slate-500">{msg("progression.noProposalYet")}</p>
        {error && (
          <p className="mt-2 text-sm text-red-600" role="alert">
            {error}
          </p>
        )}
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void recompute()}
          className="btn btn-primary mt-3 min-h-11 px-3 py-1.5 text-xs"
        >
          {busy === "recompute" ? msg("progression.recomputing") : msg("progression.computeCta")}
        </button>
      </section>
    );
  }

  if (proposal.status === "stale") {
    return (
      <section className="card mb-6 border-amber-200 bg-amber-50 p-4" data-progression-state="stale">
        <h3 className="text-sm font-semibold text-slate-800">{stageName}</h3>
        <p className="mt-2 text-sm text-amber-800">{msg("progression.staleBanner")}</p>
        {error && (
          <p className="mt-2 text-sm text-red-600" role="alert">
            {error}
          </p>
        )}
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void recompute()}
          className="btn btn-primary mt-3 min-h-11 px-3 py-1.5 text-xs"
        >
          {busy === "recompute" ? msg("progression.recomputing") : msg("progression.recompute")}
        </button>
      </section>
    );
  }

  if (proposal.status === "confirmed") {
    return (
      <section className="card mb-6 border-emerald-200 bg-emerald-50 p-4" data-progression-state="confirmed">
        <h3 className="text-sm font-semibold text-slate-800">{stageName}</h3>
        <p className="mt-2 text-sm text-emerald-800">{msg("progression.alreadyConfirmed")}</p>
      </section>
    );
  }

  const ready = allTiesResolved(proposal.computed.ties, editsBySlot);

  return (
    <section className="card mb-6 overflow-hidden" data-progression-state="draft">
      <header className="border-b border-slate-100 px-4 py-3">
        <h3 className="text-sm font-semibold text-slate-800">{stageName}</h3>
        <p className="text-xs text-slate-500">{msg("progression.heading")}</p>
      </header>
      {/* Wide table — scrolls in its OWN container, never the page (v3 UI bar). */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-left text-xs font-medium text-slate-500">
              <th className="px-4 py-2">{msg("progression.rankHeader")}</th>
              <th className="px-4 py-2">{msg("progression.entrantHeader")}</th>
              <th className="px-4 py-2">{msg("progression.sourceHeader")}</th>
              <th className="px-4 py-2">{msg("progression.destinationHeader")}</th>
            </tr>
          </thead>
          <tbody>
            {proposal.computed.qualifiers.map((q) => {
              const tied = tiedSlots.has(q.destinationSlot);
              const options = optionsForSlot(
                q.destinationSlot,
                proposal.computed.qualifiers,
                proposal.computed.ties,
                editsBySlot,
                allEntrantIds,
              );
              const value = tied ? (editsBySlot.get(q.destinationSlot) ?? "") : (editsBySlot.get(q.destinationSlot) ?? q.entrantId);
              return (
                <tr
                  key={q.destinationSlot}
                  data-progression-row={q.destinationSlot}
                  data-progression-tied={tied ? "true" : "false"}
                  className={`border-b border-slate-50 last:border-0 ${tied ? "bg-amber-50" : ""}`}
                >
                  <td className="px-4 py-2 tabular-nums text-slate-500">{q.rank}</td>
                  <td className="px-4 py-2">
                    <select
                      value={value}
                      onChange={(e) => onSlotChange(q.destinationSlot, tied ? undefined : q.entrantId, e.target.value)}
                      className="select min-h-11 w-full max-w-[12rem]"
                      aria-label={msg("progression.entrantHeader")}
                    >
                      {tied && <option value="">{msg("progression.choosePlaceholder")}</option>}
                      {options.map((id) => (
                        <option key={id} value={id}>
                          {entrantNames[id] ?? "?"}
                        </option>
                      ))}
                    </select>
                    {tied && <p className="mt-1 text-xs text-amber-700">{msg("progression.tiedHint")}</p>}
                  </td>
                  <td className="px-4 py-2 text-slate-600">{formatQualifierSource(q.source, stageNames, msg)}</td>
                  <td className="px-4 py-2 text-slate-600">{destinationSlotLabelText(q.destinationSlot, fixtures, msg, "schedule.tbd")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 px-4 py-3">
        {error && (
          <p className="text-sm text-red-600" role="alert">
            {error}
          </p>
        )}
        {notice && <p className="text-sm text-emerald-700">{notice}</p>}
        <div className="flex-1" />
        <button
          type="button"
          disabled={busy !== null || !ready}
          onClick={() => void confirm()}
          className="btn btn-primary min-h-11 px-4 py-1.5 text-xs"
        >
          {busy === "confirm" ? msg("progression.confirming") : msg("progression.confirmCta")}
        </button>
      </div>
    </section>
  );
}
