// Review Focus 5 / AGENTS class 10: the visual gate's vacuous mode. Every
// declared shot must exist on disk, be non-empty, and each must-differ pair
// must differ by hash; zero shots is a failure, not a pass (R25). And every
// probed state has no page-level horizontal scroll. In-memory fs, fake page.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BadEvidencePath, DuplicateShot, Evidence, type EvidenceFs, type ShotPage } from "../lib/browser/evidence.ts";

interface MemFs extends EvidenceFs { files: Map<string, Uint8Array>; dirs: string[] }
/** failWrite: a write whose path contains it throws. loseWrite: it "succeeds"
 *  but nothing lands (the read-back finds no file). */
function memFs(o: { failWrite?: string; loseWrite?: string } = {}): MemFs {
  const files = new Map<string, Uint8Array>();
  const dirs: string[] = [];
  return {
    files, dirs,
    mkdir(d) { dirs.push(d); },
    writeFile(p, data) {
      if (o.failWrite !== undefined && p.includes(o.failWrite)) throw new Error(`EACCES: permission denied, open '${p}'`);
      if (o.loseWrite !== undefined && p.includes(o.loseWrite)) return;
      files.set(p, data);
    },
    readFile(p) {
      const f = files.get(p);
      if (f === undefined) throw new Error(`ENOENT: no such file or directory, open '${p}'`);
      return f;
    },
  };
}

function fakePage(pixels: string, widths: { scrollWidth: number; clientWidth: number } = { scrollWidth: 320, clientWidth: 320 }, o: { probeThrows?: boolean; shotThrows?: boolean } = {}): ShotPage & { shots: number } {
  const page = {
    shots: 0,
    async screenshot(opts: { fullPage: boolean }) {
      if (!opts.fullPage) throw new Error("fake: the evidence shot must be full-page");
      page.shots++;
      if (o.shotThrows) throw new Error("page.screenshot: Target page, context or browser has been closed");
      return new TextEncoder().encode(pixels);
    },
    async evaluate<R>(_fn: () => R): Promise<R> {
      if (o.probeThrows) throw new Error("page.evaluate: Execution context was destroyed");
      return widths as unknown as R;
    },
  };
  return page;
}

const check = (ev: Evidence, id: string) => ev.checks().find((c) => c.id === id)!;

