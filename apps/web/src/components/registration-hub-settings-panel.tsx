"use client";

import { SlidersHorizontal } from "lucide-react";
import {
  RegistrationHubDivisionRow,
  type RegistrationHubRowData,
  type RegistrationHubRowContext,
} from "@/components/registration-hub-division-row";
import { useHubTabs } from "@/components/registration-hub-tabs-host";

/**
 * Registration hub — Settings tab (RS004 W3/W3c, design §5).
 *
 * W2 shipped this as a data-free designed frame; W3 filled it with one
 * `RegistrationHubDivisionRow` per division. With zero divisions the
 * original W2 frame still renders unchanged.
 *
 * B7 T24: a row's "Open settings" opens the division's settings as a hub tab
 * (registration-hub-tabs-host.tsx), which owns which divisions are open and
 * asks before an open would close a tab holding unsaved edits. It was a dialog
 * this component mounted until then.
 */
export function RegistrationHubSettingsPanel({
  title,
  body,
  rows,
  context,
}: {
  title: string;
  body: string;
  rows: RegistrationHubRowData[];
  /** Everything the rows share EXCEPT `onOpen` — the tab host supplies that. */
  context: Omit<RegistrationHubRowContext, "onOpen">;
}) {
  const tabs = useHubTabs();

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

  // An editor's rows each offer "Open settings", and only the host can open a tab: without one that button would do nothing.
  if (context.canEdit && !tabs) {
    throw new Error("RegistrationHubSettingsPanel: rendered outside RegistrationHubTabsHost, so Open settings has nothing to open");
  }
  const rowContext: RegistrationHubRowContext = {
    ...context,
    onOpen: (divisionId) => tabs?.openDivision(divisionId),
  };

  return (
    <ul data-registration-hub-settings-panel className="flex flex-col gap-3">
      {rows.map((row) => (
        <li key={row.division_id}>
          <RegistrationHubDivisionRow row={row} context={rowContext} />
        </li>
      ))}
    </ul>
  );
}
