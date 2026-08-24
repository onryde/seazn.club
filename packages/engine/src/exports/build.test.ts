// DocModel goldens (Jul3/06, PROMPT-26 acceptance): stable JSON, not pixels.
import { describe, expect, it } from "vitest";
import {
  buildAdmitTickets,
  buildAuditLedger,
  buildBracket,
  buildBracketDe,
  buildLadderPoster,
  buildOfficialsRota,
  buildPagePoster,
  buildParticipants,
  buildRoster,
  buildStandings,
  buildTimetable,
} from "./build.ts";
import { DocBranding, DocModel, type ExportFixture } from "./types.ts";
import { volleyball } from "../sports/setbased/volleyball.ts";

const OPTS = { printedAt: "2026-07-20T09:00:00.000Z" };

const FIXTURES: ExportFixture[] = [
  { id: "f1", at: "2026-07-20T09:00:00Z", court: "Court 1", stageName: "Preliminary", round: 1, home: "A", away: "B" },
  { id: "f2", at: "2026-07-20T09:30:00Z", court: "Court 2", stageName: "Preliminary", round: 1, home: "C", away: "D" },
  { id: "f3", at: null, court: "Court 1", stageName: "Knockout", round: 2, home: "Winner of SF1", away: "Winner of SF2" },
];

