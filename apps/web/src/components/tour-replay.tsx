"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { TOUR_STORAGE_KEY } from "@/components/product-tour";
import { useMsg } from "@/components/i18n/dict-provider";

/** Replays the product tour: the quiet one-line form under the Organisation card (settings C8, owner 2026-11-11). */
export function TourReplayButton() {
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