describe("Evidence — the visual gate", () => {
  it("empty case first: no shots → visual-evidence fails as vacuous (checked 0 is a failure, R25)", () => {
    const ev = new Evidence("/r", "case", memFs());
    const v = ev.checks().find((c) => c.id === "visual-evidence")!;
    expect(v.verdict).toBe("fail");
    expect(v.checked).toBe(0);
    // And no state probed is no proof of no scroll either.
    const s = check(ev, "no-horizontal-scroll");
    expect([s.verdict, s.checked]).toEqual(["fail", 0]);
  });

  it("checks() is exactly the two checks, and asking twice answers the same", async () => {
    const ev = new Evidence("/r", "case", memFs());
    await ev.shot(fakePage("A"), "01-built");
    expect(ev.checks().map((c) => c.id)).toEqual(["visual-evidence", "no-horizontal-scroll"]);
    expect(ev.checks()).toEqual(ev.checks());
  });

  it("a written shot lands at <dir>/shots/<case>/<label>.png, read back and hashed", async () => {
    const fs = memFs();
    const ev = new Evidence("/r", "LIFECYCLE-league-badminton", fs);
    const page = fakePage("PIXELS");
    await ev.shot(page, "01-built");
    const path = "/r/shots/LIFECYCLE-league-badminton/01-built.png";
    expect([...fs.files.keys()]).toEqual([path]);
    expect(fs.dirs).toContain("/r/shots/LIFECYCLE-league-badminton");
    expect(page.shots).toBe(1);
    const v = check(ev, "visual-evidence");
    expect([v.verdict, v.checked]).toEqual(["pass", 1]);
    expect(v.evidence.join()).toContain(createHash("sha256").update(new TextEncoder().encode("PIXELS")).digest("hex").slice(0, 12));
  });

  it("a missing or empty file reds visual-evidence by label", async () => {
    const fs = memFs({ failWrite: "02-started" });
    const ev = new Evidence("/r", "case", fs);
    await ev.shot(fakePage("A"), "01-built");
    await ev.shot(fakePage("B"), "02-started");
    expect(ev.checks().find((c) => c.id === "visual-evidence")!.evidence.join()).toMatch(/02-started/);
    expect(check(ev, "visual-evidence").verdict).toBe("fail");
    expect(check(ev, "visual-evidence").checked).toBe(2);
  });

  it("a write that silently lands nothing, an empty picture, and a screenshot that throws each red by label — and none is rethrown", async () => {
    const ev = new Evidence("/r", "case", memFs({ loseWrite: "01-lost" }));
    await expect(ev.shot(fakePage("A"), "01-lost")).resolves.toBeUndefined();
    await expect(ev.shot(fakePage(""), "02-empty")).resolves.toBeUndefined();
    await expect(ev.shot(fakePage("C", undefined, { shotThrows: true }), "03-closed")).resolves.toBeUndefined();
    await ev.shot(fakePage("D"), "04-fine");
    const v = check(ev, "visual-evidence");
    expect([v.verdict, v.checked]).toEqual(["fail", 4]);
    const bad = v.evidence.filter((e) => /not written|empty/.test(e));
    expect(bad.map((e) => e.split(":")[0])).toEqual(["01-lost", "02-empty", "03-closed"]);
  });

  it("a must-differ pair with identical pixels reds; differing pixels pass", async () => {
    const ev = new Evidence("/r", "case", memFs());
    await ev.shot(fakePage("SAME"), "01-before");
    await ev.shot(fakePage("SAME"), "02-after", { mustDiffer: "01-before" });
    expect(ev.checks().find((c) => c.id === "visual-evidence")!.verdict).toBe("fail");
    const ok = new Evidence("/r", "case2", memFs());
    await ok.shot(fakePage("X"), "01-before");
    await ok.shot(fakePage("Y"), "02-after", { mustDiffer: "01-before" });
    expect(ok.checks().find((c) => c.id === "visual-evidence")!.verdict).toBe("pass");
  });

  it("identical pixels WITHOUT a must-differ declaration are fine (two states may legitimately look alike)", async () => {
    const ev = new Evidence("/r", "case", memFs());
    await ev.shot(fakePage("SAME"), "01-a");
    await ev.shot(fakePage("SAME"), "02-b");
    expect(check(ev, "visual-evidence").verdict).toBe("pass");
  });

  it("a must-differ naming a shot that was never taken reds by both labels", async () => {
    const ev = new Evidence("/r", "case", memFs());
    await ev.shot(fakePage("X"), "02-after", { mustDiffer: "01-before" });
    const v = check(ev, "visual-evidence");
    expect(v.verdict).toBe("fail");
    expect(v.evidence.join()).toMatch(/02-after.*01-before.*never shot/);
  });

  it("no-horizontal-scroll: checked = states probed; a scrollWidth over clientWidth reds with its label and numbers", async () => {
    const ev = new Evidence("/r", "case", memFs());
    await ev.shot(fakePage("A", { scrollWidth: 320, clientWidth: 320 }), "01-a");
    await ev.shot(fakePage("B", { scrollWidth: 426, clientWidth: 320 }), "02-b");
    const c = ev.checks().find((k) => k.id === "no-horizontal-scroll")!;
    expect(c.checked).toBe(2);
    expect(c.verdict).toBe("fail");
    expect(c.evidence).toEqual(["02-b: page scrollWidth 426 > clientWidth 320"]);
  });

  it("no-horizontal-scroll: a probe that fails is a red by label, never a silent pass", async () => {
    const ev = new Evidence("/r", "case", memFs());
    await ev.shot(fakePage("A", undefined, { probeThrows: true }), "01-a");
    const c = check(ev, "no-horizontal-scroll");
    expect([c.verdict, c.checked]).toEqual(["fail", 1]);
    expect(c.evidence.join()).toMatch(/^01-a: scroll probe failed/);
    // The shot itself was still written: one failed probe does not cost the picture.
    expect(check(ev, "visual-evidence").verdict).toBe("pass");
  });

  it("a second shot under the same label is refused (it would overwrite the first picture)", async () => {
    const ev = new Evidence("/r", "case", memFs());
    await ev.shot(fakePage("A"), "01-built");
    await expect(ev.shot(fakePage("B"), "01-built")).rejects.toThrow(DuplicateShot);
  });

  it("a label or case slug that is not one plain path segment is refused by name", async () => {
    for (const slug of ["", "..", "a/b", "../escape", "a\\b"]) expect(() => new Evidence("/r", slug, memFs()), JSON.stringify(slug)).toThrow(BadEvidencePath);
    const ev = new Evidence("/r", "case", memFs());
    let refused = 0;
    for (const label of ["", "..", "a/b", "../../x", "01 built"]) {
      await expect(ev.shot(fakePage("A"), label), JSON.stringify(label)).rejects.toThrow(BadEvidencePath);
      refused++;
    }
    expect(refused).toBe(5);
    expect(check(ev, "visual-evidence").checked).toBe(0);
  });
});

