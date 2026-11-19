"use client";

// W5 app-A Task 23 (X-CU-11; R24 pick 1A, owner 2026-11-16): the Group field a late player's add carries when the running root
// group has more than one pool — on the Entrants tab's add form and on the waiting strip's row. ONE select in the form's own
// style; each option names what the pool costs (its size and the matches a newcomer owes there), every smallest is marked, and the
// field opens at the server's own pick (`readTableLatePools().defaultKey`, `choosePool`). Left alone, the caller names NO pool
// (fix round 1 m1): the server decides at the moment of the write. A league or a one-pool group has no field (owner R24: a one-pool division shows no pool letter).
import { useMsg, useMsgPlural } from "@/components/i18n/dict-provider";
import type { TableLatePool } from "@/server/usecases/table-desk";

/** Whether the field shows: a group of two pools or more. */
export function poolPickerShown(pools: readonly TableLatePool[] | undefined): pools is readonly TableLatePool[] {
  return pools !== undefined && pools.length > 1;
}

export function TableLatePoolSelect({
  id,
  testId,
  pools,
  value,
  onChange,
  disabled = false,
  label = true,
  srLabel,
}: {
  id: string;
  testId: string;
  pools: readonly TableLatePool[];
  value: string;
  onChange: (key: string) => void;
  disabled?: boolean;
  /** The visible "Group" label (the form); the strip's row names it for a screen reader only. */
  label?: boolean;
  /** Fix round 1 m3: the screen-reader name when `label` is false — the strip names the player the field places ("Group for X"). */
  srLabel?: string;
}) {
  const msg = useMsg();
  const msgPlural = useMsgPlural();
  // Fix round 1 m3: "smallest" tags EVERY pool tied at the smallest size (the default is one of them: `choosePool` breaks the tie
  // by the seed snake, which the organiser cannot see), so the tag is a fact about the option, never a hint at the tie-break.
  const smallest = Math.min(...pools.map((p) => p.size));
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className={label ? "text-xs font-medium text-slate-600" : "sr-only"}>
        {label || srLabel === undefined ? msg("entrants.tableLate.pool") : srLabel}
      </label>
      <select
        id={id}
        data-testid={testId}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="input min-h-11 w-full min-w-0 max-w-full truncate"
      >
        {pools.map((p) => (
          <option key={p.key} value={p.key} data-pool={p.key}>
            {[
              msg("entrants.tableLate.poolOption", { pool: p.key }),
              msgPlural("entrants.tableLate.poolSize", p.size),
              msgPlural("entrants.tableLate.poolOwes", p.owes),
              ...(p.size === smallest ? [msg("entrants.tableLate.poolSmallest")] : []),
            ].join(" · ")}
          </option>
        ))}
      </select>
    </div>
  );
}
