import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { HarnMem } from "../dist/index.js";

const roots = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function fresh(harness = "dsh") {
  const root = await mkdtemp(join(tmpdir(), "harnmem-journal-"));
  roots.push(root);
  const home = join(root, "home");
  const cwd = join(root, "work", "proj");
  const eng = await HarnMem.open({ harness, cwd, home, project: "proj", autoExtract: false });
  return { root, home, cwd, eng };
}

function dayStamp(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

test("session journal round-trips and de-duplicates re-persisted snapshots", async () => {
  const { eng } = await fresh();
  const messages = [
    { role: "user", text: "remember: pnpm only", ts: 1 },
    { role: "assistant", text: "Noted.", ts: 2 },
    { role: "user", text: "remember: no npm", ts: 3 },
  ];
  await eng.sessionEnd({ sessionId: "sess-1", messages });
  const first = await eng.readSessionJournal("sess-1");
  assert.deepEqual(
    first.map((message) => [message.role, message.text, message.ts]),
    [
      ["user", "remember: pnpm only", 1],
      ["assistant", "Noted.", 2],
      ["user", "remember: no npm", 3],
    ],
  );

  // A restarted process re-persists the hydrated snapshot; the journal must not
  // grow duplicate lines (N2 quit path appends on every dispose).
  await eng.sessionEnd({ sessionId: "sess-1", messages });
  const second = await eng.readSessionJournal("sess-1");
  assert.equal(second.length, 3);
  assert.deepEqual(
    second.map((message) => message.text),
    ["remember: pnpm only", "Noted.", "remember: no npm"],
  );
});

test("journal reader merges day directories, orders by timestamp and dedupes", async () => {
  const { home, eng } = await fresh();
  const dirA = join(home, "sessions", "20260101");
  const dirB = join(home, "sessions", "20260102");
  await mkdir(dirA, { recursive: true });
  await mkdir(dirB, { recursive: true });
  const lines = (entries) => entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  await writeFile(
    join(dirA, "dsh_sess-2.jsonl"),
    lines([
      { ts: 30, role: "user", text: "later in file but newest", cwd: "/w" },
      { ts: 10, role: "user", text: "oldest", cwd: "/w" },
    ]),
  );
  await writeFile(
    join(dirB, "dsh_sess-2.jsonl"),
    lines([
      { ts: 20, role: "assistant", text: "middle", cwd: "/w" },
      { ts: 30, role: "user", text: "later in file but newest", cwd: "/w" },
    ]),
  );
  const messages = await eng.readSessionJournal("sess-2");
  assert.deepEqual(
    messages.map((message) => message.text),
    ["oldest", "middle", "later in file but newest"],
  );
  // Unrelated sessions and harnesses are not mixed in.
  assert.equal((await eng.readSessionJournal("other-session")).length, 0);
});

test("journal reader tolerates malformed lines and bounds to 200 messages", async () => {
  const { home, eng } = await fresh();
  const dir = join(home, "sessions", dayStamp(Date.now()));
  await mkdir(dir, { recursive: true });
  const lines = ["not json at all"];
  for (let i = 0; i < 205; i += 1) {
    lines.push(JSON.stringify({ ts: i + 1, role: "user", text: `message ${i}`, cwd: "/w" }));
  }
  await writeFile(join(dir, "dsh_sess-3.jsonl"), `${lines.join("\n")}\n`);
  const messages = await eng.readSessionJournal("sess-3");
  assert.equal(messages.length, 200);
  assert.equal(messages[0].text, "message 5");
  assert.equal(messages[199].text, "message 204");
});

test("journal reader tolerates a leading UTF-8 BOM", async () => {
  const { home, eng } = await fresh();
  const dir = join(home, "sessions", dayStamp(Date.now()));
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "dsh_sess-bom.jsonl"),
    `\uFEFF${JSON.stringify({ ts: 1, role: "user", text: "first" })}\n${JSON.stringify({ ts: 2, role: "user", text: "second" })}\n`,
  );
  const messages = await eng.readSessionJournal("sess-bom");
  assert.equal(messages.length, 2);
  assert.equal(messages[0].text, "first");
});
