"use client";
// RS006 Step 3 — one cart entry's details card (design §4 step 3):
// roster + live per-player eligibility + the mixed-composition meter +
// the self-row picker + custom form_fields. Owns nothing itself beyond
// wiring cart.ts's step-3 actions and computing the live eligibility
// verdict once per render (rosterEligibilityForDivision,
// eligibility-presentation.ts — the SAME evaluator step 2 uses, never a
// second one).
import { useT } from "@/components/i18n/dict-provider";
import type { EligibilityIssue } from "@/lib/registration-rules";
import type { CartAction } from "./cart";
import { rosterEligibilityForDivision, rosterIssueMessageKey } from "./eligibility-presentation";
import { FormFields } from "./form-fields";
import { effectiveSelfPlayers } from "./roster";
import { RosterTable } from "./roster-table";
import { FIELD, FIELD_LABEL as LABEL } from "./styles";
import type { CartEntry, ContactState, DivisionLike } from "./types";

/** Groups issues by their 1-based `playerIndex` so RosterTable can render
 *  each row's own issues beside it. `MIXED_NEEDS_BOTH_GENDERS` carries no
 *  `playerIndex` (roster-wide) and is never in this map — the meter below
 *  reads it separately, straight off the verdict's issue list. */
function issuesByPlayerIndex(issues: readonly EligibilityIssue[]): Map<number, EligibilityIssue[]> {
  const map = new Map<number, EligibilityIssue[]>();
  for (const issue of issues) {
    if (issue.playerIndex == null) continue;
    const list = map.get(issue.playerIndex) ?? [];
    list.push(issue);
    map.set(issue.playerIndex, list);
  }
  return map;
}

export function EntryDetails({
  entry,
  division,
  contact,
  isSelfEntry,
  selfPlayerIndex,
  seasonStartYear,
  dispatch,
  importText,
  onImportTextChange,
}: {
  entry: CartEntry;
  /** Absent for a stale/unresolvable division_id (a restored cart against a
   *  division that has since vanished) — degrades to rendering nothing,
   *  same precedent as entry-cart.tsx's own `division` lookup. */
  division: DivisionLike | undefined;
  contact: ContactState;
  /** Whether THIS entry is self-linked (entry.registering_self) — drives
   *  both the contact dob/gender fallback and whether the self-row picker
   *  renders at all. RS006: per-entry, so more than one EntryDetails card
   *  can have this true at once. */
  isSelfEntry: boolean;
  selfPlayerIndex: number | null;
  seasonStartYear: number;
  dispatch: (action: CartAction) => void;
  /** This entry's paste-roster draft — see roster-table.tsx's header for
   *  why it's controlled from RegisterStepper rather than local state. */
  importText: string;
  onImportTextChange: (text: string) => void;
}) {
  const t = useT();

  if (!division) return null;

  if (entry.free_agent) {
    return (
      <div className="min-w-0 rounded-xl border border-zinc-200/80 bg-surface p-4 shadow-sm sm:p-6">
        <h3 className="font-display text-lg font-semibold text-ink">{division.name}</h3>
        <p className="mt-2 text-sm text-ink-muted">{t("register.details.freeAgent.note")}</p>
      </div>
    );
  }

  // "Collected once" (design §4 step 1): the self row's blank dob/gender
  // falls back to the WHO-step contact for EVALUATION only — the table
  // itself still edits/shows the raw (unmerged) rows, see roster.ts's
  // effectiveSelfPlayers doc comment.
  const effective = isSelfEntry ? effectiveSelfPlayers(entry, contact) : entry.players;
  const verdict = rosterEligibilityForDivision(division, effective, seasonStartYear);
  const rowIssues = issuesByPlayerIndex(verdict.issues);
  const mixedUnmet = verdict.issues.some((i) => i.code === "MIXED_NEEDS_BOTH_GENDERS");
  const showSelfPicker = isSelfEntry && entry.entrant_kind !== "individual";

  return (
    <div className="min-w-0 rounded-xl border border-zinc-200/80 bg-surface p-4 shadow-sm sm:p-6">
      <h3 className="font-display text-lg font-semibold text-ink">{division.name}</h3>

      <div className="mt-3">
        <RosterTable
          entry={entry}
          requiresDob={division.requires_dob}
          requiresGender={division.requires_gender}
          issuesByRow={rowIssues}
          importText={importText}
          onImportTextChange={onImportTextChange}
          onAddPlayer={() => dispatch({ type: "ADD_PLAYER", id: entry.id })}
          onRemovePlayer={(index) => dispatch({ type: "REMOVE_PLAYER", id: entry.id, index })}
          onUpdatePlayer={(index, patch) => dispatch({ type: "UPDATE_PLAYER", id: entry.id, index, patch })}
          onImportPlayers={(players) => dispatch({ type: "IMPORT_PLAYERS", id: entry.id, players })}
        />
      </div>

      {/* The mixed-composition METER — always visible on a mixed division,
          not gated behind an "attempted" flag (same live-feedback precedent
          as step 2's self-ineligibility notices): a progress indicator, not
          a nag. */}
      {division.category === "mixed" && (
        <div
          className={`mt-3 rounded-lg border px-3 py-2 text-xs ${
            mixedUnmet ? "border-amber-200 bg-amber-50 text-amber-800" : "border-emerald-200 bg-emerald-50 text-emerald-800"
          }`}
        >
          {mixedUnmet ? t(rosterIssueMessageKey("MIXED_NEEDS_BOTH_GENDERS")!) : t("register.details.mixedMeter.satisfied")}
        </div>
      )}

      {/* Which roster row is the contact — only meaningful once this entry
          IS the self-linked one and the kind isn't "individual" (the schema
          implies index 0 there, cart.ts's toGroupEntry). Reuses the RS001-era
          reserved register.self.rosterLabel/rosterNone keys (never wired
          until this session had a roster to pick from). */}
      {showSelfPicker && (
        <div className="mt-3">
          <label className={LABEL} htmlFor={`reg-self-index-${entry.id}`}>
            {t("register.self.rosterLabel")}
          </label>
          <select
            id={`reg-self-index-${entry.id}`}
            className={`${FIELD} min-w-0`}
            value={selfPlayerIndex ?? ""}
            onChange={(e) =>
              dispatch({
                type: "SET_SELF_PLAYER_INDEX",
                id: entry.id,
                index: e.target.value === "" ? null : Number(e.target.value),
              })
            }
          >
            <option value="">{t("register.self.rosterNone")}</option>
            {entry.players.map((p, i) =>
              p.full_name.trim() ? (
                <option key={i} value={i}>
                  {p.full_name}
                </option>
              ) : null,
            )}
          </select>
        </div>
      )}

      {division.form_fields.length > 0 && (
        <div className="mt-4">
          <FormFields
            fields={division.form_fields}
            answers={entry.answers}
            entryId={entry.id}
            onChange={(key, value) =>
              dispatch({ type: "SET_ANSWERS", id: entry.id, answers: { ...entry.answers, [key]: value } })
            }
          />
        </div>
      )}
    </div>
  );
}
