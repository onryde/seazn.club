"use client";

// Division Settings tab (v8 spec §2): General → Format → Sharing & embed →
// Danger zone, tap-per-section. The stage STRUCTURE (template, knobs) hides behind a note once fixtures exist -
// `replaceStages` refuses on any fixture row, so `structureLocked` is "fixtures exist" (formatAlreadyLocked).
// Match Day C2 (owner, 2026-10-31): the match RULES - variant, online play and its clock, points, every rule field, the
// tie-break order - left this tab for the Division rules strip on the Fixtures tab (`components/v2/rules/`); the Format
// group keeps the structure and points the organiser there. `lockedFields` is still read for the group's summary (a variant
// a started stage plays reads "(locked)").
// Match Day C4 (owner, 2026-10-31): the entrant kinds moved to the top of the Entrants tab (`entrant-kinds-settings.tsx`) and the
// Advanced overrides JSON is gone for good; "Format" - the structure above - stays here with its rebuild.
import { useEffect, useState, type ReactNode } from "react";
import { SettingsGroup } from "@/components/v2/settings-group";
import Link from "@/components/ui/console-link";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { settingsSaveErrorText } from "@/lib/config-issue-copy";
import { divisionAccent, monogram } from "@/lib/division-hue";
import { SWISS_ROUNDS_REQUIRED_CODE } from "@/lib/swiss-shell";
import { ONLINE_CHESS_DISABLED_CODE, onlinePlayShown } from "@/lib/online-chess";
import { CHESS_INDIVIDUAL_ONLY } from "@/lib/chess-individual-only";
import { CAMERA_POLICIES, type CameraPolicy } from "@/lib/camera-policy";
import { lockLineFor } from "./division-settings-locks";
import type { RefusedField } from "@/lib/rule-errors";
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
import { useMsg } from "@/components/i18n/dict-provider";
import { sportLabel } from "@/lib/scoring-vocab";
import { variantWord } from "@/lib/variant-label-keys";
import { TagChipInput } from "@/components/ui/tag-chip-input";
import type { MessageKey } from "@/lib/messages";
import type { ViewerPlan } from "@/lib/viewer-plan";

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
   *  passes it, but a hand-built
   *  DivisionSettingsInfo test fixture may not — keep compiling and rendering; the
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