// W1c Task 8 (Walkthrough A) found two ways a picture showed something the
// page was not: the builder's tab indicator caught mid-CSS-transition (ten
// animations running, the old tab's border at 82–97% alpha — settled, the
// page was right), and a full-page capture taken while the page was scrolled
// painting the sticky header at the scroll offset, over the content (H-2, H-3).
describe("Evidence — the picture is the settled page, from its top", () => {
  it("the full-page shot fast-forwards finite transitions and animations (animations: disabled)", async () => {
    const seen: unknown[] = [];
    const page: ShotPage = {
      async screenshot(opts) { seen.push(opts); return new TextEncoder().encode("A"); },
      async evaluate<R>(): Promise<R> { return { scrollWidth: 320, clientWidth: 320 } as unknown as R; },
    };
    const ev = new Evidence("/r", "case", memFs());
    await ev.shot(page, "01-built");
    await ev.shot(page, "02-next");
    expect(seen).toEqual([{ fullPage: true, animations: "disabled" }, { fullPage: true, animations: "disabled" }]);
    expect(check(ev, "visual-evidence")).toMatchObject({ verdict: "pass", checked: 2 });
  });

  it("the page is scrolled to its top BEFORE the picture, by the probe Playwright ships into the page", async () => {
    const log: string[] = [];
    let y = 900; // the organiser's last click left the page 900px down
    const page: ShotPage = {
      async screenshot() { log.push(`screenshot at y=${y}`); return new TextEncoder().encode(`A${y}`); },
      async evaluate<R>(fn: () => R): Promise<R> {
        // What Playwright does with a function: ship its SOURCE and run it in
        // the page. So rebuild it from its text (a closure over module scope
        // would throw here, as it would in the page) and run it against a
        // fake page scrolled 900px down.
        const shipped = new Function(`return (${String(fn)})`)() as () => R;
        const g = globalThis as Record<string, unknown>;
        const saved = { window: g.window, document: g.document };
        const scroller = {
          scrollWidth: 330, clientWidth: 320,
          get scrollTop() { return y; },
          set scrollTop(v: number) { y = v; log.push(`scrollTop=${v}`); },
        };
        g.window = {
          get scrollY() { return y; },
          scrollTo(a: number | { top?: number }, b?: number) { y = typeof a === "object" ? a.top ?? y : b ?? y; log.push(`scrollTo y=${y}`); },
        };
        g.document = { scrollingElement: scroller, documentElement: scroller };
        try { return shipped(); } finally { g.window = saved.window; g.document = saved.document; }
      },
    };
    const ev = new Evidence("/r", "case", memFs());
    await ev.shot(page, "01-built");
    expect(log.at(-1)).toBe("screenshot at y=0");
    expect(log.filter((l) => l.startsWith("screenshot"))).toEqual(["screenshot at y=0"]);
    // The same probe still measures the page: 330 > 320 is one sideways state.
    expect(check(ev, "no-horizontal-scroll")).toMatchObject({ verdict: "fail", checked: 1 });
    expect(check(ev, "no-horizontal-scroll").evidence.join(" ")).toMatch(/01-built: page scrollWidth 330 > clientWidth 320/);
  });
});
