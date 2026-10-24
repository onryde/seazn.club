// W2c Batch-5 fix, review I-1 — the banner a scoring pad shows when a match's format is corrected, and the `format` the
// 409 FIXTURE_RULES_CHANGED names, say what the PUBLIC line says (the match centre's, the stage chip's).
//
// The public line is the format, then how a tied match ENDS (the stage kind's deciders), then an abandon policy the
// stage changed (`matchRulesLine`, describe-rules.ts). The banner used to be the format alone, so a correction that
// moves ONLY a decider — football's extra time switched off, a shoot-out of three kicks instead of five — showed the
// scorer "The organiser corrected this match's format" over a line that had not changed. The pad folds the right cfg
// either way; the one thing the banner exists to say was missing.
//
// Every expected line is built here from the ENGINE's declarations (the variant's parsed config, the knockout preset a
// created stage stores) and the en public dictionary — never from `matchRulesLine`/`describeMatchRules`, which the old
// T15 oracles used and which therefore mirrored the code under test (`rules-version.test.ts`). The independent witness
// is the match centre: `getPublicFixture` and the poll's `publicFixture` read the line through their own seam
// (`match-centre-load.ts`), so a banner that drifted from it reds here.
//
// Real Postgres; skipped without DATABASE_URL.
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));

import { builtinModules } from "@seazn/engine/sports";
import { deciderKeysFor, stageDefaultsFor, type AnySportModule } from "@seazn/engine/sport";
import enPublic from "@/dictionaries/en/public.json";
import enUi from "@/dictionaries/en/ui.json";
import { sql } from "@/lib/db";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import { decidersOffRules } from "@/lib/stage-decider-off";
import { resolveLatestModule } from "@/server/engine-db";
import { getPublicFixture } from "@/server/public-site/data";
import type { MatchCentreDocT } from "@/server/public-site/match-centre-schema";
import { seedDecidersScene, type DecidersScene } from "@/server/public-site/__tests__/_stage-rules-scene";
import { publicFixture } from "../public";
import { writeFixtureRulesOverride } from "../fixture-rules";
import { getFixtureRules } from "../fixtures";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { putStageRules } from "../stage-rules";

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const EN = enPublic as unknown as Dict;
const EN_UI = enUi as unknown as Record<string, string>;
const line = (...clauses: string[]) => clauses.join(", ");

/** The match centre's Info-tab format row for a fixture, through the page's loader and the poll's: the label the
 *  spectator reads (a stage that plays the division's own rules keeps the preset NAME there). */
async function publicLines(s: DecidersScene, fixtureId: string): Promise<{ page: string; poll: string }> {
  const read = (doc: MatchCentreDocT) => String(doc.info.rows.find((r) => r.label.key === "matchCentre.info.format")?.value.params?.format);
  const data = await getPublicFixture(s.orgSlug, s.compSlug, s.divSlug, fixtureId);
  expect(data, "the seeded fixture must be publicly visible").not.toBeNull();
  const polled = (await publicFixture(fixtureId)) as { match_centre: MatchCentreDocT };
  return { page: read(data!.matchCentre), poll: read(polled.match_centre) };
}

/** The 409's English sentence, read off the dictionary (the server's English IS the en dictionary). */
const refusalSentence = (format: string) => EN_UI["rules.err.fixtureRulesChanged"]!.replace("{format}", format);

// ---------------------------------------------------------------------------------------------------------------------
// football: the extra-time and penalty clauses, derived from the engine's own declarations.
// ---------------------------------------------------------------------------------------------------------------------
const FB = resolveLatestModule("football");
const FB_VARIANT = "11-a-side";
const FB_CFG = FB.configSchema.parse(FB.variants[FB_VARIANT]) as { halfMinutes: number };
const FB_PRESET = stageDefaultsFor(FB, "knockout", FB_VARIANT) as {
  extraTime: { enabled: boolean; halfMinutes: number };
  shootoutAttempts: number;
};
const HALVES = t(EN, "format.rules.period.halves", { minutes: FB_CFG.halfMinutes });
const EXTRA = t(EN, "format.rules.decider.extraTime", { n: FB_PRESET.extraTime.halfMinutes });
const PENS = (n: number) => t(EN, "format.rules.decider.penalties", { n });
/** A shoot-out shorter than the preset's (the live override's bound is "shorter"), by two kicks. */
const SHORT_ATTEMPTS = FB_PRESET.shootoutAttempts - 2;

