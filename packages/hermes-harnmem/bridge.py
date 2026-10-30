"""Subprocess bridge between the Hermes memory provider and @harnmem/core.

Hermes memory providers are Python; the HarnMem engine is Node/TypeScript. This
module owns the whole boundary: locating a suitable Node.js runtime, building
the child environment, running one command per process, and normalising bridge
output into Python dicts.

Design rules:

* fail-soft — every helper returns a ``dict`` instead of raising whenever
  possible. A broken memory backend must never break the host conversation;
* one process per command — no long-lived engine process to leak or corrupt;
* stdout belongs to JSON — engine diagnostics go to stderr only.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

logger = logging.getLogger(__name__)

_PLUGIN_DIR = Path(__file__).resolve().parent
BRIDGE_SCRIPT = _PLUGIN_DIR / "lib" / "bridge.mjs"
VENDOR_ENTRY = _PLUGIN_DIR / "vendor" / "core" / "index.js"

#: Hermes accepts ``node --version`` output from v22.15.0 onward (matches
#: @harnmem/cli engines and the vendored core build target).
MIN_NODE: Tuple[int, int] = (22, 15)
NODE_PROBE_TIMEOUT_S = 5.0

#: Session-end payloads are handed to a detached bridge process; the bridge
#: deletes the file it reads. Files that survive a crash are swept once older
#: than this.
PAYLOAD_DIR = Path(tempfile.gettempdir()) / "harnmem-hermes"
PAYLOAD_TTL_S = 3600
#: Guard against pathological transcripts: the engine only needs the tail of a
#: session, and a multi-megabyte stdin risks platform pipe limits.
MAX_PAYLOAD_BYTES = 8 * 1024 * 1024

#: memory_manager gives external providers 8s for a synchronous prefetch; stay
#: just inside that so Hermes logs a timeout we caused rather than its own.
DEFAULT_CONTEXT_TIMEOUT_S = 7.0
DEFAULT_TOOL_TIMEOUT_S = 20.0

_node_lock = threading.Lock()
_cached_node: Optional[str] = None
_cached_node_version = ""


def _candidate_nodes() -> list[str]:
    candidates: list[str] = []
    override = os.environ.get("HARNMEM_NODE", "").strip()
    if override:
        candidates.append(override)
    found = shutil.which("node")
    if found:
        candidates.append(found)
    if os.name == "nt":
        program_files = os.environ.get("ProgramFiles", r"C:\Program Files")
        local_app_data = os.environ.get("LOCALAPPDATA", "")
        candidates.append(os.path.join(program_files, "nodejs", "node.exe"))
        if local_app_data:
            candidates.append(os.path.join(local_app_data, "Programs", "nodejs", "node.exe"))
    else:
        candidates.extend(["/usr/local/bin/node", "/usr/bin/node", "/opt/homebrew/bin/node"])
    seen: set[str] = set()
    unique: list[str] = []
    for candidate in candidates:
        if candidate and candidate not in seen:
            seen.add(candidate)
            unique.append(candidate)
    return unique


def _probe_node(binary: str) -> Optional[str]:
    """Return the version string of ``binary`` when it is Node >= MIN_NODE."""
    try:
        result = subprocess.run(
            [binary, "--version"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=NODE_PROBE_TIMEOUT_S,
            stdin=subprocess.DEVNULL,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    raw = (result.stdout or "").strip().lstrip("v")
    match = raw.split(".")
    if result.returncode != 0 or len(match) < 2:
        return None
    try:
        version = (int(match[0]), int(match[1]))
    except ValueError:
        return None
    if version < MIN_NODE:
        return None
    return raw


def resolve_node(*, force: bool = False) -> Optional[str]:
    """Locate a Node.js binary once per process (thread-safe)."""
    global _cached_node, _cached_node_version
    with _node_lock:
        if _cached_node is not None and not force:
            return _cached_node or None
        for candidate in _candidate_nodes():
            version = _probe_node(candidate)
            if version is not None:
                _cached_node = candidate
                _cached_node_version = version
                return candidate
        _cached_node = ""
        _cached_node_version = ""
        return None


def node_version() -> str:
    """Version of the resolved Node.js, or an empty string."""
    if resolve_node() is None:
        return ""
    return _cached_node_version


def bridge_available() -> bool:
    """True when both a usable Node.js and the vendored engine are present."""
    return resolve_node() is not None and BRIDGE_SCRIPT.is_file() and VENDOR_ENTRY.is_file()


def unavailable_reason() -> str:
    if resolve_node() is None:
        return (
            "Node.js 22.15 or newer was not found on PATH; harnmem needs it to run the memory engine "
            "(set HARNMEM_NODE to an explicit node binary if it is installed elsewhere)"
        )
    if not BRIDGE_SCRIPT.is_file():
        return f"harnmem bridge script is missing: {BRIDGE_SCRIPT}"
    if not VENDOR_ENTRY.is_file():
        return f"harnmem vendored engine is missing: {VENDOR_ENTRY}"
    return ""


def child_env() -> Dict[str, str]:
    """Environment for bridge child processes.

    Hermes loads the profile's ``.env`` into the process environment before
    plugins run, so a plain copy is enough: the bridge needs ``PATH`` (to find
    Node.js) and the ``HARNMEM_*`` overrides. Staying on the public
    ``os.environ`` surface avoids Hermes-private imports that catalog validation
    flags (rule 9: public surfaces only).
    """
    env = dict(os.environ)
    node = resolve_node()
    if node is not None:
        node_dir = os.path.dirname(node)
        if node_dir:
            path = env.get("PATH", "")
            env["PATH"] = node_dir + (os.pathsep + path if path else "")
    return env


def _decode(data: bytes | str | None) -> str:
    if data is None:
        return ""
    if isinstance(data, bytes):
        return data.decode("utf-8", "replace")
    return data


def _parse_json_line(stdout: str) -> Optional[Dict[str, Any]]:
    for line in reversed(stdout.splitlines()):
        line = line.strip()
        if not line:
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed
    return None


def run_bridge(payload: Dict[str, Any], *, timeout: float = DEFAULT_TOOL_TIMEOUT_S) -> Dict[str, Any]:
    """Run one bridge command synchronously and return its JSON answer.

    Returns ``{"ok": False, "error": ...}`` on every failure mode (missing
    runtime, timeout, crash, garbage output) — never raises.
    """
    node = resolve_node()
    if node is None:
        return {"ok": False, "error": unavailable_reason()}
    if not BRIDGE_SCRIPT.is_file():
        return {"ok": False, "error": unavailable_reason()}
    raw = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
    if len(raw) > MAX_PAYLOAD_BYTES:
        return {"ok": False, "error": f"harnmem bridge payload too large ({len(raw)} bytes)"}
    cwd = payload.get("cwd")
    workdir = str(cwd) if isinstance(cwd, str) and Path(cwd).is_dir() else None
    try:
        result = subprocess.run(
            [node, str(BRIDGE_SCRIPT)],
            input=raw,
            capture_output=True,
            timeout=timeout,
            cwd=workdir,
            env=child_env(),
            check=False,
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"harnmem bridge timed out after {timeout:g}s"}
    except FileNotFoundError:
        global _cached_node
        with _node_lock:
            _cached_node = None
        return {"ok": False, "error": "node binary disappeared; will re-resolve on the next call"}
    except OSError as error:
        return {"ok": False, "error": f"failed to start the harnmem bridge: {error}"}

    stdout = _decode(result.stdout)
    stderr = _decode(result.stderr).strip()
    parsed = _parse_json_line(stdout)
    if parsed is None:
        detail = stderr.splitlines()[-3:] if stderr else []
        suffix = f" (stderr: {' | '.join(detail)})" if detail else ""
        return {"ok": False, "error": f"harnmem bridge returned no JSON (exit {result.returncode}){suffix}"}
    if parsed.get("ok") is not True:
        logger.debug("harnmem bridge reported failure: %s", parsed.get("error", "unknown"))
    return parsed


def _spawn_flags() -> tuple[int, bool]:
    if os.name == "nt":
        flags = 0
        for name in ("DETACHED_PROCESS", "CREATE_NEW_PROCESS_GROUP", "CREATE_NO_WINDOW"):
            flags |= int(getattr(subprocess, name, 0))
        return flags, False
    return 0, True


def run_detached(payload: Dict[str, Any], *, label: str) -> Optional[str]:
    """Hand a payload to a detached bridge process and return its path.

    The process outlives this session (Hermes may exit right after
    ``on_session_end``); the bridge deletes the payload file once handled.
    Returns ``None`` when the job could not be started.
    """
    node = resolve_node()
    if node is None or not BRIDGE_SCRIPT.is_file():
        logger.warning("harnmem: cannot start background extraction: %s", unavailable_reason())
        return None
    raw = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
    if len(raw) > MAX_PAYLOAD_BYTES:
        logger.warning("harnmem: dropping oversized %s payload (%d bytes)", label, len(raw))
        return None
    try:
        PAYLOAD_DIR.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        logger.warning("harnmem: cannot create payload directory %s: %s", PAYLOAD_DIR, error)
        return None
    path = PAYLOAD_DIR / f"{label}-{int(time.time())}-{uuid.uuid4().hex[:8]}.json"
    try:
        path.write_bytes(raw)
    except OSError as error:
        logger.warning("harnmem: cannot write payload %s: %s", path, error)
        return None
    cwd = payload.get("cwd")
    workdir = str(cwd) if isinstance(cwd, str) and Path(cwd).is_dir() else None
    flags, new_session = _spawn_flags()
    try:
        subprocess.Popen(
            [node, str(BRIDGE_SCRIPT), "--payload", str(path)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            cwd=workdir,
            env=child_env(),
            close_fds=True,
            start_new_session=new_session,
            creationflags=flags,
        )
    except OSError as error:
        logger.warning("harnmem: cannot start detached extraction: %s", error)
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass
        return None
    return str(path)


def sweep_payloads(*, ttl: int = PAYLOAD_TTL_S) -> int:
    """Delete stale payload files (crash leftovers). Returns the count removed."""
    try:
        entries = list(PAYLOAD_DIR.iterdir())
    except OSError:
        return 0
    removed = 0
    cutoff = time.time() - ttl
    for entry in entries:
        try:
            if entry.is_file() and entry.stat().st_mtime < cutoff:
                entry.unlink(missing_ok=True)
                removed += 1
        except OSError:
            continue
    return removed