describe("buildDocModel goldens (Jul3/06 §2)", () => {
  it("timetable: prelim/KO headings, TBD feeds render labels, footer date input", () => {
    const model = buildTimetable("Summer Cup — Open", FIXTURES, {
      ...OPTS,
      footerNote: "printed 2026-07-20",
    });
    expect(DocModel.parse(model)).toBeTruthy();
    expect(model.meta.printedAt).toBe(OPTS.printedAt); // input, never Date.now()
    expect(model.sections.map((s) => s.subheading)).toEqual(["Preliminary", "Knockout"]);
    const ko = model.sections[1]!.table!.rows[0]!;
    expect(ko).toContain("Winner of SF1"); // unfinished tournament (§7)
    expect(ko[0]).toBe("TBD");
  });

  it("timetable pageBreaks=per_pitch: each court starts a new page", () => {
    const model = buildTimetable("Cup", FIXTURES, { ...OPTS, pageBreaks: "per_pitch" });
    const headings = model.sections.filter((s) => s.heading !== undefined).map((s) => s.heading);
    expect(headings).toEqual(["Court 1", "Court 2"]);
    expect(model.sections.some((s) => s.pageBreakBefore === true)).toBe(true);
  });

  it("landscape standings with metric columns", () => {
    const model = buildStandings(
      "Open — Standings",
      [
        { name: "A", played: 2, won: 2, drawn: 0, lost: 0, points: 6, metrics: { diff: 4, for: 5 } },
        { name: "B", played: 2, won: 0, drawn: 0, lost: 2, points: 0, metrics: { diff: -4, for: 1 } },
      ],
      { ...OPTS, landscape: true, metricColumns: ["for", "diff"] },
    );
    expect(model.sections[0]!.table).toEqual({
      columns: ["#", "Team", "P", "W", "D", "L", "for", "diff", "Pts"],
      rows: [
        [1, "A", 2, 2, 0, 0, 5, 4, 6],
        [2, "B", 2, 0, 0, 2, 1, -4, 0],
      ],
      landscape: true,
    });
  });

  it("roster form: sign-at-start table + signature blocks (13 May)", () => {
    const model = buildRoster(
      "Open — Rosters",
      [{ teamName: "U12", clubName: "Acme SC", players: [{ name: "Ada", dob: "2014-01-01", number: 7 }] }],
      OPTS,
    );
    expect(model.sections[0]).toMatchObject({
      heading: "Acme SC — U12",
      signatures: ["Team captain", "Official"],
    });
    expect(model.sections[0]!.table!.rows[0]).toEqual([7, "Ada", "2014-01-01", ""]);
  });

  it("participants keep Empty-Spot labels (30 Jan)", () => {
    const model = buildParticipants(
      "Participants",
      [{ club: "", team: "", division: "Open", entrant: "Empty Spot 3", player: "", number: null, position: "" }],
      OPTS,
    );
    expect(model.sections[0]!.table!.rows[0]).toContain("Empty Spot 3");
  });

  it("volleyball scoresheet: per-set point columns, signatures, two-per-page (12 Jun)", () => {
    const sections = volleyball.exportTemplates!.scoresheet!(
      { home: "A", away: "B", court: "Court 1", homeColor: "#ff0000" },
      { bestOf: 5, setTo: 25, finalSetTo: 15 } as never,
    );
    const model = DocModel.parse({
      kind: "scoresheet",
      title: "Scoresheets",
      meta: { printedAt: OPTS.printedAt },
      sections,
      pageBreaks: "auto",
    });
    const s = model.sections[0]!;
    expect(s.columnsHint).toBe(2);
    expect(s.signatures).toContain("1st referee");
    expect(s.table!.rows).toHaveLength(10); // 5 sets × 2 teams
    expect(s.table!.rows[0]![2]).toContain("25");
    expect(s.table!.rows[8]![2]).not.toContain("16"); // final set to 15
    expect(s.swatches).toEqual([{ label: "A", color: "#ff0000" }]);
  });

  it("DocBranding carries tiered sponsors + orgName", () => {
    const b = DocBranding.parse({
      orgName: "Riverside SC",
      colors: { primary: "#123456" },
      sponsors: [{ name: "Acme", tier: "title" }],
    });
    expect(b.sponsors?.[0]).toEqual({ name: "Acme", tier: "title" });
    expect(b.orgName).toBe("Riverside SC");
  });

  it("DocModel carries an optional description", () => {
    const m = DocModel.parse({
      kind: "timetable", title: "T", meta: { printedAt: "2026-07-19" },
      description: "All fixtures, in play order.", sections: [],
    });
    expect(m.description).toBe("All fixtures, in play order.");
  });

  it("buildOfficialsRota: one section per official with a duties table", () => {
    const m = buildOfficialsRota("Summer League — Officials", [
      { officialName: "Sam Ref", duties: [
        { at: "Sat 19 Jul 09:00", court: "1", compDivision: "Summer · Div 1",
          role: "Referee", opponents: "Falcons vs Hawks", response: "accepted" },
      ] },
    ], { printedAt: "2026-07-19", pageBreaks: "per_team" });
    expect(m.kind).toBe("officials_rota");
    expect(m.sections).toHaveLength(1);
    expect(m.sections[0]!.heading).toBe("Sam Ref");
    expect(m.sections[0]!.table?.rows[0]).toContain("Referee");
    expect(m.sections[0]!.signatures).toBeTruthy();
    expect(m.sections[0]!.table?.landscape).toBe(true); // 6 wide columns clip on portrait A4
  });

  it("buildAdmitTickets: one 2-up section per ticket, QR is a URL not pixels", () => {
    const m = buildAdmitTickets("Summer League — Tickets", [
      { maskedName: "S. Ref", competition: "Summer League", dates: "19 Jul",
        ref: "AB12CD", status: "CONFIRMED", qrUrl: "https://x/r/AB12CD", seq: 1 },
    ], { printedAt: "2026-07-19" });
    expect(m.kind).toBe("admit_ticket");
    expect(m.sections[0]!.columnsHint).toBe(2);
    expect(m.sections[0]!.ticket?.qrUrl).toBe("https://x/r/AB12CD");
    expect(JSON.stringify(m)).not.toMatch(/data:image/); // no pixels in the model
  });
});

