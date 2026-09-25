"use client";

// Division Settings tab (v8 spec §2): General → Format → Sharing & embed →
// Danger zone, tap-per-section. The format section renders read-only once
// fixtures exist; patchDivision enforces the same rule (409 FORMAT_LOCKED),
// so hiding and enforcement can't drift.
import { useEffect, useState, type ReactNode } from "react";
import Link from "@/components/ui/console-link";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { divisionAccent, monogram } from "@/lib/division-hue";
import { SWISS_ROUNDS_REQUIRED_CODE } from "@/lib/swiss-shell";
import { MatchRuleFields, buildRuleOverride, hydrateRuleValues, SPORT_RULES } from "./match-rules";
import {
  STAGE_TEMPLATES,
  applyStandingsCarry,
  buildTemplateStages,
  clampKnob,
  detectTemplate,
  templateHasProgression,
  type StageDraft,
  type StandingsCarry,
  type TemplateKnobs,
} from "./format-templates";
import { UpgradeGate } from "@/components/upgrade-gate";
import { useMsg } from "@/components/i18n/dict-provider";
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
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between gap-2 px-5 py-3 text-left"
      >
        <span className={`text-sm font-semibold ${danger ? "text-red-700" : "text-slate-700"}`}>
          {title}
        </span>
        <span className="flex items-center gap-2">
          {summary && !open && (
            <span className="max-w-48 truncate text-xs text-slate-400">{summary}</span>
          )}
          <span aria-hidden className="text-xs text-slate-400">{open ? "▾" : "▸"}</span>
        </span>
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
 * owns a dedicated, better-explained input for (football's
 * shootoutWin/shootoutLoss — see match-rules.tsx) so the two editors never
 * double up on one key.
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
  const dedicated = new Set((SPORT_RULES[sportKey] ?? []).map((f) => f.key));
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
  locked,
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
}: {
  division: DivisionSettingsInfo;
  /** Org id, for the tag-suggestions fetch only (the division PATCH itself
   *  is not org-scoped in its URL) — see saveRequiredCourtTags below. */
  orgId: string;
  variants: { key: string; name: string }[];
  /** formatLocked() from the page — fixtures exist. */
  locked: boolean;
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
}) {
  const msg = useMsg();
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
  const cfg = (division.config ?? {}) as { points?: Record<string, number>; progressScore?: boolean };
  // R3.5 review F7 — which boxes this editor shows/writes is derived from
  // the saved config's OWN points shape, not the sport key (see
  // editablePointsKeys above).
  const pointsFieldKeys = editablePointsKeys(division.sport_key, cfg.points);
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
  const configSignature = JSON.stringify(division.config);
  const [syncedConfigSignature, setSyncedConfigSignature] = useState(configSignature);
  if (configSignature !== syncedConfigSignature) {
    setSyncedConfigSignature(configSignature);
    setRuleValues(hydrateRuleValues(division.sport_key, division.config));
    setPointsValues(hydratePointsValues(division.sport_key, cfg.points));
  }
  const [advancedText, setAdvancedText] = useState("");
  // Entrants block (spec 2026-07-18): the ticked kinds, the default, and the
  // team extras seed from the resolved effective model.
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

  async function run(fn: () => Promise<void>, done: string) {
    setBusy(true);
    setError(null);
    setPaywallFeature(null);
    setNotice(null);
    try {
      await fn();
      setNotice(done);
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
      } else {
        setError(err instanceof Error ? err.message : msg("divset.failed"));
      }
    } finally {
      setBusy(false);
    }
  }

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
      // The server merges preset + override, but presets only carry the
      // variant-identity keys (resultMode/allowDraws) — schema-required keys
      // like progressScore live in the division's current config. Base the
      // override on that valid snapshot; on a variant change, drop the
      // identity keys so the new preset wins them.
      const override: Record<string, unknown> = {
        ...((division.config as Record<string, unknown>) ?? {}),
      };
      if (variantKey !== division.variant_key) {
        delete override.resultMode;
        delete override.allowDraws;
      }
      // R3.5/Task Q — buildRuleOverride can return a nested `{ points: {...} }`
      // (football's shootoutWin/shootoutLoss). A bare Object.assign of the
      // whole rule override would REPLACE override.points wholesale, dropping
      // whatever of the existing config's points (win/draw/loss, or a
      // shootout half the organiser isn't touching right now) the rule
      // fields didn't themselves resend. Merge points separately; everything
      // else a rule field returns is a fine top-level Object.assign, exactly
      // as before.
      // `division.config` as the inherited config: a blank best-of here keeps
      // the saved one (the `{...config}` base above), so it is also what
      // decides whether the single best-of-1 points field applies.
      const { points: rulePoints, ...ruleOverrideRest } = buildRuleOverride(
        division.sport_key,
        ruleValues,
        (division.config as Record<string, unknown>) ?? {},
      );
      Object.assign(override, ruleOverrideRest);
      if (rulePoints && typeof rulePoints === "object") {
        const mergedPoints: Record<string, unknown> = {
          ...((override.points as Record<string, unknown>) ?? {}),
          ...(rulePoints as Record<string, unknown>),
        };
        // R3.5 review F5 — a rule field's build()/buildOnBlank() (currently
        // only match-rules.tsx's shootoutPointsPatch) can ask to DELETE a key
        // from the nested object by setting it to `undefined` rather than
        // omitting it — omitting it would leave whatever `override.points`
        // already carried forward from the `{...division.config}` base at
        // the top of this function untouched. Resolve those markers into a
        // real deletion here, so the PATCH body (and any `toEqual`/
        // `toHaveProperty` assertion on it) is a clean object rather than
        // one holding `undefined`-valued keys.
        for (const key of Object.keys(mergedPoints)) {
          if (mergedPoints[key] === undefined) delete mergedPoints[key];
        }
        override.points = mergedPoints;
      }
      if (pointsFieldKeys.some((k) => pointsValues[k] !== undefined && pointsValues[k] !== "")) {
        // Spread whatever survived above (shootout points included) rather
        // than replacing override.points outright, and write only the keys
        // THIS sport's schema actually declares — see editablePointsKeys.
        const pointsPatch: Record<string, unknown> = { ...((override.points as Record<string, unknown>) ?? {}) };
        for (const key of pointsFieldKeys) {
          const raw = pointsValues[key];
          pointsPatch[key] = raw === undefined || raw === "" ? (cfg.points?.[key] ?? 0) : Number(raw);
        }
        override.points = pointsPatch;
      }
      if (advancedText.trim() !== "") {
        try {
          Object.assign(override, JSON.parse(advancedText));
        } catch {
          throw new Error(msg("divset.invalidJson"));
        }
      }
      await apiV1(`/api/v1/divisions/${division.id}`, {
        method: "PATCH",
        json: { variant_key: variantKey, config: override },
      });
    }, msg("divset.notice.rulesSaved"));

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
        summary={`${division.sport_key} · ${locked ? msg("divset.variantLocked", { variant: division.variant_key }) : division.variant_key}`}
      >
        {locked ? (
          <div data-testid="format-locked" className="rounded-md bg-slate-50 p-3 text-xs text-slate-600">
            <p className="font-medium text-slate-700">
              {division.sport_key} · {division.variant_key}
            </p>
            <p className="mt-1">
              {msg("divset.lockedNotePre")}
              <Link href={fixturesHref} className="text-purple-700 underline">{msg("divset.fixtures")}</Link>
              {msg("divset.lockedNotePost")}
            </p>
          </div>
        ) : (
          <>
            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
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
                  {STAGE_TEMPLATES.map((t) => (
                    <option key={t.key} value={t.key}>
                      {msg(`format.template.${t.key}.label` as MessageKey)}
                    </option>
                  ))}
                </select>
                <span className="mt-0.5 block text-[11px] text-slate-400">
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
                    <span className="mt-0.5 block text-[11px] text-slate-400">{msg("format.carry.help")}</span>
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

            <p className="border-t border-slate-100 pt-3 text-xs font-semibold uppercase tracking-wide text-slate-400">
              {msg("divset.matchRules")}
            </p>
            <label className="block text-xs text-slate-500">
              {msg("divset.variant")}
              <select
                disabled={!canEdit}
                value={variantKey}
                onChange={(e) => setVariantKey(e.target.value)}
                className="input mt-1 w-full"
              >
                {variants.map((v) => (
                  <option key={v.key} value={v.key}>
                    {v.name}
                  </option>
                ))}
              </select>
            </label>

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
                        disabled={!canEdit}
                        value={pointsValues[key] ?? ""}
                        onChange={(e) => setPointsValues({ ...pointsValues, [key]: e.target.value })}
                        className="input mt-1 w-full"
                      />
                    </label>
                  ))}
                </div>
              </div>
            )}

            <MatchRuleFields
              sportKey={division.sport_key}
              values={ruleValues}
              onChange={setRuleValues}
              disabled={!canEdit}
              inherited={(division.config as Record<string, unknown>) ?? {}}
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
              <summary className="cursor-pointer text-[11px] text-slate-400">
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
            <p className="text-[11px] text-slate-400">{msg("divset.rulesNote")}</p>
          </>
        )}
      </Group>

      <Group
        title={msg("divset.entrants.title")}
        summary={entrantKinds.map((k) => msg(KIND_LABEL_KEY[k as (typeof ENTRANT_KINDS)[number]])).join(", ")}
        defaultOpen
      >
        <p className="text-xs text-slate-500">{msg("divset.entrants.desc")}</p>

        {/* Source line: a muted "Sport default" note, or, once overridden, the
            same note swapped for a quiet Reset affordance beside it. */}
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          {entrantModelSource === "sport" ? (
            <span className="text-slate-400" data-testid="entrants-sport-default">
              {msg("divset.entrants.sportDefault")}
            </span>
          ) : (
            <>
              <span className="text-slate-400">{msg("divset.entrants.overridden")}</span>
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
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
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
        <p className="text-[11px] text-slate-400">{msg("divset.entrants.note")}</p>
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
        <p className="text-[11px] text-slate-400">{msg("divset.news.note")}</p>
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
      {notice && <p className="rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-700">{notice}</p>}
      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>}
    </div>
  );
}
