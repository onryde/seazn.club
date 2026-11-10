"use client";

// Division Settings tab (v8 spec §2): General → Sharing & embed → Danger zone, tap-per-section.
// Match Day C2 (owner, 2026-10-31): the match RULES - variant, online play and its clock, points, every rule field, the
// tie-break order - left this tab for the Division rules strip on the Fixtures tab (`components/v2/rules/`).
// Match Day C4 (owner, 2026-10-31): the entrant kinds moved to the top of the Entrants tab (`entrant-kinds-settings.tsx`) and the
// Advanced overrides JSON is gone for good.
// FMT5 (owner-approved mock, 2026-11-03): the FORMAT - the stage structure and its knobs - left too, for the Format button on
// the same Division rules card (`rules/division-format.tsx`); one line here points there, and the page sends an old
// `?tab=format` link to the Fixtures tab with the Format dialog open.
import { useEffect, useState, type ReactNode } from "react";
import { SettingsGroup } from "@/components/v2/settings-group";
import Link from "@/components/ui/console-link";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { settingsSaveErrorText } from "@/lib/config-issue-copy";
import { fileToWebp, putLogo } from "@/lib/division-logo-upload";
import { divisionAccent, monogram } from "@/lib/division-hue";
import { ONLINE_CHESS_DISABLED_CODE, onlinePlayShown } from "@/lib/online-chess";
import { CAMERA_POLICIES, type CameraPolicy } from "@/lib/camera-policy";
import { UpgradeGate } from "@/components/upgrade-gate";
import { useMsg } from "@/components/i18n/dict-provider";
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


export function DivisionSettings({
  division,
  orgId,
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
  const router = useRouter();
  const [name, setName] = useState(division.name);
  const [logoUrl, setLogoUrl] = useState(division.logo_url);
  const cfg = (division.config ?? {}) as { onlinePlay?: string };
  // T6 camera policy. The control shows the EFFECTIVE value (own, else the
  // competition's, else off); `ownCamera === null` is surfaced as inherited
  // rather than collapsed into "off" — the server keeps that distinction.
  // Online play gates the control on its SAVED value: the camera has its own
  // Save, so an unsaved choice in the Division rules card must not unlock it.
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
      } else if (err instanceof ApiV1Error && err.code === "POLICY_LOCKED") {
        // Server English otherwise (no server-side i18n): localise the code.
        setError(msg("divset.err.cameraPolicyLocked"));
      } else if (err instanceof ApiV1Error && err.code === "INVALID_TIME_CONTROL") {
        // The refusal carries the catalogue keys ("3+0", "10+5"…), which read
        // the same in every locale; only the sentence around them is ours.
        const controls = Array.isArray(err.extra.controls) ? err.extra.controls.map(String).join(", ") : "";
        setError(msg("divset.err.timeControlUnsupported", { controls }));
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
      const webp = await fileToWebp(file, 512, msg);
      const { upload_url, storage_path } = await apiV1<{
        upload_url: string;
        storage_path: string;
      }>(`/api/v1/divisions/${division.id}/logo-upload-url`, { method: "POST", json: {} });
      await putLogo(upload_url, webp, msg);
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

  // D5/P8 gap closed: PatchDivision (server/api-v1/schemas/divisions.ts) and COLS
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

      {/* FMT5: the format, with the match rules, points and tie-breaks (Match Day C2), is set on the Fixtures tab's
          Division rules card; Settings keeps one line pointing there. */}
      <p className="card min-w-0 px-4 py-3 text-xs text-slate-600" data-testid="division-rules-moved">
        {msg(onlinePlayShown(division.sport_key, onlineChessOffered) ? "divset.rulesMovedOnline" : "divset.rulesMoved")}{" "}
        <Link href={fixturesHref} className="inline-flex min-h-11 items-center font-semibold text-purple-700 underline underline-offset-2 md:min-h-0">
          {msg("divset.rulesMovedLink")}
        </Link>
      </p>

      {/* T6 — its own group, OUTSIDE the format lock: the camera requirement
          is edited mostly on divisions that already have fixtures, where the
          format is read-only. T20: only while the club is offered online chess. */}
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
