// A case's screenshots, and the two checks they owe (AGENTS class 10; Review
// Focus 5). The visual gate has its own vacuous mode: a harness that errored
// before its first picture, or states that are pixel-identical because
// nothing opened, would sign off pictures of nothing. So every declared shot
// must exist on disk and be non-empty (read BACK, then hashed), each
// must-differ pair must differ by hash, zero shots is a failure (R25), and
// every probed state has no page-level horizontal scroll.
//
// sha256 here hashes bytes to compare two pictures; it is not entropy, so the
// reference determinism gate (packages/reference) has nothing to say about it.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckResult } from "../results.ts";

/** The three fs operations a shot needs; injectable so the gate is tested
 *  without a disk. `readFile` throws when the file is absent. */
export interface EvidenceFs {
  mkdir(dir: string): void;
  writeFile(path: string, data: Uint8Array): void;
  readFile(path: string): Uint8Array;
}

export const nodeEvidenceFs: EvidenceFs = {
  mkdir: (dir) => { mkdirSync(dir, { recursive: true }); },
  writeFile: (path, data) => { writeFileSync(path, data); },
  readFile: (path) => readFileSync(path),
};

/** The page surface a shot uses — a structural subset a Playwright Page meets.
 *  The picture comes back as bytes (no `path`), so its write goes through
 *  EvidenceFs and can be read back. `animations: "disabled"` fast-forwards a
 *  finite CSS transition or animation to its end: a picture taken mid-
 *  transition shows a state the page never settles in. */
export interface ShotPage {
  screenshot(o: { fullPage: boolean; animations: "disabled" }): Promise<Uint8Array>;
  evaluate<R>(fn: () => R): Promise<R>;
}

/** One plain path segment: a label or case slug that could climb out of the
 *  report directory, or name a sub-directory, is a harness bug. */
export class BadEvidencePath extends Error {
  constructor(what: string, value: string) {
    super(`evidence: ${what} ${JSON.stringify(value)} is not one plain path segment ([A-Za-z0-9._-], not "." or "..")`);
    this.name = "BadEvidencePath";
  }
}

/** A second shot under a label would overwrite the first picture on disk. */
export class DuplicateShot extends Error {
  constructor(label: string) {
    super(`evidence: a shot labelled ${label} was already taken in this case — a second would overwrite it`);
    this.name = "DuplicateShot";
  }
}

const SEGMENT = /^[A-Za-z0-9._-]+$/;
function assertSegment(what: string, value: string): void {
  if (!SEGMENT.test(value) || value === "." || value === "..") throw new BadEvidencePath(what, value);
}

interface Shot { label: string; path: string; bytes: number; sha256: string | null; problem: string | null; mustDiffer: string | null }
interface Probe { label: string; problem: string | null; scrollWidth: number; clientWidth: number }

const firstLine = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split("\n")[0];

/** Runs INSIDE the page (Playwright ships its source, so no closure): scrolls
 *  the document to its top, then measures its own scroll box. A full-page
 *  capture of a scrolled page paints a sticky header at the scroll offset,
 *  over the content; from the top, the picture is the page as it lays out. */
function topAndWidths(): { scrollWidth: number; clientWidth: number } {
  window.scrollTo(0, 0);
  const el = document.scrollingElement ?? document.documentElement;
  return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
}

export class Evidence {
  readonly #dir: string;
  readonly #fs: EvidenceFs;
  readonly #shots: Shot[] = [];
  readonly #probes: Probe[] = [];

  constructor(dir: string, caseSlug: string, fs: EvidenceFs = nodeEvidenceFs) {
    assertSegment("case slug", caseSlug);
    this.#dir = join(dir, "shots", caseSlug);
    this.#fs = fs;
  }

