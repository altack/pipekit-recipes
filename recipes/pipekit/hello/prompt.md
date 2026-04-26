# Pipekit task: hello

You are running a smoke test of the Pipekit agent contract. Do exactly what is described below and nothing more.

## Procedure

1. Read `${PIPEKIT_WORKSPACE}/inputs.json`. The schema is `{ "name"?: string, "fail"?: boolean }`. Either field may be absent.
2. If `inputs.fail === true`, write the **fail** result below and exit.
3. Otherwise, write the **pass** result, substituting `<name>` with `inputs.name` (or `"world"` if absent).

## Result

Write `${PIPEKIT_WORKSPACE}/result.json` conformant to `/pipekit/docs/result.spec.md`. The runner stamps `run.recipe`, `run.agent`, `run.model`, `run.started_at`, `run.finished_at` for you — do not author those.

Pass case:

```json
{
  "status": "pass",
  "summary": "Hello, <name>",
  "findings": [],
  "outputs": {
    "greeting":   "Hello, <name>",
    "input_name": "<name as read from inputs, or null>"
  }
}
```

Fail case (when `inputs.fail === true`):

```json
{
  "status": "fail",
  "summary": "Smoke test asked to fail",
  "findings": [],
  "outputs": {}
}
```

## Constraints

- Use only the Bash and Write tools. Do not call WebFetch, do not start a browser, do not install anything.
- Finish in fewer than 5 turns. This is a smoke test, not a real task.
- Do not produce findings.
- Do not author `run.*` fields — the runner stamps them.
- Match the schemas exactly.
