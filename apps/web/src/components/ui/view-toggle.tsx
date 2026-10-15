"use client";

// Cards ⇄ compact list toggle (v3/03 §2, for orgs with >20 comps). The grid
// itself is server-rendered; this wrapper only flips a data attribute the
// .ecard styles respond to, and remembers the choice per browser.
import { useState, type ReactNode } from "react";
import { LayoutGrid, Rows3 } from "lucide-react";
import { useMsg } from "@/components/i18n/dict-provider";
import { useLocalStorageItem, writeLocalStorageItem } from "@/lib/use-client-snapshot";

type View = "cards" | "list";

export function ViewToggleContainer({
  storageKey,
  toggle,
  children,
}: {
  storageKey: string;
  /** Show the toggle control at all (hidden for short lists). */
  toggle: boolean;
  children: ReactNode;
}) {
  const msg = useMsg();
  // The remembered choice, read through a store: "cards" on the server and the
  // hydration render (the server cannot see it), the saved view from the
  // render after. A pick in THIS tab is held in state too — `storage` events
  // only reach other tabs, and a browser that refuses the write must still
  // switch views.
  const saved = useLocalStorageItem(storageKey);
  const [picked, setPicked] = useState<{ key: string; view: View } | null>(null);
  const view: View =
    picked?.key === storageKey ? picked.view : saved === "list" || saved === "cards" ? saved : "cards";

  function pick(next: View) {
    setPicked({ key: storageKey, view: next });
    writeLocalStorageItem(storageKey, next);
  }

  return (
    <div data-view={view}>
      {toggle && (
        <div className="mb-3 flex justify-end">
          <div role="group" aria-label="View" className="flex rounded-lg border border-purple-100 bg-white p-0.5">
            {(
              [
                { v: "cards" as const, label: msg("card.view.cards"), Icon: LayoutGrid },
                { v: "list" as const, label: msg("card.view.list"), Icon: Rows3 },
              ]
            ).map(({ v, label, Icon }) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => pick(v)}
                className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition ${
                  view === v ? "bg-purple-100 text-purple-800" : "text-slate-500 hover:text-purple-700"
                }`}
              >
                <Icon className="h-3.5 w-3.5" strokeWidth={2} />
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className={view === "list" ? "ecard-list space-y-2" : "grid gap-4 sm:grid-cols-2 lg:grid-cols-3"}>
        {children}
      </div>
    </div>
  );
}
