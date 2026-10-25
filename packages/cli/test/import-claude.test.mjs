/**
 * `harnmem import claude` — Claude Code memory files under
 * `$CLAUDE_CONFIG_DIR/projects/<slug>/` plus the legacy `memory/` directory.
 * Project attribution is recovered from the session JSONL `cwd`.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { countMemories, isolatedStores, runCliJson, write } from "./helpers.mjs";

async function makeClaudeStore(stores) {
  const root = stores.claude;
  const projectDir = join(root, "projects", "-Users-me-proj-a");
  await write(
    join(projectDir, "MEMORY.md"),
    [
      "# Memory index",
      "",
      "- [Release gate](alpha.md) 📌 — Run the gate before tagging",
      "",
    ].join("\n"),
  );
  await write(
    join(projectDir, "alpha.md"),
    [
      "---",
      "name: Release gate",
      "description: Tag only after the release gate passes",
      "metadata:",
      "  type: feedback",
      "---",
      "",
      "# Release gate",
      "",
      "Run the gate before tagging; do not skip it for hotfixes.",
    ].join("\n"),
  );
  await write(
    join(projectDir, "memory", "beta.md"),
    ["# Deploy window", "", "Deploy on Tuesdays only."].join("\n"),
  );
  await write(
    join(projectDir, "session-1.jsonl"),
    [
      JSON.stringify({ type: "summary", summary: "no cwd here" }),
      JSON.stringify({ type: "user", cwd: join(stores.root, "work", "proj-a") }),
    ].join("\n"),
  );

  // No session log and no --path-map: cannot be attributed.
  await write(
    join(root, "projects", "-Users-me-unknown", "gamma.md"),
    ["# Unknown project note", "", "Nothing ties this to a repository."].join("\n"),
  );

  // Legacy store: always user scope.
  await write(
    join(root, "memory", "legacy-note.md"),
    ["# Legacy preference", "", "Always answer in the user's language."].join("\n"),
  );
  return { root, projectDir };
}

test("claude: imports project + legacy memory, recovers cwd, buckets unknown projects", async () => {
  const stores = await isolatedStores("claude");
  await makeClaudeStore(stores);

  const plan = await runCliJson(["import", "claude", "--home", stores.home], { env: stores.env });
  assert.equal(plan.code, 0, plan.stderr);
  assert.equal(plan.data.counts.discovered, 3);
  assert.equal(plan.data.counts.unresolved, 1);
  assert.equal(plan.data.byType.feedback, 1, "metadata.type: feedback must win over the default");
  assert.equal(await countMemories(stores.home), 0);

  // The two project records share the cwd-recovered project id; legacy is user scope.
  const projectIds = Object.keys(plan.data.byProject);
  assert.equal(projectIds.filter((id) => id !== "user").length, 1, JSON.stringify(plan.data.byProject));
  assert.equal(plan.data.byProject.user, 1);

  const applied = await runCliJson(["import", "claude", "--home", stores.home, "--apply", "--verify"], {
    env: stores.env,
  });
  assert.equal(applied.code, 0, applied.stderr);
  assert.equal(applied.data.counts.imported, 3);
  assert.equal(applied.data.verify.found, 3);
  assert.equal(applied.data.verify.sourcesUnchanged, true);
  assert.equal(await countMemories(stores.home), 3);

  // MEMORY.md is an index only — it must not produce a memory of its own
  // (3 imported = alpha + memory/beta + legacy note; gamma went to unresolved).
  const unresolved = await runCliJson(["import", "unresolved", "--home", stores.home], {
    env: stores.env,
  });
  assert.equal(unresolved.code, 0, unresolved.stderr);
  assert.equal(unresolved.data.length, 1, JSON.stringify(unresolved.data));
  assert.match(unresolved.data[0].key, /Users-me-unknown/);
  assert.equal(unresolved.data[0].count, 1);

  // Idempotent in place.
  const again = await runCliJson(["import", "claude", "--home", stores.home, "--apply"], {
    env: stores.env,
  });
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.data.counts.imported, 0);
  assert.equal(again.data.counts.skipped, 3);
  assert.equal(await countMemories(stores.home), 3);
});