// F5/Task 6: build.ts used to hardcode its table chrome ("Time"/"Court"/…) and
// its no-kick-off-time cell ("TBD") as English literals with no way for a
// caller to override them, so a French org's printed timetable carried English
// headers over French entrant names. `BuildOpts.i18n` carries pre-resolved
// strings the same way `home`/`away` already arrive pre-resolved — the engine
// still holds no locale of its own.
describe("BuildOpts.i18n — caller-supplied table chrome (F5/Task 6)", () => {
  // Stand-ins for what exports.ts resolves out of fr/ui.json. Deliberately not
  // imported from apps/web: the engine must not reach across that boundary.
  const FR = {
    timeTbc: "À confirmer",
    timetableColumns: ["Heure", "Terrain", "Domicile", "", "Extérieur", "Phase"],
    rotaColumns: ["Quand", "Terrain", "Compétition · Division", "Rôle", "Match", "Réponse"],
    participantsColumns: ["Club", "Équipe", "Division", "Participant", "Joueur", "#", "Poste"],
    // F5 remainder: the VALUE fallbacks F5/Task 6 above left as English
    // literals with no opts.i18n override — see build.ts:52,76,198,209 and
    // the four bracket-family builders' `?? "TBD"` sites.
    resultVs: "contre",
    courtUnassigned: "Non attribué",
    rotaNoDuties: "Aucune désignation attribuée",
    rotaResponseAccepted: "Acceptée",
    rotaResponseDeclined: "Déclinée",
    rotaResponsePending: "En attente",
    entrantTbd: "À définir",
  };

  it("timetable: columns and the no-time cell come from opts.i18n, not English", () => {
    const model = buildTimetable("Coupe d'été", FIXTURES, { ...OPTS, i18n: FR });
    expect(DocModel.parse(model)).toBeTruthy();
    for (const s of model.sections) {
      expect(s.table!.columns).toEqual(FR.timetableColumns);
    }
    // f3 has `at: null` — the cell that used to read the literal "TBD".
    const ko = model.sections[1]!.table!.rows[0]!;
    expect(ko[0]).toBe("À confirmer");
    expect(ko[0]).not.toBe("TBD");
    // Nothing anywhere in the doc still says the English header words.
    const json = JSON.stringify(model);
    for (const english of ["Time", "Court", "Home", "Away", "Stage", "TBD"]) {
      expect(json).not.toContain(`"${english}"`);
    }
  });

  it("officials rota: columns come from opts.i18n, not English", () => {
    const m = buildOfficialsRota("Planning", [
      { officialName: "Sam Ref", duties: [
        { at: "sam. 19 juil. 09:00", court: "1", compDivision: "Été · Div 1",
          role: "Arbitre", opponents: "Falcons vs Hawks", response: "accepted" },
      ] },
    ], { printedAt: "2026-07-19", pageBreaks: "per_team", i18n: FR });
    expect(m.sections[0]!.table!.columns).toEqual(FR.rotaColumns);
    expect(m.sections[0]!.table!.columns).not.toContain("When");
  });

  it("participants: columns come from opts.i18n, not English", () => {
    const m = buildParticipants(
      "Participants",
      [{ club: "", team: "", division: "Open", entrant: "Empty Spot 3", player: "", number: null, position: "" }],
      { ...OPTS, i18n: FR },
    );
    expect(m.sections[0]!.table!.columns).toEqual(FR.participantsColumns);
    expect(m.sections[0]!.table!.columns).not.toContain("Entrant");
  });

  it("a caller that omits i18n (or omits one field) still gets the English defaults", () => {
    // The whole point of the field being optional — every pre-existing engine
    // caller must be byte-identical to before.
    const plain = buildTimetable("Cup", FIXTURES, OPTS);
    expect(plain.sections[0]!.table!.columns).toEqual(["Time", "Court", "Home", "", "Away", "Stage"]);
    expect(plain.sections[1]!.table!.rows[0]![0]).toBe("TBD");

    // A partially-filled block falls back per field, not all-or-nothing.
    const partial = buildTimetable("Cup", FIXTURES, { ...OPTS, i18n: { timeTbc: "À confirmer" } });
    expect(partial.sections[0]!.table!.columns).toEqual(["Time", "Court", "Home", "", "Away", "Stage"]);
    expect(partial.sections[1]!.table!.rows[0]![0]).toBe("À confirmer");
  });

  // F5 remainder: #630 localized the table CHROME above (columns, the
  // no-time cell) but left five VALUE fallbacks hardcoded English —
  // build.ts's undecided-result "vs" separator, its per_pitch "no court"
  // grouping heading, the officials-rota "no duties" subheading and its
  // three response-state labels, and the bracket-family "TBD" side.
  const bracketFx = (id: string, round_no: number, seq_in_round: number) => ({
    id,
    round_no,
    seq_in_round,
    home: null as string | null,
    away: null as string | null,
    headline: null,
    decided: false,
  });

  it("timetable: the undecided-result separator and the per_pitch 'no court' heading come from opts.i18n", () => {
    const fixtures: ExportFixture[] = [
      { id: "f1", at: "2026-07-20T09:00:00Z", court: null, stageName: "Prelim", round: 1, home: "A", away: "B" },
    ];
    const model = buildTimetable("Coupe", fixtures, { ...OPTS, pageBreaks: "per_pitch", i18n: FR });
    expect(model.sections[0]!.heading).toBe("Non attribué");
    expect(model.sections[0]!.heading).not.toBe("Unassigned");
    const row = model.sections[0]!.table!.rows[0]!;
    expect(row[3]).toBe("contre"); // result column — fixture has no `result` yet
    expect(row[3]).not.toBe("vs");
  });

  it("officials rota: the no-duties subheading and the response labels come from opts.i18n", () => {
    const m = buildOfficialsRota(
      "Planning",
      [
        { officialName: "Sans tâche", duties: [] },
        {
          officialName: "Sam Ref",
          duties: [
            { at: "x", court: null, compDivision: "d", role: "r", opponents: "A vs B", response: "accepted" },
            { at: "x", court: null, compDivision: "d", role: "r", opponents: "A vs B", response: "declined" },
            { at: "x", court: null, compDivision: "d", role: "r", opponents: "A vs B", response: "pending" },
          ],
        },
      ],
      { ...OPTS, i18n: FR },
    );
    expect(m.sections[0]!.subheading).toBe("Aucune désignation attribuée");
    const responses = m.sections[1]!.table!.rows.map((r) => r[5]);
    expect(responses).toEqual(["Acceptée", "Déclinée", "En attente"]);
    const json = JSON.stringify(m);
    for (const english of ["No duties assigned", "Accepted", "Declined", "Pending"]) {
      expect(json).not.toContain(`"${english}"`);
    }
  });

  it("buildBracket: an unresolved side falls back to opts.i18n.entrantTbd", () => {
    const model = buildBracket("Coupe", [bracketFx("a", 0, 1)], () => "Finale", { ...OPTS, i18n: FR });
    expect(model.bracket!.nodes[0]).toMatchObject({ home: "À définir", away: "À définir" });
    expect(JSON.stringify(model)).not.toContain('"TBD"');
  });

  it("buildBracketDe: an unresolved side falls back to opts.i18n.entrantTbd", () => {
    // k=2 (4-entrant) double-elim, verified against doubleElimBracket()
    // directly: WB round_no 1-2, LB 5-6, GF 9 (bracket-layout.ts).
    const fixtures = [
      bracketFx("wb1a", 1, 1), bracketFx("wb1b", 1, 2),
      bracketFx("wb2", 2, 1),
      bracketFx("lb1", 5, 1),
      bracketFx("lb2", 6, 1),
      bracketFx("gf", 9, 1),
    ];
    const model = buildBracketDe(
      "Coupe",
      fixtures,
      { winners: "W", losers: "L", grandFinal: "GF", reset: "R" },
      { ...OPTS, i18n: FR },
    );
    for (const n of model.bracketDe!.nodes) {
      expect(n.home).toBe("À définir");
      expect(n.away).toBe("À définir");
    }
  });

  it("buildLadderPoster: an unresolved side falls back to opts.i18n.entrantTbd", () => {
    const fixtures = [bracketFx("r1", 0, 1), bracketFx("r2", 1, 1)];
    const model = buildLadderPoster("Coupe", fixtures, (i) => `Rung ${i}`, { ...OPTS, i18n: FR });
    for (const rung of model.ladder!.rungs) {
      expect(rung.home).toBe("À définir");
      expect(rung.away).toBe("À définir");
    }
  });

  it("buildPagePoster: an unresolved side falls back to opts.i18n.entrantTbd", () => {
    const fixtures = [bracketFx("q1", 0, 1), bracketFx("elim", 0, 2), bracketFx("q2", 1, 1), bracketFx("final", 2, 1)];
    const model = buildPagePoster(
      "Coupe",
      fixtures,
      { q1: "Q1", eliminator: "E", q2: "Q2", final: "F" },
      { ...OPTS, i18n: FR },
    );
    for (const n of model.pagePlayoff!.nodes) {
      expect(n.home).toBe("À définir");
      expect(n.away).toBe("À définir");
    }
  });

  it("every new value fallback stays English when opts.i18n is absent — every pre-existing caller is byte-identical to before", () => {
    const plainTimetable = buildTimetable(
      "Cup",
      [{ id: "f1", at: "2026-07-20T09:00:00Z", court: null, stageName: "Prelim", round: 1, home: "A", away: "B" }],
      { ...OPTS, pageBreaks: "per_pitch" },
    );
    expect(plainTimetable.sections[0]!.heading).toBe("Unassigned");
    expect(plainTimetable.sections[0]!.table!.rows[0]![3]).toBe("vs");

    const plainRota = buildOfficialsRota("Rota", [{ officialName: "X", duties: [] }], OPTS);
    expect(plainRota.sections[0]!.subheading).toBe("No duties assigned");

    const plainBracket = buildBracket("Cup", [bracketFx("a", 0, 1)], () => "R", OPTS);
    expect(plainBracket.bracket!.nodes[0]).toMatchObject({ home: "TBD", away: "TBD" });

    const plainDe = buildBracketDe(
      "Cup",
      [bracketFx("wb1a", 1, 1), bracketFx("wb1b", 1, 2), bracketFx("wb2", 2, 1), bracketFx("lb1", 5, 1), bracketFx("lb2", 6, 1), bracketFx("gf", 9, 1)],
      { winners: "W", losers: "L", grandFinal: "GF", reset: "R" },
      OPTS,
    );
    expect(plainDe.bracketDe!.nodes[0]).toMatchObject({ home: "TBD", away: "TBD" });

    const plainLadder = buildLadderPoster("Cup", [bracketFx("r1", 0, 1)], (i) => `Rung ${i}`, OPTS);
    expect(plainLadder.ladder!.rungs[0]).toMatchObject({ home: "TBD", away: "TBD" });

    const plainPage = buildPagePoster(
      "Cup",
      [bracketFx("q1", 0, 1), bracketFx("elim", 0, 2), bracketFx("q2", 1, 1), bracketFx("final", 2, 1)],
      { q1: "Q1", eliminator: "E", q2: "Q2", final: "F" },
      OPTS,
    );
    expect(plainPage.pagePlayoff!.nodes[0]).toMatchObject({ home: "TBD", away: "TBD" });

    // Partial i18n (an unrelated field only) must not disturb these five —
    // each falls back per field, not all-or-nothing (same rule as timeTbc above).
    const partialTimetable = buildTimetable(
      "Cup",
      [{ id: "f1", at: "2026-07-20T09:00:00Z", court: null, stageName: "Prelim", round: 1, home: "A", away: "B" }],
      { ...OPTS, pageBreaks: "per_pitch", i18n: { timeTbc: "À confirmer" } },
    );
    expect(partialTimetable.sections[0]!.heading).toBe("Unassigned");
    expect(partialTimetable.sections[0]!.table!.rows[0]![3]).toBe("vs");
  });
});

