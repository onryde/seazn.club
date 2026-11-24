## What

<!-- one-paragraph summary of the change -->

## Checklist

- [ ] Regression test added/extended that fails without this change
- [ ] The smoke script (`scripts/smoke/`: a suite file under `scripts/smoke/suites/`, wired in `scripts/smoke/main.ts`) exercises the feature on the pro AND free paths (new features)
- [ ] Help/blog updated for this change, or not affected (say why): a UX change updates its `/help` article under `apps/web/content/help/**` (v3/11 gap 14), an engine or rules change its posts under `apps/web/content/blog/**`
- [ ] `npm run openapi:gen` committed if any v1 route/schema changed (CI drift gate)
- [ ] `tsc` + unit tests green locally before push
