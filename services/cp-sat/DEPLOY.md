# Deploying the CP-SAT service — owner runbook

**You run this by hand.** CI builds the image and runs the container, but
never logs in, pushes, or deploys — deliberately
(`.github/workflows/cp-sat-service.yml:131`). No agent in this programme
runs `fly deploy`.

Run every command from the repository root. `services/cp-sat/` is the build
context: its `Dockerfile` copies `pyproject.toml` and `src/` relative to
itself, so pointing `fly` at the repo root builds the wrong tree.

Two names are load-bearing and must not be changed:

| | |
|---|---|
| Service app | `cp-sat` — Fly's private DNS derives from the app name, and `cpsat-client.ts`'s `DEFAULT_HOST` is the literal `cp-sat.flycast:50051` |
| Web app | `seazn-club-prod` (root `fly.toml`) |

Rename the service app and every solve dials a host that does not exist: the
gRPC call fails, `build.ts` falls back to greedy, and **nothing surfaces
why**. That is the failure this runbook most wants to avoid.

---

## 1. Create the app

```bash
fly apps create cp-sat        # add --org <org> if you belong to more than one
```

## 2. Allocate the PRIVATE IPv6 that makes `.flycast` resolve

**Do not skip this, and do not confuse it with a public IP.** `fly.toml` sets
`auto_stop_machines = "suspend"`, so the machine spends most of its life
suspended. Autostart is a **Fly Proxy** feature: `<app>.internal` resolves
straight to machine IPs and bypasses the proxy, so a suspended machine on an
`.internal` host is simply unreachable. `.flycast` routes through the proxy,
which is what wakes the machine on the first request.

Fly's own docs, on Flycast: *"unlike private networking using `.internal`
addresses you don't need to keep Machines running for the app to be
reachable."*

```bash
fly ips allocate-v6 --private --app cp-sat
```

Skip it and the symptom is not an error — it is **greedy boards, silently**,
for every organiser, presenting as "cp-sat got worse".

## 3. Confirm it has NO *public* IP

The private v6 above is expected and required. What must not exist is a
public address. The design's security model is that 6PN is already
WireGuard-encrypted and not internet-reachable, which is *why* a shared
secret substitutes for mTLS. A public IP invalidates that assumption.

```bash
fly ips list --app cp-sat     # expect the private v6 ONLY — no public v4/v6
```

If Fly allocated a public one anyway, release it before deploying:

```bash
fly ips release <address> --app cp-sat
```

## 4. Set the shared secret on BOTH apps

`CPSAT_SERVICE_SECRET` is new. **Never reuse `CRON_SECRET`** — a shared value
would let either service authenticate as the other.

Generate it once and set the *same* value on both apps. Do not paste it into
a chat, a commit, or a ticket.

```bash
SECRET=$(openssl rand -base64 32)
fly secrets set CPSAT_SERVICE_SECRET="$SECRET" --app cp-sat
fly secrets set CPSAT_SERVICE_SECRET="$SECRET" --app seazn-club-prod
unset SECRET
```

Both sides are required. `build.ts:1427` reads
`process.env.CPSAT_SERVICE_SECRET ?? ""`, and the service rejects an empty
secret as `UNAUTHENTICATED` — which `cpsat-client.ts:485` maps to a failure
and `build.ts` turns into a greedy board. A missing secret on the web app
therefore looks exactly like "CP-SAT is slow", not like an auth error.

## 5. Deploy

```bash
fly deploy services/cp-sat --app cp-sat
```

`fly.toml` pins `auto_stop_machines = "suspend"` with
`min_machines_running = 0`, so the machine scales to zero between solves and
**resumes from a memory snapshot** on the first request through the proxy —
much faster than the 1-3s cold start a full `stop` would cost, which matters
against an 8-10s wall budget. Nothing further is owed: **no `fly scale` call
is needed.**

This is the setting that makes step 2 non-optional. Suspended plus
`.internal` equals unreachable.

## 6. Verify before touching the web app

```bash
fly status --app cp-sat       # 1 machine, tcp check passing
fly logs --app cp-sat         # expect a bind on 50051, no tracebacks
```

Expect the machine to report `suspended` shortly after deploy once traffic
stops. That is the configuration working, not a fault.

The health check is a TCP accept, not a gRPC `Health/Check`, on purpose —
a gRPC probe once shared the solve thread pool and would kill the machine
mid-solve. A passing check proves the port accepts, not that a solve works.
Step 7 is what proves that.

## 7. Prove the cutover is actually live

The one assertion that matters: run a real Auto-schedule on a **multi-court**
board and confirm the result strip reports the CP-SAT engine, not the greedy
fallback. A board that simply "looks fine" proves nothing — greedy also
returns a plausible board, and the entire cutover once shipped inert while
every happy-path test passed (`_INDEX.md`, "The cutover nearly shipped
INERT").

If it says greedy, work through, in order: **private v6 allocated so
`.flycast` resolves (step 2)** — the most likely cause now that the machine
suspends — then secret set on both apps (step 4), app named exactly `cp-sat`
(step 1), machine actually deployed (step 5).

## 8. Owed immediately after this deploy

**Re-measure `NUM_SEARCH_WORKERS`.** It is hardcoded at 8
(`src/cp_sat/model.py`), measured on a 6-physical-core dev box. This shape is
`shared-cpu-2x` — 2 vCPU, so 4x oversubscribed — and a dev-box A/B already
found 4 beating both 8 and 12 under load. It cannot be measured anywhere but
the real machine shape.

Two prior task reports already recommended this and nothing changed, because
they recorded it in the git-ignored SDD workspace. It is in `_INDEX.md` too,
which is committed.

Watch `tiers_completed`, not `placed`. Across 24 paired runs on the
production board, `placed` was 37 of 37 every time regardless of load — what
degrades under contention is how much of the T0-T3 proof chain completes
inside the wall. **A run whose `placed` is not 37 is a real bug, not a sizing
tradeoff.**
