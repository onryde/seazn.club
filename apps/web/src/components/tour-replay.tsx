"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { TOUR_STORAGE_KEY } from "@/components/product-tour";
import { useMsg } from "@/components/i18n/dict-provider";

/**
 * Replays the product tour. `row` (the default) is a described row with a button; `link` is the quiet one-line form
 * under the Organisation card (settings C8, owner 2026-11-11): "Product tour · Replay tour".
 */
export function TourReplayButton({ variant = "row" }: { variant?: "row" | "link" }) {
  const msg = useMsg();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function replay() {
    setBusy(true);
    try {
      await fetch("/api/tour", { method: "DELETE" });
      sessionStorage.removeItem(TOUR_STORAGE_KEY);
      router.push("/dashboard");
    } finally {
      setBusy(false);
    }
  }

  const label = busy ? msg("settings.org.tour.starting") : msg("settings.org.tour.replay");

  if (variant === "link") {
    return (
      <p className="flex flex-wrap items-center gap-x-1.5 px-1 text-[13px] text-slate-600" data-testid="tour-replay-link">
        <span>{msg("settings.org.tour")}</span>
        <span aria-hidden>·</span>
        <button
          type="button"
          onClick={replay}
          disabled={busy}
          title={msg("settings.org.tour.desc")}
          className="inline-flex min-h-11 items-center font-medium text-purple-700 underline underline-offset-2 hover:text-purple-900 disabled:opacity-60"
        >
          {label}
        </button>
      </p>
    );
  }

  return (
    <div className="flex items-center justify-between gap-4">
      <p className="text-sm text-slate-500">{msg("settings.org.tour.desc")}</p>
      <button type="button" onClick={replay} disabled={busy} className="btn btn-ghost shrink-0 text-xs">
        {label}
      </button>
    </div>
  );
}
