// planImport (Jul3/01 §3–§4) — the pure half of the import pipeline: a
// deterministic diff from (rows, snapshot, config) to an ImportPlan. Total:
// never throws — every problem becomes an ImportIssue. Writes nothing; the
// app executes the plan's ops in bucket order (clubs → teams → persons →
// entrants → rosters, Jul3/01 §9), resolving synthetic refs → uuids.
import type {
  ImportConfig,
  ImportIssue,
  ImportOp,
  ImportPlan,
  ImportRow,
  ImportSnapshot,
  ImportTarget,
} from "./types.ts";

// Jul3/01 §4: all name matching happens on lower(btrim(name)).
export function fold(s: string): string {
  return s.trim().toLowerCase();
}

type ClubCreateOp = Extract<ImportOp, { kind: "club.create" }>;
type ClubUpdateOp = Extract<ImportOp, { kind: "club.update" }>;
type TeamCreateOp = Extract<ImportOp, { kind: "team.create" }>;
type TeamLinkOp = Extract<ImportOp, { kind: "team.link" }>;
type PersonCreateOp = Extract<ImportOp, { kind: "person.create" }>;
type EntrantCreateOp = Extract<ImportOp, { kind: "entrant.create" }>;
type RosterAddOp = Extract<ImportOp, { kind: "roster.add" }>;
type SquadAddOp = Extract<ImportOp, { kind: "squad.add" }>;

// A resolved entity within one planning run: either an existing row (id) or
// an op emitted earlier in this same plan (ref).
type Resolved = { target: ImportTarget; key: string };

function targetKey(t: ImportTarget): string {
  return "id" in t ? `id:${t.id}` : `ref:${t.ref}`;
}

function blank(s: string | undefined): boolean {
  return s === undefined || s.trim() === "";
}

