// RS011 review round 3, finding 2: `commit()` (POST
// /imports/{id}/commit) can 422 ELIGIBILITY_VIOLATION (`commitImport`,
// server/usecases/imports.ts), but its `fail()` handler only ever
// special-cased PAYMENT_REQUIRED — the same gap as `lineup-editor.tsx`'s
// finding 1, fixed with the same override-dialog retry wiring. Also proves
// the round-2-class regression it must NOT introduce: a confirmed retry
// resubmits the commit exactly once more (2 POSTs to .../commit total), it
// does not re-upload the file or re-run any other one-time step.
import { describe, expect, it, vi, afterEach } from "vitest";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { ImportWizard } from "@/components/v2/import-wizard";
import { EligibilityOverrideDialog } from "@/components/v2/eligibility-override-dialog";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

const PREVIEW = {
  importId: "imp-1",
  filename: "roster.csv",
  rowCount: 1,
  mapping: {},
  plan: {
    ops: [
      {
        kind: "entrant.create",
        ref: "e1",
        sourceRows: [1],
        after: { displayName: "Vet Player" },
      },
    ],
    stats: { clubs: 0, teams: 0, persons: 1, entrants: 1, rosters: 1 },
    issues: [],
  },
};

const calls = vi.hoisted(() => ({
  log: [] as { url: string; init?: RequestInit }[],
}));

function mockFetch() {
  // Node has no jsdom `localStorage` here (repo standing trap — no jsdom
  // anywhere in the tree); `upload()` reads/writes the remembered column
  // mapping through it, so it needs a stub or the whole upload throws before
  // ever reaching `fetch`.
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.log.push({ url, init });
      if (url === "/api/v1/imports") {
        return {
          ok: true,
          json: async () => ({ ok: true, data: PREVIEW }),
        } as Response;
      }
      if (url === `/api/v1/imports/${PREVIEW.importId}/commit`) {
        const body = init?.body ? (JSON.parse(String(init.body)) as { eligibility_override?: unknown }) : {};
        if (!body.eligibility_override) {
          return {
            ok: false,
            status: 422,
            json: async () => ({
              ok: false,
              error: {
                code: "ELIGIBILITY_VIOLATION",
                message: "import roster has 1 eligibility violation(s)",
                violations: [
                  {
                    code: "AGE_TOO_OLD",
                    message: "Too old for this division.",
                    playerIndex: 1,
                    playerName: "Vet Player",
                  },
                ],
                warnings: [],
              },
            }),
          } as unknown as Response;
        }
        return {
          ok: true,
          status: 201,
          json: async () => ({
            ok: true,
            data: { importId: PREVIEW.importId, stats: PREVIEW.plan.stats, divisionIds: ["div-1"] },
          }),
        } as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

function findFileInput(tree: ReturnType<ReturnType<typeof renderIsland>["tree"]>) {
  const el = tree.find((e) => propsOf(e).id === "import-file");
  if (!el) throw new Error("file input not found");
  return el;
}

function findCommitButton(tree: ReturnType<ReturnType<typeof renderIsland>["tree"]>) {
  const el = tree.find((e) => e.type === "button" && propsOf(e).className === "btn btn-primary");
  if (!el) throw new Error("commit button not found");
  return el;
}

function findDialogElement(tree: ReturnType<ReturnType<typeof renderIsland>["tree"]>) {
  const el = tree.find((e) => e.type === EligibilityOverrideDialog);
  if (!el) throw new Error("EligibilityOverrideDialog element not found in tree");
  return el;
}

async function mountWithPreview() {
  const island = renderIsland(ImportWizard, {});
  const file = new File(["name\nVet Player"], "roster.csv", { type: "text/csv" });
  (
    propsOf(findFileInput(island.tree())).onChange as (
      e: React.ChangeEvent<HTMLInputElement>,
    ) => void
  )({ target: { files: [file] } } as unknown as React.ChangeEvent<HTMLInputElement>);
  await vi.waitFor(() => {
    expect(() => findCommitButton(island.tree())).not.toThrow();
  });
  return island;
}

describe("ImportWizard — a 422 ELIGIBILITY_VIOLATION on commit opens the override dialog and a confirmed retry resends with eligibility_override (RS011 review round 3, finding 2)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("Commit -> 422 opens EligibilityOverrideDialog with the server's violations, not the generic error banner", async () => {
    calls.log.length = 0;
    mockFetch();
    const island = await mountWithPreview();

    expect(propsOf(findDialogElement(island.tree())).open).toBe(false);

    (propsOf(findCommitButton(island.tree())).onClick as () => void)();

    await vi.waitFor(() => {
      expect(propsOf(findDialogElement(island.tree())).open).toBe(true);
    });
    const dialogProps = propsOf(findDialogElement(island.tree()));
    expect(dialogProps.violations).toEqual([
      expect.objectContaining({ code: "AGE_TOO_OLD", playerName: "Vet Player" }),
    ]);
    const commitCalls = calls.log.filter((c) => c.url.endsWith("/commit"));
    expect(commitCalls).toHaveLength(1);
  });

  it("confirming the dialog resubmits the commit ONCE with eligibility_override, without re-uploading the file", async () => {
    calls.log.length = 0;
    mockFetch();
    const island = await mountWithPreview();

    (propsOf(findCommitButton(island.tree())).onClick as () => void)();
    await vi.waitFor(() => {
      expect(propsOf(findDialogElement(island.tree())).open).toBe(true);
    });

    (propsOf(findDialogElement(island.tree())).onConfirm as (reason: string) => void)(
      "confirmed by organiser",
    );

    await vi.waitFor(() => {
      expect(propsOf(findDialogElement(island.tree())).open).toBe(false);
    });

    // Exactly one upload (the original file select) and exactly two commit
    // attempts (the 422, then the override-confirmed retry) — no re-upload,
    // no third commit.
    const uploadCalls = calls.log.filter((c) => c.url === "/api/v1/imports");
    expect(uploadCalls).toHaveLength(1);
    const commitCalls = calls.log.filter((c) => c.url.endsWith("/commit"));
    expect(commitCalls).toHaveLength(2);
    const retryBody = JSON.parse(String(commitCalls[1]!.init?.body)) as {
      eligibility_override?: { reason: string };
    };
    expect(retryBody.eligibility_override).toEqual({ reason: "confirmed by organiser" });
  });
});
