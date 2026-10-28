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
import { DocBranding, DocKind, DocModel, type ExportFixture } from "./types.ts";
import { EngineError } from "../core/errors.ts";
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
    // Repair pass (review of F5 remainder): the officials-rota sign-on/off
    // block and the roster's sign-at-start block were still hardcoded
    // English `signatures` arrays in build.ts — see build.ts:152,228.
    rotaSignatures: ["Signature de l'officiel", "Arrivée", "Départ"] as const,
    rosterSignatures: ["Capitaine de l'équipe", "Officiel"] as const,
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

  // Repair pass: build.ts:228 hardcoded the rota's sign-on/off block
  // ("Official signature"/"Time on"/"Time off") six lines below the
  // rotaResponse* fields this same F5 remainder pass already wired.
  it("officials rota: sign-on/off signature labels come from opts.i18n, not English", () => {
    const m = buildOfficialsRota("Planning", [
      { officialName: "Sans tâche", duties: [] },
    ], { printedAt: "2026-07-19", i18n: FR });
    expect(m.sections[0]!.signatures).toEqual(FR.rotaSignatures);
    expect(m.sections[0]!.signatures).not.toEqual(["Official signature", "Time on", "Time off"]);
  });

  // Repair pass: build.ts:152 hardcoded the roster's sign-at-start block
  // ("Team captain"/"Official") the same way — buildRoster had no opts.i18n
  // field at all before this pass.
  it("roster: sign-at-start signature labels come from opts.i18n, not English", () => {
    const m = buildRoster(
      "Rosters",
      [{ teamName: "U12", clubName: "Acme SC", players: [{ name: "Ada", dob: "2014-01-01", number: 7 }] }],
      { ...OPTS, i18n: FR },
    );
    expect(m.sections[0]!.signatures).toEqual(FR.rosterSignatures);
    expect(m.sections[0]!.signatures).not.toEqual(["Team captain", "Official"]);
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
    // Repair pass: the rota's sign-on/off block, same byte-identical rule.
    expect(plainRota.sections[0]!.signatures).toEqual(["Official signature", "Time on", "Time off"]);

    // Repair pass: the roster's sign-at-start block, same byte-identical rule.
    const plainRoster = buildRoster("Rosters", [{ teamName: "U12", players: [] }], OPTS);
    expect(plainRoster.sections[0]!.signatures).toEqual(["Team captain", "Official"]);

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

// W2d follow-up (final review m3): the result columns are the CALLER's table declaration — the web export hands the
// public table's own (IIHF's P · W · OTW · OTL · D · L, RBG:343-344), the cells beside them — and the builder places them
// between Team and the sport's metrics. It invents none: no `resultColumns` keeps its historic P · W · D · L.
describe("buildStandings — the caller's result columns (W2d follow-up m3)", () => {
  const SPLIT = ["P", "W", "OTW", "OTL", "D", "L"] as const;
  // Every count differs from every other on the row, so a cell in the wrong column cannot match by luck.
  const ash = { name: "Ash", played: 6, won: 5, drawn: 0, lost: 1, points: 13, metrics: { gf: 14 }, results: [6, 1, 2, 3, 0, 4] };

  it("prints the caller's headers and each row's cells in that order, between Team and the metrics; # and Pts as before", () => {
    const model = buildStandings("Open — Standings", [ash], { ...OPTS, metricColumns: ["gf"], resultColumns: [...SPLIT] });
    expect(model.sections[0]!.table).toEqual({
      columns: ["#", "Team", ...SPLIT, "gf", "Pts"],
      rows: [[1, "Ash", 6, 1, 2, 3, 0, 4, 14, 13]],
    });
  });

  it("no result columns: the historic P · W · D · L from the row's own counts (the empty case)", () => {
    const { results: _results, ...plain } = ash;
    const model = buildStandings("S", [plain], { ...OPTS, metricColumns: [] });
    expect(model.sections[0]!.table!.columns).toEqual(["#", "Team", "P", "W", "D", "L", "Pts"]);
    expect(model.sections[0]!.table!.rows).toEqual([[1, "Ash", 6, 5, 0, 1, 13]]);
  });

  it("refuses a row whose cells do not pair with the headers: a short row, a missing one, and cells with no headers", () => {
    let refused = 0;
    const cases: [string, () => unknown][] = [
      ["one cell short", () => buildStandings("S", [{ ...ash, results: ash.results.slice(1) }], { ...OPTS, resultColumns: [...SPLIT] })],
      ["no cells on a row", () => buildStandings("S", [ash, { ...ash, name: "Birch", results: undefined }], { ...OPTS, resultColumns: [...SPLIT] })],
      ["cells but no headers", () => buildStandings("S", [ash], OPTS)],
    ];
    for (const [label, build] of cases) {
      expect(build, label).toThrow(EngineError);
      try {
        build();
      } catch (e) {
        expect(e, label).toMatchObject({ code: "CONFIG_INVALID" });
        refused++;
      }
    }
    expect(refused, "every case refused").toBe(cases.length);
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

// ---------------------------------------------------------------------------
// Engine mutation-debt P0 pilot (2026-10-11): the build.ts survivors of Stryker run 37957068135, killed by what the export
// format DECLARES, never by a run of the builders: the DocModel schema and the DocKind enum (types.ts), BuildOpts' field docs,
// the v12 matchday-documents spec (docs/superpowers/specs/2026-07-17-v12-matchday-documents-design.md §3.4 and §4 PR2), the
// audit PDF task (docs/superpowers/plans/2026-07-18-v13-wave.md Task 16), bracket-layout.ts's own shape declarations, and the
// header comment's refusal contract ("Throws CONFIG_INVALID for shapes the ... geometry can't lay out"). Table cells are read
// through the model's own header row, so no test hard-codes a column position.
// ---------------------------------------------------------------------------

type BracketFx = { id: string; round_no: number; seq_in_round: number; home: string | null; away: string | null; headline: string | null; decided: boolean };
const bfx = (id: string, round_no: number, seq_in_round: number, home: string | null = null, away: string | null = null): BracketFx =>
  ({ id, round_no, seq_in_round, home, away, headline: null, decided: false });
/** A 4-entrant single-elimination field whose last round also holds the 3rd-place playoff: bracket-layout's twoSidedBracket
 *  takes the lowest seq of the last round as the final and a second fixture there as the 3rd-place match. */
const FOUR_WITH_THIRD = [bfx("sf1", 0, 1, "A", "B"), bfx("sf2", 0, 2, "C", "D"), bfx("final", 1, 1), bfx("third", 1, 2)];
/** A k=2 double-elimination field with its grand-final reset: doubleElimBracket's rounds are WB 0..k-1, LB 2k..4k-3, GF 5k-2
 *  and the reset 5k-1 (relative to the first round), here offset by 1. */
const DE_WITH_RESET = [bfx("wb1a", 1, 1), bfx("wb1b", 1, 2), bfx("wb2", 2, 1), bfx("lb1", 5, 1), bfx("lb2", 6, 1), bfx("gf", 9, 1), bfx("reset", 10, 1)];
/** IPL page playoffs: Q1 and the Eliminator, then Q2, then the Final (pagePlayoffBracket's one accepted shape). */
const PAGE_FOUR = [bfx("q1", 0, 1), bfx("elim", 0, 2), bfx("q2", 1, 1), bfx("fin", 2, 1)];
const LANES = { winners: "W", losers: "L", grandFinal: "GF", reset: "R" };
const SLOTS = { q1: "Q1", eliminator: "E", q2: "Q2", final: "F" };

/** The cell of `row` under the header `column`, located through the model's own header row. */
function cell(table: { columns: string[]; rows: (string | number)[][] }, row: number, column: string): string | number {
  const at = table.columns.indexOf(column);
  expect(at, `the header has a "${column}" column: ${JSON.stringify(table.columns)}`).toBeGreaterThanOrEqual(0);
  return table.rows[row]![at]!;
}

/** Every builder, each on an input that reaches its optional branches: an unscheduled and a court-less fixture, a club-less
 *  team, a player with no number or date of birth, a participant with no number, an official with no duties and a duty
 *  with no court, unresolved bracket sides, a tampered and unsigned ledger with no head. `kind` is the DocKind member the
 *  builder is named for. */
function everyBuilder(opts: Parameters<typeof buildTimetable>[2]): { name: string; kind: DocKind; model: DocModel }[] {
  return [
    { name: "buildTimetable", kind: "timetable", model: buildTimetable("T", [
      { id: "a", at: null, court: null, stageName: "Prelim", round: 1, home: "A", away: "B" },
      { id: "b", at: "2026-07-20T09:00:00Z", court: "Court 1", stageName: "Prelim", round: 1, home: "C", away: "D", result: "2–1" },
    ], opts) },
    { name: "buildStandings", kind: "standings", model: buildStandings("S", [
      { name: "A", played: 1, won: 1, drawn: 0, lost: 0, points: 3, metrics: { for: 2 }, badgeUrl: "https://b/a.png" },
      { name: "B", played: 1, won: 0, drawn: 0, lost: 1, points: 0, metrics: {} },
    ], { ...opts, metricColumns: ["for"] }) },
    { name: "buildRoster", kind: "roster", model: buildRoster("R", [{ teamName: "U12", players: [{ name: "Ada" }] }], opts) },
    { name: "buildParticipants", kind: "participants", model: buildParticipants("P", [
      { club: "", team: "", division: "Open", entrant: "Empty Spot 1", player: "", number: null, position: "" },
    ], opts) },
    { name: "buildOfficialsRota", kind: "officials_rota", model: buildOfficialsRota("O", [
      { officialName: "Idle", duties: [] },
      { officialName: "Busy", duties: [{ at: "09:00", court: null, compDivision: "C · D", role: "Referee", opponents: "A vs B", response: "pending" }] },
    ], opts) },
    { name: "buildAdmitTickets", kind: "admit_ticket", model: buildAdmitTickets("K", [
      { maskedName: "A. B.", competition: "Cup", dates: "1 Aug", ref: "R1", status: "PAID", qrUrl: "https://x/r/R1", seq: 1 },
    ], opts) },
    { name: "buildBracket", kind: "bracket", model: buildBracket("B", FOUR_WITH_THIRD, () => "Round", opts) },
    { name: "buildBracketDe", kind: "bracket", model: buildBracketDe("B", DE_WITH_RESET, LANES, opts) },
    { name: "buildLadderPoster", kind: "bracket", model: buildLadderPoster("B", [bfx("r1", 0, 1), bfx("r2", 1, 1)], (i) => `Rung ${i + 1}`, opts) },
    { name: "buildPagePoster", kind: "bracket", model: buildPagePoster("B", PAGE_FOUR, SLOTS, opts) },
    { name: "buildAuditLedger", kind: "audit", model: buildAuditLedger("A", {
      events: [{ seq: 1, at: "12:00", actor: "org", type: "core.start", detail: "{}", voids: "" }],
      verified: false, firstTamperedSeq: 1, headHash: null, signature: null,
    }, opts) },
  ];
}

describe("every builder's model is one its own declared format accepts (the DocModel schema; mutation-debt P0)", () => {
  it("each parses as a DocModel of the kind the builder is named for; a bracket kind carries exactly one bracket payload and no sections", () => {
    const models = everyBuilder(OPTS);
    let checked = 0;
    for (const { name, kind, model } of models) {
      const parsed = DocModel.safeParse(model);
      expect(parsed.success, `${name}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
      expect(model.kind, name).toBe(kind);
      if (kind === "bracket") {
        // types.ts: "set only for kind:'bracket' (sections stay empty)"; "exactly one of the ... bracket payloads is set"
        expect(model.sections, name).toEqual([]);
        expect([model.bracket, model.bracketDe, model.ladder, model.pagePlayoff].filter((p) => p !== undefined), name).toHaveLength(1);
      }
      checked++;
    }
    // anti-vacuity: the sweep covers every kind a builder here produces, which is every DocKind except the two the sport
    // modules' exportTemplates produce (scoresheet, match_report)
    expect(checked).toBe(models.length);
    expect(new Set(models.map((m) => m.kind))).toEqual(new Set(DocKind.options.filter((k) => k !== "scoresheet" && k !== "match_report")));
  });
});

describe("base(): the caller's description, footerNote, liveUrl and branding reach every builder's model (BuildOpts → DocModel)", () => {
  const branding = { orgName: "Riverside SC", sponsors: [{ name: "Acme", tier: "title" }] };
  const opts = { ...OPTS, description: "What this sheet is.", footerNote: "Printed for the desk", liveUrl: "https://x/live", branding };

  it("each builder carries all four onto the model; the audit ledger's description is its own verification stamp", () => {
    let checked = 0;
    for (const { name, model } of everyBuilder(opts)) {
      expect(model.meta, name).toEqual({ printedAt: OPTS.printedAt, footerNote: opts.footerNote, liveUrl: opts.liveUrl });
      expect(model.branding, name).toEqual(branding);
      if (name === "buildAuditLedger") {
        // the audit ledger's description is its own verification stamp (v13 wave Task 16), never the caller's: three parts
        expect(model.description, name).not.toBe(opts.description);
        expect(model.description?.split(" · "), name).toHaveLength(3);
      } else {
        expect(model.description, name).toBe(opts.description);
      }
      checked++;
    }
    expect(checked).toBe(11);
  });

  it("and none of them is invented when the caller gives none", () => {
    let checked = 0;
    for (const { name, model } of everyBuilder(OPTS)) {
      expect(model.meta.footerNote, name).toBeUndefined();
      expect(model.meta.liveUrl, name).toBeUndefined();
      expect(model.branding, name).toBeUndefined();
      if (name !== "buildAuditLedger") expect(model.description, name).toBeUndefined();
      checked++;
    }
    expect(checked).toBe(11);
  });
});

describe("timetable rows: each cell is its fixture's own value (v12 spec §3.4, order of play)", () => {
  it("a scheduled fixture shows its time and court, a decided one its result between the sides; a court-less one is never a blank cell", () => {
    const model = buildTimetable("T", [
      { id: "a", at: "2026-07-20T09:00:00Z", court: "Court 7", stageName: "Prelim", round: 1, home: "A", away: "B", result: "3–1" },
      { id: "b", at: "2026-07-20T09:30:00Z", court: null, stageName: "Prelim", round: 1, home: "C", away: "D" },
    ], OPTS);
    const table = model.sections[0]!.table!;
    expect(cell(table, 0, "Time")).toBe("2026-07-20T09:00:00Z");
    expect(cell(table, 0, "Court")).toBe("Court 7");
    expect(cell(table, 0, "")).toBe("3–1"); // the deliberately unlabelled result column
    expect(cell(table, 1, "Time")).toBe("2026-07-20T09:30:00Z");
    const noCourt = cell(table, 1, "Court");
    expect(typeof noCourt === "string" && noCourt.trim() !== "", `a fixture with no court prints a placeholder, got ${JSON.stringify(noCourt)}`).toBe(true);
    expect(noCourt).not.toBe("Court 7");
  });
});

describe("timetable page groups: per_pitch / per_division page breaks are respected (v12 spec §3.4), auto has none", () => {
  const fx = (id: string, court: string | null, stageName: string, divisionName: string): ExportFixture =>
    ({ id, at: null, court, stageName, round: 1, home: "H", away: "A", divisionName });
  // given out of name order on purpose, with two stages on one court and one division. WHY name order: the product reads the
  // competition's divisions `order by name` (apps/web/src/server/usecases/exports.ts:749, the competition timetable, whose
  // default is per_division), so the printed groups follow the order the rest of the export already uses; the v12 spec (§3.4) is
  // silent on it. The builder collates every page group, courts included, with the one sort.
  const FIXTURES2 = [fx("1", "Court B", "Prelim", "Girls"), fx("2", "Court A", "Prelim", "Boys"), fx("3", "Court A", "Knockout", "Boys")];
  const shape = (m: DocModel) => m.sections.map((s) => [s.heading ?? null, s.subheading ?? null, s.pageBreakBefore === true]);

  it("auto: one section per stage, no page-group heading and no page break anywhere", () => {
    expect(shape(buildTimetable("T", FIXTURES2, OPTS))).toEqual([[null, "Prelim", false], [null, "Knockout", false]]);
  });

  it("per_pitch: the courts are collated by name, each court's first section carries its heading and every court after the first starts a new page", () => {
    expect(shape(buildTimetable("T", FIXTURES2, { ...OPTS, pageBreaks: "per_pitch" }))).toEqual([
      ["Court A", "Prelim", false],
      [null, "Knockout", false],
      ["Court B", "Prelim", true],
    ]);
  });

  it("per_division (the competition timetable's default, exports.ts): grouped by division the same way", () => {
    expect(shape(buildTimetable("T", FIXTURES2, { ...OPTS, pageBreaks: "per_division" }))).toEqual([
      ["Boys", "Prelim", false],
      [null, "Knockout", false],
      ["Girls", "Prelim", true],
    ]);
  });
});

describe("standings: landscape only on request (BuildOpts.landscape)", () => {
  it("a standings table built without `landscape` carries no landscape hint", () => {
    const m = buildStandings("S", [{ name: "A", played: 0, won: 0, drawn: 0, lost: 0, points: 0, metrics: {} }], { ...OPTS, metricColumns: [] });
    expect(m.sections[0]!.table!.landscape).toBeUndefined();
  });
});

/** The page-break flags of a sectioned model, in order. */
const breaks = (m: DocModel) => m.sections.map((s) => s.pageBreakBefore === true);

describe("roster form (v12 spec §4: pageBreakBefore when scoped; 13 May sign-at-start form)", () => {
  const teams = [
    { teamName: "U12", clubName: "Acme SC", players: [{ name: "Ada", dob: "2014-01-01", number: 7 }] },
    { teamName: "U14", players: [{ name: "Bo" }] },
    { teamName: "U16", players: [] },
  ];

  it("per_team: every team after the first starts a new page; unscoped, none does", () => {
    expect(breaks(buildRoster("R", teams, { ...OPTS, pageBreaks: "per_team" }))).toEqual([false, true, true]);
    expect(breaks(buildRoster("R", teams, OPTS))).toEqual([false, false, false]);
  });

  it("a team with no club is headed by its own name; a player with no number or date of birth leaves those cells blank to fill in", () => {
    const m = buildRoster("R", teams, OPTS);
    expect(m.sections[1]!.heading).toBe("U14");
    const table = m.sections[1]!.table!;
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]).toContain("Bo");
    expect(table.rows[0]!.filter((c) => c !== "Bo")).toEqual(["", "", ""]);
  });

  it("the form's header labels every column it prints, one label per cell", () => {
    const table = buildRoster("R", teams, OPTS).sections[0]!.table!;
    expect(table.columns).toHaveLength(table.rows[0]!.length);
    expect(table.columns.filter((c) => c.trim() === "")).toEqual([]);
  });
});

describe("participants: the squad number column", () => {
  it("a squad number prints as the number; none prints an empty cell", () => {
    const row = (n: number | null) => ({ club: "Acme", team: "U12", division: "Open", entrant: "Acme U12", player: "Ada", number: n, position: "GK" });
    const t = buildParticipants("P", [row(7), row(null)], OPTS).sections[0]!.table!;
    expect(cell(t, 0, "#")).toBe(7);
    expect(cell(t, 1, "#")).toBe("");
  });
});

describe("officials rota (v12 spec §3.4 / §4 PR2: one page per official, a duties table, a designed empty state)", () => {
  const duty = (court: string | null) => ({ at: "09:00", court, compDivision: "C · D", role: "Referee", opponents: "A vs B", response: "accepted" as const });
  const officials = [
    { officialName: "One", duties: [duty("Court 3")] },
    { officialName: "Two", duties: [] },
    { officialName: "Three", duties: [duty(null)] },
  ];
  // production always asks for per_team (exports.ts officials rota and /me/rota.pdf)
  const m = buildOfficialsRota("O", officials, { ...OPTS, pageBreaks: "per_team" });

  it("per_team: every official after the first starts a new page", () => {
    expect(breaks(m)).toEqual([false, true, true]);
  });

  it("an official with duties gets the table and no 'no duties' state; one with none gets the state and no table", () => {
    expect(m.sections[0]!.subheading).toBeUndefined();
    expect(m.sections[0]!.table!.rows).toHaveLength(1);
    expect(m.sections[1]!.subheading).toBe("No duties assigned");
    expect(m.sections[1]!.table).toBeUndefined();
  });

  it("a duty's court prints as its court; a court-less duty is never a blank cell", () => {
    expect(cell(m.sections[0]!.table!, 0, "Court")).toBe("Court 3");
    const noCourt = cell(m.sections[2]!.table!, 0, "Court");
    expect(typeof noCourt === "string" && noCourt.trim() !== "", `got ${JSON.stringify(noCourt)}`).toBe(true);
    expect(noCourt).not.toBe("Court 3");
  });
});

describe("bracket posters: the layout's optional fixtures, and the refusal contract", () => {
  it("the 3rd-place playoff and the grand-final reset are named on the poster", () => {
    expect(buildBracket("B", FOUR_WITH_THIRD, () => "R", OPTS).bracket!.thirdPlaceId).toBe("third");
    expect(buildBracketDe("B", DE_WITH_RESET, LANES, OPTS).bracketDe!.resetId).toBe("reset");
  });

  it("each of the four posters refuses a shape its layout cannot take with EngineError CONFIG_INVALID (never a crash)", () => {
    const refusals: [string, () => unknown][] = [
      ["buildBracket (a ladder is not a two-sided field)", () => buildBracket("B", [bfx("a", 0, 1), bfx("b", 1, 1), bfx("c", 2, 1)], () => "R", OPTS)],
      ["buildBracketDe (no fixtures)", () => buildBracketDe("B", [], LANES, OPTS)],
      ["buildLadderPoster (no fixtures)", () => buildLadderPoster("B", [], (i) => `${i}`, OPTS)],
      ["buildPagePoster (three fixtures)", () => buildPagePoster("B", PAGE_FOUR.slice(0, 3), SLOTS, OPTS)],
    ];
    let checked = 0;
    for (const [name, build] of refusals) {
      let thrown: unknown;
      try { build(); } catch (e) { thrown = e; }
      expect(thrown instanceof EngineError && thrown.code === "CONFIG_INVALID", `${name} threw ${String(thrown)}`).toBe(true);
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("the stepladder's rungs climb bottom-up by round, whatever order the fixtures arrive in", () => {
    const m = buildLadderPoster("B", [bfx("top", 2, 1), bfx("bottom", 0, 1), bfx("middle", 1, 1)], (i) => `Rung ${i + 1}`, OPTS);
    expect(m.ladder!.rungs.map((r) => [r.fixtureId, r.label])).toEqual([["bottom", "Rung 1"], ["middle", "Rung 2"], ["top", "Rung 3"]]);
  });
});

describe("audit ledger (v13 wave Task 16: one table, columns # Time Actor Event Detail Void, a stamp line)", () => {
  const ledger = (headHash: string | null, verified: boolean) => buildAuditLedger("A", {
    events: [{ seq: 1, at: "12:00", actor: "org", type: "core.start", detail: "{}", voids: "" }],
    verified, firstTamperedSeq: verified ? null : 1, headHash, signature: null,
  }, OPTS);

  it("the table's columns are the six the task declares", () => {
    expect(ledger(null, false).sections[0]!.table!.columns).toEqual(["#", "Time", "Actor", "Event", "Detail", "Void"]);
  });

  it("the stamp is three ' · '-separated parts, none blank, for a ledger with a head and for an empty one", () => {
    const head = "0123456789abcdef".repeat(4);
    for (const m of [ledger(head, true), ledger(null, false)]) {
      const parts = m.description!.split(" · ");
      expect(parts, m.description).toHaveLength(3);
      expect(parts.filter((p) => p.trim() === ""), m.description).toEqual([]);
    }
    // the head is abbreviated on the stamp, never printed whole (the existing golden pins its 16-character prefix)
    expect(ledger(head, true).description).not.toContain(head);
  });
});

// W2d follow-up review m3: the standings header in the caller's language. The builder has no locale; the web export
// hands every header pre-resolved through the public table's own dictionary keys (the timetable's and rota's columns
// already arrive this way, `i18n`). The metric headers pair with `metricColumns` by position; the cells stay keyed.
describe("buildStandings — the caller's localised headers (W2d follow-up review m3)", () => {
  const row = { name: "Ash", played: 2, won: 1, drawn: 0, lost: 1, points: 3, metrics: { gf: 4, ga: 2 } };

  it("prints the caller's Team, metric and Pts headers; # stays the glyph and the cells stay the metrics' own", () => {
    const model = buildStandings("S", [{ ...row, results: [2, 1, 0, 1] }], {
      ...OPTS,
      metricColumns: ["gf", "ga"],
      resultColumns: ["PJ", "G", "E", "P"],
      i18n: { standingsHeaders: { team: "Equipo", points: "Pts.", metrics: ["GF", "GC"] } },
    });
    expect(model.sections[0]!.table!.columns).toEqual(["#", "Equipo", "PJ", "G", "E", "P", "GF", "GC", "Pts."]);
    expect(model.sections[0]!.table!.rows).toEqual([[1, "Ash", 2, 1, 0, 1, 4, 2, 3]]);
  });

  it("no headers given: Team, the metric keys and Pts, as before (the empty case)", () => {
    const model = buildStandings("S", [row], { ...OPTS, metricColumns: ["gf", "ga"] });
    expect(model.sections[0]!.table!.columns).toEqual(["#", "Team", "P", "W", "D", "L", "gf", "ga", "Pts"]);
  });

  it("refuses metric headers that do not pair with the metric columns, never prints them shifted", () => {
    let refused = 0;
    for (const metrics of [["GF"], ["GF", "GC", "DG"]]) {
      try {
        buildStandings("S", [row], { ...OPTS, metricColumns: ["gf", "ga"], i18n: { standingsHeaders: { team: "T", points: "P", metrics } } });
      } catch (e) {
        expect(e).toBeInstanceOf(EngineError);
        expect(e).toMatchObject({ code: "CONFIG_INVALID" });
        refused++;
      }
    }
    expect(refused, "both mismatches refused").toBe(2);
  });
});