interface Correction {
  name: string;
  /** The stage's rules fragment (the pre-kickoff writer). */
  rules: Record<string, unknown>;
  /** The match's own fragment (the live writer): the same change as a match-scoped key. Absent where a match cannot
   *  make it (shorter halves are not a live correction a match may make beyond its stage's bound). */
  override?: Record<string, unknown>;
  /** What the corrected match's line must say — and what it must NOT (the cleared clause). */
  after: string;
  gone?: string;
}
const CORRECTIONS: readonly Correction[] = [
  {
    name: "extra time switched off",
    rules: { extraTime: { ...FB_PRESET.extraTime, enabled: false } },
    override: { extraTime: { ...FB_PRESET.extraTime, enabled: false } },
    after: line(HALVES, PENS(FB_PRESET.shootoutAttempts)),
    gone: EXTRA,
  },
  {
    name: "shoot-out attempts shortened",
    rules: { shootoutAttempts: SHORT_ATTEMPTS },
    override: { shootoutAttempts: SHORT_ATTEMPTS },
    after: line(HALVES, EXTRA, PENS(SHORT_ATTEMPTS)),
    gone: PENS(FB_PRESET.shootoutAttempts),
  },
  {
    // Every decider off: a knockout that cannot end level says so ("level matches wait for the organiser"), which only
    // the stage KIND lets the line say. The halves are shorter too, so the stage differs from its division and the
    // public line is a described one rather than the preset name.
    name: "every decider off, shorter halves",
    rules: { ...decidersOffRules(FB, FB_VARIANT, "knockout"), halfMinutes: FB_CFG.halfMinutes - 5 },
    after: line(t(EN, "format.rules.period.halves", { minutes: FB_CFG.halfMinutes - 5 }), t(EN, "format.rules.decider.none")),
    gone: EXTRA,
  },
];
const LIVE_CORRECTIONS = CORRECTIONS.filter((c) => c.override !== undefined);
const BEFORE = line(HALVES, EXTRA, PENS(FB_PRESET.shootoutAttempts));
const checked = { n: 0 };

/** The scene, with its division STARTED: scoring is closed until it is, and a pad is only open on a started division.
 *  Starting freezes nothing (a fixture's cfg freezes at its first event), so the pre-kickoff writers still apply. */
async function startedScene(sportKey: string, variantKey: string, entrantKind?: "team" | "individual"): Promise<DecidersScene> {
  const s = await seedDecidersScene({ sportKey, variantKey, entrantKind });
  await startDivision(s.auth, s.divisionId);
  return s;
}

