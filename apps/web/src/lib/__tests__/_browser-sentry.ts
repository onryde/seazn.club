// Test-only (no `.test.` in the name, so vitest never collects it): boot the browser Sentry client the way a consented page
// does, over the IMPORTING file's `@sentry/nextjs` mock (it must define `init` and `consoleLoggingIntegration`).
import { expect, vi } from "vitest";
import { CONSENT_KEY, CONSENT_VERSION_KEY, COOKIE_POLICY_VERSION } from "@/lib/consent";

export const TEST_DSN = "https://0123456789abcdef0123456789abcdef@o0.ingest.sentry.io/0";

/** A localStorage holding the banner's choice (lib/consent's own keys), or none; returns the store to change it later. */
export function stubConsent(choice: "accepted" | "rejected" | null, version: string = COOKIE_POLICY_VERSION): Map<string, string> {
  const store = new Map<string, string>();
  if (choice) {
    store.set(CONSENT_KEY, choice);
    store.set(CONSENT_VERSION_KEY, version);
  }
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  return store;
}

/** A DSN and the visitor's consent stubbed, src/instrumentation-client.ts imported for real, and the SDK load it schedules
 *  awaited: the options the browser client handed `init`. */
export async function bootBrowserSentry(): Promise<Record<string, unknown>> {
  vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", TEST_DSN);
  stubConsent("accepted");
  await import("../../instrumentation-client");
  const facade = await import("@/lib/sentry-browser");
  expect(await facade.loadBrowserSentry(), "the browser client loaded the (mocked) SDK").toBe(true);
  const Sentry = await import("@sentry/nextjs");
  const calls = vi.mocked(Sentry.init).mock.calls;
  expect(calls, "the browser client calls init once").toHaveLength(1);
  return calls[0]![0] as Record<string, unknown>;
}
