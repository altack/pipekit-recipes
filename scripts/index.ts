#!/usr/bin/env bun
import { readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "yaml";

const ROOT = process.cwd();
const TOKEN = process.env.GITHUB_TOKEN ?? "";
const OUT = process.env.OUT ?? join(ROOT, "index.json");
const CACHE = process.env.CACHE ?? "";
const SELF_REPO = process.env.GITHUB_REPOSITORY ?? "altack/pipekit-recipes";
const SELF_REF = process.env.GITHUB_REF_NAME ?? "main";
const SELF_SHA = process.env.GITHUB_SHA ?? "HEAD";

interface RecipeYaml {
  name: string;
  version: string;
  description: string;
  homepage?: string;
  tags?: string[];
  agents?: { preferred?: string[] };
  requires?: { env?: string[]; mounts?: string[] };
  inputs?: { schema?: unknown };
}

interface IndexEntry {
  id: string;
  org: string;
  name: string;
  version: string;
  description: string;
  homepage?: string;
  tags: string[];
  agents_preferred: string[];
  requires: { env: string[]; mounts: string[] };
  inputs_schema: unknown;
  source: { repo: string; path: string; ref: string; sha: string };
  links: { recipe_yaml: string; prompt_md: string; tree: string };
}

interface PublisherIn {
  org: string;
  repo: string;
  ref?: string;
  homepage?: string;
}

interface PublisherOut {
  org: string;
  repo: string;
  ref: string;
  sha: string;
  canonical: boolean;
  homepage?: string;
}

interface IndexFile {
  generated_at: string;
  indexer_version: string;
  publishers: PublisherOut[];
  recipes: IndexEntry[];
}

async function gh(path: string): Promise<any> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "pipekit-indexer",
  };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  const r = await fetch(`https://api.github.com${path}`, { headers });
  if (!r.ok) throw new Error(`gh ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function* walk(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

function rawUrl(repo: string, sha: string, path: string): string {
  return `https://raw.githubusercontent.com/${repo}/${sha}/${path}`;
}

function treeUrl(repo: string, sha: string, path: string): string {
  return `https://github.com/${repo}/tree/${sha}/${path}`;
}

function entryFromYaml(
  yaml: RecipeYaml,
  repo: string,
  ref: string,
  sha: string,
  path: string,
): IndexEntry {
  const parts = path.split("/");
  const org = parts[1]!;
  const name = parts[2]!;
  const dir = `recipes/${org}/${name}`;
  return {
    id: `@${org}/${name}`,
    org,
    name,
    version: yaml.version,
    description: yaml.description,
    ...(yaml.homepage ? { homepage: yaml.homepage } : {}),
    tags: yaml.tags ?? [],
    agents_preferred: yaml.agents?.preferred ?? [],
    requires: {
      env: yaml.requires?.env ?? [],
      mounts: yaml.requires?.mounts ?? [],
    },
    inputs_schema: yaml.inputs?.schema ?? null,
    source: { repo, path: dir, ref, sha },
    links: {
      recipe_yaml: rawUrl(repo, sha, `${dir}/recipe.yaml`),
      prompt_md: rawUrl(repo, sha, `${dir}/prompt.md`),
      tree: treeUrl(repo, sha, dir),
    },
  };
}

function looksLikeRecipe(y: unknown): y is RecipeYaml {
  if (!y || typeof y !== "object") return false;
  const r = y as Record<string, unknown>;
  return (
    typeof r.name === "string" &&
    typeof r.version === "string" &&
    typeof r.description === "string"
  );
}

async function indexLocal(): Promise<{
  entry: PublisherOut;
  recipes: IndexEntry[];
}> {
  const recipesDir = join(ROOT, "recipes");
  const recipes: IndexEntry[] = [];
  for await (const file of walk(recipesDir)) {
    if (!file.endsWith("/recipe.yaml")) continue;
    const rel = relative(ROOT, file).replaceAll("\\", "/");
    const text = await readFile(file, "utf8");
    let y: unknown;
    try {
      y = parse(text);
    } catch (e) {
      console.warn(`[skip] ${rel}: invalid YAML (${(e as Error).message})`);
      continue;
    }
    if (!looksLikeRecipe(y)) {
      console.warn(`[skip] ${rel}: missing required fields`);
      continue;
    }
    recipes.push(entryFromYaml(y, SELF_REPO, SELF_REF, SELF_SHA, rel));
  }
  return {
    entry: {
      org: "pipekit",
      repo: SELF_REPO,
      ref: SELF_REF,
      sha: SELF_SHA,
      canonical: true,
    },
    recipes,
  };
}

