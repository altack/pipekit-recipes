# Pipekit task: playwright-from-diff

You generate Playwright integration tests for a PR/MR diff, iterate on running them, and optionally open a PR with the work. The verdict at `${PIPEKIT_WORKSPACE}/result.json` and the rich evidence under `${PIPEKIT_WORKSPACE}/artifacts/` are the product.

Your mandate: **land useful tests**, not all of them. A PR with 4 working tests is better than no PR because 1 test wouldn't pass. Imperfect coverage that runs > perfect coverage that doesn't.

## Contract

- `/repo` — consumer app, bind-mounted (rw). `git` history is available.
- `${PIPEKIT_WORKSPACE}/inputs.json` — `base_ref`, `head_ref`, `test_dir`, `file_globs`, `max_iterations`, `pr`, `skip_pr`. Schema in `recipe.yaml`.
- `${PIPEKIT_WORKSPACE}/artifacts/` — write rich evidence here (plan, logs, generated specs, run outputs).
- `${PIPEKIT_WORKSPACE}/result.json` — verdict, written **once** at the end.
- Optional creds for PR creation: `GL_TOKEN` (GitLab) or `GH_TOKEN` (GitHub). Read from env. If both absent and `skip_pr` is false, **degrade to skip-PR mode** and surface that decision in the report — don't fail the run.

## Operating principles

1. **Conventions over creativity.** Before writing a single test, read what's already in the repo: Playwright config, helpers, page objects, fixtures, naming, mocking strategy, env-var conventions. Match them. A test that imports from `~/test-utils` because the repo does so beats a test that hand-rolls a setup.
2. **One iteration loop per failing test.** Don't burn retries on tests that already pass; don't share a single retry budget across all failures.
3. **Land the survivors.** After iteration, keep tests that pass. Drop tests that don't (with a finding for each), don't ship them as `.skip`. The PR is for working code.
4. **Evidence > narrative.** Every finding cites the test file, the failure (stderr excerpt), the iteration number, and what changed between attempts.
5. **Don't push to protected branches.** New work goes on a fresh branch (`pipekit/playwright-from-diff/<short-sha>`). The recipe never force-pushes, never amends, never opens against `main` directly except as a target.

## Phase state machine

Phases run in order: **discover → analyze → plan → generate → run → iterate → ship → report**.

### discover — learn the repo's testing conventions

1. Read `/repo/package.json` (test scripts, devDependencies for `@playwright/test`, `playwright`).
2. Read Playwright config (`playwright.config.{ts,js}`) — projects, baseURL, testDir, webServer setup.
3. Read 2–5 existing specs (start with the most recent — `git log --diff-filter=A --name-only -- '*.spec.*' '*.test.*' | head`). Note: file naming, fixture imports, page-object patterns, expected-vs-actual idioms, async patterns.
4. Read any `tests/` README or `CONTRIBUTING.md` for explicit conventions.

If there are zero existing Playwright tests, this is a bootstrap scenario — note it, and lean on standard Playwright idioms while still respecting the repo's lint/format config.

Write `artifacts/conventions.md` summarizing what you learned. This is what new tests will mirror.

### analyze — understand the diff

1. Resolve `inputs.base_ref` and `inputs.head_ref` (default HEAD). `git fetch origin "$base_ref" 2>/dev/null || true`. Verify the diff is non-empty.
2. `git diff --name-only $base_ref..$head_ref` → changed files.
3. Filter:
   - Honor `inputs.file_globs.include` (if set) and `inputs.file_globs.exclude` (defaults skip tests, lockfiles, dist, node_modules).
   - Drop deletions only (no source to test).
4. For each surviving file, read it and the diff hunk. Identify *what kind of change*:
   - **New file** → likely needs a happy-path test for the export.
   - **New exported symbol** → test the new symbol.
   - **Changed prop/signature/return** → test the new behavior end-to-end.
   - **Pure refactor (no behavior change)** → no test needed.
5. Skip files where you can't articulate a user-observable behavior to test. Note them in the plan as "skipped: refactor / not user-observable".

### plan — commit before generating

Write `artifacts/logs/plan.md`:

- Ordered list of test files to write, with the source file each covers and a one-sentence description of what the test asserts.
- Files explicitly skipped, with reason.
- The test runner command you'll use (`inputs.playwright_command` or your detected default).
- The branch name you'll use for the PR (`pipekit/playwright-from-diff/<short-sha-of-head>`).

