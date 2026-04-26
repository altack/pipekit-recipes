# pipekit-recipes

The canonical home for **pipekit recipes** — self-contained agent tasks you can drop into any GitHub Actions or GitLab CI pipeline via [pipekit](https://github.com/altack/pipekit).

This repo plays two roles:

1. **Hosts the `@pipekit/*` recipes** maintained by the pipekit core team (under `recipes/pipekit/`).
2. **Indexes community publishers** registered in `publishers.yaml`, producing the `index.json` consumed by [pipekit.dev](https://pipekit.dev).

If you're new, start with [pipekit's README](https://github.com/altack/pipekit) for the runtime story. This repo is content + discovery.

## Repo layout

```
pipekit-recipes/
├── publishers.yaml                  # external publishers indexed alongside us
├── recipes/
│   └── pipekit/                     # core recipes (this repo only)
│       ├── hello/
│       ├── exploratory-tests/
│       ├── dep-migration-check/
│       └── playwright-from-diff/
└── .github/
    └── workflows/
        ├── index.yml                # generates index.json on push + every 6h
        └── validate.yml             # PR-time recipe.yaml + publishers.yaml validation
```

Every recipe is a directory with at minimum:

```
<recipe>/
├── recipe.yaml      # the spec — see pipekit/docs/recipe.spec.md
└── prompt.md        # the agent system prompt
```

## Using a recipe

In GitHub Actions:

```yaml
- uses: altack/pipekit-action@main
  with:
    recipe: '@pipekit/hello'
    inputs: |
      { "name": "World" }
```

In GitLab CI:

```yaml
include:
  - remote: 'https://raw.githubusercontent.com/altack/pipekit/main/gitlab/v1.yml'
pipekit:
  variables:
    PIPEKIT_RECIPE: '@pipekit/hello'
    PIPEKIT_INPUTS: '{"name":"World"}'
```

Browse all available recipes — including community publishers — at [pipekit.dev](https://pipekit.dev).

## Contributing a recipe to `@pipekit/*`

The `recipes/pipekit/` namespace is for recipes maintained by the pipekit core team. We accept high-quality general-purpose recipes here; everything else should live in your own publisher repo (see below).

To propose one:

1. Open an issue first, describing the recipe and the problem it solves. We'll discuss fit before you build.
2. Fork this repo, add `recipes/pipekit/<your-recipe>/` with a `recipe.yaml` and `prompt.md` conforming to [`recipe.spec.md`](https://github.com/altack/pipekit/blob/main/docs/recipe.spec.md).
3. Recipes must produce a valid `result.json` per [`result.spec.md`](https://github.com/altack/pipekit/blob/main/docs/result.spec.md). The validation Action will block merge if either spec is violated.
4. Open the PR. CI runs the recipe end-to-end against a fixture; spec validation runs on every change.

## Registering as an external publisher

You can publish recipes from your own repo without ever touching this one's `recipes/` directory. Your recipes appear at [pipekit.dev](https://pipekit.dev) alongside ours, and consumers reference them as `@yourcompany/<name>`.

### Step 1 — host your recipes

Create a public repo (e.g. `yourcompany/yourcompany-pipekit-recipes`) with this layout:

```
yourcompany-pipekit-recipes/
└── recipes/
    └── yourcompany/                 # must match the org you'll register
        ├── recipe-a/
        └── recipe-b/
```

The directory under `recipes/` must match the `org` you register below. Cross-org publishing is not allowed (publishers can't claim names under another org).

Each recipe must conform to [`recipe.spec.md`](https://github.com/altack/pipekit/blob/main/docs/recipe.spec.md).

### Step 2 — register

Open a PR adding one entry to `publishers.yaml`:

```yaml
publishers:
  - org: yourcompany
    repo: yourcompany/yourcompany-pipekit-recipes
    ref: main
    homepage: https://yourcompany.com           # optional
    contact: ops@yourcompany.com                # optional, used for outage / takedown
```

Constraints (enforced at PR review):

- `org` must not collide with `pipekit` or with another existing publisher.
- `repo` must be public.
- The repo must contain at least one valid `recipes/<org>/<name>/recipe.yaml` at `ref`.

We don't gate on quality. We do remove publishers whose recipes consistently break the spec or the validation pipeline, after warning.

### Step 3 — wait for the next index run

The indexer runs on every push to `main` here and on a 6-hour schedule. After your PR merges, your recipes appear at [pipekit.dev](https://pipekit.dev) within ~6 hours.

Pushes inside your own publisher repo are picked up by the next scheduled run; if you need an immediate refresh after a fix, re-run the `index` workflow from the Actions tab.

## How the indexer works (brief)

`/.github/workflows/index.yml` walks `recipes/**/recipe.yaml` here, then walks each external publisher's repo via the GitHub API. Publisher repos that haven't moved (same SHA as last run) are served from cache, so a steady-state index run costs almost no API quota.

Output is a single `index.json` published to the `gh-pages` branch and consumed by the [pipekit.dev](https://pipekit.dev) static site.

Full design: [pipekit/docs/marketplace.md](https://github.com/altack/pipekit/blob/main/docs/marketplace.md).

## What this repo is *not*

- Not a runtime. Pipekit's runner image lives at [altack/pipekit](https://github.com/altack/pipekit). Recipes are content; the harness is separate.
- Not a place for private recipes. If your recipe can't be public, host it yourself and bind-mount it at runtime via `PIPEKIT_RECIPES_DIR`.
- Not a marketplace UI. The discovery surface is [pipekit.dev](https://pipekit.dev) (a separate static site).

## License

Recipes under `recipes/pipekit/` are MIT-licensed (see `LICENSE`). External publishers set their own license in their own repos.