  /** Scrolls the page to its top and probes its horizontal scroll, then writes
   *  a full-page PNG, transitions settled, to
   *  `<dir>/shots/<caseSlug>/<label>.png` and reads it back. A failure to
   *  probe, shoot, write or read back is RECORDED against the label, never
   *  rethrown: the case still judges its other checks. */
  async shot(page: ShotPage, label: string, o: { mustDiffer?: string } = {}): Promise<void> {
    assertSegment("shot label", label);
    if (this.#shots.some((s) => s.label === label)) throw new DuplicateShot(label);
    const path = join(this.#dir, `${label}.png`);

    try {
      const w = await page.evaluate(topAndWidths);
      if (!Number.isFinite(w?.scrollWidth) || !Number.isFinite(w?.clientWidth)) throw new Error(`probe answered ${JSON.stringify(w)}`);
      this.#probes.push({ label, problem: null, scrollWidth: w.scrollWidth, clientWidth: w.clientWidth });
    } catch (e) {
      this.#probes.push({ label, problem: firstLine(e), scrollWidth: 0, clientWidth: 0 });
    }

    const shot: Shot = { label, path, bytes: 0, sha256: null, problem: null, mustDiffer: o.mustDiffer ?? null };
    try {
      const png = await page.screenshot({ fullPage: true, animations: "disabled" });
      this.#fs.mkdir(this.#dir);
      this.#fs.writeFile(path, png);
      const back = this.#fs.readFile(path);
      shot.bytes = back.length;
      shot.sha256 = createHash("sha256").update(back).digest("hex");
    } catch (e) {
      shot.problem = firstLine(e);
    }
    this.#shots.push(shot);
  }

  /** Exactly two: "visual-evidence" and "no-horizontal-scroll". */
  checks(): CheckResult[] {
    return [this.#visual(), this.#scroll()];
  }

  #visual(): CheckResult {
    const shots = this.#shots;
    const byLabel = new Map(shots.map((s) => [s.label, s]));
    const bad: string[] = [];
    let pairs = 0;
    for (const s of shots) {
      if (s.problem !== null) bad.push(`${s.label}: not written (${s.problem})`);
      else if (s.bytes === 0) bad.push(`${s.label}: empty file (0 bytes)`);
      if (s.mustDiffer === null) continue;
      pairs++;
      const other = byLabel.get(s.mustDiffer);
      if (other === undefined) bad.push(`${s.label}: must differ from ${s.mustDiffer}, which was never shot`);
      else if (s.sha256 !== null && s.sha256 === other.sha256) bad.push(`${s.label}: identical to ${other.label} (sha256 ${s.sha256.slice(0, 12)}) — the screen did not change`);
    }
    if (shots.length === 0) {
      return { id: "visual-evidence", kind: "assertion", verdict: "fail", checked: 0, reason: "vacuous: no screenshot was taken (checked 0 is a failure)", evidence: [] };
    }
    if (bad.length > 0) {
      return { id: "visual-evidence", kind: "assertion", verdict: "fail", checked: shots.length, reason: `${bad.length} of ${shots.length} shot(s) missing, empty or unchanged`, evidence: bad };
    }
    return {
      id: "visual-evidence", kind: "assertion", verdict: "pass", checked: shots.length,
      reason: `${shots.length} shot(s) written and non-empty; ${pairs} must-differ pair(s) differ`,
      evidence: shots.map((s) => `${s.label}: ${s.bytes} bytes, sha256 ${s.sha256!.slice(0, 12)}`),
    };
  }

  #scroll(): CheckResult {
    const probes = this.#probes;
    if (probes.length === 0) {
      return { id: "no-horizontal-scroll", kind: "invariant", verdict: "fail", checked: 0, reason: "vacuous: no state was probed (checked 0 is a failure)", evidence: [] };
    }
    const bad = probes.flatMap((p) => {
      if (p.problem !== null) return [`${p.label}: scroll probe failed (${p.problem})`];
      return p.scrollWidth > p.clientWidth ? [`${p.label}: page scrollWidth ${p.scrollWidth} > clientWidth ${p.clientWidth}`] : [];
    });
    return bad.length > 0
      ? { id: "no-horizontal-scroll", kind: "invariant", verdict: "fail", checked: probes.length, reason: `${bad.length} of ${probes.length} state(s) scroll sideways or could not be probed`, evidence: bad }
      : { id: "no-horizontal-scroll", kind: "invariant", verdict: "pass", checked: probes.length, reason: `${probes.length} state(s) probed, none scrolls sideways`, evidence: [] };
  }
}
