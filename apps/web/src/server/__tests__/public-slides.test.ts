// buildPublicDivisionSlides (PROMPT-64 public /present) — pure, no DB.
import { describe, expect, it } from "vitest";
import { buildPublicDivisionSlides } from "../slideshow-data";
import type { FixtureSlideItem } from "../slideshow-data";
import { getDictionary } from "@/lib/i18n";
import { t } from "@/lib/i18n-runtime";
import { msgFor } from "@/lib/messages-i18n";
import enPublic from "@/dictionaries/en/public.json";
import esPublic from "@/dictionaries/es/public.json";
import frPublic from "@/dictionaries/fr/public.json";
import nlPublic from "@/dictionaries/nl/public.json";

const input = {
  division: { id: "d1", name: "Open" },
  stages: [
    { id: "sg", kind: "group", name: "Groups" },
    { id: "sk", kind: "knockout", name: "Knockout" },
  ],
  pools: [{ id: "pA", stage_id: "sg", key: "A", name: "Pool A" }],
  fixtures: [
    { id: "k1", stage_id: "sk", round_no: 0, seq_in_round: 1, home_entrant_id: "e1", away_entrant_id: "e2", status: "in_play", summary: { headline: "1–0" } },
    { id: "k2", stage_id: "sk", round_no: 0, seq_in_round: 2, home_entrant_id: "e3", away_entrant_id: "e4", status: "scheduled", summary: null },
    { id: "kf", stage_id: "sk", round_no: 1, seq_in_round: 1, home_entrant_id: null, away_entrant_id: null, status: "scheduled", summary: null },
  ],
  standings: [
    { stage_id: "sg", pool_id: "pA", rows: [
      { entrantId: "e1", played: 3, won: 3, drawn: 0, lost: 0, points: 9, rank: 1 },
      { entrantId: "e2", played: 3, won: 0, drawn: 0, lost: 3, points: 0, rank: 2 },
    ] },
  ],
  entrants: [
    { id: "e1", display_name: "Mexico" }, { id: "e2", display_name: "Canada" },
    { id: "e3", display_name: "Japan" }, { id: "e4", display_name: "Ghana" },
  ],
};

describe("buildPublicDivisionSlides", () => {
  it("builds standings + pinned in-play + upcoming + bracket slides", async () => {
    const slides = await buildPublicDivisionSlides(input);
    const kinds = slides.map((s) => s.kind);
    expect(kinds).toEqual(["standings", "fixtures", "fixtures", "bracket"]);
    // The en label from the dictionary file, over the KEY — not the stored name.
    expect(slides[0]).toMatchObject({ caption: `Groups — ${enPublic["table.poolLabel"].replace("{key}", "A")}` });
    expect(slides[1]).toMatchObject({ title: "In play", pinned: true });
    const bracket = slides[3] as { fixtures: { home: string | null }[] };
    expect(bracket.fixtures[0]).toMatchObject({ home: "Mexico", line: "1–0" });
  });

  it("skips the bracket slide when the knockout shape doesn't lay out", async () => {
    const slides = await buildPublicDivisionSlides({
      ...input,
      // three round-0 matches, nothing after: not a power-of-two field
      fixtures: [1, 2, 3].map((i) => ({
        id: `x${i}`, stage_id: "sk", round_no: 0, seq_in_round: i,
        home_entrant_id: "e1", away_entrant_id: "e2", status: "scheduled",
        summary: null,
      })),
    });
    expect(slides.some((s) => s.kind === "bracket")).toBe(false);
  });

  it("no live matches ⇒ no pinned slide", async () => {
    const slides = await buildPublicDivisionSlides({
      ...input,
      fixtures: input.fixtures.map((f) => ({ ...f, status: "scheduled", summary: null })),
    });
    expect(slides.every((s) => !("pinned" in s) || s.pinned !== true)).toBe(true);
  });
});

