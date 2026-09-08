// _discipline-routes.ts — the discipline surface `runTinySuite`'s T5b-3 step
// drives, modelled as a STATEFUL fake so a POST is visible to the GET that
// follows it and a written team sheet is visible to the read-back.
//
// Shared by `tiny-suite.test.ts` and `tiny-suite-simulate.test.ts` for the
// same reason `_oracle-routes.ts` is: four separate `sql`-passing fakes would
// otherwise each have to model five routes, and three of them would drift.
//
// It models the product's REAL two-step, because that is the thing under
// test (`usecases/discipline.ts`): a created row is `pending` with no
// `entrantId` and no `decidedAt`, and ONLY `PATCH {kind:"confirm"}` makes it
// `active` and stamps the entrant. A fake that returned `active` from the
// POST would let a suite that forgot to confirm still pass.
//
// The lineup routes ACCEPT a banned player, deliberately — that is what the
// product does (`putLineup` never reads the `suspensions` table), and a fake
// that refused would make the bench's enforcement probe report a gate this
// product does not have.
import type { RawResult } from "../http.ts";

export interface SuspensionRowLike {
  id: string;
  divisionId: string;
  personId: string;
  personName: string;
  entrantId: string | null;
  status: string;
  source: string;
  reason: string;
  matchesTotal: number;
  matchesServed: number;
}

export interface DisciplineRoutesWorld {
  /** `undefined` for any method/path this world does not own, so a caller
   *  chains it before its own branches. */
  handle(method: string, path: string, body: unknown): RawResult | undefined;
  /** Every suspension this world was asked to create, in creation order. */
  readonly created: readonly SuspensionRowLike[];
  /** `${fixtureId}|${entrantId}` -> the person ids last written. */
  readonly sheets: ReadonlyMap<string, readonly string[]>;
}

export function makeDisciplineRoutesWorld(input: {
  /** What `decideSuspension`'s confirm branch resolves from `entrant_members`
   *  — the person's entrant in THIS division. */
  entrantForPerson(divisionId: string, personId: string): string | undefined;
  personName?(personId: string): string | undefined;
  /** Test seam: bend the active-ban list the division read returns. Used to
   *  model a product that bans everybody, or one that bans nobody. */
  interceptActive?(rows: SuspensionRowLike[]): SuspensionRowLike[];
  /** Test seam: bend a stored team sheet on the way out. Used to model a ban
   *  that reached a fixture the pack does not name, or one that reached none. */
  interceptSheet?(fixtureId: string, entrantId: string, personIds: string[]): string[];
}): DisciplineRoutesWorld {
  const rows: SuspensionRowLike[] = [];
  const sheets = new Map<string, string[]>();
  let nextId = 1;

  return {
    created: rows,
    sheets,
    handle(method, path, body) {
      const createMatch = /^\/api\/v1\/divisions\/([^/?]+)\/suspensions$/.exec(path);
      if (method === "POST" && createMatch !== null) {
        const divisionId = createMatch[1]!;
        const b = body as { person_id?: string; matches_total?: number; reason?: string };
        const personId = b?.person_id ?? "";
        const row: SuspensionRowLike = {
          id: `sus-${nextId++}`,
          divisionId,
          personId,
          personName: input.personName?.(personId) ?? personId,
          // pending: NOT stamped. The product stamps at confirm, not here.
          entrantId: null,
          status: "pending",
          source: "manual",
          reason: b?.reason ?? "",
          matchesTotal: b?.matches_total ?? 0,
          matchesServed: 0,
        };
        rows.push(row);
        return { status: 201, json: { ok: true, data: { ...row } } };
      }

      const decideMatch = /^\/api\/v1\/suspensions\/([^/?]+)$/.exec(path);
      if (method === "PATCH" && decideMatch !== null) {
        const row = rows.find((r) => r.id === decideMatch[1]);
        if (row === undefined) {
          // `RawJson.error` is typed `string` in http.ts while the real v1
          // envelope carries `{code,message}` (which is why `oracle.ts`'s
          // `errorOf` re-casts it). Cast here rather than "fix" that type —
          // widening it is a lib change this task does not own.
          return {
            status: 404,
            json: { ok: false, error: { code: "NOT_FOUND", message: "suspension not found" } },
          } as unknown as RawResult;
        }
        const kind = (body as { kind?: string } | null)?.kind;
        if (kind === "confirm") {
          row.status = "active";
          row.entrantId = input.entrantForPerson(row.divisionId, row.personId) ?? null;
        } else if (kind === "waive") {
          row.status = "waived";
        }
        return { status: 200, json: { ok: true, data: { ...row } } };
      }

      const listMatch = /^\/api\/v1\/divisions\/([^/?]+)\/suspensions\?status=active$/.exec(path);
      if (method === "GET" && listMatch !== null) {
        const divisionId = listMatch[1];
        const live = rows.filter((r) => r.divisionId === divisionId && r.status === "active");
        const served = input.interceptActive?.(live.map((r) => ({ ...r }))) ?? live.map((r) => ({ ...r }));
        return { status: 200, json: { ok: true, data: served } };
      }

      const lineupMatch = /^\/api\/v1\/fixtures\/([^/?]+)\/lineups\/([^/?]+)$/.exec(path);
      if (lineupMatch !== null) {
        const fixtureId = lineupMatch[1]!;
        const entrantId = lineupMatch[2]!;
        const key = `${fixtureId}|${entrantId}`;
        if (method === "PUT") {
          const slots = ((body as { slots?: { person_id?: string }[] } | null)?.slots ?? [])
            .map((sl) => sl.person_id ?? "")
            .filter((id) => id !== "");
          // REPLACE, exactly as `putLineup` does (it deletes the entrant's
          // rows before inserting). A merge here would hide a bench step that
          // wrote the wrong sheet second.
          sheets.set(key, slots);
          return {
            status: 200,
            json: {
              ok: true,
              data: {
                fixture_id: fixtureId,
                entrant_id: entrantId,
                slots: slots.map((person_id) => ({
                  person_id,
                  full_name: input.personName?.(person_id) ?? person_id,
                })),
                warnings: [],
              },
            },
          };
        }
        if (method === "GET") {
          const stored = sheets.get(key) ?? [];
          const out = input.interceptSheet?.(fixtureId, entrantId, [...stored]) ?? [...stored];
          return {
            status: 200,
            json: {
              ok: true,
              data: {
                fixture_id: fixtureId,
                entrant_id: entrantId,
                slots: out.map((person_id) => ({
                  person_id,
                  full_name: input.personName?.(person_id) ?? person_id,
                })),
              },
            },
          };
        }
      }
      return undefined;
    },
  };
}
