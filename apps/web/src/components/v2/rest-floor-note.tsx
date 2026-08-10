"use client";

// One line, under either minimum-rest control, naming the setting that is
// actually in charge.
//
// Four separate controls raise this floor and the strictest silently wins
// (`restFloor`, #459): `perEntrantMinRest` on the Settings tab, `restMin` on
// the Constraints tab, a per-pool `restByGroup` override, and the
// "at least one break between a team's matches" checkbox — which resolves to
// `matchMinutes + gapMinutes` and so routinely outranks both numbers without
// looking like a rest setting at all. An organiser who lowers the field in
// front of them and sees the timetable not budge has, until now, had nothing
// on screen to explain it.
//
// The note is deliberately CONDITIONAL: it appears only when the winner is a
// different control from the one it sits beside. Printing "35 min, set by this
// field" under the field that set it is noise, and noise next to every input is
// how organisers learn to stop reading the small print under inputs.
//
// It reads the engine's own resolver rather than re-deriving the MAX. A second
// implementation of this rule is the recurring defect in this subsystem, and it
// has always arrived as a literal that looked harmless.
import {
  restFloor,
  type RestFloorInputs,
  type RestFloorSource,
} from "@seazn/engine/scheduling/rest-floor";
import { useMsg } from "@/components/i18n/dict-provider";

/** Taken off `useMsg` rather than imported: the key union is generated, and it
 *  has been re-exported under more than one name. Deriving it here cannot drift
 *  from what `msg()` actually accepts. */
type MessageKey = Parameters<ReturnType<typeof useMsg>>[0];

/** Which of the two numeric controls this note is rendered beneath. The note
 *  stays silent when that control is the one setting the floor. */
export type RestFloorField = "perEntrantMinRest" | "restMin";

/** Keyed on `RestFloorSource`, not `string`. A fifth source added to
 *  `rest-floor.ts` must then fail to compile here rather than reaching
 *  `msg(undefined)` at runtime — which is precisely the silent drift the
 *  comments above are written to prevent. */
const SOURCE_KEY = {
  perEntrantMinRest: "restFloor.source.perEntrantMinRest",
  restMin: "restFloor.source.restMin",
  restByGroup: "restFloor.source.restByGroup",
  noBackToBack: "restFloor.source.noBackToBack",
} as const satisfies Record<RestFloorSource, MessageKey>;

/** Whether the note will render for these inputs.
 *
 *  Exported so a panel can decide whether to name the note in its input's
 *  `aria-describedby` WITHOUT re-deriving the condition — pointing the
 *  attribute at an id that is not in the document would be a dangling
 *  reference, and always rendering an empty span would be an empty described
 *  element. Same function the component itself calls, so the two cannot drift. */
export function restFloorNoteShown(config: RestFloorInputs, field: RestFloorField): boolean {
  const floor = restFloor(config);
  // Nothing to explain: this field is the one in charge, or no rule demands any
  // rest at all. `minutes === 0` also covers the common untouched case, where
  // every source is 0 and naming a "winner" would be actively misleading.
  return floor.source !== field && floor.minutes > 0;
}

export function RestFloorNote({
  config,
  field,
  id,
  className = "mt-0.5 block text-xs text-amber-700",
}: {
  /** The LIVE values, not the persisted ones — the note has to move while the
   *  organiser types, or it reads as stale rather than as an explanation. */
  config: RestFloorInputs;
  field: RestFloorField;
  /** Referenced from the neighbouring input's `aria-describedby`. Required:
   *  this line is the one thing the feature exists to say, so a screen-reader
   *  user reaching the field must hear it — the sibling hint and unit spans are
   *  already in that described set and this was the gap review found. */
  id: string;
  className?: string;
}) {
  const msg = useMsg();
  const floor = restFloor(config);

  if (!restFloorNoteShown(config, field)) return null;

  return (
    <span id={id} className={className} data-rest-floor-source={floor.source}>
      {msg("restFloor.note", {
        minutes: floor.minutes,
        source: msg(SOURCE_KEY[floor.source]),
      })}
    </span>
  );
}