// P6 fix round 1, finding #2 (CRITICAL): this is the public /present
// slideshow — the ONLY thing standing between a visitor and English slot
// labels regardless of the org's own default_locale. Both slide KINDS that
// can show an unfilled slot (fixtures AND bracket) must resolve through it.
describe("buildPublicDivisionSlides — orgLocale (P6 finding #2)", () => {
  const withLabel = {
    ...input,
    fixtures: [
      ...input.fixtures.slice(0, 2),
      {
        id: "kf", stage_id: "sk", round_no: 1, seq_in_round: 1,
        home_entrant_id: null, away_entrant_id: null, status: "scheduled",
        summary: null,
        home_slot_label: { key: "slot.winner_group", params: { g: "A" } },
        away_slot_label: { key: "slot.winner_group", params: { g: "B" } },
      },
    ],
  };

  it("a fixtures-kind slide resolves an unfilled slot in the org's own locale, not English", async () => {
    const slides = await buildPublicDivisionSlides({ ...withLabel, orgLocale: "es" });
    // An es org's coming-up slide is titled in es (N1c c3), not "Coming up".
    const upcoming = slides.find((s) => s.kind === "fixtures" && s.title === msgFor("es", "slideshow.slide.comingUp"));
    expect(upcoming?.kind).toBe("fixtures");
    const items = (upcoming as { items: FixtureSlideItem[] }).items;
    const kf = items.find((i) => i.round === 1)!;
    expect(kf.home).toBe("Ganador del Grupo A");
    expect(kf.away).toBe("Ganador del Grupo B");
  });

  it("a bracket-kind slide ALSO resolves the unfilled slot (was left null for the client to guess at)", async () => {
    const slides = await buildPublicDivisionSlides({ ...withLabel, orgLocale: "es" });
    const bracket = slides.find((s) => s.kind === "bracket") as {
      fixtures: { id: string; home: string | null; away: string | null }[];
    };
    const kf = bracket.fixtures.find((f) => f.id === "kf")!;
    expect(kf.home).toBe("Ganador del Grupo A");
    expect(kf.away).toBe("Ganador del Grupo B");
  });

  it("omitting orgLocale defaults to English — back-compat with every existing caller", async () => {
    const slides = await buildPublicDivisionSlides(withLabel); // no orgLocale field at all
    const upcoming = slides.find((s) => s.kind === "fixtures" && s.title === "Coming up");
    const items = (upcoming as { items: FixtureSlideItem[] }).items;
    const kf = items.find((i) => i.round === 1)!;
    expect(kf.home).toBe("Winner of Group A");
  });
});

// Pool label i18n (2026-10-06). The fixture's pool carries the only name the
// generator ever stores, the English "Pool " + key. A venue screen speaks the
// ORG's locale, so the standings slide names the pool with that locale's
// `table.poolLabel` over the pool's KEY — expected text read out of the
// dictionary FILES, never through the builder.
describe("buildPublicDivisionSlides — the pool label is the org's locale's, from the key", () => {
  it("captions the pooled standings slide in every locale from the key — never the stored English name", async () => {
    const files: Record<string, Record<string, string>> = { en: enPublic, es: esPublic, fr: frPublic, nl: nlPublic };
    expect(files.es!["table.poolLabel"]!.replace("{key}", "A"), "premise").not.toBe("Pool A");
    let checked = 0;
    for (const locale of Object.keys(files)) {
      const slides = await buildPublicDivisionSlides({ ...input, orgLocale: locale });
      const captions = slides.filter((s) => s.kind === "standings").map((s) => (s as { caption: string }).caption);
      expect(captions, locale).toEqual([`Groups — ${files[locale]!["table.poolLabel"]!.replace("{key}", "A")}`]);
      checked += captions.length;
    }
    // Anti-vacuity: one pooled slide, four locales.
    expect(checked).toBe(4);
  });
});

// RS008 review fix #2 — the anonymous public kiosk (/shared/{org}/{comp}/
// present) had NO masking at all, not even by youth: buildDivisionSlides
// (the AUTHED /slideshow/competitions/[id] twin) already masked by both
// youth and consent, but this "pure public twin" never did. Standings slides
// are the simplest surface to prove the `names` map on (see
// buildDivisionSlides — consent masking, slideshow-data-locale.test.ts, for
// the DB-backed sibling of this same fix on the authed builder).
describe("buildPublicDivisionSlides — consent masking (RS008 review fix #2)", () => {
  it("masks a non-team entrant's name when opted_out is true, even on a non-youth division", async () => {
    const slides = await buildPublicDivisionSlides({
      ...input,
      entrants: [
        { id: "e1", display_name: "Arun Kumar", kind: "individual", opted_out: true },
        { id: "e2", display_name: "Dev Patel", kind: "individual", opted_out: false },
        { id: "e3", display_name: "Japan", kind: "individual" },
        { id: "e4", display_name: "Ghana", kind: "individual" },
      ],
    });
    const standings = slides.find((s) => s.kind === "standings") as { rows: { name: string }[] };
    // Per-entrant, not blanket: e2 (not opted out) stays full.
    expect(standings.rows.map((r) => r.name)).toEqual(["Arun K.", "Dev Patel"]);
  });

  it("never masks a TEAM's own name, even when opted_out is (incorrectly) true", async () => {
    const slides = await buildPublicDivisionSlides({
      ...input,
      entrants: [
        { id: "e1", display_name: "Thunder Strikers", kind: "team", opted_out: true },
        { id: "e2", display_name: "Dev Patel", kind: "individual" },
        { id: "e3", display_name: "Japan", kind: "individual" },
        { id: "e4", display_name: "Ghana", kind: "individual" },
      ],
    });
    const standings = slides.find((s) => s.kind === "standings") as { rows: { name: string }[] };
    expect(standings.rows.map((r) => r.name)).toContain("Thunder Strikers");
  });

  it("masks by division youth policy alone, with no explicit opt-out", async () => {
    const slides = await buildPublicDivisionSlides({
      ...input,
      division: { ...input.division, youth: true },
      entrants: [
        { id: "e1", display_name: "Arun Kumar", kind: "individual" },
        { id: "e2", display_name: "Dev Patel", kind: "individual" },
        { id: "e3", display_name: "Japan", kind: "individual" },
        { id: "e4", display_name: "Ghana", kind: "individual" },
      ],
    });
    const standings = slides.find((s) => s.kind === "standings") as { rows: { name: string }[] };
    expect(standings.rows.map((r) => r.name)).toEqual(["Arun K.", "Dev P."]);
  });

  it("omitting kind/opted_out/youth entirely never masks — back-compat with every existing caller/test", async () => {
    // The base `input` fixture (top of file) predates this fix and sets none
    // of kind/opted_out/youth/player_name_display anywhere.
    const slides = await buildPublicDivisionSlides(input);
    const standings = slides.find((s) => s.kind === "standings") as { rows: { name: string }[] };
    expect(standings.rows.map((r) => r.name)).toEqual(["Mexico", "Canada"]);
  });
});

