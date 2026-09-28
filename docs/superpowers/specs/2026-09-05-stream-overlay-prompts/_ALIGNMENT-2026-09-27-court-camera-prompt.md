# Aligning the "Court Camera Devices & Match Livestreaming" prompt with this programme

The owner brought a prompt written in another chat, with no sight of this repo or this programme, and asked
where it fits. Verdict up front: **Phase 1 is a good skeleton for work we have not built and had already
scoped (the court-bound device). Phase 2 is largely ALREADY BUILT and merged — running it as written would
rebuild R1 and introduce a second money model beside it. Phase 3 belongs to the capture app in the other
repo.** Its process section (Scout → Implementer → Reviewer, small PRs per phase) already matches our topology.

Everything below was checked against the tree on `feat/stream-relay-b` (main `782628af5`), not inferred.

## Verdict per item

| Prompt item | Where it lands |
|---|---|
| `court_devices` table | **NEW, and wanted.** This is the durable row the owner's 1a ruling needs. Our column is `org_id`, not `tenant_id`. |
| `device_pairing_codes` (6-digit + QR) | **NEW, but it must not become a THIRD code scheme.** We already have `device_links` (`dl_` scoring tokens, `token_hash` lookup, `secret_enc` sealed under `DEVICE_LINK_KEK`, V417) and the capture QR contract v1 for ingest credentials. Pairing should copy the `token_hash` + sealed-secret idiom rather than invent one. |
| Device token (`role=court_device`) | **ALIGNS with R1 Task 6** — job and page tokens signed on `AUTH_SECRET` via `jose`. Reuse it, and heed the lane-A review's I2: pin `audience` AND `algorithms`, or one surface's token verifies on another's. |
| "Revocation must take effect immediately" | **OPEN, and the prompt hand-waves it.** R1 tokens have a 5 h 30 m life and **no revocation**. "Immediately" means either a status read on every request or short-lived tokens plus refresh. A real decision, owed before Phase 1 is designed. |
| Device-scoped **RLS** | **PARTLY WRONG for this architecture.** `fixtures` and `device_links` do carry `app_user` tenant policies (`org_id = seazn_club.current_org_id()`), but `fixture_stream_sessions` and `org_stream_credits` are **RLS-forced with ZERO policies** — superuser-only by design (lane A Task 1 + `scripts/rls-exempt.ts`). A device never talks to Postgres directly; it calls a server route. So the negative tests belong at the ROUTE, not at RLS, and "device can read only its court" is a usecase guarantee. |
| Realtime per court | **The gap already recorded.** Today's channel is `fixture:{id}`, private, token minted per fixture (`api/v1/public/fixtures/[id]/realtime-token`), gated on the `realtime` entitlement with a bypass for officials and for a device link **for that same fixture**. A device that does not yet know its next fixture cannot subscribe. Needs `court:{id}` + a device-authorised mint. The prompt's "< 2 s" acceptance is reachable only with that. |
| Heartbeat every 20 s; derived offline, no cron | **ALIGNS with what R1 already does** — `heartbeat_at`, `beat_window_at`, the stale-beat trigger, and evaluation on the lazy read. Reuse rather than invent. |
| `device_heartbeats` table + retention | **Already ruled:** raw samples (`fixture_stream_samples`) are deleted after 90 days; events and provider calls are kept forever. Same pattern, same retention answer. |
| Camera wall | **NEW UI, and wanted.** Two standing rules apply: ≥2 UI options to the owner BEFORE building, and "Fixture Console" in owner vocabulary means the DIVISION page's `?tab=fixtures`, not `fixture-console.tsx`. |
| Phase 2: one live stream per MATCH | **ALREADY the model**, and now an owner ruling (1a, 2026-09-27). |
| Phase 2: stream key tied to the match, reconnect within the window | **ALREADY true by construction** — one Cloudflare live input per session; a reconnect inside the session reuses the same credentials, and the QR's `exp` is provision + `max_duration` + 30 min. |
| Phase 2: provider webhooks, signature verified | **In R1's scope already.** |
| Phase 2: viewer page with Reconnecting / Paused slate | **BUILT** — overlay W1/W2 merged, with warming / signal-lost / ended states specced. |
| Phase 2: per-match VOD linked to the match | **BUILT** — `fill_replay` plus Cloudflare retention. Note the owner's ruling: no 3-day retention number in customer copy until Task 12's sweep AND its schedule are both live. |
| Phase 2: **bill streaming MINUTES via hold/settle** | **CONTRADICTS a merged ruling. Reject.** Billing is **per-match CREDITS** (`org_stream_credits`), consumed at `live` inside the same transaction. There is no hold and no settle for stream credits, so there is no stranded-hold risk to inherit — and adding a minutes model would put a second currency beside a merged ledger. |
| Ingest provider "Mux / LiveKit / undecided — Scout to recommend" | **DECIDED AND MEASURED. Do not re-open.** Cloudflare Stream for ingest; the compositor is ffmpeg on a Fly Machine with chroma-key (B2), because browser-as-compositor failed the frame-timing bar in R0 (10 s of output carried 156 duplicated frames and 84 gaps while ffmpeg reported a healthy `fps 30.05`; B2 returned 0 and 0 over 298 frames). |
| Device app "PWA for pilot / React Native / undecided" | **This is exactly the open Q2** — web stand-in first, or wait for R3's capture app. "PWA for pilot" matches the recommendation on file. Owner has not ruled. |
| Phase 3 (kiosk/Guided Access, local backup recording, Android foreground service) | **R3, and mostly OUTSIDE this repo** (`seazn-capture`). Two ideas in it are genuinely new and worth keeping: the pre-live checklist, and **local backup recording that can replace a gappy VOD**. |
| "Don't modify solver logic; consume its outputs" | **ALIGNS** — the placement service is already consumed, not edited. |

