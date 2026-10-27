import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { ServePips } from "@/components/discipline/serve-pips";
import { DictProvider } from "@/components/i18n/dict-provider";
import uiEn from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";

const dict = uiEn as unknown as Dict;

function render(served: number, total: number): string {
  return renderToStaticMarkup(
    <DictProvider dict={dict} locale="en">
      <ServePips served={served} total={total} />
    </DictProvider>,
  );
}

describe("ServePips", () => {
  it("renders one pip per match with N filled", () => {
    const html = render(2, 3);
    const filled = (html.match(/data-filled="1"/g) ?? []).length;
    const empty = (html.match(/data-filled="0"/g) ?? []).length;
    expect(filled).toBe(2);
    expect(empty).toBe(1);
  });

  it("carries an accessible label with the served count", () => {
    const html = render(2, 3);
    expect(html).toContain("2 of 3 matches served");
    expect(html).toContain('role="img"');
  });

  it("never shows more filled pips than the total (clamps overflow)", () => {
    const html = render(5, 2);
    const filled = (html.match(/data-filled="1"/g) ?? []).length;
    expect(filled).toBe(2);
    expect(html).toContain("2 of 2 matches served");
  });

  // F6 (owner-approved 2026-10-27): the unserved pip was a FILLED slate dot (designed for the dark scorebug), so on the
  // light discipline card "0 of 3 served" read as three filled dots. Unserved is now HOLLOW — no fill, a slate ring —
  // and served stays a solid lime dot. Read off each pip's `class="…"` attribute (anchored on `="`, so a class name
  // merely appearing elsewhere in the markup cannot satisfy it).
  it("an unserved pip is hollow (transparent, slate ring) and a served one solid lime — every pip checked", () => {
    const html = render(1, 3);
    const pips = [...html.matchAll(/data-filled="([01])" class="([^"]*)"/g)].map((m) => ({ filled: m[1] === "1", cls: m[2]!.split(/\s+/) }));
    expect(pips.length, "pips checked").toBe(3);
    const unserved = pips.filter((p) => !p.filled);
    const served = pips.filter((p) => p.filled);
    expect([served.length, unserved.length]).toEqual([1, 2]);
    for (const p of unserved) {
      expect(p.cls).toEqual(expect.arrayContaining(["bg-transparent", "ring-1", "ring-inset", "ring-slate-400"]));
      expect(p.cls.some((c) => /^bg-slate-/.test(c)), `no filled slate: ${p.cls.join(" ")}`).toBe(false);
    }
    for (const p of served) {
      expect(p.cls).toContain("bg-lime-400");
      expect(p.cls).not.toContain("bg-transparent");
    }
  });

  it("empty case: nothing served ⇒ every pip hollow, none filled", () => {
    const html = render(0, 3);
    const classes = [...html.matchAll(/data-filled="0" class="([^"]*)"/g)].map((m) => m[1]!);
    expect(classes.length, "pips checked").toBe(3);
    expect(html).not.toContain('data-filled="1"');
    for (const c of classes) expect(c.split(/\s+/)).toContain("bg-transparent");
  });

  // The hollow pip is drawn for a LIGHT surface. Every consumer is named with the surface it renders the pips on, so a
  // new one — the dark scorebug or pad, say — reds here and owes a decision (a variant) rather than inheriting a pip
  // that disappears on a dark background.
  it("every consumer renders the pips on a light surface (the consumer set is pinned)", () => {
    const SRC = join(__dirname, "..", "..", "..");
    const SURFACES: Record<string, "light"> = {
      "components/discipline/discipline-panel.tsx": "light", // `.card` (bg-white) active-ban row
      "components/me/suspensions-lane.tsx": "light", // `.card` (bg-white) row on /me
    };
    const consumers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          if (entry !== "__tests__" && entry !== "node_modules") walk(full);
        } else if (/\.tsx?$/.test(entry) && !full.endsWith("serve-pips.tsx")) {
          if (/from\s+["'][^"']*serve-pips["']/.test(readFileSync(full, "utf8"))) consumers.push(relative(SRC, full));
        }
      }
    };
    walk(SRC);
    expect(consumers.length, "consumers found").toBeGreaterThan(0);
    expect(consumers.sort()).toEqual(Object.keys(SURFACES).sort());
    for (const f of consumers) expect(readFileSync(join(SRC, f), "utf8"), `${f} renders on a .card`).toMatch(/className="card[ "]/);
  });
});
