// Fix round 1, R50(g) — `PadPage` must be a structural subset that a real
// Playwright `Page` satisfies with NO cast (task-9-review.md I1: a real
// `Page.goto()` resolves `Response | null`, which is NOT assignable to the
// original `PadPage.goto`'s `Promise<void>`). A pure compile-time proof, never
// imported by anything: if `PadPage` regresses to a shape a real `Page` cannot
// satisfy, `tsc -p tsconfig.scripts.json` reds HERE with TS2322.
//
// Deviation from R50(g)'s letter ("in the test file"): `tsconfig.scripts.json`
// excludes `scripts/**/*.test.ts`, so an assertion placed in the test would be
// unchecked, not proven. Both imports are `import type`, erased under
// `node --experimental-strip-types` (`strip-types-loadable.test.ts` loads this
// file too), so this module has no runtime behaviour.
import type { Page } from "playwright";
import type { PadPage } from "./scorer.ts";

const assignablePadPage: PadPage = null as unknown as Page;
void assignablePadPage;

/** Negative control — proves the assignment above has teeth. The pre-fix
 *  `goto(): Promise<void>` must still REFUSE a real `Page`. If `Page` ever
 *  degraded to `any` (an unresolved or `skipLibCheck`-swallowed type), every
 *  assignment would pass: this directive would then go unused and tsc would
 *  red with TS2578 instead of the check passing vacuously. */
interface PreFixPadPage extends Omit<PadPage, "goto"> {
  goto(url: string): Promise<void>;
}
// @ts-expect-error TS2322 — a real Page's goto resolves Response | null, never void.
const preFixShapeRefusesRealPage: PreFixPadPage = null as unknown as Page;
void preFixShapeRefusesRealPage;