## False premises in the prompt (findings, not blockers)

1. **"Next.js + Supabase" overstates Supabase.** `@supabase/supabase-js` is a dependency and realtime rides on
   private `fixture:{id}` channels with a JWT we mint ourselves (`lib/realtime.ts`, `jose`). The DATABASE is our
   own Postgres with **Flyway** deltas (`db/migration/deltas`, currently V417) and an `app_user` role — not a
   Supabase-managed schema. Advice about "Supabase Small tier connection-pool pressure" does not describe us.
2. **RLS is not the app's read boundary for the streaming tables** — see the table above. Writing "device RLS
   policies" into a design here would produce policies nothing consults.
3. **"Migrations fully reversible" is not this repo's convention.** There are zero `U*` undo scripts under
   `db/migration/deltas`; every change is forward-only, and an unmerged migration is AMENDED instead. Promising
   reversibility in a PR description would be promising something the tooling does not do.
4. **"Issue #348 / stranded holds" does not map.** Stream credits have no hold/settle at all, so the hazard the
   prompt is guarding against cannot arise on this path. (The AI-credit wallet does reserve, which is probably
   what that issue was about — a different currency, out of scope here.)
5. **"tenant" is not our vocabulary** — it is `org` / `org_id` throughout, and `organizations` is the table.
6. **Streaming target "[seazn.club viewer page / YouTube / both]" is settled: both**, and destination-agnostic
   (YouTube / Facebook / Twitch / Kick), with video never touching seazn's own servers.

## What I would actually run

1. **Nothing yet in lane B** — it is mid-flight on Task 7 and untouched by any of this.
2. **Phase 1, reshaped**, as the control-plane half of the court-bound device: `court_devices` + pairing on the
   existing sealed-token idiom, a `court:{id}` realtime channel with a device-authorised mint, the derived
   offline state reusing R1's heartbeat model, and the camera wall with ≥2 UI options first. It needs the two
   owner answers already on file (Q2: stand-in vs R3 app; and now the revocation question above).
3. **Skip Phase 2 as written.** Its only genuinely new items are the dashboard remote controls (start / stop /
   restart / switch court) delivered to the device, and auto-resume on launch — both of which are the same
   assignment channel as Phase 1, not a streaming rebuild.
4. **Phase 3 goes to `seazn-capture`**, with the local-backup-VOD idea carried into its spec.
