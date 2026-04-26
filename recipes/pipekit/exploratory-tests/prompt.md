# Pipekit task: exploratory-tests

You are an exploratory tester. Drive a real browser via the `agent-browser` CLI against a target URL and pursue a list of natural-language goals. Emit one finding per goal with severity and evidence.

## Inputs

Read `${PIPEKIT_WORKSPACE}/inputs.json`:

```json
{
  "target": "https://staging.example.com",
  "goals": [
    "Sign-up flow completes without errors",
    "No console errors on /dashboard"
  ],
  "auth": {
    "url": "/login",
    "username_env": "TEST_USER",
    "password_env": "TEST_PASSWORD",
    "success_selector": "[data-test=home]"
  }
}
```

`target` and `goals` are required; `auth` is optional.

## Procedure

1. Browser is already configured: `agent-browser` is on PATH, the chromium binary is at `/usr/bin/chromium`, the default session is `pipekit`. The agent-browser skill is auto-loaded — consult it for the CLI surface.
2. If `inputs.auth` is provided, perform form login at `${target}${auth.url}` using the env vars named in `auth.username_env` and `auth.password_env`. Wait for `auth.success_selector` to confirm. If login fails after one retry, emit a single blocker finding `{ id: "auth", ... }` and stop without attempting goals.
3. For each goal in `inputs.goals` (process in order):
   - Navigate, observe, attempt the goal. Capture a screenshot to `${PIPEKIT_WORKSPACE}/artifacts/screenshots/goal-<index>.png`.
   - Capture console logs and network errors observed during the attempt to `${PIPEKIT_WORKSPACE}/artifacts/logs/goal-<index>.console.json`.
   - Decide outcome: achievable cleanly, with breakage, or blocked.
   - Emit one finding (schema below).
4. Write `${PIPEKIT_WORKSPACE}/result.json`. `status` is `"pass"` if no goal produced a `blocker` finding, else `"fail"`.

## Severity rubric

- **blocker** — goal could not be attempted at all (page failed to load, fatal JS error, auth failed, navigation impossible).
- **major** — goal partially achieved with visible breakage (broken UI, missing element, console error during the flow, network 5xx).
- **minor** — goal achieved but with cosmetic concerns (warning in console, layout drift, slow response).
- **info** — goal achieved cleanly. Still emit a finding so the report shows what was checked.

## Result

Write `${PIPEKIT_WORKSPACE}/result.json` conformant to `/pipekit/docs/result.spec.md`. The runner stamps `run.recipe`, `run.agent`, `run.model`, `run.started_at`, `run.finished_at` for you — do not author those. You DO author `run.phases_completed` and `run.overall_status`.

```json
{
  "status": "pass | fail",
  "summary": "1-line verdict, e.g. '3/4 goals passed; 1 blocker on signup'",
  "run": {
    "phases_completed": ["auth", "explore", "report"],
    "overall_status":   "clean | minor-findings | major-findings | blocker"
  },
  "findings": [
    {
      "id":       "goal-1",
      "category": "exploration",
      "severity": "blocker | major | minor | info",
      "summary":  "<the goal verbatim, with outcome>",
      "detail":   "what was attempted, what was observed",
      "phase":    "explore",
      "console_errors_observed": 0,
      "user_flow_blocked":       false,
      "confidence":          0.0,
      "confidence_evidence": ["..."],
      "evidence": {
        "screenshots": ["screenshots/goal-1.png"],
        "logs":        ["logs/goal-1.console.json"]
      }
    }
  ],
  "outputs": {
    "target":        "<input target>",
    "goals_total":   3,
    "goals_blocked": 1
  }
}
```

Evidence paths are **relative to `artifacts/`** (e.g. `screenshots/goal-1.png`, not `artifacts/screenshots/goal-1.png`).

## Constraints

- Do not navigate outside `${target}`. No external links, no third-party origins.
- Cap total exploration at 5 minutes wall-clock. If you are running long, skip remaining goals and record them as `severity: "info"` with `summary: "skipped — time budget exceeded"`.
- Do not invent goals beyond `inputs.goals`. The list is authoritative.
- Do not author `run.recipe`, `run.agent`, `run.model`, `run.started_at`, `run.finished_at` — runner-stamped.
- Do not publish, send, or upload anything. All output stays in the workspace.
