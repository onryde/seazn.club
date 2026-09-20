"use client";

// Division builder (PROMPT-15 task 1): sport → variant → match rules →
// eligibility template → stage graph. Creates the division, then its stages,
// then lands on the division console. Match-rule fields build the config
// override object, validated server-side by the pinned module's configSchema.
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { MatchRuleFields, SPORT_RULES, buildRuleOverride } from "./match-rules";
import {
  STAGE_TEMPLATES,
  applyStandingsCarry,
  buildTemplateStages,
  clampKnob,
  templateHasProgression,
  type StageDraft,
  type StandingsCarry,
} from "./format-templates";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { routes } from "@/lib/routes";
import { SWISS_ROUNDS_REQUIRED_CODE } from "@/lib/swiss-shell";
import { UpgradeGate } from "@/components/upgrade-gate";
import type { ViewerPlan } from "@/lib/viewer-plan";
import { doubleElimFormatReason } from "@/lib/feature-copy";
import { venueNoun, venueLabel, pluralizeVenue } from "@/lib/venue";
import { defaultMatchMinutes } from "@/lib/match-length";
import { FormatExplainerPanel } from "@/components/v2/format-explainer-panel";
import { FormatRecommendStrip } from "@/components/v2/format-recommend-strip";
import { DateTimeField } from "@/components/v2/shared/datetime-field";
import { CourtMultiPicker } from "@/components/v2/shared/court-multi-picker";
// P9: BOARD-side Venue — no calendar (see court-multi-picker.tsx).
import type { Venue } from "@/components/v2/shared/court-multi-picker";
import { useMsg, useLocale } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";
import { sportLabel } from "@/lib/scoring-vocab";
// RS007/V380: the wizard's Eligibility tab and the registration hub config
// panel edit the SAME first-class `category` column now (the jsonb
// `eligibility` array this replaced is gone) — the value union is imported
// rather than redeclared so the two screens can never drift onto two
// different "valid category" lists.
import type { DivisionCategoryValue } from "@/components/registration-hub-row-derive";
import {
  divisionEndBounds,
  divisionStartBounds,
  endDateIsBackwards,
  type CompetitionWindow,
} from "@/lib/date-order";

export interface SportOption {
  key: string;
  name: string;
  variants: { key: string; name: string; system: boolean }[];
}

// The most common variant to preselect per sport (else the first listed).
const PREFERRED_VARIANT: Record<string, string> = {
  cricket: "t20",
  tennis: "tour",
  icehockey: "iihf",
  hockey: "fih-outdoor",
};

function pickVariant(sportKey: string, variants: { key: string }[]): string {
  const pref = PREFERRED_VARIANT[sportKey.toLowerCase()];
  if (pref && variants.some((v) => v.key === pref)) return pref;
  return variants[0]?.key ?? "";
}

// Wizard template → format-gallery family (v3/06 §4 "How this works →").
const TEMPLATE_FAMILY: Record<string, string> = {
  league: "league",
  league_ko: "league",
  groups_ko: "groups-knockout",
  group_stepladder: "stepladder",
  group_playoffs: "page_playoff",
  swiss: "swiss",
  swiss_playoff: "swiss_playoff",
  swiss_knockout: "swiss_knockout",
  knockout: "knockout",
  double_elim: "double_elim",
  triple_rr: "league",
  americano: "americano",
  mexicano: "americano",
  ladder: "ladder",
};

// The Top N values the wizard's qualifier <select> offers, per template.
// ONE declaration, because the list is read TWICE — to render the options
// and to decide whether a carried-over `qualified` is still valid when the
// organiser switches template. The two used to be separate literals; a
// value offered by one and rejected by the other is how a chosen Top N
// silently snaps back to 4.
function qualifierOptionsFor(templateKey: string): readonly number[] {
  if (templateKey === "group_stepladder") return [3, 4, 5, 6];
  // Swiss Knockout's finals half is the GENERIC single-elimination bracket
  // (scheduling/bracket.ts pads to nextPowerOfTwo and byes the leaders), so
  // an odd Top N is a real shape rather than an error — 3 especially: the
  // qualifying winner waits while second plays third. The other templates
  // here feed brackets an organiser expects to be clean powers of two.
  //
  // The top of this list is load-bearing: format.swiss_knockout.body.1
  // promises "anything from 2 to 32" in all four locales, and the Settings
  // tab's own Top N input is min 2 / max 32. A wizard that stopped at 16 made
  // the marketing copy false and left the largest brackets reachable only
  // after the division already existed.
  if (templateKey === "swiss_knockout") return [2, 3, 4, 6, 8, 12, 16, 24, 32];
  return [2, 4, 8, 16];
}

// Recommendation slug → wizard template key (strip picks land here).
const FAMILY_TEMPLATE: Record<string, string> = {
  league: "league",
  "groups-knockout": "groups_ko",
  swiss: "swiss",
  knockout: "knockout",
  double_elim: "double_elim",
};

// Mirror of the server preview response (src/server/usecases/stages.ts).
interface PreviewMatch {
  home: string;
  away: string;
}
interface PreviewSection {
  title: string;
  matches: PreviewMatch[];
}
interface PreviewPhase {
  title: string;
  note?: string;
  sections: PreviewSection[];
}

