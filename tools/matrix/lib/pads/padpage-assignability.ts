// A compile-time proof that a real Playwright `Page` is a bench `PadPage` with
// no cast (W1c Task 7). BrowserDriver hands its page to replayEvents, which
// takes a PadPage. The shape is copied from
// tools/bench/lib/drivers/padpage-assignability.ts:16-28, negative control
// included. Nothing imports this file. It is checked by
// `tsc -p tsconfig.scripts.json`, which excludes test files, so the proof
// cannot live in a test. Both imports are `import type`, so the module has no
// runtime behaviour; strip-types-loadable.test.ts loads it like any other.
//
// It lives in lib/pads, not lib/driver as the brief names it. boundary.test.ts
// refuses a playwright import (type-only included) outside lib/browser,
// lib/pads and browser-driver.ts, so lib/driver would red that rule.
import type { Page } from "playwright";
import type { PadPage } from "../../../bench/lib/drivers/scorer.ts";

const assignablePadPage: PadPage = null as unknown as Page;
void assignablePadPage;

/** The negative control, which proves the assignment above has teeth. A
 *  PadPage whose goto resolves void must REFUSE a real Page. If `Page` ever
 *  degraded to `any` (an unresolved type, or one swallowed by skipLibCheck),
 *  every assignment would pass. This directive would then go unused, and tsc
 *  would red with TS2578 instead of passing vacuously. */
interface VoidGotoPadPage extends Omit<PadPage, "goto"> {
  goto(url: string): Promise<void>;
}
// @ts-expect-error TS2322 — a real Page's goto resolves Response | null, never void.
const voidGotoRefusesRealPage: VoidGotoPadPage = null as unknown as Page;
void voidGotoRefusesRealPage;