async function indexPublisher(
  pub: PublisherIn,
  cached: IndexFile | null,
): Promise<{ entry: PublisherOut; recipes: IndexEntry[] }> {
  const ref = pub.ref ?? "main";
  const commit = await gh(`/repos/${pub.repo}/commits/${ref}`);
  const sha: string = commit.sha;

  const prev = cached?.publishers.find((p) => p.repo === pub.repo);
  if (prev?.sha === sha) {
    const existing = cached!.recipes.filter((r) => r.source.repo === pub.repo);
    console.log(
      `[cache hit] ${pub.repo}@${sha.slice(0, 7)}: ${existing.length} recipes`,
    );
    return {
      entry: {
        org: pub.org,
        repo: pub.repo,
        ref,
        sha,
        canonical: false,
        ...(pub.homepage ? { homepage: pub.homepage } : {}),
      },
      recipes: existing,
    };
  }

  const tree = await gh(
    `/repos/${pub.repo}/git/trees/${sha}?recursive=1`,
  );
  const recipeYamlPaths: string[] = (tree.tree as Array<{ path: string }>)
    .map((n) => n.path)
    .filter((p) => /^recipes\/[^/]+\/[^/]+\/recipe\.yaml$/.test(p));

  const recipes: IndexEntry[] = [];
  for (const path of recipeYamlPaths) {
    const file = await gh(
      `/repos/${pub.repo}/contents/${path}?ref=${sha}`,
    );
    const text = Buffer.from(file.content, "base64").toString("utf8");
    let y: unknown;
    try {
      y = parse(text);
    } catch (e) {
      console.warn(`[skip] ${pub.repo}:${path}: invalid YAML`);
      continue;
    }
    if (!looksLikeRecipe(y)) {
      console.warn(`[skip] ${pub.repo}:${path}: missing required fields`);
      continue;
    }
    const pathOrg = path.split("/")[1];
    if (pathOrg !== pub.org) {
      console.warn(
        `[skip] ${pub.repo}:${path}: org mismatch (path=${pathOrg}, registered=${pub.org})`,
      );
      continue;
    }
    recipes.push(entryFromYaml(y, pub.repo, ref, sha, path));
  }
  console.log(
    `[fetch] ${pub.repo}@${sha.slice(0, 7)}: ${recipes.length} recipes`,
  );
  return {
    entry: {
      org: pub.org,
      repo: pub.repo,
      ref,
      sha,
      canonical: false,
      ...(pub.homepage ? { homepage: pub.homepage } : {}),
    },
    recipes,
  };
}

async function main(): Promise<void> {
  let cached: IndexFile | null = null;
  if (CACHE && existsSync(CACHE)) {
    try {
      cached = JSON.parse(await readFile(CACHE, "utf8")) as IndexFile;
      console.log(
        `[cache] loaded ${cached.recipes.length} recipes from ${CACHE}`,
      );
    } catch (e) {
      console.warn(`[cache] failed to load ${CACHE}: ${e}`);
    }
  }

  const local = await indexLocal();

  const publishersText = await readFile(
    join(ROOT, "publishers.yaml"),
    "utf8",
  );
  const publishersYaml = parse(publishersText) as
    | { publishers?: PublisherIn[] }
    | null;
  const externalPubs: PublisherIn[] = publishersYaml?.publishers ?? [];

  const publishers: PublisherOut[] = [local.entry];
  const recipes: IndexEntry[] = [...local.recipes];

  for (const pub of externalPubs) {
    try {
      const result = await indexPublisher(pub, cached);
      publishers.push(result.entry);
      recipes.push(...result.recipes);
    } catch (e) {
      console.error(`[error] ${pub.repo}: ${(e as Error).message}`);
    }
  }

  const index: IndexFile = {
    generated_at: new Date().toISOString(),
    indexer_version: "1",
    publishers,
    recipes,
  };

  await writeFile(OUT, JSON.stringify(index, null, 2));
  console.log(
    `[done] wrote ${recipes.length} recipes from ${publishers.length} publishers to ${OUT}`,
  );
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
