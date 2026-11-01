"use client";

// Entrant kinds - what an entrant in this division looks like: a single player, a pair, a whole team; which is the default; the team
// extras (squad numbers, a captain). Match Day C4 (owner, 2026-10-31): this block LEFT the division Settings tab and sits at the
// top of the Entrants tab, for the organiser only (the page mounts it behind `canEdit`), because it decides what the add-entrant
// form right below it offers. Behaviour is the Settings block's, unchanged:
//   - the effective model (the sport's default <- the division's saved `config.entrants`) seeds the controls; a saved override
//     is named, and Reset drops the key so the server re-derives it from the sport;
//   - Save is a wholesale-config PATCH (the server merges the variant preset with the sent config and re-validates), and the
//     server owns the lock: narrowing the kinds while entrants of a removed kind are still active is refused there ("withdraw
//     them first") and shown here as the server words it - the form keeps no copy of that rule;
//   - chess is individual-only (owner ruling, 2026-10-26): no kind is offered, a pre-ruling widened override is named and can be
//     Reset, never edited or re-saved here.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { settingsSaveErrorText } from "@/lib/config-issue-copy";
import { CHESS_INDIVIDUAL_ONLY, entrantsOverrideWidensBeyondIndividual, isChessSport } from "@/lib/chess-individual-only";
import { useMsg } from "@/components/i18n/dict-provider";
import { SettingsGroup } from "@/components/v2/settings-group";
import type { MessageKey } from "@/lib/messages";
import type { EffectiveEntrantModel } from "@seazn/engine/sport";

// The three entrant shapes, in a stable display order. The effective model (module default <- division override) decides which are
// ticked.
const ENTRANT_KINDS = ["individual", "pair", "team"] as const;
type EntrantKind = (typeof ENTRANT_KINDS)[number];
const KIND_LABEL_KEY: Record<EntrantKind, MessageKey> = {
  individual: "divset.entrants.kind.individual",
  pair: "divset.entrants.kind.pair",
  team: "divset.entrants.kind.team",
};
const kindLabelKey = (kind: string): MessageKey => KIND_LABEL_KEY[kind as EntrantKind];