// N1c c3 — the public kiosk (/present) printed the organiser board's "Winner of
// R1·2" for a knockout side still waiting on a match, and English slide titles
// ("In play" / "Latest results" / "Coming up") whatever the org's language. A
// venue screen now reads the waiting side through the public round namer, the
// same words the hub, the match centre and the division page use, and every
// fixtures-slide title from the dictionary in the org's locale. Expectations
// are derived from the dictionaries, never typed copies.
describe("buildPublicDivisionSlides — waiting sides name their feeder's ROUND; titles come from the dictionary (N1c c3)", () => {
  const knockout = {
    division: { id: "d1", name: "Open" },
    stages: [{ id: "ko", kind: "knockout", name: "Knockout" }],
    pools: [],
    standings: [],
    entrants: [
      { id: "e1", display_name: "Mexico" }, { id: "e2", display_name: "Canada" },
      { id: "e3", display_name: "Japan" }, { id: "e4", display_name: "Ghana" },
    ],
    fixtures: [
      { id: "semi-1", stage_id: "ko", round_no: 1, seq_in_round: 1, home_entrant_id: "e1", away_entrant_id: "e2", status: "decided", summary: { headline: "2–1" } },
      { id: "semi-2", stage_id: "ko", round_no: 1, seq_in_round: 2, home_entrant_id: "e3", away_entrant_id: "e4", status: "in_play", summary: null },
      {
        id: "final", stage_id: "ko", round_no: 2, seq_in_round: 1,
        home_entrant_id: null, away_entrant_id: null, status: "scheduled", summary: null,
        home_slot_label: { key: "slot.winner_match", params: { round: 1, seq: 1 } },
        away_slot_label: { key: "slot.winner_match", params: { round: 1, seq: 2 } },
      },
    ],
  };
  const TITLE_KEYS = ["slideshow.slide.inPlay", "slideshow.slide.latestResults", "slideshow.slide.comingUp"] as const;

  for (const locale of ["en", "fr"] as const) {
    it(`${locale}: the fixtures slide AND the bracket slide name the final's waiting sides by the semi-finals' round, never an R·code`, async () => {
      const slides = await buildPublicDivisionSlides({ ...knockout, orgLocale: locale });

      const dict = await getDictionary(locale, "public");
      const semi = msgFor(locale, "bracket.round.semi");
      const expected = [1, 2].map((seq) => t(dict, "knockout.feederWinner", { round: semi, seq }));
      if (locale === "en") expect(expected).toEqual(["Winner of Semi-finals, match\u00a01", "Winner of Semi-finals, match\u00a02"]);
      else {
        const en = t(await getDictionary("en", "public"), "knockout.feederWinner", { round: msgFor("en", "bracket.round.semi"), seq: 1 });
        expect(expected[0], "the premise: the fr sentence is not the English one").not.toBe(en);
      }

      const upcoming = slides.find(
        (s): s is Extract<(typeof slides)[number], { kind: "fixtures" }> => s.kind === "fixtures" && s.items.some((i) => i.round === 2),
      );
      expect(upcoming, "the final is on a fixtures slide").toBeDefined();
      const final = upcoming!.items.find((i) => i.round === 2)!;
      expect([final.home, final.away]).toEqual(expected);

      const bracket = slides.find((s) => s.kind === "bracket") as { fixtures: { id: string; home: string | null; away: string | null }[] } | undefined;
      expect(bracket, "the knockout lays out as a bracket slide").toBeDefined();
      const node = bracket!.fixtures.find((f) => f.id === "final")!;
      expect([node.home, node.away]).toEqual(expected);

      expect(JSON.stringify(slides.map((s) => (s.kind === "bracket" ? s.fixtures.map((f) => [f.home, f.away]) : s)))).not.toMatch(/R\d+·\d+/);
    });
  }

  it("a bracket side with NO label keeps the bracket's own 'to be decided' (bracket.tbd), a fixtures slide keeps schedule.tbd", async () => {
    const unlabelled = {
      ...knockout,
      fixtures: knockout.fixtures.map((f) => (f.id === "final" ? { ...f, home_slot_label: null, away_slot_label: null } : f)),
    };
    const slides = await buildPublicDivisionSlides({ ...unlabelled, orgLocale: "fr" });
    expect(msgFor("fr", "bracket.tbd"), "the premise: the two fr 'to be decided' strings differ").not.toBe(msgFor("fr", "schedule.tbd"));
    const bracket = slides.find((s) => s.kind === "bracket") as { fixtures: { id: string; home: string | null }[] };
    expect(bracket.fixtures.find((f) => f.id === "final")!.home).toBe(msgFor("fr", "bracket.tbd"));
    const upcoming = slides.find(
      (s): s is Extract<(typeof slides)[number], { kind: "fixtures" }> => s.kind === "fixtures" && s.items.some((i) => i.round === 2),
    );
    expect(upcoming!.items.find((i) => i.round === 2)!.home).toBe(msgFor("fr", "schedule.tbd"));
  });

  // A `timing: "setup"` progression bracket leaves a sibling-fed seat's STORED
  // label null on purpose — the feed edges are the only thing that knows who
  // feeds it. The kiosk is a public surface like any other and has to read the
  // same sentence the share page does; before this it printed "to be decided"
  // on both slides.
  //
  // Driving it through the real builder is the point: the bracket slide's
  // seat used to be `f.home_slot_label ? namer.seat(...) : tbd`, which reads
  // correctly and short-circuits on exactly this shape, so the namer was never
  // reached. A test that only fed it a STORED label could never see that.
  it("a seat with no stored label but a known FEED EDGE names its feeder on BOTH slides", async () => {
    const fedByEdges = {
      ...knockout,
      fixtures: knockout.fixtures.map((f) =>
        f.id === "final"
          ? { ...f, home_slot_label: null, away_slot_label: null }
          : { ...f, winner_to_fixture: "final", winner_to_slot: f.id === "semi-1" ? 1 : 2 },
      ),
    };
    const slides = await buildPublicDivisionSlides({ ...fedByEdges, orgLocale: "fr" });
    const dict = await getDictionary("fr", "public");
    const semi = msgFor("fr", "bracket.round.semi");
    const expected = [1, 2].map((seq) => t(dict, "knockout.feederWinner", { round: semi, seq }));
    // The premise, stated rather than assumed: the sentence under test is not
    // either "to be decided" word, so the assertions below cannot pass on the
    // old behaviour.
    expect(expected[0]).not.toBe(msgFor("fr", "bracket.tbd"));
    expect(expected[0]).not.toBe(msgFor("fr", "schedule.tbd"));

    const bracket = slides.find((s) => s.kind === "bracket") as {
      fixtures: { id: string; home: string | null; away: string | null }[];
    };
    const node = bracket.fixtures.find((f) => f.id === "final")!;
    expect([node.home, node.away], "the bracket slide still shows an unfed seat").toEqual(expected);

    const upcoming = slides.find(
      (s): s is Extract<(typeof slides)[number], { kind: "fixtures" }> =>
        s.kind === "fixtures" && s.items.some((i) => i.round === 2),
    );
    const final = upcoming!.items.find((i) => i.round === 2)!;
    expect([final.home, final.away], "the fixtures slide still shows an unfed seat").toEqual(expected);
  });

  it("fr: the in-play, latest-results and coming-up slides take their titles from the dictionary in the org's locale", async () => {
    const slides = await buildPublicDivisionSlides({ ...knockout, orgLocale: "fr" });
    for (const k of TITLE_KEYS) expect(msgFor("fr", k), `the premise: fr ${k} differs from en`).not.toBe(msgFor("en", k));
    const titles = slides.filter((s) => s.kind === "fixtures").map((s) => (s as { title: string }).title);
    expect(titles).toEqual(TITLE_KEYS.map((k) => msgFor("fr", k)));
  });

  it("no orgLocale: the titles are the en dictionary's, unchanged for every existing caller", async () => {
    const slides = await buildPublicDivisionSlides(knockout);
    const titles = slides.filter((s) => s.kind === "fixtures").map((s) => (s as { title: string }).title);
    expect(titles).toEqual(TITLE_KEYS.map((k) => msgFor("en", k)));
  });
});
