"use client";
// The browser half of signing out, in ONE place: the logout button and the match room's "Switch account" both end a
// session, and both must kill the analytics identity with it (see logout-button's history: the cached identify payload
// and PostHog distinct id would otherwise outlive the session and misattribute the next user in this tab).
import posthog from "posthog-js";
import { api } from "@/lib/client";
import { clearAnalyticsIdentity } from "@/lib/analytics-identity";

/** End the session (`POST /api/auth/logout`), then clear the analytics identity. Rejects when the session could not be
 *  ended - the caller must NOT navigate on as if signed out. The analytics teardown is best-effort and never blocks. */
export async function signOutClient(): Promise<void> {
  await api("/api/auth/logout", { method: "POST" });
  try {
    clearAnalyticsIdentity();
    if (posthog.__loaded) posthog.reset();
  } catch {
    /* analytics teardown is best-effort */
  }
}
