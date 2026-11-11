// Test-only: flatten a settings island's tree THROUGH the C8 frame.
//
// `renderIsland` renders one component one level deep, and the default `walk` follows `children` only. The settings
// card takes its columns as `left` / `right` / `notices` / `footer` props, so without this every field, the form and
// the Save button are invisible to a test — which would make an absent-control assertion pass vacuously. The frame,
// the save bar and the date field are all hookless, so calling them directly is exactly what React would render.
import type { ReactElement, ReactNode } from "react";
import { propsOf, walk } from "@/components/__tests__/_hook-harness";
import { SaveBar, SettingsSplitCard } from "../shared/settings-split-card";
import { DateTimeField, type DateTimeFieldProps } from "../shared/datetime-field";

type CardProps = Parameters<typeof SettingsSplitCard>[0];
type BarProps = Parameters<typeof SaveBar>[0];

export function expandSettingsCard(node: ReactNode): ReactElement[] {
  return walk(node).flatMap((el) => {
    if (el.type === SettingsSplitCard) return [el, ...expandSettingsCard(SettingsSplitCard(propsOf(el) as unknown as CardProps))];
    if (el.type === SaveBar) return [el, ...expandSettingsCard(SaveBar(propsOf(el) as unknown as BarProps))];
    if (el.type === DateTimeField) return [el, ...walk(DateTimeField(propsOf(el) as unknown as DateTimeFieldProps))];
    return [el];
  });
}
