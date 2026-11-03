"use client";

// The new-division builder (/o/[orgSlug]/c/[compSlug]/d/new), Match Day C9: four steps the owner approved on 2026-11-02.
//
//   1 Who plays       name, sport (icon tiles, five then Show more: C9 R2), entrant kind, category; age and the
//                     eligibility note folded away.
//   2 Format          a visual picker (shape diagrams, match counts): 5 suggested formats, then a Show more tile as the
//                     sixth cell (C9 R2); Americano and Mexicano last. Knobs below.
//   3 Division rules  the Division rules strip the Fixtures tab shows (DivisionRulesStrip, in its draft mode), then the
//                     schedule seed, folded. For chess, online play comes first.
//   4 Review          a receipt of stages, matches, rounds and a time estimate; every row names where it can be changed
//                     later and has Edit, back to its step. Create is here, and lands on the division's Fixtures tab.
//
// Every step stays mounted (hidden when not current), so moving between steps and Edit from Review never loses what was
// typed. Create POSTs the division, then its stages, then the schedule seed (non-fatal), exactly as the 4-tab builder
// did: the inventory in the C9 report maps every input of that builder to its step here.
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { buildRuleOverride } from "./rules/match-format-editor";
import { divisionPointsDirty, divisionPointsOf, divisionPointsPatch, stagePointsHeadline } from "./rules/points-editor";
import { divisionOrderRefusals, divisionSportOrder, foldedSummary } from "./rules/tiebreaks-editor";
import { unitLabelKey } from "@/lib/stage-card/summaries";
import { DivisionRulesStrip } from "./rules/division-rules-strip";
import { CAMERA_INHERIT, cameraSelectOptions, cameraSummary, type CameraChoice } from "./division-settings";
import type { CameraPolicy } from "@/lib/camera-policy";
import { stageTakesPoints } from "./stage-rules/stage-points-model";
import { divisionSummaryClauses } from "./stage-rules/stage-row-model";
import { moduleFor } from "@/lib/rule-scope";
import type { EntrantKind, TableStageKind, TiebreakerKey } from "@seazn/engine/sport";
import { ruleFormState } from "./match-rules-state";
import { ruleContextFor } from "@/lib/match-rules";
import {
  STAGE_TEMPLATES,
  applyStandingsCarry,
  buildTemplateStages,
  clampKnob,
  templateHasProgression,
  templatesForSport,
  type StageDraft,
  type StandingsCarry,
} from "@/lib/format-templates";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { routes } from "@/lib/routes";
import { SWISS_ROUNDS_REQUIRED_CODE } from "@/lib/swiss-shell";
import { UpgradeGate } from "@/components/upgrade-gate";
import type { ViewerPlan } from "@/lib/viewer-plan";
import { doubleElimFormatReason } from "@/lib/feature-copy";
import { venueNoun, venueLabel, pluralizeVenue } from "@/lib/venue";
import { defaultMatchMinutes, timeControlMatchMinutes } from "@/lib/match-length";
import { pickVariant } from "@/lib/preferred-variant";
import { FormatExplainerPanel } from "@/components/v2/format-explainer-panel";
import { LegsChoice } from "@/components/v2/legs-choice";
import { FORMAT_BOUNDS, type FormatBoundKey, withinFormatBounds } from "@/lib/format-bounds";
import { DateTimeField } from "@/components/v2/shared/datetime-field";
import { CourtMultiPicker } from "@/components/v2/shared/court-multi-picker";
// P9: BOARD-side Venue — no calendar (see court-multi-picker.tsx).
import type { Venue } from "@/components/v2/shared/court-multi-picker";
import { useMsg, useMsgPlural, useLocale } from "@/components/i18n/dict-provider";
import { swissRoundsDefault, swissRoundsGuidanceLine } from "@/lib/swiss-rounds";
import type { MessageKey } from "@/lib/messages";
import type { Dict } from "@/lib/i18n-constants";
import { sportLabel } from "@/lib/scoring-vocab";
import { variantOptionLabel } from "@/lib/variant-label-keys";
import { configIssueText, settingsSaveErrorText } from "@/lib/config-issue-copy";
import { rulesChipText } from "@/lib/rules-line";
import { selectedTimeControlKey, timeControlOptions } from "@/lib/online-time-control";
import { onlinePlayShown } from "@/lib/online-chess";
// RS007/V380: the builder and the registration hub config panel edit the SAME first-class `category` column; the value
// union is imported rather than redeclared so the two screens can never drift onto two different "valid category" lists.
import type { DivisionCategoryValue } from "@/components/registration-hub-row-derive";
import { divisionEndBounds, divisionStartBounds, endDateIsBackwards, type CompetitionWindow } from "@/lib/date-order";
import { FormatShape } from "@/components/v2/division-builder/format-shape";
import { SportIcon } from "@/components/v2/division-builder/sport-icon";
import { estimateMinutes, estimateStages } from "@/lib/division-builder/format-estimate";
import {
  BUILDER_STEPS,
  CATCH_ALL_SPORT,
  collapsedPicks,
  entrantKindAfterSportChange,
  entrantsConfigFor,
  divisionEntrantKinds,
  divisionFormatOffer,
  divisionPlaysTemplate,
  OPENING_PLAN,
  openingKnobs,
  openingTemplate,
  pickAfterChange,
  firstBlockedStep,
  formatPickerOrder,
  rankTemplates,
  sportPickerOrder,
  stepForCreateError,
  SUGGESTED_COUNT,
  type BuilderStep,
  type EntrantChoice,
} from "@/lib/division-builder/model";

export interface SportOption {
  key: string;
  name: string;
  /** `config` is the variant's preset (`sport_variants.config`): what the rule fields convert by where they scale a value
   *  (cricket's overs, in the variant's over length). Absent on a variant whose row stores none. */
  variants: { key: string; name: string; system: boolean; config?: Record<string, unknown> }[];
  /** The engine's entrant model for the sport (`effectiveEntrantModel`, the page reads it off the pinned module). Absent:
   *  the builder does not ask, and sends no `config.entrants`. */
  entrants?: EntrantChoice;
}

/** No history: the Sport picker's order is the popular five, then the registry's (one stable empty list, so the order's
 *  memo is not recomputed on every render). */
const NO_RECENT_SPORTS: readonly string[] = Object.freeze([]);

/** The receipt rows the division POST already saved (I1): read-only once the division exists. */
const SAVED_WITH_DIVISION: readonly string[] = ["who", "rules", "points", "tiebreaks"];

/** Who plays and Division rules, once saved: what they show is what the division holds, and where to change it. */
export function SavedNote({ name }: { name: string }) {
  const msg = useMsg();
  return (
    <p role="status" className="mb-3 rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700" data-testid="division-builder-saved-note">
      {msg("divBuilder.saved.note", { name })}
    </p>
  );
}

/** The entrant kinds the format offer reads (templatesForSport, C9 fix round 1 I5): the engine's declaration the page
 *  passes. A sport with no model passed holds nothing as far as the offer knows, so it is offered no pair format -
 *  never one it might not be able to play. */
function offerKinds(sport: SportOption | undefined): readonly string[] {
  return sport?.entrants?.kinds ?? [];
}

/** The kinds a division of this sport will take with this kind shown on Who plays (Q3, n3); none declared, none. */
function kindsFor(sport: SportOption | undefined, kind: EntrantKind | null): readonly string[] {
  return sport?.entrants === undefined ? [] : divisionEntrantKinds(sport.entrants, kind);
}

/** The Format step's offer (C9 review 2, N1): what the sport is offered (its engine model), less what a division taking
 *  `kinds` cannot play. The cards, the ranking, the suggested five, the opening and Next all read it. */
function formatOfferFor(sport: SportOption | undefined, kinds: readonly string[]): string[] {
  return sport === undefined ? [] : divisionFormatOffer(templatesForSport(sport.key, offerKinds(sport)).map((t) => t.key), kinds);
}

/** The plan boxes' bounds (the inputs' own min/max). */
const PLAN_BOUNDS = {
  entrants: { min: 2, max: 64, whole: true },
  venues: { min: 1, max: 64, whole: true },
  hours: { min: 1, max: 240, whole: false },
} as const;

/** A plan box's typed text as the number the estimates read: within its bounds (entrants and venues whole numbers, hours
 *  as typed); empty or not a number reads as the minimum (C9 fix round 1, m3: clamped on read and on blur, never per
 *  keystroke). */
function planNumber(raw: string, { min, max, whole }: { min: number; max: number; whole: boolean }): number {
  const n = whole ? Math.floor(Number(raw)) : Number(raw);
  return raw.trim() !== "" && Number.isFinite(n) && n >= min ? Math.min(max, n) : min;
}

// Template → format-gallery family, for "How this works" (v3/06 §4).
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
  americano: "americano",
  mexicano: "americano",
  ladder: "ladder",
};

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

const CATEGORIES: {
  key: DivisionCategoryValue;
  labelKey: "reg.hub.row.category.open" | "reg.hub.row.category.mens" | "reg.hub.row.category.womens" | "reg.hub.row.category.mixed";
}[] = [
  { key: "open", labelKey: "reg.hub.row.category.open" },
  { key: "mens", labelKey: "reg.hub.row.category.mens" },
  { key: "womens", labelKey: "reg.hub.row.category.womens" },
  { key: "mixed", labelKey: "reg.hub.row.category.mixed" },
];

