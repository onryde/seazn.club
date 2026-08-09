# Prompt 08: Deployment

**Context**: `docs/superpowers/specs/2026-08-07-cpsat-scheduler-design.md`,
section "Deployment" — `min_machines_running=1` (always warm), not
scale-to-zero: a cold start (~1-3s) would eat directly into the 8-10s
wall budget the whole investigation was built around. Different
traffic/latency shape than the web app's own `min_machines_running=2`
(deploy overlap + matchday headroom) — don't copy that value.

**Acceptance criteria**: the Docker image builds successfully. `fly.toml`
uses a TCP service block (gRPC over raw TCP), not `[http_service]` —
that block is HTTP/1.1-oriented and tuned for the web app.

**Do not touch**: the root `Dockerfile`/`fly.toml` (web app's own) —
this is a fully separate app/image per the design doc's repo-structure
section, additive only.

**Files:**
- Create: `services/cp-sat/Dockerfile`, `services/cp-sat/fly.toml`

---

## Corrections to this prompt (2026-08-09, from the Tasks 01-04 re-audit)

Read these before Step 1. The sample code below predates the service
being built and is wrong in at least two ways.

**1. The Python version below is WRONG.** The sample says
`python:3.11-slim`. The service is developed and tested on **CPython
3.14.6** (the owner asked for the latest stable), and every installed
wheel is native `cp314`. Shipping 3.11 would run production on a
different interpreter and a different wheel set from every test that has
ever passed. Use a 3.14 base image. If a required wheel has no cp314
build, stop and report it rather than silently dropping the base image
back.

**2. `pip install .` ships the codegen toolchain into the production
image.** `grpcio-tools` currently sits in `[project.dependencies]`, not
in a dev group — flagged by the Task 01 audit and deferred here for a
ruling. **Ruling: move it out of the runtime dependencies.** It exists to
generate stubs, the stubs are committed, and a prod image has no business
carrying a compiler toolchain. Confirm the image still starts and the
committed stubs import without it. If moving it breaks the drift gate,
that gate belongs in the dev/CI path (Prompt 09), not in the runtime deps.

**3. The health-check type interacts with a known defect — do not
"upgrade" it casually.** The Task 04 audit found the gRPC health servicer
shares the solve `ThreadPoolExecutor`: with `max_workers` solves in
flight, `Health/Check` returns `DEADLINE_EXCEEDED`, which would let a
liveness probe kill the machine mid-solve. Prompt 05c fixes that.

The `tcp_checks` block below is, as it happens, immune — a TCP accept
does not touch the solve pool. So keep `tcp_checks` here. But know what
you are trading: a TCP check proves the port is open, **not** that the
service can answer. Do not switch to a gRPC health check as an
"improvement" unless 05c has landed; and if you do add one afterwards,
verify it under `max_workers` concurrent solves, not on an idle box.

**4. `NUM_SEARCH_WORKERS` is tuned for the wrong machine.** 4 workers beat
8 and 12 — measured on a 6-physical-core dev box. `shared-cpu-2x` is 2
vCPU. Re-measure on the real machine shape before trusting the value, and
report what you measured. Related: the bench shows the wall budget is
safe on the production board *because* real boards are heavily
constrained; a sparsely-constrained org is the harder case. Do not size
memory or CPU off the dense board alone.

---

- [ ] **Step 1: Write the Dockerfile**

```dockerfile
FROM python:3.11-slim   # ← WRONG, see correction 1 above: use 3.14
WORKDIR /app
COPY pyproject.toml .
COPY src/ src/
RUN pip install --no-cache-dir .
RUN useradd -m cpsat
USER cpsat
ENV CPSAT_PORT=50051
EXPOSE 50051
CMD ["python3", "-m", "cp_sat.main"]
```

- [ ] **Step 2: Write `fly.toml`**

```toml
app = "seazn-cpsat-prod"
primary_region = "lhr"

[build]

[[services]]
  internal_port = 50051
  protocol = "tcp"

  [[services.ports]]
    port = 50051

  [[services.tcp_checks]]
    interval = "15s"
    timeout = "5s"
    grace_period = "10s"

[[vm]]
  size = "shared-cpu-2x"
  memory = "1gb"

# min_machines_running intentionally omitted from [http_service] — this app
# has no [http_service] block (gRPC over raw TCP, not HTTP/1.1). Set via
# `fly scale count 1 --min-machines-running=1` post-deploy: always warm,
# a cold start would eat directly into the 8-10s wall budget.

# Secrets (fly secrets set):
#   CPSAT_SERVICE_SECRET — new, distinct from apps/web's CRON_SECRET
```

- [ ] **Step 3: Verify the Docker image builds**

Run: `cd services/cp-sat && docker build -t cpsat-service-test .`
Expected: build succeeds with exit code 0.

- [ ] **Step 4: Commit**

```bash
git add services/cp-sat/Dockerfile services/cp-sat/fly.toml
git commit -m "feat(cp-sat): Dockerfile and Fly app config"
```

**Verify**: `docker build` exits 0. Do not `fly deploy` as part of this prompt — deployment execution is a separate, explicit step outside this plan's scope (irreversible/shared-state action, needs its own confirmation).

**Output cap**: final message under 15 lines — build exit code, image size, confirm no `[http_service]` block present.
