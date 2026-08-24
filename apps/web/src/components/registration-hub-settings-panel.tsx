import { SlidersHorizontal } from "lucide-react";
import {
  RegistrationHubDivisionRow,
  type RegistrationHubRowData,
  type RegistrationHubRowContext,
} from "@/components/registration-hub-division-row";

/**
 * Registration hub — Settings tab (RS004 W3, design §5).
 *
 * W2 shipped this as a data-free designed frame; W3 fills it: one
 * `RegistrationHubDivisionRow` per division, fed by the page's single
 * server-side query (`rows`) plus everything the rows share (`context` —
 * dict, now, org tz, currency, the register link). With zero divisions the
 * original W2 frame still renders unchanged — an empty competition is not a
 * half-built row list either. The row-click config panel is a later wave.
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
  context: RegistrationHubRowContext;
}) {
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

  return (
    <ul data-registration-hub-settings-panel className="flex flex-col gap-3">
      {rows.map((row) => (
        <li key={row.division_id}>
          <RegistrationHubDivisionRow row={row} context={context} />
        </li>
      ))}
    </ul>
  );
}
