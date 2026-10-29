"use client";

// Division Settings tab (v8 spec §2): General → Format → Sharing & embed →
// Danger zone, tap-per-section. Two locks, two doors (W2c Task 20, S4), and the form names each BEFORE anyone types:
//  - the stage STRUCTURE (template, knobs) hides behind a note once fixtures exist - `replaceStages` refuses on any
//    fixture row, so `structureLocked` is "fixtures exist" (formatAlreadyLocked);
//  - the match RULES (variant, points, every rule field) lock per field and per STARTED stage that inherits them -
//    `patchDivision` refuses a locked key and saves the rest. `lockedFields` is that same read (`divisionLockedFields`),
//    handed down by the page; a save's own `refused` (a 200 that kept part of it, or a 409) covers a stage that started after
//    the page loaded, and names every kept field instead of reading "saved" over a value that snapped back.
import { useEffect, useState, type ReactNode } from "react";
import Link from "@/components/ui/console-link";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { settingsSaveErrorText } from "@/lib/config-issue-copy";
import { divisionAccent, monogram } from "@/lib/division-hue";
import { SWISS_ROUNDS_REQUIRED_CODE } from "@/lib/swiss-shell";
import { ONLINE_CHESS_DISABLED_CODE } from "@/lib/online-chess";
import {
  CHESS_INDIVIDUAL_ONLY,
  entrantsOverrideWidensBeyondIndividual,
  isChessSport,
} from "@/lib/chess-individual-only";
import { CAMERA_POLICIES, type CameraPolicy } from "@/lib/camera-policy";
import { MatchRuleFields, hydrateRuleValues, rulesFor } from "./match-rules";
import { visibleRuleFields } from "@/lib/match-rules";
import { configUnderVariant, divisionFormatPatch, ruleValuesAfterVariantSwitch } from "./division-format-patch";
import {
  LICHESS_CLOCK_FIELD_KEYS,
  selectedTimeControlKey,
  timeControlOptions,
  timeControlRuleValues,
} from "@/lib/online-time-control";
import {
  RULE_LOCK_PARTIAL_KEY,
  lockLineFor,
  lockSentence,
  mergeLocks,
  refusedLines,
  type RefusedLine,
} from "./division-settings-locks";
import { keptPinnedOf, refusedFieldsOf, type KeptPinnedStage, type RefusedField } from "@/lib/rule-errors";
import {
  STAGE_TEMPLATES,
  applyStandingsCarry,
  buildTemplateStages,
  clampKnob,
  detectTemplate,
  templateHasProgression,
  templatesForSport,
  type StageDraft,
  type StandingsCarry,
  type TemplateKnobs,
} from "@/lib/format-templates";
import { UpgradeGate } from "@/components/upgrade-gate";
import { useLocaleOrDefault, useMsg, useMsgPlural } from "@/components/i18n/dict-provider";
import { sportLabel } from "@/lib/scoring-vocab";
import { variantHintKey, variantOptionLabel, variantWord } from "@/lib/variant-label-keys";
import { hasLinkGaps, linkGapSentence, type LinkGapsSummary } from "@/lib/online-link-gaps";
import { TagChipInput } from "@/components/ui/tag-chip-input";
import type { MessageKey } from "@/lib/messages";
import type { EffectiveEntrantModel } from "@seazn/engine/sport";
import type { ViewerPlan } from "@/lib/viewer-plan";

// The three entrant shapes, in a stable display order. The effective model
// (module default ← division override) decides which are ticked.
const ENTRANT_KINDS = ["individual", "pair", "team"] as const;
const KIND_LABEL_KEY: Record<(typeof ENTRANT_KINDS)[number], MessageKey> = {
  individual: "divset.entrants.kind.individual",
  pair: "divset.entrants.kind.pair",
  team: "divset.entrants.kind.team",
};

// One option label per declared camera policy (lib/camera-policy.ts is the
// vocabulary; camera-policy-copy.test.ts sweeps it against all four locales).
const CAMERA_OPTION_KEY: Record<CameraPolicy, MessageKey> = {
  off: "divset.camera.off",
  optional: "divset.camera.optional",
  required: "divset.camera.required",
};

/** M-4 (fix round 2026-10-09): the select's "use the competition setting"
 *  choice. It is not a policy: saving it sends `camera_policy: null`, which
 *  patchDivision gates and audits on the EFFECTIVE change it makes (clearing
 *  to inherit a stricter competition after a round opens is 409). */
export const CAMERA_INHERIT = "inherit" as const;
export type CameraChoice = CameraPolicy | typeof CAMERA_INHERIT;

/** The division's stored value as a select choice: null is inherit. */
export const cameraChoiceOf = (own: CameraPolicy | null): CameraChoice => own ?? CAMERA_INHERIT;

/** What a save sends for a choice: inherit clears the division's own value. */
export const cameraPatchValue = (choice: CameraChoice): CameraPolicy | null =>
  choice === CAMERA_INHERIT ? null : choice;

/** What players get under a choice at division level (a pin wins, even
 *  downwards; inherit is the competition's value). */
export const effectiveCameraChoice = (choice: CameraChoice, inherited: CameraPolicy): CameraPolicy =>
  choice === CAMERA_INHERIT ? inherited : choice;

type CameraMsg = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** The select's options: return-to-inherit FIRST, then each declared policy
 *  once — every label SHORT, with no value inside (controller ruling r3): a
 *  select cannot wrap, and at 320px the long labels clipped exactly the part
 *  that mattered. Explanations live in the help text; the competition's value
 *  in the hint line (cameraInheritHint) and the summary (cameraSummary). */
export function cameraSelectOptions(msg: CameraMsg): { value: CameraChoice; label: string }[] {
  return [
    { value: CAMERA_INHERIT, label: msg("divset.camera.inheritOption") },
    ...CAMERA_POLICIES.map((p) => ({ value: p, label: msg(CAMERA_OPTION_KEY[p]) })),
  ];
}

/** The hint under the select naming the competition's current value — shown
 *  only while inherit is SELECTED (a select is never the only place a value
 *  is visible, and this line can wrap where an option cannot). Its wording
 *  follows the SAVED state (review Minor 3): "not set for this division" is
 *  true only once inherit is stored; an unsaved inherit choice on a pinned
 *  division says what saving will do instead. */
export function cameraInheritHint(
  choice: CameraChoice,
  stored: CameraChoice,
  inherited: CameraPolicy,
  msg: CameraMsg,
): string | null {
  if (choice !== CAMERA_INHERIT) return null;
  const policy = msg(CAMERA_OPTION_KEY[inherited]);
  return stored === CAMERA_INHERIT
    ? msg("divset.camera.inherited", { policy })
    : msg("divset.camera.inheritPending", { policy });
}

/** The collapsed Group's summary for the STORED choice: a pin's short label,
 *  or the competition setting with its value. */
export function cameraSummary(choice: CameraChoice, inherited: CameraPolicy, msg: CameraMsg): string {
  return choice === CAMERA_INHERIT
    ? msg("divset.camera.inheritSummary", { policy: msg(CAMERA_OPTION_KEY[inherited]) })
    : msg(CAMERA_OPTION_KEY[choice]);
}

export interface DivisionSettingsInfo {
  id: string;
  name: string;
  sport_key: string;
  variant_key: string;
  config: unknown;
  logo_url: string | null;
  logo_storage_path: string | null;
  /** D5/P9 candidate-court filter (tags ⊇ required_court_tags; empty = any
   *  court) — stored and read back by this picker (server: PatchDivision +
   *  COLS, usecases/divisions.ts); not yet READ by scheduling or
   *  candidate-court filtering, which is P9's. Optional (not required) so
   *  existing callers/fixtures that predate this field — the page always
   *  passes it, but division-settings-entrants.test.tsx and any other
   *  DivisionSettingsInfo fixture do not — keep compiling and rendering; the
   *  component defaults a missing value to "no requirement" rather than
   *  throwing. */
  required_court_tags?: string[];
  /** T6 — the division's OWN camera policy; null = inherit the competition's.
   *  Optional for the same reason as required_court_tags: fixtures that
   *  predate the field keep compiling, and a missing value reads as inherit. */
  camera_policy?: CameraPolicy | null;
  /** The competition's policy — what an unset division inherits. */
  inherited_camera_policy?: CameraPolicy;
}

function Group({
  title,
  summary,
  defaultOpen = false,
  danger = false,
  children,
}: {
  title: string;
  summary?: string;
  defaultOpen?: boolean;
  danger?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`card p-0 ${danger ? "border-red-200" : ""}`}>
      {/* Below md the summary takes a row of its own under the title (order +
          basis-full) instead of squeezing it: at 320px a long title next to a
          summary wrapped one word per line. md+ is one row, as before. */}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 px-5 py-3 text-left md:flex-nowrap md:justify-between"
      >
        <span className={`min-w-0 flex-1 text-sm font-semibold ${danger ? "text-red-700" : "text-slate-700"}`}>
          {title}
        </span>
        <span aria-hidden className="order-2 text-xs text-slate-500 md:order-3">{open ? "▾" : "▸"}</span>
        {summary && !open && (
          <span className="order-3 basis-full truncate text-xs text-slate-500 md:order-2 md:max-w-sm md:basis-auto">{summary}</span>
        )}
      </button>
      {open && <div className="space-y-3 px-5 pb-5">{children}</div>}
    </section>
  );
}