describe.skipIf(!HAS_DB)("I-1 football knockout: a decider-only correction changes the banner line and the 409's format, and both equal the match centre's", () => {
  it("premise: the declarations differ where the corrections claim, so a banner stuck on the period line cannot pass", () => {
    expect(FB_PRESET.extraTime.enabled, "the knockout preset plays extra time").toBe(true);
    expect(SHORT_ATTEMPTS, "the shorter shoot-out is a real, different, positive number").toBeGreaterThan(0);
    expect(SHORT_ATTEMPTS).not.toBe(FB_PRESET.shootoutAttempts);
    for (const c of CORRECTIONS) expect(c.after, c.name).not.toBe(BEFORE);
  });

  it.each(CORRECTIONS)("before kickoff ($name, the stage's rules): GET /rules, the 409 and the public line agree", async (c) => {
    const s = await startedScene("football", FB_VARIANT);
    const id = s.cupFixtureId;
    // The preset NAME, as the match centre prints it for a fixture that plays the division's own rules (the Pool's): read off
    // the page, not typed (a typed variant key here once named a message that does not exist, and the assertion below it
    // compared against the key itself).
    const preset = (await publicLines(s, s.leagueFixtureId)).poll;
    expect(preset, "premise: the preset name is a real line, and not the cup's described one").not.toBe(BEFORE);
    expect(preset.length, "premise: and it is not empty").toBeGreaterThan(0);

    const before = await getFixtureRules(s.auth, id, EN);
    expect(before.format_line, "the cup's line before: the period line then both deciders").toBe(BEFORE);
    expect((await publicLines(s, id)).poll, "premise: the public line is the described one, not the preset name").toBe(BEFORE);

    await putStageRules(s.auth, s.cupStageId, { rules: c.rules });
    const after = await getFixtureRules(s.auth, id, EN);
    expect(after.rules_version, "the stage save moved the version the pad compares").toBe(before.rules_version + 1);
    expect(after.format_line, `${c.name}: the banner line says the corrected deciders`).toBe(c.after);
    expect(after.format_line, "the banner line CHANGED (it used to repeat the period line)").not.toBe(before.format_line);
    if (c.gone !== undefined) expect(after.format_line, "the cleared clause is gone").not.toContain(c.gone);

    const pub = await publicLines(s, id);
    expect(pub.poll, "premise: the match centre states the rules, not the preset name").not.toBe(preset);
    expect(after.format_line, "the banner equals the match centre's line (poll)").toBe(pub.poll);
    expect(after.format_line, "the banner equals the match centre's line (page)").toBe(pub.page);

    await expect(scoreEvent(s.auth, id, { expected_seq: 0, type: "core.start", payload: {}, rules_version: before.rules_version })).rejects.toMatchObject({
      status: 409,
      code: "FIXTURE_RULES_CHANGED",
      extra: { rules_version: after.rules_version, format: c.after },
      message: refusalSentence(c.after),
    });
    checked.n++;
  }, 90_000);

  it.each(LIVE_CORRECTIONS)("live ($name, the match's own correction): GET /rules, the 409 and the public line agree", async (c) => {
    const s = await startedScene("football", FB_VARIANT);
    const id = s.cupFixtureId;
    const started = await scoreEvent(s.auth, id, { expected_seq: 0, type: "core.start", payload: {} });
    const before = await getFixtureRules(s.auth, id, EN);
    expect(before.format_line).toBe(BEFORE);

    await writeFixtureRulesOverride(s.auth, [id], c.override!);
    const after = await getFixtureRules(s.auth, id, EN);
    expect(after.rules_version, "the live correction moved the version").toBe(before.rules_version + 1);
    expect(after.format_line).toBe(c.after);
    expect(after.format_line).not.toBe(before.format_line);
    if (c.gone !== undefined) expect(after.format_line).not.toContain(c.gone);

    const pub = await publicLines(s, id);
    expect(after.format_line, "the banner equals the match centre's line (poll)").toBe(pub.poll);
    expect(after.format_line, "the banner equals the match centre's line (page)").toBe(pub.page);

    await expect(
      scoreEvent(s.auth, id, { expected_seq: started.seq, type: "football.period", payload: { phase: "HT" }, rules_version: before.rules_version }),
    ).rejects.toMatchObject({
      status: 409,
      code: "FIXTURE_RULES_CHANGED",
      extra: { rules_version: after.rules_version, format: c.after },
      message: refusalSentence(c.after),
    });
    checked.n++;
  }, 90_000);

  it("a Pool (league) fixture's banner names no decider: the stage kind decides, so the same sport's table match is the period line alone", async () => {
    const s = await startedScene("football", FB_VARIANT);
    const pool = await getFixtureRules(s.auth, s.leagueFixtureId, EN);
    expect(pool.format_line, "a drawn league match is a result: no extra time, no penalties, no 'level matches'").toBe(HALVES);
    const cup = await getFixtureRules(s.auth, s.cupFixtureId, EN);
    expect(cup.format_line, "the same division, the other kind").not.toBe(pool.format_line);
    checked.n++;
  }, 90_000);

  it("the abandon policy rides the line when the stage CHANGED it from the division's, as on the public line — and not otherwise", async () => {
    const s = await startedScene("football", FB_VARIANT);
    const id = s.cupFixtureId;
    const before = await getFixtureRules(s.auth, id, EN);
    expect(before.format_line, "premise: the division's policy (replay) is the stage's, so no abandon clause").not.toContain(
      t(EN, "format.rules.abandon.replay"),
    );
    await putStageRules(s.auth, s.cupStageId, { rules: { abandonPolicy: "award" } });
    const after = await getFixtureRules(s.auth, id, EN);
    const award = t(EN, "format.rules.abandon.award");
    expect(after.format_line, "the changed policy is the third part of the line").toBe(line(BEFORE, award));
    const pub = await publicLines(s, id);
    expect(after.format_line).toBe(pub.poll);
    expect(after.format_line).toBe(pub.page);
    // The 409 composes the same line from its OWN reads (append-event.ts hands `matchRulesLine` the DIVISION's cfg, the
    // abandon clause's baseline), so GET /rules agreeing says nothing about it: tap under the version the pad loaded.
    // A 409 that passed the match's own cfg as that baseline (which already carries the stage's policy) loses the clause.
    await expect(
      scoreEvent(s.auth, id, { expected_seq: 0, type: "core.start", payload: {}, rules_version: before.rules_version }),
    ).rejects.toMatchObject({
      status: 409,
      code: "FIXTURE_RULES_CHANGED",
      extra: { rules_version: after.rules_version, format: line(BEFORE, award) },
      message: refusalSentence(line(BEFORE, award)),
    });
    checked.n++;
  }, 90_000);

  it("anti-vacuity: every scenario above ran its comparison", () => {
    // every correction before kickoff + each live-able one live + the pool + the abandon case.
    expect(LIVE_CORRECTIONS.length, "premise: the live arm has corrections").toBeGreaterThanOrEqual(2);
    expect(checked.n).toBe(CORRECTIONS.length + LIVE_CORRECTIONS.length + 2);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// hockey: a shoot-out of three attempts. Another sport, another decider shape (`{attempts, ...}` not a boolean + a count).
// ---------------------------------------------------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("I-1 hockey knockout: a shoot-out correction changes the banner line and equals the match centre's", () => {
  it("the banner says the new attempts, and the 409 names the same line", async () => {
    const m = resolveLatestModule("hockey");
    const variant = "fih-outdoor";
    const cfg = m.configSchema.parse(m.variants[variant]) as { periods: { minutes: number } };
    const preset = stageDefaultsFor(m, "knockout", variant) as { shootout: { attempts: number } };
    const attempts = preset.shootout.attempts - 2;
    expect(attempts, "premise: a real shorter shoot-out").toBeGreaterThan(0);
    const quarters = t(EN, "format.rules.period.quarters", { minutes: cfg.periods.minutes });
    const beforeLine = line(quarters, t(EN, "format.rules.decider.shootout", { n: preset.shootout.attempts }));
    const afterLine = line(quarters, t(EN, "format.rules.decider.shootout", { n: attempts }));
    expect(afterLine).not.toBe(beforeLine);

    const s = await startedScene("hockey", variant);
    const id = s.cupFixtureId;
    const before = await getFixtureRules(s.auth, id, EN);
    expect(before.format_line).toBe(beforeLine);
    await putStageRules(s.auth, s.cupStageId, { rules: { shootout: { ...preset.shootout, attempts } } });
    const after = await getFixtureRules(s.auth, id, EN);
    expect(after.format_line).toBe(afterLine);
    const pub = await publicLines(s, id);
    expect(after.format_line).toBe(pub.poll);
    expect(after.format_line).toBe(pub.page);
    await expect(
      scoreEvent(s.auth, id, { expected_seq: 0, type: "core.start", payload: {}, rules_version: before.rules_version }),
    ).rejects.toMatchObject({ code: "FIXTURE_RULES_CHANGED", extra: { rules_version: after.rules_version, format: afterLine } });
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int n from score_events where fixture_id = ${id}`;
    expect(n, "the refused tap wrote nothing").toBe(0);
  }, 90_000);
});

// ---------------------------------------------------------------------------------------------------------------------
// Every sport that declares a decider (the registry's own `deciderKeysFor`, not a list typed here): the banner and the
// public line are one composition, fresh and after the stage switches its deciders off.
// ---------------------------------------------------------------------------------------------------------------------
const swept = { n: 0, compared: 0 };
const DECIDER_SPORTS = (builtinModules as readonly AnySportModule[]).filter((m) => deciderKeysFor(m, null, null).length > 0);

describe.skipIf(!HAS_DB)("I-1 every decider sport: the banner's line is the match centre's, fresh and after the stage's deciders are switched off", () => {
  it("premise: the registry has decider sports to sweep (zero is a failure)", () => {
    expect(DECIDER_SPORTS.length).toBeGreaterThanOrEqual(6);
  });

  it.each(DECIDER_SPORTS.map((m) => [m.key, m] as const))("%s", async (_key, m) => {
    const variant = Object.keys(m.variants)[0]!;
    // single-kind note: the entrant kind is the sport's own default (team sports take no other).
    const kind = (m.entrantModel?.defaultKind ?? "individual") as "team" | "individual";
    const s = await startedScene(m.key, variant, kind);
    const id = s.cupFixtureId;
    const compare = async (when: string) => {
      const banner = (await getFixtureRules(s.auth, id, EN)).format_line;
      const pub = await publicLines(s, id);
      expect(banner, `${m.key} ${when}: the banner says something`).not.toBeNull();
      expect(pub.page, `${m.key} ${when}: the two public loaders agree`).toBe(pub.poll);
      return { banner: banner!, pub: pub.poll };
    };
    const fresh = await compare("fresh");
    // The cup plays the sport's knockout preset: its deciders are in the line (the public line is the described one
    // exactly when the stage differs from the division; where it keeps the preset NAME the banner still states rules).
    // The preset name, as the match centre prints it for a fixture that plays the division's own rules: the Pool's.
    const presetName = (await publicLines(s, s.leagueFixtureId)).poll;
    if (fresh.pub !== presetName) {
      expect(fresh.banner, `${m.key}: fresh banner = match centre`).toBe(fresh.pub);
      swept.compared++;
    }

    const before = fresh.banner;
    const off = decidersOffRules(m, variant, "knockout");
    const bumped = (await getFixtureRules(s.auth, id, EN)).rules_version;
    await putStageRules(s.auth, s.cupStageId, { rules: off });
    const afterRules = await getFixtureRules(s.auth, id, EN);
    const after = await compare("deciders off");
    if (afterRules.rules_version !== bumped) {
      // The save moved what the match plays: the banner's line is NOT the stale one, and still the public one.
      expect(after.banner, `${m.key}: a save that moved the version moved the line`).not.toBe(before);
    }
    if (after.pub !== presetName) {
      expect(after.banner, `${m.key}: banner = match centre after the switch-off`).toBe(after.pub);
      swept.compared++;
    }
    swept.n++;
  }, 120_000);

  it("anti-vacuity: every decider sport ran, and the banner was compared with a described public line for each", () => {
    expect(swept.n).toBe(DECIDER_SPORTS.length);
    // The public line is the described one only where the stage differs from its division; each sport's fresh cup does.
    expect(swept.compared, "banner = match centre comparisons").toBeGreaterThanOrEqual(DECIDER_SPORTS.length);
  });
});
