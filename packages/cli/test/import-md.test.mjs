/**
 * `harnmem import md` — arbitrary Markdown trees in `file` and `heading` modes,
 * frontmatter mapping, host-file skipping and git-repository attribution.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { countMemories, isolatedStores, readMemoryBodies, runCliJson, write } from "./helpers.mjs";

async function makeVault(stores) {
  const vault = join(stores.root, "vault");
  await write(
    join(vault, "notes", "alpha.md"),
    [
      "---",
      'title: "Release checklist"',
      "type: rule",
      "tags: [release, process]",
      "created: 2026-01-03",
      "---",
      "",
      "# Release checklist",
      "",
      "Tag, build, run the CLI tests, then publish.",
    ].join("\n"),
  );
  await write(
    join(vault, "notes", "beta.md"),
    [
      "# Beta notes",
      "",
      "Intro paragraph kept as the preamble of heading mode.",
      "",
      "## Deployment",
      "",
      "Deploy from the release branch only.",
      "",
      "## Rollback",
      "",
      "Roll back by re-pointing the tag; never hotfix in main.",
    ].join("\n"),
  );
  await write(
    join(vault, "decisions", "adr-001.md"),
    ["---", "type: decision", "---", "", "# Use pnpm", "", "One package manager, one lockfile."].join("\n"),
  );
  await write(join(vault, "rules", "style.md"), "# Style rules\n\nPrefer small commits.\n");
  await write(join(vault, "repo", ".git", "HEAD"), "ref: refs/heads/main\n");
  await write(join(vault, "repo", "doc.md"), "# Repo doc\n\nThis file belongs to a git repository.\n");
  await write(join(vault, "CLAUDE.md"), "# Host instructions\n\nInjected by the host, not imported.\n");
  await write(join(vault, "MEMORY.md"), "# Index\n\n- [Release checklist](notes/alpha.md)\n");
  await write(join(vault, ".obsidian", "ignored.md"), "# Internal Obsidian state\n");
  await write(join(vault, "nested", "plain.txt"), "Plain text note about deployment windows.\n");
  return vault;
}

test("md: file mode discovers records, skips host files, attributes git repos", async () => {
  const stores = await isolatedStores("md");
  const vault = await makeVault(stores);

  const plan = await runCliJson(["import", "md", "--path", vault, "--home", stores.home], {
    env: stores.env,
  });
  assert.equal(plan.code, 0, plan.stderr);
  assert.equal(plan.data.counts.discovered, 6);
  assert.equal(plan.data.byType.feedback, 2); // frontmatter rule + rules/ path hint
  assert.equal(plan.data.byType.project, 1); // frontmatter decision
  assert.equal(plan.data.byType.reference, 3); // beta, repo doc, plain txt
  assert.equal(await countMemories(stores.home), 0);

  const warnings = plan.data.warnings.join("\n");
  assert.match(warnings, /host\/instruction file/);
  assert.match(warnings, /no git repository/);

  // one project (the nested git repo), everything else is user scope
  const projects = Object.keys(plan.data.byProject);
  assert.equal(projects.length, 2, JSON.stringify(plan.data.byProject));

  // --- apply + idempotency ---------------------------------------------
  const applied = await runCliJson(["import", "md", "--path", vault, "--home", stores.home, "--apply"], {
    env: stores.env,
  });
  assert.equal(applied.code, 0, applied.stderr);
  assert.equal(applied.data.counts.imported, 6);
  assert.equal(await countMemories(stores.home), 6);

  const again = await runCliJson(["import", "md", "--path", vault, "--home", stores.home, "--apply"], {
    env: stores.env,
  });
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.data.counts.imported, 0);
  assert.equal(again.data.counts.skipped, 6);

  const memories = await readMemoryBodies(stores.home);
  const joined = memories.join("\n");
  assert.match(joined, /Release checklist/);
  assert.match(joined, /One package manager, one lockfile/);
});

test("md: heading mode splits on H1/H2 and --include-all opts host files in", async () => {
  const stores = await isolatedStores("md-heading");
  const vault = await makeVault(stores);

  const heading = await runCliJson(
    ["import", "md", "--path", vault, "--mode", "heading", "--home", stores.home],
    { env: stores.env },
  );
  assert.equal(heading.code, 0, heading.stderr);
  // alpha 1 + beta 3 (preamble + 2 sections) + adr 1 + style 1 + repo doc 1 + txt 1
  assert.equal(heading.data.counts.discovered, 8);

  const includeAll = await runCliJson(
    ["import", "md", "--path", vault, "--include-all", "--home", stores.home],
    { env: stores.env },
  );
  assert.equal(includeAll.code, 0, includeAll.stderr);
  assert.equal(includeAll.data.counts.discovered, 8);
  assert.doesNotMatch(includeAll.data.warnings.join("\n"), /host\/instruction file/);

  const applied = await runCliJson(
    ["import", "md", "--path", vault, "--mode", "heading", "--home", stores.home, "--apply"],
    { env: stores.env },
  );
  assert.equal(applied.code, 0, applied.stderr);
  assert.equal(applied.data.counts.imported, 8);
  assert.equal(await countMemories(stores.home), 8);

  const memories = await readMemoryBodies(stores.home);
  const joined = memories.join("\n");
  assert.match(joined, /Deploy from the release branch only/);
  assert.match(joined, /Roll back by re-pointing the tag/);
});
