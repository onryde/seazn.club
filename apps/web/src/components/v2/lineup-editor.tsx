"use client";

// Per-fixture lineup editor: pick starters/bench from the entrant's roster,
// assign positions/order from the module catalog. PUT replaces the lineup
// (doc 08 §3); the engine validates size/roles at the scoring door.
import { useState } from "react";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import type {
  SideInfo,
  LineupSlotIn,
  PersonAvailability,
} from "@/components/v2/fixture-console";
import { useMsg } from "@/components/i18n/dict-provider";
// RS011 review round 3, finding 1: `putLineup` (server/usecases/fixtures.ts)
// runs `gateRosterEligibility` and can 422 ELIGIBILITY_VIOLATION, but this
// editor had no recovery path for it — the SAME override dialog
// `entrants-panel.tsx`'s `runGated` wraps 4 roster-write call sites with.
import type { EligibilityIssue } from "@/lib/registration-rules";
import { EligibilityOverrideDialog } from "@/components/v2/eligibility-override-dialog";

/** One row of the resolved `PositionCatalog.groups` (engine `PositionGroup`),
 *  narrowed to the fields this editor reads. Structural, not an engine import:
 *  this is a client component and the engine's zod-inferred type would drag
 *  the whole module graph into the browser bundle. */
export interface PositionGroupIn {
  key: string;
  name: string;
  min?: number;
  max?: number;
}

interface Props {
  fixtureId: string;
  side: SideInfo;
  /** The catalog groups that govern THIS fixture — the module's per-config
   *  catalog (`resolvePositions`, R7 B2), never its static `positions`.
   *  `min`/`max` ride along because they are the half the per-config hook
   *  actually moves: hockey and ice hockey drop the keeper group's `min` to
   *  0 when the competition declares `goalkeeper: "optional"` (FIH Rule 4).
   *  Dropping them here would leave that resolution inert on screen. */
  positionGroups: PositionGroupIn[];
  roles: { key: string; name?: string }[];
  lineupSize: number;
  canEdit: boolean;
  onSaved: () => void;
  /** Player RSVP/check-in per person (PROMPT-53). No entry → "—" chip. */
  availability?: Record<string, PersonAvailability>;
}

// RSVP chip vocabulary: ✓ in / ✗ out / ? maybe / — no answer (or unclaimed).
// Marks + colours are structural; the labels come from the `ui` catalog.
const AVAIL_CHIP: Record<PersonAvailability["status"], { mark: string; cls: string }> = {
  in: { mark: "✓", cls: "bg-emerald-100 text-emerald-700" },
  out: { mark: "✗", cls: "bg-red-100 text-red-600" },
  maybe: { mark: "?", cls: "bg-amber-100 text-amber-700" },
};
const AVAIL_LABEL_KEY: Record<PersonAvailability["status"], "lineup.avail.in" | "lineup.avail.out" | "lineup.avail.maybe"> = {
  in: "lineup.avail.in",
  out: "lineup.avail.out",
  maybe: "lineup.avail.maybe",
};