const KIND_LABEL: Record<EntrantKind, MessageKey> = {
  individual: "divBuilder.entrants.kind.individual",
  pair: "divBuilder.entrants.kind.pair",
  team: "divBuilder.entrants.kind.team",
};
/** Review's Who plays row: the one kind the division takes (C9 review 2, n3), in the run of its " · " summary. */
const REVIEW_KIND_ONLY: Record<EntrantKind, MessageKey> = {
  individual: "divBuilder.review.only.individual",
  pair: "divBuilder.review.only.pair",
  team: "divBuilder.review.only.team",
};
const KIND_ONLY: Record<EntrantKind, MessageKey> = {
  individual: "divBuilder.entrants.only.individual",
  pair: "divBuilder.entrants.only.pair",
  team: "divBuilder.entrants.only.team",
};
const STEP_LABEL: Record<BuilderStep, MessageKey> = {
  who: "divBuilder.step.who",
  // The matrix's page object finds the Format step by this key's words (tools/matrix selectors.ts NAME.formatTab).
  format: "wizard.tab.format",
  rules: "rulesStrip.title",
  review: "divBuilder.step.review",
};

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
    startAt: DATETIME_LOCAL_VALUE.test(input.startAt) ? new Date(input.startAt).toISOString() : null,
    endAt: input.endAt ? new Date(`${input.endAt}T23:59:00`).toISOString() : null,
  };
}

/**
 * The `formats.double_elim` gate's per-kind wording (feature-copy.ts's `doubleElimFormatReason`), given the stage
 * drafts this builder is about to submit (bug-fix follow-up 2026-08-18, gate-copy): a `group_playoffs` template builds a
 * `page_playoff` stage, which must not read "Double-elimination brackets are a Pro format." Returns undefined for every
 * other feature key; `<UpgradeGate>` then falls back to its own `featureReason(feature)`.
 */
export function paywallReasonForStages(featureKey: string, stages: StageDraft[]): string | undefined {
  if (featureKey !== "formats.double_elim") return undefined;
  const gatedStage = stages.find((s) => s.kind === "double_elim" || s.kind === "page_playoff");
  return doubleElimFormatReason(gatedStage?.kind ?? "double_elim");
}

/** RS007/V380: the eligibility columns Who plays writes. "open" collapses to `null` on write, mirroring the registration
 *  hub config panel, so both screens store the SAME "no restriction" value. "U16" = 15 or younger on the cutoff (doc 06
 *  §2.1): the age box holds the age group and `age_max` stores one less. `age_min` stays the hub panel's own. */
export function eligibilityPatch(input: { maxAge: string; cutoffMonth: string; cutoffDay: string; category: DivisionCategoryValue; customNote: string }): {
  category: DivisionCategoryValue | null;
  age_max: number | null;
  age_cutoff_month: number | null;
  age_cutoff_day: number | null;
  eligibility_note: string | null;
} {
  const age = Number(input.maxAge);
  const hasAge = input.maxAge !== "" && Number.isInteger(age) && age > 0;
  return {
    category: input.category === "open" ? null : input.category,
    age_max: hasAge ? age - 1 : null,
    age_cutoff_month: hasAge ? Number(input.cutoffMonth) : null,
    age_cutoff_day: hasAge ? Number(input.cutoffDay) : null,
    eligibility_note: input.customNote.trim() ? input.customNote.trim() : null,
  };
}

/** The division POST's `config`: the rule overrides typed on Division rules, the points once a box was touched, online
 *  play only when it is on (absent = over the board, the server's default), and the entrant kind only when it is not
 *  the sport's own default (`entrantsConfigFor`). Everything left alone stays absent, so the server's defaults apply. */