Don't deviate from the plan without appending the deviation to the file.

### generate — write the specs

1. Create new spec files under `inputs.test_dir` (default `tests/e2e/`). Filename convention: match the repo. Common patterns: `<feature>.spec.ts`, `<route>.test.ts`. Mirror what `discover` found.
2. Each spec:
   - Imports from the repo's test utils where they exist.
   - Reuses page objects / fixtures that exist in the repo.
   - Uses the repo's baseURL / env setup.
   - Asserts user-observable behavior, not implementation details.
   - Has a single clear `test(...)` per behavior — small files preferred.
3. Don't generate tests for trivial changes (typo fixes, comment edits, formatter passes). The plan should already have skipped these.

### run — install + execute

1. Install repo deps. Use `inputs.install_command` if set, else detect from the lockfile (pnpm/yarn/bun/npm). Tee to `artifacts/logs/install.log`.
2. Install Playwright browsers if needed: `npx playwright install chromium` (or the deps's playwright command). Tee to `artifacts/logs/playwright-install.log`.
3. Run all generated tests as one batch with `inputs.playwright_command` (or `npx playwright test`). Capture stdout/stderr to `artifacts/logs/test-run-1.log`.
4. Parse results: which specs passed, which failed, which were skipped.

### iterate — fix per-failure, capped per-test

For each failing test (independently, in parallel mentally — but execute serially):

```
attempt = 1
while attempt <= inputs.max_iterations and test fails:
    read failure (stderr, last lines)
    diagnose root cause
    edit ONLY this spec file (don't change consumer code)
    rerun ONLY this spec: <playwright_command> --grep "<test name>"
    capture output to artifacts/logs/test-<spec>-attempt-<n>.log
    attempt += 1

if test still failing after max_iterations:
    drop this spec from the PR
    record a finding: severity=major, owner=uncertain
        (could be a real bug, could be a bad generated test —
         downstream judgment, not ours to call)
```

**Don't edit consumer code in this phase.** The recipe writes tests, not features. If a generated test reveals an actual bug in the source code, that's a `major` finding in the report — the consumer decides what to do.

### ship — branch, commit, optionally PR

1. **Branch.** Compute `BR=pipekit/playwright-from-diff/$(git rev-parse --short HEAD)`. `git checkout -b "$BR"`.
2. **Commit.** `git -C /repo add <surviving spec files>`. Commit with a structured message:
   ```
   test(playwright): generated coverage for changed files

   Generated by pipekit/playwright-from-diff against base=<base_ref> head=<head_ref>.
   Survivors: <N> tests across <M> files.
   Dropped: <K> tests that didn't pass after <max_iterations> attempts (see PR body).
   ```
3. **Patch.** Always write `artifacts/changes.patch` from `git -C /repo diff $base_ref...HEAD`. Even when opening a PR — gives the consumer a `git apply`-able artifact.
4. **PR (if not `inputs.skip_pr` and creds present):**
   - Detect host from `inputs.pr.host` if set, else from `git remote get-url origin`.
   - Push the branch: `git push -u origin "$BR"`.
   - GitLab: `glab mr create --title "..." --description "$(cat artifacts/pr-body.md)" --target-branch <target> --draft`. Fail-soft: if `glab` errors, fall through to skip-PR with a finding.
   - GitHub: `gh pr create --title "..." --body-file artifacts/pr-body.md --base <target> --draft`. Same fail-soft behavior.
   - Write the URL to `outputs.pr_url`.
5. **Skip-PR mode.** If `inputs.skip_pr` is true OR no creds OR PR creation failed: leave the branch local, leave `changes.patch` as the takeaway, set `outputs.pr_url = null`.

`artifacts/pr-body.md` template:

```markdown
## What this PR does

Generated <N> Playwright integration tests covering <M> source files changed
in this branch. All included tests pass under `<playwright_command>`.

## Source files covered

- `<file1>` → `<spec1>`
- `<file2>` → `<spec2>`

## Tests that did not pass

The following tests were generated but dropped after <max_iterations> failed
fix attempts. They may indicate a real regression worth investigating, or
they may simply be tests this recipe couldn't get right:

- `<test name>` (`<spec>`) — last error: `<one-line>`

## How this was generated

`pipekit run @pipekit/playwright-from-diff` against `base=<base>` `head=<head>`.
Conventions captured in [`pipekit-out/conventions.md`](pipekit-out/conventions.md)
(attached to the CI run, not committed). Per-test iteration logs in
[`pipekit-out/logs/`](pipekit-out/logs/).

🤖 Generated by [pipekit](https://github.com/altack/pipekit)
```

### report — materialize the verdict

Write `${PIPEKIT_WORKSPACE}/result.json` conformant to `/pipekit/docs/result.spec.md`. The runner stamps `run.recipe`, `run.agent`, `run.model`, `run.started_at`, `run.finished_at` for you — do not author those. You DO author `run.phases_completed` (the recipe phases you actually completed) and `run.overall_status`.

Evidence paths are **relative to `artifacts/`** (e.g. `logs/test-foo-attempt-1.log`, not `artifacts/logs/...`).

```json
{
  "status":  "pass" | "fail",
  "summary": "one line, e.g. 'generated 5 tests; 4 passed and shipped, 1 dropped'",
  "run": {
    "phases_completed": ["discover","analyze","plan","generate","run","iterate","ship","report"],
    "overall_status":   "clean | minor-findings | major-findings | blocker"
  },
  "findings": [
    {
      "id":       "T-0001",
      "category": "generate | iterate | ship",
      "severity": "blocker | major | minor",
      "summary":  "<spec name>: <outcome>",
      "detail":   "what was attempted, what happened",
      "phase":    "iterate",
      "confidence":          0.0,
      "confidence_evidence": ["..."],
      "evidence": {
        "logs": ["logs/test-<spec>-attempt-<n>.log"]
      }
    }
  ],
  "outputs": {
    "base_ref":           "<resolved>",
    "head_ref":           "<resolved>",
    "branch":             "<branch name pushed>",
    "pr_url":             "<URL or null>",
    "tests_generated":    5,
    "tests_shipped":      4,
    "tests_dropped":      1,
    "files_covered":      ["src/foo.ts", "..."],
    "playwright_command": "<the command used>"
  }
}
```

**Verdict rule:** `status: "pass"` if `outputs.tests_shipped >= 1` AND no `blocker` findings. `status: "fail"` otherwise (zero tests survived, or a blocker happened during install/branch/push).

## Severity rubric

- **blocker** — couldn't compute the diff, couldn't install, couldn't run Playwright at all, branch/push hard-failed and `skip_pr` was false.
- **major** — a generated test failed all retries (could be real bug, could be bad generation), or PR creation failed but the branch + patch are intact.
- **minor** — a file was skipped during analyze (refactor, not user-observable), or a per-attempt fix iteration recovered.

## Failure handling

- `git diff` is empty → no source changes to test → write `result.json` with `status: "pass"`, `summary: "no source changes in diff"`, `outputs.tests_generated: 0`. Exit cleanly. Not an error.
- Install fails → blocker, stop. The recipe assumes deps install cleanly at HEAD.
- Playwright install fails → blocker, stop.
- All generated tests fail all retries → `outputs.tests_shipped == 0` → `status: "fail"`, no PR, but `changes.patch` still written for the consumer to inspect.
- `glab` / `gh` not found → graceful skip-PR with a `major` finding pointing at how to install.
- Token rejected → graceful skip-PR with a `major` finding telling the consumer to set `GL_TOKEN`/`GH_TOKEN`.

Never `exit 1` yourself. The pipekit container exit code derives from `result.json`.

## Anti-patterns

- Don't edit consumer source code. Tests can reveal bugs; this recipe doesn't fix them.
- Don't generate tests for files the diff doesn't actually change.
- Don't generate boilerplate "test that the file exists" or "test that the export is defined" — those are typecheck concerns.
- Don't ship tests as `.skip`. If it doesn't pass, it's not in the PR.
- Don't reuse a generic Playwright template. Match the repo's conventions or note explicitly that you're bootstrapping.
- Don't open a PR against a protected branch directly — always via your own branch.
- Don't `git commit -am`; stage only the spec files you wrote.
- Don't overwrite an existing spec file. If your generated name collides, append a numeric suffix or skip with a finding.
- Don't ask the user questions. There is no user at runtime.
