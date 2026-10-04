// B07a Task 10 fix round 2 — R62: a tapped fixture's team sheets are SETUP.
//
// Player-attributed pad scoring needs a SAVED LINEUP. The v3 pad builds its
// squads only from `lineups` rows (`registry.tsx` `slots: side.lineup.map`,
// the device page's `getLineup`), so with no sheet there is no sole-player
// stamp and no person chip, and a pack event naming a person cannot be tapped
// (live run 2, F1). Setup stays API (owner ruling), so the sheet is written
// through the real lineups route — `PUT /api/v1/fixtures/{id}/lineups/{entrantId}`,
// `usecases/fixtures.ts#putLineup` — with the organiser session, before the
// scorer is handed anything.
//
// Built from each side's OWN seeded members (the pack's `entrants[].roster`,
// which is what the bench seeds into `entrant_members`) — never an invented
// person, never another entrant's. `putLineup` refuses a non-member with 422,
// and that refusal comes back here as a finding.
//
// A pack event naming a person who is not a seeded member of its `by` entrant
// is a FINDING (`personOutsideByEntrantFindings`): no saved sheet can put them
// on the pad, and `person` is never added to a tolerated allowlist instead.
import type { Session } from "./http.ts";
import { putFixtureLineup, type OracleTransport } from "./oracle.ts";
import type { Pack, PackStream } from "./pack-schema.ts";

export interface TapLineupSide {
  readonly side: "home" | "away";
  readonly entrantRef: string;
  readonly personRefs: readonly string[];
}

/** The entrant's seeded members, in roster order. `[]` for an entrant the
 *  pack does not declare. */
export function seededMemberRefs(pack: Pick<Pack, "entrants">, entrantRef: string): readonly string[] {
  const entrant = pack.entrants.find((e) => e.ref === entrantRef);
  return entrant === undefined ? [] : entrant.roster.map((member) => member.person);
}

/** One sheet per side, each from THAT side's entrant as the stream declares it. */
export function tapLineupSides(
  pack: Pick<Pack, "entrants">,
  stream: Pick<PackStream, "home" | "away">,
): readonly TapLineupSide[] {
  return [
    { side: "home", entrantRef: stream.home, personRefs: seededMemberRefs(pack, stream.home) },
    { side: "away", entrantRef: stream.away, personRefs: seededMemberRefs(pack, stream.away) },
  ];
}

function sigilRef(value: unknown): string | undefined {
  return typeof value === "string" && value.startsWith("@") ? value.slice(1) : undefined;
}

export function personOutsideByEntrantFindings(
  pack: Pick<Pack, "entrants">,
  stream: Pick<PackStream, "events">,
): readonly string[] {
  const findings: string[] = [];
  stream.events.forEach((event, i) => {
    const payload = event.payload;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return;
    const fields = payload as Record<string, unknown>;
    const byRef = sigilRef(fields.by);
    const personRef = sigilRef(fields.person);
    if (byRef === undefined || personRef === undefined) return;
    if (seededMemberRefs(pack, byRef).includes(personRef)) return;
    findings.push(
      `lineup: event ${i} (${event.type}) names person "${personRef}", who is not a seeded member of its by ` +
        `entrant "${byRef}" — no saved team sheet can put them on the pad`,
    );
  });
  return findings;
}

export interface SaveTapLineupsInput {
  readonly base: string;
  readonly session: Session;
  readonly fixtureId: string;
  readonly sides: readonly TapLineupSide[];
  readonly entrantIdByRef: ReadonlyMap<string, string>;
  readonly personIdByRef: ReadonlyMap<string, string>;
  readonly transport?: OracleTransport | undefined;
}

/** Writes each side's sheet and returns findings — never throws on a refusal.
 *
 *  A side with no seeded members writes nothing and reports nothing: there is
 *  no sheet to build, and any event that needed a person on that side is
 *  already a finding from `personOutsideByEntrantFindings`. A side with an
 *  unresolved entrant or member is never written half-built — a partial sheet
 *  would silently leave a player off the pad. */
export async function saveTapLineups(input: SaveTapLineupsInput): Promise<readonly string[]> {
  const findings: string[] = [];
  for (const side of input.sides) {
    if (side.personRefs.length === 0) continue;
    const entrantId = input.entrantIdByRef.get(side.entrantRef);
    if (entrantId === undefined) {
      findings.push(`lineup: the ${side.side} entrant "${side.entrantRef}" has no seeded id — its team sheet was not saved`);
      continue;
    }
    const unresolved = side.personRefs.filter((ref) => !input.personIdByRef.has(ref));
    if (unresolved.length > 0) {
      findings.push(
        `lineup: the ${side.side} sheet for "${side.entrantRef}" names member(s) with no seeded id: ` +
          `${unresolved.map((ref) => `"${ref}"`).join(", ")} — the sheet was not saved half-built`,
      );
      continue;
    }
    const personIds = side.personRefs.map((ref) => input.personIdByRef.get(ref) as string);
    const { status, code } = await putFixtureLineup(
      input.base,
      input.session,
      input.fixtureId,
      entrantId,
      personIds,
      input.transport,
    );
    if (status < 200 || status >= 300) {
      findings.push(
        `lineup: saving the ${side.side} sheet for "${side.entrantRef}" answered HTTP ${status} ${code ?? "(no code)"} ` +
          "— its players cannot be named on the pad",
      );
    }
  }
  return findings;
}