export function divisionCreateConfig(input: {
  ruleOverrides: Record<string, unknown>;
  points?: unknown;
  onlinePlay: "off" | "lichess";
  entrants?: { kinds: EntrantKind[]; defaultKind: EntrantKind };
}): Record<string, unknown> {
  const config: Record<string, unknown> = { ...input.ruleOverrides };
  if (input.points !== undefined) config.points = input.points;
  if (input.onlinePlay === "lichess") config.onlinePlay = "lichess";
  if (input.entrants !== undefined) config.entrants = input.entrants;
  return config;
}

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
  onlineChessOffered = false,
  inheritedCameraPolicy = "off",
  ruleDict,
  pointsDict,
  templateLocks = {},
  carryAllowed = true,
  recentSports = NO_RECENT_SPORTS,
}: {
  competitionId: string;
  orgSlug: string;
  compSlug: string;
  sports: SportOption[];
  /** Org venues with nested courts (`listVenues` shape) — the schedule seed's court multi-picker (P9 scope item 5).
   *  An empty list degrades to the picker's own "no courts yet" Directory pointer. */
  venues?: Venue[];
  /** The competition's own `starts_on`/`ends_on`: the schedule fields carry it as `min`/`max`, because the seed PUT
   *  fired after create is refused outside it (422) and that PUT deliberately swallows every error. */
  competitionWindow?: CompetitionWindow;
  /** Pro `scheduling.constraints` — gates a multi-venue list (doc 12 §5). */
  constraintsAllowed?: boolean;
  /** Would releasing this competition's ARCHIVED slot-holders (V354) let a refused create through? Answered by the
   *  page from the same predicate the quota charge uses; it only explains a `divisions.per_competition.max` refusal. */
  archivedSlotsExplainRefusal?: boolean;
  viewerPlan: ViewerPlan;
  /** Online chess is offered to this club (T20): Division rules shows the online play select for chess. */
  onlineChessOffered?: boolean;
  /** The competition's camera policy (`competitionCameraPolicy`): what a division that sets none plays, named under the
   *  camera select. The column is NOT NULL, default "off". */
  inheritedCameraPolicy?: CameraPolicy;
  /** The public dictionary's `format.*` / `format.points.*` slices, for the rules' words (the strip and the receipt). */
  ruleDict?: Dict;
  pointsDict?: Dict;
  /** Template key → the plan feature it needs and this organisation lacks (the stage writers' own gates, asked by the
   *  page). A locked format is shown, and choosing it stops Next with the upgrade, instead of a 402 after the division
   *  already exists. */
  templateLocks?: Readonly<Record<string, string>>;
  /** `standings.carry_over`: carrying standings into the next stage. */
  carryAllowed?: boolean;
  /** The sports this organisation has run divisions in, most recent first (the page's one query): the Sport picker
   *  leads with them (C9 R2). */
  recentSports?: readonly string[];
}) {
  const msg = useMsg();
  const msgPlural = useMsgPlural();
  const locale = useLocale();
  const router = useRouter();

  const [step, setStep] = useState<BuilderStep>("who");
  // Edit from Review: the step opened from a Review row offers the way straight back.
  const [fromReview, setFromReview] = useState(false);

  // --- 1 Who plays ---
  const [name, setName] = useState("");
  const [sportKey, setSportKey] = useState(sports[0]?.key ?? "");
  const sport = useMemo(() => sports.find((s) => s.key === sportKey), [sports, sportKey]);
  // C9 R2: the Sport picker's tiles, in its order (the organisation's own, the popular five, the registry, generic last);
  // five shown until Show more, the picked one never folded away.
  const sportOrder = useMemo(() => sportPickerOrder(sports.map((s) => s.key), recentSports), [sports, recentSports]);
  const [sportsOpen, setSportsOpen] = useState(false);
  const sportsShown = collapsedPicks(sportOrder, sportKey);
  const sportFolded = (key: string) => !sportsOpen && !sportsShown.includes(key);
  const sportsFoldedCount = sportOrder.filter(sportFolded).length;
  const [entrantKind, setEntrantKind] = useState<EntrantKind | null>(() => sports[0]?.entrants?.defaultKind ?? null);
  const [entrantKindTouched, setEntrantKindTouched] = useState(false);
  const [eligibilityOpen, setEligibilityOpen] = useState(false);
  const [maxAge, setMaxAge] = useState("");
  const [cutoffMonth, setCutoffMonth] = useState("1");
  const [cutoffDay, setCutoffDay] = useState("1");
  const [category, setCategory] = useState<DivisionCategoryValue>("open");
  const [customNote, setCustomNote] = useState("");

  // --- 2 Format ---
  // Owner ruling 2026-11-03 (C9 Q5): null until the organiser picks a card; until then the builder opens on the
  // suggester's first for the sport at the opening plan that the division's entrant kinds can play (model.ts
  // openingTemplate). It follows the sport and the kind picked on Who plays, never the plan typed on Format.
  const [templatePicked, setTemplatePicked] = useState<string | null>(null);
  // C9 review 2 (N1): the kinds the division will take, and the formats it can play - the offer, the ranking, the
  // opening and Next all read this one list, so a division narrowed to Pairs or Teams is never offered Americano.
  const divisionKinds = kindsFor(sport, entrantKind);
  const formatOffer = formatOfferFor(sport, divisionKinds);
  const template =
    templatePicked ??
    openingTemplate(
      formatOffer,
      defaultMatchMinutes(sportKey, sport ? pickVariant(sport.key, sport.variants) : ""),
      divisionKinds,
      Object.keys(templateLocks),
    );
  const [qualified, setQualified] = useState(4);
  // C9 fix round 1 (I2): null until the organiser types in the Rounds box; until then the box follows the plan's
  // entrant count (swissRoundsDefault, the same helper Settings opens a new Swiss at), as the match length follows the
  // sport until it is touched.
  const [swissRoundsPicked, setSwissRoundsPicked] = useState<number | null>(null);
  const [poolCount, setPoolCount] = useState(2);
  const [legs, setLegs] = useState(1);
  const [standingsCarry, setStandingsCarry] = useState<StandingsCarry>("none");
  const [showAll, setShowAll] = useState(false);
  // The plan the estimates are worked out for (builder-only: nothing here is sent). The entrant count is also the
  // example draw's and the Swiss guidance line's.
  // The boxes keep what the organiser TYPES (C9 fix round 1, m3): clamping every keystroke turned "1" into 2 before the
  // "2" of "12" arrived. The value is clamped where it is read (planNumber) and written back clamped on blur.
  const [planEntrants, setPlanEntrants] = useState(String(OPENING_PLAN.entrants));
  const [planVenues, setPlanVenues] = useState(String(OPENING_PLAN.venues));
  const [planHours, setPlanHours] = useState(String(OPENING_PLAN.hours));
  const planEntrantCount = planNumber(planEntrants, PLAN_BOUNDS.entrants);
  const swissRounds = swissRoundsPicked ?? swissRoundsDefault(planEntrantCount);

  // --- 3 Division rules ---
  const [variantKey, setVariantKey] = useState(sport ? pickVariant(sport.key, sport.variants) : "");
  const [ruleValues, setRuleValues] = useState<Record<string, string>>({});
  const [onlinePlay, setOnlinePlay] = useState<"off" | "lichess">("off");
  // m6 (C9 fix round 1): the server's default - absent ⇒ NULL ⇒ the competition's policy (CreateDivision.camera_policy).
  const [cameraChoice, setCameraChoice] = useState<CameraChoice>(CAMERA_INHERIT);
  const [pointsValues, setPointsValues] = useState<Record<string, string> | null>(null);
  const [tiebreakOrder, setTiebreakOrder] = useState<TiebreakerKey[] | null>(null);
  // The schedule seed (optional; also editable later on the schedule board). Real court ids picked from the org's own
  // court list (P9 scope item 5) — no fabricated default.
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [courts, setCourts] = useState<string[]>([]);
  // The sport's (or variant's) default until the organiser types one; an online division's control overrides it below.
  const [sportMatchMinutes, setMatchMinutes] = useState(() =>
    defaultMatchMinutes(sports[0]?.key, sports[0] ? pickVariant(sports[0].key, sports[0].variants) : ""),
  );
  // Once the organiser edits the length, stop auto-filling it from the sport.
  const [matchMinutesTouched, setMatchMinutesTouched] = useState(false);
  // Seeded with the competition's opening DAY (a bare `YYYY-MM-DD`, "date set, time unset") so the calendar opens on
  // the right month without inventing a time: `buildScheduleSeed` treats a half-filled value as unset.
  const [scheduleStart, setScheduleStart] = useState(() => competitionWindow?.startsOn ?? "");
  const [scheduleEnd, setScheduleEnd] = useState(""); // date

  // "Show example" fixture preview (runs the real engine draw server-side).
  const [previewOpen, setPreviewOpen] = useState(false);
  const [explainOpen, setExplainOpen] = useState(false);
  /** The example on screen, tagged with the format knobs it was drawn for. */
  const [shownPreview, setPreview] = useState<{ knobs: string; phases: PreviewPhase[] } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // One error slot, shown on the step it belongs to. `check`: raised by the step's own check (Next, a jump, Create), so
  // it speaks for that check as it stands now - see the render-phase clear below. A server refusal is not a check.
  const [error, setError] = useState<{ step: BuilderStep; text: string; check?: true } | null>(null);
  // Match Day E1 item 8 (D1): a refusal of a format knob remembers the knob values it was raised for, so it is dropped
  // the moment the organiser changes the box it names (see the render-phase clear below).
  const [formatRefusal, setFormatRefusal] = useState<{ text: string; knobs: string } | null>(null);
  const [paywallFeature, setPaywallFeature] = useState<string | null>(null);
  const [paywallReason, setPaywallReason] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  // A division created whose stages were then refused: Create again adds the stages to IT, never a second division.
  const [created, setCreated] = useState<{ id: string; slug: string; name: string } | null>(null);
  // C9 fix round 1 (I1): what the division was saved with (Who plays, the Division rules strip) is read-only once it
  // exists; only the stages (Format) and the schedule seed are still to be sent.
  const saved = created !== null;
  const rowSaved = (id: string) => saved && SAVED_WITH_DIVISION.includes(id);

  function selectSport(key: string) {
    setSportKey(key);
    const next = sports.find((s) => s.key === key);
    const firstVariant = next ? pickVariant(next.key, next.variants) : "";
    setVariantKey(firstVariant);
    setRuleValues({}); // rules are sport-specific
    setPointsValues(null);
    setTiebreakOrder(null);
    setOnlinePlay("off");
    setCameraChoice(CAMERA_INHERIT);
    // A kind the organiser never picked follows the sport; a picked one is kept where the new sport allows it.
    const nextKind = next?.entrants && entrantKind !== null ? entrantKindAfterSportChange(entrantKind, entrantKindTouched, next.entrants) : (next?.entrants?.defaultKind ?? null);
    setEntrantKind(nextKind);
    // Chess and the team sports are offered no americano/mexicano (templatesForSport), nor is a division of pairs or
    // teams (N1): a pick the new sport's division is not offered is dropped rather than staying selected behind a card
    // that is no longer rendered - to the opening format (n1), not a picked League. Untouched, the opening follows (Q5).
    setTemplatePicked((t) => pickAfterChange(t, formatOfferFor(next, kindsFor(next, nextKind))));
    if (!matchMinutesTouched) setMatchMinutes(defaultMatchMinutes(key, firstVariant));
  }

  function selectVariant(key: string) {
    setVariantKey(key);
    setPointsValues(null);
    setTiebreakOrder(null);
    if (!matchMinutesTouched) setMatchMinutes(defaultMatchMinutes(sportKey, key));
  }

  // Templates whose second stage is sized by the `qualified` knob, so the builder shows the Top N control. ko_plate and
  // qualifying_main read `qualified` too, at their own default of 4: buildStages sends them that. group_playoffs is a
  // fixed four. Declared above buildStages, which runs during render (draftTableKinds).
  const hasSecondStage =
    template === "league_ko" ||
    template === "groups_ko" ||
    template === "group_stepladder" ||
    template === "swiss_knockout";
  // The other bounded number knobs, shown per template. The JSX and formatBoundProblem read these same two, so a knob is
  // judged exactly when it is on screen.
  const showPools = template === "groups_ko";
  const showRounds = template === "swiss" || template === "swiss_playoff" || template === "swiss_knockout";
  const showLegs = template === "league" || template === "league_ko" || template === "groups_ko" || template === "group_stepladder";

  /** The first VISIBLE format knob outside FORMAT_BOUNDS, as a sentence naming it, or null (fix round 1, M1). */
  function formatBoundProblem(): string | null {
    const shown: [FormatBoundKey, number, MessageKey][] = [];
    if (showPools) shown.push(["pools", poolCount, "wizard.pools"]);
    if (showRounds) shown.push(["swissRounds", swissRounds, "wizard.rounds"]);
    if (hasSecondStage) shown.push(["qualify", qualified, "wizard.qualify"]);
    for (const [field, value, label] of shown) {
      if (!withinFormatBounds(field, value)) {
        const { min, max } = FORMAT_BOUNDS[field];
        return msg("wizard.err.formatBound", { field: msg(label), min, max });
      }
    }
    return null;
  }

  function buildStages(): StageDraft[] {
    // B (round-4 review): a cleared knob reads as Number("") === 0; one shared clampKnob (format-templates.ts) over one
    // set of bounds (format-bounds.ts), the same guard as division-settings.tsx's. The Top N is read only where it is on
    // screen (hasSecondStage): a template that does not show it gets the templates' default 4.
    return applyStandingsCarry(
      buildTemplateStages(template, {
        qualified: hasSecondStage ? clampKnob(qualified, FORMAT_BOUNDS.qualify.min, FORMAT_BOUNDS.qualify.max) : 4,
        swissRounds,
        poolCount: clampKnob(poolCount, FORMAT_BOUNDS.pools.min, FORMAT_BOUNDS.pools.max),
        legs,
      }),
      standingsCarry,
    );
  }

  // What the division will be created with (the variant's preset under the rules typed on Division rules): the points
  // and tie-breaks read it, and the create sends the same overrides.
  const sportModule = moduleFor(sportKey);
  const variantPreset = sport?.variants.find((v) => v.key === variantKey)?.config;
  const ruleOverrides = buildRuleOverride(sportKey, ruleValues, ruleContextFor(sportKey, variantPreset));
  const builderCfg: Record<string, unknown> = {
    ...(variantPreset ?? {}),
    ...Object.fromEntries(Object.entries(ruleOverrides).filter(([, v]) => v !== undefined)),
    ...(onlinePlay === "lichess" ? { onlinePlay: "lichess" } : {}),
  };
  const builderPoints = sportModule === null ? undefined : divisionPointsOf(sportModule, builderCfg);
  const stagesNow = buildStages();
  const draftTableKinds = [...new Set(stagesNow.map((s) => s.kind).filter(stageTakesPoints))] as TableStageKind[];
  // W2e Task 29: the write doors' refusals beside their fields, laid over the variant's own preset as the server will.
  const ruleState = ruleFormState({ sportKey, variantKey, values: ruleValues, base: variantPreset ?? {} });
  const ruleProblemText = (): string | null => {
    const problem = ruleState.problems[0];
    return problem === undefined ? null : configIssueText({ path: [], message: problem.sentence }, msg);
  };
  const onlineShown = onlinePlayShown(sportKey, onlineChessOffered);
  const lichess = onlineShown && onlinePlay === "lichess";
  const timeControlKey = lichess ? selectedTimeControlKey(ruleValues, builderCfg) : "";
  // m8 (C9 fix round 1): an online division plays its Lichess control, so its slot is that control's length (both clocks
  // spent) - until the organiser types a length, which always stands. The seed, the estimates and Review all read this.
  const matchMinutes = (!matchMinutesTouched ? timeControlMatchMinutes(timeControlKey) : undefined) ?? sportMatchMinutes;
  const venue = venueNoun(sportKey); // "pitch" / "table" / "court" / "board" / "rink"
  const VenueCap = venueLabel(sportKey);
  const offered = formatOffer;
  const planMinutes = matchMinutes >= 1 ? matchMinutes : 30;
  const plan = {
    entrants: planEntrantCount,
    venues: planNumber(planVenues, PLAN_BOUNDS.venues),
    hours: planNumber(planHours, PLAN_BOUNDS.hours),
    matchMinutes: planMinutes,
  };
  // Ranked at the builder's opening knobs, so the suggested five do not reshuffle while a knob moves; each card's own
  // counts are at the knobs as they stand.
  const ranked = rankTemplates(offered, plan, openingKnobs(plan.entrants));
  // C9 R2 (owner 2026-11-03): the cards in the ranking's order with Americano and Mexicano after every other.
  const pickerOrder = formatPickerOrder(ranked.map((r) => r.key));
  const suggested = pickerOrder.slice(0, SUGGESTED_COUNT);
  // Every offered card is rendered, in the picker's order; past the first five they are folded (hidden, never
  // unmounted) until Show more. The picked card is never folded away: outside the five it takes the fifth slot.
  const formatsShown = collapsedPicks(pickerOrder, template);
  const folded = (key: string) => !showAll && !formatsShown.includes(key);
  const foldedCount = pickerOrder.filter(folded).length;
  const estimate = estimateStages(stagesNow, plan.entrants);
  const estimateMins = estimateMinutes(estimate, plan.venues, plan.matchMinutes);
  const templateLock = templateLocks[template];
  const carryLocked = !carryAllowed && standingsCarry !== "none";

  function templateLabel(key: string): string {
    return msg(`format.template.${key}.label` as MessageKey);
  }
  const hoursText = (minutes: number) =>
    new Intl.NumberFormat(locale, { style: "unit", unit: "hour", unitDisplay: "short", maximumFractionDigits: 1 }).format(Math.round((minutes / 60) * 10) / 10);
  const placesText = (n: number) => msgPlural(`divBuilder.places.${venue}` as "divBuilder.places.court", n, { count: n });

  // --- Validation: each step's first problem, said in the reader's words. ---
  function stepProblem(s: BuilderStep): string | null {
    if (s === "who") {
      if (!name.trim()) return msg("wizard.err.name");
      if (!sportKey) return msg("wizard.err.sport");
      if (maxAge) {
        const n = Number(maxAge);
        if (!Number.isInteger(n) || n <= 0) return msg("wizard.err.maxAge");
      }
    }
    if (s === "format") {
      const bound = formatBoundProblem();
      if (bound !== null) return bound;
      // Said in the reader's language; the upgrade box below the cards gives the plan's own reason.
      if (templateLock !== undefined) return msg("divBuilder.err.formatLocked", { format: templateLabel(template) });
      // N1: a format the division's kinds cannot play (a stale pick that outlived a change of kind) never passes.
      if (!divisionPlaysTemplate(template, divisionKinds)) return msg("divBuilder.err.formatKind", { format: templateLabel(template) });
      if (carryLocked) return msg("divBuilder.err.carryLocked");
    }
    if (s === "rules") {
      if (!variantKey) return msg("wizard.err.variant");
      // A format the sport's write door would refuse stops here, beside the field it is about, not at Create.
      const ruleProblem = ruleProblemText();
      if (ruleProblem !== null) return ruleProblem;
      // Lichess plays only its eight controls; the create refuses any other clock (assertTimeControl).
      if (lichess && timeControlKey === "") return msg("divBuilder.err.timeControl");
      if (!(matchMinutes >= 1)) return msg("wizard.err.matchLength");
      // `endDateIsBackwards` and the end input's `min=` are one expression (`startDay`), so the input cannot permit what
      // this then rejects. The seed PUT is non-fatal and swallows a refusal, so this is the only message there would be.
      if (endDateIsBackwards(scheduleStart, scheduleEnd)) return msg("boardset.datesError");
    }
    return null;
  }
  const problems = Object.fromEntries(BUILDER_STEPS.map((s) => [s, stepProblem(s)])) as Record<BuilderStep, string | null>;
  // A step's own refusal goes the moment what it named is fixed (the name typed after "Enter a division name"), rather
  // than standing over a field that is now right. Cleared, not hidden: emptying the field again raises nothing until
  // the next Next or jump asks again. A server refusal (no `check`) stays until the organiser acts on it.
  if (error !== null && error.check === true && problems[error.step] === null) setError(null);
  const blocked = firstBlockedStep(problems);
  const stepIndex = BUILDER_STEPS.indexOf(step);

  /** Raise a refusal on a step. One that is a format-knob refusal is remembered with the knobs it was raised for, so it
   *  goes when they change; any other is never tagged, so a knob change cannot touch it. */
  function refuse(at: BuilderStep, text: string) {
    setError({ step: at, text, check: true });
    if (text === formatBoundProblem()) setFormatRefusal({ text, knobs: boundKnobs });
  }

  /** Move to a step. Going back is free; going forward needs every step before the target clear, and stops on the
   *  first that is not, saying why. */
  function goTo(target: BuilderStep, opts: { fromReview?: boolean } = {}) {
    const to = BUILDER_STEPS.indexOf(target);
    if (to > stepIndex) {
      const stop = BUILDER_STEPS.slice(0, to).find((s) => problems[s] !== null);
      if (stop !== undefined) {
        setStep(stop);
        refuse(stop, problems[stop]!);
        return;
      }
    }
    setError(null);
    setFromReview(opts.fromReview ?? false);
    setStep(target);
  }
  const goNext = () => goTo(BUILDER_STEPS[Math.min(stepIndex + 1, BUILDER_STEPS.length - 1)]!);

  // Any change to the format or its knobs invalidates a shown example: one drawn for other knobs is CLEARED during
  // render (not from an effect), which also drops an answer still in flight when a knob moved (see
  // division-builder-example-knobs.test.tsx). A clear, not a hidden value: changing the knobs back does not resurrect it.
  const knobs = JSON.stringify([template, qualified, swissRounds, poolCount, legs, standingsCarry]);
  if (shownPreview && shownPreview.knobs !== knobs) setPreview(null);
  const preview = shownPreview?.phases ?? null;

  // Match Day E1 item 8 (D1): the same render-phase clear for a format refusal, from the error slot and the example's,
  // and only if the slot still holds THAT sentence.
  const boundKnobs = JSON.stringify([template, qualified, swissRounds, poolCount]);
  if (formatRefusal !== null && formatRefusal.knobs !== boundKnobs) {
    setFormatRefusal(null);
    if (error?.text === formatRefusal.text) setError(null);
    if (previewError === formatRefusal.text) setPreviewError(null);
  }

  async function runPreview() {
    setPreviewError(null);
    // The example draws the stages Create would send, so a knob Create refuses draws nothing either.
    const formatProblem = formatBoundProblem();
    if (formatProblem !== null) {
      setPreviewError(formatProblem);
      setFormatRefusal({ text: formatProblem, knobs: boundKnobs });
      return;
    }
    setPreviewBusy(true);
    const drawnFor = knobs;
    try {
      const { phases } = await apiV1<{ phases: PreviewPhase[] }>("/api/v1/format-preview", {
        method: "POST",
        json: { count: Math.min(64, plan.entrants), stages: buildStages() },
      });
      setPreview({ knobs: drawnFor, phases });
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : msg("wizard.previewError"));
    } finally {
      setPreviewBusy(false);
    }
  }

  async function submit() {
    // Create is drawn on Review only (and the form's own submit is prevented), so this asks one thing again: every step
    // clear. A press on a disabled Create still lands here in a test harness; it creates nothing.
    if (blocked !== null) {
      setStep(blocked);
      refuse(blocked, problems[blocked]!);
      return;
    }
    setError(null);
    setPaywallFeature(null);
    setPaywallReason(undefined);

    // The tie-break order, asked again of the structure it is sent with (fix round 1, M6): a template changed since the
    // order was edited can leave no table to rank, or a kind the order does not fit.
    const sentOrder =
      tiebreakOrder !== null && sportModule !== null && draftTableKinds.length > 0 && divisionOrderRefusals(sportModule, builderCfg, draftTableKinds, tiebreakOrder).length === 0
        ? tiebreakOrder
        : null;
    const config = divisionCreateConfig({
      ruleOverrides,
      // Points only once the organiser touched a box, laid over the points the config keeps.
      points: pointsValues !== null && divisionPointsDirty(sportKey, builderPoints, pointsValues) ? divisionPointsPatch(sportKey, builderPoints, pointsValues) : undefined,
      onlinePlay: lichess ? "lichess" : "off",
      entrants: sport?.entrants && entrantKind !== null ? entrantsConfigFor(sport.entrants, entrantKind) : undefined,
    });

    setBusy(true);
    let phase: "division" | "stages" = "division";
    // Declared outside try{} so the catch can read WHICH stage kinds were submitted.
    let stages: StageDraft[] = [];
    try {
      let division = created;
      if (division === null) {
        const made = await apiV1<{ id: string; slug: string }>(`/api/v1/competitions/${competitionId}/divisions`, {
          method: "POST",
          json: {
            name,
            sport_key: sportKey,
            variant_key: variantKey,
            config,
            // The division's own tie-break order (`divisions.tiebreakers`). Absent while untouched: the sport's.
            ...(sentOrder === null ? {} : { tiebreakers: sentOrder }),
            // m6: only an online division, and only a picked policy - untouched, the server's default (inherit) stands.
            ...(lichess && cameraChoice !== CAMERA_INHERIT ? { camera_policy: cameraChoice } : {}),
            ...eligibilityPatch({ maxAge, cutoffMonth, cutoffDay, category, customNote }),
          },
        });
        division = { id: made.id, slug: made.slug, name };
      }
      const retry = created !== null;
      setCreated(division);
      phase = "stages";
      stages = buildStages().map((s, i) => ({ ...s, seq: i + 1 }));
      // I1: a retry REPLACES the stages (PUT) rather than adding them: on a bad connection the first POST can land while
      // its answer is lost, and a second POST would leave the division with two stage graphs.
      await apiV1(`/api/v1/divisions/${division.id}/stages`, { method: retry ? "PUT" : "POST", json: stages });

      // Seed scheduling settings. Non-fatal: the board can set these later, so a failure here does not block create.
      const seedInput = { courts, matchMinutes, startAt: scheduleStart, endAt: scheduleEnd };
      const putSeed = (seed: ReturnType<typeof buildScheduleSeed>) =>
        apiV1(`/api/v1/divisions/${division.id}/schedule-settings`, { method: "PUT", json: { config: seed } });
      try {
        await putSeed(buildScheduleSeed(seedInput));
      } catch {
        // A multi-venue list can be refused (402); retry with a single venue so dates and match length still land.
        try {
          await putSeed(buildScheduleSeed(seedInput, { singleVenue: true }));
        } catch {
          /* board settings are editable later — ignore */
        }
      }

      // Land on the stage cards (Match Day C9, owner): Generate there names what it is waiting for.
      router.push(routes.division(orgSlug, compSlug, division.slug, "fixtures"));
    } catch (err) {
      const at = stepForCreateError(phase, err instanceof ApiV1Error ? { code: err.code, extra: err.extra } : {});
      if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") {
        const feature = String(err.extra.feature_key ?? "");
        setPaywallFeature(feature);
        setPaywallReason(paywallReasonForStages(feature, stages));
        setStep(phase === "stages" ? "format" : "review");
      } else {
        let text: string;
        if (err instanceof ApiV1Error && err.code === "COMPETITION_ENDED") {
          // A finished competition does not grow (#376 part D); the server's message is English-only.
          text = msg("division.create.competitionEnded");
        } else if (err instanceof ApiV1Error && err.code === SWISS_ROUNDS_REQUIRED_CODE) {
          text = msg("stage.err.swissRoundsRequired");
        } else {
          // Every other refusal says itself in the reader's language off its code and issues.
          text = settingsSaveErrorText(err, msg, msg("wizard.failed"));
        }
        setStep(at);
        setError({ step: at, text });
      }
      setBusy(false);
    }
  }

  const showStandingsCarry = templateHasProgression(template);
  const entrantModel = sport?.entrants;
  const kindLabel = (k: EntrantKind) => msg(KIND_LABEL[k]);

  // --- Review rows ---
  const rulesSummary =
    ruleDict === undefined || sportModule === null ? [] : divisionSummaryClauses(sportKey, sportModule, builderCfg).map((c) => rulesChipText(ruleDict, c));
  const timeControlLabel = timeControlKey === "" ? undefined : timeControlOptions(msg).find((o) => o.key === timeControlKey)?.label;
  const variant = sport?.variants.find((v) => v.key === variantKey);
  // m7 (C9 fix round 1): the Points and Tie-breaks rows say what the division will play, as the receipt (mock A7) does:
  // the stage card's one phrase for the points ("Win 2 · Loss 0") and the tie-break panel's folded order, each marked the
  // sport's or the organiser's. Read for the first table kind, as the Points and Tie-breaks panels read it.
  const ownPoints = pointsValues !== null && divisionPointsDirty(sportKey, builderPoints, pointsValues);
  const pointsHeadline =
    sportModule === null || draftTableKinds.length === 0
      ? null
      : stagePointsHeadline(
          {
            module: sportModule,
            kind: draftTableKinds[0]!,
            stageConfig: {},
            divisionConfig: ownPoints ? { ...builderCfg, points: divisionPointsPatch(sportKey, builderPoints, pointsValues!) } : builderCfg,
            stored: undefined,
            pointsDict,
          },
          msg,
        );
  const shownOrder = tiebreakOrder ?? (sportModule === null ? null : divisionSportOrder(sportModule, builderCfg, draftTableKinds));
  const orderText = shownOrder === null || shownOrder.length === 0 ? null : foldedSummary(shownOrder, (k) => msg(unitLabelKey(k, sportKey)));
  const reviewRows: { id: string; step: BuilderStep; label: string; value: string; later: string }[] = [
    {
      id: "who",
      step: "who",
      label: msg("divBuilder.step.who"),
      value: [
        name.trim() || "—",
        sportLabel(sportKey, msg),
        // n3: the division takes this kind alone - Review says so ("Teams only").
        entrantKind === null ? null : msg(REVIEW_KIND_ONLY[entrantKind]),
        msg(CATEGORIES.find((c) => c.key === category)!.labelKey),
        maxAge && Number(maxAge) > 0 ? msg("divBuilder.review.under", { age: Number(maxAge) }) : msg("divBuilder.review.allAges"),
      ]
        .filter((x) => x !== null)
        .join(" · "),
      later: msg("divBuilder.review.later.who"),
    },
    {
      id: "format",
      step: "format",
      label: msg("wizard.tab.format"),
      value: [
        templateLabel(template),
        showPools ? msgPlural("divBuilder.review.pools", poolCount, { count: poolCount }) : null,
        showRounds ? msgPlural("divBuilder.card.rounds", swissRounds, { count: swissRounds }) : null,
        hasSecondStage ? msg("divBuilder.review.top", { count: qualified }) : null,
        showLegs ? msg(legs === 2 ? "wizard.legsHomeAway" : "wizard.legsSingle") : null,
      ]
        .filter((x) => x !== null)
        .join(" · "),
      later: msg("divBuilder.review.later.format"),
    },
    {
      id: "rules",
      step: "rules",
      label: msg("rulesStrip.format"),
      value: [
        variant ? variantOptionLabel(sportKey, variant, msg) : null,
        lichess ? msg("divBuilder.review.lichess", { control: timeControlLabel ?? "—" }) : null,
        lichess ? msg("divBuilder.review.camera", { policy: cameraSummary(cameraChoice, inheritedCameraPolicy, msg) }) : null,
        ...rulesSummary,
      ]
        .filter((x) => x !== null)
        .join(" · "),
      later: msg("divBuilder.review.later.rules"),
    },
    ...(draftTableKinds.length > 0
      ? [
          {
            id: "points",
            step: "rules" as const,
            label: msg("stagePoints.title"),
            value:
              pointsHeadline === null
                ? msg(ownPoints ? "divBuilder.review.own" : "divBuilder.review.sports")
                : msg(ownPoints ? "divBuilder.review.points.own" : "divBuilder.review.points.sports", { points: pointsHeadline }),
            later: msg("divBuilder.review.later.rules"),
          },
          {
            id: "tiebreaks",
            step: "rules" as const,
            label: msg("stageTiebreaks.title"),
            value:
              orderText === null
                ? msg(tiebreakOrder === null ? "divBuilder.review.sports" : "divBuilder.review.own")
                : msg(tiebreakOrder === null ? "divBuilder.review.order.sports" : "divBuilder.review.order.own", { order: orderText }),
            later: msg("divBuilder.review.later.rules"),
          },
        ]
      : []),
    {
      id: "schedule",
      step: "rules",
      label: msg("divBuilder.schedule.title"),
      value: [
        msg("divBuilder.review.minutes", { minutes: matchMinutes }),
        DATETIME_LOCAL_VALUE.test(scheduleStart)
          ? msg("divBuilder.review.starts", { date: new Date(scheduleStart).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" }) })
          : msg("divBuilder.review.noStart"),
        courts.length > 0 ? placesText(courts.length) : msg("divBuilder.review.noPlaces"),
      ].join(" · "),
      later: msg("divBuilder.review.later.schedule"),
    },
  ];

  // A check's refusal reads the check as it stands (the first problem on that step now), never the sentence it was raised with.
  const stepError = error !== null && error.step === step ? (error.check ? (problems[error.step] ?? error.text) : error.text) : null;
  const section = (s: BuilderStep) => `space-y-4 ${step === s ? "" : "hidden"}`;

  return (
    <form onSubmit={(e) => e.preventDefault()} className="min-w-0 space-y-5" data-testid="division-builder" data-step={step}>
      {/* Step navigation. One DOM: below md the labels fold to the numbers and the current step's name is said under
          them; every button is a 44px target. */}
      <nav aria-label={msg("divBuilder.steps")} className="min-w-0">
        <ol className="grid grid-cols-4 gap-2">
          {BUILDER_STEPS.map((s, i) => {
            const current = s === step;
            const done = i < stepIndex;
            const flagged = error !== null && error.step === s;
            return (
              <li key={s} className="min-w-0">
                <button
                  type="button"
                  onClick={() => goTo(s)}
                  aria-current={current ? "step" : undefined}
                  data-testid={`division-builder-step-${s}`}
                  className={`flex min-h-11 w-full min-w-0 items-center gap-2 rounded-lg border px-2 text-left text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-600 max-md:justify-center ${
                    current ? "border-purple-500 bg-purple-50 text-purple-800" : "border-slate-200 bg-white text-slate-600 hover:border-purple-200"
                  }`}
                >
                  {/* The number is drawn, not written: the button's name is the step's name. */}
                  <span
                    aria-hidden="true"
                    data-n={i + 1}
                    className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold before:content-[attr(data-n)] ${
                      flagged ? "bg-red-600 text-white" : current ? "bg-purple-600 text-white" : done ? "bg-purple-100 text-purple-700" : "bg-slate-100 text-slate-500"
                    }`}
                  />
                  <span className="min-w-0 truncate max-md:sr-only">{msg(STEP_LABEL[s])}</span>
                </button>
              </li>
            );
          })}
        </ol>
        <p className="mt-2 text-sm font-semibold text-slate-800 md:hidden" data-testid="division-builder-step-label">
          {msg("divBuilder.stepOf", { n: stepIndex + 1, total: BUILDER_STEPS.length })} · {msg(STEP_LABEL[step])}
        </p>
      </nav>

      {/* ---------------- 1 Who plays ---------------- */}
      <section className={section("who")} data-testid="division-builder-who" aria-label={msg("divBuilder.step.who")}>
        {created !== null && <SavedNote name={created.name} />}
        {/* C9 fix round 1 (I1): once the division is saved (its stages refused), what it was saved with is read-only here -
            a retry sends the stages only, so an edit here would be silently dropped. */}
        {/* C9 review 2 (n5): once saved, the step reads as read-only - dimmed, as its disabled controls are - beside the
            note saying where it changes now. A disclosure closed then stays closed; Review lists what it holds. */}
        <fieldset disabled={saved} className="card min-w-0 space-y-4 p-4 transition-opacity disabled:opacity-70 md:p-6" data-testid="division-builder-who-fields">
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
              className="input min-h-11"
            />
          </label>
          <div>
            {/* C9 R2 (owner 2026-11-03, mock "Sport A"): a tile per sport, an icon and its name, in a radio group - native
                radios sharing one name, so the arrow keys move between the tiles and the pick is the checked radio. Five
                shown, then a Show more tile as the next cell; the picked sport is never folded away. */}
            <fieldset className="min-w-0" data-testid="division-builder-sport" aria-describedby="division-builder-sport-fixed">
              <legend className="label">{msg("wizard.sport")}</legend>
              <div id="division-builder-sports" className="grid grid-cols-2 gap-2 md:grid-cols-3" data-testid="division-builder-sports">
                {sportOrder.map((key) => {
                  const picked = key === sportKey;
                  return (
                    <label
                      key={key}
                      data-sport={key}
                      className={`${sportFolded(key) ? "hidden" : "flex"} min-h-14 min-w-0 cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm transition has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-purple-600 ${
                        picked ? "border-purple-500 bg-purple-50 font-semibold text-purple-900" : "border-slate-200 bg-white text-slate-700 hover:border-purple-200"
                      }`}
                    >
                      <input type="radio" name="division-sport" value={key} checked={picked} onChange={() => selectSport(key)} className="sr-only" />
                      <SportIcon sportKey={key} className={`shrink-0 ${picked ? "text-purple-600" : "text-slate-500"}`} />
                      {/* "Any other game" names the catch-all here only; everywhere else it keeps the catalogue's name. */}
                      <span className="min-w-0 break-words">{key === CATCH_ALL_SPORT ? msg("divBuilder.sport.generic") : sportLabel(key, msg)}</span>
                    </label>
                  );
                })}
                {(sportsOpen || sportsFoldedCount > 0) && (
                  <button
                    type="button"
                    onClick={() => setSportsOpen((v) => !v)}
                    aria-expanded={sportsOpen}
                    aria-controls="division-builder-sports"
                    data-testid="division-builder-sport-more"
                    className="flex min-h-14 min-w-0 items-center justify-center rounded-lg border border-dashed border-slate-300 bg-white px-3 py-2 text-center text-sm font-medium text-purple-700 transition hover:border-purple-300 hover:bg-purple-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-600"
                  >
                    {sportsOpen ? msg("divBuilder.showFewer") : msgPlural("divBuilder.sport.showMore", sportsFoldedCount, { count: sportsFoldedCount })}
                  </button>
                )}
              </div>
            </fieldset>
            {/* The group's description (aria-describedby above), not part of its name ("Sport"). */}
            <p id="division-builder-sport-fixed" className="mt-1 text-xs text-slate-500">
              {msg("divBuilder.sportFixed")}
            </p>
          </div>

          {entrantModel !== undefined && entrantKind !== null && (
            <fieldset data-testid="division-builder-entrant-kind" className="min-w-0">
              <legend className="label">{msg("divBuilder.entrants.label")}</legend>
              {entrantModel.kinds.length > 1 ? (
                <div className="flex flex-wrap gap-2">
                  {entrantModel.kinds.map((k) => (
                    <label
                      key={k}
                      data-entrant-kind={k}
                      className={`inline-flex min-h-11 cursor-pointer items-center rounded-full border px-4 text-sm transition has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-purple-600 ${
                        entrantKind === k ? "border-purple-500 bg-purple-50 font-medium text-purple-800" : "border-slate-200 text-slate-600 hover:border-purple-200"
                      }`}
                    >
                      <input
                        type="radio"
                        name="division-entrant-kind"
                        value={k}
                        checked={entrantKind === k}
                        onChange={() => {
                          setEntrantKind(k);
                          setEntrantKindTouched(true);
                          // N1: a pick the division of this kind cannot play (Americano, once it takes pairs or teams)
                          // is dropped, so the opening format applies again (n1).
                          setTemplatePicked((t) => pickAfterChange(t, formatOfferFor(sport, kindsFor(sport, k))));
                        }}
                        className="sr-only"
                      />
                      {kindLabel(k)}
                    </label>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-slate-700">{msg(KIND_ONLY[entrantModel.kinds[0] ?? entrantKind])}</p>
              )}
              <p className="mt-1 text-xs text-slate-500">{msg("divBuilder.entrants.later")}</p>
            </fieldset>
          )}

          <fieldset data-testid="division-builder-category" className="min-w-0">
            <legend className="label">{msg("reg.hub.config.category")}</legend>
            <div className="flex flex-wrap gap-2">
              {CATEGORIES.map((c) => (
                <label
                  key={c.key}
                  /* The bench's organiser driver clicks THIS, not the input: the radio is `sr-only`, so a real click on it
                   * is intercepted by this label. The hook lives on exactly one element per value (strict-mode safe). */
                  data-category={c.key}
                  className={`inline-flex min-h-11 cursor-pointer items-center rounded-full border px-4 text-sm transition has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-purple-600 ${
                    category === c.key ? "border-purple-500 bg-purple-50 font-medium text-purple-800" : "border-slate-200 text-slate-600 hover:border-purple-200"
                  }`}
                >
                  <input type="radio" name="division-category" value={c.key} checked={category === c.key} onChange={() => setCategory(c.key)} className="sr-only" />
                  {msg(c.labelKey)}
                </label>
              ))}
            </div>
          </fieldset>

          <div className="border-t border-slate-100 pt-3">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-800">{msg("divBuilder.eligibility.title")}</p>
                <p className="text-xs text-slate-500" data-testid="division-builder-eligibility-summary">
                  {maxAge && Number(maxAge) > 0 ? msg("divBuilder.review.under", { age: Number(maxAge) }) : msg("divBuilder.eligibility.open")}
                  {customNote.trim() ? ` · ${customNote.trim()}` : ""}
                </p>
              </div>
              <button
                type="button"
                aria-expanded={eligibilityOpen}
                aria-controls="division-builder-eligibility"
                data-testid="division-builder-eligibility-toggle"
                onClick={() => setEligibilityOpen((o) => !o)}
                className="btn btn-ghost min-h-11"
              >
                {eligibilityOpen ? msg("wizard.hide") : msg("divBuilder.eligibility.add")}
              </button>
            </div>
            {/* Folded, never unmounted: what was typed survives closing it. */}
            <div id="division-builder-eligibility" className={`mt-3 space-y-4 ${eligibilityOpen ? "" : "hidden"}`}>
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
                    data-testid="division-builder-age"
                    className="input min-h-11"
                  />
                </label>
                <label className="block">
                  <span className="label">{msg("wizard.cutoffMonth")}</span>
                  <select value={cutoffMonth} onChange={(e) => setCutoffMonth(e.target.value)} className="select min-h-11" disabled={!maxAge} data-testid="division-builder-cutoff-month">
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
                    className="input min-h-11"
                    disabled={!maxAge}
                    data-testid="division-builder-cutoff-day"
                  />
                </label>
              </div>
              <label className="block">
                <span className="label">{msg("wizard.customRule")}</span>
                <input
                  value={customNote}
                  onChange={(e) => setCustomNote(e.target.value)}
                  placeholder={msg("wizard.customRulePlaceholder")}
                  maxLength={2000}
                  data-testid="division-builder-note"
                  className="input min-h-11"
                />
              </label>
            </div>
          </div>
        </fieldset>
      </section>

      {/* ---------------- 2 Format ---------------- */}
      <section className={section("format")} data-testid="division-builder-format" aria-label={msg("wizard.tab.format")}>
        <div className="card space-y-4 p-4 md:p-6">
          <fieldset className="min-w-0" data-testid="division-builder-plan">
            <legend className="text-sm font-medium text-slate-800">{msg("divBuilder.plan.title")}</legend>
            <p className="text-xs text-slate-500" data-testid="division-builder-plan-note">
              {msg("divBuilder.plan.note", { minutes: plan.matchMinutes })}
            </p>
            <div className="mt-2 grid grid-cols-3 gap-2 md:max-w-md">
              <label className="block min-w-0">
                <span className="label">{msg("recommend.entrants")}</span>
                <input
                  type="number"
                  min={2}
                  max={64}
                  value={planEntrants}
                  onChange={(e) => setPlanEntrants(e.target.value)}
                  onBlur={() => setPlanEntrants(String(planNumber(planEntrants, PLAN_BOUNDS.entrants)))}
                  data-testid="division-builder-plan-entrants"
                  className="input min-h-11 w-full"
                />
              </label>
              <label className="block min-w-0">
                <span className="label">{msg(`divBuilder.plan.venues.${venue}` as MessageKey)}</span>
                <input
                  type="number"
                  min={1}
                  max={64}
                  value={planVenues}
                  onChange={(e) => setPlanVenues(e.target.value)}
                  onBlur={() => setPlanVenues(String(planNumber(planVenues, PLAN_BOUNDS.venues)))}
                  data-testid="division-builder-plan-venues"
                  className="input min-h-11 w-full"
                />
              </label>
              <label className="block min-w-0">
                <span className="label">{msg("divBuilder.plan.hours")}</span>
                <input
                  type="number"
                  min={1}
                  max={240}
                  value={planHours}
                  onChange={(e) => setPlanHours(e.target.value)}
                  onBlur={() => setPlanHours(String(planNumber(planHours, PLAN_BOUNDS.hours)))}
                  data-testid="division-builder-plan-hours"
                  className="input min-h-11 w-full"
                />
              </label>
            </div>
          </fieldset>

          <fieldset className="min-w-0">
            <legend className="text-sm font-medium text-slate-800">{showAll ? msg("divBuilder.allFormats") : msg("divBuilder.suggested")}</legend>
            <div id="division-builder-templates" className="mt-2 grid gap-2 md:grid-cols-2" data-testid="division-builder-templates">
              {/* The division's OFFER, not every template: chess is individual-only (owner ruling 2026-10-26), so it is
                  offered no americano/mexicano (format-templates.ts templatesForSport), nor is a division of pairs or
                  teams (C9 review 2, N1: formatOfferFor). In the picker's order: the ranking, Americano and Mexicano
                  after every other (C9 R2). */}
              {pickerOrder.map((key) => {
                const t = STAGE_TEMPLATES.find((x) => x.key === key)!;
                const row = ranked.find((r) => r.key === key)!;
                const picked = template === key;
                // The card's counts at the knobs as they stand for the picked card, the opening knobs for the rest.
                const est = picked ? estimate : row.estimate;
                const mins = picked ? estimateMins : row.minutes;
                const locked = templateLocks[key] !== undefined;
                return (
                  <label
                    key={t.key}
                    data-template={t.key}
                    data-suggested={suggested.includes(t.key) ? "" : undefined}
                    className={`${folded(t.key) ? "hidden" : "flex"} min-h-11 min-w-0 cursor-pointer gap-3 rounded-lg border p-3 text-sm transition has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-purple-600 ${
                      picked ? "border-purple-500 bg-purple-50 text-purple-900" : "border-slate-200 bg-white text-slate-700 hover:border-purple-200"
                    }`}
                  >
                    <input type="radio" name="template" checked={picked} onChange={() => setTemplatePicked(t.key)} className="sr-only" />
                    <FormatShape stages={t.build({ qualified: 4, swissRounds: 3, poolCount: 2, legs: 1 })} className={`shrink-0 ${picked ? "text-purple-600" : "text-slate-400"}`} />
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-x-2">
                        {/* t.key is a plain string, so the key cannot be checked against MessageKey's union without a
                            cast; format-templates.test.ts's dictionary-coverage test is the runtime backstop. */}
                        <span className="font-medium">{msg(`format.template.${t.key}.label` as MessageKey)}</span>
                        {locked && <span className="rounded bg-amber-100 px-1.5 text-[11px] font-semibold text-amber-800">{msg("divBuilder.card.pro")}</span>}
                      </span>
                      <span className="mt-0.5 block text-xs text-slate-500">{msg(`format.template.${t.key}.help` as MessageKey)}</span>
                      <span className="mt-1 block text-xs font-medium text-slate-700" data-testid={`division-builder-estimate-${t.key}`}>
                        {est.matches === null
                          ? msg("divBuilder.card.noDraw")
                          : [msgPlural("divBuilder.card.matches", est.matches, { count: est.matches }), mins === null ? null : msg("divBuilder.card.about", { time: hoursText(mins) })]
                              .filter((x) => x !== null)
                              .join(" · ")}
                      </span>
                    </span>
                  </label>
                );
              })}
              {/* C9 R2: Show more is the grid's next cell (the sixth, collapsed), a card-sized tile with a dashed edge -
                  beside the fifth card it takes that row's height. */}
              {(showAll || foldedCount > 0) && (
                <button
                  type="button"
                  onClick={() => setShowAll((v) => !v)}
                  aria-expanded={showAll}
                  aria-controls="division-builder-templates"
                  data-testid="division-builder-show-all"
                  className="flex min-h-20 min-w-0 items-center justify-center rounded-lg border border-dashed border-slate-300 bg-white p-3 text-center text-sm font-medium text-purple-700 transition hover:border-purple-300 hover:bg-purple-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-600"
                >
                  {showAll ? msg("divBuilder.showFewer") : msg("divBuilder.showAll", { count: foldedCount })}
                </button>
              )}
            </div>
          </fieldset>

          {templateLock !== undefined && (
            <UpgradeGate feature={templateLock} reason={paywallReasonForStages(templateLock, stagesNow)} compact viewerPlan={viewerPlan} />
          )}

          <div className="grid gap-4 sm:grid-cols-3">
            {showLegs && (
              <div className="sm:col-span-2">
                <LegsChoice legend={msg("wizard.legs")} legendClassName="label" value={legs} onChange={setLegs} />
              </div>
            )}
            {showPools && (
              <label className="block">
                <span className="label">{msg("wizard.pools")}</span>
                <input
                  type="number"
                  data-format-bound="pools"
                  min={FORMAT_BOUNDS.pools.min}
                  max={FORMAT_BOUNDS.pools.max}
                  value={poolCount}
                  onChange={(e) => setPoolCount(Number(e.target.value))}
                  className="input min-h-11"
                />
              </label>
            )}
            {showRounds && (
              <div>
                <label className="block">
                  <span className="label">{msg("wizard.rounds")}</span>
                  <input
                    type="number"
                    data-format-bound="swissRounds"
                    min={FORMAT_BOUNDS.swissRounds.min}
                    max={FORMAT_BOUNDS.swissRounds.max}
                    value={swissRounds}
                    onChange={(e) => setSwissRoundsPicked(Number(e.target.value))}
                    aria-describedby="builder-swiss-rounds-guidance"
                    className="input min-h-11"
                  />
                </label>
                {/* W3 T11 (X-SW-16): the builder has no roster yet, so the plan's entrant count is the one the line uses.
                    OUTSIDE the label, so it is the box's description, not part of its name. */}
                <p id="builder-swiss-rounds-guidance" data-testid="builder-swiss-rounds-guidance" className="mt-1 text-xs text-slate-500">
                  {swissRoundsGuidanceLine(plan.entrants, msgPlural)}
                </p>
              </div>
            )}
            {hasSecondStage && (
              <label className="block">
                <span className="label">{msg("wizard.qualify")}</span>
                <input
                  type="number"
                  data-format-bound="qualify"
                  min={FORMAT_BOUNDS.qualify.min}
                  max={FORMAT_BOUNDS.qualify.max}
                  value={qualified}
                  onChange={(e) => setQualified(Number(e.target.value))}
                  className="input min-h-11"
                />
              </label>
            )}
            {showStandingsCarry && (
              <label className="block">
                <span className="label">{msg("format.carry.label")}</span>
                <select data-testid="division-builder-carry" value={standingsCarry} onChange={(e) => setStandingsCarry(e.target.value as StandingsCarry)} className="select min-h-11">
                  <option value="none">{msg("format.carry.none")}</option>
                  <option value="points">{msg("format.carry.points")}</option>
                  <option value="full">{msg("format.carry.full")}</option>
                </select>
                <span className="mt-0.5 block text-xs text-slate-500">{msg("format.carry.help")}</span>
              </label>
            )}
          </div>
          {carryLocked && <UpgradeGate feature="standings.carry_over" compact viewerPlan={viewerPlan} />}

          <div className="flex flex-wrap items-center gap-3">
            {TEMPLATE_FAMILY[template] && (
              <button type="button" onClick={() => setExplainOpen(true)} className="min-h-11 text-sm font-medium text-purple-700 underline underline-offset-2 hover:text-purple-900">
                {msg("wizard.howWorks")}
              </button>
            )}
            <p className="text-xs text-slate-500">{msg("wizard.generatedHint")}</p>
          </div>
          {explainOpen && TEMPLATE_FAMILY[template] && <FormatExplainerPanel familySlug={TEMPLATE_FAMILY[template]} onClose={() => setExplainOpen(false)} />}

          <div className="border-t border-slate-100 pt-4">
            {!previewOpen ? (
              <button
                type="button"
                onClick={() => {
                  setPreviewOpen(true);
                  void runPreview(); // always reflect the current format
                }}
                className="btn btn-ghost min-h-11 text-sm"
              >
                {msg("wizard.showExample")}
              </button>
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-slate-700">{msg("wizard.exampleFixtures")}</span>
                  <button type="button" onClick={() => void runPreview()} disabled={previewBusy} className="btn btn-primary min-h-11 px-3 text-xs">
                    {previewBusy ? "…" : msg("wizard.generate")}
                  </button>
                  <button type="button" onClick={() => setPreviewOpen(false)} className="btn btn-ghost min-h-11 px-3 text-xs">
                    {msg("wizard.hide")}
                  </button>
                  <span className="text-[11px] text-slate-500">{msg("wizard.placeholderNote")}</span>
                </div>
                {previewError && <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">{previewError}</p>}
                {preview?.map((phase, pi) => (
                  <div key={pi} className="rounded-lg border border-slate-200 p-3">
                    <p className="text-sm font-semibold text-slate-800">{phase.title}</p>
                    {phase.note && <p className="mt-0.5 text-xs text-slate-500">{phase.note}</p>}
                    <div className="mt-2 grid gap-3 sm:grid-cols-2">
                      {phase.sections.map((sec, si) => (
                        <div key={si} className="min-w-0">
                          <p className="mb-1 text-xs font-semibold text-slate-500">{sec.title}</p>
                          <ul className="space-y-0.5">
                            {sec.matches.map((m, mi) => (
                              <li key={mi} className="flex min-w-0 items-center gap-1.5 text-xs text-slate-600">
                                <span className="truncate font-medium text-slate-700">{m.home}</span>
                                <span className="text-slate-400">v</span>
                                <span className="truncate font-medium text-slate-700">{m.away}</span>
                              </li>
                            ))}
                            {sec.matches.length === 0 && <li className="text-xs text-slate-400">—</li>}
                          </ul>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ---------------- 3 Division rules ---------------- */}
      <section className={section("rules")} data-testid="division-builder-rules" aria-label={msg("rulesStrip.title")}>
        {created !== null && <SavedNote name={created.name} />}
        {/* I1: the rules were saved with the division - read-only on a retry; the schedule card below is not saved yet. */}
        <fieldset disabled={saved} className="min-w-0 transition-opacity disabled:opacity-70" data-testid="division-builder-rules-fields">
        {sportModule !== null && sport !== undefined && (
          <DivisionRulesStrip
            // The draft has no division yet; the strip never PATCHes in draft mode (it throws if it ever tried).
            divisionId=""
            sportKey={sportKey}
            variantKey={variantKey}
            divisionConfig={builderCfg}
            divisionTiebreakers={null}
            tableKinds={draftTableKinds}
            canEdit
            ruleDict={ruleDict}
            pointsDict={pointsDict}
            variants={sport.variants}
            lockedFields={[]}
            onlineChessOffered={onlineChessOffered}
            initialOpen={["format"]}
            draft={{
              variantKey,
              onVariantChange: selectVariant,
              ruleValues,
              setRuleValues,
              onlinePlay,
              setOnlinePlay,
              pointsValues,
              setPointsValues,
              order: tiebreakOrder,
              setOrder: setTiebreakOrder,
              cameraControl: (
                <div>
                  <label className="block">
                    <span className="label">{msg("divset.camera.label")}</span>
                    <select
                      value={cameraChoice}
                      onChange={(e) => setCameraChoice(e.target.value as CameraChoice)}
                      className="select block min-h-11 w-full md:max-w-xs"
                      data-testid="division-builder-camera"
                    >
                      {cameraSelectOptions(msg).map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  {cameraChoice === CAMERA_INHERIT && (
                    <p className="mt-1 text-[11px] text-slate-600" data-testid="division-builder-camera-inherited">
                      {msg("divBuilder.camera.inherited", { policy: cameraSelectOptions(msg).find((o) => o.value === inheritedCameraPolicy)?.label ?? inheritedCameraPolicy })}
                    </p>
                  )}
                  <p className="mt-1 text-[11px] text-slate-600">{msg("divset.camera.help")}</p>
                </div>
              ),
            }}
          />
        )}
        </fieldset>

        <div className="card space-y-4 p-4 md:p-6" data-testid="division-builder-schedule">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-slate-900">
                {msg("divBuilder.schedule.title")} <span className="ml-1 text-xs font-normal text-slate-500">{msg("wizard.optional")}</span>
              </h2>
              <p className="mt-0.5 text-xs text-slate-600">{msg("divBuilder.schedule.hint", { minutes: matchMinutes })}</p>
            </div>
            <button
              type="button"
              aria-expanded={scheduleOpen}
              aria-controls="division-builder-schedule-body"
              data-testid="division-builder-schedule-toggle"
              onClick={() => setScheduleOpen((o) => !o)}
              className="btn btn-ghost min-h-11"
            >
              {scheduleOpen ? msg("wizard.hide") : msg("divBuilder.schedule.set")}
            </button>
          </div>
          <div id="division-builder-schedule-body" className={`space-y-4 ${scheduleOpen ? "" : "hidden"}`}>
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
                  data-testid="division-builder-match-minutes"
                  className="input min-h-11 w-full"
                />
                <span className="mt-0.5 block text-xs text-slate-500">{msg("wizard.matchLengthHint")}</span>
              </label>
              <DateTimeField kind="datetime-local" label={msg("boardset.startAt")} value={scheduleStart} {...divisionStartBounds(competitionWindow)} onChange={setScheduleStart} />
              {/* The hint sits beside the field rather than inside its <label>: DateTimeField owns the label element. */}
              <div>
                <DateTimeField kind="date" label={msg("boardset.endAt")} value={scheduleEnd} {...divisionEndBounds(competitionWindow, scheduleStart)} onChange={setScheduleEnd} />
                <span className="mt-0.5 block text-xs text-slate-500">{msg("wizard.endDateHint")}</span>
              </div>
            </div>
            <div>
              {/* P9 scope item 5: real org courts, multi-selected and ordered. */}
              <CourtMultiPicker
                venues={venues}
                value={courts}
                onChange={setCourts}
                maxSelected={constraintsAllowed ? undefined : 1}
                label={msg("boardset.venuesLabel", { venue: pluralizeVenue(VenueCap) })}
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
                <div className="mt-2 space-y-1">
                  <p className="text-xs text-slate-500">{msg("wizard.venuesProHint", { venue })}</p>
                  <UpgradeGate feature="scheduling.constraints" compact viewerPlan={viewerPlan} />
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* ---------------- 4 Review ---------------- */}
      <section className={section("review")} data-testid="division-builder-review" aria-label={msg("divBuilder.step.review")}>
        <div className="card space-y-4 p-4 md:p-6">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">{msg("divBuilder.review.title")}</h2>
            <p className="mt-0.5 text-xs text-slate-600">{msg("divBuilder.review.lead", { count: plan.entrants })}</p>
          </div>
          <dl className="grid grid-cols-2 gap-2 md:grid-cols-4" data-testid="division-builder-totals">
            {[
              [msgPlural("divBuilder.review.stages", estimate.stages.length, { count: estimate.stages.length }), "stages"],
              [estimate.matches === null ? msg("divBuilder.card.noDraw") : msgPlural("divBuilder.card.matches", estimate.matches, { count: estimate.matches }), "matches"],
              [estimate.rounds === null ? "—" : msgPlural("divBuilder.card.rounds", estimate.rounds, { count: estimate.rounds }), "rounds"],
              [estimateMins === null ? "—" : msg("divBuilder.review.time", { time: hoursText(estimateMins), places: placesText(plan.venues), minutes: plan.matchMinutes }), "time"],
            ].map(([text, id]) => (
              <div key={id} className="min-w-0 rounded-lg bg-slate-50 px-3 py-2" data-total={id}>
                <dd className="text-sm font-semibold text-slate-900">{text}</dd>
              </div>
            ))}
          </dl>
          <ol className="space-y-1" data-testid="division-builder-stages">
            {estimate.stages.map((s, i) => (
              <li key={i} className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm text-slate-700" data-stage-kind={s.kind}>
                <span className="font-medium text-slate-900">
                  {i + 1}. {s.name}
                </span>
                <span className="text-xs text-slate-600">
                  {[
                    msgPlural("divBuilder.review.entrants", s.entrants, { count: s.entrants }),
                    s.matches === null ? msg("divBuilder.card.noDraw") : msgPlural("divBuilder.card.matches", s.matches, { count: s.matches }),
                    s.rounds === null ? null : msgPlural("divBuilder.card.rounds", s.rounds, { count: s.rounds }),
                  ]
                    .filter((x) => x !== null)
                    .join(" · ")}
                </span>
              </li>
            ))}
          </ol>
        </div>

        <ul className="card divide-y divide-slate-100 p-0" data-testid="division-builder-receipt">
          {reviewRows.map((r) => (
            <li key={r.id} className="flex min-w-0 items-start justify-between gap-3 px-4 py-3" data-review-row={r.id}>
              <div className="min-w-0">
                <p className="text-xs font-semibold text-slate-600">{r.label}</p>
                <p className="min-w-0 break-words text-sm text-slate-900">{r.value}</p>
                <p className="mt-0.5 text-xs text-slate-500">{rowSaved(r.id) ? msg("divBuilder.review.savedLater") : r.later}</p>
              </div>
              {rowSaved(r.id) ? (
                <span className="shrink-0 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-800" data-testid={`division-builder-saved-${r.id}`}>
                  {msg("divBuilder.review.saved")}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => goTo(r.step, { fromReview: true })}
                  aria-label={msg("divBuilder.review.editRow", { row: r.label })}
                  data-testid={`division-builder-edit-${r.id}`}
                  className="btn btn-ghost min-h-11 shrink-0 px-3 text-sm"
                >
                  {msg("divBuilder.review.edit")}
                </button>
              )}
            </li>
          ))}
        </ul>

        {created !== null && (
          <p role="status" className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800" data-testid="division-builder-created-no-stages">
            {msg("divBuilder.created.noStages", { name: created.name })}
          </p>
        )}
        {/* Drawn only on Review (the step it is about), so the sentence is not also in the hidden markup of the step
            the organiser is mending. */}
        {step === "review" && blocked !== null && (
          <div role="status" className="flex min-w-0 flex-wrap items-center gap-2 rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700" data-testid="division-builder-blocked">
            <span className="min-w-0">{msg("divBuilder.review.blocked", { step: msg(STEP_LABEL[blocked]), reason: problems[blocked]! })}</span>
            <button type="button" onClick={() => goTo(blocked)} className="btn btn-ghost min-h-11 px-3 text-sm">
              {msg("divBuilder.review.goTo", { step: msg(STEP_LABEL[blocked]) })}
            </button>
          </div>
        )}
      </section>

      {paywallFeature && (
        <div className="space-y-2">
          <UpgradeGate feature={paywallFeature} reason={paywallReason} viewerPlan={viewerPlan} />
          {/* The invisible cause (V354): an archived-but-played division keeps its slot, so the console shows fewer
              divisions than the limit. Gated on BOTH the feature key and the server's marginality answer. */}
          {paywallFeature === "divisions.per_competition.max" && archivedSlotsExplainRefusal && (
            <p data-archived-slot-note className="text-xs text-slate-500">
              {msg("division.limit.archivedCount")}
            </p>
          )}
        </div>
      )}
      {stepError !== null && (
        <p role="alert" data-testid="division-builder-error" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
          {stepError}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" onClick={() => router.push(routes.competition(orgSlug, compSlug))} className="btn btn-ghost min-h-11">
          {msg("wizard.cancel")}
        </button>
        <div className="flex flex-wrap justify-end gap-2">
          {stepIndex > 0 && (
            <button type="button" onClick={() => goTo(BUILDER_STEPS[stepIndex - 1]!)} className="btn btn-ghost min-h-11" data-testid="division-builder-back">
              {msg("wizard.back")}
            </button>
          )}
          {fromReview && step !== "review" && (
            <button type="button" onClick={() => goTo("review")} className="btn btn-ghost min-h-11" data-testid="division-builder-back-to-review">
              {msg("divBuilder.backToReview")}
            </button>
          )}
          {step === "review" ? (
            <button
              type="button"
              data-testid="division-builder-create"
              onClick={() => void submit()}
              disabled={busy || blocked !== null}
              className="btn btn-primary min-h-11"
            >
              {busy ? msg("wizard.creating") : created !== null ? msg("divBuilder.create.stages") : msg("wizard.create")}
            </button>
          ) : (
            <button type="button" data-testid="division-builder-next" onClick={goNext} className="btn btn-primary min-h-11">
              {msg("wizard.next")}
            </button>
          )}
        </div>
      </div>
    </form>
  );
}
