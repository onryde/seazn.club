"use client";
// RS006 Step 3 — the roster table (design §4 step 3: "roster builder
// (typed AND pasted)"). Individual/pair kinds are FIXED size (1/2 rows,
// seeded by cart.ts's blankPlayers at ADD_ENTRY time) — no add/remove
// control for them, matching the schema's own exact-count requirement.
// Team is open-ended (0..MAX_ROSTER_PLAYERS): add/remove one row at a
// time, or paste a list (parseRoster, ported from git history) that
// APPENDS rather than replaces — same behaviour the recovered TeamRoster
// had. Per-row dob/gender inputs render only when `requiresDob`/
// `requiresGender` say the division needs them (same conditional
// discipline as step-who.tsx).
//
// The paste textarea's draft text is a CONTROLLED prop, not a local
// `useState`, deliberately — every other component in this tree below
// RegisterStepper is hookless (only the mocked, non-hook `useT()`), which
// is what lets register-stepper-interaction.test.tsx's `deepExpand` walk
// this component's rendered output by calling it directly outside React's
// own render cycle; a real hook call there throws "Invalid hook call"
// (`_hook-harness.tsx`'s own header). The draft lives on RegisterStepper
// (`importTextByEntry`) instead — deliberately NOT part of the persisted
// CartState (storage.ts): losing an in-progress paste on refresh is
// acceptable, the same way the honeypot `website` field is top-level state
// that's never included in `saveRegisterState`'s snapshot.
import { useT } from "@/components/i18n/dict-provider";
import type { EligibilityIssue } from "@/lib/registration-rules";
import { MAX_ROSTER_PLAYERS } from "./cart";
import { rosterIssueMessageKey } from "./eligibility-presentation";
import { parseRoster } from "./roster";
import { BTN_GHOST, BTN_TEXT, FIELD } from "./styles";
import type { CartEntry, Gender, RosterPlayerState } from "./types";

/** The SECOND row of a PAIR entry is the "partner field for pairs" the
 *  design calls out (§4 step 3) — labeled distinctly, not a second
 *  "Player 2" indistinguishable from a team roster row. */
function rowLabel(kind: CartEntry["entrant_kind"], index: number, t: (key: string, vars?: Record<string, string | number>) => string): string {
  if (kind === "pair" && index === 1) return t("register.details.player.partnerLabel", { n: index + 1 });
  return t("register.details.player.label", { n: index + 1 });
}