// RS007/V380: single-select, mirroring the registration hub config panel's
// own category <select> (registration-hub-config-panel.tsx) — reusing ITS
// labels (`reg.hub.row.category.*`) rather than the retired `wizard.gender.*`
// keys, since both screens now edit the identical `category` column and the
// owner ruling is explicit that "Mixed" is not a gender chip any more (a
// roster-composition rule, `mixed`, not a per-person allow-list). A
// single-select (radio, not checkbox) so two chips can never again express a
// combination the column itself cannot hold.
const CATEGORIES: {
  key: DivisionCategoryValue;
  labelKey: "reg.hub.row.category.open" | "reg.hub.row.category.mens" | "reg.hub.row.category.womens" | "reg.hub.row.category.mixed";
}[] = [
  { key: "open", labelKey: "reg.hub.row.category.open" },
  { key: "mens", labelKey: "reg.hub.row.category.mens" },
  { key: "womens", labelKey: "reg.hub.row.category.womens" },
  { key: "mixed", labelKey: "reg.hub.row.category.mixed" },
];

/** A COMPLETE `datetime-local` value: both halves present. Anything shorter (a
 *  bare `YYYY-MM-DD`) is the half-filled state `joinValue` reports as "". */
const DATETIME_LOCAL_VALUE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** The schedule-settings body the wizard seeds right after create (doc 12 §3).
 *  `singleVenue` collapses the list to the first COURT (P9 scope item 5:
 *  `input.courts` are real `courts.id` uuids picked from the org's own list,
 *  in the organiser's chosen order — never free text, so there is nothing
 *  left to trim/dedupe/fall back on here): more than one court trips
 *  `usesConstraints()` server-side, which 402s the WHOLE PUT — dates and
 *  match length included — for orgs without `scheduling.constraints`. */
export function buildScheduleSeed(
  input: {
    courts: string[];
    matchMinutes: number;
    /** datetime-local value ("" = not set). */
    startAt: string;
    /** date value ("" = not set). */
    endAt: string;
  },
  opts: { singleVenue?: boolean } = {},
): { courts: string[]; matchMinutes: number; startAt: string | null; endAt: string | null } {
  return {
    courts: opts.singleVenue ? input.courts.slice(0, 1) : input.courts,
    matchMinutes: input.matchMinutes,
    // A HALF-FILLED start (a date with no time — what the competition-window
    // prefill seeds, and what `joinValue` already emits "" for) is unset, not
    // midnight: `new Date("2026-08-01")` is midnight UTC, which for a venue
    // west of UTC is the previous day on the venue clock and 422s against the
    // competition's own opening date.
    startAt: DATETIME_LOCAL_VALUE.test(input.startAt) ? new Date(input.startAt).toISOString() : null,
    endAt: input.endAt ? new Date(`${input.endAt}T23:59:00`).toISOString() : null,
  };
}

/**
 * The `formats.double_elim` gate's per-kind wording (feature-copy.ts's
 * `doubleElimFormatReason`), given the stage drafts THIS wizard is about to
 * submit — bug-fix follow-up 2026-08-18 (gate-copy): this wizard's own
 * "Group + Playoffs (IPL style)" card (`format-templates.ts`'s
 * `group_playoffs` template) builds a `page_playoff` stage exactly the way
 * the catalog "League + Playoffs" template does, and reached the SAME wrong
 * "Double-elimination brackets are a Pro format." wording, because
 * `<UpgradeGate feature={paywallFeature} />` only ever had the bare feature
 * key to go on.
 *
 * Pure, and takes the ALREADY-RESOLVED feature key (not the raw error) —
 * `submit()`'s catch block already extracts it once for `setPaywallFeature`,
 * so this reuses that rather than re-deriving it. Mirrors
 * template-gallery.tsx's `paywallFromError`, adapted to this component's own
 * `paywallFeature` (a plain string) plus a PARALLEL `paywallReason` state —
 * not one combined object — so every existing `paywallFeature` string
 * comparison (e.g. the archived-slot explainer below) stays untouched.
 * Returns undefined for every other feature key, exactly as before —
 * `<UpgradeGate>` then falls back to its own `featureReason(feature)`.
 */
export function paywallReasonForStages(featureKey: string, stages: StageDraft[]): string | undefined {
  if (featureKey !== "formats.double_elim") return undefined;
  const gatedStage = stages.find((s) => s.kind === "double_elim" || s.kind === "page_playoff");
  return doubleElimFormatReason(gatedStage?.kind ?? "double_elim");
}

