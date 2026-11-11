"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { ArrowLeftRight } from "lucide-react";
import type { OrgMembership } from "@/lib/types";
import { orgSwitchTarget, switchActiveOrg } from "@/lib/org-switch";
import { useMsg } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";

// orgSwitchTarget moved to lib/org-switch.ts with the switch itself (the account menu switches orgs too); re-exported here
// for its existing importers (breadcrumbs, org-switch-target.test.ts).
export { orgSwitchTarget };

const ROLE_BADGE: Record<string, string> = {
  owner: "bg-amber-100 text-amber-700",
  admin: "bg-purple-100 text-purple-700",
  viewer: "bg-slate-100 text-slate-600",
};

/**
 * Compact "Switch" trigger that sits beside the active org's name in the
 * settings header. Opens a right-aligned popover listing the other
 * organizations (plus a "create new" shortcut); closes on outside click.
 *
 * All of its copy comes from the `ui` catalog via `useMsg` (settings walkthrough
 * W2, finding E): this is a customer-facing row on ?tab=organization, and it
 * shipped its five strings — trigger label and aria-label, the busy row, the
 * active marker, the create shortcut — plus the role badge as English literals,
 * so every non-English organiser read English there. The `/o` layout provides
 * the dict; `useMsg` falls back to the English catalog outside a provider.
 */
export function OrgSwitcher({
  orgs,
  activeId,
}: {
  orgs: OrgMembership[];
  activeId: string;
}) {
  const msg = useMsg();
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  async function switchTo(id: string) {
    if (id === activeId) {
      setOpen(false);
      return;
    }
    setBusy(id);
    try {
      // The shared switch (lib/org-switch.ts): POST /api/orgs/active, then a HARD navigation to the same page under the new org.
      await switchActiveOrg({ orgs, fromId: activeId, toId: id, pathname });
    } finally {
      setBusy(null);
      setOpen(false);
    }
  }

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={msg("settings.org.switch.aria")}
        className="btn btn-ghost flex items-center gap-1.5"
      >
        <ArrowLeftRight className="h-3.5 w-3.5" strokeWidth={1.75} />
        {msg("settings.org.switch")}
      </button>

      {open && (
        <ul
          role="menu"
          className="absolute right-0 top-full z-30 mt-2 w-72 max-w-[85vw] space-y-1 rounded-xl border border-purple-100 bg-white p-2 shadow-xl"
        >
          {orgs.map((o) => {
            const isActive = o.id === activeId;
            return (
              <li key={o.id}>
                <button
                  type="button"
                  disabled={busy !== null || isActive}
                  onClick={() => switchTo(o.id)}
                  className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left transition ${
                    isActive
                      ? "border-purple-300 bg-purple-50"
                      : "border-purple-100 bg-white hover:border-purple-300 hover:shadow-sm"
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-slate-800">
                      {o.name}
                    </span>
                    <span className="block truncate font-mono text-xs text-purple-400">
                      {o.slug}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className={`badge ${ROLE_BADGE[o.role]}`}>
                      {msg(`role.${o.role}` as MessageKey)}
                    </span>
                    {isActive ? (
                      <span className="text-xs font-medium text-purple-600">
                        {msg("settings.org.switch.active")}
                      </span>
                    ) : busy === o.id ? (
                      <span className="text-xs text-slate-500">
                        {msg("settings.org.switch.busy")}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
          <li>
            <button
              type="button"
              onClick={() => router.push("/orgs/new")}
              className="w-full rounded-lg border border-dashed border-purple-200 px-3 py-2 text-left text-sm font-medium text-purple-700 transition hover:border-purple-400 hover:bg-purple-50"
            >
              {msg("settings.org.switch.new")}
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}
