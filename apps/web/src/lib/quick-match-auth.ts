// Quick match (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §7.1): the system user acting in the system
// org, the actor of every guest-created row and the issuer of every guest scoring link.
//
// Import-light on purpose: the constants and a type, nothing else. device-links.ts imports it, and every importer of
// device links (the scoring door in api-v1/auth.ts, the pad page, the public realtime-token route) would otherwise carry
// the quick match create's whole graph. quick-match-create.ts re-exports it under its old path.
import type { AuthCtx } from "@/server/api-v1/auth";
import { QUICK_MATCH_SYSTEM_ORG_ID, QUICK_MATCH_SYSTEM_USER_ID } from "./quick-match-constants";

/** The system user acting in the system org (§7.1). Session-shaped, as the pad page builds its context from a link's
 *  issuer and `createFromDraft` builds a draft's. A fresh object per call: a caller may mutate what it is given. */
export function systemAuth(): AuthCtx {
  return { orgId: QUICK_MATCH_SYSTEM_ORG_ID, via: "session", userId: QUICK_MATCH_SYSTEM_USER_ID, role: "owner", keyId: null };
}
