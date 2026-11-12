// Quick match plan 2, Task 6 review m2: `ClearFlashParam` takes the spent `?e=` out of the URL after mount, so a reload,
// a shared link or a bookmark of a refused page does not print the refusal again. No DOM (vitest `environment: "node"`):
// the island runs through the no-DOM `renderIsland` harness, whose effects run after the render as React's do, against a
// stubbed `window` that records every `history.replaceState`.
//
// The contract: after mount, `e` is gone (every `e`, a repeated one too) and NOTHING else moves: the path (a home token
// rides it), every other parameter and the fragment. No `e`, no write at all (the empty case). Once per mount: a
// re-render writes nothing more.
//
// Sport: not applicable (the island reads a URL; it knows no sport).
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import { ClearFlashParam, FLASH_PARAM } from "../clear-flash-param";

const ORIGIN = "https://seazn.test";
const HOME = "/q/qm_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde";

/** Mount the island on a page at `path`; answer every URL it wrote. */
function mountAt(path: string, props: { alsoSpent?: readonly string[] } = {}) {
  const writes: string[] = [];
  const location = { href: `${ORIGIN}${path}` };
  vi.stubGlobal("window", {
    location,
    history: {
      replaceState: (_state: unknown, _unused: string, url: string) => {
        writes.push(url);
        location.href = new URL(url, location.href).toString();
      },
    },
  });
  const island = renderIsland(ClearFlashParam, props);
  return { island, writes, now: () => location.href.slice(ORIGIN.length) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ClearFlashParam: the spent ?e= leaves the URL, and nothing else does", () => {
  it("reads the setup page's and the home's own parameter name", () => {
    expect(FLASH_PARAM).toBe("e");   // the routes' Location: `?e=<code>` (score route, create route)
  });

  it("takes e out after mount, keeping the path, the other parameters and the fragment; renders nothing", () => {
    const cases: [string, string][] = [
      [`${HOME}?e=QUICK_MATCH_SIDES_UNKNOWN`, HOME],
      ["/en/play?e=QUICK_MATCH_TOO_MANY_ALIVE", "/en/play"],
      [`${HOME}?utm_source=pad&e=QUICK_MATCH_NOT_FOUND&from=share#up-next`, `${HOME}?utm_source=pad&from=share#up-next`],
      [`${HOME}?e=QUICK_MATCH_NOT_FOUND&e=QUICK_MATCH_LINK_LIMITED`, HOME],   // a repeated e: every one
      [`${HOME}?e=`, HOME],   // a blank e is still a spent one
    ];
    let checked = 0;
    for (const [from, to] of cases) {
      const { island, writes, now } = mountAt(from);
      expect(writes, from).toHaveLength(1);
      expect(now(), from).toBe(to);
      expect(island.tree(), "renders nothing").toEqual([]);
      checked++;
    }
    expect(checked).toBe(cases.length);
  });

  it("a URL with no e is not written at all (the empty case), with or without other parameters", () => {
    let checked = 0;
    for (const path of [HOME, `${HOME}?from=pad#up-next`, "/en/play?sport=badminton", `${HOME}?error=x&ee=1`]) {
      const { writes, now } = mountAt(path);
      expect(writes, path).toEqual([]);
      expect(now(), path).toBe(path);
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("once per mount: a re-render after the write writes nothing more", () => {
    const { island, writes } = mountAt(`${HOME}?e=QUICK_MATCH_NOT_FOUND`);
    expect(writes).toHaveLength(1);
    island.rerender({});
    island.rerender({});
    expect(writes).toHaveLength(1);
  });
});

// T8 review m4: the home's refused add hands the guest's two picks back beside `e` (`?e=…&home=<id>&away=<id>`). They are
// spent with it: named in `alsoSpent`, they leave with `e`, and only with `e`.
describe("ClearFlashParam alsoSpent: the names a refusal carries beside e go with it, and only with it", () => {
  const PICKS = ["home", "away"] as const;
  const A = "11111111-2222-4333-8444-555555555555";

  it("takes e and each named parameter out, keeping every other parameter and the fragment", () => {
    const cases: [string, string][] = [
      [`${HOME}?e=QUICK_MATCH_SAME_SIDE&home=${A}&away=${A}`, HOME],
      [`${HOME}?e=QUICK_MATCH_NOT_FOUND&home=${A}`, HOME],   // one pick handed back: that one goes
      [`${HOME}?from=share&e=QUICK_MATCH_ADHOC_LIMIT&away=${A}#up-next`, `${HOME}?from=share#up-next`],
      [`${HOME}?e=QUICK_MATCH_SIDES_UNKNOWN`, HOME],   // no picks: e alone, as before
    ];
    let checked = 0;
    for (const [from, to] of cases) {
      const { now } = mountAt(from, { alsoSpent: PICKS });
      expect(now(), from).toBe(to);
      checked++;
    }
    expect(checked).toBe(cases.length);
  });

  it("with no e, the named parameters stay (they belong to no refusal), and nothing is written", () => {
    const path = `${HOME}?home=${A}&away=${A}`;
    const { writes, now } = mountAt(path, { alsoSpent: PICKS });
    expect(writes).toEqual([]);
    expect(now()).toBe(path);
  });

  it("without alsoSpent (the setup page), a picks-shaped parameter is left alone: the default is e only", () => {
    const { now } = mountAt(`${HOME}?e=QUICK_MATCH_SAME_SIDE&home=${A}`);
    expect(now()).toBe(`${HOME}?home=${A}`);
  });
});
