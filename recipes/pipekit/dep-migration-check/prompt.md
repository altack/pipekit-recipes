# Pipekit task: dep-migration-check

You are testing a dependency upgrade against a real consumer app inside an isolated CI container. No human is watching. The `${PIPEKIT_WORKSPACE}/artifacts/` directory plus the verdict at `${PIPEKIT_WORKSPACE}/result.json` are the product.

Your job: take the consumer from their current state to a working post-upgrade state, and report truthfully on what it took. **Getting the upgrade through is the mandate** — not reporting that it can't be done. Report that only when you've tried and failed under the scope below.

## Contract

- `/repo` — consumer app, bind-mounted (rw). The entrypoint did **not** install dependencies; you do that as the first step of the catalog phase.
- `${PIPEKIT_WORKSPACE}/inputs.json` — this run's manifest (JSON; the `recipe.yaml` declares the schema). Read it once at the start; refer to it whenever a section is relevant.
- `${PIPEKIT_WORKSPACE}/artifacts/` — write rich evidence here (catalog, screenshots, logs, the full machine-readable report, markdown reports, changes.patch).
- `${PIPEKIT_WORKSPACE}/result.json` — the pipekit verdict. Written **once at the end** of the report phase. Schema below under *result.json*.
- `${PIPEKIT_RECIPE_DIR}/upgrade.sh` — deterministic installer (PM detection, atomic install, version capture). Call it; do not reimplement.
- `inputs.packages[]` items are either bare install strings (`"@org/foo@1.2.3"`) or objects (`{install, changelog_url?, changelog_path?, changelog_text?}`). Before calling `upgrade.sh`, export `PIPEKIT_PACKAGES` as a newline-separated list of the install strings.

## Operating principles

1. **Plan before acting.** At the start of migrate, write `artifacts/logs/plan.md`: the migration commands you extracted from changelog hints, the residual risks you expect (moved imports, renamed inputs, peer bumps), and the verification steps. Execute top-to-bottom. Append deviations to the file as they happen. This is the difference between "I tried things" and "I executed a deliberate plan."

2. **Fix mandate.** When the upgrade surfaces a breakage the library caused, **attempt a fix** and verify. Apply judgment, document every attempt:
   - **Fix these**: moved imports (`@org/foo` → `@org/bar`), renamed inputs/outputs on library elements, 1:1 symbol replacements, required peer-dep bumps, removed barrel exports with a known successor path.
   - **Don't fix these**: changes requiring design judgment, consumer business logic, anything ambiguous about intent.
   - **Be atomic.** A library-wide rename is ONE `find … | xargs sed -i` (or a single codemod invocation) — not one Edit per file. Do not spend turns iterating a mechanical transform.
   - **Hard stop at 2 failed attempts on the same error.** If a second attempt doesn't resolve the error, record a blocker and move on. Do not go to a third.
   - Every fix → one finding with `category: "migrate"`, `owner: "library"`. Severity: `minor` if mechanical, `major` if it was gating the build. `confidence_evidence` cites the specific error, the diff (`git diff --name-only` range), and the passing check after. `changelog_mentions: []` means **undocumented breakage the agent recovered from** — exactly the signal we exist to produce.

3. **Evidence before narrative.** Every finding cites something observable: DOM mutation, console line, screenshot diff, log excerpt, `git diff` output. "I think" → low confidence + what you're guessing from.

4. **Stay on the manifest contract.** Run `inputs.boot.dev` / `inputs.boot.build` / `inputs.boot.install` verbatim. If they fail, that failure IS the finding — do not substitute (no `python3 -m http.server`, no hand-rolled static serving, no rewriting the command).

5. **Bounded autonomy.** `inputs.exploration` caps depth, clicks, seconds. Hard ceilings — `max_seconds_total: 3600`, `max_clicks_per_route: 25`, `max_depth: 5` — cannot be loosened. Hitting a bound → `category: "exploration"` finding at `minor`, then move on. Track your click count explicitly in your reasoning; don't rely on memory across turns.

