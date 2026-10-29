// A streaming destination's platform: its name and its mark (spec 2026-09-30 §4; mockup `directory.html` — brand-
// coloured rounded squares with an initial). Shared by the Streaming page and the fixture panel's picker.
// YouTube is the exception, and the other way round from what T12 first did (owner, 2026-10-28): YouTube's branding terms say
// "any logo used within an application must be clickable and link back to YouTube content", and a row's platform mark is not a link.
// So no row's PlatformMark is ever the logo (youtube-icon.tsx owns the logo, and draws it only inside a link): YouTube's mark here is the
// house NEUTRAL tile (custom_rtmp's slate), with its initial so a YouTube row stays aligned with every other row. Never a tile of our own
// drawing in YouTube's red.
// Every STORED kind lists (spec §5.4: legacy rows keep listing until removed), so every kind has a name and a mark here —
// even though only STREAM_PLATFORMS can be created (D6).
import type { StreamTargetKind } from "@/server/api-v1/schemas";

type Msg = (key: "stream.target.kind.other", vars?: Record<string, string | number>) => string;

/** Brand names are not copy — the same proper noun in every locale. `custom_rtmp` has no brand; its label is copy. */
export const STREAM_KIND_BRAND: Record<Exclude<StreamTargetKind, "custom_rtmp">, string> = {
  youtube: "YouTube",
  facebook: "Facebook",
  twitch: "Twitch",
  kick: "Kick",
};

export function platformName(msg: Msg, kind: StreamTargetKind): string {
  return kind === "custom_rtmp" ? msg("stream.target.kind.other") : STREAM_KIND_BRAND[kind];
}

const MARK: Record<StreamTargetKind, { bg: string; fg: string; letter: string }> = {
  // Neutral on purpose (see the header): the same slate as the unbranded `custom_rtmp` tile, never YouTube's red.
  youtube: { bg: "#e2e8f0", fg: "#334155", letter: "Y" },
  twitch: { bg: "#9146ff", fg: "#ffffff", letter: "T" },
  facebook: { bg: "#1877f2", fg: "#ffffff", letter: "f" },
  kick: { bg: "#53fc18", fg: "#0b0e0f", letter: "K" },
  custom_rtmp: { bg: "#e2e8f0", fg: "#334155", letter: "•" },
};

/** Every kind with a mark — held equal to `StreamTargetKind.options` by the destinations panel's test. */
export const STREAM_MARK_KINDS = Object.keys(MARK) as StreamTargetKind[];

/** Decorative: the platform's NAME always sits beside it in text, so the mark is hidden from assistive tech. */
export function PlatformMark({ kind, size }: { kind: StreamTargetKind; size: "sm" | "md" }) {
  const m = MARK[kind];
  const box = size === "md" ? "h-8 w-8 text-sm" : "h-5 w-5 text-[11px]";
  return (
    <span
      aria-hidden="true"
      data-platform-mark={kind}
      className={`grid ${box} shrink-0 place-items-center rounded-md font-bold`}
      style={{ background: m.bg, color: m.fg }}
    >
      {m.letter}
    </span>
  );
}