function AvailabilityChip({
  personName,
  info,
}: {
  personName: string;
  info: PersonAvailability | undefined;
}) {
  const msg = useMsg();
  if (!info) {
    return (
      <span
        aria-label={msg("lineup.noAnswer", { name: personName })}
        className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-slate-100 text-[11px] text-slate-400"
        data-testid="availability-chip"
      >
        —
      </span>
    );
  }
  const chip = AVAIL_CHIP[info.status];
  const label = msg(AVAIL_LABEL_KEY[info.status]);
  return (
    <span className="inline-flex items-center gap-1" data-testid="availability-chip">
      <span
        aria-label={msg("lineup.statusAria", { name: personName, label }) + (info.note ? ` — ${info.note}` : "")}
        title={info.note ?? undefined}
        className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold ${chip.cls}`}
      >
        {chip.mark}
      </span>
      {info.checked_in_at && (
        <span
          aria-label={msg("lineup.checkedInAria", { name: personName })}
          title={msg("lineup.checkedInTitle")}
          className="inline-block h-2 w-2 rounded-full bg-lime-500"
          data-testid="checkedin-dot"
        />
      )}
    </span>
  );
}

export interface SlotDraft {
  person_id: string;
  full_name: string;
  slot: "starting" | "bench";
  position_key: string | null;
  order_no: number;
  roles: string[];
  /** player/coach/staff (S3/#426 ruling) — S12/#421 pass D. Defaults to
   *  "player", mirroring the engine's own LineupSlot.role default. */
  role: "player" | "coach" | "staff";
  /** Doubles/pair serve order (S3/#426's engine LineupSlot.pairOrder) —
   *  S12/#421 pass D, V361. null = no declared order. Only ever SET through
   *  the pair-order control below, which only renders for a pair-shaped
   *  side (see isPairShaped) — a non-pair side simply never gets a way to
   *  set this away from null. */
  pair_order: number | null;
}

/**
 * `side.lineup` (the wire shape `readLineup` returns) -> the editor's own
 * draft shape. Extracted so the mapping is unit-testable without rendering
 * anything (this repo tests client components via static markup, not
 * jsdom — see this file's own test for why).
 */
export function draftFromSavedLineup(lineup: LineupSlotIn[]): SlotDraft[] {
  return lineup.map((s, i) => ({
    person_id: s.person_id,
    full_name: s.full_name,
    slot: s.slot,
    position_key: s.position_key,
    order_no: s.order_no ?? i + 1,
    roles: s.roles ?? [],
    role: s.role ?? "player",
    pair_order: s.pair_order ?? null,
  }));
}

/**
 * Is this side's entrant pair-shaped (tennis/badminton/tabletennis/carrom
 * doubles, volleyball beach pairs, or any other sport whose entrant model
 * allows a "pair")? `pair_order` (which of the two partners serves/plays
 * first) only means something then.
 *
 * S12/#421 pass E review, Finding 1: this used to be inferred structurally
 * (empty position catalog + memberCount === 2), which was wrong for 2/11
 * sports — a generic TEAM entrant with exactly 2 members false-positived
 * (generic declares no entrantModel and no position catalog), and a real
 * volleyball pair false-negatived (its catalog is a genuine non-empty
 * 5-group list). The fix reads the entrant's OWN declared `kind` instead —
 * `SideInfo.kind`, sourced from `entrants.kind` (set once at registration
 * and validated against the division's effective entrant model;
 * server/usecases/entrants.ts) — because that is the one fact that is
 * actually about THIS entrant rather than about its sport's catalog shape or
 * its current roster size. It needs no sport-specific list: any sport that
 * ever declares a "pair" kind is handled without another edit here.
 */
export function isPairShaped(kind: string | null | undefined): boolean {
  return kind === "pair";
}

/**
 * The draft -> PUT body mapping `save()` sends. Extracted for the same
 * reason as `draftFromSavedLineup`: this is the exact spot the product's
 * lineup UI used to silently drop `role` (and had nowhere to carry
 * `pair_order` at all) — a coach saved through the editor was written back
 * as a plain player regardless of what the row showed.
 *
 * `pairShaped` is required, not defaulted, deliberately (S12/#421 pass E
 * review, Finding 2): a caller must say explicitly whether THIS side is
 * pair-shaped right now, and a non-pair-shaped side always sends
 * `pair_order: null` regardless of what the draft still holds. Before this,
 * both `draftFromSavedLineup` and this function carried a slot's saved
 * `pair_order` unconditionally, so an entrant that hit Finding 1's false
 * positive and saved one, then was re-read under the corrected
 * `isPairShaped`, kept re-sending that stale value on every future PUT —
 * the editor replaces the whole lineup on save, so gating here is the only
 * place a stale value can ever be cleared; there is no separate "clear" UI.
 */
export function toPutSlot(
  s: SlotDraft,
  index: number,
  pairShaped: boolean,
): {
  person_id: string;
  slot: "starting" | "bench";
  position_key: string | null;
  order_no: number;
  roles: string[];
  role: "player" | "coach" | "staff";
  pair_order: number | null;
} {
  return {
    person_id: s.person_id,
    slot: s.slot,
    position_key: s.position_key,
    order_no: index + 1,
    roles: s.roles,
    role: s.role,
    pair_order: pairShaped ? s.pair_order : null,
  };
}

/**
 * Does this sport have a lineup to edit at all?
 *
 * R7 Task B (D-1, D-18). The console used to gate the editor on
 * `{home && away}` alone, so chess, carrom singles and generic each rendered
 * a one-slot team sheet — position dropdown, Captain checkbox, bench
 * controls — for a competitor who has no team. The answer is the module's
 * own declaration and never a sport-key list: a catalog that nominates one
 * unit and admits no bench (`lineup: { size: 1, benchMax: 0 }` —
 * `boardgame.ts`, `carrom.ts`, `generic.ts`) is saying there is nothing to
 * pick.
 *
 * BOTH halves are load-bearing. The racquet family declares
 * `size: 1, benchMax: 1` — one nominated unit, player or pair — so a
 * predicate reduced to `size <= 1` would take the doubles pair-order editor
 * away from tennis, badminton and table tennis with it.
 *
 * Read the RESOLVED catalog (`lineupCatalogFor`, R7 B2), not the module's
 * static `positions`: a competition can shrink its own squad.
 */
export function lineupEditorApplies(catalog: { lineupSize: number; benchMax: number }): boolean {
  return !(catalog.lineupSize <= 1 && catalog.benchMax === 0);
}

/**
 * Which position groups the STARTING slots do not yet satisfy, and by how
 * many. `PositionGroup.min` is the same number `validateLineup` enforces at
 * the scoring door (`kind: "group_min"`), so this is that refusal said in
 * advance instead of as a 422 after Save.
 *
 * R7 B2 — the reason this reads a RESOLVED catalog and not the module's
 * static one: `min` is precisely what a competition can move. Hockey and ice
 * hockey declare their keeper group `min: 1`, and `positionsFor(cfg)` drops
 * it to 0 when the competition declares `goalkeeper: "optional"` (FIH Rule
 * 4 — a side may play out with no keeper at all). Feed this the static
 * catalog and such a competition is told to name a goalkeeper it has
 * explicitly decided not to field.
 *
 * Bench slots are excluded on purpose: group minima are a starting-lineup
 * rule (`validateLineup` counts only `slot === "starting"`, and a benched
 * keeper is no keeper). Slots with no position chosen count towards no group.
 */
export function unmetPositionMinimums(
  groups: PositionGroupIn[],
  slots: Pick<SlotDraft, "slot" | "position_key">[],
): { key: string; name: string; short: number }[] {
  const startingByKey = new Map<string, number>();
  for (const s of slots) {
    if (s.slot !== "starting" || s.position_key === null) continue;
    startingByKey.set(s.position_key, (startingByKey.get(s.position_key) ?? 0) + 1);
  }
  return groups
    .map((g) => ({
      key: g.key,
      name: g.name,
      short: (g.min ?? 0) - (startingByKey.get(g.key) ?? 0),
    }))
    .filter((g) => g.short > 0);
}

export function LineupEditor({
  fixtureId,
  side,
  positionGroups,
  roles,
  lineupSize,
  canEdit,
  onSaved,
  availability = {},
}: Props) {
  const msg = useMsg();
  // Pair-shaped once, from the entrant's own declared kind (see
  // isPairShaped's own doc comment) — not per-slot, since it describes the
  // ENTRANT, not a row. Computed before the draft's lazy initializer below
  // so the roster auto-populate seeding can use it too.
  const pairShaped = isPairShaped(side.kind);
  // `lineupSize` counts UNITS — one nominated player OR PAIR per side
  // (packages/engine/src/sports/tennis/tennis.ts's positions.lineup.size,
  // "one nominated unit (player or pair) per side"; that value is correct
  // and this expression does not change it). A pair-shaped entrant fills
  // each unit with 2 PEOPLE, so anything that counts or labels PEOPLE
  // (the roster auto-populate seeding below, the starting-count badge, and
  // its emerald/slate colour switch) must compare against the PEOPLE-shaped
  // target, not the raw unit count — otherwise a doubles pair reads "2/1
  // starting" and the badge never turns emerald (defect register D-3).
  const expectedStarting = pairShaped ? lineupSize * 2 : lineupSize;
  const [slots, setSlots] = useState<SlotDraft[]>(() => {
    if (side.lineup.length > 0) {
      return draftFromSavedLineup(side.lineup);
    }
    // Nothing saved yet → auto-populate a DRAFT from the roster (first
    // `expectedStarting` start, rest bench) so matchday is one Save, not N
    // taps. Draft only: nothing persists (and the engine reads nothing)
    // until Save. Read-only viewers keep the honest empty state instead.
    if (!canEdit) return [];
    return side.members.map((m, i) => ({
      person_id: m.person_id,
      full_name: m.full_name,
      slot: i < expectedStarting ? ("starting" as const) : ("bench" as const),
      position_key: m.default_position_key,
      order_no: i + 1,
      roles: m.roles ?? [],
      role: "player" as const,
      pair_order: null,
    }));
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // RS011 review round 3, finding 1: pending override-dialog state, set only
  // while a save is blocked on ELIGIBILITY_VIOLATION and waiting on the
  // organiser — same shape as `entrants-panel.tsx`'s `eligibilityGate`.
  const [eligibilityGate, setEligibilityGate] = useState<{
    violations: EligibilityIssue[];
  } | null>(null);

  const inLineup = new Set(slots.map((s) => s.person_id));
  const startingCount = slots.filter((s) => s.slot === "starting").length;
  const unmet = unmetPositionMinimums(positionGroups, slots);

  function add(member: SideInfo["members"][number], slot: "starting" | "bench") {
    setSlots((prev) => [
      ...prev,
      {
        person_id: member.person_id,
        full_name: member.full_name,
        slot,
        position_key: member.default_position_key,
        order_no: prev.length + 1,
        roles: member.roles ?? [],
        role: "player",
        pair_order: null,
      },
    ]);
    setSaved(false);
  }

  /** RS011 review round 3, finding 1: `override` is only ever passed on a
   *  confirmed retry from `EligibilityOverrideDialog` below — a plain Save
   *  tap calls this with none. Re-sending the SAME `slots` snapshot on retry
   *  is safe (unlike `entrants-panel.tsx`'s CSV bulk-add, `save()` has no
   *  one-time side effect ahead of the PUT — it is a pure resubmit of the
   *  current draft, and the PUT itself replaces the whole lineup either way,
   *  so a retry is naturally idempotent). */
  async function save(override?: { reason: string }) {
    setBusy(true);
    setError(null);
    try {
      await apiV1(`/api/v1/fixtures/${fixtureId}/lineups/${side.id}`, {
        method: "PUT",
        json: {
          slots: slots.map((s, i) => toPutSlot(s, i, pairShaped)),
          ...(override ? { eligibility_override: override } : {}),
        },
      });
      setEligibilityGate(null);
      setSaved(true);
      onSaved();
    } catch (err) {
      if (err instanceof ApiV1Error && err.code === "ELIGIBILITY_VIOLATION") {
        const violations = (err.extra.violations as EligibilityIssue[] | undefined) ?? [];
        setEligibilityGate({ violations });
      } else {
        setError(err instanceof Error ? err.message : msg("lineup.failed"));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card p-4" data-testid="lineup-editor">
      <header className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-700">{msg("lineup.title", { name: side.name })}</h3>
        <span
          className={`text-xs ${startingCount === expectedStarting ? "text-emerald-600" : "text-slate-400"}`}
        >
          {msg("lineup.starting", { n: startingCount, total: expectedStarting })}
        </span>
      </header>

      {slots.length === 0 && (
        <p className="mb-2 text-xs text-slate-400">
          {canEdit ? msg("lineup.emptyEdit") : msg("lineup.empty")}
        </p>
      )}

      {/* The engine's group minima, said before Save rather than as a 422
          after it. Absent entirely when the resolved catalog demands
          nothing — which is what a competition declaring
          `goalkeeper: "optional"` produces (R7 B2). */}
      {unmet.length > 0 && (
        <p className="mb-2 text-xs text-amber-600" data-testid="lineup-position-minimums">
          {msg("lineup.needsPositions", {
            list: unmet.map((g) => `${g.name} × ${g.short}`).join(", "),
          })}
        </p>
      )}

      <ul className="space-y-1.5">
        {slots.map((s, i) => (
          <li key={s.person_id} className="flex flex-wrap items-center gap-2 text-xs">
            <span className="w-7 font-mono text-slate-400">{i + 1}.</span>
            <span className="w-36 truncate font-medium text-slate-700">{s.full_name}</span>
            <AvailabilityChip personName={s.full_name} info={availability[s.person_id]} />
            <select
              disabled={!canEdit}
              value={s.slot}
              onChange={(e) => {
                const v = e.target.value as "starting" | "bench";
                setSlots((prev) => prev.map((x, j) => (j === i ? { ...x, slot: v } : x)));
                setSaved(false);
              }}
              className="select min-h-11 w-24 px-2 py-1 text-xs"
              aria-label={msg("lineup.slotAria", { name: s.full_name })}
            >
              <option value="starting">{msg("lineup.slotStarting")}</option>
              <option value="bench">{msg("lineup.slotBench")}</option>
            </select>
            {positionGroups.length > 0 && (
              <select
                disabled={!canEdit}
                value={s.position_key ?? ""}
                onChange={(e) => {
                  const v = e.target.value || null;
                  setSlots((prev) =>
                    prev.map((x, j) => (j === i ? { ...x, position_key: v } : x)),
                  );
                  setSaved(false);
                }}
                className="select min-h-11 w-32 px-2 py-1 text-xs"
                aria-label={msg("lineup.positionAria", { name: s.full_name })}
              >
                <option value="">{msg("lineup.positionPlaceholder")}</option>
                {positionGroups.map((g) => (
                  <option key={g.key} value={g.key}>
                    {g.name}
                  </option>
                ))}
              </select>
            )}
            <select
              disabled={!canEdit}
              value={s.role}
              onChange={(e) => {
                const v = e.target.value as "player" | "coach" | "staff";
                setSlots((prev) => prev.map((x, j) => (j === i ? { ...x, role: v } : x)));
                setSaved(false);
              }}
              className="select min-h-11 w-24 px-2 py-1 text-xs"
              aria-label={msg("lineup.roleAria", { name: s.full_name })}
              data-testid="lineup-role-select"
            >
              <option value="player">{msg("lineup.role.player")}</option>
              <option value="coach">{msg("lineup.role.coach")}</option>
              <option value="staff">{msg("lineup.role.staff")}</option>
            </select>
            {pairShaped && (
              <select
                disabled={!canEdit}
                value={s.pair_order ?? ""}
                onChange={(e) => {
                  const v = e.target.value ? Number(e.target.value) : null;
                  setSlots((prev) =>
                    prev.map((x, j) => (j === i ? { ...x, pair_order: v } : x)),
                  );
                  setSaved(false);
                }}
                className="select min-h-11 w-32 px-2 py-1 text-xs"
                aria-label={msg("lineup.pairOrderAria", { name: s.full_name })}
                data-testid="lineup-pairorder-select"
              >
                <option value="">{msg("lineup.pairOrderPlaceholder")}</option>
                <option value="1">{msg("lineup.pairOrder.first")}</option>
                <option value="2">{msg("lineup.pairOrder.second")}</option>
              </select>
            )}
            {roles.map((r) => (
              <label key={r.key} className="flex items-center gap-1 text-slate-500">
                <input
                  type="checkbox"
                  disabled={!canEdit}
                  checked={s.roles.includes(r.key)}
                  onChange={(e) => {
                    setSlots((prev) =>
                      prev.map((x, j) =>
                        j === i
                          ? {
                              ...x,
                              roles: e.target.checked
                                ? [...x.roles, r.key]
                                : x.roles.filter((k) => k !== r.key),
                            }
                          : x,
                      ),
                    );
                    setSaved(false);
                  }}
                />
                {r.name ?? r.key}
              </label>
            ))}
            {canEdit && (
              <span className="flex gap-1">
                <button
                  type="button"
                  disabled={i === 0}
                  onClick={() => {
                    setSlots((prev) => {
                      const next = [...prev];
                      [next[i - 1], next[i]] = [next[i], next[i - 1]];
                      return next;
                    });
                    setSaved(false);
                  }}
                  className="text-slate-400 hover:text-slate-700"
                  aria-label={msg("lineup.moveUp", { name: s.full_name })}
                >
                  ↑
                </button>
                <button
                  type="button"
                  disabled={i === slots.length - 1}
                  onClick={() => {
                    setSlots((prev) => {
                      const next = [...prev];
                      [next[i], next[i + 1]] = [next[i + 1], next[i]];
                      return next;
                    });
                    setSaved(false);
                  }}
                  className="text-slate-400 hover:text-slate-700"
                  aria-label={msg("lineup.moveDown", { name: s.full_name })}
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSlots((prev) => prev.filter((_, j) => j !== i));
                    setSaved(false);
                  }}
                  className="text-red-500 hover:underline"
                >
                  ×
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>

      {canEdit && (
        <div className="mt-3 space-y-2 border-t border-slate-100 pt-2">
          <div className="flex flex-wrap gap-1.5">
            {side.members
              .filter((m) => !inLineup.has(m.person_id))
              .map((m) => (
                <span key={m.person_id} className="inline-flex items-center gap-1 rounded-full border border-slate-200 px-2 py-0.5 text-xs text-slate-500">
                  <AvailabilityChip personName={m.full_name} info={availability[m.person_id]} />
                  {m.full_name}
                  <button
                    type="button"
                    onClick={() => add(m, "starting")}
                    className="text-purple-600 hover:underline"
                  >
                    {msg("lineup.addStart")}
                  </button>
                  <button
                    type="button"
                    onClick={() => add(m, "bench")}
                    className="text-slate-400 hover:underline"
                  >
                    {msg("lineup.addBench")}
                  </button>
                </span>
              ))}
            {side.members.length === 0 && (
              <span className="text-xs text-slate-400">{msg("lineup.noRoster")}</span>
            )}
          </div>
          {error && <p className="text-xs text-red-600">{error}</p>}
          {saved && <p className="text-xs text-emerald-600">{msg("lineup.saved")}</p>}
          <button
            type="button"
            disabled={busy}
            onClick={() => void save()}
            className="btn btn-primary px-3 py-1.5 text-xs"
          >
            {busy ? msg("lineup.saving") : msg("lineup.save")}
          </button>
        </div>
      )}

      <EligibilityOverrideDialog
        open={eligibilityGate !== null}
        violations={eligibilityGate?.violations ?? []}
        busy={busy}
        onCancel={() => setEligibilityGate(null)}
        onConfirm={(reason) => void save({ reason })}
        testId="lineup-eligibility-override"
      />
    </section>
  );
}
