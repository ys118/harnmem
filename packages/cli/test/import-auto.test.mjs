/**
 * `harnmem import auto` — probes the known memory stores, prints a plan, imports
 * each source as its own run/ledger, and refuses to apply non-interactively
 * without --yes.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { countMemories, isolatedStores, runCli, runCliJson, write } from "./helpers.mjs";

async function makeStores(stores) {
  // pi: MEMORY.md blocks (user scope) + a daily note that cannot be attributed.
  await write(
    join(stores.pi, "memory", "MEMORY.md"),
    [
      "<!-- 2026-01-02 03:04:05 [a1b2c3d4] -->",
      "",
      "## Use pnpm",
      "",
      "Always use pnpm in this repository.",
      "",
      "<!-- 2026-01-03 06:07:08 [b2c3d4e5] -->",
      "",
      "## Answer language",
      "",
      "Answer in the user's language.",
      "",
    ].join("\n"),
  );
  await write(
    join(stores.pi, "memory", "daily", "2026-01-04.md"),
    ["<!-- 2026-01-04 10:11:12 [deadbeef] -->", "", "Deployment window is Tuesday.", ""].join("\n"),
  );

  // claude: one attributed project note (session JSONL cwd) + one legacy note.
  const projectDir = join(stores.claude, "projects", "-Users-me-demo");
  await write(join(projectDir, "note.md"), ["# Demo rule", "", "Keep changes small."].join("\n"));
  await write(
    join(projectDir, "session-1.jsonl"),
    JSON.stringify({ type: "user", cwd: join(stores.root, "work", "demo") }),
  );
  await write(
    join(stores.claude, "memory", "legacy.md"),
    ["# Legacy preference", "", "Prefer short answers."].join("\n"),
  );
}

test("auto: plan, non-TTY guard, per-source runs, idempotency and per-source rollback", async () => {
  const stores = await isolatedStores("auto");
  await makeStores(stores);

  // --- plan ------------------------------------------------------------
  const plan = await runCliJson(["import", "auto", "--home", stores.home], { env: stores.env });
  assert.equal(plan.code, 0, plan.stderr);
  assert.equal(plan.data.dryRun, true);
  assert.equal(plan.data.totals.sources, 2, JSON.stringify(plan.data.sources));
  const bySource = Object.fromEntries(plan.data.sources.map((row) => [row.source, row]));
  assert.deepEqual(Object.keys(bySource).sort(), ["claude", "pi"]);
  assert.equal(bySource.pi.discovered, 3);
  assert.equal(bySource.pi.unresolved, 1);
  assert.equal(bySource.claude.discovered, 2);
  assert.equal(bySource.claude.unresolved, 0);
  assert.equal(plan.data.totals.discovered, 5);
  assert.equal(await countMemories(stores.home), 0);

  // --- non-TTY apply requires --yes ------------------------------------
  const refused = await runCli(["import", "auto", "--home", stores.home, "--apply"], { env: stores.env });
  assert.equal(refused.code, 2, `${refused.stdout}\n${refused.stderr}`);
  assert.match(refused.stderr, /needs --yes/);
  assert.equal(await countMemories(stores.home), 0);

  // --- apply --yes: one run/ledger per source --------------------------
  const applied = await runCliJson(["import", "auto", "--home", stores.home, "--apply", "--yes"], {
    env: stores.env,
  });
  assert.equal(applied.code, 0, applied.stderr);
  assert.equal(applied.data.dryRun, false);
  assert.equal(applied.data.sources.length, 2);
  const appliedBySource = Object.fromEntries(
    applied.data.sources.map((report) => [report.harness, report]),
  );
  assert.equal(appliedBySource.pi.counts.imported, 2);
  assert.equal(appliedBySource.claude.counts.imported, 2);
  assert.equal(applied.data.totals.imported, 4);
  assert.equal(applied.data.totals.errors, 0);
  assert.equal(applied.data.failed, false);
  assert.notEqual(appliedBySource.pi.runId, appliedBySource.claude.runId);
  assert.equal(await countMemories(stores.home), 4);

  const ledgers = await runCliJson(["import", "list", "--home", stores.home], { env: stores.env });
  assert.equal(ledgers.code, 0, ledgers.stderr);
  assert.equal(ledgers.data.length, 2);
  assert.deepEqual(
    ledgers.data.map((ledger) => ledger.harness).sort(),
    ["claude", "pi"],
  );

  // --- rerun imports nothing -------------------------------------------
  const again = await runCliJson(["import", "auto", "--home", stores.home, "--apply", "--yes"], {
    env: stores.env,
  });
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.data.totals.imported, 0);
  assert.equal(again.data.totals.skipped, 4);
  assert.equal(await countMemories(stores.home), 4);

  // --- rollback one source leaves the other alone ----------------------
  const piRun = ledgers.data.find((ledger) => ledger.harness === "pi");
  const rolledBack = await runCli(["import", "rollback", piRun.runId, "--home", stores.home], {
    env: stores.env,
  });
  assert.equal(rolledBack.code, 0, rolledBack.stderr);
  assert.equal(await countMemories(stores.home), 2, "only the claude records remain");
});