export function DivisionSettings({
  division,
  orgId,
  structureLocked,
  lockedFields,
  stages,
  canEdit,
  divisionPathPrefix,
  fixturesHref,
  embed,
  danger,
  autoPosts,
  canAutoPost,
  showSeeds,
  viewerPlan,
  onlineChessOffered,
}: {
  division: DivisionSettingsInfo;
  /** Org id, for the tag-suggestions fetch only (the division PATCH itself
   *  is not org-scoped in its URL) — see saveRequiredCourtTags below. */
  orgId: string;
  /** Fixtures exist - the stage structure cannot be replaced (`formatAlreadyLocked`, the page). NOT the rules: those lock
   *  per started stage (`lockedFields`), so a division with fixtures and no started stage keeps its rules editable. */
  structureLocked: boolean;
  /** Every field a started stage locks (`divisionLockedFields`): the Format group's summary says a locked variant. */
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
  /** SPEC-2 auto-draft opt-in (divisions.auto_posts). */
  autoPosts: boolean;
  /** news.auto entitlement (Pro) — off → the toggle shows the PlusReveal. */
  canAutoPost: boolean;
  /** V416: seeds on the public site (divisions.show_seeds). Not a paid
   *  layer — every organiser can hide their seeds. */
  showSeeds: boolean;
  viewerPlan: ViewerPlan;
  /** T20: the club is offered online chess (the PostHog flag `online-chess`, asked by the page). Off ⇒ the camera control
   *  is not rendered at all (the Online play select itself is in the Division rules strip, Match Day C2). */
  onlineChessOffered: boolean;
}) {
  const msg = useMsg();
  // The Format section names the division's sport and variant as WORDS (`sport.<key>`, `variant.<sport>.<variant>`),
  // never the stored keys: the key is the identity (`boardgame`), the word is what the organiser reads ("Chess").
  const sportName = sportLabel(division.sport_key, msg);
  const variantName = variantWord(division.sport_key, division.variant_key, msg);
  const router = useRouter();
  const [name, setName] = useState(division.name);
  const [logoUrl, setLogoUrl] = useState(division.logo_url);
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
  const cfg = (division.config ?? {}) as { onlinePlay?: string };
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
  const [autoPostsOn, setAutoPostsOn] = useState<boolean>(autoPosts);
  const [showSeedsOn, setShowSeedsOn] = useState<boolean>(showSeeds);
  // D5/P8 required-court-tags picker (design doc §"Division settings:
  // required-tags picker"). Staged locally, explicit Save — same shape as
  // the camera and news blocks, not autosave-per-chip like venues-panel's
  // court tags, because this file's OWN convention (every other multi-field
  // section here) is stage-then-Save.
  const [requiredCourtTags, setRequiredCourtTags] = useState<string[]>(division.required_court_tags ?? []);
  const [courtTagSuggestions, setCourtTagSuggestions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The Format group's summary says the variant is locked while a started stage plays it (W2c Task 20, S4); the variant
  // itself is chosen in the Division rules strip (Match Day C2).
  const variantLock = lockLineFor("variant_key", lockedFields);
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
      } else if (err instanceof ApiV1Error && err.code === "POLICY_LOCKED") {
        // Server English otherwise (no server-side i18n): localise the code.
        setError(msg("divset.err.cameraPolicyLocked"));
      } else if (err instanceof ApiV1Error && err.code === "INVALID_TIME_CONTROL") {
        // The refusal carries the catalogue keys ("3+0", "10+5"…), which read
        // the same in every locale; only the sentence around them is ours.
        const controls = Array.isArray(err.extra.controls) ? err.extra.controls.map(String).join(", ") : "";
        setError(msg("divset.err.timeControlUnsupported", { controls }));
      } else if (err instanceof ApiV1Error && err.code === CHESS_INDIVIDUAL_ONLY) {
        // Server English otherwise (no server-side i18n): localise the code. Reached by the format Apply on a chess
        // division stored with americano/mexicano before the ruling: that structure stays listed and selected
        // (templatesForSport `current`), so re-applying it - even to change only rounds or courts - is refused by the
        // stage writers (follow-up to #1027). The entrant-kinds save, which met it here too, moved to the Entrants tab.
        setError(msg("divset.err.chessIndividualOnly"));
      } else if (err instanceof ApiV1Error && err.code === ONLINE_CHESS_DISABLED_CODE) {
        // T20 (fix round 1, m6): turning online play on while the club is not offered online chess — a save racing a
        // flag change, a kept answer gone stale, PostHog down. Server English otherwise: localise the code.
        setError(msg("divset.err.onlineChessDisabled"));
      } else {
        // A refused save names its problem (CONFIG_INVALID `issues`) in the reader's language where this app owns it.
        setError(settingsSaveErrorText(err, msg, msg("divset.failed")));
      }
    } finally {
      setBusy(false);
    }
  }

  // What the last save says, at the foot of the page.
  const saveFeedback = (
    <>
      {notice && (
        <p role="status" className="rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-600" data-testid="division-settings-error">
          {error}
        </p>
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
      <SettingsGroup title={msg("divset.general")} defaultOpen summary={division.name}>
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
      </SettingsGroup>

      <SettingsGroup
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

        {/* Match Day C2: the match format, points and tie-breaks left Settings for the Division rules strip on the Fixtures
            tab (owner, 2026-10-31: "Rules" leave Settings; "Format" - the structure above - stays). */}
        <p className="border-t border-slate-100 pt-3 text-xs text-slate-600" data-testid="division-rules-moved">
          {msg(onlinePlayShown(division.sport_key, onlineChessOffered) ? "divset.rulesMovedOnline" : "divset.rulesMoved")}{" "}
          <Link href={fixturesHref} className="font-semibold text-purple-700 underline underline-offset-2">
            {msg("divset.rulesMovedLink")}
          </Link>
        </p>

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
      </SettingsGroup>

      {/* T6 — its own group, OUTSIDE the format lock: the camera requirement
          is edited mostly on divisions that already have fixtures, where the
          Format group above is read-only. T20: only while the club is offered online chess. */}
      {division.sport_key === "boardgame" && onlineChessOffered && (
        <SettingsGroup
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
            // Online play is set on the Fixtures tab's Division rules strip now (Match Day C2; fix round 1, M3): say where.
            <p data-testid="division-camera-needs-online" className="text-[11px] text-slate-500">
              {msg("divset.camera.needsOnlinePlay")}{" "}
              <Link href={fixturesHref} className="font-semibold text-purple-700 underline underline-offset-2" data-testid="division-camera-online-link">
                {msg("divset.rulesMovedLink")}
              </Link>
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
        </SettingsGroup>
      )}

      <SettingsGroup
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
      </SettingsGroup>

      <SettingsGroup
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
      </SettingsGroup>

      <SettingsGroup
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
      </SettingsGroup>

      <SettingsGroup title={msg("divset.sharing")} summary={msg("divset.sharingSummary")}>
        {embed}
      </SettingsGroup>

      <SettingsGroup title={msg("divset.danger")} summary={msg("divset.dangerSummary")} danger>
        {danger}
      </SettingsGroup>

      {paywallFeature && <UpgradeGate feature={paywallFeature} viewerPlan={viewerPlan} />}
      {saveFeedback}
    </div>
  );
}
