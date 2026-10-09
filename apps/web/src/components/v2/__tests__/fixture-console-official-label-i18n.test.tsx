// The console names the sport's official in the viewer's locale on all three
// surfaces that name it (scorer sheets T3, fix round 3). Before, each one
// interpolated the engine's English `officialLabel.scorer` ("Referee"), so a
// French organiser read English mid-sentence:
//
//   1. a device-link row's provenance — `score.courtsidePad` (was :782);
//   2. a row recorded by a user the page has no name for — the bare label as
//      the recorder (was :784);
//   3. the match-details line — `score.recordedBy` (was :966).
//
// Rendered through the REAL `<DictProvider>` per locale (no `useMsg` mock),
// on the same console harness as `fixture-console-one-ledger.test.tsx`. Each
// surface has its own test so a revert of one site reds a named case.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { EventEnvelope } from "@seazn/engine/core";
import { builtinModules } from "@seazn/engine/sports";
import { DictProvider } from "@/components/i18n/dict-provider";
import { FixtureConsole } from "@/components/v2/fixture-console";
import type { EventIn, LiveState, SideInfo, SportInfo } from "@/components/v2/fixture-console";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import { officialLabelKey } from "@/lib/official-label";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const football = builtinModules.find((m) => m.key === "football")!;
const CFG = football.configSchema.parse(
  (football.variants as Record<string, unknown> | undefined)?.["11-a-side"] ?? {},
);
/** The engine's own English word — what leaked. */
const ENGLISH = football.officialLabel.scorer;

const sport: SportInfo = {
  key: "football",
  config: {},
  scorerLabel: ENGLISH,
  positionGroups: [],
  roles: [],
  lineupSize: 11,
  benchMax: 5,
};

const side = (id: string, name: string): SideInfo => ({ id, name, members: [], lineup: [] });

const row = (seq: number, over: Partial<EventIn>): EventIn => ({
  id: `ev-${seq}`,
  seq,
  type: "football.goal",
  payload: { by: "e-home" },
  recorded_at: `2026-08-30T10:0${seq}:00.000Z`,
  recorded_by: null,
  voids_event_id: null,
  device_link_id: null,
  ...over,
});
const ROWS: EventIn[] = [
  row(1, { type: "core.start", payload: {}, recorded_by: "user-1" }),
  // Surface 1: the handed device.
  row(2, { device_link_id: "link-9" }),
  // Surface 2: a signed-in recorder the page has no name for.
  row(3, { recorded_by: "user-unnamed" }),
];
const ENVELOPES: readonly EventEnvelope[] = ROWS.map((r) => ({
  id: r.id,
  fixtureId: "f1",
  seq: r.seq,
  type: r.type,
  payload: r.payload,
  recordedAt: r.recorded_at,
  recordedBy: r.recorded_by ?? null,
}));

const DICTS: Record<Locale, Dict> = { en, es, fr, nl } as Record<Locale, Dict>;
const LOCALES = Object.keys(DICTS) as Locale[];

function consoleHtml(locale: Locale): string {
  const live: LiveState = { status: "in_play", last_seq: 3, summary: { headline: "2 — 0" }, state: {}, outcome: null };
  return renderToStaticMarkup(
    <DictProvider dict={DICTS[locale]} locale={locale}>
      <FixtureConsole
        fixture={{ id: "f1", status: "in_play", scheduled_at: null, venue_name: null, court_name: null, round_no: 1 }}
        sport={sport}
        home={side("e-home", "Riverside FC")}
        away={side("e-away", "Summit Athletic")}
        initialState={live}
        initialEvents={ROWS}
        canEdit
        canOrganise
        stageKind={null}
        recorderNames={{ "user-1": "Dana Okafor" }}
        audit={{ verified: true, tamperedSeq: null, entitled: true }}
        scorePadV2={{
          moduleVersion: football.version,
          resolvedConfig: CFG,
          initialEvents: ENVELOPES,
          entitlements: {},
          stageKind: null,
          identity: { recordedBy: "user-1", deviceLinkId: null },
        }}
        viewerPlan="community"
      />
    </DictProvider>,
  );
}

/** The text of every provenance line, tags stripped (ClientTime nests one). */
function provenanceTexts(html: string): string[] {
  return html
    .split('data-role="v3-activity-provenance"')
    .slice(1)
    .map((chunk) => chunk.slice(chunk.indexOf(">") + 1, chunk.indexOf("</li>") > 0 ? chunk.indexOf("</li>") : 600))
    .map((s) => s.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim());
}

const englishWord = new RegExp(`\\b${ENGLISH}\\b`, "i");
const labelIn = (locale: Locale) => t(DICTS[locale], officialLabelKey("football"));

describe("the console names the official in the viewer's locale (T3 fix round 3)", () => {
  it("every non-English locale has its own word for football's official (else the negatives below are vacuous)", () => {
    for (const locale of LOCALES.filter((l) => l !== "en")) {
      expect(labelIn(locale).toLowerCase(), locale).not.toBe(ENGLISH.toLowerCase());
    }
    expect(labelIn("en")).toBe(ENGLISH);
  });

  it.each(LOCALES)("%s: the device-link row's provenance says 'courtside pad' with that locale's official (was :782)", (locale) => {
    const lines = provenanceTexts(consoleHtml(locale));
    const courtside = t(DICTS[locale], "score.courtsidePad", { scorer: labelIn(locale).toLowerCase() });
    expect(lines.some((l) => l.includes(courtside)), `${courtside} in ${JSON.stringify(lines)}`).toBe(true);
    if (locale !== "en") expect(lines.filter((l) => englishWord.test(l))).toEqual([]);
  });

  it.each(LOCALES)("%s: a recorder with no name falls back to that locale's official, never English (was :784)", (locale) => {
    const lines = provenanceTexts(consoleHtml(locale));
    const fallback = t(DICTS[locale], "pad.activity.recordedBy", { name: labelIn(locale) });
    expect(lines.some((l) => l.includes(fallback)), `${fallback} in ${JSON.stringify(lines)}`).toBe(true);
    if (locale !== "en") {
      expect(lines.some((l) => l.includes(t(DICTS[locale], "pad.activity.recordedBy", { name: ENGLISH })))).toBe(false);
    }
  });

  it.each(LOCALES)("%s: the match-details line says who records, with that locale's official (was :966)", (locale) => {
    const html = consoleHtml(locale).replace(/&#x27;/g, "'");
    expect(html).toContain(t(DICTS[locale], "score.recordedBy", { scorer: labelIn(locale).toLowerCase() }));
    if (locale !== "en") {
      expect(html).not.toContain(t(DICTS[locale], "score.recordedBy", { scorer: ENGLISH.toLowerCase() }));
    }
  });
});