async function fileToWebp(file: File, max: number): Promise<Blob> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("bad image"));
    el.src = dataUrl;
  });
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));
  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/webp", 0.88),
  );
  if (!blob) throw new Error("image conversion failed");
  return blob;
}

/** Reverse-derives the picker's "how many qualify" knob from a division's
 *  stored stages, to pre-fill the Top-N-advance control when editing an
 *  existing format. Pure, so it's unit-testable without opening the
 *  "Format" Group (defaults closed — its children, including the control
 *  this feeds, never reach a static render or the interactive harness).
 *
 *  F2 (unified progression field): was `.qualification` (`topN` |
 *  `take.length`); now reads the FIRST stage's `.progression`, matching
 *  whichever TakeRule kind format-templates.ts's real specs emit —
 *  rankRange -> to-from+1 (league_ko/group_stepladder/group_playoffs/
 *  qualifying_main), roundLosers -> count (ko_plate), picks -> picks.length
 *  (a hand-built custom graph only — no current template emits it since
 *  ruling 11's groups_ko conversion).
 *
 *  A3 (round-4 review, MAJOR): groups_ko emits topNPerGroup (+ a bestNth
 *  remainder), never picks — this used to fall through every branch above
 *  and hit the `4` fallback for EVERY groups_ko division, regardless of its
 *  real qualifier count. topNPerGroup -> n × the group stage's pool count
 *  (config.pools.count on whichever earlier stage is kind:"group" — the take
 *  rule itself is pool-count-agnostic, so the count has to come from the
 *  sibling stage); bestNth -> its count. Summed, not early-returned, because
 *  groups_ko's real shape carries BOTH in the same take array (the
 *  cross-pool remainder — format-templates.ts) — every other template still
 *  emits exactly one recognised rule per take, so summing changes nothing
 *  for them. Falls back to 4, same default as before. */
export function currentQualifiedFromStages(
  stages: {
    kind?: string;
    config?: Record<string, unknown> | null;
    progression: Record<string, unknown> | null;
  }[],
): number {
  const stageIdx = stages.findIndex((st) => st.progression);
  const stage = stageIdx === -1 ? undefined : stages[stageIdx];
  const sources = (stage?.progression as { sources?: { take?: unknown[] }[] } | undefined)?.sources;
  const take = sources?.flatMap((s) => s.take ?? []) ?? [];
  // F3 ultrareview finding 8 — was `stages.find((st) => st.kind === "group")`,
  // the FIRST group stage in the division regardless of which stage this
  // progression actually reads. In a graph with two group phases (a
  // qualifying pool round into a main group stage, then a knockout) that
  // sized the knockout off the QUALIFYING round's pool count. Every template
  // this reads today declares `stage: "previous"`, so the correct source is
  // the stage immediately before the one carrying the progression — search
  // backwards from there rather than forwards from the start of the graph.
  // (An explicit `{stageId}` source is not resolvable here: these props are
  // draft/unsaved stages with no ids. Nearest-earlier remains the best
  // available answer for one, and is the exactly-right answer for the
  // "previous" every shipped template emits.)
  const poolCount =
    (stages
      .slice(0, stageIdx === -1 ? 0 : stageIdx)
      .reverse()
      .find((st) => st.kind === "group")?.config as { pools?: { count?: number } } | undefined)?.pools
      ?.count ?? 1;
  let total = 0;
  let matched = false;
  for (const t of take) {
    const rule = t as { kind?: string; from?: number; to?: number; count?: number; picks?: unknown[]; n?: number };
    if (rule.kind === "rankRange" && typeof rule.from === "number" && typeof rule.to === "number") {
      total += rule.to - rule.from + 1;
      matched = true;
    } else if (rule.kind === "picks" && Array.isArray(rule.picks)) {
      total += rule.picks.length;
      matched = true;
    } else if (rule.kind === "roundLosers" && typeof rule.count === "number") {
      total += rule.count;
      matched = true;
    } else if (rule.kind === "topNPerGroup" && typeof rule.n === "number") {
      total += rule.n * poolCount;
      matched = true;
    } else if (rule.kind === "bestNth" && typeof rule.count === "number") {
      total += rule.count;
      matched = true;
    }
  }
  return matched ? total : 4;
}

/** Reverse-derives the carry knob from stored progression stages. Pure. */
export function currentStandingsCarryFromStages(
  stages: { progression: StageDraft["progression"] }[],
): StandingsCarry {
  for (const st of stages) {
    if (!st.progression) continue;
    const carry = st.progression.carry;
    if (carry === "points" || carry === "full") return carry;
  }
  return "none";
}

/** Stage drafts applyStructure submits — pure mirror of its build path. */
export function structureDraftsForApply(
  templateKey: string,
  knobs: TemplateKnobs,
  carry: StandingsCarry,
): StageDraft[] {
  return applyStandingsCarry(
    buildTemplateStages(templateKey, {
      qualified: clampKnob(knobs.qualified, 2, 32),
      swissRounds: knobs.swissRounds,
      poolCount: clampKnob(knobs.poolCount, 2, 8),
      legs: knobs.legs,
    }),
    carry,
  );
}

/**
 * R3.5 review finding F7 — this editor used to hardcode `sportKey ===
 * "generic" ? w/d/l : win/draw/loss` for every OTHER sport. That shipped two
 * bugs: tennis and the nested-kernel family
 * (`packages/engine/src/sports/nested/kernel.ts:179`) declare
 * `points: { win, loss }` with no `draw` field at all, so the hardcoded
 * third box rendered a control that could never hold a value and, on save,
 * wrote a spurious `draw: 0` the schema doesn't use; cricket's
 * `{ win, tie, noResult, loss, draw? }`
 * (`packages/engine/src/sports/cricket/cricket.ts:52-60`) meant the same
 * hardcoded pair couldn't reach `tie`/`noResult` at all.
 *
 * Fix: derive the editable keys from the ACTUAL saved config's `points`
 * shape rather than from the sport key. The server's Zod parse
 * (`usecases/divisions.ts`) fills in every schema-declared key — with its
 * default — before `division.config` ever reaches this client component, so
 * `Object.keys(cfg.points)` already IS the sport module's declared shape;
 * no engine import needed here. `POINTS_KEY_CONCEPT` only recognises the
 * win/draw/loss concept (both the generic module's bare `w`/`d`/`l` and
 * everyone else's spelled-out names) — an unrecognised key is left out of
 * the rendered grid entirely and passes through on save via the spread in
 * `applyFormat`, untouched.
 *
 * Ruling (owner, R3.5 review): making cricket's `tie`/`noResult` genuinely
 * editable is a NEW capability (its own help copy, its own tests), not part
 * of this fix, and is deliberately left as a follow-up rather than
 * half-built here — a box with no help text explaining what a "no result"
 * pays would be the same dead/confusing-control defect in a new place.
 * `editablePointsKeys` also excludes any key a MatchRuleFields field already
 * owns a dedicated, better-explained input for (none today: football's
 * shoot-out points pair left in W2d, its `soBonus` is the stage Points
 * section's) so the two editors never double up on one key.
 */
const POINTS_KEY_CONCEPT: Record<string, { order: number; labelKey: MessageKey }> = {
  w: { order: 0, labelKey: "divset.win" },
  win: { order: 0, labelKey: "divset.win" },
  d: { order: 1, labelKey: "divset.draw" },
  draw: { order: 1, labelKey: "divset.draw" },
  l: { order: 2, labelKey: "divset.loss" },
  loss: { order: 2, labelKey: "divset.loss" },
};

function editablePointsKeys(sportKey: string, points: Record<string, unknown> | undefined): string[] {
  if (!points) return [];
  const dedicated = new Set(rulesFor(sportKey).map((f) => f.key));
  return Object.keys(points)
    .filter((k) => !dedicated.has(k) && POINTS_KEY_CONCEPT[k])
    .sort((a, b) => POINTS_KEY_CONCEPT[a]!.order - POINTS_KEY_CONCEPT[b]!.order);
}

/** Mirrors `hydrateRuleValues` (match-rules.tsx) for the points sub-object:
 *  initial string values for whatever keys `editablePointsKeys` says this
 *  sport's saved config actually has. */
function hydratePointsValues(sportKey: string, points: Record<string, unknown> | undefined): Record<string, string> {
  const values: Record<string, string> = {};
  for (const key of editablePointsKeys(sportKey, points)) {
    const v = points![key];
    if (typeof v === "number") values[key] = String(v);
  }
  return values;
}

