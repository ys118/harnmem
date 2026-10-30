"""Configuration resolution for the HarnMem Hermes provider.

Kept in its own module (rather than ``__init__.py``) because Hermes loads
``cli.py`` through a synthetic package shell without executing the package
``__init__``: the CLI must be able to resolve config without importing the
provider class and the rest of the plugin.

Resolution order per key: ``HARNMEM_*`` environment variable (the setup wizard
stores secrets in ``.env``), then the ``memory.harnmem`` block from
``config.yaml``, then the built-in default.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict

PLUGIN_NAME = "harnmem"
PROVIDER_LABEL = "HarnMem"

DEFAULT_MAX_INJECT_TOKENS = 1200
DEFAULT_MAX_INJECT_CHARS = 10_000

_TRUE = {"1", "true", "yes", "on", "y", "t"}
_FALSE = {"0", "false", "no", "off", "n", "f"}


def _coerce_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in _TRUE:
            return True
        if lowered in _FALSE:
            return False
    return default


def _coerce_int(value: Any, default: int, *, minimum: int = 0, maximum: int | None = None) -> int:
    try:
        parsed = int(str(value).strip())
    except (TypeError, ValueError):
        return default
    if parsed < minimum:
        return minimum
    if maximum is not None and parsed > maximum:
        return maximum
    return parsed


def _expand_home(value: str) -> str:
    return os.path.expandvars(os.path.expanduser(value.strip()))


def default_store_home() -> str:
    """Engine default: ``~/.harnmem``, shared with every other adapter."""
    return str(Path.home() / ".harnmem")


def load_plugin_block() -> Dict[str, Any]:
    """Read the ``memory.harnmem`` block from the active Hermes config.

    Also accepts the legacy ``memory.provider_config`` fallback that older
    setups wrote, and stays importable when Hermes' config module is absent
    (tests, standalone CLI use).
    """
    try:
        from hermes_cli.config import load_config

        config = load_config() or {}
    except Exception:  # pragma: no cover - config is optional outside Hermes
        return {}
    memory = config.get("memory")
    if not isinstance(memory, dict):
        return {}
    block = memory.get(PLUGIN_NAME)
    if not isinstance(block, dict):
        block = memory.get("provider_config")
    return dict(block) if isinstance(block, dict) else {}


def resolve_config(block: Dict[str, Any]) -> Dict[str, Any]:
    """Merge a config block with ``HARNMEM_*`` environment overrides."""

    def pick(key: str, env_key: str, default: Any) -> Any:
        if env_key in os.environ and os.environ[env_key].strip() != "":
            return os.environ[env_key]
        if key in block and block[key] not in (None, ""):
            return block[key]
        return default

    enabled = _coerce_bool(pick("enabled", "HARNMEM_ENABLED", "true"), True)
    if _coerce_bool(os.environ.get("HARNMEM_DISABLED", ""), False):
        enabled = False
    home = str(pick("home", "HARNMEM_HOME", "") or "").strip()
    return {
        "enabled": enabled,
        "inject": _coerce_bool(pick("inject", "HARNMEM_INJECT", "true"), True),
        "read_only": _coerce_bool(pick("read_only", "HARNMEM_READONLY", "false"), False),
        "auto_extract": _coerce_bool(pick("auto_extract", "HARNMEM_AUTO_EXTRACT", "false"), False),
        "debug": _coerce_bool(pick("debug", "HARNMEM_DEBUG", "false"), False),
        "home": _expand_home(home) if home else default_store_home(),
        "project": str(pick("project", "HARNMEM_PROJECT", "") or "").strip(),
        "max_inject_tokens": _coerce_int(
            pick("max_inject_tokens", "HARNMEM_MAX_INJECT_TOKENS", DEFAULT_MAX_INJECT_TOKENS),
            DEFAULT_MAX_INJECT_TOKENS,
            minimum=100,
            maximum=8000,
        ),
        "max_inject_chars": _coerce_int(
            pick("max_inject_chars", "HARNMEM_MAX_INJECT_CHARS", DEFAULT_MAX_INJECT_CHARS),
            DEFAULT_MAX_INJECT_CHARS,
            minimum=500,
            maximum=100_000,
        ),
        "llm": {
            "url": str(pick("llm_url", "HARNMEM_LLM_URL", "") or "").strip(),
            "model": str(pick("llm_model", "HARNMEM_LLM_MODEL", "") or "").strip(),
            "apiKey": str(pick("llm_api_key", "HARNMEM_LLM_API_KEY", "") or "").strip(),
        },
    }


# Backwards-compatible private aliases (the provider module re-exports these).
_load_plugin_config = load_plugin_block
_default_store_home = default_store_home
