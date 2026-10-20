# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |

HarnMem is at an early stage. Security fixes land on `main` and in the newest
release; there are no long-term support branches yet.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's
private vulnerability reporting on the repository (the **Security** tab ->
**Report a vulnerability**) so the maintainers can coordinate a fix and a
disclosure date with you.

Include:

- affected version/commit and harness (pi, CLI, core),
- a minimal reproduction (memory files, config, command line),
- impact assessment (data leak across scopes/projects, path traversal, secret
  exposure, code execution through a crafted store, ...),
- any suggested mitigation.

We aim to acknowledge reports within 7 days and to ship a fix or mitigation
within 30 days for confirmed issues. Credit is given in the release notes
unless you prefer to stay anonymous.

## Scope

HarnMem is a **local, file-native** memory system: it does not listen on a
network port, does not call home, and does not require an external service.
The most relevant classes of issues are:

- **Crafted memory stores**: path traversal, symlink tricks, oversized or
  malformed frontmatter, YAML edge cases, or escaping a project scope.
- **Secret and PII leakage**: memory entries or session journals containing
  credentials, tokens, or personal data that end up in injected context,
  logs, exports, or model prompts.
- **Prompt-injection persistence**: content that a model is tricked into
  writing into memory and that later steers another harness.
- **Cross-scope leakage**: user-scope memories leaking into project contexts,
  or one project's memories being retrieved in another project.
- **Supply chain**: dependencies (the core engine and CLI intentionally have
  zero runtime dependencies beyond Node.js built-ins), install scripts, and
  release provenance.

## Design mitigations already in place

- Local-only operation with no telemetry and no network calls in the core
  engine and CLI.
- Plain Markdown/JSON files under `~/.harnmem/` as the single source of truth;
  indexes are derived and rebuildable.
- Path validation, symlink rejection, and containment checks when reading
  memory files.
- Sensitive-content detection and redaction before writing a memory; entry
  size caps (`maxBodyBytes`) and per-scope capacity limits.
- Soft delete via `trash/` with a restore path, plus an append-only
  `state/audit.jsonl` for write/injection events.
- The pi adapter snapshots injected context per session and isolates
  read-only subagents.

## Operator guidance

A memory home is personal data. Back it up, keep it out of version control
(the repository `.gitignore` ignores `.harnmem/`), and do not paste secrets
into conversations you expect to be remembered. If you migrate a legacy store,
run `harnmem import ... --dry-run` first; `--apply` backs up the source before
writing.
