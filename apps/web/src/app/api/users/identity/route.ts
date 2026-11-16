import { getCurrentUser } from "@/lib/auth";
import { handler } from "@/lib/http";
import { whoami } from "@/server/usecases/whoami";

/**
 * Who the visitor is, for the client-side analytics bootstrap (lib/analytics-identity). Same payload as
 * GET /api/users/me for a signed-in visitor; an anonymous one gets 200 with `data: null` instead of a 401. The
 * bootstrap asks on every public page, and a browser logs any 4xx as a console error, so the 401 put an error in the
 * console of every anonymous visit (and cost the marketing pages their Lighthouse best-practices score).
 * No session means no database read.
 */
export async function GET() {
  const res = await handler(async () => {
    const user = await getCurrentUser();
    return user ? whoami(user) : null;
  });
  // Identity must never be cacheable: a cached 200 would hand one visitor's identity to another, and a cached
  // anonymous answer would blind the identify after login.
  res.headers.set("Cache-Control", "private, no-store");
  return res;
}
