"use client";

// Entrant & roster management (PROMPT-15 task 1): persons picker, CSV import,
// position/role assignment from the module catalog, withdraw/seed.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { entrantKindCap } from "@seazn/engine/sport";
import type { EffectiveEntrantModel, EntrantKind } from "@seazn/engine/sport";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { resolveEntrantBadge } from "@/lib/entrant-badge";
import { ENTRANT_NAME_MAX, rosterDerivedName } from "@/lib/entrant-roster-name";
import { UpgradeGate } from "@/components/upgrade-gate";
import type { ViewerPlan } from "@/lib/viewer-plan";
import { useConfirm } from "@/components/ui/confirm-provider";
import { useMsg, useMsgPlural } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";
import { SuspensionChip } from "@/components/discipline/suspension-chip";
// RS007/V380 — the SAME organiser-facing category/age-band derivations the
// registration hub's row card uses (registration-hub-division-row.tsx),
// reused here rather than re-implemented: both are the SAME audience
// (organiser console) reading the SAME `divisions` columns.
import {
  resolveDivisionCategory,
  deriveAgeBand,
  type DivisionCategoryValue,
} from "@/components/registration-hub-row-derive";
// RS011: `requiresDob`/`requiresGender` are the CLIENT-safe half of the same
// evaluator the server-side gate enforces (`@/lib/registration-rules`,
// re-exported verbatim by `server/usecases/registration-eligibility.ts`) —
// reused here to decide when a member row's missing dob/gender is worth an
// amber chip, never a second rule. `EligibilityIssue` is the dialog's own
// violation shape.
import { requiresDob, requiresGender, type EligibilityIssue } from "@/lib/registration-rules";
import { EligibilityOverrideDialog } from "@/components/v2/eligibility-override-dialog";

/** RS007/V380 — the division columns this panel badges above the roster.
 *  Replaces the retired jsonb `eligibility` array (a `Record<string,
 *  unknown>[]` of `{kind:"age"|"gender"|"custom", ...}` rules) — division
 *  eligibility has been ONE representation (category/age_min/age_max/
 *  eligibility_note) since V380; there is no second shape left to carry. */
export interface EntrantsPanelEligibility {
  category: string | null;
  age_min: number | null;
  age_max: number | null;
  eligibility_note: string | null;
}

// Reuses the registration hub row's own category vocabulary (same
// organiser audience) — "open" is deliberately absent, matching that row's
// own "no restriction set, no badge" precedent (see eligibilityBadges below).
const ENTRANT_CATEGORY_KEY: Record<Exclude<DivisionCategoryValue, "open">, MessageKey> = {
  mens: "reg.hub.row.category.mens",
  womens: "reg.hub.row.category.womens",
  mixed: "reg.hub.row.category.mixed",
};

// Shared entrant-kind labels — reuse the same catalog keys the Settings tab
// uses so "Individual / Pair / Team" read identically across the console.
const ENTRANT_KIND_LABEL: Record<EntrantKind, MessageKey> = {
  individual: "divset.entrants.kind.individual",
  pair: "divset.entrants.kind.pair",
  team: "divset.entrants.kind.team",
};

/** The entrant STATUS enum, as `V212__entrants.sql` declares it. Its own keys,
 *  deliberately NOT `reg.hub.registrants.status.*`: that is a different enum
 *  (pending / paid / waitlisted / expired / rejected) which merely shares two
 *  names, and one key serving two domains breaks whoever changes one of them.
 *  The WORDING is pinned to the registrants table where the two overlap —
 *  `entrants-panel-enum-i18n.test.tsx` holds that to locale by locale. */
const ENTRANT_STATUS_LABEL: Record<"registered" | "confirmed" | "withdrawn" | "disqualified", MessageKey> = {
  registered: "entrants.status.registered",
  confirmed: "entrants.status.confirmed",
  withdrawn: "entrants.status.withdrawn",
  disqualified: "entrants.status.disqualified",
};

/** The catalogue key for a stored enum value, or `undefined` when the column
 *  holds something these maps have never heard of — a status the schema gains
 *  after this file, most likely. The callers then print the STORED VALUE:
 *  `t()` answers a miss with the key PATH, so the do-nothing option would show
 *  a customer "entrants.status.suspended", and an empty cell would hide a real
 *  state altogether. `Partial` because the index signature is otherwise a lie
 *  — nothing constrains what the API hands us. */
function labelKeyFor(map: Record<string, MessageKey>, value: string): MessageKey | undefined {
  return (map as Partial<Record<string, MessageKey>>)[value];
}

interface PositionGroup {
  key: string;
  name: string;
}
interface RoleSpec {
  key: string;
  name?: string;
}
interface EntrantRow {
  id: string;
  kind: string;
  team_id: string | null;
  display_name: string;
  seed: number | null;
  status: string;
  badge_url: string | null;
}
interface TeamOption {
  id: string;
  name: string;
  short_name: string | null;
  club_name: string | null;
  club_short_name: string | null;
  logo_path: string | null;
  latest_entrant_id: string | null;
  squad_count: number;
}
interface Member {
  person_id: string;
  full_name: string;
  // RS011: rides along from withMembers (entrants.ts) so the roster editor
  // can show a MISSING_DOB/MISSING_GENDER chip against the division's own
  // requiresDob/requiresGender — never exposed publicly.
  dob: string | null;
  gender: string | null;
  squad_number: number | null;
  default_position_key: string | null;
  is_captain: boolean;
  roles: string[];
}
interface Person {
  id: string;
  full_name: string;
  dob: string | null;
  gender: string | null;
}
interface DivisionRosterRow {
  person_id: string;
  entrant_id: string;
  entrant_name: string;
}

interface Props {
  divisionId: string;
  entrants: EntrantRow[];
  /** entrant id → resolved badge URL (own badge → team logo → club crest),
   *  from listEntrantLogoUrls. The rows fall back to this when the entrant
   *  has no badge of its own — without it a squad-seeded team entrant showed
   *  a bare monogram even though its club crest existed. */
  logoUrls?: Record<string, string | null>;
  canEdit: boolean;
  positionGroups: PositionGroup[];
  roles: RoleSpec[];
  /** Is the entrant list closed? Mirrors `createEntrants`'s own guard via
   *  `lib/open-entry-stages.ts`. When true the Add-entrant form is not
   *  rendered at all: it was a dead control on every started tournament, and
   *  the Start dialog has already promised the organiser it would be gone. */
  rosterLocked?: boolean;
  eligibility: EntrantsPanelEligibility;
  /** Effective entrant model (sport default merged with any config.entrants
   *  override) — decides which kinds the add form offers and whether the
   *  roster editor shows squad numbers / captain. */
  entrantModel: EffectiveEntrantModel;
  /** Active suspensions per entrant id (SPEC-1) — red chip on the entrant row.
   *  Empty/absent for non-entitled orgs or non-card sports. */
  suspensions?: Record<string, { personName: string; remaining: number }[]>;
  viewerPlan: ViewerPlan;
  /** The division's own status column (`divisions.status`) — gates the
   *  hard-delete action, which the server only allows pre-`setup` exit
   *  (entrants.ts's `deleteEntrant`). Withdraw remains available always. */
  divisionStatus: string;
}