export function EntrantKindsSettings({
  divisionId,
  sportKey,
  config,
  entrantModel,
  canEdit,
  defaultOpen = false,
}: {
  divisionId: string;
  sportKey: string;
  /** The division's STORED config: the save re-sends it with `entrants` replaced, Reset re-sends it without the key, and the
   *  caption / legacy-chess line read the stored `entrants` key off it. */
  config: unknown;
  /** The resolved effective model (sport default <- saved override), already clamped to individual-only for chess by the page. */
  entrantModel: EffectiveEntrantModel;
  /** False for a billing-frozen club: the block shows, read-only. A viewer never gets the block at all (the page). */
  canEdit: boolean;
  /** Test seam and nothing else: the page never passes it, so the block opens folded under one row naming the kinds. */
  defaultOpen?: boolean;
}) {
  const msg = useMsg();
  const router = useRouter();
  const stored = (config as { entrants?: unknown } | null)?.entrants;
  const source: "sport" | "override" = stored && typeof stored === "object" ? "override" : "sport";
  // Chess is individual-only: the block offers no kind to choose. A division saved before the ruling can still hold a widened
  // override; it is named and can be Reset, never edited or re-saved here.
  const chessOnly = isChessSport(sportKey);
  const chessLegacy = chessOnly && entrantsOverrideWidensBeyondIndividual(stored);

  const [kinds, setKinds] = useState<string[]>(entrantModel.kinds);
  const [defaultKind, setDefaultKind] = useState<string>(entrantModel.defaultKind);
  const [squadNumbers, setSquadNumbers] = useState<boolean>(entrantModel.squadNumbers);
  const [captain, setCaptain] = useState<boolean>(entrantModel.captain);
  // A saved change (a Reset above all, which drops the override and so changes what the chips must show) arrives as a new model
  // after router.refresh(): the controls follow it. Keyed on the MODEL, so an unrelated refresh (an entrant added below) leaves
  // an unsaved tick alone.
  const signature = `${entrantModel.kinds.join(",")}|${entrantModel.defaultKind}|${entrantModel.squadNumbers}|${entrantModel.captain}`;
  const [syncedSignature, setSyncedSignature] = useState(signature);
  if (signature !== syncedSignature) {
    setSyncedSignature(signature);
    setKinds(entrantModel.kinds);
    setDefaultKind(entrantModel.defaultKind);
    setSquadNumbers(entrantModel.squadNumbers);
    setCaptain(entrantModel.captain);
  }
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<void>, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(done);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiV1Error && err.code === CHESS_INDIVIDUAL_ONLY) {
        // Server English otherwise (no server-side i18n): localise the code. Reached by a save that names a non-individual kind
        // (a stale page, or a legacy override re-sent beside a different one).
        setError(msg("divset.err.chessIndividualOnly"));
      } else {
        // A refused save names its problem in the reader's language where this app owns it, else as the server worded it - the
        // "withdraw them first" lock among them.
        setError(settingsSaveErrorText(err, msg, msg("divset.failed")));
      }
    } finally {
      setBusy(false);
    }
  }

  // Tick/untick a kind, keeping canonical order and never emptying the list; if the current default falls out, re-point it at the
  // first remaining kind.
  const toggleKind = (kind: string) => {
    const next: string[] = ENTRANT_KINDS.filter((k) => (k === kind ? !kinds.includes(k) : kinds.includes(k)));
    if (next.length === 0) return;
    setKinds(next);
    if (!next.includes(defaultKind)) setDefaultKind(next[0]!);
  };

  const saveEntrants = () =>
    run(async () => {
      // Same wholesale-config contract as the format save: the server merges the variant preset with the sent config and
      // re-validates, so base the override on the current snapshot and set `entrants` on it.
      const entrants: Record<string, unknown> = { kinds, defaultKind };
      if (kinds.includes("team")) {
        entrants.squadNumbers = squadNumbers;
        entrants.captain = captain;
      }
      const override = { ...((config as Record<string, unknown> | null) ?? {}), entrants };
      await apiV1(`/api/v1/divisions/${divisionId}`, { method: "PATCH", json: { config: override } });
    }, msg("divset.entrants.saved"));

  const resetEntrants = () =>
    run(async () => {
      // Drop the override key -> the server re-derives from the module default.
      const override = { ...((config as Record<string, unknown> | null) ?? {}) };
      delete override.entrants;
      await apiV1(`/api/v1/divisions/${divisionId}`, { method: "PATCH", json: { config: override } });
    }, msg("divset.entrants.resetDone"));

  return (
    <SettingsGroup
      title={msg("divset.entrants.kinds")}
      summary={(chessOnly ? ["individual"] : entrantModel.kinds).map((k) => msg(kindLabelKey(k))).join(", ")}
      defaultOpen={defaultOpen}
    >
      <div className="max-w-2xl space-y-3" data-testid="entrant-kinds">
        {chessOnly ? (
          <div className="space-y-2" data-testid="entrants-chess-only">
            <p className="text-xs text-slate-600">{msg("divset.entrants.chessOnly")}</p>
            {chessLegacy && (
              <div
                role="status"
                className="grid min-w-0 gap-2 break-words rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
                data-testid="entrants-chess-legacy"
              >
                <span>{msg("divset.entrants.chessLegacy")}</span>
                {canEdit && (
                  <button type="button" disabled={busy} onClick={resetEntrants} className="btn min-h-11 w-full justify-self-start text-xs sm:w-auto">
                    {msg("divset.entrants.reset")}
                  </button>
                )}
              </div>
            )}
          </div>
        ) : (
          <>
            <p className="text-xs text-slate-500">{msg("divset.entrants.desc")}</p>

            {/* Source line: a muted "Sport default" note, or, once overridden, the same note swapped for a quiet Reset affordance
                beside it. */}
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              {source === "sport" ? (
                <span className="text-slate-500" data-testid="entrants-sport-default">
                  {msg("divset.entrants.sportDefault")}
                </span>
              ) : (
                <>
                  <span className="text-slate-500">{msg("divset.entrants.overridden")}</span>
                  {canEdit && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={resetEntrants}
                      className="inline-flex min-h-11 items-center rounded text-slate-500 underline transition hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-300"
                    >
                      {msg("divset.entrants.reset")}
                    </button>
                  )}
                </>
              )}
            </div>

            {/* Kinds - multi-select chips, mirroring RoleChipPicker's toggle style. min-inline-size:0 keeps the fieldset from
                bursting narrow cards. The group title above is the visible name; the legend keeps the fieldset named. */}
            <fieldset className="min-w-0 space-y-1.5 [min-inline-size:0]" disabled={!canEdit}>
              <legend className="sr-only">{msg("divset.entrants.kinds")}</legend>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label={msg("divset.entrants.kinds")}>
                {ENTRANT_KINDS.map((kind) => {
                  const active = kinds.includes(kind);
                  return (
                    <button
                      key={kind}
                      type="button"
                      data-kind={kind}
                      aria-pressed={active}
                      onClick={() => toggleKind(kind)}
                      disabled={!canEdit}
                      className={`min-h-11 rounded-full border px-4 py-1 text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-300 disabled:cursor-not-allowed disabled:opacity-60 ${
                        active
                          ? "border-purple-600 bg-purple-600 text-white"
                          : "border-slate-200 bg-white text-slate-600 hover:border-purple-300"
                      }`}
                    >
                      {msg(KIND_LABEL_KEY[kind])}
                    </button>
                  );
                })}
              </div>
            </fieldset>

            <label className="block text-xs text-slate-500">
              {msg("divset.entrants.defaultKind")}
              <select
                disabled={!canEdit}
                value={defaultKind}
                onChange={(e) => setDefaultKind(e.target.value)}
                className="input mt-1 block min-h-11 w-full sm:w-auto"
              >
                {kinds.map((kind) => (
                  <option key={kind} value={kind}>
                    {msg(kindLabelKey(kind))}
                  </option>
                ))}
              </select>
            </label>

            {/* Team affordances - indented + grouped, shown only while a team kind is ticked (there is nothing to number or
                captain otherwise). */}
            {kinds.includes("team") && (
              <div className="space-y-2 rounded-lg bg-slate-50 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{msg("divset.entrants.teamOptions")}</p>
                <label className="flex min-h-11 items-center gap-2 text-xs text-slate-600">
                  <input type="checkbox" checked={squadNumbers} onChange={(e) => setSquadNumbers(e.target.checked)} disabled={!canEdit} />
                  {msg("divset.entrants.squadNumbers")}
                </label>
                <label className="flex min-h-11 items-center gap-2 text-xs text-slate-600">
                  <input type="checkbox" checked={captain} onChange={(e) => setCaptain(e.target.checked)} disabled={!canEdit} />
                  {msg("divset.entrants.captain")}
                </label>
              </div>
            )}

            {canEdit && (
              <button type="button" disabled={busy} onClick={saveEntrants} className="btn btn-primary min-h-11 w-full text-xs sm:w-auto">
                {msg("divset.entrants.save")}
              </button>
            )}
            <p className="text-[11px] text-slate-500">{msg("divset.entrants.note")}</p>
          </>
        )}

        {notice && (
          <p role="status" className="rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-700" data-testid="entrant-kinds-notice">
            {notice}
          </p>
        )}
        {error && (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-600" data-testid="entrant-kinds-error">
            {error}
          </p>
        )}
      </div>
    </SettingsGroup>
  );
}