describe("buildStandings — row badges (PROMPT-60)", () => {
  it("threads badge URLs into the table when any row carries one", () => {
    const model = buildStandings(
      "Open — Standings",
      [
        { name: "Mexico", played: 3, won: 3, drawn: 0, lost: 0, points: 9, metrics: {},
          badgeUrl: "https://flags.example/mex.png" },
        { name: "Canada", played: 3, won: 0, drawn: 0, lost: 3, points: 0, metrics: {} },
      ],
      { printedAt: "2026-07-18T00:00:00Z" },
    );
    const table = model.sections[0]!.table!;
    expect(table.rowBadges).toEqual(["https://flags.example/mex.png", null]);
  });

  it("omits rowBadges entirely when no row has a badge (plain output unchanged)", () => {
    const model = buildStandings(
      "Open — Standings",
      [{ name: "A", played: 0, won: 0, drawn: 0, lost: 0, points: 0, metrics: {} }],
      { printedAt: "2026-07-18T00:00:00Z" },
    );
    expect(model.sections[0]!.table!.rowBadges).toBeUndefined();
  });
});

describe("buildBracket (PROMPT-62 §4)", () => {
  const fx = (
    id: string, round: number, seq: number,
    home: string | null, away: string | null, headline: string | null, decided: boolean,
  ) => ({ id, round_no: round, seq_in_round: seq, home, away, headline, decided });

  // F1 Task 4: buildBracket no longer computes round names itself (the
  // engine must not carry English) -- the caller injects a `roundLabel`
  // callback, the same pattern buildBracketDe already uses for laneLabels.
  // This mirrors what apps/web's roundRoleLabel(msg, roundRole({...}))
  // would produce for a knockout, without pulling apps/web into the engine
  // test.
  const roundLabel = (fromEnd: number): string => {
    if (fromEnd === 0) return "Final";
    if (fromEnd === 1) return "Semi-finals";
    if (fromEnd === 2) return "Quarter-finals";
    return `Round of ${2 ** (fromEnd + 1)}`;
  };

  const eight = [
    fx("q1", 0, 1, "Mexico", "Chile", "2–0", true),
    fx("q2", 0, 2, "Japan", "Ghana", "1–0", true),
    fx("q3", 0, 3, "France", "Peru", null, false),
    fx("q4", 0, 4, "Canada", "Italy", null, false),
    fx("s1", 1, 1, "Mexico", "Japan", null, false),
    fx("s2", 1, 2, null, null, null, false),
    fx("f", 2, 1, null, null, null, false),
  ];

  it("produces a landscape-natured model with the laid-out payload + labels", () => {
    const model = buildBracket("Cup — Open", eight, roundLabel, { printedAt: "2026-07-18T00:00:00Z" });
    expect(model.kind).toBe("bracket");
    expect(model.sections).toEqual([]);
    expect(model.bracket!.roundLabels).toEqual(["Quarter-finals", "Semi-finals", "Final"]);
    expect(model.bracket!.rowsPerSide).toBe(2);
    const final = model.bracket!.nodes.find((n) => n.side === "center");
    expect(final).toMatchObject({ home: "TBD", away: "TBD", decided: false });
    const q1 = model.bracket!.nodes.find((n) => n.fixtureId === "q1");
    expect(q1).toMatchObject({ home: "Mexico", headline: "2–0", decided: true });
    // deterministic golden: printedAt is an input
    expect(model.meta.printedAt).toBe("2026-07-18T00:00:00Z");
  });

  it("labels deep fields with Round of N", () => {
    // 16-slot field: rounds = 4 → outermost label Round of 16
    const refs = Array.from({ length: 8 }, (_, i) => fx(`r0-${i}`, 0, i + 1, `A${i}`, `B${i}`, null, false))
      .concat(Array.from({ length: 4 }, (_, i) => fx(`r1-${i}`, 1, i + 1, null, null, null, false)))
      .concat(Array.from({ length: 2 }, (_, i) => fx(`r2-${i}`, 2, i + 1, null, null, null, false)))
      .concat([fx("fin", 3, 1, null, null, null, false)]);
    const model = buildBracket("Cup", refs, roundLabel, { printedAt: "2026-07-18T00:00:00Z" });
    expect(model.bracket!.roundLabels).toEqual(["Round of 16", "Quarter-finals", "Semi-finals", "Final"]);
  });

  // Proves buildBracket actually CALLS the injected function (never falls
  // back to hardcoded English) -- a distinctive marker string that isn't
  // "Final"/"Semi-finals"/etc could only appear via roundLabel().
  it("is driven by the injected roundLabel, not internal English", () => {
    const model = buildBracket("Cup", eight, (fromEnd) => `MARKER-${fromEnd}`, {
      printedAt: "2026-07-18T00:00:00Z",
    });
    expect(model.bracket!.roundLabels).toEqual(["MARKER-2", "MARKER-1", "MARKER-0"]);
  });

  it("throws CONFIG_INVALID for shapes the two-sided layout can't take", () => {
    const ladder = [fx("a", 0, 1, "A", "B", null, false), fx("b", 1, 1, null, null, null, false), fx("c", 2, 1, null, null, null, false)];
    expect(() => buildBracket("Cup", ladder, roundLabel, { printedAt: "x" })).toThrow(/bracket poster/);
  });
});