// Load the whole org persons directory once (cursor-paged) — org rosters are
// small; the picker filters locally.
async function loadAllPersons(): Promise<Person[]> {
  const all: Person[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 20; i++) {
    const url: string = cursor
      ? `/api/v1/persons?limit=100&cursor=${encodeURIComponent(cursor)}`
      : "/api/v1/persons?limit=100";
    const page: { items: Person[]; nextCursor: string | null } = await apiV1(url);
    all.push(...page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return all;
}

export function EntrantsPanel({
  divisionId,
  entrants,
  logoUrls,
  canEdit,
  positionGroups,
  roles,
  eligibility,
  entrantModel,
  suspensions = {},
  rosterLocked = false,
  viewerPlan,
  divisionStatus,
}: Props) {
  const msg = useMsg();
  const router = useRouter();
  const confirmDialog = useConfirm();
  const [persons, setPersons] = useState<Person[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [paywallFeature, setPaywallFeature] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Club facet (Jul3/01 §8): filter entrants by parent club. Hidden when the
  // org has no clubs (or the clubs list is not readable on this plan).
  const [clubs, setClubs] = useState<{ id: string; name: string }[]>([]);
  const [clubFilter, setClubFilter] = useState("");
  const [clubEntrantIds, setClubEntrantIds] = useState<Set<string> | null>(null);
  // Existing-team enrollment (unified Add Entrant): the org's teams, for the
  // picker. Empty for orgs that never imported — the form then shows only the
  // "new entrant" mode, exactly as before.
  const [teams, setTeams] = useState<TeamOption[]>([]);
  // Division-wide (person → team entrant) map, for the same-division
  // double-roster warning (advisory: a person on two teams here is flagged,
  // not blocked).
  const [rosterIndex, setRosterIndex] = useState<DivisionRosterRow[]>([]);
  // Bumped after every mutation to force a roster-map refetch.
  const [rosterBump, setRosterBump] = useState(0);

  useEffect(() => {
    loadAllPersons().then(setPersons).catch(() => setPersons([]));
    apiV1<{ id: string; name: string }[]>("/api/v1/clubs")
      .then(setClubs)
      .catch(() => setClubs([]));
    apiV1<TeamOption[]>("/api/v1/teams")
      .then(setTeams)
      .catch(() => setTeams([]));
  }, []);

  const enteredTeamIds = useMemo(
    () => new Set(entrants.map((e) => e.team_id).filter((id): id is string => id != null)),
    [entrants],
  );

  // Refetch the roster map whenever the entrant set changes OR any mutation
  // runs (rosterBump) — a member added/removed on one team must clear/raise the
  // warning on the others, and entrant ids alone don't capture roster edits.
  const entrantSig = entrants.map((e) => `${e.id}:${e.status}`).join(",");
  useEffect(() => {
    apiV1<DivisionRosterRow[]>(`/api/v1/divisions/${divisionId}/roster`)
      .then(setRosterIndex)
      .catch(() => setRosterIndex([]));
  }, [divisionId, entrantSig, rosterBump]);

  const otherTeamsFor = useCallback(
    (personId: string, exceptEntrantId: string) =>
      rosterIndex.filter((r) => r.person_id === personId && r.entrant_id !== exceptEntrantId),
    [rosterIndex],
  );

  useEffect(() => {
    if (!clubFilter) return; // cleared in the select's onChange
    apiV1<EntrantRow[]>(
      `/api/v1/divisions/${divisionId}/entrants?club_id=${encodeURIComponent(clubFilter)}`,
    )
      .then((rows) => setClubEntrantIds(new Set(rows.map((r) => r.id))))
      .catch(() => setClubEntrantIds(null));
  }, [clubFilter, divisionId]);

  const visibleEntrants = clubEntrantIds
    ? entrants.filter((e) => clubEntrantIds.has(e.id))
    : entrants;

  const fail = useCallback((err: unknown) => {
    if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") {
      setPaywallFeature(String(err.extra.feature_key ?? ""));
    } else {
      setError(err instanceof Error ? err.message : "Failed");
    }
  }, []);

  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setError(null);
    setPaywallFeature(null);
    setBusy(true);
    try {
      const result = await fn();
      router.refresh();
      setRosterBump((n) => n + 1); // re-pull the division roster map
      return result;
    } catch (err) {
      fail(err);
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  // RS011: the override dialog's pending state — set only while a roster
  // write is blocked on ELIGIBILITY_VIOLATION and waiting on the organiser.
  const [eligibilityGate, setEligibilityGate] = useState<{
    violations: EligibilityIssue[];
    onCancel: () => void;
    onConfirm: (reason: string) => void;
  } | null>(null);

  /** Merges an override reason into a roster-write JSON payload — absent
   *  `override` leaves the payload untouched (the field is optional on
   *  every body that takes it). */
  function withOverride(
    payload: Record<string, unknown>,
    override?: { reason: string },
  ): Record<string, unknown> {
    return override ? { ...payload, eligibility_override: override } : payload;
  }

  /** Like `run`, but for roster-writing calls (`fn` takes the override the
   *  dialog collects): on a 422 `ELIGIBILITY_VIOLATION` it opens
   *  `EligibilityOverrideDialog` instead of the generic error banner, and
   *  the returned promise resolves once the organiser cancels (→
   *  `undefined`, matching `run`'s own failure return) or a reason-carrying
   *  retry itself settles. Callers (`AddEntrantForm`, `RosterEditor`'s save,
   *  sync-from-squad) already branch on `res === undefined` the same way
   *  `run`'s callers do, so their existing success handling fires unchanged
   *  on the eventual result — a dialog round-trip is invisible to them. */
  function runGated<T>(fn: (override?: { reason: string }) => Promise<T>): Promise<T | undefined> {
    const attempt = async (override?: { reason: string }): Promise<T | undefined> => {
      setError(null);
      setPaywallFeature(null);
      setBusy(true);
      try {
        const result = await fn(override);
        router.refresh();
        setRosterBump((n) => n + 1);
        setBusy(false);
        return result;
      } catch (err) {
        setBusy(false);
        if (err instanceof ApiV1Error && err.code === "ELIGIBILITY_VIOLATION") {
          const violations = (err.extra.violations as EligibilityIssue[] | undefined) ?? [];
          return new Promise<T | undefined>((resolve) => {
            setEligibilityGate({
              violations,
              onCancel: () => {
                setEligibilityGate(null);
                resolve(undefined);
              },
              onConfirm: (reason: string) => {
                setEligibilityGate(null);
                resolve(attempt({ reason }));
              },
            });
          });
        }
        fail(err);
        return undefined;
      }
    };
    return attempt(undefined);
  }

  const eligibilityBadgeList = eligibilityBadges(eligibility, msg);

  return (
    <div className="space-y-6">
      {eligibilityBadgeList.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <span className="font-medium">{msg("divset.entrants.eligibility.label")}</span>
          {eligibilityBadgeList.map((badge, i) => (
            <span key={i} className="rounded-full bg-white/70 px-2 py-0.5">
              {badge}
            </span>
          ))}
          <span className="text-amber-600">{msg("divset.entrants.eligibility.hint")}</span>
        </div>
      )}

      {canEdit && rosterLocked && (
        <p className="panel p-4 text-sm text-slate-600" data-testid="entrants-roster-locked">
          {msg("entrants.locked.note")}
        </p>
      )}
      {canEdit && !rosterLocked && (
        <AddEntrantForm
          persons={persons}
          teams={teams}
          enteredTeamIds={enteredTeamIds}
          entrantModel={entrantModel}
          busy={busy}
          onSubmit={(payload) =>
            runGated((override) =>
              apiV1<{ roster_keys_dropped?: number }>(
                `/api/v1/divisions/${divisionId}/entrants`,
                { method: "POST", json: withOverride(payload, override) },
              ),
            )
          }
          importControls={
            <CsvImport
              busy={busy}
              onImport={async (rows) => {
                // RS011 review fix 5: this bulk path used to call plain
                // `run(...)`, not the `runGated(...)` wrapper its 3 sibling
                // roster-write call sites in this file use — the server gate
                // still fired, but a violation surfaced only as a generic red
                // error banner with no path to override except falling back
                // to one-at-a-time adds. `withOverride` is applied to EVERY
                // entrant in the batch on a confirmed retry — `eligibility_
                // override` is per-entrant (CreateEntrant's own shape,
                // bulk-create can override some rows and not others), but a
                // 422 from this array body only names the FIRST offending
                // entrant (createEntrants throws inside its per-input loop),
                // so there's no way to know from here which of the batch it
                // was; applying the confirmed override to the whole retried
                // batch is the safe interpretation of "the organiser just
                // confirmed this batch is fine."
                //
                // RS011 round-2 review fix: person resolution (which CREATES
                // rows via POST /persons for any name not already in the
                // directory) must happen exactly ONCE, before `runGated`, not
                // inside the retried closure. `runGated` re-invokes the same
                // closure verbatim on an override-confirm retry; the original
                // shape ran `ensurePerson` again on retry against `persons`
                // (a state snapshot captured when this closure was created,
                // stale by the time of a second call), silently minting a
                // SECOND, orphaned person row per CSV name on every override
                // confirm. Resolving persons up front makes the retried
                // closure a pure resubmit of an already-built payload — no
                // side effects on retry, matching the other 3 `runGated`
                // call sites in this file.
                const byName = new Map(persons.map((p) => [p.full_name.toLowerCase(), p]));
                const ensurePerson = async (row: CsvRow): Promise<string> => {
                  const existing = byName.get(row.name.toLowerCase());
                  if (existing) return existing.id;
                  const created = await apiV1<Person>("/api/v1/persons", {
                    method: "POST",
                    json: {
                      full_name: row.name,
                      dob: row.dob || null,
                      gender: row.gender || null,
                    },
                  });
                  byName.set(created.full_name.toLowerCase(), created);
                  setPersons((prev) => [...prev, created]);
                  return created.id;
                };

                const teamMode = rows.some((r) => r.team);
                let entrantsPayload: Record<string, unknown>[];
                if (teamMode) {
                  const teams = new Map<string, CsvRow[]>();
                  for (const row of rows) {
                    const key = row.team || row.name;
                    if (!teams.has(key)) teams.set(key, []);
                    teams.get(key)!.push(row);
                  }
                  entrantsPayload = [];
                  for (const [team, teamRows] of teams) {
                    const members = [];
                    for (const row of teamRows) {
                      members.push({
                        person_id: await ensurePerson(row),
                        squad_number: row.squad_number ?? null,
                        is_captain: false,
                        roles: [],
                      });
                    }
                    entrantsPayload.push({ kind: "team", display_name: team, members });
                  }
                } else {
                  entrantsPayload = [];
                  for (const row of rows) {
                    entrantsPayload.push({
                      kind: "individual",
                      display_name: row.name,
                      seed: row.seed ?? null,
                      members: [{ person_id: await ensurePerson(row), is_captain: false, roles: [] }],
                    });
                  }
                }

                await runGated((override) =>
                  apiV1(`/api/v1/divisions/${divisionId}/entrants`, {
                    method: "POST",
                    json: entrantsPayload.map((e) => withOverride(e, override)),
                  }),
                );
              }}
            />
          }
        />
      )}

      {paywallFeature && <UpgradeGate feature={paywallFeature} viewerPlan={viewerPlan} />}
      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>
      )}

      {clubs.length > 0 && (
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <span>Club</span>
          <select
            className="input max-w-xs"
            value={clubFilter}
            onChange={(e) => {
              setClubFilter(e.target.value);
              if (!e.target.value) setClubEntrantIds(null);
            }}
            aria-label="Filter entrants by club"
            data-testid="entrants-club-filter"
          >
            <option value="">All clubs</option>
            {clubs.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
      )}

      <section className="card scroll-x scroll-x-fade">
        <table className="table">
          <thead>
            <tr>
              <th className="px-4 py-2 text-left">{msg("entrants.table.entrant")}</th>
              <th className="px-4 py-2 text-left">{msg("entrants.table.kind")}</th>
              <th className="px-4 py-2 text-left">{msg("entrants.table.seed")}</th>
              {/* The column is translated; the VALUES under it are still the
                  raw `entrants.status` enum, in English, for every locale.
                  Deliberate and owner-scoped-out (2026-09-22): mapping the enum
                  is a separate job from swapping a string. */}
              <th className="px-4 py-2 text-left">{msg("entrants.table.status")}</th>
              {canEdit && <th className="px-4 py-2 text-right">{msg("entrants.table.actions")}</th>}
            </tr>
          </thead>
          <tbody>
            {visibleEntrants.length === 0 && (
              <tr>
                <td
                  colSpan={canEdit ? 5 : 4}
                  className="px-4 py-6 text-center text-sm text-slate-400"
                  data-testid="entrants-table-empty"
                >
                  {clubFilter ? msg("entrants.table.emptyForClub") : msg("entrants.table.empty")}
                </td>
              </tr>
            )}
            {visibleEntrants.map((e) => (
              <EntrantTableRow
                key={e.id}
                entrant={e}
                logoUrl={logoUrls?.[e.id] ?? null}
                canEdit={canEdit}
                busy={busy}
                persons={persons}
                positionGroups={positionGroups}
                roles={roles}
                entrantModel={entrantModel}
                eligibility={eligibility}
                suspensions={suspensions[e.id]}
                otherTeamsFor={otherTeamsFor}
                deletable={divisionStatus === "setup"}
                onPatch={(patch) =>
                  runGated((override) =>
                    apiV1(`/api/v1/entrants/${e.id}`, {
                      method: "PATCH",
                      json: withOverride(patch, override),
                    }),
                  )
                }
                onWithdraw={async () => {
                  // Withdrawal mid-tournament does fixture surgery (spec 05
                  // §5) — spell out the policy before firing.
                  const ok = await confirmDialog({
                    title: msg("confirm.withdrawEntrant.title", { name: e.display_name }),
                    body: msg("confirm.withdrawEntrant.body"),
                    confirmLabel: msg("confirm.withdrawEntrant.label"),
                    tone: "danger",
                  });
                  if (!ok) return;
                  await run(() =>
                    apiV1(`/api/v1/entrants/${e.id}/withdraw`, { method: "POST", json: {} }),
                  );
                }}
                onBadge={(file) => void run(() => badgeRequest(e.id, file))}
                onDelete={async () => {
                  // Only offered pre-setup (deletable prop) — nothing downstream
                  // to unwind yet, so no fixture-surgery warning like Withdraw's.
                  const ok = await confirmDialog({
                    title: msg("confirm.deleteEntrant.title", { name: e.display_name }),
                    body: msg("confirm.deleteEntrant.body"),
                    confirmLabel: msg("confirm.deleteEntrant.label"),
                    tone: "danger",
                  });
                  if (!ok) return;
                  await run(() => apiV1(`/api/v1/entrants/${e.id}`, { method: "DELETE" }));
                }}
                onSyncSquad={
                  e.team_id
                    ? async () => {
                        // Replaces the whole entry roster — spell that out.
                        const ok = await confirmDialog({
                          title: msg("confirm.syncSquad.title", { name: e.display_name }),
                          body: msg("confirm.syncSquad.body"),
                          confirmLabel: msg("confirm.syncSquad.label"),
                        });
                        if (!ok) return undefined;
                        return runGated((override) =>
                          apiV1<{ members: Member[] }>(
                            `/api/v1/entrants/${e.id}/roster/sync`,
                            { method: "POST", json: withOverride({}, override) },
                          ),
                        );
                      }
                    : undefined
                }
              />
            ))}
          </tbody>
        </table>
      </section>

      <EligibilityOverrideDialog
        open={eligibilityGate !== null}
        violations={eligibilityGate?.violations ?? []}
        busy={busy}
        onCancel={() => eligibilityGate?.onCancel()}
        onConfirm={(reason) => eligibilityGate?.onConfirm(reason)}
        testId="eligibility-override"
      />
    </div>
  );
}

/** RS007/V380 — category/age-band badges plus the raw organiser note, in
 *  that order. `open`/null carries no restriction to announce (same
 *  precedent as the registration hub row's own categoryLabel — "Null/open
 *  ... never a badge; only an explicit mens/womens/mixed restriction is
 *  worth one"); the note renders VERBATIM (organiser-authored free text,
 *  not a translated label — same "render as TEXT, never HTML/markdown"
 *  rule the public register/join pages follow for the identical column). */
export function eligibilityBadges(
  e: EntrantsPanelEligibility,
  msg: (key: MessageKey, vars?: Record<string, string | number>) => string,
): string[] {
  const badges: string[] = [];
  // e.category is the raw `divisions.category` column (string | null,
  // matching DivisionRow — divisions.ts); the DB CHECK/zod enum already
  // constrain its real values to DivisionCategoryValue, same precedent as
  // this file's own `kind as EntrantKind` narrowing elsewhere.
  const category = resolveDivisionCategory(e.category as DivisionCategoryValue | null);
  if (category !== "open") badges.push(msg(ENTRANT_CATEGORY_KEY[category]));
  const ageBand = deriveAgeBand(e.age_min, e.age_max);
  if (ageBand.kind === "range") {
    badges.push(msg("reg.hub.row.ageBand.range", { min: ageBand.min, max: ageBand.max }));
  } else if (ageBand.kind === "min") {
    badges.push(msg("reg.hub.row.ageBand.min", { min: ageBand.min }));
  } else if (ageBand.kind === "max") {
    badges.push(msg("reg.hub.row.ageBand.max", { max: ageBand.max }));
  }
  if (e.eligibility_note) badges.push(e.eligibility_note);
  return badges;
}

// ---------------------------------------------------------------------------
// Add one entrant
// ---------------------------------------------------------------------------

const STORAGE_BASE = `${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""}/storage/v1/object/public/assets`;

function AddEntrantForm({
  persons,
  teams,
  enteredTeamIds,
  entrantModel,
  busy,
  onSubmit,
  importControls,
}: {
  persons: Person[];
  teams: TeamOption[];
  enteredTeamIds: Set<string>;
  entrantModel: EffectiveEntrantModel;
  busy: boolean;
  onSubmit: (
    payload: Record<string, unknown>,
  ) => Promise<{ roster_keys_dropped?: number } | undefined>;
  /** Inline CSV-import controls rendered in the footer row. */
  importControls?: React.ReactNode;
}) {
  // "Existing team" mode enrolls a whole team, so it only makes sense when this
  // division actually accepts a team kind AND the org has teams (created by
  // import). Otherwise the form is exactly the old "new entrant" flow.
  const teamKindAllowed = entrantModel.kinds.includes("team");
  const canExisting = teamKindAllowed && teams.length > 0;
  const [mode, setMode] = useState<"existing" | "new">("new");
  const [touched, setTouched] = useState(false);
  // Teams load after first paint; default to "existing" once available, but
  // never override a mode the organiser explicitly picked.
  useEffect(() => {
    if (!touched) setMode(canExisting ? "existing" : "new");
  }, [canExisting, touched]);

  return (
    <form className="card space-y-3 p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-slate-700">Add entrant</h3>
        {canExisting && (
          <div className="inline-flex rounded-lg border border-slate-200 p-0.5 text-xs">
            {(["existing", "new"] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => {
                  setTouched(true);
                  setMode(m);
                }}
                className={`rounded-md px-2.5 py-1 font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-300 ${
                  mode === m ? "bg-purple-600 text-white" : "text-slate-500 hover:text-slate-800"
                }`}
              >
                {m === "existing" ? "Existing team" : "New entrant"}
              </button>
            ))}
          </div>
        )}
      </div>

      {mode === "existing" && canExisting ? (
        <ExistingTeamFields
          teams={teams}
          enteredTeamIds={enteredTeamIds}
          busy={busy}
          onSubmit={onSubmit}
        />
      ) : (
        <NewEntrantFields
          persons={persons}
          entrantModel={entrantModel}
          busy={busy}
          onSubmit={onSubmit}
        />
      )}

      <div className="flex flex-wrap items-center justify-end gap-3">{importControls}</div>
    </form>
  );
}

