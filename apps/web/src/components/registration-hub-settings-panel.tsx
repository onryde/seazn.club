"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { SlidersHorizontal } from "lucide-react";
import {
  RegistrationHubDivisionRow,
  type RegistrationHubRowData,
  type RegistrationHubRowContext,
} from "@/components/registration-hub-division-row";
import { RegistrationHubConfigPanel } from "@/components/registration-hub-config-panel";

/**
 * Registration hub — Settings tab (RS004 W3/W3c, design §5).
 *
 * W2 shipped this as a data-free designed frame; W3 filled it with one
 * `RegistrationHubDivisionRow` per division. W3c makes it stateful: it owns
 * which division's config panel (if any) is open and mounts
 * `RegistrationHubConfigPanel` for it — a client component now, since that
 * state has to live somewhere and the row/page split keeps rows themselves
 * (and `page.tsx`) exactly as read-only as before. With zero divisions the
 * original W2 frame still renders unchanged.
 */
export function RegistrationHubSettingsPanel({
  title,
  body,
  rows,
  context,
  orgSlug,
  feePercentPct,
  cardUnsupportedCurrency,
}: {
  title: string;
  body: string;
  rows: RegistrationHubRowData[];
  /** Everything the rows share EXCEPT `onOpen` — this component supplies
   *  that itself, since it is the one that owns "which row is open". */
  context: Omit<RegistrationHubRowContext, "onOpen">;
  orgSlug: string;
  /** registration.fee_percent entitlement, resolved server-side (page.tsx). */
  feePercentPct: number;
  /** Non-null when the org's connected Stripe account settles outside the
   *  registration currency allowlist. */
  cardUnsupportedCurrency: string | null;
}) {
  const router = useRouter();
  const [openDivisionId, setOpenDivisionId] = useState<string | null>(null);

  if (rows.length === 0) {
    return (
      <div
        data-registration-hub-settings-panel
        className="card flex flex-col items-center gap-3 px-6 py-14 text-center"
      >
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-purple-100 text-purple-600">
          <SlidersHorizontal className="h-6 w-6" strokeWidth={1.75} aria-hidden />
        </span>
        <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
        <p className="max-w-md text-sm text-slate-500">{body}</p>
      </div>
    );
  }

  const rowContext: RegistrationHubRowContext = { ...context, onOpen: setOpenDivisionId };
  const openRow = rows.find((r) => r.division_id === openDivisionId) ?? null;

  return (
    <>
      <ul data-registration-hub-settings-panel className="flex flex-col gap-3">
        {rows.map((row) => (
          <li key={row.division_id}>
            <RegistrationHubDivisionRow row={row} context={rowContext} />
          </li>
        ))}
      </ul>

      {openRow && (
        <RegistrationHubConfigPanel
          // Keyed by division so switching rows REMOUNTS the panel with fresh
          // state, instead of the panel resetting its own state from inside an
          // effect — that shape is a cascading render (react-hooks lint) and
          // leaves one frame showing the previous division's values.
          key={openRow.division_id}
          division={{
            division_id: openRow.division_id,
            name: openRow.name,
            category: openRow.category,
            age_min: openRow.age_min,
            age_max: openRow.age_max,
          }}
          orgTz={context.orgTz}
          orgSlug={orgSlug}
          currency={context.currency}
          feePercentPct={feePercentPct}
          cardUnsupportedCurrency={cardUnsupportedCurrency}
          onClose={() => setOpenDivisionId(null)}
          onSaved={() => {
            // The row list is server-fetched (page.tsx); refresh re-runs
            // that fetch so the row reflects what was just saved instead of
            // this component trying to merge/predict the new server state.
            setOpenDivisionId(null);
            router.refresh();
          }}
        />
      )}
    </>
  );
}
