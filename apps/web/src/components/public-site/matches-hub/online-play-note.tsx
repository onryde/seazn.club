// Walk-fix F8 (+ F4 on the public page): an online division says, on the public competition page, that it is played
// online (a linked Lichess account needed to enter) and what its camera policy asks of a player. Before this the page
// never mentioned it; the first hint was the register flow. NO `"use client"`: the Info and Overview tabs render it
// on the server with the public dictionary. The tones are the register flow's own (amber for a required camera, a duty;
// lavender otherwise - components/public-site/register/online-play-note.tsx).
import type { Dict as PublicDict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import type { HubDivisionT } from "@/server/public-site/competition-hub-schema";

export function HubOnlinePlayNote({
  dict,
  onlinePlay,
  divisionName,
  testId,
}: {
  dict: PublicDict;
  onlinePlay: NonNullable<HubDivisionT["onlinePlay"]>;
  /** Named in the sentence where the note stands outside its division's own box (the Overview's register slot). */
  divisionName?: string;
  testId: string;
}) {
  const policy = onlinePlay.cameraPolicy;
  return (
    <div
      data-testid={testId}
      data-camera-policy={policy}
      className={`min-w-0 max-w-prose space-y-1 rounded-lg border px-3 py-2 text-xs [overflow-wrap:anywhere] ${
        policy === "required" ? "border-[#f5d27a] bg-[#fef3c7] text-[#713f12]" : "border-transparent bg-[#f3effc] text-[#4a3a6b]"
      }`}
    >
      <p>
        {divisionName === undefined
          ? t(dict, "info.onlinePlay.body")
          : t(dict, "info.onlinePlay.named", { division: divisionName })}
      </p>
      {policy !== "off" && <p className="font-medium">{t(dict, `info.camera.${policy}`)}</p>}
    </div>
  );
}
