"""``hermes harnmem`` — operator commands for the HarnMem memory provider.

Hermes discovers this module for the *active* memory provider and wires
``register_cli(subparser)`` into the ``hermes`` CLI (``hermes harnmem …``). The
commands are thin wrappers over the same Node bridge the provider uses, so they
work without a running agent session.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

try:  # Loaded by Hermes as ``<provider package>.cli``
    from . import bridge
    from . import config
except ImportError:  # pragma: no cover - direct execution / unusual loaders
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import bridge  # type: ignore[no-redef]
    import config  # type: ignore[no-redef]


def _config() -> Dict[str, Any]:
    return config.resolve_config(config.load_plugin_block())


def _load_plugin_block() -> Dict[str, Any]:
    return config.load_plugin_block()


def _emit(args: argparse.Namespace, data: Any, *, render) -> int:
    # Bridge/engine failures arrive as {"ok": False, "error": ...}; print the
    # human message instead of rendering an empty result record.
    if isinstance(data, dict) and data.get("ok") is False:
        if getattr(args, "json", False):
            print(json.dumps(data, ensure_ascii=False, indent=2))
        else:
            print(data.get("error") or "harnmem command failed", file=sys.stderr)
        return 1
    if getattr(args, "json", False):
        print(json.dumps(data, ensure_ascii=False, indent=2))
    else:
        text = render(data)
        if text:
            print(text)
    return 0


def _run(command: str, *, read_only: bool, **extra: Any) -> Dict[str, Any]:
    config = _config()
    payload: Dict[str, Any] = {
        "command": command,
        "cwd": os.getcwd(),
        "home": config["home"],
        "readOnly": read_only or bool(config["read_only"]),
        "injectTokens": config["max_inject_tokens"],
        "debug": config["debug"],
    }
    if config.get("project"):
        payload["project"] = config["project"]
    payload.update(extra)
    return bridge.run_bridge(payload)


# --------------------------------------------------------------------- render


def _render_status(data: Dict[str, Any]) -> str:
    lines = [
        f"store:   {data.get('home')}",
        f"project: {data.get('project') or '(none)'}",
    ]
    shards = data.get("shards") or []
    if shards:
        lines.append("shards:")
        for shard in shards:
            lines.append(
                f"  {shard.get('name')}: {shard.get('active', 0)} active / "
                f"{shard.get('total', 0)} total ({shard.get('pinned', 0)} pinned)"
            )
    index = data.get("index") or {}
    lines.append(f"index:       seq {index.get('seq')} (stale: {index.get('stale')})")
    health = data.get("health") or {}
    extraction = data.get("extraction") or {}
    lines.append(f"health:      over-budget={health.get('overBudget')} duplicates={health.get('duplicateCandidates')}")
    lines.append(f"extraction:  pending={extraction.get('pending')} failed={extraction.get('failed')}")
    return "\n".join(lines)


def _render_search(data: Dict[str, Any]) -> str:
    results = data.get("results") or []
    if not results:
        reason = " (abstained: no confident match)" if data.get("abstained") else ""
        return f"no memories matched {data.get('query')!r}{reason}"
    lines = [f"{len(results)} result(s) for {data.get('query')!r}:"]
    for hit in results:
        lines.append(
            f"- [{hit.get('type')}/{hit.get('scope')}] {hit.get('title')} — {hit.get('description')}"
            f"  ({hit.get('id')}, score {hit.get('score')})"
        )
        if hit.get("snippet"):
            lines.append(f"    {hit['snippet']}")
    return "\n".join(lines)


def _render_read(data: Dict[str, Any]) -> str:
    record = data.get("record") or {}
    lines = [
        f"{record.get('title')}  ({record.get('id')})",
        f"  type: {record.get('type')}  scope: {record.get('scope')}  status: {record.get('status')}",
        f"  {record.get('description') or ''}".rstrip(),
    ]
    content = record.get("content")
    if content:
        lines.append("")
        lines.append(str(content))
    tags = record.get("tags") or []
    if tags:
        lines.append(f"\n  tags: {', '.join(tags)}")
    backlinks = data.get("backlinks") or []
    if backlinks:
        lines.append(f"  backlinks: {', '.join(backlinks)}")
    for version in data.get("history") or []:
        lines.append(f"  history: {version.get('id')} ({version.get('status')})")
    return "\n".join(lines)


def _render_write(data: Dict[str, Any]) -> str:
    action = data.get("action") or "NEW"
    line = f"stored {data.get('id')} ({action})"
    superseded = data.get("superseded") or []
    if superseded:
        line += f"; superseded {', '.join(superseded)}"
    warnings = data.get("warnings") or []
    for warning in warnings:
        line += f"\n  warning: {warning}"
    return line


def _render_consolidate(data: Dict[str, Any]) -> str:
    merged = data.get("merged") or []
    lines = [
        f"consolidated {len(merged)} merge(s), archived {len(data.get('archived') or [])}, "
        f"digests {len(data.get('digestsWritten') or [])}, skipped {data.get('skipped', 0)}"
    ]
    if data.get("dryRun"):
        lines.append("  (dry run: nothing was written)")
    return "\n".join(lines)


# -------------------------------------------------------------------- commands


def harnmem_command(args: argparse.Namespace) -> int:
    """Fallback dispatcher when no subcommand was given."""
    func = getattr(args, "func", None)
    if callable(func) and func is not harnmem_command:
        return func(args)
    print("usage: hermes harnmem {status,search,read,write,forget,restore,consolidate,rebuild} [options]", file=sys.stderr)
    return 2


def _cmd_status(args: argparse.Namespace) -> int:
    return _emit(args, _run("status", read_only=True), render=_render_status)


def _cmd_search(args: argparse.Namespace) -> int:
    extra: Dict[str, Any] = {"query": args.query}
    if args.limit:
        extra["limit"] = args.limit
    if args.scope:
        extra["scope"] = args.scope
    return _emit(args, _run("search", read_only=True, **extra), render=_render_search)


def _cmd_read(args: argparse.Namespace) -> int:
    extra: Dict[str, Any] = {"id": args.id}
    if args.history:
        extra["includeHistory"] = True
    return _emit(args, _run("read", read_only=True, **extra), render=_render_read)


def _read_content(args: argparse.Namespace) -> str:
    if args.content is not None and args.content_file is not None:
        raise SystemExit("pass either --content or --content-file, not both")
    if args.content_file is not None:
        if args.content_file == "-":
            return sys.stdin.read()
        return Path(args.content_file).read_text(encoding="utf-8")
    return args.content or ""


def _cmd_write(args: argparse.Namespace) -> int:
    content = _read_content(args)
    if not content.strip():
        print("content is empty; pass --content or --content-file", file=sys.stderr)
        return 2
    extra: Dict[str, Any] = {
        "input": {
            "type": args.type,
            "title": args.title,
            "description": args.description,
            "content": content,
            "source": {"harness": "hermes"},
        }
    }
    if args.tags:
        extra["input"]["tags"] = [tag.strip() for tag in args.tags.split(",") if tag.strip()]
    if args.scope:
        extra["input"]["scope"] = args.scope
    if args.importance is not None:
        extra["input"]["importance"] = args.importance
    return _emit(args, _run("write", read_only=False, **extra), render=_render_write)


def _cmd_forget(args: argparse.Namespace) -> int:
    extra: Dict[str, Any] = {"id": args.id}
    if args.hard:
        extra["hard"] = True
    return _emit(
        args,
        _run("forget", read_only=False, **extra),
        render=lambda data: f"forgot {data.get('id')} ({data.get('mode', 'trash')})",
    )


def _cmd_restore(args: argparse.Namespace) -> int:
    return _emit(
        args,
        _run("restore", read_only=False, id=args.id),
        render=lambda data: f"restored {data.get('id')}" if data.get("ok") else f"could not restore {data.get('id')}",
    )


def _cmd_consolidate(args: argparse.Namespace) -> int:
    extra: Dict[str, Any] = {}
    if args.dry_run:
        extra["dryRun"] = True
    if args.mechanical_only:
        extra["mechanicalOnly"] = True
    return _emit(args, _run("consolidate", read_only=False, **extra), render=_render_consolidate)


def _cmd_rebuild(args: argparse.Namespace) -> int:
    return _emit(args, _run("rebuild", read_only=False), render=lambda data: "index rebuilt")


def register_cli(subparser: argparse.ArgumentParser) -> None:
    """Add ``hermes harnmem`` subcommands (called by the Hermes CLI factory)."""
    subparser.set_defaults(func=harnmem_command)
    subs = subparser.add_subparsers(dest="harnmem_action", metavar="<action>")

    status = subs.add_parser("status", help="show store health")
    status.set_defaults(func=_cmd_status)

    search = subs.add_parser("search", help="search stored memories")
    search.add_argument("query")
    search.add_argument("--limit", type=int, default=8)
    search.add_argument("--scope", choices=["user", "project"])
    search.set_defaults(func=_cmd_search)

    read = subs.add_parser("read", help="read one memory by id")
    read.add_argument("id")
    read.add_argument("--history", action="store_true", help="include superseded versions")
    read.set_defaults(func=_cmd_read)

    write = subs.add_parser("write", help="store a memory")
    write.add_argument("--type", required=True, choices=["user", "feedback", "project", "reference"])
    write.add_argument("--title", required=True)
    write.add_argument("--description", required=True)
    write.add_argument("--content")
    write.add_argument("--content-file", help="read the body from a file, or '-' for stdin")
    write.add_argument("--tags", help="comma-separated tags")
    write.add_argument("--scope", choices=["user", "project", "auto"])
    write.add_argument("--importance", type=int)
    write.set_defaults(func=_cmd_write)

    forget = subs.add_parser("forget", help="move a memory to trash (or delete it)")
    forget.add_argument("id")
    forget.add_argument("--hard", action="store_true", help="delete permanently")
    forget.set_defaults(func=_cmd_forget)

    restore = subs.add_parser("restore", help="restore a trashed memory")
    restore.add_argument("id")
    restore.set_defaults(func=_cmd_restore)

    consolidate = subs.add_parser("consolidate", help="merge duplicates and archive cold memories")
    consolidate.add_argument("--dry-run", action="store_true")
    consolidate.add_argument("--mechanical-only", action="store_true", help="skip LLM-assisted passes")
    consolidate.set_defaults(func=_cmd_consolidate)

    rebuild = subs.add_parser("rebuild", help="rebuild the BM25 index from plain files")
    rebuild.set_defaults(func=_cmd_rebuild)

    for parser in (status, search, read, write, forget, restore, consolidate, rebuild):
        parser.add_argument("--json", action="store_true", help="print raw JSON")


# Hermes resolves ``<provider>_command`` with getattr(); the manifest and the
# documented install directory are ``harnmem``. The alias keeps the lookup
# working when a profile installs the plugin under another directory name.
setattr(sys.modules[__name__], "harnmem_command", harnmem_command)


def __getattr__(name: str):
    """Fallback for ``getattr(module, f"{provider}_command")`` with odd names."""
    if name.endswith("_command"):
        return harnmem_command
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