export function DivisionSettings({
  division,
  orgId,
  variants,
  structureLocked,
  lockedFields,
  stages,
  canEdit,
  divisionPathPrefix,
  fixturesHref,
  embed,
  danger,
  entrantModel,
  entrantModelSource,
  autoPosts,
  canAutoPost,
  showSeeds,
  viewerPlan,
  onlineChessOffered,
  lichessGaps,
}: {
  division: DivisionSettingsInfo;
  /** Org id, for the tag-suggestions fetch only (the division PATCH itself
   *  is not org-scoped in its URL) — see saveRequiredCourtTags below. */
  orgId: string;
  /** `config` is the variant's preset as stored (only the keys it declares) and `system` marks a built-in: a variant switch
   *  needs the presets of BOTH ends (W2e Task 29), a picker the flag to localise a built-in's name and leave an org's own. */
  variants: { key: string; name: string; system?: boolean; config?: Record<string, unknown> }[];
  /** Fixtures exist - the stage structure cannot be replaced (`formatAlreadyLocked`, the page). NOT the rules: those lock
   *  per started stage (`lockedFields`), so a division with fixtures and no started stage keeps its rules editable. */
  structureLocked: boolean;
  /** Every field a started stage locks, read by the page from the same `divisionRefusals` the save asks
   *  (`divisionLockedFields`): each is read-only here with its line before the organiser types. */
  lockedFields: RefusedField[];
  /** Stage structure (kind + name) — shown so group/top sections are visible
   *  here; structure itself is edited on the Fixtures tab. */
  stages: {
    name: string;
    kind: string;
    config: Record<string, unknown> | null;
    /** F2 — shaped enough for detectTemplate/currentQualifiedFromStages to
     *  read take-rule kinds without a cast at either call site below; the
     *  page passes this through from StageRow's untyped JSONB column, so the
     *  narrowing cast belongs there, at the actual DB-read boundary. */
    progression: StageDraft["progression"];
  }[];
  canEdit: boolean;
  /** "/o/{org}/c/{comp}/d/" — renames regenerate the slug, and the client
   *  must follow it without losing the settings tab. */
  divisionPathPrefix: string;
  fixturesHref: string;
  /** Server-rendered EmbedSnippet (or the private-comp note). */
  embed: ReactNode;
  /** DivisionDangerZone, unchanged. */
  danger: ReactNode;
  /** Resolved effective entrant model (module default merged with any
   *  `config.entrants` override) — seeds the Entrants block's controls. */
  entrantModel: EffectiveEntrantModel;
  /** Whether the effective model comes from the sport default or a saved
   *  `config.entrants` override — drives the caption + Reset affordance. */
  entrantModelSource: "sport" | "override";
  /** SPEC-2 auto-draft opt-in (divisions.auto_posts). */
  autoPosts: boolean;
  /** news.auto entitlement (Pro) — off → the toggle shows the PlusReveal. */
  canAutoPost: boolean;
  /** V416: seeds on the public site (divisions.show_seeds). Not a paid
   *  layer — every organiser can hide their seeds. */
  showSeeds: boolean;
  viewerPlan: ViewerPlan;
  /** T20: the club is offered online chess (the PostHog flag `online-chess`, asked by the page). Off ⇒ the Online
   *  play select and the camera control are not rendered at all. A division already online keeps its stored value
   *  through a save — the select's state still starts from the config (applyFormat). */
  onlineChessOffered: boolean;
  /** The players in the field who cannot be paired online yet (`listLichessLinkGaps`, summarised by the page): those with
   *  no Lichess link, and those whose link cannot play and must be reconnected. Read only where the select renders. The
   *  warning under the Online play select reads it - while the FORM says Lichess, so it shows at the moment of switching
   *  and stays once saved - one sentence per kind (no link, reconnect, and an entrant with no player), each present only
   *  when somebody is in it, and never blocks the switch
   *  (owner ruling 2026-10-25). Absent or both counts `0` ⇒ no warning. */
  lichessGaps?: LinkGapsSummary;
}) {
  const msg = useMsg();
  const plural = useMsgPlural();
  const locale = useLocaleOrDefault();
  // The Format section names the division's sport and variant as WORDS (`sport.<key>`, `variant.<sport>.<variant>`),
  // never the stored keys: the key is the identity (`boardgame`), the word is what the organiser reads ("Chess").
  const sportName = sportLabel(division.sport_key, msg);
  const variantName = variantWord(division.sport_key, division.variant_key, msg);
  const router = useRouter();
  const [name, setName] = useState(division.name);
  const [logoUrl, setLogoUrl] = useState(division.logo_url);
  const [variantKey, setVariantKey] = useState(division.variant_key);
  // Competition format = the stage structure (League / Groups + Knockout…).
  const detected = detectTemplate(stages);
  const [template, setTemplate] = useState(detected ?? "league");
  // F3 Task 6: hoisted out of the JSX so the format <select>'s help caption
  // (:597) doesn't re-run STAGE_TEMPLATES.find for the same lookup the
  // <option> loop already keys off of.
  const selectedTemplate = STAGE_TEMPLATES.find((t) => t.key === template);
  const [qualified, setQualified] = useState(currentQualifiedFromStages(stages));
  const [poolCount, setPoolCount] = useState(
    ((stages.find((st) => st.kind === "group")?.config as { pools?: { count?: number } } | null)?.pools?.count) ?? 2,
  );
  const [swissRounds, setSwissRounds] = useState(
    ((stages.find((st) => st.kind === "swiss")?.config as { rounds?: number } | null)?.rounds) ?? 5,
  );
  const templateHasSwissRounds = ["swiss", "swiss_playoff", "swiss_knockout"].includes(template);
  const [legs, setLegs] = useState(
    ((stages.find((st) => st.kind === "league" || st.kind === "group")?.config as { legs?: number } | null)?.legs) ?? 1,
  );
  const [standingsCarry, setStandingsCarry] = useState<StandingsCarry>(() =>
    currentStandingsCarryFromStages(stages),
  );
  const cfg = (division.config ?? {}) as {
    points?: Record<string, number>;
    progressScore?: boolean;
    onlinePlay?: string;
  };
  // R3.5 review F7 — which boxes this editor shows/writes is derived from
  // the saved config's OWN points shape, not the sport key (see
  // editablePointsKeys above).
  const pointsFieldKeys = editablePointsKeys(division.sport_key, cfg.points);
  // The saved config the rule fields fall back to. ONE value read by the grid (`MatchRuleFields`) and by the "kept" lines
  // (`refusedLines`), so both see the same visible controls (batch-6 T20-1: best of 1 hides one of the points pair).
  // W2e Task 29: under the variant the form HOLDS, not the one saved - choosing 3x15 shows the fields (and converts cricket's
  // overs) by 3x15's numbers, and the same config is what Save builds from (`divisionFormatPatch` derives the same one).
  const presetOf = (key: string) => variants.find((v) => v.key === key)?.config;
  const savedConfig = (division.config as Record<string, unknown>) ?? {};
  const inheritedCfg = configUnderVariant(savedConfig, presetOf(division.variant_key), presetOf(variantKey), variantKey === division.variant_key);
  const pickVariantKey = (next: string) => {
    // The rule fields the organiser has not typed in take the new variant's own values, so the grid reads what Save will send.
    setRuleValues(
      ruleValuesAfterVariantSwitch({
        sportKey: division.sport_key,
        ruleValues,
        divisionConfig: savedConfig,
        savedPreset: presetOf(division.variant_key),
        fromPreset: presetOf(variantKey),
        toPreset: presetOf(next),
        savedKey: division.variant_key,
        fromKey: variantKey,
        toKey: next,
      }),
    );
    setVariantKey(next);
  };
  const variantHint = variantHintKey(division.sport_key, variantKey);
  const [pointsValues, setPointsValues] = useState<Record<string, string>>(() =>
    hydratePointsValues(division.sport_key, cfg.points),
  );
  const [ruleValues, setRuleValues] = useState<Record<string, string>>(() =>
    hydrateRuleValues(division.sport_key, division.config),
  );
  // R3.5 review F6 — hydratePointsValues/hydrateRuleValues above only ever
  // ran in the useState INITIALIZER, so once this instance is mounted,
  // saving through `run()` (every action in this component funnels through
  // it, and it always calls `router.refresh()`) swaps in a freshly-fetched
  // `division` prop that this already-mounted instance never re-reads:
  // ruleValues/pointsValues kept showing whatever the organiser last typed,
  // including a field the server clamped, defaulted, or (F5) deliberately
  // deleted.
  //
  // Render-time "derive from props" adjustment (the same pattern
  // use-board-actions.ts and cricket-skin.tsx's striker/nonStriker/bowler
  // resync already use in this codebase) rather than a useEffect: track the
  // LAST config CONTENT seen in its own state slot, and when the incoming
  // content differs, overwrite the derived state during render.
  //
  // Comparing the config's serialised CONTENT, never the `division.config`
  // object reference, is load-bearing: the server hands back a brand-new
  // object on every refresh even when nothing in it changed (an unrelated
  // save elsewhere in this same component — name, logo, entrants — refreshes
  // too), and reference comparison would resync on every one of those and
  // discard an in-progress edit here for no reason.
  // Declared ABOVE the resync below, which calls its setter: a `const` read
  // before its declaration is a temporal-dead-zone ReferenceError, so the
  // first config change after mount (any rules save → router.refresh())
  // crashed this tab (tsc TS2448 had been reporting it).
  const [onlinePlay, setOnlinePlay] = useState<"off" | "lichess">(
    cfg.onlinePlay === "lichess" ? "lichess" : "off",
  );
  const configSignature = JSON.stringify(division.config);
  const [syncedConfigSignature, setSyncedConfigSignature] = useState(configSignature);
  if (configSignature !== syncedConfigSignature) {
    setSyncedConfigSignature(configSignature);
    setRuleValues(hydrateRuleValues(division.sport_key, division.config));
    setPointsValues(hydratePointsValues(division.sport_key, cfg.points));
    setOnlinePlay(cfg.onlinePlay === "lichess" ? "lichess" : "off");
  }
  const [advancedText, setAdvancedText] = useState("");
  // T6 camera policy. The control shows the EFFECTIVE value (own, else the
  // competition's, else off); `ownCamera === null` is surfaced as inherited
  // rather than collapsed into "off" — the server keeps that distinction.
  // Online play gates the control on its SAVED value: the camera has its own
  // Save, so an unsaved choice in the Format group must not unlock it.
  // M-4: the select carries "use the competition setting" as its own choice,
  // so a pinned division can go back to inheriting (saved as null).
  const ownCamera: CameraPolicy | null = division.camera_policy ?? null;
  const inheritedCamera: CameraPolicy = division.inherited_camera_policy ?? "off";
  const storedCameraChoice = cameraChoiceOf(ownCamera);
  const cameraOptions = cameraSelectOptions(msg);
  const onlinePlaySaved = cfg.onlinePlay === "lichess";
  // While Online play is Lichess (the form's state, not the saved one) the clock is ONE select of the supported time
  // controls instead of free time/increment/delay inputs. Which option it shows is decided by the form values, else the
  // saved clock; "" (none of them) renders a prompt, never the first option. See lib/online-time-control.ts.
  const lichessClock = division.sport_key === "boardgame" && onlinePlay === "lichess";
  const timeControl = lichessClock ? selectedTimeControlKey(ruleValues, division.config) : "";
  const [cameraChoice, setCameraChoice] = useState<CameraChoice>(storedCameraChoice);
  const cameraHint = cameraInheritHint(cameraChoice, storedCameraChoice, inheritedCamera, msg);
  // Same derive-from-props resync as the config block above: a saved change
  // (or another tab's) arrives as new props after router.refresh().
  const cameraSignature = `${storedCameraChoice}|${inheritedCamera}`;
  const [syncedCameraSignature, setSyncedCameraSignature] = useState(cameraSignature);
  if (cameraSignature !== syncedCameraSignature) {
    setSyncedCameraSignature(cameraSignature);
    setCameraChoice(storedCameraChoice);
  }
  // Entrants block (spec 2026-07-18): the ticked kinds, the default, and the
  // team extras seed from the resolved effective model.
  // Chess is individual-only (owner ruling 2026-10-26): the block offers no kind to choose. A division saved before
  // the ruling can still hold a widened override; it is named and can be Reset, never edited or re-saved here.
  const chessOnly = isChessSport(division.sport_key);
  const chessLegacyEntrants =
    chessOnly && entrantsOverrideWidensBeyondIndividual((division.config as { entrants?: unknown } | null)?.entrants);
  const [entrantKinds, setEntrantKinds] = useState<string[]>(entrantModel.kinds);
  const [entrantDefault, setEntrantDefault] = useState<string>(entrantModel.defaultKind);
  const [squadNumbers, setSquadNumbers] = useState<boolean>(entrantModel.squadNumbers);
  const [captain, setCaptain] = useState<boolean>(entrantModel.captain);
  const [autoPostsOn, setAutoPostsOn] = useState<boolean>(autoPosts);
  const [showSeedsOn, setShowSeedsOn] = useState<boolean>(showSeeds);
  // D5/P8 required-court-tags picker (design doc §"Division settings:
  // required-tags picker"). Staged locally, explicit Save — same shape as
  // the Entrants block above, not autosave-per-chip like venues-panel's
  // court tags, because this file's OWN convention (every other multi-field
  // section here) is stage-then-Save.
  const [requiredCourtTags, setRequiredCourtTags] = useState<string[]>(division.required_court_tags ?? []);
  const [courtTagSuggestions, setCourtTagSuggestions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // What the last save kept, and whether the rest landed: a 200 with `refused[]` is a PARTIAL save (the line says what
  // landed and the list what did not); a 409 is a save where nothing landed (the red error, plus the list).
  const [refusedList, setRefusedList] = useState<RefusedField[]>([]);
  const [partialSave, setPartialSave] = useState(false);
  // W2d (PR B carry, I3): the pinned stages the last rules save did not reach (`stagesKeptPinned`). The save landed; each
  // such stage keeps the points and order it started with, which the notice says beside "Rules saved".
  const [keptPinned, setKeptPinned] = useState<KeptPinnedStage[]>([]);
  // Which save the notices belong to: the rules save (inside the Format group, directly under its Save) or any other (the foot
  // of the page, where they always were). One home per save, so each notice - and its testid - renders once.
  const [rulesSave, setRulesSave] = useState(false);
  // Fields a save refused that the page did not know were locked (a stage started after it loaded). Dropped when the page's
  // own list changes - the refresh after that save carries them - so a stage deleted since does not leave a stale lock.
  const [learnedLocks, setLearnedLocks] = useState<RefusedField[]>([]);
  const lockedSignature = JSON.stringify(lockedFields);
  const [syncedLockedSignature, setSyncedLockedSignature] = useState(lockedSignature);
  if (lockedSignature !== syncedLockedSignature) {
    setSyncedLockedSignature(lockedSignature);
    setLearnedLocks([]);
  }
  const locks = mergeLocks(lockedFields, learnedLocks);
  const variantLock = lockLineFor("variant_key", locks);
  const pointsLock = lockLineFor("points", locks);
  // The Lichess time-control picker stands in for the clock fields it omits (`variant` and the clock), so it is locked
  // when either is: a started stage that plays this clock refuses a change to it.
  const clockLock = lockLineFor("clock", locks, ["variant"]);
  const [paywallFeature, setPaywallFeature] = useState<string | null>(null);
  const fileInputId = `division-logo-${division.id}`;
  const hue = divisionAccent(division.id);

  // Tag suggestions for the picker below: every tag currently used by any
  // court in the org, ranked by count (same rule venues-panel.tsx applies to
  // a court's own tags — see `rankTagsByCount` there). A soft enhancement,
  // not core function: this tab has no other reason to fetch venues, so a
  // failure here is swallowed rather than surfaced as a page error.
  useEffect(() => {
    let cancelled = false;
    apiV1<{ courts: { tags: string[] }[] }[]>(`/api/v1/orgs/${orgId}/venues`)
      .then((venues) => {
        if (cancelled) return;
        const counts = new Map<string, number>();
        for (const v of venues) {
          for (const c of v.courts) {
            for (const tag of c.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
          }
        }
        setCourtTagSuggestions(
          [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag]) => tag),
        );
      })
      .catch(() => {
        /* suggestions are a nicety — free-form entry still works without them */
      });
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  // A refusal keeps what is STORED, so the control it locks must show that again, not what was typed (a locked box reading
  // 13 over a stored 11 says the save worked). Only the refused controls are reset: whatever else was typed stands.
  const restoreRefused = (refused: readonly RefusedField[]) => {
    if (lockLineFor("variant_key", refused) !== undefined) setVariantKey(division.variant_key);
    if (lockLineFor("points", refused) !== undefined) setPointsValues(hydratePointsValues(division.sport_key, cfg.points));
    const stored = hydrateRuleValues(division.sport_key, division.config);
    const covered = rulesFor(division.sport_key).filter((f) => lockLineFor(f.key, refused, f.edits) !== undefined);
    setRuleValues((prev) => {
      const next = { ...prev };
      for (const f of covered) {
        if (Object.hasOwn(stored, f.key)) next[f.key] = stored[f.key]!;
        else delete next[f.key];
      }
      return next;
    });
  };

  async function run(fn: () => Promise<void | RefusedField[]>, done: string, rules = false) {
    setBusy(true);
    setError(null);
    setPaywallFeature(null);
    setNotice(null);
    setRefusedList([]);
    setPartialSave(false);
    setKeptPinned([]);
    setRulesSave(rules);
    try {
      const refused = await fn();
      if (refused !== undefined && refused.length > 0) {
        // A mixed save: the rest landed, these were kept. "Rules saved" over a value that snapped back is the defect.
        setPartialSave(true);
        setRefusedList(refused);
        setLearnedLocks((prev) => mergeLocks(prev, refused));
        restoreRefused(refused);
      } else {
        setNotice(done);
      }
      router.refresh();
    } catch (err) {
      if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") {
        setPaywallFeature(String(err.extra.feature_key ?? ""));
      } else if (err instanceof ApiV1Error && err.code === SWISS_ROUNDS_REQUIRED_CODE) {
        // Reachable from the Rounds box right on this screen: it is a
        // `type="number"` bound through `Number(e.target.value)`, and an
        // emptied box is `Number("") === 0` — below the server's floor of 1.
        // The server's message is English-only (no server-side i18n in this
        // repo), so the CODE is what gets localised here rather than shown raw.
        setError(msg("stage.err.swissRoundsRequired"));
      } else if (err instanceof ApiV1Error && err.code === "POLICY_LOCKED") {
        // Server English otherwise (no server-side i18n): localise the code.
        setError(msg("divset.err.cameraPolicyLocked"));
      } else if (err instanceof ApiV1Error && err.code === "INVALID_TIME_CONTROL") {
        // The refusal carries the catalogue keys ("3+0", "10+5"…), which read
        // the same in every locale; only the sentence around them is ours.
        const controls = Array.isArray(err.extra.controls) ? err.extra.controls.map(String).join(", ") : "";
        setError(msg("divset.err.timeControlUnsupported", { controls }));
      } else if (err instanceof ApiV1Error && err.code === CHESS_INDIVIDUAL_ONLY) {
        // Server English otherwise (no server-side i18n): localise the code. Reached by an entrants save that names a
        // non-individual kind (a stale page, or a legacy override re-sent beside a different one), and by the format
        // Apply on a chess division stored with americano/mexicano before the ruling: that structure stays listed and
        // selected (templatesForSport `current`), so re-applying it - even to change only rounds or courts - is
        // refused by the stage writers (follow-up to #1027).
        setError(msg("divset.err.chessIndividualOnly"));
      } else if (err instanceof ApiV1Error && err.code === ONLINE_CHESS_DISABLED_CODE) {
        // T20 (fix round 1, m6): turning online play on while the club is not offered online chess — a save racing a
        // flag change, a kept answer gone stale, PostHog down. Server English otherwise: localise the code.
        setError(msg("divset.err.onlineChessDisabled"));
      } else {
        // W2c P-5: a refused match-rules save names its problem (CONFIG_INVALID `issues`) - the rule's own sentence,
        // localized where this app owns it - instead of the generic "invalid <sport> config".
        setError(settingsSaveErrorText(err, msg, msg("divset.failed")));
        // A refusal names EVERY field it kept (409 `extra.refused`): list them, and lock them from now on.
        const refused = err instanceof ApiV1Error ? refusedFieldsOf(err.extra) : null;
        if (refused !== null) {
          setRefusedList(refused);
          setLearnedLocks((prev) => mergeLocks(prev, refused));
          restoreRefused(refused);
        }
      }
    } finally {
      setBusy(false);
    }
  }

  // A lock line (W2c Task 20): the sentence for the stage that has started, under the control it locks. A plain function,
  // not a component, so a test of this island's own markup reads it without rendering a child.
  const lockLine = (lock: RefusedField, testId: string) => (
    <p className="mt-1 text-[11px] leading-snug text-slate-700" data-testid={testId}>
      <span aria-hidden="true">🔒 </span>
      {lockSentence(lock, msg)}
    </p>
  );

  // What a save kept, one line per CONTROL the organiser can see (never a raw config key): the control's own label and the
  // stage that holds it. Used by the partial-save notice (a 200) and under the refusal (a 409), so the two say it the same way.
  const keptLines = refusedLines(visibleRuleFields(division.sport_key, ruleValues, inheritedCfg), refusedList, msg, pointsFieldKeys.length > 0);
  const refusedItems = (lines: readonly RefusedLine[]) => (
    <ul className="mt-1 space-y-0.5">
      {lines.map((l) => (
        <li key={l.id} data-testid={`division-refused-${l.id}`}>
          <span className="font-medium">{l.label}</span>
          {": "}
          {lockSentence(l.lock, msg)}
        </li>
      ))}
    </ul>
  );

  // What the last save says. It renders in ONE place: inside the Format group directly under "Save match rules" when the rules
  // save made it (the organiser's eyes are on that button), at the foot of the page for every other save.
  const saveFeedback = (
    <>
      {notice && (
        <p role="status" className="rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
          {notice}
        </p>
      )}
      {keptPinned.length > 0 && (
        <ul role="status" className="space-y-0.5 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-700" data-testid="division-kept-pinned">
          {keptPinned.map((k) => (
            <li key={k.stageId} data-testid={`division-kept-pinned-${k.stageId}`}>
              {msg("divset.keptPinned", { stage: k.name })}
            </li>
          ))}
        </ul>
      )}
      {partialSave && refusedList.length > 0 && (
        <div role="status" className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800" data-testid="division-partial-save">
          <p className="font-medium">{msg(RULE_LOCK_PARTIAL_KEY, { n: keptLines.length })}</p>
          {refusedItems(keptLines)}
        </div>
      )}
      {error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">
          {error}
        </p>
      )}
      {error && refusedList.length > 0 && (
        <div role="status" className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-600" data-testid="division-refused-list">
          {refusedItems(keptLines)}
        </div>
      )}
    </>
  );

  const saveName = () =>
    run(async () => {
      const row = await apiV1<{ slug: string }>(`/api/v1/divisions/${division.id}`, {
        method: "PATCH",
        json: { name: name.trim() },
      });
      // Renames regenerate the slug — follow it and stay on this tab.
      router.replace(`${divisionPathPrefix}${row.slug}?tab=settings`);
    }, msg("divset.notice.nameSaved"));

  const uploadLogo = (file: File | undefined) => {
    if (!file) return;
    void run(async () => {
      const webp = await fileToWebp(file, 512);
      const { upload_url, storage_path } = await apiV1<{
        upload_url: string;
        storage_path: string;
      }>(`/api/v1/divisions/${division.id}/logo-upload-url`, { method: "POST", json: {} });
      const put = await fetch(upload_url, {
        method: "PUT",
        headers: { "Content-Type": "image/webp" },
        body: webp,
      });
      if (!put.ok) throw new Error(`upload failed (${put.status})`);
      await apiV1(`/api/v1/divisions/${division.id}`, {
        method: "PATCH",
        json: { logo_storage_path: storage_path },
      });
      const base = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
      setLogoUrl(base ? `${base}/storage/v1/object/public/assets/${storage_path}` : null);
    }, msg("divset.notice.logoUploaded"));
  };

  const removeLogo = () =>
    run(async () => {
      await apiV1(`/api/v1/divisions/${division.id}`, {
        method: "PATCH",
        json: { logo_storage_path: null },
      });
      setLogoUrl(null);
    }, msg("divset.notice.logoRemoved"));

  const applyStructure = () =>
    run(async () => {
      const drafts = structureDraftsForApply(
        template,
        { qualified, swissRounds, poolCount, legs },
        standingsCarry,
      );
      await apiV1(`/api/v1/divisions/${division.id}/stages`, {
        method: "PUT",
        json: drafts.map((d, i) => ({ ...d, seq: i + 1 })),
      });
    }, msg("divset.notice.formatChanged"));

  const applyFormat = () =>
    run(async () => {
      let advanced: Record<string, unknown> | null = null;
      if (advancedText.trim() !== "") {
        try {
          advanced = JSON.parse(advancedText) as Record<string, unknown>;
        } catch {
          throw new Error(msg("divset.invalidJson"));
        }
      }
      const override = divisionFormatPatch({
        sportKey: division.sport_key,
        divisionConfig: (division.config as Record<string, unknown>) ?? {},
        savedVariantKey: division.variant_key,
        variantKey,
        savedVariantPreset: presetOf(division.variant_key),
        variantPreset: presetOf(variantKey),
        ruleValues,
        pointsFieldKeys,
        pointsValues,
        savedPoints: cfg.points,
        advanced,
      });
      if (division.sport_key === "boardgame") {
        if (onlinePlay === "lichess") override.onlinePlay = "lichess";
        else delete override.onlinePlay;
      }
      const saved = await apiV1<unknown>(`/api/v1/divisions/${division.id}`, {
        method: "PATCH",
        json: { variant_key: variantKey, config: override },
      });
      setKeptPinned(keptPinnedOf(saved));
      return refusedFieldsOf(saved) ?? [];
    }, msg("divset.notice.rulesSaved"), true);

  // Sends ONLY camera_policy, so it works on a format-locked division (any
  // variant_key in the patch is 409 FORMAT_LOCKED once fixtures exist). On a
  // refusal the control snaps back to the stored value, so it never shows a
  // requirement the server did not keep.
  const saveCameraPolicy = () =>
    run(async () => {
      try {
        await apiV1(`/api/v1/divisions/${division.id}`, {
          method: "PATCH",
          json: { camera_policy: cameraPatchValue(cameraChoice) },
        });
      } catch (err) {
        setCameraChoice(storedCameraChoice);
        throw err;
      }
    }, msg("divset.camera.saved"));

  // Tick/untick a kind, keeping canonical order and never emptying the list;
  // if the current default falls out, re-point it at the first remaining kind.
  const toggleKind = (kind: string) => {
    const next: string[] = ENTRANT_KINDS.filter((k) =>
      k === kind ? !entrantKinds.includes(k) : entrantKinds.includes(k),
    );
    if (next.length === 0) return;
    setEntrantKinds(next);
    if (!next.includes(entrantDefault)) setEntrantDefault(next[0]!);
  };

  const saveEntrants = () =>
    run(async () => {
      // Same wholesale-config contract as applyFormat: the server merges the
      // variant preset with the sent config and re-validates, so base the
      // override on the current snapshot and set `entrants` on it.
      const entrants: Record<string, unknown> = { kinds: entrantKinds, defaultKind: entrantDefault };
      if (entrantKinds.includes("team")) {
        entrants.squadNumbers = squadNumbers;
        entrants.captain = captain;
      }
      const override = { ...((division.config as Record<string, unknown>) ?? {}), entrants };
      await apiV1(`/api/v1/divisions/${division.id}`, {
        method: "PATCH",
        json: { config: override },
      });
    }, msg("divset.entrants.saved"));

  const resetEntrants = () =>
    run(async () => {
      // Drop the override key → the server re-derives from the module default.
      const override = { ...((division.config as Record<string, unknown>) ?? {}) };
      delete override.entrants;
      await apiV1(`/api/v1/divisions/${division.id}`, {
        method: "PATCH",
        json: { config: override },
      });
    }, msg("divset.entrants.resetDone"));

  // SPEC-2: toggle divisions.auto_posts (Pro news.auto). Turning it ON while
  // unentitled returns 402 server-side; the UI gates on canAutoPost so the
  // control only enables when entitled (turning it off is always allowed).
  const toggleAutoPosts = (next: boolean) => {
    setAutoPostsOn(next); // optimistic
    void run(async () => {
      try {
        await apiV1(`/api/v1/divisions/${division.id}`, {
          method: "PATCH",
          json: { auto_posts: next },
        });
      } catch (err) {
        setAutoPostsOn(!next); // revert on failure
        throw err;
      }
    }, msg("divset.news.saved"));
  };

  // V416: toggle divisions.show_seeds. Same optimistic-then-revert shape as
  // auto_posts above; no entitlement gate. The server expires the division's
  // public pages on a flip (patchDivision), so spectators see the change on
  // their next load, not after a cache TTL.
  const toggleShowSeeds = (next: boolean) => {
    setShowSeedsOn(next); // optimistic
    void run(async () => {
      try {
        await apiV1(`/api/v1/divisions/${division.id}`, {
          method: "PATCH",
          json: { show_seeds: next },
        });
      } catch (err) {
        setShowSeedsOn(!next); // revert on failure
        throw err;
      }
    }, msg("divset.publicPage.saved"));
  };

  // D5/P8 gap closed: PatchDivision (server/api-v1/schemas.ts) and COLS
  // (usecases/divisions.ts) now carry `required_court_tags`, normalised on
  // write with the same normalizeTags() the courts path uses. Not read by
  // scheduling/candidate-court filtering — that stays P9's.
  const saveRequiredCourtTags = () =>
    run(async () => {
      await apiV1(`/api/v1/divisions/${division.id}`, {
        method: "PATCH",
        json: { required_court_tags: requiredCourtTags },
      });
    }, msg("divset.requiredTags.saved"));

  return (
    <div className="max-w-2xl space-y-3" data-testid="division-settings">
      <Group title={msg("divset.general")} defaultOpen summary={division.name}>
        <label className="block text-xs text-slate-500">
          {msg("divset.name")}
          <input
            disabled={!canEdit}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="input mt-1 w-full"
          />
        </label>
        {canEdit && (
          <button
            type="button"
            disabled={busy || name.trim() === "" || name.trim() === division.name}
            onClick={saveName}
            className="btn btn-primary text-xs"
          >
            {msg("divset.saveName")}
          </button>
        )}

        <div className="flex items-center gap-4 border-t border-slate-100 pt-3">
          {/* Live card-tile preview: logo, else monogram in the accent hue. */}
          <label
            htmlFor={canEdit ? fileInputId : undefined}
            aria-hidden
            data-testid="settings-tile-preview"
            className={`flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg ${canEdit ? "cursor-pointer" : ""}`}
            style={
              logoUrl
                ? undefined
                : { backgroundColor: `color-mix(in srgb, ${hue} 15%, white)`, color: hue }
            }
          >
            {logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- tenant upload
              <img src={logoUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <span className="text-xl font-bold">{monogram(name || division.name)}</span>
            )}
          </label>
          <div className="min-w-0 flex-1 text-xs text-slate-500">
            <p className="font-medium text-slate-700">{msg("divset.cardLogo")}</p>
            <p className="mt-0.5">{msg("divset.cardLogoDesc")}</p>
            {canEdit && (
              <span className="mt-1 flex gap-3">
                <label htmlFor={fileInputId} className="cursor-pointer text-purple-700 underline">
                  {msg("divset.uploadImage")}
                </label>
                {logoUrl && (
                  <button type="button" disabled={busy} onClick={removeLogo} className="text-red-500 underline">
                    {msg("divset.remove")}
                  </button>
                )}
              </span>
            )}
          </div>
          <input
            id={fileInputId}
            type="file"
            accept="image/*"
            disabled={!canEdit || busy}
            className="sr-only"
            onChange={(e) => uploadLogo(e.target.files?.[0])}
          />
        </div>
      </Group>

      <Group
        title={msg("divset.format")}
        // T16 (canvas SettingsPhone): the summary states that the division plays online — a fact, shown whatever the
        // flag and even when the format is locked (the select itself is hidden then).
        summary={`${sportName} · ${variantLock ? msg("divset.variantLocked", { variant: variantName }) : variantName}${
          division.sport_key === "boardgame" && onlinePlaySaved ? ` · ${msg("divset.onlinePlay.summaryOn")}` : ""
        }`}
      >
        {structureLocked ? (
          <div data-testid="format-locked" className="rounded-md bg-slate-50 p-3 text-xs text-slate-600">
            <p className="font-medium text-slate-700">
              {sportName} · {variantName}
            </p>
            <p className="mt-1">
              {msg("divset.lockedNotePre")}
              <Link href={fixturesHref} className="text-purple-700 underline">{msg("divset.fixtures")}</Link>
              {msg("divset.lockedNotePost")}
            </p>
          </div>
        ) : (
            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                {msg("divset.competitionFormat")}
              </p>
              <label className="block text-xs text-slate-500">
                {msg("divset.structure")}
                <select
                  disabled={!canEdit}
                  value={template}
                  onChange={(e) => setTemplate(e.target.value)}
                  className="input mt-1 w-full"
                  data-testid="format-template"
                >
                  {/* F3 Task 6: t.key is a plain `string` (STAGE_TEMPLATES
                      isn't narrowed to a literal-key union — see
                      format-templates.ts), so this template-literal lookup
                      can't be checked against MessageKey's literal union
                      without a cast. Narrow, not `as any`: a typo in the
                      "format.template."/".label" literals themselves would
                      still fail to compile. format-templates.test.ts's
                      dictionary-coverage test backstops every t.key actually
                      resolving. */}
                  {/* The sport's offer (templatesForSport): chess lists no americano/mexicano, except the structure a
                      division stored before the ruling already plays, so it still shows what it is. */}
                  {templatesForSport(division.sport_key, detected).map((t) => (
                    <option key={t.key} value={t.key}>
                      {msg(`format.template.${t.key}.label` as MessageKey)}
                    </option>
                  ))}
                </select>
                <span className="mt-0.5 block text-[11px] text-slate-500">
                  {selectedTemplate && msg(`format.template.${selectedTemplate.key}.help` as MessageKey)}
                </span>
              </label>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {["league_ko", "groups_ko", "group_stepladder", "swiss_knockout"].includes(
                  template,
                ) && (
                  <label className="block text-xs text-slate-500">
                    {msg("divset.topN")}
                    <input type="number" min={2} max={32} disabled={!canEdit} value={qualified}
                      onChange={(e) => setQualified(Number(e.target.value))} className="input mt-1 w-full" />
                  </label>
                )}
                {template === "groups_ko" && (
                  <label className="block text-xs text-slate-500">
                    {msg("divset.groups")}
                    <input type="number" min={2} max={8} disabled={!canEdit} value={poolCount}
                      onChange={(e) => setPoolCount(Number(e.target.value))} className="input mt-1 w-full" />
                  </label>
                )}
                {templateHasSwissRounds && (
                  <label className="block text-xs text-slate-500">
                    {msg("divset.rounds")}
                    <input
                      type="number"
                      min={3}
                      max={15}
                      disabled={!canEdit}
                      value={swissRounds}
                      data-testid="division-settings-swiss-rounds"
                      onChange={(e) => setSwissRounds(Number(e.target.value))}
                      className="input mt-1 w-full"
                    />
                  </label>
                )}
                {["league", "league_ko", "groups_ko"].includes(template) && (
                  <label className="block text-xs text-slate-500">
                    {msg("divset.legs")}
                    <input type="number" min={1} max={4} disabled={!canEdit} value={legs}
                      onChange={(e) => setLegs(Number(e.target.value))} className="input mt-1 w-full" />
                  </label>
                )}
                {templateHasProgression(template) && (
                  <label className="block text-xs text-slate-500">
                    {msg("format.carry.label")}
                    <select
                      data-testid="division-settings-carry"
                      disabled={!canEdit}
                      value={standingsCarry}
                      onChange={(e) => setStandingsCarry(e.target.value as StandingsCarry)}
                      className="input mt-1 w-full"
                    >
                      <option value="none">{msg("format.carry.none")}</option>
                      <option value="points">{msg("format.carry.points")}</option>
                      <option value="full">{msg("format.carry.full")}</option>
                    </select>
                    <span className="mt-0.5 block text-[11px] text-slate-500">{msg("format.carry.help")}</span>
                  </label>
                )}
              </div>
              {canEdit && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={applyStructure}
                  className="btn btn-primary text-xs"
                  data-testid="apply-structure"
                >
                  {stages.length > 0 ? msg("divset.changeFormat") : msg("divset.setFormat")}
                </button>
              )}
              {detected === null && stages.length > 0 && (
                <p className="text-[11px] text-amber-600">{msg("divset.customStructure")}</p>
              )}
            </div>
        )}

        <p className="border-t border-slate-100 pt-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
          {msg("divset.matchRules")}
        </p>
        <label className="block text-xs text-slate-500">
          {msg("divset.variant")}
          <select
            disabled={!canEdit || variantLock !== undefined}
            value={variantKey}
            onChange={(e) => pickVariantKey(e.target.value)}
            aria-describedby={variantHint === undefined ? undefined : "division-variant-hint"}
            data-testid="division-settings-variant"
            className="input mt-1 w-full"
          >
            {variants.map((v) => (
              <option key={v.key} value={v.key}>
                {variantOptionLabel(division.sport_key, v, msg)}
              </option>
            ))}
          </select>
        </label>
        {variantHint !== undefined && (
          <p id="division-variant-hint" role="note" data-testid="division-variant-hint" className="min-w-0 rounded-md bg-slate-50 px-3 py-2 text-xs leading-snug text-slate-700">
            {msg(variantHint)}
          </p>
        )}
        {variantLock !== undefined && lockLine(variantLock, "division-locked-variant_key")}

        {division.sport_key === "boardgame" && onlineChessOffered && (
          <div>
            <label className="block text-xs text-slate-500">
              {msg("divset.onlinePlay.label")}
              <select
                disabled={!canEdit}
                value={onlinePlay}
                onChange={(e) => setOnlinePlay(e.target.value as "off" | "lichess")}
                className="input mt-1 w-full"
                data-testid="division-online-play"
              >
                <option value="off">{msg("divset.onlinePlay.off")}</option>
                <option value="lichess">{msg("divset.onlinePlay.lichess")}</option>
              </select>
            </label>
            <p className="mt-1 text-[11px] text-slate-500">{msg("divset.onlinePlay.help")}</p>
            {/* WARN, never block: the select above and Save below stay live. The same sentence before and after the
                save, because it follows the form's choice, which a save leaves where it was. */}
            {onlinePlay === "lichess" && lichessGaps !== undefined && hasLinkGaps(lichessGaps) && (
              <div
                role="status"
                data-testid="division-online-link-gaps"
                className="mt-2 grid min-w-0 gap-2 break-words rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
              >
                {/* An unbroken name (a 70-character token) must wrap INSIDE the box: `break-words` alone does not shrink a
                    grid item below its min-content width, so each sentence also takes `min-w-0` and `anywhere`, which
                    counts the break opportunities in the min-content width too. */}
                {lichessGaps.unlinked.count > 0 && (
                  <p data-testid="division-online-unlinked" className="min-w-0 [overflow-wrap:anywhere]">
                    {linkGapSentence("unlinked", lichessGaps.unlinked, locale, plural)}
                  </p>
                )}
                {lichessGaps.reconnect.count > 0 && (
                  <p data-testid="division-online-reconnect" className="min-w-0 [overflow-wrap:anywhere]">
                    {linkGapSentence("reconnect", lichessGaps.reconnect, locale, plural)}
                  </p>
                )}
                {lichessGaps.empty.count > 0 && (
                  <p data-testid="division-online-empty" className="min-w-0 [overflow-wrap:anywhere]">
                    {linkGapSentence("empty", lichessGaps.empty, locale, plural)}
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {lichessClock && (
          <div>
            <label className="block text-xs text-slate-500">
              {msg("divset.timeControl.label")}
              <select
                disabled={!canEdit || clockLock !== undefined}
                value={timeControl}
                onChange={(e) => {
                  const picked = timeControlRuleValues(e.target.value);
                  if (picked) setRuleValues({ ...ruleValues, ...picked });
                }}
                className="input mt-1 w-full"
                data-testid="division-time-control"
              >
                {timeControl === "" && <option value="">{msg("divset.timeControl.choose")}</option>}
                {timeControlOptions(msg).map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="mt-1 text-[11px] text-slate-500">{msg("divset.timeControl.help")}</p>
            {timeControl === "" && (
              <p className="mt-1 text-[11px] text-amber-700">{msg("divset.timeControl.unsupported")}</p>
            )}
            {clockLock !== undefined && lockLine(clockLock, "division-locked-clock")}
          </div>
        )}

        {pointsFieldKeys.length > 0 && (
          <div>
            <p className="text-xs text-slate-500">{msg("divset.standingsPoints")}</p>
            <div className="mt-1 grid grid-cols-3 gap-2">
              {pointsFieldKeys.map((key) => (
                <label key={key} className="block text-xs text-slate-500">
                  {msg(POINTS_KEY_CONCEPT[key]!.labelKey)}
                  <input
                    type="number"
                    min={0}
                    max={99}
                    disabled={!canEdit || pointsLock !== undefined}
                    value={pointsValues[key] ?? ""}
                    onChange={(e) => setPointsValues({ ...pointsValues, [key]: e.target.value })}
                    className="input mt-1 w-full"
                  />
                </label>
              ))}
            </div>
            {pointsLock !== undefined && lockLine(pointsLock, "division-locked-points")}
          </div>
        )}

        <MatchRuleFields
          sportKey={division.sport_key}
          values={ruleValues}
          onChange={setRuleValues}
          disabled={!canEdit}
          inherited={inheritedCfg}
          lockedFields={locks}
          omit={lichessClock ? LICHESS_CLOCK_FIELD_KEYS : undefined}
        />

        {stages.length > 0 && (
          <p className="rounded-md bg-slate-50 p-3 text-xs text-slate-500" data-testid="stage-structure">
            {msg("divset.structureLabel")}{" "}
            {stages.map((st, i) => (
              <span key={i}>
                {i > 0 && " → "}
                <span className="font-medium text-slate-700">{st.name}</span> ({st.kind})
              </span>
            ))}
            {" · "}
            <Link href={fixturesHref} className="text-purple-700 underline">
              {msg("divset.editStages")}
            </Link>
          </p>
        )}

        <details>
          <summary className="cursor-pointer text-[11px] text-slate-500">
            {msg("divset.advanced")}
          </summary>
          <textarea
            disabled={!canEdit}
            value={advancedText}
            onChange={(e) => setAdvancedText(e.target.value)}
            rows={4}
            spellCheck={false}
            placeholder='e.g. { "progressScore": true }'
            className="input mt-1 w-full font-mono text-xs"
          />
        </details>

        {canEdit && (
          <button type="button" disabled={busy} onClick={applyFormat} className="btn btn-primary text-xs">
            {msg("divset.saveRules")}
          </button>
        )}
        {rulesSave && saveFeedback}
        <p className="text-[11px] text-slate-500">{msg("divset.rulesNote")}</p>
      </Group>

      {/* T6 — its own group, OUTSIDE the format lock: the camera requirement
          is edited mostly on divisions that already have fixtures, where the
          Format group above is read-only. T20: only while the club is offered online chess. */}
      {division.sport_key === "boardgame" && onlineChessOffered && (
        <Group
          title={msg("divset.camera.label")}
          summary={cameraSummary(storedCameraChoice, inheritedCamera, msg)}
        >
          <select
            aria-label={msg("divset.camera.label")}
            disabled={!canEdit || !onlinePlaySaved}
            value={cameraChoice}
            onChange={(e) => setCameraChoice(e.target.value as CameraChoice)}
            className="input w-full"
            data-testid="division-camera-policy"
          >
            {cameraOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {!onlinePlaySaved && (
            <p data-testid="division-camera-needs-online" className="text-[11px] text-slate-500">
              {msg("divset.camera.needsOnlinePlay")}
            </p>
          )}
          {cameraHint && (
            <p data-testid="division-camera-inherited" className="text-[11px] text-slate-500">
              {cameraHint}
            </p>
          )}
          <p className="text-[11px] text-slate-500">{msg("divset.camera.help")}</p>
          {effectiveCameraChoice(cameraChoice, inheritedCamera) === "required" && (
            <div data-testid="division-camera-player-notice" className="rounded-md bg-slate-50 p-3 text-xs text-slate-600">
              <p className="font-medium text-slate-700">{msg("divset.camera.playerNoticeLabel")}</p>
              <p className="mt-1">{msg("onlineChess.camera.playerNotice")}</p>
            </div>
          )}
          {canEdit && (
            <button
              type="button"
              disabled={busy || !onlinePlaySaved || cameraChoice === storedCameraChoice}
              onClick={saveCameraPolicy}
              className="btn btn-primary text-xs"
              data-testid="division-camera-save"
            >
              {msg("divset.camera.save")}
            </button>
          )}
        </Group>
      )}

      <Group
        title={msg("divset.entrants.title")}
        summary={
          chessOnly
            ? msg(KIND_LABEL_KEY.individual)
            : entrantKinds.map((k) => msg(KIND_LABEL_KEY[k as (typeof ENTRANT_KINDS)[number]])).join(", ")
        }
        defaultOpen
      >
        {chessOnly ? (
          <div className="space-y-2" data-testid="entrants-chess-only">
            <p className="text-xs text-slate-600">{msg("divset.entrants.chessOnly")}</p>
            {chessLegacyEntrants && (
              <div
                role="status"
                className="grid min-w-0 gap-2 break-words rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
                data-testid="entrants-chess-legacy"
              >
                <span>{msg("divset.entrants.chessLegacy")}</span>
                {canEdit && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={resetEntrants}
                    className="btn w-full justify-self-start text-xs sm:w-auto"
                  >
                    {msg("divset.entrants.reset")}
                  </button>
                )}
              </div>
            )}
          </div>
        ) : (
          <>
        <p className="text-xs text-slate-500">{msg("divset.entrants.desc")}</p>

        {/* Source line: a muted "Sport default" note, or, once overridden, the
            same note swapped for a quiet Reset affordance beside it. */}
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          {entrantModelSource === "sport" ? (
            <span className="text-slate-500" data-testid="entrants-sport-default">
              {msg("divset.entrants.sportDefault")}
            </span>
          ) : (
            <>
              <span className="text-slate-500">{msg("divset.entrants.overridden")}</span>
              {canEdit && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={resetEntrants}
                  className="rounded text-slate-500 underline transition hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-300"
                >
                  {msg("divset.entrants.reset")}
                </button>
              )}
            </>
          )}
        </div>

        {/* Kinds — multi-select chips, mirroring RoleChipPicker's toggle style.
            min-inline-size:0 keeps the fieldset from bursting narrow cards. */}
        <fieldset className="min-w-0 space-y-1.5 [min-inline-size:0]" disabled={!canEdit}>
          <legend className="label">{msg("divset.entrants.kinds")}</legend>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={msg("divset.entrants.kinds")}>
            {ENTRANT_KINDS.map((kind) => {
              const active = entrantKinds.includes(kind);
              return (
                <button
                  key={kind}
                  type="button"
                  data-kind={kind}
                  aria-pressed={active}
                  onClick={() => toggleKind(kind)}
                  disabled={!canEdit}
                  className={`rounded-full border px-3 py-1 text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-300 disabled:cursor-not-allowed disabled:opacity-60 ${
                    active
                      ? "border-purple-600 bg-purple-600 text-white"
                      : "border-slate-200 bg-white text-slate-600 hover:border-purple-300"
                  }`}
                >
                  {msg(KIND_LABEL_KEY[kind])}
                </button>
              );
            })}
          </div>
        </fieldset>

        <label className="block text-xs text-slate-500">
          {msg("divset.entrants.defaultKind")}
          <select
            disabled={!canEdit}
            value={entrantDefault}
            onChange={(e) => setEntrantDefault(e.target.value)}
            className="input mt-1 block w-full sm:w-auto"
          >
            {entrantKinds.map((kind) => (
              <option key={kind} value={kind}>
                {msg(KIND_LABEL_KEY[kind as (typeof ENTRANT_KINDS)[number]])}
              </option>
            ))}
          </select>
        </label>

        {/* Team affordances — indented + grouped, shown only while a team kind
            is ticked (there is nothing to number or captain otherwise). */}
        {entrantKinds.includes("team") && (
          <div className="space-y-2 rounded-lg bg-slate-50 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              {msg("divset.entrants.teamOptions")}
            </p>
            <label className="flex items-start gap-2 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={squadNumbers}
                onChange={(e) => setSquadNumbers(e.target.checked)}
                disabled={!canEdit}
                className="mt-0.5"
              />
              {msg("divset.entrants.squadNumbers")}
            </label>
            <label className="flex items-start gap-2 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={captain}
                onChange={(e) => setCaptain(e.target.checked)}
                disabled={!canEdit}
                className="mt-0.5"
              />
              {msg("divset.entrants.captain")}
            </label>
          </div>
        )}

        {canEdit && (
          <button
            type="button"
            disabled={busy}
            onClick={saveEntrants}
            className="btn btn-primary w-full text-xs sm:w-auto"
          >
            {msg("divset.entrants.save")}
          </button>
        )}
        <p className="text-[11px] text-slate-500">{msg("divset.entrants.note")}</p>
          </>
        )}
      </Group>

      <Group
        title={msg("divset.requiredTags.title")}
        summary={requiredCourtTags.length > 0 ? requiredCourtTags.join(", ") : msg("divset.requiredTags.any")}
      >
        <p className="text-xs text-slate-500">{msg("divset.requiredTags.desc")}</p>
        <TagChipInput
          value={requiredCourtTags}
          onChange={setRequiredCourtTags}
          suggestions={courtTagSuggestions}
          disabled={!canEdit}
          label={msg("divset.requiredTags.label")}
          placeholder={msg("tags.placeholder")}
          addLabel={msg("tags.add")}
          removeLabelFor={(tag) => msg("tags.remove", { tag })}
          suggestionsLabel={msg("tags.suggestions")}
        />
        {canEdit && (
          <button
            type="button"
            disabled={busy}
            onClick={saveRequiredCourtTags}
            className="btn btn-primary text-xs"
          >
            {msg("divset.requiredTags.save")}
          </button>
        )}
      </Group>

      <Group
        title={msg("divset.news.title")}
        summary={autoPostsOn ? msg("divset.news.on") : msg("divset.news.off")}
      >
        <p className="text-xs text-slate-500">{msg("divset.news.desc")}</p>
        {canAutoPost ? (
          <label className="flex items-start gap-2 text-sm text-slate-600" data-testid="auto-posts-toggle">
            <input
              type="checkbox"
              checked={autoPostsOn}
              disabled={!canEdit || busy}
              onChange={(e) => toggleAutoPosts(e.target.checked)}
              className="mt-0.5"
            />
            {msg("divset.news.toggle")}
          </label>
        ) : (
          <UpgradeGate feature="news.auto" viewerPlan={viewerPlan} />
        )}
        {/* Shown in BOTH branches, deliberately. Drafting is a side effect of
            FOLDING a result (`refreshNews`, usecases/scoring.ts:132), so an org
            that turns this on after play has started gets nothing for what is
            already scored, and re-folding is not something anyone may do to
            recover. The org that most needs the warning is the one still
            looking at the UpgradeGate — it has to know the entitlement matters
            BEFORE scoring, not at the moment it flips the toggle. */}
        <p className="text-[11px] text-amber-700" data-testid="auto-posts-timing">
          {msg("divset.news.timing")}
        </p>
        <p className="text-[11px] text-slate-500">{msg("divset.news.note")}</p>
      </Group>

      <Group
        title={msg("divset.publicPage.title")}
        summary={showSeedsOn ? msg("divset.publicPage.seedsShown") : msg("divset.publicPage.seedsHidden")}
      >
        <label className="flex items-start gap-2 text-sm text-slate-600" data-testid="show-seeds-toggle">
          <input
            type="checkbox"
            checked={showSeedsOn}
            disabled={!canEdit || busy}
            onChange={(e) => toggleShowSeeds(e.target.checked)}
            aria-describedby={`show-seeds-help-${division.id}`}
            className="mt-0.5"
          />
          {msg("divset.publicPage.seedsToggle")}
        </label>
        <p id={`show-seeds-help-${division.id}`} className="text-xs text-slate-500">
          {msg("divset.publicPage.seedsHelp")}
        </p>
      </Group>

      <Group title={msg("divset.sharing")} summary={msg("divset.sharingSummary")}>
        {embed}
      </Group>

      <Group title={msg("divset.danger")} summary={msg("divset.dangerSummary")} danger>
        {danger}
      </Group>

      {paywallFeature && <UpgradeGate feature={paywallFeature} viewerPlan={viewerPlan} />}
      {!rulesSave && saveFeedback}
    </div>
  );
}