describe("buildAuditLedger (PROMPT-63 §2)", () => {
  const events = [
    { seq: 1, at: "12:00:01", actor: "org", type: "core.start", detail: "{}", voids: "" },
    { seq: 2, at: "12:31:07", actor: "Priya", type: "football.goal", detail: '{"by":"H","minute":31}', voids: "" },
  ];

  it("verified ledger: stamp + head + signature ride in the description", () => {
    const model = buildAuditLedger("Cup — Match 14 audit", {
      events, verified: true, firstTamperedSeq: null,
      headHash: "deadbeef".repeat(8), signature: { key_id: "k1", issued_at: "2026-07-18T12:00:00Z" },
    }, { printedAt: "2026-07-18T12:00:00Z" });
    expect(model.kind).toBe("audit");
    expect(model.description).toContain("VERIFIED ✓");
    expect(model.description).toContain("deadbeefdeadbeef…");
    expect(model.description).toContain("key k1");
    expect(model.sections[0]!.table!.rows).toHaveLength(2);
    expect(model.sections[0]!.table!.rows[1]).toEqual([2, "12:31:07", "Priya", "football.goal", '{"by":"H","minute":31}', ""]);
  });

  it("tampered + unsigned ledger says so", () => {
    const model = buildAuditLedger("t", {
      events, verified: false, firstTamperedSeq: 2, headHash: null, signature: null,
    }, { printedAt: "x" });
    expect(model.description).toContain("TAMPERED");
    expect(model.description).toContain("#2");
    expect(model.description).toContain("unsigned");
  });
});
