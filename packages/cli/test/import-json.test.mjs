/**
 * `harnmem import json` — relaxed contract (aliases, envelopes, JSONL, stdin,
 * per-record unresolved, idempotency, verify and rollback).
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  countMemories,
  isolatedStores,
  readMemoryBodies,
  runCli,
  runCliJson,
  write,
} from "./helpers.mjs";

const ENVELOPE = {
  version: 1,
  kind: "other-app-export",
  memories: [
    {
      name: "Use pnpm in this repo",
      text: "Always use pnpm, not npm; the lockfile is pnpm-lock.yaml.",
      memory_type: "rule",
      scope: "user",
      keywords: ["tooling", "pnpm"],
      created_at: "2026-01-02T03:04:05Z",
    },
    {
      title: "Prefer pnpm over npm",
      body: "npm installs are not used in this repository.",
      type: "preference",
    },
    {
      name: "Migration onboarding is three layers",
      content: "Relaxed JSON contract, deterministic importers, agent recipe.",
      metadata: { type: "decision", created: "2026-01-01" },
    },
    42,
  ],
};

test("json: aliases, envelope, per-record unresolved, apply/verify, idempotency, rollback", async () => {
  const stores = await isolatedStores("json");
  const exportFile = join(stores.root, "export.json");
  await writeFile(exportFile, JSON.stringify(ENVELOPE), "utf8");

  // --- dry-run -----------------------------------------------------------
  const plan = await runCliJson(
    ["import", "json", "--path", exportFile, "--project", stores.root, "--home", stores.home],
    { env: stores.env },
  );
  assert.equal(plan.code, 0, plan.stderr);
  assert.equal(plan.data.dryRun, true);
  assert.equal(plan.data.counts.discovered, 3, "normalizable records count as discovered");
  assert.equal(plan.data.counts.imported, 3);
  assert.equal(plan.data.counts.unresolved, 1, "the corrupt record lands in the unresolved bucket");
  assert.equal(plan.data.byType.feedback, 2); // memory_type: rule + type: preference
  assert.equal(plan.data.byType.project, 1); // metadata.type: decision
  assert.equal(plan.data.byProject.user, 1);
  assert.ok(plan.data.unresolvedKeys.some((key) => key.startsWith("invalid:")), JSON.stringify(plan.data.unresolvedKeys));
  assert.equal(await countMemories(stores.home), 0, "dry-run must not write memories");

  // --- apply + verify ----------------------------------------------------
  const applied = await runCliJson(
    [
      "import",
      "json",
      "--path",
      exportFile,
      "--project",
      stores.root,
      "--home",
      stores.home,
      "--apply",
      "--verify",
    ],
    { env: stores.env },
  );
  assert.equal(applied.code, 0, applied.stderr);
  assert.equal(applied.data.counts.imported, 3);
  assert.equal(applied.data.verify.found, 3);
  assert.equal(applied.data.verify.missing, 0);
  assert.equal(applied.data.verify.sourcesUnchanged, true);
  assert.equal(await countMemories(stores.home), 3);

  // the aliased fields actually reached the store
  const joined = (await readMemoryBodies(stores.home)).join("\n");
  assert.match(joined, /use pnpm, not npm/i, "aliased text/body fields kept");
  assert.match(joined, /Migration onboarding is three layers/, "metadata.* aliases kept");

  // --- second run imports nothing ---------------------------------------
  const again = await runCliJson(
    [
      "import",
      "json",
      "--path",
      exportFile,
      "--project",
      stores.root,
      "--home",
      stores.home,
      "--apply",
    ],
    { env: stores.env },
  );
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.data.counts.imported, 0);
  assert.equal(again.data.counts.skipped, 3);
  assert.equal(await countMemories(stores.home), 3);

  // --- rollback the run that imported the records -----------------------
  const list = await runCliJson(["import", "list", "--home", stores.home], { env: stores.env });
  assert.ok(Array.isArray(list.data));
  const run = list.data.find((ledger) => ledger.counts.imported === 3);
  assert.ok(run, JSON.stringify(list.data));
  const rolledBack = await runCli(["import", "rollback", run.runId, "--home", stores.home], {
    env: stores.env,
  });
  assert.equal(rolledBack.code, 0, rolledBack.stderr);
  assert.equal(await countMemories(stores.home), 0);
});

test("json: JSONL files and stdin (--path -)", async () => {
  const stores = await isolatedStores("jsonl");
  const jsonl = [
    JSON.stringify({ name: "JSONL one", text: "First line record.", scope: "user" }),
    "// a comment line is ignored",
    JSON.stringify({ name: "JSONL two", text: "Second line record.", memory_type: "rule", scope: "user" }),
  ].join("\n");
  const file = join(stores.root, "export.jsonl");
  await writeFile(file, jsonl, "utf8");

  const fromFile = await runCliJson(["import", "json", "--path", file, "--home", stores.home], {
    env: stores.env,
  });
  assert.equal(fromFile.code, 0, fromFile.stderr);
  assert.equal(fromFile.data.counts.discovered, 2);
  assert.equal(fromFile.data.byType.feedback, 1);
  assert.equal(fromFile.data.byType.user, 1);

  const stdinPlan = await runCliJson(["import", "json", "--path", "-", "--home", stores.home], {
    env: stores.env,
    input: jsonl,
  });
  assert.equal(stdinPlan.code, 0, stdinPlan.stderr);
  assert.equal(stdinPlan.data.sourceRoot, "-");
  assert.equal(stdinPlan.data.counts.discovered, 2);

  const stdinApply = await runCliJson(["import", "json", "--path", "-", "--home", stores.home, "--apply"], {
    env: stores.env,
    input: jsonl,
  });
  assert.equal(stdinApply.code, 0, stdinApply.stderr);
  assert.equal(stdinApply.data.counts.imported, 2);
  assert.equal(await countMemories(stores.home), 2);
  // --apply keeps the materialized stdin copy so backup/verify stay meaningful
  const incoming = await readdir(join(stores.home, "imports", "incoming"));
  assert.ok(incoming.some((name) => name.startsWith("stdin-")), JSON.stringify(incoming));
});

test("json: an unparseable file is a usage error and writes nothing", async () => {
  const stores = await isolatedStores("json-bad");
  const file = join(stores.root, "broken.json");
  await writeFile(file, "{ not json", "utf8");

  const result = await runCli(["import", "json", "--path", file, "--home", stores.home], {
    env: stores.env,
  });
  assert.equal(result.code, 2, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /JSON/i);
  assert.equal(existsSync(join(stores.home, "memories")), false);
});