/** Mode A: enroll a team that already exists (season rollover, league + cup). */
/** Exported for tests only — nothing else imports it, for the same reason
 *  `EntrantTableRow` is: the squad preview below is gated on `selectedId`, a
 *  `useState` this form owns, so a static render can never pick a team and
 *  the preview's copy could only ever be declared, never witnessed. */
export function ExistingTeamFields({
  teams,
  enteredTeamIds,
  busy,
  onSubmit,
}: {
  teams: TeamOption[];
  enteredTeamIds: Set<string>;
  busy: boolean;
  onSubmit: (
    payload: Record<string, unknown>,
  ) => Promise<{ roster_keys_dropped?: number } | undefined>;
}) {
  const msg = useMsg();
  const msgPlural = useMsgPlural();
  const [filter, setFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [copyRoster, setCopyRoster] = useState(true);
  const [note, setNote] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const rows = q
      ? teams.filter(
          (t) =>
            t.name.toLowerCase().includes(q) ||
            (t.club_name ?? "").toLowerCase().includes(q),
        )
      : teams;
    return rows.slice(0, 12);
  }, [teams, filter]);

  const selected = teams.find((t) => t.id === selectedId) ?? null;
  const canCopy = Boolean(selected?.latest_entrant_id);

  async function submit() {
    if (!selected) return;
    setNote(null);
    const res = await onSubmit({
      kind: "team",
      team_id: selected.id,
      // display_name is intentionally omitted — the server snapshots it from
      // the team so a later rename never rewrites historical standings.
      ...(copyRoster && selected.latest_entrant_id
        ? { copy_roster_from_entrant_id: selected.latest_entrant_id }
        : {}),
    });
    if (res === undefined) return; // failed — panel shows the error (incl. 409)
    setSelectedId(null);
    setFilter("");
    if (res.roster_keys_dropped)
      setNote(
        `Enrolled. ${res.roster_keys_dropped} position/role setting${
          res.roster_keys_dropped > 1 ? "s" : ""
        } didn't carry over to this sport.`,
      );
  }

  return (
    <div className="space-y-3">
      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        className="input"
        placeholder="Search teams…"
        aria-label="Search teams"
      />
      <div className="flex flex-wrap gap-1.5">
        {teams.length === 0 && (
          <span className="text-xs text-slate-400">No teams yet — import some first.</span>
        )}
        {filtered.map((t) => {
          const entered = enteredTeamIds.has(t.id);
          const isSelected = t.id === selectedId;
          return (
            <button
              key={t.id}
              type="button"
              disabled={entered}
              onClick={() => setSelectedId(isSelected ? null : t.id)}
              data-testid="enroll-team-option"
              className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs transition ${
                entered
                  ? "cursor-not-allowed border-slate-200 text-slate-300"
                  : isSelected
                    ? "border-purple-500 bg-purple-50 text-purple-700"
                    : "border-slate-200 text-slate-600 hover:border-purple-200"
              }`}
              title={t.club_name ?? undefined}
            >
              {t.logo_path && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`${STORAGE_BASE}/${t.logo_path}`}
                  alt=""
                  className="h-4 w-4 rounded object-contain"
                />
              )}
              <span>{t.name}</span>
              {t.club_short_name && (
                <span className="text-[10px] text-slate-400">{t.club_short_name}</span>
              )}
              {entered && <span className="text-[10px] text-slate-400">· Already entered</span>}
            </button>
          );
        })}
      </div>

      <label className="flex items-center gap-2 text-xs text-slate-600">
        <input
          type="checkbox"
          checked={copyRoster && canCopy}
          disabled={!canCopy}
          onChange={(e) => setCopyRoster(e.target.checked)}
        />
        Copy roster from this team&apos;s most recent entrant
        {!canCopy && selected && <span className="text-slate-400">(no earlier roster)</span>}
      </label>

      {/* Roster preview: enrollment seeds from the squad exactly once, so an
          empty squad silently produces an empty entry roster — say so BEFORE
          the organiser enrolls, not after they expand the row and wonder. */}
      {selected && !(copyRoster && canCopy) && (
        selected.squad_count > 0 ? (
          <p
            className="text-xs text-slate-500"
            data-testid="squad-preview"
            data-squad-empty="false"
            data-squad-count={String(selected.squad_count)}
          >
            {/* `plural()`, not `count > 1 ? "s" : ""` — the suffix trick is the
                construction that cannot survive translation at all. */}
            {msgPlural("entrants.add.squadPreview", selected.squad_count)}
          </p>
        ) : (
          <p
            className="text-xs text-amber-600"
            data-testid="squad-preview"
            data-squad-empty="true"
            data-squad-count="0"
          >
            {/* The sentence NAMES A CONTROL, so it interpolates that control's
                own key rather than gluing a translated fragment in: four
                locales put the name in four different places (Dutch ends on
                "gebruik later “…”"), and whatever the button says, this says.
                A glued fragment is the word-order trap the Swiss legend paid
                for. */}
            {msg("entrants.add.squadEmpty", { control: msg("entrants.row.syncSquad") })}
          </p>
        )
      )}

      {note && <p className="text-xs text-emerald-600">{note}</p>}

      <button
        type="button"
        onClick={submit}
        disabled={busy || !selected}
        className="btn btn-primary"
      >
        {busy ? "Enrolling…" : "Enroll team"}
      </button>
    </div>
  );
}

/** Mode B: the original ad-hoc entrant (scratch pairs, one-offs) — never
 *  creates a team, kept deliberately as an explicit choice. The add form now
 *  follows the division's effective entrant model: it offers only the allowed
 *  kinds, and individual/pair entrants derive their display name from the
 *  picked people instead of a free-text box. Exported for the markup test. */
export function NewEntrantFields({
  persons,
  entrantModel,
  busy,
  onSubmit,
}: {
  persons: Person[];
  entrantModel: EffectiveEntrantModel;
  busy: boolean;
  onSubmit: (payload: Record<string, unknown>) => Promise<unknown>;
}) {
  const msg = useMsg();
  const [kind, setKind] = useState<string>(entrantModel.defaultKind);
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [seed, setSeed] = useState("");
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [filter, setFilter] = useState("");

  const isIndividual = kind === "individual";
  const isTeam = kind === "team";
  const cap = entrantKindCap(kind, entrantModel);
  const atCap = memberIds.length >= cap;
  const singleKind = entrantModel.kinds.length === 1;

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return persons.slice(0, 8);
    return persons.filter((p) => p.full_name.toLowerCase().includes(q)).slice(0, 8);
  }, [persons, filter]);

  // Derived name from the picked people: individual → that person, pair →
  // "A & B". Teams always name themselves manually.
  const derivedName = useMemo(() => {
    const picked = memberIds
      .map((id) => persons.find((p) => p.id === id)?.full_name)
      .filter((n): n is string => Boolean(n));
    if (isIndividual) return picked[0] ?? "";
    // The shared create-time join: a later roster edit recognises (and
    // follows) only a name built by it — see lib/entrant-roster-name.ts.
    if (kind === "pair") return rosterDerivedName(picked);
    return "";
  }, [isIndividual, kind, memberIds, persons]);

  // The name shown in / submitted from the editable field. Teams and a
  // hand-edited individual/pair keep the typed value; untouched ones
  // auto-fill from the picked people. The field stays for individuals too:
  // organisers legitimately register name-only entrants with no person
  // record (board-game one-nighters) — the person pick is optional sugar.
  const nameValue = isTeam || nameTouched ? name : derivedName;
  const submitName = nameValue;

  function pickKind(next: string) {
    setKind(next);
    // Trim any picks beyond the new kind's cap (team→pair keeps the first two).
    setMemberIds((prev) => prev.slice(0, entrantKindCap(next, entrantModel)));
  }

  function togglePick(id: string) {
    setMemberIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (isIndividual) return [id]; // single seat — a new pick replaces
      if (prev.length >= cap) return prev; // pair/team cap reached — ignore
      return [...prev, id];
    });
  }

  async function submit() {
    await onSubmit({
      kind,
      display_name: submitName,
      seed: seed ? Number(seed) : null,
      members: memberIds.map((id) => ({ person_id: id, is_captain: false, roles: [] })),
    });
    setName("");
    setNameTouched(false);
    setSeed("");
    setMemberIds([]);
  }

  return (
    <div className="space-y-3">
      {/* Kind — chips when the division offers a choice (mirrors the Settings
          tab), a static caption when only one shape is allowed. */}
      {singleKind ? (
        <span className="inline-flex w-fit rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs text-slate-600">
          {msg(ENTRANT_KIND_LABEL[kind as EntrantKind])}
        </span>
      ) : (
        <fieldset className="min-w-0 space-y-1.5 [min-inline-size:0]">
          <legend className="label">{msg("entrants.add.kind")}</legend>
          <div
            className="flex flex-wrap gap-1.5"
            role="group"
            aria-label={msg("entrants.add.kind")}
          >
            {entrantModel.kinds.map((k) => {
              const active = k === kind;
              return (
                <button
                  key={k}
                  type="button"
                  data-kind={k}
                  aria-pressed={active}
                  onClick={() => pickKind(k)}
                  className={`rounded-full border px-3 py-1 text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-300 ${
                    active
                      ? "border-purple-600 bg-purple-600 text-white"
                      : "border-slate-200 bg-white text-slate-600 hover:border-purple-300"
                  }`}
                >
                  {msg(ENTRANT_KIND_LABEL[k])}
                </button>
              );
            })}
          </div>
        </fieldset>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block min-w-0">
          <span className="label">Name</span>
          <input
            value={nameValue}
            onChange={(e) => {
              setName(e.target.value);
              setNameTouched(true);
            }}
            className="input w-full"
            placeholder={isTeam ? "Riverside CC" : isIndividual ? "Alex Doe" : "Alice & Bob"}
          />
        </label>
        <label className="block min-w-0">
          <span className="label">Seed</span>
          <input
            type="number"
            min={1}
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
            className="input w-full"
          />
        </label>
      </div>

      <div className="min-w-0">
        <span className="label">
          {kind === "individual"
            ? msg("entrants.add.player")
            : kind === "pair"
              ? msg("entrants.add.pairPlayers")
              : "Members (persons directory)"}
        </span>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="input w-full"
          placeholder="Search players…"
        />
        <div className="mt-2 flex flex-wrap gap-1.5">
          {filtered.map((p) => {
            const selected = memberIds.includes(p.id);
            // Pair/team seats are finite: once full, unpicked people are
            // disabled. Individual always allows a replacing pick.
            const blocked = !selected && atCap && !isIndividual;
            return (
              <button
                key={p.id}
                type="button"
                disabled={blocked}
                aria-pressed={selected}
                onClick={() => togglePick(p.id)}
                className={`max-w-full truncate rounded-full border px-2.5 py-0.5 text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-300 ${
                  selected
                    ? "border-purple-500 bg-purple-50 text-purple-700"
                    : blocked
                      ? "cursor-not-allowed border-slate-200 text-slate-300"
                      : "border-slate-200 text-slate-500 hover:border-purple-200"
                }`}
              >
                {p.full_name}
              </button>
            );
          })}
          {persons.length === 0 && (
            <span className="text-xs text-slate-400">
              No players yet — add them under Players, or import a CSV.
            </span>
          )}
        </div>
        {memberIds.length > 0 && (
          <p className="mt-1 text-xs text-slate-400">{memberIds.length} selected</p>
        )}
      </div>

      <button
        type="button"
        onClick={submit}
        disabled={busy || !submitName.trim()}
        className="btn btn-primary w-full sm:w-auto"
      >
        {busy ? "Saving…" : "Add entrant"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CSV import
// ---------------------------------------------------------------------------

interface CsvRow {
  name: string;
  dob?: string;
  gender?: string;
  team?: string;
  seed?: number;
  squad_number?: number;
}

function parseCsv(text: string): CsvRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];
  const first = lines[0].toLowerCase();
  const hasHeader = first.includes("name");
  const headers = hasHeader ? first.split(",").map((h) => h.trim()) : ["name"];
  const rows: CsvRow[] = [];
  for (const line of lines.slice(hasHeader ? 1 : 0)) {
    const cells = line.split(",").map((c) => c.trim());
    const get = (key: string) => {
      const i = headers.indexOf(key);
      return i >= 0 ? cells[i] : undefined;
    };
    const name = hasHeader ? get("name") : cells[0];
    if (!name) continue;
    const row: CsvRow = { name };
    const dob = get("dob");
    if (dob) row.dob = dob;
    const gender = get("gender");
    if (gender && ["m", "f", "x"].includes(gender.toLowerCase())) {
      row.gender = gender.toLowerCase();
    }
    const team = get("team");
    if (team) row.team = team;
    const seed = get("seed");
    if (seed && Number.isInteger(Number(seed))) row.seed = Number(seed);
    const squad = get("squad_number") ?? get("number");
    if (squad && Number.isInteger(Number(squad))) row.squad_number = Number(squad);
    rows.push(row);
  }
  return rows;
}

function CsvImport({
  busy,
  onImport,
}: {
  busy: boolean;
  onImport: (rows: CsvRow[]) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    const rows = parseCsv(await file.text());
    if (rows.length === 0) {
      setError("No entrants found in that file — check it matches the sample format.");
      return;
    }
    setError(null);
    onImport(rows);
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <input
        ref={fileRef}
        type="file"
        accept=".csv,text/csv"
        onChange={onFile}
        className="hidden"
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => fileRef.current?.click()}
        className="btn btn-ghost"
      >
        {busy ? "Importing…" : "Import CSV"}
      </button>
      <a
        href="/entrants-sample.csv"
        download
        className="text-xs text-purple-600 underline hover:text-purple-800"
      >
        Sample CSV
      </a>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Entrant row (+ expandable roster editor)
// ---------------------------------------------------------------------------

/** F4 — the badge route is multipart, so it can't ride apiV1 (which forces a
 *  JSON content-type); same raw-fetch pattern as the /me photo upload. */
async function badgeRequest(entrantId: string, file: File | null): Promise<void> {
  let res: Response;
  if (file) {
    const form = new FormData();
    form.append("file", file);
    res = await fetch(`/api/v1/entrants/${entrantId}/badge`, { method: "POST", body: form });
  } else {
    res = await fetch(`/api/v1/entrants/${entrantId}/badge`, { method: "DELETE" });
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null;
    throw new Error(body?.error?.message ?? `badge update failed (${res.status})`);
  }
}

/** Exported for the markup test. Renders the crest preview plus, when
 *  editable, upload/replace + remove controls. */
export function EntrantBadgeControl({
  entrant,
  logoUrl = null,
  canEdit,
  busy,
  onBadge,
}: {
  entrant: Pick<EntrantRow, "id" | "display_name" | "badge_url">;
  /** Resolved fallback (team logo / club crest) when no own badge is set. */
  logoUrl?: string | null;
  canEdit: boolean;
  busy: boolean;
  onBadge: (file: File | null) => void;
}) {
  const src = entrant.badge_url
    ? resolveEntrantBadge({ badge_url: entrant.badge_url })
    : (logoUrl ?? null);
  return (
    <div className="flex items-center gap-3">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" className="h-8 w-8 shrink-0 rounded-md border border-slate-200 object-cover" />
      ) : (
        <span
          aria-hidden
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-slate-100 text-xs font-semibold text-slate-500"
        >
          {entrant.display_name.slice(0, 1).toUpperCase()}
        </span>
      )}
      <span className="text-xs text-slate-500">Badge</span>
      {canEdit && (
        <>
          <label className="btn btn-ghost cursor-pointer px-2 py-1 text-xs">
            {entrant.badge_url ? "Replace" : "Upload"}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              className="hidden"
              disabled={busy}
              aria-label={`Badge for ${entrant.display_name}`}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) onBadge(file);
              }}
            />
          </label>
          {entrant.badge_url && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onBadge(null)}
              className="btn btn-ghost px-2 py-1 text-xs text-red-600"
            >
              Remove
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** What a blur on the Name field saves: the trimmed name when it is a real
 *  change, or `null` — save nothing and put the field back — when it was
 *  emptied (the column cannot be empty) or left as it was. Exported for the
 *  markup test. */
export function nameFieldCommit(typed: string, current: string): string | null {
  const next = typed.trim();
  if (next === "" || next === current) return null;
  return next;
}

/** The entrant's name, editable in place at the top of an expanded card
 *  (2026-09-22 — `display_name` was set once at create and no screen could
 *  change it). Saves on blur, or Enter; the row header follows through the
 *  panel's `router.refresh()`. Nothing for a read-only viewer. Exported for the
 *  markup test.
 *
 *  Uncontrolled, and remounted by the caller on `key={name}`: a rename made
 *  ELSEWHERE — the roster editor's save renaming a pair whose name was derived
 *  from its people (`patchEntrant`) — must land in this field too, not leave it
 *  holding the old name for the next blur to write straight back. */
export function EntrantNameField({
  name,
  canEdit,
  onRename,
}: {
  name: string;
  canEdit: boolean;
  onRename: (next: string) => void;
}) {
  const msg = useMsg();
  if (!canEdit) return null;
  return (
    <label className="mb-3 block min-w-0 max-w-sm">
      <span className="label">{msg("entrants.row.name")}</span>
      <input
        type="text"
        defaultValue={name}
        maxLength={ENTRANT_NAME_MAX}
        autoComplete="off"
        onBlur={(e) => {
          const next = nameFieldCommit(e.currentTarget.value, name);
          if (next === null) e.currentTarget.value = name;
          else onRename(next);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className="input min-h-11 w-full text-sm"
        data-testid="entrant-name-field"
      />
    </label>
  );
}

/** Exported for tests only — nothing else imports it. The row's EXPANDED half
 *  (Sync from team squad, the roster's loading line) sits behind `open`, a
 *  `useState` this row owns, so `renderToStaticMarkup` can never reach it: it
 *  renders one frozen instant with no way to press the disclosure. Driving the
 *  row itself under `_hook-harness`'s dispatcher is the only way those two
 *  strings can be WITNESSED rendering rather than merely declared in a
 *  catalogue, which is the difference this repo keeps paying for. */
export function EntrantTableRow({
  entrant,
  logoUrl,
  canEdit,
  busy,
  persons,
  positionGroups,
  roles,
  entrantModel,
  eligibility,
  suspensions,
  otherTeamsFor,
  deletable,
  onPatch,
  onWithdraw,
  onBadge,
  onSyncSquad,
  onDelete,
}: {
  entrant: EntrantRow;
  logoUrl: string | null;
  canEdit: boolean;
  busy: boolean;
  persons: Person[];
  positionGroups: PositionGroup[];
  roles: RoleSpec[];
  entrantModel: EffectiveEntrantModel;
  /** RS011 — for the roster editor's MISSING_DOB/MISSING_GENDER chips. */
  eligibility: EntrantsPanelEligibility;
  suspensions?: { personName: string; remaining: number }[];
  otherTeamsFor: (personId: string, exceptEntrantId: string) => DivisionRosterRow[];
  /** Hard-delete offered only pre-setup (server enforces the same gate —
   *  `deleteEntrant`, entrants.ts). Once the division has started, Withdraw
   *  is the only removal path. */
  deletable: boolean;
  onPatch: (patch: Record<string, unknown>) => void;
  /** Withdraw with fixture surgery (spec 05 §5) — confirm handled upstream. */
  onWithdraw: () => void;
  onBadge: (file: File | null) => void;
  /** Replace the roster with the team's current squad (team entrants only —
   *  confirm handled upstream; returns the fresh members on success). */
  onSyncSquad?: () => Promise<{ members: Member[] } | undefined>;
  /** Hard delete (confirm handled upstream) — see `deletable`. */
  onDelete: () => void;
}) {
  const msg = useMsg();
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<Member[] | null>(null);
  // RosterEditor seeds its own state from `members` once (useState(initial)) —
  // bump this key when a squad sync replaces the roster so the editor remounts
  // on the fresh list instead of showing the pre-sync one.
  const [rosterVersion, setRosterVersion] = useState(0);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && members === null) {
      try {
        const full = await apiV1<{ members: Member[] }>(`/api/v1/entrants/${entrant.id}`);
        setMembers(full.members);
      } catch {
        setMembers([]);
      }
    }
  }

  const withdrawn = entrant.status === "withdrawn" || entrant.status === "disqualified";
  const kindKey = labelKeyFor(ENTRANT_KIND_LABEL, entrant.kind);
  const statusKey = labelKeyFor(ENTRANT_STATUS_LABEL, entrant.status);

  return (
    <>
      <tr className={withdrawn ? "opacity-50" : ""}>
        <td className="px-4 py-2">
          <button
            type="button"
            onClick={toggle}
            data-testid="entrant-row-disclosure"
            className="flex items-center gap-2 text-left text-sm font-medium text-slate-800 hover:text-purple-700"
          >
            {(() => {
              const src = logoUrl ?? resolveEntrantBadge({ badge_url: entrant.badge_url });
              return src ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={src} alt="" className="h-5 w-5 shrink-0 rounded object-cover" />
              ) : null;
            })()}
            {entrant.display_name}
            <span className="ml-1.5 text-xs text-slate-400">{open ? "▾" : "▸"}</span>
          </button>
          {suspensions && suspensions.length > 0 && (
            <span className="ml-2 align-middle">
              <SuspensionChip suspensions={suspensions} />
            </span>
          )}
        </td>
        {/* The VALUE, not just the header above it. The same kind words the
            add form's chips already print — one vocabulary per console. The
            raw value stays on the element: it is what a spec or a style map
            can key on once the text is four different words. */}
        <td className="px-4 py-2 text-sm text-slate-500" data-entrant-kind={entrant.kind}>
          {kindKey ? msg(kindKey) : entrant.kind}
        </td>
        <td className="px-4 py-2 text-sm text-slate-500">
          {canEdit ? (
            <input
              type="number"
              min={1}
              defaultValue={entrant.seed ?? ""}
              onBlur={(e) => {
                const v = e.target.value ? Number(e.target.value) : null;
                if (v !== entrant.seed) onPatch({ seed: v });
              }}
              // `.input`'s own padding loses to `px-2 py-1 text-xs` under
              // Tailwind's utilities layer (S13/#422 W11). `min-h-11` survives it.
              className="input min-h-11 w-16 px-2 py-1 text-xs"
              // The field has no visible label — its accessible name IS the
              // label, so an English one left every non-English screen-reader
              // user with an unnamed number box. `mobile.spec.ts` used to
              // select on this string; it is on the testid now.
              aria-label={msg("entrants.row.seedLabel", { name: entrant.display_name })}
              data-testid="entrant-row-seed"
            />
          ) : (
            (entrant.seed ?? "—")
          )}
        </td>
        <td className="px-4 py-2">
          {/* `entrantStatusStyle` and the `withdrawn` branch above both read
              the RAW value and keep doing so — only the printed word moves.
              `withdrawn-entrant-organiser.spec.ts` asserted on this cell's
              text to prove the server's own column; it reads the attribute
              now, which is the same claim in a form four locales share. */}
          <span
            className={`badge ${entrantStatusStyle(entrant.status)}`}
            data-entrant-status={entrant.status}
          >
            {statusKey ? msg(statusKey) : entrant.status}
          </span>
        </td>
        {canEdit && (
          <td className="px-4 py-2 text-right">
            <div className="flex justify-end gap-2">
              {withdrawn ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onPatch({ status: "registered" })}
                  data-testid="entrant-row-reinstate"
                  className="btn btn-ghost px-2 py-1 text-xs"
                >
                  {msg("entrants.row.reinstate")}
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={onWithdraw}
                  // `withdrawn-entrant-organiser.spec.ts` used to find this by
                  // the English word, and said so in a comment. On the testid
                  // now — see the Delete sibling below.
                  data-testid="entrant-row-withdraw"
                  className="btn btn-danger px-2 py-1 text-xs"
                >
                  {msg("entrants.row.withdraw")}
                </button>
              )}
              {deletable && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={onDelete}
                  title={msg("entrants.row.deleteHint")}
                  // The walkthrough (`e2e/walkthrough/swiss-pre-start-field-change.spec.ts`)
                  // used to find this button by the English word that used to be
                  // hardcoded here. Now that the label is translated, the handle
                  // has to be something a Dutch organiser's console still carries.
                  data-testid="entrant-row-delete"
                  className="btn btn-danger px-2 py-1 text-xs"
                >
                  {msg("entrants.row.delete")}
                </button>
              )}
            </div>
          </td>
        )}
      </tr>
      {open && (
        <tr>
          <td colSpan={canEdit ? 5 : 4} className="bg-slate-50 px-4 py-3">
            <EntrantNameField
              key={entrant.display_name}
              name={entrant.display_name}
              canEdit={canEdit}
              onRename={(display_name) => onPatch({ display_name })}
            />
            <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
              <EntrantBadgeControl
                entrant={entrant}
                logoUrl={logoUrl}
                canEdit={canEdit}
                busy={busy}
                onBadge={onBadge}
              />
              {canEdit && onSyncSquad && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={async () => {
                    const res = await onSyncSquad();
                    if (res) {
                      setMembers(res.members);
                      setRosterVersion((v) => v + 1);
                    }
                  }}
                  className="btn min-h-[44px] text-xs"
                  title={msg("entrants.row.syncSquadHint")}
                  // `enroll.spec.ts` used to find this by the English label.
                  data-testid="entrant-row-sync-squad"
                >
                  {msg("entrants.row.syncSquad")}
                </button>
              )}
            </div>
            {members === null ? (
              <p className="text-xs text-slate-400" data-testid="entrant-row-roster-loading">
                {msg("entrants.row.loadingRoster")}
              </p>
            ) : (
              <RosterEditor
                key={rosterVersion}
                kind={entrant.kind}
                members={members}
                persons={persons}
                positionGroups={positionGroups}
                roles={roles}
                canEdit={canEdit}
                busy={busy}
                allowCaptain={entrantModel.captain}
                allowSquadNumbers={entrantModel.squadNumbers}
                entrantModel={entrantModel}
                eligibility={eligibility}
                conflictsFor={(personId) => otherTeamsFor(personId, entrant.id)}
                onSave={(next) =>
                  onPatch({
                    members: next.map((m) => ({
                      person_id: m.person_id,
                      squad_number: m.squad_number,
                      default_position_key: m.default_position_key,
                      is_captain: m.is_captain,
                      roles: m.roles,
                    })),
                  })
                }
              />
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function entrantStatusStyle(status: string): string {
  if (status === "confirmed") return "bg-emerald-100 text-emerald-700";
  if (status === "withdrawn") return "bg-slate-100 text-slate-500";
  if (status === "disqualified") return "bg-red-100 text-red-600";
  return "bg-sky-100 text-sky-700";
}

export function RosterEditor({
  members: initial,
  persons,
  positionGroups,
  roles,
  canEdit,
  busy,
  kind,
  allowCaptain,
  allowSquadNumbers,
  entrantModel,
  eligibility,
  conflictsFor,
  onSave,
}: {
  members: Member[];
  persons: Person[];
  positionGroups: PositionGroup[];
  roles: RoleSpec[];
  canEdit: boolean;
  busy: boolean;
  /** Entrant kind — only a team roster shows captain + squad number. */
  kind: string;
  /** Whether the division's effective model allows a captain marker. */
  allowCaptain: boolean;
  /** Whether the division's effective model allows squad numbers. */
  allowSquadNumbers: boolean;
  /** Effective model — supplies the team member cap for the picker gate. */
  entrantModel: EffectiveEntrantModel;
  /** RS011 — division columns for the MISSING_DOB/MISSING_GENDER chips
   *  below (`requiresDob`/`requiresGender`, `@/lib/registration-rules` — the
   *  SAME predicates the server-side gate evaluates against). */
  eligibility: EntrantsPanelEligibility;
  /** Other team entrants IN THIS DIVISION a person is already on. */
  conflictsFor: (personId: string) => DivisionRosterRow[];
  onSave: (members: Member[]) => void;
}) {
  const msg = useMsg();
  const [members, setMembers] = useState(initial);
  const [filter, setFilter] = useState("");
  const [dirty, setDirty] = useState(false);
  // Captain + squad numbers are team concepts, and each is independently
  // switchable in the division's entrant settings.
  const teamish = kind === "team";
  const atCap = members.length >= entrantKindCap(kind, entrantModel);
  // RS011: whether THIS division's rules even care about dob/gender at all —
  // a chip on a division with no age band or category restriction would be
  // noise nobody can act on (there is nothing to be missing FOR).
  const needsDob = requiresDob(eligibility);
  const needsGender = requiresGender(eligibility);

  function update(i: number, patch: Partial<Member>) {
    setMembers((prev) => prev.map((m, j) => (j === i ? { ...m, ...patch } : m)));
    setDirty(true);
  }

  const memberIds = new Set(members.map((m) => m.person_id));
  const candidates = persons
    .filter((p) => !memberIds.has(p.id))
    .filter((p) => !filter || p.full_name.toLowerCase().includes(filter.toLowerCase()))
    .slice(0, 6);

  // Advisory: people also rostered to another team in this division. Not
  // blocked — the organiser may knowingly double-roster (guest, correction).
  const conflicts = members
    .map((m) => ({ name: m.full_name, on: conflictsFor(m.person_id) }))
    .filter((c) => c.on.length > 0);

  return (
    // The roster editor's own box. Named because the members and the
    // add-player SUGGESTIONS live in one subtree, and a page-wide text probe
    // cannot tell "on the roster" from "offered for the roster" — which is
    // exactly how enroll.spec.ts once asserted a roster that was empty.
    <div className="space-y-3" data-testid="entrant-roster">
      {conflicts.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <span className="font-medium">Also on another team in this division:</span>{" "}
          {conflicts
            .map((c) => `${c.name} (${c.on.map((o) => o.entrant_name).join(", ")})`)
            .join("; ")}
          . You can still save.
        </div>
      )}
      {members.length === 0 && (
        <p className="text-xs text-slate-400">No players on this roster.</p>
      )}
      {members.map((m, i) => (
        <div key={m.person_id} className="flex flex-wrap items-center gap-2 text-xs">
          <span className="w-40 truncate font-medium text-slate-700">
            {m.full_name}
            {conflictsFor(m.person_id).length > 0 && (
              <span
                className="ml-1 text-amber-600"
                title={`Also on ${conflictsFor(m.person_id)
                  .map((o) => o.entrant_name)
                  .join(", ")} in this division`}
              >
                ⚠
              </span>
            )}
          </span>
          {/* RS011: MISSING_DOB/MISSING_GENDER — amber, advisory, never a
              block (the organiser-side gate treats these two codes as
              warnings). Shown only when the division's own rules actually
              need the field (needsDob/needsGender) AND this member lacks
              it. */}
          {needsDob && !m.dob && (
            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-amber-700">
              {msg("divset.entrants.warning.missingDob")}
            </span>
          )}
          {needsGender && !m.gender && (
            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-amber-700">
              {msg("divset.entrants.warning.missingGender")}
            </span>
          )}
          {teamish && allowSquadNumbers && (
            <input
              type="number"
              min={0}
              placeholder="No."
              disabled={!canEdit}
              value={m.squad_number ?? ""}
              onChange={(e) =>
                update(i, { squad_number: e.target.value ? Number(e.target.value) : null })
              }
              className="input min-h-11 w-16 px-2 py-1 text-xs"
              aria-label={`Squad number for ${m.full_name}`}
            />
          )}
          {positionGroups.length > 0 && (
            <select
              disabled={!canEdit}
              value={m.default_position_key ?? ""}
              onChange={(e) => update(i, { default_position_key: e.target.value || null })}
              className="select min-h-11 w-36 px-2 py-1 text-xs"
              aria-label={`Position for ${m.full_name}`}
            >
              <option value="">position…</option>
              {positionGroups.map((g) => (
                <option key={g.key} value={g.key}>
                  {g.name}
                </option>
              ))}
            </select>
          )}
          {teamish && allowCaptain && (
            <label className="flex items-center gap-1 text-slate-500">
              <input
                type="checkbox"
                disabled={!canEdit}
                checked={m.is_captain}
                onChange={(e) => {
                  // Captain is unique — setting it clears the others.
                  setMembers((prev) =>
                    prev.map((mm, j) => ({
                      ...mm,
                      is_captain: j === i ? e.target.checked : false,
                    })),
                  );
                  setDirty(true);
                }}
              />
              captain
            </label>
          )}
          {/* `captain` has its own dedicated checkbox above; don't render it
              again as a generic role (some sport specs list it in roles). */}
          {roles.filter((r) => r.key !== "captain").map((r) => (
            <label key={r.key} className="flex items-center gap-1 text-slate-500">
              <input
                type="checkbox"
                disabled={!canEdit}
                checked={m.roles.includes(r.key)}
                onChange={(e) =>
                  update(i, {
                    roles: e.target.checked
                      ? [...m.roles, r.key]
                      : m.roles.filter((k) => k !== r.key),
                  })
                }
              />
              {r.name ?? r.key}
            </label>
          ))}
          {canEdit && (
            <button
              type="button"
              onClick={() => {
                setMembers((prev) => prev.filter((_, j) => j !== i));
                setDirty(true);
              }}
              className="text-red-500 hover:underline"
            >
              remove
            </button>
          )}
        </div>
      ))}

      {canEdit && (
        // `atCap` only hides the ADD affordances (find/candidates) — Save
        // must stay reachable at exactly cap size (e.g. a pair back at 2/2
        // after a remove+re-add), or the only way off this screen is to
        // discard the edit. This footer used to be one block gated on
        // `!atCap`, which made Save disappear the moment a roster returned
        // to full.
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-2">
          {!atCap && (
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Find player…"
              className="input min-h-11 w-44 px-2 py-1 text-xs"
            />
          )}
          {!atCap && candidates.map((p) => {
            const onOther = conflictsFor(p.id);
            return (
              <button
                key={p.id}
                type="button"
                title={
                  onOther.length > 0
                    ? `Already on ${onOther.map((o) => o.entrant_name).join(", ")} in this division`
                    : undefined
                }
                onClick={() => {
                  setMembers((prev) => {
                    // A rapid double-click (or a stale `candidates` list mid-render)
                    // can fire this before the person drops out of the suggestions —
                    // without this guard the same person_id lands twice in `members`,
                    // and the server's unique (entrant_id, person_id) constraint
                    // turns the save into a raw 500 instead of a clean validation error.
                    if (prev.some((m) => m.person_id === p.id)) return prev;
                    return [
                      ...prev,
                      {
                        person_id: p.id,
                        full_name: p.full_name,
                        dob: p.dob,
                        gender: p.gender,
                        squad_number: null,
                        default_position_key: null,
                        is_captain: false,
                        roles: [],
                      },
                    ];
                  });
                  setDirty(true);
                }}
                className={`rounded-full border px-2 py-0.5 text-xs hover:border-purple-300 ${
                  onOther.length > 0
                    ? "border-amber-300 text-amber-700"
                    : "border-slate-200 text-slate-500"
                }`}
              >
                + {p.full_name}
                {onOther.length > 0 && " ⚠"}
              </button>
            );
          })}
          <div className="flex-1" />
          <button
            type="button"
            disabled={busy || !dirty}
            onClick={() => onSave(members)}
            className="btn btn-primary px-3 py-1 text-xs"
          >
            Save roster
          </button>
        </div>
      )}
    </div>
  );
}
