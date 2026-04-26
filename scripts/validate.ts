#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { parse } from "yaml";

const TOKEN = process.env.GITHUB_TOKEN ?? "";
const CHANGED_FILES = (process.env.CHANGED_FILES ?? "")
  .split("\n")
  .map((s) => s.trim())
  .filter(Boolean);

interface Issue {
  file: string;
  message: string;
}

const issues: Issue[] = [];
const fail = (file: string, message: string) =>
  issues.push({ file, message });

async function gh(path: string): Promise<any> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "pipekit-validator",
  };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  const r = await fetch(`https://api.github.com${path}`, { headers });
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json();
}

async function validateRecipe(path: string): Promise<void> {
  const text = await readFile(path, "utf8");
  let y: any;
  try {
    y = parse(text);
  } catch (e) {
    return fail(path, `invalid YAML: ${(e as Error).message}`);
  }
  if (!y || typeof y !== "object")
    return fail(path, `recipe.yaml must be a mapping`);

  for (const f of ["name", "version", "description", "prompt"] as const) {
    if (typeof y[f] !== "string")
      fail(path, `missing required string field '${f}'`);
  }

  const m = path.match(/^recipes\/([^/]+)\/([^/]+)\/recipe\.yaml$/);
  if (!m) {
    fail(path, `path must be recipes/<org>/<name>/recipe.yaml`);
  } else if (typeof y.name === "string" && m[2] !== y.name) {
    fail(
      path,
      `directory name '${m[2]}' must match recipe.name '${y.name}'`,
    );
  }

  if (y.tags !== undefined && !Array.isArray(y.tags))
    fail(path, `'tags' must be an array of strings`);
  if (
    y.agents?.preferred !== undefined &&
    !Array.isArray(y.agents.preferred)
  )
    fail(path, `'agents.preferred' must be an array`);
  if (y.requires?.env !== undefined && !Array.isArray(y.requires.env))
    fail(path, `'requires.env' must be an array`);
  if (y.requires?.mounts !== undefined && !Array.isArray(y.requires.mounts))
    fail(path, `'requires.mounts' must be an array`);
}

async function validatePublishers(): Promise<void> {
  const text = await readFile("publishers.yaml", "utf8");
  const y = parse(text) as { publishers?: unknown } | null;
  if (!y || y.publishers === undefined)
    return fail("publishers.yaml", `missing top-level 'publishers' list`);
  if (!Array.isArray(y.publishers))
    return fail("publishers.yaml", `'publishers' must be an array`);

  const seen = new Set<string>(["pipekit"]);
  for (const [i, raw] of y.publishers.entries()) {
    const ctx = `publishers.yaml[${i}]`;
    const p = raw as Record<string, unknown>;
    if (typeof p?.org !== "string") {
      fail(ctx, `missing 'org'`);
      continue;
    }
    if (typeof p?.repo !== "string") {
      fail(ctx, `missing 'repo'`);
      continue;
    }
    if (seen.has(p.org)) {
      fail(ctx, `org '${p.org}' collides with another publisher or 'pipekit'`);
    }
    seen.add(p.org);

    const ref = (p.ref as string | undefined) ?? "main";
    try {
      const commit = await gh(`/repos/${p.repo}/commits/${ref}`);
      const tree = await gh(
        `/repos/${p.repo}/git/trees/${commit.sha}?recursive=1`,
      );
      const re = new RegExp(`^recipes/${p.org}/[^/]+/recipe\\.yaml$`);
      const matches = (tree.tree as Array<{ path: string }>).filter((n) =>
        re.test(n.path),
      );
      if (matches.length === 0)
        fail(
          ctx,
          `${p.repo}@${ref}: no recipes/${p.org}/<name>/recipe.yaml found`,
        );
    } catch (e) {
      fail(ctx, `${p.repo}@${ref}: ${(e as Error).message}`);
    }
  }
}

async function main(): Promise<void> {
  const changedRecipes = CHANGED_FILES.filter((f) =>
    /^recipes\/[^/]+\/[^/]+\/recipe\.yaml$/.test(f),
  );
  for (const f of changedRecipes) await validateRecipe(f);

  if (CHANGED_FILES.includes("publishers.yaml")) await validatePublishers();

  if (issues.length === 0) {
    console.log(
      `[validate] all checks passed (${changedRecipes.length} recipe(s) checked)`,
    );
    return;
  }
  for (const i of issues) console.error(`[fail] ${i.file}: ${i.message}`);
  process.exit(1);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
