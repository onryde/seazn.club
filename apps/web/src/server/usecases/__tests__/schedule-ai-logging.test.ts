// Regression test for `releasePreviewQuietly`'s console.error -> log.warn
// conversion. Deliberately NOT in schedule-ai-route.test.ts's style (that
// suite hits real Postgres via `sql` and is skipped without DATABASE_URL) —
// `releasePreviewQuietly` only calls `releasePreview`, which this file mocks,
// so the regression it guards (a swallowed failure now being logged with
// curated fields) can be proven without a database at all.
import { afterEach, describe, expect, it, vi } from "vitest";

const releasePreviewMock = vi.fn();
vi.mock("@/server/usecases/schedule-ai-preview", () => ({
  releasePreview: (...args: unknown[]) => releasePreviewMock(...args),
}));

import { log } from "@/server/logger";
import { releasePreviewQuietly } from "../schedule-ai";

describe("releasePreviewQuietly", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    releasePreviewMock.mockReset();
  });

  it("logs a curated warning instead of throwing when the release itself fails", async () => {
    const failure = new Error("connection reset");
    releasePreviewMock.mockRejectedValueOnce(failure);
    const spy = vi.spyOn(log, "warn").mockImplementation(() => undefined as never);

    // Must not throw: both callers invoke this from a `catch`, and a throw
    // here would replace the real 402/422 the caller has to see with a
    // database error about a bookkeeping detail (see the function's own doc).
    await expect(releasePreviewQuietly("preview-1", "org-1")).resolves.toBeUndefined();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toMatchObject({
      message: failure.message,
      previewId: "preview-1",
      orgId: "org-1",
    });
    expect(spy.mock.calls[0]?.[1]).toContain("could not release preview");
  });

  it("does not log at all when the release succeeds", async () => {
    releasePreviewMock.mockResolvedValueOnce(undefined);
    const spy = vi.spyOn(log, "warn").mockImplementation(() => undefined as never);

    await releasePreviewQuietly("preview-2", "org-2");

    expect(spy).not.toHaveBeenCalled();
  });
});
