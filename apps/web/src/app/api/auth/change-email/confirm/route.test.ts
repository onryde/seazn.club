// The email-change confirm redirect must land on the tabbed settings account
// view (/settings?tab=account), not the removed standalone /settings/account
// page. Regression for the settings/account de-duplication.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  // No matching token row → route takes the "invalid" branch without touching
  // sql.begin, so a plain empty-result stub is enough.
  sql: vi.fn(() => Promise.resolve([])),
}));
vi.mock("@/lib/auth", () => ({ invalidateUser: vi.fn() }));

import { GET } from "./route";

describe("change-email confirm redirect", () => {
  it("redirects to the tabbed settings account view, not /settings/account", async () => {
    const res = await GET(
      new Request("https://app.test/api/auth/change-email/confirm?token=nope"),
    );
    const loc = res.headers.get("location")!;
    // Parsed against a base, because the Location is deliberately RELATIVE
    // now (see below). `new URL(loc)` on its own threw here the moment that
    // changed — the assertions underneath it are still the ones we want.
    const url = new URL(loc, "https://app.test");
    expect(url.pathname).toBe("/settings");
    expect(url.searchParams.get("tab")).toBe("account");
    expect(url.searchParams.get("email_change")).toBe("invalid");
    expect(loc).not.toContain("/settings/account");
  });

  /**
   * The Location must carry NO origin.
   *
   * This route used to build it as `new URL(path, req.url)`, and `req.url` is
   * the server's INTERNAL BINDING, not the address the browser is on. A
   * standalone server started without HOSTNAME binds 0.0.0.0, so the header
   * read `http://0.0.0.0:3000/settings?…` while the user was on
   * `http://localhost:3000`; the browser withholds the session cookie across
   * that origin hop, and the confirmation landed on `/login` — after the new
   * address had already committed (CI run 33968571673).
   *
   * The test above cannot see that: it parses the Location and inspects the
   * path, which is identical either way. This one asserts the whole header.
   */
  it("carries no origin, so it cannot cross to the server's own binding", async () => {
    const res = await GET(
      // A request whose origin is NOT where a browser would be, standing in
      // for the bind address the old code leaked into the header.
      new Request("http://0.0.0.0:3000/api/auth/change-email/confirm?token=nope"),
    );
    expect(res.headers.get("location")).toBe(
      "/settings?tab=account&email_change=invalid",
    );
  });
});