export function RosterTable({
  entry,
  requiresDob,
  requiresGender,
  issuesByRow,
  importText,
  onImportTextChange,
  onAddPlayer,
  onRemovePlayer,
  onUpdatePlayer,
  onImportPlayers,
}: {
  entry: CartEntry;
  requiresDob: boolean;
  requiresGender: boolean;
  /** Keyed by 1-based playerIndex, matching EligibilityIssue's convention. */
  issuesByRow: Map<number, EligibilityIssue[]>;
  /** The paste textarea's draft — controlled from above, see this file's
   *  header for why. */
  importText: string;
  onImportTextChange: (text: string) => void;
  onAddPlayer: () => void;
  onRemovePlayer: (index: number) => void;
  onUpdatePlayer: (index: number, patch: Partial<RosterPlayerState>) => void;
  onImportPlayers: (players: RosterPlayerState[]) => void;
}) {
  const t = useT();
  const isTeam = entry.entrant_kind === "team";
  const parsedCount = parseRoster(importText).length;

  return (
    <div className="space-y-3">
      {entry.players.length === 0 && isTeam && (
        <p className="text-xs text-ink-muted">{t("register.details.roster.team.hint")}</p>
      )}

      {entry.players.length > 0 && (
        <ul className="space-y-3">
          {entry.players.map((p, i) => {
            const label = rowLabel(entry.entrant_kind, i, t);
            const issues = issuesByRow.get(i + 1) ?? [];
            return (
              <li key={i} className="min-w-0 rounded-lg border border-zinc-200 bg-canvas p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-display text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
                    {label}
                  </span>
                  {isTeam && (
                    <button type="button" className={BTN_TEXT} onClick={() => onRemovePlayer(i)}>
                      {t("register.entries.cart.remove")}
                    </button>
                  )}
                </div>

                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <input
                    type="text"
                    maxLength={120}
                    className={`${FIELD} min-w-0`}
                    placeholder={t("register.who.name.placeholder")}
                    /* Bench hook. Every field in this row was addressable only
                     * by an aria-label built from TRANSLATED strings, which is
                     * the text selector AGENTS.md forbids — and the row repeats
                     * per player, so a driver needs the index too. */
                    data-testid="reg-roster-name"
                    data-player-row={i}
                    aria-label={`${label} — ${t("register.who.name.label")}`}
                    value={p.full_name}
                    onChange={(e) => onUpdatePlayer(i, { full_name: e.target.value })}
                  />
                  {isTeam && (
                    <input
                      type="text"
                      inputMode="numeric"
                      maxLength={3}
                      className={`${FIELD} min-w-0`}
                      placeholder={t("register.details.player.squadNumber.placeholder")}
                      data-testid="reg-roster-squad"
                      data-player-row={i}
                      aria-label={`${label} — ${t("register.details.player.squadNumber.placeholder")}`}
                      value={p.squad_number}
                      onChange={(e) => onUpdatePlayer(i, { squad_number: e.target.value.replace(/\D/g, "").slice(0, 3) })}
                    />
                  )}
                  {requiresDob && (
                    <input
                      type="date"
                      className={`${FIELD} min-w-0`}
                      data-testid="reg-roster-dob"
                      data-player-row={i}
                      aria-label={`${label} — ${t("register.who.dob.label")}`}
                      value={p.dob ?? ""}
                      onChange={(e) => onUpdatePlayer(i, { dob: e.target.value || null })}
                    />
                  )}
                  {requiresGender && (
                    <select
                      className={`${FIELD} min-w-0`}
                      data-testid="reg-roster-gender"
                      data-player-row={i}
                      aria-label={`${label} — ${t("register.who.gender.label")}`}
                      value={p.gender ?? ""}
                      onChange={(e) => onUpdatePlayer(i, { gender: (e.target.value || null) as Gender | null })}
                    >
                      <option value="" disabled>
                        {t("register.who.gender.label")}
                      </option>
                      <option value="m">{t("register.who.gender.m")}</option>
                      <option value="f">{t("register.who.gender.f")}</option>
                      <option value="x">{t("register.who.gender.x")}</option>
                    </select>
                  )}
                </div>

                {issues.length > 0 && (
                  <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                    {issues
                      .map((issue) => rosterIssueMessageKey(issue.code))
                      .filter((key): key is string => Boolean(key))
                      .map((key) => (
                        <p key={key}>{t(key)}</p>
                      ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {isTeam && (
        <>
          <div>
            <button
              type="button"
              onClick={onAddPlayer}
              disabled={entry.players.length >= MAX_ROSTER_PLAYERS}
              className={BTN_GHOST}
            >
              {t("register.details.roster.addPlayer")}
            </button>
          </div>

          <details className="text-sm">
            <summary className="cursor-pointer font-display text-xs font-semibold uppercase tracking-wide text-accent-strong">
              {t("register.details.roster.import.summary")}
            </summary>
            <p className="mt-2 text-xs text-ink-muted">{t("register.details.roster.import.hint")}</p>
            <textarea
              value={importText}
              onChange={(e) => onImportTextChange(e.target.value)}
              rows={4}
              className={`${FIELD} mt-2 min-w-0`}
            />
            <button
              type="button"
              className={`${BTN_GHOST} mt-2`}
              disabled={parsedCount === 0}
              onClick={() => {
                const parsed = parseRoster(importText);
                if (parsed.length === 0) return;
                onImportPlayers(parsed);
                onImportTextChange("");
              }}
            >
              {t("register.details.roster.import.button", { n: parsedCount })}
            </button>
          </details>
        </>
      )}
    </div>
  );
}