// ---------------------------------------------------------------------------
export function DivisionBuilder({
  competitionId,
  orgSlug,
  compSlug,
  sports,
  venues = [],
  competitionWindow,
  constraintsAllowed = true,
  archivedSlotsExplainRefusal = false,
  viewerPlan,
}: {
  competitionId: string;
  orgSlug: string;
  compSlug: string;
  sports: SportOption[];
  /** Org venues with nested courts (`listVenues` shape, venues.ts) — feeds
   *  the Scheduling step's court multi-picker (P9 scope item 5). Optional/
   *  defaulted to `[]`: existing test call sites construct this wizard
   *  without it, and an empty list degrades to the picker's own "no courts
   *  yet" Directory pointer rather than a crash. */
  venues?: Venue[];
  /** The competition this division is being created inside — its own
   *  `starts_on`/`ends_on`. Both schedule fields carry it as `min`/`max`, and
   *  the start seeds its date half from the opening day, because the seed PUT
   *  this wizard fires after create is refused server-side when the range
   *  leaves that window (schedule.ts CONTAINMENT GUARD → 422) — and that PUT
   *  deliberately swallows every error, so an out-of-window range would
   *  otherwise vanish with no message at all. */
  competitionWindow?: CompetitionWindow;
  /** Pro `scheduling.constraints` — gates a multi-venue list (doc 12 §5). */
  constraintsAllowed?: boolean;
  /**
   * Would releasing this competition's ARCHIVED slot-holders (V354 — recorded
   * results, minus a staff waiver) let a refused create through? Answered
   * server-side by the page, from the same SQL predicate and the same
   * `withinLimit` call the quota charge itself uses.
   *
   * It exists only to explain a refusal that is otherwise invisible: an org
   * can be looking at ONE division and a "limit reached" paywall, with the
   * rest of its slots held by rows the console deliberately hides.
   *
   * A boolean rather than the COUNT it started as (#376 part C review). "There
   * are archived holders" is not "the archived holders are why you were
   * refused": at a cap of four with four visible divisions and one archived
   * holder, releasing it changes nothing, and the sentence would send the
   * reader to fix something that is not the cause. Half of that answer is a
   * quota limit, which is not a question a client component can ask.
   */
  archivedSlotsExplainRefusal?: boolean;
  viewerPlan: ViewerPlan;
}) {
  const msg = useMsg();
  const locale = useLocale();
  const router = useRouter();
  const [name, setName] = useState("");
  const [sportKey, setSportKey] = useState(sports[0]?.key ?? "");
  const sport = useMemo(() => sports.find((s) => s.key === sportKey), [sports, sportKey]);
  const [variantKey, setVariantKey] = useState(
    sport ? pickVariant(sport.key, sport.variants) : "",
  );
  // Match-rule values keyed by RuleField.key; "" = keep the variant default.
  const [ruleValues, setRuleValues] = useState<Record<string, string>>({});

  // Eligibility template (doc 06 §2): age cutoff + category + note. RS007/
  // V380: these map onto the first-class columns (category/age_max/
  // age_cutoff_month/age_cutoff_day/eligibility_note) on submit — see
  // eligibilityPatch() below — not the retired jsonb `eligibility` array.
  const [maxAge, setMaxAge] = useState("");
  const [cutoffMonth, setCutoffMonth] = useState("1");
  const [cutoffDay, setCutoffDay] = useState("1");
  const [category, setCategory] = useState<DivisionCategoryValue>("open");
  const [customNote, setCustomNote] = useState("");

  const [template, setTemplate] = useState("league");
  const [qualified, setQualified] = useState(4);
  const [swissRounds, setSwissRounds] = useState(5);
  const [poolCount, setPoolCount] = useState(2);
  const [legs, setLegs] = useState(1);
  const [standingsCarry, setStandingsCarry] = useState<StandingsCarry>("none");

  // Scheduling (optional — can also be edited later on the schedule board).
  // Real court ids picked from the org's own court list (P9 scope item 5) —
  // no fabricated default: an org may have zero courts at this point, and
  // there is no free-text name left to invent one from. Configuring courts
  // is fully deferrable to the schedule board after create.
  const [courts, setCourts] = useState<string[]>([]);
  const [matchMinutes, setMatchMinutes] = useState(() =>
    defaultMatchMinutes(sports[0]?.key, sports[0] ? pickVariant(sports[0].key, sports[0].variants) : ""),
  );
  // Once the organiser edits the length, stop auto-filling it from the sport.
  const [matchMinutesTouched, setMatchMinutesTouched] = useState(false);
  // datetime-local. Seeded with the competition's opening DAY (a bare
  // `YYYY-MM-DD`, which `splitValue` reads as "date set, time unset") so the
  // calendar opens on the right month without inventing a time-of-day:
  // `buildScheduleSeed` treats a half-filled value as unset, exactly as
  // `joinValue` does, so nothing is stored until the organiser picks a time.
  const [scheduleStart, setScheduleStart] = useState(() => competitionWindow?.startsOn ?? "");
  const [scheduleEnd, setScheduleEnd] = useState(""); // date

  const [tab, setTab] = useState<"basics" | "eligibility" | "format" | "scheduling">("basics");

  // "Show example" fixture preview (runs the real engine draw server-side).
  const [previewOpen, setPreviewOpen] = useState(false);
  const [explainOpen, setExplainOpen] = useState(false);
  const [previewCount, setPreviewCount] = useState(8);
  const [preview, setPreview] = useState<PreviewPhase[] | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [paywallFeature, setPaywallFeature] = useState<string | null>(null);
  // Parallel to paywallFeature rather than folded into one object, so every
  // existing `paywallFeature === "..."` comparison (the archived-slot
  // explainer below) is untouched. undefined outside the formats.double_elim
  // case — <UpgradeGate> then falls back to its own featureReason(feature).
  const [paywallReason, setPaywallReason] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  function selectSport(key: string) {
    setSportKey(key);
    const next = sports.find((s) => s.key === key);
    const firstVariant = next ? pickVariant(next.key, next.variants) : "";
    setVariantKey(firstVariant);
    setRuleValues({}); // rules are sport-specific
    if (!matchMinutesTouched) setMatchMinutes(defaultMatchMinutes(key, firstVariant));
    // `courts` (P9 scope item 5: real court ids from the picker) is no
    // longer a fabricated per-sport name — nothing to rename here on a sport
    // change any more; the organiser's own picked courts survive it.
  }

  /** RS007/V380: the CreateDivision columns this tab now writes directly
   *  (schemas.ts) — replaces the retired jsonb `eligibility` array this
   *  function used to build (a non-strict CreateDivision silently dropped
   *  that field entirely, which is the regression V380 exists to close).
   *  "open" collapses to `null` on write, mirroring the registration hub
   *  config panel's own convention (registration-hub-config-panel.tsx) so
   *  both screens store the SAME "no restriction" value, never two spellings
   *  of it. `age_min` is left unset — this tab has only ever offered a
   *  single "age group" (max-age) field; the fuller min+max band stays the
   *  hub panel's own, unchanged surface. */
  function eligibilityPatch(): {
    category: DivisionCategoryValue | null;
    age_max: number | null;
    age_cutoff_month: number | null;
    age_cutoff_day: number | null;
    eligibility_note: string | null;
  } {
    const age = Number(maxAge);
    // "U16" = 15 or younger on the cutoff (doc 06 §2.1) — always explicit,
    // same arithmetic this tab has always used.
    const hasAge = maxAge !== "" && Number.isInteger(age) && age > 0;
    return {
      category: category === "open" ? null : category,
      age_max: hasAge ? age - 1 : null,
      age_cutoff_month: hasAge ? Number(cutoffMonth) : null,
      age_cutoff_day: hasAge ? Number(cutoffDay) : null,
      eligibility_note: customNote.trim() ? customNote.trim() : null,
    };
  }

  function buildStages(): StageDraft[] {
    // B (round-4 review): poolCount is a free `<input type="number" min={2}
    // max={8}>` — HTML `min` doesn't stop a cleared field reading as
    // Number("")===0, which mints groups_ko's take rule with n:Infinity
    // (serialises as n:null over the wire) instead of a clean validation
    // message. qualified is a fixed <select> here (always one of a known-good
    // set) so this is defence-in-depth for it, not a live gap — same guard as
    // division-settings.tsx's free-text qualified input, for one shared
    // clampKnob (format-templates.ts) rather than two divergent ones.
    return applyStandingsCarry(
      buildTemplateStages(template, {
        qualified: clampKnob(qualified, 2, 32),
        swissRounds,
        poolCount: clampKnob(poolCount, 2, 8),
        legs,
      }),
      standingsCarry,
    );
  }

  async function submit() {
    // Guard: only the explicit Create button (on the last tab) may create.
    if (tab !== "scheduling") return;
    setError(null);
    setPaywallFeature(null);
    setPaywallReason(undefined);

    // A backwards range IS refused server-side now (`PutScheduleSettings`,
    // #498) — but that refusal arrives on the schedule-settings SEED PUT
    // below, which is deliberately non-fatal and swallows every error so a
    // paywalled court list cannot block the create. So without this check the
    // organiser gets no message at all and a division whose dates silently
    // did not save. The end-date input's `min=` is advisory only; a typed or
    // pasted value walks straight past it.
    //
    // `endDateIsBackwards` and the `min=` advisory below are one expression
    // (`startDay`), so the input cannot permit what this then rejects.
    if (endDateIsBackwards(scheduleStart, scheduleEnd)) {
      setError(msg("boardset.datesError"));
      return;
    }

    // Only rules the user actually set become overrides; the rest stay on
    // the variant's defaults.
    const overrides = buildRuleOverride(sportKey, ruleValues);

    setBusy(true);
    // Declared here, outside try{}, purely so the catch block below can
    // still read WHICH stage kinds were submitted (`const` inside try{} is
    // block-scoped to try{} alone). buildStages() is a pure, synchronous
    // read of wizard state — no network dependency — so hoisting only the
    // BINDING changes nothing about when it runs or what it POSTs; the
    // assignment below still happens at the exact same point it always did.
    let stages: StageDraft[] = [];
    try {
      const division = await apiV1<{ id: string; slug: string }>(
        `/api/v1/competitions/${competitionId}/divisions`,
        {
          method: "POST",
          json: {
            name,
            sport_key: sportKey,
            variant_key: variantKey,
            config: overrides,
            ...eligibilityPatch(),
          },
        },
      );
      stages = buildStages().map((s, i) => ({ ...s, seq: i + 1 }));
      await apiV1(`/api/v1/divisions/${division.id}/stages`, {
        method: "POST",
        json: stages,
      });

      // Seed scheduling settings (courts / match length / start+end). Non-fatal:
      // the board can set these later, so a failure here shouldn't block create.
      const seedInput = {
        courts,
        matchMinutes,
        startAt: scheduleStart,
        endAt: scheduleEnd,
      };
      const putSeed = (config: ReturnType<typeof buildScheduleSeed>) =>
        apiV1(`/api/v1/divisions/${division.id}/schedule-settings`, {
          method: "PUT",
          json: { config },
        });
      try {
        await putSeed(buildScheduleSeed(seedInput));
      } catch {
        // A multi-venue list needs Pro; without it the PUT 402s and the whole
        // tab (dates + match length too) would vanish silently. Retry with a
        // single venue so everything else still lands.
        try {
          await putSeed(buildScheduleSeed(seedInput, { singleVenue: true }));
        } catch {
          /* board settings are editable later — ignore */
        }
      }

      router.push(routes.division(orgSlug, compSlug, division.slug));
    } catch (err) {
      if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") {
        const feature = String(err.extra.feature_key ?? "");
        setPaywallFeature(feature);
        setPaywallReason(paywallReasonForStages(feature, stages));
      } else if (err instanceof ApiV1Error && err.code === "COMPETITION_ENDED") {
        // A finished competition does not grow (#376 part D). The server's
        // message is English-only, so the refusal is localised here rather
        // than shown raw — this is the only surface that creates a division.
        setError(msg("division.create.competitionEnded"));
      } else if (err instanceof ApiV1Error && err.code === SWISS_ROUNDS_REQUIRED_CODE) {
        // Same English-only-server reasoning as COMPETITION_ENDED above. The
        // wizard's Rounds box is `Number(e.target.value)` too, so an emptied
        // box posts 0 and the stages POST 422s — after the division itself has
        // already been created, which is why the organiser needs a sentence
        // naming Rounds rather than a raw wire message.
        setError(msg("stage.err.swissRoundsRequired"));
      } else {
        setError(err instanceof Error ? err.message : msg("wizard.failed"));
      }
      setBusy(false);
    }
  }

  const templateInfo = STAGE_TEMPLATES.find((t) => t.key === template);
  const venue = venueNoun(sportKey); // "pitch" / "table" / "court" / "board"
  const VenueCap = venueLabel(sportKey);

  // Wizard flow: Next validates the current tab before advancing.
  const TAB_ORDER = ["basics", "eligibility", "format", "scheduling"] as const;
  const tabIndex = TAB_ORDER.indexOf(tab);
  const isLastTab = tabIndex === TAB_ORDER.length - 1;

  function tabError(t: (typeof TAB_ORDER)[number]): string | null {
    if (t === "basics") {
      if (!name.trim()) return msg("wizard.err.name");
      if (!sportKey) return msg("wizard.err.sport");
      if (!variantKey) return msg("wizard.err.variant");
    }
    if (t === "eligibility" && maxAge) {
      const n = Number(maxAge);
      if (!Number.isInteger(n) || n <= 0) return msg("wizard.err.maxAge");
    }
    if (t === "scheduling") {
      if (!(matchMinutes >= 1)) return msg("wizard.err.matchLength");
      // No "must pick at least one court" gate any more (P9 scope item 5):
      // an org can have zero courts at create time, and `courts: []` is a
      // legitimate ScheduleConfig — configuring courts is fully deferrable
      // to the schedule board, same as leaving the dates blank already is.
    }
    return null;
  }

  function goNext() {
    const err = tabError(tab);
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    setTab(TAB_ORDER[Math.min(tabIndex + 1, TAB_ORDER.length - 1)]!);
  }

  // Any change to the format or its knobs invalidates a shown example.
  useEffect(() => {
    setPreview(null);
  }, [template, qualified, swissRounds, poolCount, legs, standingsCarry]);

  async function runPreview() {
    setPreviewError(null);
    setPreviewBusy(true);
    try {
      const { phases } = await apiV1<{ phases: PreviewPhase[] }>("/api/v1/format-preview", {
        method: "POST",
        json: { count: previewCount, stages: buildStages() },
      });
      setPreview(phases);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : msg("wizard.previewError"));
    } finally {
      setPreviewBusy(false);
    }
  }

  // Nav jumps: going back is free; going forward must clear the current tab.
  function goToTab(key: (typeof TAB_ORDER)[number]) {
    if (TAB_ORDER.indexOf(key) > tabIndex) {
      const err = tabError(tab);
      if (err) {
        setError(err);
        return;
      }
    }
    setError(null);
    setTab(key);
  }
  // Templates whose second stage is sized by the `qualified` knob, so the
  // wizard has to show the Top N control. swiss_knockout is here for the
  // same reason league_ko is: without it the builder would silently ship
  // every Swiss Knockout as a Top 4 (the state's default) with no control
  // on screen saying so — the same "no control anywhere that says so" trap
  // the swiss rounds knob already avoids in format-templates.ts.
  // group_playoffs is NOT here: the Page playoff is a fixed four.
  const hasSecondStage =
    template === "league_ko" ||
    template === "groups_ko" ||
    template === "group_stepladder" ||
    template === "swiss_knockout";
  const showStandingsCarry = templateHasProgression(template);

  return (
    <form onSubmit={(e) => e.preventDefault()} className="space-y-6">
      <nav className="flex flex-wrap gap-1 border-b border-slate-200">
        {(
          [
            ["basics", msg("wizard.tab.basics")],
            ["eligibility", msg("wizard.tab.eligibility")],
            ["format", msg("wizard.tab.format")],
            ["scheduling", msg("wizard.tab.scheduling")],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => goToTab(key)}
            className={`border-b-2 px-4 py-2 text-sm font-medium transition ${
              tab === key
                ? "border-purple-600 text-purple-700"
                : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
          >
            {label}
          </button>
        ))}
      </nav>

      <section className={`card space-y-4 p-6 ${tab === "basics" ? "" : "hidden"}`}>
        <h2 className="text-sm font-semibold text-slate-700">{msg("wizard.sportVariant")}</h2>
        <label className="block">
          <span className="label">{msg("wizard.divisionName")}</span>
          <input
            autoFocus
            required
            data-testid="division-builder-name"
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={msg("wizard.divisionNamePlaceholder")}
            className="input"
          />
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="label">{msg("wizard.sport")}</span>
            <select value={sportKey} onChange={(e) => selectSport(e.target.value)} className="select">
              {sports.map((s) => (
                <option key={s.key} value={s.key}>
                  {sportLabel(s.key, msg)}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">{msg("wizard.variant")}</span>
            <select
              value={variantKey}
              onChange={(e) => {
                setVariantKey(e.target.value);
                if (!matchMinutesTouched) setMatchMinutes(defaultMatchMinutes(sportKey, e.target.value));
              }}
              className="select"
            >
              {(sport?.variants ?? []).map((v) => (
                <option key={v.key} value={v.key}>
                  {v.name}
                  {v.system ? "" : msg("wizard.orgPreset")}
                </option>
              ))}
            </select>
          </label>
        </div>
        {(SPORT_RULES[sportKey] ?? []).length > 0 && (
          <div className="border-t border-slate-100 pt-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              {msg("wizard.matchRules")}
            </h3>
            <p className="mt-0.5 text-xs text-slate-400">{msg("wizard.matchRulesHint")}</p>
            <div className="mt-3">
              <MatchRuleFields sportKey={sportKey} values={ruleValues} onChange={setRuleValues} />
            </div>
          </div>
        )}
      </section>

      <section className={`card space-y-4 p-6 ${tab === "eligibility" ? "" : "hidden"}`}>
        <h2 className="text-sm font-semibold text-slate-700">{msg("wizard.tab.eligibility")}</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="block">
            <span className="label">{msg("wizard.ageGroup")}</span>
            <input
              type="number"
              min={4}
              max={99}
              value={maxAge}
              onChange={(e) => setMaxAge(e.target.value)}
              placeholder={msg("wizard.ageOpen")}
              className="input"
            />
          </label>
          <label className="block">
            <span className="label">{msg("wizard.cutoffMonth")}</span>
            <select
              value={cutoffMonth}
              onChange={(e) => setCutoffMonth(e.target.value)}
              className="select"
              disabled={!maxAge}
            >
              {Array.from({ length: 12 }, (_, i) => (
                <option key={i + 1} value={i + 1}>
                  {new Date(2000, i, 1).toLocaleString(locale, { month: "long" })}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">{msg("wizard.cutoffDay")}</span>
            <input
              type="number"
              min={1}
              max={31}
              value={cutoffDay}
              onChange={(e) => setCutoffDay(e.target.value)}
              className="input"
              disabled={!maxAge}
            />
          </label>
        </div>
        <fieldset data-testid="division-builder-category">
          <legend className="label">{msg("reg.hub.config.category")}</legend>
          <div className="flex flex-wrap gap-2">
            {CATEGORIES.map((c) => (
              <label
                key={c.key}
                /* The bench's organiser driver clicks THIS, not the input.
                 * The radio below is `sr-only` — clipped to a 1px box — so a
                 * real Playwright click on it is either "not visible" or
                 * intercepted by this label, and no node-env test can see
                 * either failure (apps/web vitest has no DOM). The hook lives
                 * on exactly one element per value so the selector stays
                 * strict-mode safe. Note the enclosing fieldset is closed on
                 * mount (`tab` defaults to "basics", :276) — a driver must
                 * open the eligibility tab before this exists. */
                data-category={c.key}
                className={`cursor-pointer rounded-full border px-3 py-1 text-xs transition ${
                  category === c.key
                    ? "border-purple-500 bg-purple-50 text-purple-700"
                    : "border-slate-200 text-slate-500 hover:border-purple-200"
                }`}
              >
                <input
                  type="radio"
                  name="division-category"
                  value={c.key}
                  checked={category === c.key}
                  onChange={() => setCategory(c.key)}
                  className="sr-only"
                />
                {msg(c.labelKey)}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="block">
          <span className="label">{msg("wizard.customRule")}</span>
          <input
            value={customNote}
            onChange={(e) => setCustomNote(e.target.value)}
            placeholder={msg("wizard.customRulePlaceholder")}
            maxLength={2000}
            className="input"
          />
        </label>
      </section>

      <section className={`card space-y-4 p-6 ${tab === "format" ? "" : "hidden"}`}>
        <h2 className="text-sm font-semibold text-slate-700">{msg("wizard.formatTitle")}</h2>

        {/* v3/06 §4: entrants + courts + hours → the formats that fit. */}
        <FormatRecommendStrip
          onPick={(slug) => {
            const key = FAMILY_TEMPLATE[slug];
            if (key) setTemplate(key);
          }}
        />

        <div className="grid gap-2 sm:grid-cols-3">
          {STAGE_TEMPLATES.map((t) => (
            <label
              key={t.key}
              className={`cursor-pointer rounded-lg border p-3 text-sm transition ${
                template === t.key
                  ? "border-purple-500 bg-purple-50 text-purple-800"
                  : "border-slate-200 bg-white text-slate-600 hover:border-purple-200"
              }`}
            >
              <input
                type="radio"
                name="template"
                checked={template === t.key}
                onChange={() => {
                  setTemplate(t.key);
                  // Keep the qualifier valid for the template's option list.
                  if (t.key === "group_playoffs" && qualified !== 4) {
                    setQualified(4); // the Page system is a fixed 4-team shape
                  } else if (!qualifierOptionsFor(t.key).includes(qualified)) {
                    setQualified(4);
                  }
                }}
                className="sr-only"
              />
              {/* F3 Task 6: t.key is a plain `string` (STAGE_TEMPLATES isn't
                  narrowed to a literal-key union — see format-templates.ts),
                  so this template-literal lookup can't be checked against
                  MessageKey's literal union without a cast. The cast is
                  narrow (still a real key of the dictionary type, just not
                  provably one of THESE 14) rather than `as any`: a typo in
                  the "format.template."/".label"/".help" literals themselves
                  would still fail to compile. format-templates.test.ts's
                  dictionary-coverage test is the runtime backstop that every
                  t.key actually resolves. */}
              <span className="block font-medium">
                {msg(`format.template.${t.key}.label` as MessageKey)}
              </span>
              <span className="mt-0.5 block text-xs text-slate-500">
                {msg(`format.template.${t.key}.help` as MessageKey)}
              </span>
            </label>
          ))}
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          {(template === "league" ||
            template === "league_ko" ||
            template === "groups_ko" ||
            template === "group_stepladder") && (
            <label className="block">
              <span className="label">{msg("wizard.legs")}</span>
              <select
                value={legs}
                onChange={(e) => setLegs(Number(e.target.value))}
                className="select"
              >
                <option value={1}>{msg("wizard.legsSingle")}</option>
                <option value={2}>{msg("wizard.legsHomeAway")}</option>
              </select>
            </label>
          )}
          {template === "groups_ko" && (
            <label className="block">
              <span className="label">{msg("wizard.pools")}</span>
              <input
                type="number"
                min={2}
                max={8}
                value={poolCount}
                onChange={(e) => setPoolCount(Number(e.target.value))}
                className="input"
              />
            </label>
          )}
          {["swiss", "swiss_playoff", "swiss_knockout"].includes(template) && (
            <label className="block">
              <span className="label">{msg("wizard.rounds")}</span>
              <input
                type="number"
                min={1}
                max={15}
                value={swissRounds}
                onChange={(e) => setSwissRounds(Number(e.target.value))}
                className="input"
              />
            </label>
          )}
          {hasSecondStage && (
            <label className="block">
              <span className="label">{msg("wizard.qualify")}</span>
              <select
                value={qualified}
                onChange={(e) => setQualified(Number(e.target.value))}
                className="select"
              >
                {qualifierOptionsFor(template).map((n) => (
                  <option key={n} value={n}>
                    {msg("schedule.topN", { n })}
                  </option>
                ))}
              </select>
            </label>
          )}
          {showStandingsCarry && (
            <label className="block">
              <span className="label">{msg("format.carry.label")}</span>
              <select
                data-testid="division-builder-carry"
                value={standingsCarry}
                onChange={(e) => setStandingsCarry(e.target.value as StandingsCarry)}
                className="select"
              >
                <option value="none">{msg("format.carry.none")}</option>
                <option value="points">{msg("format.carry.points")}</option>
                <option value="full">{msg("format.carry.full")}</option>
              </select>
              <span className="mt-0.5 block text-xs text-slate-400">{msg("format.carry.help")}</span>
            </label>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {TEMPLATE_FAMILY[template] && (
            <button
              type="button"
              onClick={() => setExplainOpen(true)}
              className="text-sm font-medium text-purple-700 underline underline-offset-2 hover:text-purple-900"
            >
              {msg("wizard.howWorks")}
            </button>
          )}
          {templateInfo && (
            <p className="text-xs text-slate-400">{msg("wizard.generatedHint")}</p>
          )}
        </div>
        {explainOpen && TEMPLATE_FAMILY[template] && (
          <FormatExplainerPanel
            familySlug={TEMPLATE_FAMILY[template]}
            onClose={() => setExplainOpen(false)}
          />
        )}

        {/* Show example — runs the real engine draw over placeholder entrants. */}
        <div className="border-t border-slate-100 pt-4">
          {!previewOpen ? (
            <button
              type="button"
              onClick={() => {
                setPreviewOpen(true);
                void runPreview(); // always reflect the current format
              }}
              className="btn btn-ghost text-sm"
            >
              {msg("wizard.showExample")}
            </button>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-slate-700">{msg("wizard.exampleFixtures")}</span>
                <label className="flex items-center gap-1.5 text-xs text-slate-500">
                  {msg("recommend.entrants")}
                  <input
                    type="number"
                    min={2}
                    max={64}
                    value={previewCount}
                    onChange={(e) => setPreviewCount(Math.min(64, Math.max(2, Number(e.target.value) || 2)))}
                    // `.input`'s own padding loses to `px-2 py-1 text-sm` under
                    // Tailwind's utilities layer (S13/#422 W11). `min-h-11` survives it.
                    className="input min-h-11 w-16 px-2 py-1 text-sm"
                  />
                </label>
                <button type="button" onClick={() => void runPreview()} disabled={previewBusy} className="btn btn-primary px-3 py-1 text-xs">
                  {previewBusy ? "…" : msg("wizard.generate")}
                </button>
                <button type="button" onClick={() => setPreviewOpen(false)} className="btn btn-ghost px-3 py-1 text-xs">
                  {msg("wizard.hide")}
                </button>
                <span className="text-[11px] text-slate-400">{msg("wizard.placeholderNote")}</span>
              </div>

              {previewError && (
                <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">{previewError}</p>
              )}

              {preview?.map((phase, pi) => (
                <div key={pi} className="rounded-lg border border-slate-200 p-3">
                  <p className="text-sm font-semibold text-slate-800">{phase.title}</p>
                  {phase.note && <p className="mt-0.5 text-xs text-slate-500">{phase.note}</p>}
                  <div className="mt-2 grid gap-3 sm:grid-cols-2">
                    {phase.sections.map((sec, si) => (
                      <div key={si}>
                        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                          {sec.title}
                        </p>
                        <ul className="space-y-0.5">
                          {sec.matches.map((m, mi) => (
                            <li key={mi} className="flex items-center gap-1.5 text-xs text-slate-600">
                              <span className="truncate font-medium text-slate-700">{m.home}</span>
                              <span className="text-slate-400">v</span>
                              <span className="truncate font-medium text-slate-700">{m.away}</span>
                            </li>
                          ))}
                          {sec.matches.length === 0 && (
                            <li className="text-xs text-slate-400">—</li>
                          )}
                        </ul>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className={`card space-y-4 p-6 ${tab === "scheduling" ? "" : "hidden"}`}>
        <div>
          <h2 className="text-sm font-semibold text-slate-700">
            {msg("wizard.tab.scheduling")} <span className="ml-1 text-xs font-normal text-slate-400">{msg("wizard.optional")}</span>
          </h2>
          <p className="mt-0.5 text-xs text-slate-400">{msg("wizard.schedulingHint")}</p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="label">{msg("boardset.matchLength")}</span>
            <input
              type="number"
              min={1}
              max={1440}
              value={matchMinutes}
              onChange={(e) => {
                setMatchMinutesTouched(true);
                setMatchMinutes(Number(e.target.value) || 30);
              }}
              className="input w-full"
            />
            <span className="mt-0.5 block text-xs text-slate-400">{msg("wizard.matchLengthHint")}</span>
          </label>
          <DateTimeField
            kind="datetime-local"
            label={msg("boardset.startAt")}
            value={scheduleStart}
            {...divisionStartBounds(competitionWindow)}
            onChange={setScheduleStart}
          />
          {/* The hint sits beside the field rather than inside its <label>:
              DateTimeField owns the label element, and a hint inside a label
              is read out as part of the control's accessible name anyway.
              `block` + the same margin keeps it visually where it was. */}
          <div>
            <DateTimeField
              kind="date"
              label={msg("boardset.endAt")}
              value={scheduleEnd}
              // Was `min={startDay(scheduleStart)}`. Same floor — `startDay` is
              // still the expression inside `divisionEndBounds`, so this and
              // the `endDateIsBackwards` guard in submit() cannot fork — with
              // the competition's own window added on both ends.
              {...divisionEndBounds(competitionWindow, scheduleStart)}
              onChange={setScheduleEnd}
            />
            <span className="mt-0.5 block text-xs text-slate-400">{msg("wizard.endDateHint")}</span>
          </div>
        </div>

        <div>
          {/* P9 scope item 5: real org courts, multi-selected and ordered —
              replaces the old free-text "Court 1"/"Court 2" name list. */}
          <CourtMultiPicker
            venues={venues}
            value={courts}
            onChange={setCourts}
            maxSelected={constraintsAllowed ? undefined : 1}
            label={msg("boardset.venuesLabel", { venue: pluralizeVenue(VenueCap) })}
            // `venuesDesc` reads `{venue}` as an already-plural noun
            // ("Pick the {venue} this schedule can use…") — the template
            // used to hardcode a literal "s" suffix and broke on a sibilant
            // noun ("Pitch" -> "Pitchs"); fixed by pluralizing here instead
            // (same fix as settings-panel.tsx's CourtsPanel/SettingsPanel).
            description={msg("boardset.venuesDesc", { venue: pluralizeVenue(venue) })}
            emptyTitle={msg("courtPicker.emptyTitle")}
            emptyBody={msg("courtPicker.emptyBody")}
            directoryLinkLabel={msg("courtPicker.directoryLink")}
            selectedLabel={msg("courtPicker.selected", { n: courts.length })}
            noneSelectedLabel={msg("courtPicker.noneSelected")}
            unknownCourtLabel={msg("courtPicker.unknownCourt")}
            moveUpLabel={msg("venues.court.moveUp")}
            moveDownLabel={msg("venues.court.moveDown")}
            removeLabelFor={(n) => msg("boardset.removeVenue", { venue, n })}
          />
          {!constraintsAllowed && (
            // Pre-empt the 402: a >1 court selection is Pro (doc 12 §5), and
            // the server refuses the whole settings PUT if the wizard sends
            // one. `maxSelected={1}` above stops the organiser from picking
            // a second court in the first place; this just explains why.
            <div className="mt-2 space-y-1">
              <p className="text-xs text-slate-400">{msg("wizard.venuesProHint", { venue })}</p>
              <UpgradeGate feature="scheduling.constraints" compact viewerPlan={viewerPlan} />
            </div>
          )}
        </div>
      </section>

      {paywallFeature && (
        <div className="space-y-2">
          <UpgradeGate feature={paywallFeature} reason={paywallReason} viewerPlan={viewerPlan} />
          {/* The invisible cause. The gate itself says "you are at your
              division limit" and the console shows the org fewer divisions
              than that limit, because an archived-but-played one keeps its
              slot (V354). Without this line the arithmetic on screen is simply
              wrong from the reader's side, and the only way to discover why is
              to ask support.

              Gated on BOTH the feature key and the server's marginality
              answer: this sentence is an explanation, and an explanation
              attached to a refusal it does not explain — a scheduling gate, a
              division limit with nothing archived behind it, or one whose
              VISIBLE divisions already fill the cap on their own — is a wrong
              answer, not a redundant one. */}
          {paywallFeature === "divisions.per_competition.max" && archivedSlotsExplainRefusal && (
            <p data-archived-slot-note className="text-xs text-slate-500">
              {msg("division.limit.archivedCount")}
            </p>
          )}
        </div>
      )}
      {error && (
        <p
          data-testid="division-builder-error"
          className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600"
        >
          {error}
        </p>
      )}

      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => router.push(routes.competition(orgSlug, compSlug))}
          className="btn btn-ghost"
        >
          {msg("wizard.cancel")}
        </button>
        <div className="flex gap-2">
          {tabIndex > 0 && (
            <button
              type="button"
              onClick={() => setTab(TAB_ORDER[tabIndex - 1]!)}
              className="btn btn-ghost"
            >
              {msg("wizard.back")}
            </button>
          )}
          {isLastTab ? (
            <button
              type="button"
              data-testid="division-builder-create"
              onClick={() => void submit()}
              disabled={busy || !name.trim() || !sportKey || !variantKey}
              className="btn btn-primary"
            >
              {busy ? msg("wizard.creating") : msg("wizard.create")}
            </button>
          ) : (
            <button
              type="button"
              data-testid="division-builder-next"
              onClick={goNext}
              className="btn btn-primary"
            >
              {msg("wizard.next")}
            </button>
          )}
        </div>
      </div>
    </form>
  );
}
