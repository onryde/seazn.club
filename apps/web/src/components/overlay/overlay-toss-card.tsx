"use client";
// Center toss card (design 2026-09-12 A2) — bar/bug only; stage gates slate.
import type { OverlayMoment } from "@/lib/overlay-moments";
import type { Phase } from "./moment-queue";

export function OverlayTossCard(props: { moment: OverlayMoment; phase: Phase }) {
  return (
    <div
      data-testid="ovl-toss-card"
      data-phase={props.phase}
      className={`ovl-toss-card ovl-toss-card--${props.phase}`}
    >
      <span className="ovl-toss-card-headline ovl-display">{props.moment.headline}</span>
    </div>
  );
}
