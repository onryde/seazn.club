// B07a Task 10 fix round 2 — R64. A pack's `state` claim describes the STREAM's
// end state, so it is judged on the product's own ledger rows through the last
// pack event — never after the core.finalize the tap path appends as the
// organiser's sign-off. Phase equality stays exact.
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import type { RawResult, Session } from "../http.ts";
import type { LedgerRow } from "../ledger.ts";
import { PackSchema } from "../pack-schema.ts";
import { TINY_PACK_PATH } from "../suites/tiny.ts";
import { bootRegistry, resolveDivisionCfg } from "../validate-pack.ts";
import {
  foldRows,
  lineupPairFromSheets,
  rowsThroughPackEvents,
  specialStateThroughPackEvents,
} from "../special-state.ts";

function row(seq: number, type: string, payload: unknown = {}): LedgerRow {
  return { id: `ev-${seq}`, seq, type, payload };
}

async function dTinyModuleAndCfg() {
  const pack = PackSchema.parse(JSON.parse(await readFile(TINY_PACK_PATH, "utf8")));
  const division = pack.divisions.find((d) => d.ref === "d-tiny");
  if (division === undefined) throw new Error("test: _tiny has no d-tiny");
  const module = bootRegistry().get(division.sportKey, division.moduleVersion);
  const resolved = resolveDivisionCfg(module, division);
  if (!resolved.ok) throw new Error(`test: d-tiny cfg did not resolve (${resolved.reason})`);
  return { module, cfg: resolved.cfg };
}

const SHEETS = {
  home: [{ person_id: "id-ana", slot: "starting", order_no: 1 }],
  away: [{ person_id: "id-bo", slot: "starting", order_no: 1 }],
};

describe("rowsThroughPackEvents — the rows a pack claim describes (R64)", () => {
  it("drops the trailing core.finalize the tap path appended as its sign-off", () => {
    const cut = rowsThroughPackEvents(
      [row(1, "core.start"), row(2, "core.forfeit"), row(3, "core.finalize")],
      ["core.start", "core.forfeit"],
    );
    expect(cut.rows.map((r) => r.seq)).toEqual([1, 2]);
    expect(cut.signOffRows).toBe(1);
  });

  it("keeps every row when nothing was signed off", () => {
    const cut = rowsThroughPackEvents([row(1, "core.start"), row(2, "generic.result")], ["core.start", "generic.result"]);
    expect(cut.rows.map((r) => r.seq)).toEqual([1, 2]);
    expect(cut.signOffRows).toBe(0);
  });

  it("a lost pack event does not move the cut — only the sign-off is dropped", () => {
    const cut = rowsThroughPackEvents(
      [row(1, "core.start"), row(2, "generic.score"), row(3, "generic.result"), row(4, "core.finalize")],
      ["core.start", "generic.score", "generic.score", "generic.result"],
    );
    expect(cut.rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(cut.signOffRows).toBe(1);
  });

  it("never drops a core.finalize the pack itself declares", () => {
    const cut = rowsThroughPackEvents(
      [row(1, "core.start"), row(2, "core.forfeit"), row(3, "core.finalize")],
      ["core.start", "core.forfeit", "core.finalize"],
    );
    expect(cut.rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(cut.signOffRows).toBe(0);
  });
});

describe("lineupPairFromSheets — the product's own buildLineup (engine-db/lineups.ts), mirrored", () => {
  it("maps stored slots exactly as the product's fold does", () => {
    const pair = lineupPairFromSheets(
      "h",
      [
        { person_id: "p1", slot: "starting", order_no: null, position_key: "gk", roles: ["captain"], role: "player", squad_number: 7 },
        { person_id: "p2", slot: "bench", order_no: 5, position_key: null, roles: [], role: "coach", squad_number: null },
      ],
      "a",
      [],
    );
    expect(pair).toEqual({
      home: {
        entrantId: "h",
        slots: [
          { personId: "p1", slot: "starting", orderNo: 1, positionKey: "gk", roles: ["captain"], squadNumber: 7 },
          { personId: "p2", slot: "bench", orderNo: 5, role: "coach" },
        ],
      },
      away: { entrantId: "a", slots: [] },
    });
  });
});

describe("foldRows — the real engine fold over product ledger rows (R64)", () => {
  it("rr-r3's pack rows fold to phase done; the same ledger WITH the sign-off folds to final", async () => {
    const { module, cfg } = await dTinyModuleAndCfg();
    const lineups = lineupPairFromSheets("id-alpha", SHEETS.home, "id-bravo", SHEETS.away);
    const packRows = [row(1, "core.start"), row(2, "core.forfeit", { by: "id-bravo", reason: "retired hurt" })];
    expect((foldRows(module, cfg, lineups, "fx-3", packRows) as { phase: string }).phase).toBe("done");
    // Control: the fold does see a sign-off, so dropping it is what the cut is for.
    expect((foldRows(module, cfg, lineups, "fx-3", [...packRows, row(3, "core.finalize")]) as { phase: string }).phase).toBe(
      "final",
    );
  });
});

describe("specialStateThroughPackEvents — reads the ledger and both sheets, never /state (R64)", () => {
  it("folds the product's rows through the last pack event, and reports the sign-off rows it dropped", async () => {
    const { module, cfg } = await dTinyModuleAndCfg();
    const paths: string[] = [];
    const wire = (seq: number, type: string, payload: unknown) => ({
      id: `ev-${seq}`,
      seq,
      type,
      payload,
      recorded_at: "2026-09-14T19:50:0" + seq + ".000Z",
      recorded_by: "user-1",
      voids_event_id: null,
      device_link_id: null,
    });
    const transport = {
      async raw(_b: string, _s: Session, path: string): Promise<RawResult> {
        paths.push(path);
        if (path === "/api/v1/fixtures/fx-3/events?since_seq=0") {
          return {
            status: 200,
            json: {
              ok: true,
              data: [
                wire(1, "core.start", {}),
                wire(2, "core.forfeit", { by: "id-bravo", reason: "retired hurt" }),
                wire(3, "core.finalize", {}),
              ],
            },
          } as unknown as RawResult;
        }
        const sheet = /^\/api\/v1\/fixtures\/fx-3\/lineups\/(id-alpha|id-bravo)$/.exec(path);
        if (sheet !== null) {
          const slots = sheet[1] === "id-alpha" ? SHEETS.home : SHEETS.away;
          return { status: 200, json: { ok: true, data: { fixture_id: "fx-3", entrant_id: sheet[1], slots } } } as unknown as RawResult;
        }
        throw new Error(`test transport: unexpected ${path}`);
      },
    };
    const out = await specialStateThroughPackEvents({
      base: "http://bench.example",
      session: {} as Session,
      fixtureId: "fx-3",
      homeEntrantId: "id-alpha",
      awayEntrantId: "id-bravo",
      packEventTypes: ["core.start", "core.forfeit"],
      module,
      cfg,
      transport,
    });
    expect((out.state as { phase: string }).phase).toBe("done");
    expect(out.signOffRows).toBe(1);
    expect(paths.sort()).toEqual(
      [
        "/api/v1/fixtures/fx-3/events?since_seq=0",
        "/api/v1/fixtures/fx-3/lineups/id-alpha",
        "/api/v1/fixtures/fx-3/lineups/id-bravo",
      ].sort(),
    );
  });
});