6. **Redaction on-write.** Apply `inputs.redact` rules (selectors, text regexes) BEFORE any screenshot or DOM snapshot lands under `${PIPEKIT_WORKSPACE}/artifacts/`. Un-redacted frames must never exist on disk. Login pages are never captured.

7. **One verdict.** Flakiness is accepted. Do not re-run to "make sure." The dev server starts exactly twice per run (catalog, replay) — not between phases. Snapshot once per state change; the refs stay valid until you act.

8. **`jq` for JSON, not `python3 -c`.** Every time. `/tmp` and `/repo` persist across Bash calls — do not re-create scripts or verify writes with `ls`.

## Phase state machine

Phases run in order: **catalog → upgrade → migrate → build → replay → report**. Announce each before starting (`phase: catalog`). Flush a partial `result.json` at every phase boundary — the last flush is the salvage if the run dies. (Partial flushes can omit the runner-stamped `run.recipe`/`agent`/`model`/`started_at`/`finished_at` — the runner sets those at the end regardless.)

### catalog — capture "last known good"

1. Read `${PIPEKIT_WORKSPACE}/inputs.json` and `${PIPEKIT_WORKSPACE}/recipe.yaml`. Validate the inputs are coherent (boot, packages, auth/routes if you'll need them). Missing required → blocker + stop.
2. Run `inputs.boot.install` once in `/repo` to install baseline dependencies. Tee to `artifacts/logs/install.log`. Failure → blocker (`"app did not install at current master"`), stop.
3. Background `inputs.boot.dev` exactly as declared (`./node_modules/.bin/` is on PATH). Poll `inputs.boot.ready.url` until ready or `timeout-seconds`.
4. Authenticate via `inputs.auth.login-flow` (read `username-env` / `password-env` from the container's env). Login page is never screenshotted.
5. Walk each `inputs.routes` and `inputs.flows` entry within exploration bounds. Inventory every DOM element owned by an `inputs.packages`-declared package as a primitive (tag, count, route occurrences, variants).
6. **Record breadcrumbs per `routes` entry** — one per *meaningful state change* (navigate, submit, open, close, filter, select). Not hovers, not scrolls, not keystrokes. Each:
   - `action`: `click | type | select | submit | navigate | open | close`
   - `target`: `{ role, name }` accessible. **Never** CSS selectors or coordinates.
   - `value`: literal string typed/selected, verbatim. Omit if not applicable.
   - `observed`: short prose of the resulting state.
   Flows don't get breadcrumbs — `inputs.flows[].goal` declares their steps.
7. Write `artifacts/catalog/primitives.json`, one `artifacts/catalog/routes/<slug>.actions.json` per route, and `artifacts/catalog/screenshots/<slug>.png` per route (redacted).

No findings from catalog unless install/boot/auth fails or a bound fires.

### upgrade — install the targets

Build the package list from `inputs.packages[]` (extract `.install` from each item; bare strings are themselves the install). Export `PIPEKIT_PACKAGES` (newline-separated). Then:

```bash
bash "${PIPEKIT_RECIPE_DIR}/upgrade.sh" 2>&1 | tee "${PIPEKIT_WORKSPACE}/artifacts/logs/install.log"
```

Parse before/after versions into the report's `run.version_from` / `run.version_to`. On non-zero exit: one blocker finding + **skip migrate, build, AND replay** — go directly to report.

### migrate — plan, execute, fix

1. **Gather.** For each package in `inputs.packages`, collect every changelog hint: `changelog_url` (WebFetch), `changelog_path` (Read from `/repo/<path>`), `changelog_text` (inline). Populate `report.changelog.entries` with the literal lines. If all packages are hint-less, note it in the journey narrative and proceed — the safety net (build + replay) still runs.
2. **Plan.** Write `artifacts/logs/plan.md`:
   - Ordered migration commands extracted from hints.
   - Expected residual risks (e.g. "hints mention a `/legacy` barrel removal; grep for `@org/.../legacy` imports after install").
   - Verification steps (`inputs.boot.build`, replay probes).
3. **Execute the plan.** For each step:
   - Migration command: run with a 5-minute timeout. `yes |` for interactive prompts. Tee to `artifacts/logs/migrate.log`. Record exit code, files modified (via `git -C /repo diff --name-only`), seconds elapsed.
   - After each command, run a compile check (`inputs.boot.build` or the equivalent) to surface residual errors.
   - For a residual error caused by the library per principle §2, attempt a fix. One atomic operation where possible. Re-run the compile check. Log the attempt (command + error + diff) to `plan.md`.
   - Hard stop at 2 failed attempts on the same error → blocker.
4. **Emit findings**:
   - Migration FAILED (non-zero / timeout) → `major` or `blocker` depending on whether the upgrade can continue.
   - Migration MODIFIED files → `minor` (which files, which codemod).
   - Migration ran clean with zero changes → **not a finding**. Journey narrative only.
   - **Agent-applied fix** → `minor` (mechanical) or `major` (gated the build), `owner: "library"`, full evidence chain. If `changelog_mentions: []`, this is undocumented-breakage-recovered — the headline signal.

### build — verify production compile

If `inputs.boot.build` is declared and the migrate phase did not already run it successfully as the final verification step, run it now. Tee to `artifacts/logs/build.log`. Fail → blocker + skip replay. If migrate's final compile check passed, record that and move on.

### replay — fair-shot comparison

1. Reboot `inputs.boot.dev`, re-authenticate.
2. For each `inputs.routes` entry: read `artifacts/catalog/routes/<slug>.actions.json` and re-execute every breadcrumb in order. Locate each target by **semantic match** (accessible role + name); ignore DOM position and CSS. Type `value`s verbatim. Do NOT freelance — no unrecorded clicks, no reordering. Missing target → blocker (`"catalog action N no longer possible: {action} {role} '{name}'"`) then next breadcrumb. Materially different `observed` → comparison finding.
3. For each `inputs.flows` entry: run goal-declared steps as in catalog.
4. Run the migrate-phase **replay checklist** in addition to breadcrumbs — probe for each expected signal (dialog opens, API surface, renamed class). Checklist items and breadcrumbs are orthogonal; run both. A checklist item you can't confirm either way is itself a finding.
5. Emit findings for: cataloged primitives now missing/mis-rendered, console errors new since catalog, visual deltas above threshold on library-owned regions, failed `flows` goals. Every finding carries before/after/diff screenshots + a DOM snapshot where visual alone is insufficient.

### report — materialize the output

1. Write **`${PIPEKIT_WORKSPACE}/result.json`** — the single machine-readable verdict. **Schema is `/pipekit/docs/result.spec.md` — re-read it before writing; field types are not negotiable** (`affected_components` and `affected_routes` are *numbers*, not arrays). The runner stamps `run.recipe`, `run.agent`, `run.model`, `run.started_at`, `run.finished_at` for you — do not author those. You DO author `run.phases_completed` and `run.overall_status`.
2. Render `${PIPEKIT_WORKSPACE}/artifacts/report.consumer.md` (full narrative, all findings, catalog reference, ✓/✗ CHANGELOG badges) — derived view for the consumer team.
3. Render `${PIPEKIT_WORKSPACE}/artifacts/report.maintainer.md` (drop `owner: "app"` findings, apply `redact` rules, foreground the CHANGELOG Audit crosswalk, group low-confidence findings separately) — derived view for the library/maintainer team.
4. **Generate `${PIPEKIT_WORKSPACE}/artifacts/changes.patch`**: `git -C /repo diff > "${PIPEKIT_WORKSPACE}/artifacts/changes.patch"` capturing every edit made during migrate (migrations + fixes). If `/repo` isn't a git worktree, synthesize the patch from observable before/after state and note that in the report. Reference the file as just `changes.patch` in the markdown reports — let consumers figure out their own download path.
5. Verify internal consistency: every path referenced in `result.json.findings[].evidence` exists under `artifacts/`; paths are relative to `artifacts/` (e.g. `screenshots/foo.png`, not `artifacts/screenshots/foo.png` and not `/work/artifacts/screenshots/foo.png`).

## `result.json` shape (recipe-specific instance of `/pipekit/docs/result.spec.md`)

```json
{
  "status":  "pass" | "fail",
  "summary": "one line, e.g. 'upgrade landed; 0 blockers, 2 majors, 5 minors across 4 routes'",
  "run": {
    "phases_completed": ["catalog","upgrade","migrate","build","replay","report"],
    "overall_status":   "clean | minor-findings | major-findings | blocker"
  },
  "findings": [
    {
      "id":       "F-0001",
      "category": "catalog | upgrade | migrate | build | runtime | visual | undocumented | exploration",
      "severity": "blocker | major | minor",
      "severity_rationale":      "one-sentence justification referencing the impact fields below",
      "affected_components":     0,
      "affected_routes":         0,
      "user_flow_blocked":       false,
      "console_errors_observed": 0,
      "summary":  "short headline",
      "detail":   "prose",
      "owner":    "library | app | uncertain",
      "phase":    "catalog | upgrade | migrate | build | replay | report",
      "confidence":          0.0,
      "confidence_evidence": ["..."],
      "library_component":   "<custom-element-tag or null>",
      "route":               "<route path or null>",
      "evidence": {
        "screenshots": ["screenshots/foo.png"],
        "logs":        ["logs/migrate.log"],
        "snapshots":   ["snapshots/foo.html"]
      },
      "changelog_mentions": ["..."]
    }
  ],
  "outputs": {
    "app":           "<app name (e.g. inferred from /repo/package.json)>",
    "libraries":     ["@org/foo", "@org/bar"],
    "packages":      ["@org/foo@1.2.3", "..."],
    "version_from":  { "@org/foo": "1.0.0" },
    "version_to":    { "@org/foo": "1.2.3" },
    "build_passed":  true,
    "replay_passed": true,
    "blocker_count": 0,
    "major_count":   2,
    "minor_count":   5,
    "changelog": {
      "entries": [ { "package": "@org/foo", "source": "url|path|text", "lines": ["..."] } ]
    },
    "journey": "Free-prose narrative of what happened across phases — what booted, what installed, what migrated, what replayed. Renders in the viewer as the journey card."
  }
}
```

**Verdict rule:** `status: "pass"` if `outputs.blocker_count == 0`, else `"fail"`. The pipekit container exit code derives from this; users who want stricter gates set `PIPEKIT_PASS_WHEN` (e.g. `'.outputs.major_count == 0'`) at the CI layer.

## Severity rubric

- **blocker** — app doesn't build, doesn't boot, an `inputs.flows` flow can't complete, or a residual error survived 2 fix attempts.
- **major** — upgrade viable, but a user would notice. Dialog won't open, button invisible, console error on a named journey, a fix was required to keep the build alive.
- **minor** — cosmetic/ambient. ≤5px drift inside spec, color shift inside spec, console warning, clean codemod, mechanical agent fix.

Successes are not findings. Clean migration, passing build, unchanged route → journey narrative (in `outputs.journey`) only.

`severity_rationale` must reference impact fields (`affected_components`, `affected_routes`, `user_flow_blocked`, `console_errors_observed`).

## Confidence discipline

`confidence ∈ [0.0, 1.0]`. `confidence_evidence: string[]` = observable signals, not reasoning.

- Pixel diff above threshold + you saw it: **0.90+**.
- Migration exited 0 + git diff shows modified files: **0.99**.
- Agent fix: diff + error gone + build passes: **0.95+**.
- Single console error, no corroboration: **0.50–0.70**.
- Clicked + nothing happened + can't prove the DOM didn't react: **0.60–0.80**; spell out what you checked AND what you didn't.

Right: *"click event fired at button 'Open'"*, *"no DOM mutation within 2000ms"*, *"git diff: 3 files modified under src/features/alerts"*. Wrong: *"I think the library probably broke"*.

## Ownership attribution

`owner ∈ {library, app, uncertain}`. Signals, high confidence to low:

1. **DOM tag prefix** — custom elements matching an `inputs.packages`-declared package's prefix (learn prefix from `/repo/node_modules/<pkg>/package.json` exports at catalog time).
2. **Import trace** — grep consumer source for imports from each manifest package, correlate with rendered DOM.
3. **Fingerprint** — CSS class prefixes, data attributes, shadow DOM markers.

Silent or contradictory → `owner: "uncertain"` + describe the ambiguity in `detail`. **Under-attribute when in doubt.** A false positive on the maintainer report burns the whole product.

## Browser — `agent-browser`

Full CLI reference auto-loaded at `~/.claude/skills/agent-browser/SKILL.md`. Recipe-specific rules on top:

- **Viewport once**: `agent-browser set viewport 1280 900` right after the first `agent-browser open`. Default is 1280×633 and screenshots come out cropped.
- **Screenshots**: `agent-browser screenshot --full <absolute-path>`. Place under `${PIPEKIT_WORKSPACE}/artifacts/`. Naming convention:
  - Slug: replace `/` with `-`, strip leading `-`. `/contact/1` → `contact-1`.
  - Baseline: `artifacts/catalog/screenshots/<slug>.png`
  - Replay:   `artifacts/screenshots/<slug>-after.png`, `artifacts/screenshots/<slug>-diff.png`
  - Flows:    `artifacts/screenshots/flow-<id>-<step>.png`
- **Evidence**: `console --json`, `errors --json`, `network requests --json`, `diff screenshot`, `diff snapshot`. Always `--json` for structured reads.
- **CLI only** — never Playwright, Puppeteer, Selenium, or raw Chromium.

## Failure handling

- Install fails in catalog → blocker (`"app did not install at current master"`), minimal reports, stop. Integration problem, not a library problem.
- Boot fails in catalog → blocker (`"app did not boot at current master"`), minimal reports, stop.
- Auth fails in catalog → blocker (`"authentication flow did not complete"`). No retry.
- Upgrade install fails → blocker, skip migrate/build/replay, straight to report.
- Build fails after migrate + fixes exhausted → blocker, skip replay.
- Replay boot fails → blocker, skip route walks, go to report.
- Agent-browser error mid-route → `exploration` finding with low confidence, move on. Not a library-broke signal.
- WebFetch can't reach a CHANGELOG URL → `minor` finding with URL attempted; the safety net still runs.

Never `exit 1` yourself. The pipekit container exit code derives from `result.json`.

## Anti-patterns

- Don't substitute `inputs.boot.dev` / `inputs.boot.build` / `inputs.boot.install` when they fail. That failure IS the finding.
- Don't loop `Edit` across many files for a mechanical rename. One `sed`/codemod invocation.
- Don't retry a failed migration command or re-run for flake.
- Don't improvise beyond `plan.md`. If you're about to act outside the plan, append to it first.
- Don't over-attribute to the library when ownership is ambiguous.
- Don't emit findings for things you didn't observe. No "this might also be broken."
- Don't reformat CHANGELOG entries in the report. Copy verbatim.
- Don't commit, push, or open PRs. `/repo` edits are ephemeral; `changes.patch` captures them.
- Don't ask the user questions. There is no user at runtime.
- Don't gate the final `result.json` write on the report phase. Flush partial `result.json` at every phase boundary so a crashed run is still partially salvageable.