export function planImport(
  rows: ImportRow[],
  snapshot: ImportSnapshot,
  config: ImportConfig,
): ImportPlan {
  const issues: ImportIssue[] = [];

  // Op buckets — concatenated in ref-dependency order (Jul3/01 §9).
  const clubCreates = new Map<string, ClubCreateOp>();
  const clubUpdates = new Map<string, ClubUpdateOp>();
  const teamCreates = new Map<string, TeamCreateOp>();
  const teamLinks = new Map<string, TeamLinkOp>();
  const personCreates = new Map<string, PersonCreateOp>();
  const entrantCreates = new Map<string, EntrantCreateOp>();
  const rosterAdds = new Map<string, RosterAddOp>();
  const squadAdds = new Map<string, SquadAddOp>();

  // --- snapshot indexes (built once; deterministic by construction) --------
  const clubByExtRef = new Map<string, ImportSnapshot["clubs"][number]>();
  const clubByName = new Map<string, ImportSnapshot["clubs"][number]>();
  for (const c of snapshot.clubs) {
    if (c.externalRef !== null) clubByExtRef.set(c.externalRef, c);
    clubByName.set(fold(c.name), c);
  }
  // Jul3/01 §4 team identity: (club_id, folded name); clubless teams keyed on
  // the org alone (clubId '').
  //
  // The composite Map keys below join on US (0x1f), written as the ESCAPE
  // `\x1f` and never as a literal byte. This file previously used a literal NUL,
  // which made it BINARY to git — its last commit reads `Bin 15911 -> 16404
  // bytes, 0 insertions(+), 0 deletions(-)`, so no reviewer has ever seen a
  // line of it change, and `git grep` answered "Binary file … matches" with
  // every line suppressed. `test/source-bytes.test.ts` now gates that.
  const teamByKey = new Map<string, ImportSnapshot["teams"][number]>();
  for (const t of snapshot.teams) {
    teamByKey.set(`${t.clubId ?? ""}\x1f${fold(t.name)}`, t);
  }
  // Person candidates: snapshot people PLUS creates pending in this plan —
  // matching against pending rows is what keeps one file from minting the
  // same person twice and keeps re-planning idempotent (Jul3/01 §4).
  type PersonCandidate = { target: ImportTarget; key: string; dob: string | null };
  const personsByName = new Map<string, PersonCandidate[]>();
  for (const p of snapshot.persons) {
    const k = fold(p.fullName);
    const list = personsByName.get(k) ?? [];
    list.push({ target: { id: p.id }, key: `id:${p.id}`, dob: p.dob });
    personsByName.set(k, list);
  }
  for (const list of personsByName.values())
    list.sort((a, b) => (a.key < b.key ? -1 : 1));
  const divisionBySlug = new Map(snapshot.divisions.map((d) => [d.slug, d]));
  // Jul3/01 §4 division match: the Division column instructions never tell
  // users to type a slug — they see the display name everywhere else in the
  // console — so a fold(name) match is tried alongside the exact slug match
  // (pinned imports still address by slug, doc 08 §3).
  const divisionByName = new Map(snapshot.divisions.map((d) => [fold(d.name), d]));
  const entrantByTeam = new Map<string, ImportSnapshot["entrants"][number]>();
  // Existing TEAM-squad memberships, the `memberships` set's sibling one level
  // up: re-planning a committed file must emit zero `squad.add` ops.
  const squadMemberships = new Set<string>();
  for (const t of snapshot.teams) {
    for (const pid of t.memberPersonIds) squadMemberships.add(`${t.id}\x1f${pid}`);
  }
  const memberships = new Set<string>();
  for (const e of snapshot.entrants) {
    if (e.teamId !== null) entrantByTeam.set(`${e.divisionId}\x1f${e.teamId}`, e);
    for (const pid of e.memberPersonIds) memberships.add(`${e.id}\x1f${pid}`);
  }

  // --- per-row resolution ---------------------------------------------------

  // Jul3/01 §4 club match: external_ref first, else folded name. Miss ⇒
  // club.create; hit with a differing supplied short_name ⇒ club.update
  // (blanks never overwrite). logo_path is never set by row import (§5).
  function resolveClub(row: ImportRow): Resolved | null | "error" {
    const hasRef = !blank(row.clubExternalRef);
    const hasName = !blank(row.clubName);
    if (!hasRef && !hasName) return null;
    const existing =
      (hasRef ? clubByExtRef.get(row.clubExternalRef!.trim()) : undefined) ??
      (hasName ? clubByName.get(fold(row.clubName!)) : undefined);
    if (existing) {
      if (!blank(row.clubShortName) && row.clubShortName!.trim() !== existing.shortName) {
        const key = `club:${existing.id}`;
        const prev = clubUpdates.get(key);
        if (prev) prev.sourceRows.push(row.rowNo);
        else
          clubUpdates.set(key, {
            kind: "club.update",
            ref: key,
            clubId: existing.id,
            before: { shortName: existing.shortName },
            after: { shortName: row.clubShortName!.trim() },
            sourceRows: [row.rowNo],
          });
      }
      return { target: { id: existing.id }, key: `id:${existing.id}` };
    }
    if (!hasName) {
      issues.push({
        rowNo: row.rowNo,
        column: "clubExternalRef",
        severity: "error",
        code: "CLUB_NAME_MISSING",
        message: `no club named for external ref '${row.clubExternalRef}' and no existing match`,
      });
      return "error";
    }
    const ref = `club:${fold(row.clubName!)}`;
    const pending = clubCreates.get(ref);
    if (pending) {
      pending.sourceRows.push(row.rowNo);
      // enrich a sparse earlier create — never overwrite with blanks
      if (pending.after.shortName === undefined && !blank(row.clubShortName))
        pending.after.shortName = row.clubShortName!.trim();
      if (pending.after.externalRef === undefined && hasRef)
        pending.after.externalRef = row.clubExternalRef!.trim();
    } else {
      clubCreates.set(ref, {
        kind: "club.create",
        ref,
        after: {
          name: row.clubName!.trim(),
          ...(blank(row.clubShortName) ? {} : { shortName: row.clubShortName!.trim() }),
          ...(hasRef ? { externalRef: row.clubExternalRef!.trim() } : {}),
        },
        sourceRows: [row.rowNo],
      });
    }
    return { target: { ref }, key: `ref:${ref}` };
  }

  // Jul3/01 §4 team identity (club, folded name); an existing clubless team
  // with a club now supplied ⇒ team.link.
  function resolveTeam(row: ImportRow, club: Resolved | null): Resolved | null {
    if (blank(row.teamName)) return null;
    const nameKey = fold(row.teamName!);
    const clubId = club && "id" in club.target ? club.target.id : null;
    // exact identity hit
    if (club === null || clubId !== null) {
      const existing = teamByKey.get(`${clubId ?? ""}\x1f${nameKey}`);
      if (existing) return { target: { id: existing.id }, key: `id:${existing.id}` };
    }
    // clubless team + club now supplied ⇒ link, not create
    if (club !== null) {
      const clubless = teamByKey.get(`\x1f${nameKey}`);
      if (clubless) {
        const key = `team:${clubless.id}`;
        const prev = teamLinks.get(key);
        if (prev) prev.sourceRows.push(row.rowNo);
        else
          teamLinks.set(key, {
            kind: "team.link",
            ref: key,
            teamId: clubless.id,
            club: club.target,
            sourceRows: [row.rowNo],
          });
        return { target: { id: clubless.id }, key: `id:${clubless.id}` };
      }
    }
    const ref = `team:${club ? club.key : "-"}/${nameKey}`;
    const pending = teamCreates.get(ref);
    if (pending) {
      pending.sourceRows.push(row.rowNo);
      if (pending.after.shortName === undefined && !blank(row.teamShortName))
        pending.after.shortName = row.teamShortName!.trim();
    } else {
      teamCreates.set(ref, {
        kind: "team.create",
        ref,
        after: {
          name: row.teamName!.trim(),
          ...(blank(row.teamShortName) ? {} : { shortName: row.teamShortName!.trim() }),
          ...(club ? { club: club.target } : {}),
        },
        sourceRows: [row.rowNo],
      });
    }
    return { target: { ref }, key: `ref:${ref}` };
  }

  // Jul3/01 §4 person match: identity is exactly (folded full_name, dob-or-
  // null) — a no-dob row only ever matches a dob-less person. Anything
  // count-based ("match when exactly one candidate") is NOT idempotent: a
  // commit changes the candidate count, so the same row would resolve
  // differently on re-plan. Same-name people the row cannot address are
  // surfaced as AMBIGUOUS_PERSON (strict ⇒ error, resolve via the persons
  // merge endpoint doc 08 §3; lenient ⇒ warn + the deterministic action).
  function resolvePerson(row: ImportRow): Resolved | null | "error" {
    if (blank(row.playerFullName)) return null;
    const nameKey = fold(row.playerFullName!);
    const candidates = personsByName.get(nameKey) ?? [];
    const ambiguous = (): "error" | null => {
      if (config.personMatch === "strict") {
        issues.push({
          rowNo: row.rowNo,
          column: "playerFullName",
          severity: "error",
          code: "AMBIGUOUS_PERSON",
          message: `${candidates.length} existing people match '${row.playerFullName}' — add a DOB or merge duplicates first`,
        });
        return "error";
      }
      issues.push({
        rowNo: row.rowNo,
        column: "playerFullName",
        severity: "warn",
        code: "AMBIGUOUS_PERSON",
        message: `${candidates.length} existing people match '${row.playerFullName}' — add a DOB to be safe`,
      });
      return null;
    };
    if (row.dob !== undefined) {
      const hit = candidates.find((p) => p.dob === row.dob);
      if (hit) return { target: hit.target, key: hit.key };
      // no identity hit ⇒ a new (name, dob) person — always distinguishable
    } else {
      const dobless = candidates.filter((p) => p.dob === null);
      if (dobless.length === 1 && candidates.length === 1) {
        return { target: dobless[0]!.target, key: dobless[0]!.key };
      }
      if (dobless.length >= 1) {
        // dob'd namesakes exist (or duplicate dob-less people): warn, then
        // match the first dob-less candidate deterministically.
        if (ambiguous() === "error") return "error";
        return { target: dobless[0]!.target, key: dobless[0]!.key };
      }
      if (candidates.length >= 1) {
        // only dob'd namesakes — this row cannot address them; a new dob-less
        // person is distinguishable, so creating stays idempotent.
        if (ambiguous() === "error") return "error";
      }
    }
    const ref = `person:${nameKey}|${row.dob ?? ""}`;
    const pending = personCreates.get(ref);
    if (pending) pending.sourceRows.push(row.rowNo);
    else {
      const list = personsByName.get(nameKey) ?? [];
      list.push({ target: { ref }, key: `ref:${ref}`, dob: row.dob ?? null });
      personsByName.set(nameKey, list);
      personCreates.set(ref, {
        kind: "person.create",
        ref,
        after: {
          fullName: row.playerFullName!.trim(),
          ...(row.dob !== undefined ? { dob: row.dob } : {}),
          ...(row.gender !== undefined ? { gender: row.gender } : {}),
          // doc 06 §4.7: consent defaults false; minorConsentDefault lets the
          // organiser attest bulk consent for names.
          consent: { public_name: config.minorConsentDefault, public_photo: false },
        },
        sourceRows: [row.rowNo],
      });
    }
    return { target: { ref }, key: `ref:${ref}` };
  }

  for (const row of rows) {
    const club = resolveClub(row);
    if (club === "error") continue;
    const team = resolveTeam(row, club);
    const person = resolvePerson(row);

    // A row naming both a team and a player is a statement about that team's
    // SQUAD, whether or not it also places the team in a division. Emitted
    // here, before the division branch below, so a directory-only file
    // ("Club,Team,Player", no Division) produces it too — that file used to
    // create the person and the team and nothing joining them.
    // Filled in below only if this row's own division validates a position:
    // the squad has no catalog of its own, so the ONLY position a squad.add
    // may carry is one already checked against a real division.
    let squadOpForRow: SquadAddOp | undefined;
    if (team !== null && person !== null && person !== "error") {
      const already =
        "id" in team.target &&
        "id" in person.target &&
        squadMemberships.has(`${team.target.id}\x1f${person.target.id}`);
      if (!already) {
        const key = `${targetKey(team.target)}\x1f${targetKey(person.target)}`;
        const pending = squadAdds.get(key);
        if (pending) {
          pending.sourceRows.push(row.rowNo);
          squadOpForRow = pending;
        } else {
          const op: SquadAddOp = {
            kind: "squad.add",
            team: team.target,
            person: person.target,
            after: {
              ...(row.squadNumber !== undefined ? { squadNumber: row.squadNumber } : {}),
              isCaptain: row.isCaptain ?? false,
            },
            sourceRows: [row.rowNo],
          };
          squadAdds.set(key, op);
          squadOpForRow = op;
        }
      }
    }
    // A Position on a row that names no division has nothing to validate it:
    // team_members.default_position_key would take whatever the file said.
    // Warn rather than drop it silently — the column is otherwise ignored
    // with no trace, which is how a typo becomes an invisible no-op.
    if (!blank(row.position) && blank(row.divisionSlug)) {
      issues.push({
        rowNo: row.rowNo,
        column: "position",
        severity: "warn",
        code: "POSITION_WITHOUT_DIVISION",
        message: `position '${row.position}' is ignored — this row names no division, so there is no position catalog to check it against`,
      });
    }

    // Jul3/01 §4: a row with divisionSlug places the team into that division.
    if (!blank(row.divisionSlug)) {
      const raw = row.divisionSlug!.trim();
      const division = divisionBySlug.get(raw) ?? divisionByName.get(fold(raw));
      if (!division) {
        // Import never creates divisions — unknown slug/name is an error and
        // NEVER an entrant/roster op (Jul3/01 §4).
        issues.push({
          rowNo: row.rowNo,
          column: "divisionSlug",
          severity: "error",
          code: "DIVISION_NOT_FOUND",
          message: `division '${row.divisionSlug}' does not exist — create divisions before importing`,
          messageArgs: { division: row.divisionSlug! },
        });
        continue;
      }
      if (team === null) {
        issues.push({
          rowNo: row.rowNo,
          column: "teamName",
          severity: "error",
          code: "TEAM_REQUIRED",
          message: "a division placement needs a team column on the row",
        });
        continue;
      }
      // find-or-create entrant(kind='team') in the division
      let entrant: Resolved;
      const existingEntrant =
        "id" in team.target
          ? entrantByTeam.get(`${division.id}\x1f${team.target.id}`)
          : undefined;
      if (existingEntrant) {
        entrant = { target: { id: existingEntrant.id }, key: `id:${existingEntrant.id}` };
      } else {
        const ref = `entrant:${division.slug}/${team.key}`;
        const pending = entrantCreates.get(ref);
        if (pending) pending.sourceRows.push(row.rowNo);
        else
          entrantCreates.set(ref, {
            kind: "entrant.create",
            ref,
            divisionId: division.id,
            after: {
              kind: "team",
              team: team.target,
              displayName: (blank(row.entrantDisplayName)
                ? row.teamName!
                : row.entrantDisplayName!
              ).trim(),
            },
            sourceRows: [row.rowNo],
          });
        entrant = { target: { ref }, key: `ref:${ref}` };
      }

      if (person !== null && person !== "error") {
        // position validated vs the division's position_catalog (doc 02 §3)
        let positionKey: string | undefined;
        if (!blank(row.position)) {
          const hit = division.positionKeys.find((k) => fold(k) === fold(row.position!));
          if (hit === undefined) {
            issues.push({
              rowNo: row.rowNo,
              column: "position",
              severity: "error",
              code: "BAD_POSITION",
              message: `position '${row.position}' is not in the ${division.sportKey} position catalog`,
            });
            continue;
          }
          positionKey = hit;
          // The same validated key lands on the persistent squad, so a file
          // with a Division sets team_members.default_position_key too — the
          // squad op is emitted above, before this branch, and patched here
          // rather than re-derived. First row to carry a position wins; a
          // later row for the same pair does not overwrite it.
          if (squadOpForRow && squadOpForRow.after.positionKey === undefined) {
            squadOpForRow.after.positionKey = hit;
          }
        }
        // roster idempotence: an existing member of an existing entrant is a no-op
        if (
          "id" in entrant.target &&
          "id" in person.target &&
          memberships.has(`${entrant.target.id}\x1f${person.target.id}`)
        ) {
          continue;
        }
        const key = `${targetKey(entrant.target)}\x1f${targetKey(person.target)}`;
        const pending = rosterAdds.get(key);
        if (pending) pending.sourceRows.push(row.rowNo);
        else
          rosterAdds.set(key, {
            kind: "roster.add",
            entrant: entrant.target,
            person: person.target,
            after: {
              ...(row.squadNumber !== undefined ? { squadNumber: row.squadNumber } : {}),
              ...(positionKey !== undefined ? { positionKey } : {}),
              isCaptain: row.isCaptain ?? false,
            },
            sourceRows: [row.rowNo],
          });
      }
    }
  }

  const ops: ImportOp[] = [
    ...clubCreates.values(),
    ...clubUpdates.values(),
    ...teamCreates.values(),
    ...teamLinks.values(),
    ...personCreates.values(),
    ...squadAdds.values(),
    ...entrantCreates.values(),
    ...rosterAdds.values(),
  ];
  return {
    ops,
    stats: {
      clubs: clubCreates.size + clubUpdates.size,
      teams: teamCreates.size + teamLinks.size,
      persons: personCreates.size,
      entrants: entrantCreates.size,
      rosters: rosterAdds.size,
      squads: squadAdds.size,
    },
    issues,
  };
}
