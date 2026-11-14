// The compile helpers are usable more than once in one test file (B7 T24 fix round 1 m9). @tailwindcss/postcss caches one
// compiler per `from` path for the life of the process and answers a second compile under the same path with the FIRST
// compile's candidates — so a second call that shared the first one's `from` compiled nothing of its own, and read as "this
// class generates no rule".
import { describe, expect, it } from "vitest";
import { compileClasses, compileCss } from "@/components/v2/__tests__/_compiled-css";

describe("compileClasses", () => {
  it("every call in the same file compiles ITS classes, not an earlier call's", async () => {
    // Six calls, as a file with several colour and ring checks makes: the stale answer is not always the second one.
    const calls = [["text-red-700"], ["text-slate-500"], ["ring-2"], ["bg-amber-50", "text-slate-500"], ["border-sky-300"], ["outline-purple-500"]] as const;
    let checked = 0;
    for (const classes of calls) {
      const compiled = await compileClasses(classes);
      for (const c of classes) {
        expect(Object.keys(compiled.get(c) ?? {}), `${c} in call ${checked}`).not.toHaveLength(0);
      }
      checked += 1;
    }
    expect(checked).toBe(6);
  });

  it("compileCss answers the raw rules, for a variant whose selector is not the class (and stays fresh after compileClasses)", async () => {
    const css = await compileCss(["[html:has(&)]:scroll-pb-4"]);
    expect(css).toMatch(/html:has\(.+\)\s*\{[^}]*scroll-padding-bottom/);
    expect(Object.keys((await compileClasses(["text-red-700"])).get("text-red-700") ?? {})).not.toHaveLength(0);
    expect(await compileCss(["ring-2"])).toContain(".ring-2");
  });
});
