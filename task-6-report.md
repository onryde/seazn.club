## Fix wave — smoke.ts assigned-fixtures routes (#707 critical)

**Date:** 2026-09-15

**Critical finding:** `scripts/smoke.ts` still called deleted `GET /api/v1/me/assigned-fixtures` and legacy `PATCH …/assigned-fixtures/{id}/response`.

**Changes:**
- Renamed all PATCH paths to `/api/v1/me/fixtures/{id}/officiating-response` (7 call sites across plan matrix, official onboarding, marks/reports, gap suite).
- Dropped three deleted-list GET assertions; retained PATCH 200 + score 201 and `/me` HTML checks where applicable.
- Post-fix grep: zero `assigned-fixtures` or `/my-matches` in `scripts/smoke.ts`.

**Commit:** `ed9c513af` — fix(smoke): retire assigned-fixtures routes for officiating-response
