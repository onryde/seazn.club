"use client";
// T16 (spec §5.4) — online play and its camera requirement, stated before signup. ONE markup for the two places the
// register flow states it (walk-fix F4): the ENTRIES step's division card (the whole note) and the CONSENT step (the
// camera requirement of each selected online division). A single-division competition skips ENTRIES, so before F4 its
// player never saw the camera requirement at all. The required duty carries the owner-approved notice verbatim; nothing
// here claims the player is monitored (D8).
import { useT } from "@/components/i18n/dict-provider";
import type { CameraPolicy } from "@/lib/camera-policy";
import type { CartState, DivisionLike } from "./types";

/** A selected online division whose camera is required or optional (`off` states nothing). */
export type CameraRequirement = { name: string; policy: Exclude<CameraPolicy, "off"> };

/** M6 (T16 fix round 1): the canvas's tones — amber for a required camera (a duty), lavender otherwise. */
export function cameraNoteTone(policy: CameraPolicy | undefined): string {
  return policy === "required" ? "border-[#f5d27a] bg-[#fef3c7] text-[#713f12]" : "border-transparent bg-[#f3effc] text-[#4a3a6b]";
}

/** The camera lines alone: the requirement, and for `required` the approved player notice. Nothing for `off`/absent. */
export function CameraRequirementLines({
  policy,
  testId = "division-camera-requirement",
}: {
  policy: CameraPolicy | undefined;
  testId?: string;
}) {
  const t = useT();
  if (policy === undefined || policy === "off") return null;
  return (
    <div data-testid={testId} data-policy={policy}>
      <p className="font-medium">{t(`register.camera.${policy}`)}</p>
      {policy === "required" && <p>{t("onlineChess.camera.playerNotice")}</p>}
    </div>
  );
}

/** The division card's note: the division plays online (a Lichess link needed), then its camera lines. */
export function OnlinePlayNote({ cameraPolicy }: { cameraPolicy: CameraPolicy | undefined }) {
  const t = useT();
  return (
    <div data-testid="division-online-play" className={`mt-3 space-y-1 rounded-lg border px-3 py-2 text-xs ${cameraNoteTone(cameraPolicy)}`}>
      <p>{t("register.online.lichess")}</p>
      <CameraRequirementLines policy={cameraPolicy} />
    </div>
  );
}

/** The cart's selected divisions that play online with a camera policy other than `off`, in the cart's order, each once. */
export function selectedCameraRequirements(
  cart: Pick<CartState, "entries">,
  divisions: readonly Pick<DivisionLike, "division_id" | "name" | "online_play" | "camera_policy">[],
): CameraRequirement[] {
  const byId = new Map(divisions.map((d) => [d.division_id, d]));
  const seen = new Set<string>();
  const out: CameraRequirement[] = [];
  for (const e of cart.entries) {
    const d = byId.get(e.division_id);
    if (d === undefined || d.online_play !== true || seen.has(d.division_id)) continue;
    seen.add(d.division_id);
    if (d.camera_policy === "required" || d.camera_policy === "optional") out.push({ name: d.name, policy: d.camera_policy });
  }
  return out;
}

/** The CONSENT step's statement: one note per selected online division with a camera policy, named, in its tone. */
export function ConsentCameraNotes({ requirements }: { requirements: readonly CameraRequirement[] }) {
  if (requirements.length === 0) return null;
  return (
    <>
      {requirements.map((r, i) => (
        <div
          key={i}
          data-testid="reg-consent-camera"
          data-policy={r.policy}
          className={`mt-4 min-w-0 space-y-1 rounded-lg border px-3 py-2 text-xs [overflow-wrap:anywhere] ${cameraNoteTone(r.policy)}`}
        >
          <p className="font-semibold">{r.name}</p>
          <CameraRequirementLines policy={r.policy} testId="reg-consent-camera-lines" />
        </div>
      ))}
    </>
  );
}
