"use client";

// Platform-wide knobs (spec §5). One card per setting; today that's the
// entry-fee default. Writes /api/admin/settings, superadmin-only server-side —
// and `canWrite` is the form expressing that same split, because the page is
// only gated on requireStaff() and a support user handed a live Save can only
// ever collect a 401.
import { useState } from "react";

export function AdminPlatformSettings({
  initialFeePercent,
  canWrite,
}: {
  initialFeePercent: number;
  canWrite: boolean;
}) {
  const [fee, setFee] = useState(String(initialFeePercent));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = fee.trim();
  const parsed = Number(trimmed);
  // `Number("")` is 0 — and so is `Number("   ")`. Without the emptiness clause
  // an empty box reads as a perfectly valid 0%: the button stays live, and one
  // click zeroes the platform's entire cut on entry fees. The route cannot
  // catch it (0 IS a legal fee, `z.number().min(0)`), so the form is the only
  // place that can tell "the admin meant zero" from "the admin cleared the box".
  // A `type="number"` input also reports "" for unparseable input, so this same
  // clause is what stops a typo'd "abc" from being saved as 0.
  const valid = trimmed !== "" && Number.isFinite(parsed) && parsed >= 0 && parsed <= 100;

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform_fee_percent: parsed }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Save failed (${res.status})`);
      }
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg bg-slate-800 p-4 space-y-3 max-w-xl">
      <div>
        <h2 className="text-sm font-semibold text-white">Entry-fee platform cut</h2>
        <p className="mt-1 text-xs text-slate-400">
          Default % taken from card entry fees. Applies when an org has no per-org override
          (set on the org page) and its plan has no fee row — Pro carries 2%, Event Pass 5%.
          Changes apply to new checkouts within ~5 minutes (cache TTL).
        </p>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={0}
          max={100}
          step={0.5}
          value={fee}
          onChange={(e) => {
            setFee(e.target.value);
            setSaved(false);
          }}
          aria-label="Platform fee percent"
          disabled={!canWrite}
          className="w-24 rounded bg-slate-900 border border-slate-700 px-2 py-1.5 text-sm text-white disabled:opacity-50"
        />
        <span className="text-sm text-slate-400">%</span>
        <button
          type="button"
          disabled={!canWrite || busy || !valid}
          onClick={save}
          className="rounded bg-purple-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-purple-600 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
        {saved && <span className="text-xs text-emerald-400">Saved.</span>}
        {error && <span className="text-xs text-red-400">{error}</span>}
        {!valid && <span className="text-xs text-amber-400">0–100 only</span>}
        {!canWrite && <span className="text-xs text-slate-400">Superadmin only.</span>}
      </div>
    </div>
  );
}
