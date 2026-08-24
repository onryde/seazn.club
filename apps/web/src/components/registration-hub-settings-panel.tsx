import { SlidersHorizontal } from "lucide-react";

/**
 * Registration hub — Settings tab, RS004 W2's frame.
 *
 * The real content (a status-pill row per division, capacity meter, fee,
 * category/age badges, approval mode, and the row-click config panel) is
 * RS004 W3 — see `docs/superpowers/specs/2026-08-16-registration-redesign-
 * prompts/RS004-hub-settings-tab.md` scope items 3-4. This wave ships no
 * division query and no settings read at all: the frame is deliberately
 * data-free rather than a half-built row list, so there is nothing here for
 * W3 to migrate away from.
 */
export function RegistrationHubSettingsPanel({ title, body }: { title: string; body: string }) {
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
