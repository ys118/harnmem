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
PAYLOAD_TTL_S = 3600
#: Payloads used to live in the shared system temp directory; crash leftovers
#: from an earlier plugin version are swept there once after the move to the
#: profile directory (see :func:`payload_dir`).
LEGACY_PAYLOAD_DIR = Path(tempfile.gettempdir()) / "harnmem-hermes"
#: Guard against pathological transcripts: the engine only needs the tail of a
#: session, and a multi-megabyte stdin risks platform pipe limits.
MAX_PAYLOAD_BYTES = 8 * 1024 * 1024

#: memory_manager gives external providers 8s for a synchronous prefetch; stay
#: just inside that so Hermes logs a timeout we caused rather than its own.
DEFAULT_CONTEXT_TIMEOUT_S = 7.0
DEFAULT_TOOL_TIMEOUT_S = 20.0

#: The only credential the plugin can use: an optional OpenAI-compatible API key
#: for the opt-in session-end extraction pass. It is resolved through Hermes'
#: profile-aware secret scope and passed to the child process in its environment,
#: never written into the payload file.
EXTRACTION_SECRET = "HARNMEM_LLM_API_KEY"

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


def _apply_secret_scope(env: Dict[str, str]) -> None:
    """Copy the extraction key from Hermes' profile-aware scope into ``env``.

    The inherited environment is scrubbed unconditionally, then the key is set
    only from a successful scoped read. ``agent.secret_scope.get_secret`` is
    the documented route for a declared plugin secret (catalog rule 11); it
    falls through to the process environment in single-profile runs, so the
    observable value there is unchanged — but under multiplexing the inherited
    copy may belong to another profile, which is exactly what this scrub
    prevents. It is imported lazily so tests and standalone CLI use keep
    working when Hermes is absent.
    """
    # Never let an inherited copy of any profile's key reach the child.
    env.pop(EXTRACTION_SECRET, None)
    try:
        from agent.secret_scope import UnscopedSecretError, get_secret
    except Exception:  # pragma: no cover - Hermes absent in tests/CLI
        return
    try:
        value = (get_secret(EXTRACTION_SECRET, "") or "").strip()
    except UnscopedSecretError:
        return
    except Exception:  # pragma: no cover - defensive
        return
    if value:
        env[EXTRACTION_SECRET] = value


def child_env(extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    """Environment for bridge child processes.

    Starts from the process environment (Hermes has already loaded the profile
    ``.env`` there), drops any inherited copy of the extraction secret and
    re-reads it through the profile-aware scope, then prepends the resolved
    Node.js directory to ``PATH`` so the child starts even when the runtime
    lives outside the inherited path. ``extra`` overrides individual variables
    without mutating ``os.environ``.
    """
    env = dict(os.environ)
    _apply_secret_scope(env)
    node = resolve_node()
    if node is not None:
        node_dir = os.path.dirname(node)
        if node_dir:
            path = env.get("PATH", "")
            env["PATH"] = node_dir + (os.pathsep + path if path else "")
    if extra:
        env.update({key: str(value) for key, value in extra.items()})
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


def run_bridge(
    payload: Dict[str, Any],
    *,
    timeout: float = DEFAULT_TOOL_TIMEOUT_S,
    env_extra: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """Run one bridge command synchronously and return its JSON answer.

    Returns ``{"ok": False, "error": ...}`` on every failure mode (missing
    runtime, timeout, crash, garbage output) — never raises. ``env_extra``
    overrides variables for this child only.
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
            env=child_env(env_extra),
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


def payload_dir(hermes_home: Optional[str] = None) -> Path:
    """Directory for session-end payload files.

    Payloads carry the session transcript, so they live under the Hermes
    profile (``<hermes_home>/plugin-data/harnmem/payloads``) — a user-owned
    location on every platform — instead of the shared system temp directory.
    ``hermes_home`` is the value Hermes passes to
    ``initialize()``; without it the ``HERMES_HOME`` environment variable is
    consulted, then the platform default. ``HARNMEM_PAYLOAD_DIR`` overrides the
    resolved directory outright (tests, sandboxed runs).
    """
    override = os.environ.get("HARNMEM_PAYLOAD_DIR", "").strip()
    if override:
        return Path(override)
    base = str(hermes_home or os.environ.get("HERMES_HOME", "") or "").strip()
    if not base:
        if os.name == "nt":
            local_app_data = os.environ.get("LOCALAPPDATA", "").strip()
            base = os.path.join(local_app_data, "hermes") if local_app_data else str(Path.home() / ".hermes")
        else:
            base = str(Path.home() / ".hermes")
    return Path(base) / "plugin-data" / "harnmem" / "payloads"


def run_detached(
    payload: Dict[str, Any],
    *,
    label: str,
    env_extra: Optional[Dict[str, str]] = None,
    hermes_home: Optional[str] = None,
) -> Optional[str]:
    """Hand a payload to a detached bridge process and return its path.

    The process outlives this session (Hermes may exit right after
    ``on_session_end``); the bridge deletes the payload file once handled.
    Returns ``None`` when the job could not be started. The payload file is
    created owner-only (0600) inside an owner-only directory under the Hermes
    profile: it carries the session transcript, and secrets are deliberately
    kept out of it — the extraction key and the extraction endpoint travel only
    in the child's environment (``env_extra``).
    """
    node = resolve_node()
    if node is None or not BRIDGE_SCRIPT.is_file():
        logger.warning("harnmem: cannot start background extraction: %s", unavailable_reason())
        return None
    raw = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
    if len(raw) > MAX_PAYLOAD_BYTES:
        logger.warning("harnmem: dropping oversized %s payload (%d bytes)", label, len(raw))
        return None
    directory = payload_dir(hermes_home)
    try:
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    except OSError as error:
        logger.warning("harnmem: cannot create payload directory %s: %s", directory, error)
        return None
    path = directory / f"{label}-{int(time.time())}-{uuid.uuid4().hex[:8]}.json"
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except OSError as error:
        logger.warning("harnmem: cannot create payload %s: %s", path, error)
        return None
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(raw)
    except OSError as error:
        logger.warning("harnmem: cannot write payload %s: %s", path, error)
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass
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
            env=child_env(env_extra),
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


def sweep_payloads(*, ttl: int = PAYLOAD_TTL_S, hermes_home: Optional[str] = None) -> int:
    """Delete stale payload files (crash leftovers). Returns the count removed.

    Also sweeps the pre-0.1.3 system temp directory once, so leftovers from an
    earlier plugin version do not linger past their TTL after the payload
    directory moved under the Hermes profile.
    """
    cutoff = time.time() - ttl
    removed = 0
    for directory in (payload_dir(hermes_home), LEGACY_PAYLOAD_DIR):
        try:
            entries = list(directory.iterdir())
        except OSError:
            continue
        for entry in entries:
            try:
                if entry.is_file() and entry.stat().st_mtime < cutoff:
                    entry.unlink(missing_ok=True)
                    removed += 1
            except OSError:
                continue
    return removed
