"""Tests for the Hermes memory provider and its CLI translation.

Hermes imports the plugin inside its own process, so these tests stub the
``agent.memory_provider``, ``tools.registry`` and ``hermes_cli.config`` modules
and then load the package from disk, mirroring what the Hermes plugin loader
does. No Node.js process is spawned: every bridge call is mocked, which keeps
the suite deterministic and network-free.
"""

import argparse
import contextlib
import importlib
import importlib.util
import io
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

PACKAGE_DIR = Path(__file__).resolve().parents[2]
PACKAGE_NAME = "harnmem_plugin"

CONFIG = {"memory": {}}

#: Mirrors Hermes' ``agent.secret_scope``: ``{name: value}`` bound to the active
#: profile, plus a multiplexing switch that makes unscoped reads fail closed.
SCOPED_SECRETS = {}
MULTIPLEX = {"active": False}

plugin = None
cli = None
plugin_config = None


def _install_stubs():
    agent = types.ModuleType("agent")
    agent.__path__ = []
    memory_provider = types.ModuleType("agent.memory_provider")

    class MemoryProvider:
        pass

    class RecallStatus:
        def __init__(self, provider_label, count, glyph="🧠"):
            self.provider_label = provider_label
            self.count = count
            self.glyph = glyph

    def spawn_context_thread(target, *, name=None, daemon=True, args=(), kwargs=None):
        raise AssertionError("the provider must not spawn threads")

    memory_provider.MemoryProvider = MemoryProvider
    memory_provider.RecallStatus = RecallStatus
    memory_provider.spawn_context_thread = spawn_context_thread
    agent.memory_provider = memory_provider

    secret_scope = types.ModuleType("agent.secret_scope")

    class UnscopedSecretError(RuntimeError):
        pass

    def get_secret(name, default=None):
        if name in SCOPED_SECRETS:
            return SCOPED_SECRETS[name]
        if MULTIPLEX["active"]:
            raise UnscopedSecretError(name)
        return os.environ.get(name, default)

    def is_multiplex_active():
        return bool(MULTIPLEX["active"])

    secret_scope.UnscopedSecretError = UnscopedSecretError
    secret_scope.get_secret = get_secret
    secret_scope.is_multiplex_active = is_multiplex_active
    agent.secret_scope = secret_scope

    tools = types.ModuleType("tools")
    tools.__path__ = []
    registry = types.ModuleType("tools.registry")
    registry.tool_error = lambda message: json.dumps({"error": message})
    tools.registry = registry

    hermes_cli = types.ModuleType("hermes_cli")
    hermes_cli.__path__ = []
    hermes_config = types.ModuleType("hermes_cli.config")

    def load_config():
        return json.loads(json.dumps(CONFIG))

    def save_config(config, **kwargs):
        CONFIG.clear()
        CONFIG.update(json.loads(json.dumps(config)))

    hermes_config.load_config = load_config
    hermes_config.save_config = save_config
    hermes_cli.config = hermes_config

    sys.modules.update(
        {
            "agent": agent,
            "agent.memory_provider": memory_provider,
            "agent.secret_scope": secret_scope,
            "tools": tools,
            "tools.registry": registry,
            "hermes_cli": hermes_cli,
            "hermes_cli.config": hermes_config,
        }
    )


def _load_package():
    spec = importlib.util.spec_from_file_location(
        PACKAGE_NAME,
        PACKAGE_DIR / "__init__.py",
        submodule_search_locations=[str(PACKAGE_DIR)],
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[PACKAGE_NAME] = module
    spec.loader.exec_module(module)
    return module


def setUpModule():
    _install_stubs()
    global plugin, cli, plugin_config
    plugin = _load_package()
    cli = importlib.import_module(PACKAGE_NAME + ".cli")
    plugin_config = importlib.import_module(PACKAGE_NAME + ".config")


def _parser():
    parser = argparse.ArgumentParser(prog="hermes")
    subparsers = parser.add_subparsers(dest="command")
    provider = subparsers.add_parser("harnmem")
    cli.register_cli(provider)
    return parser


class ProviderTestCase(unittest.TestCase):
    def setUp(self):
        self._env_backup = {key: os.environ.pop(key) for key in list(os.environ) if key.startswith("HARNMEM_")}
        self._secret_backup = dict(SCOPED_SECRETS)
        SCOPED_SECRETS.clear()
        MULTIPLEX["active"] = False
        self._reset_config()

    def tearDown(self):
        for key in [key for key in os.environ if key.startswith("HARNMEM_")]:
            del os.environ[key]
        os.environ.update(self._env_backup)
        SCOPED_SECRETS.clear()
        SCOPED_SECRETS.update(self._secret_backup)
        MULTIPLEX["active"] = False
        self._reset_config()

    @staticmethod
    def _reset_config():
        CONFIG.clear()
        CONFIG.update({"memory": {}})

    def _provider(self, block=None, *, auto_extract=False):
        values = dict(block or {})
        provider = plugin.HarnmemMemoryProvider(values)
        provider.initialize(
            "session-1",
            hermes_home="/tmp/hermes-home",
            platform="cli",
            agent_context="primary",
            cwd="/tmp/project",
        )
        return provider

    @staticmethod
    def _available():
        return mock.patch.multiple(
            plugin.bridge,
            bridge_available=mock.DEFAULT,
            unavailable_reason=mock.DEFAULT,
        )


class ConfigTests(ProviderTestCase):
    def test_defaults(self):
        provider = plugin.HarnmemMemoryProvider({})
        config = provider._config
        self.assertEqual(provider.name, "harnmem")
        self.assertTrue(config["enabled"])
        self.assertTrue(config["inject"])
        self.assertFalse(config["auto_extract"])
        self.assertFalse(config["read_only"])
        self.assertEqual(config["max_inject_tokens"], 1200)
        self.assertEqual(config["max_inject_chars"], 10_000)
        self.assertTrue(config["home"].endswith(".harnmem"))

    def test_config_block_is_read_from_hermes_config(self):
        CONFIG["memory"]["harnmem"] = {
            "auto_extract": "true",
            "max_inject_tokens": "2048",
            "home": "~/shared-memories",
        }
        provider = plugin.HarnmemMemoryProvider()
        self.assertTrue(provider._config["auto_extract"])
        self.assertEqual(provider._config["max_inject_tokens"], 2048)
        self.assertTrue(provider._config["home"].endswith("shared-memories"))

    def test_environment_overrides_win(self):
        os.environ["HARNMEM_DISABLED"] = "1"
        os.environ["HARNMEM_MAX_INJECT_TOKENS"] = "5000"
        os.environ["HARNMEM_HOME"] = "~/env-store"
        provider = plugin.HarnmemMemoryProvider({"auto_extract": "true", "read_only": "true"})
        self.assertFalse(provider._config["enabled"])
        self.assertTrue(provider._config["auto_extract"])
        self.assertTrue(provider._config["read_only"])
        self.assertEqual(provider._config["max_inject_tokens"], 5000)
        self.assertTrue(provider._config["home"].endswith("env-store"))

    def test_is_available_reports_dependency_problems(self):
        provider = plugin.HarnmemMemoryProvider({})
        with mock.patch.object(plugin.bridge, "bridge_available", return_value=True):
            self.assertTrue(provider.is_available())
        with mock.patch.object(plugin.bridge, "bridge_available", return_value=False), mock.patch.object(
            plugin.bridge, "unavailable_reason", return_value="node is missing"
        ):
            self.assertFalse(provider.is_available())
            self.assertEqual(provider.unavailable_reason(), "node is missing")

        disabled = plugin.HarnmemMemoryProvider({"enabled": "false"})
        self.assertFalse(disabled.is_available())
        self.assertIn("disabled", disabled.unavailable_reason())

    def test_initialize_binds_the_profile_and_forces_read_only_for_subagents(self):
        provider = plugin.HarnmemMemoryProvider({})
        provider.initialize(
            "session-1",
            hermes_home="/tmp/hermes-home",
            platform="cli",
            agent_context="primary",
            cwd="/tmp/project",
        )
        self.assertFalse(provider._read_only)
        self.assertEqual(provider._session_id, "session-1")
        self.assertEqual(provider._cwd, "/tmp/project")
        self.assertEqual(provider._hermes_home, "/tmp/hermes-home")

        provider.initialize("session-2", agent_context="subagent")
        self.assertTrue(provider._read_only)

    def test_save_config_persists_the_detached_wizard_block(self):
        provider = plugin.HarnmemMemoryProvider({})
        provider.save_config(
            {
                "auto_extract": "true",
                "home": "~/shared-memories",
                "llm_url": "  https://llm.example.test/v1  ",
                "debug": "   ",
            },
            "/tmp/hermes-home",
        )
        block = plugin._load_plugin_config()
        self.assertEqual(block["auto_extract"], "true")
        self.assertEqual(block["llm_url"], "https://llm.example.test/v1")
        self.assertNotIn("debug", block)

    def test_config_schema_covers_the_wizard_fields(self):
        schema = plugin.HarnmemMemoryProvider({}).get_config_schema()
        keys = [field["key"] for field in schema]
        self.assertEqual(
            keys,
            [
                "home",
                "max_inject_tokens",
                "inject",
                "auto_extract",
                "read_only",
                "llm_url",
                "llm_model",
                "llm_api_key",
                "project",
                "debug",
            ],
        )
        by_key = {field["key"]: field for field in schema}
        self.assertEqual(by_key["auto_extract"]["choices"], ["true", "false"])
        self.assertTrue(by_key["llm_api_key"]["secret"])
        self.assertEqual(by_key["llm_url"]["when"], {"auto_extract": "true"})

    def test_status_config_is_json_friendly(self):
        with mock.patch.object(plugin.bridge, "node_version", return_value="v22.15.0"):
            status = plugin.HarnmemMemoryProvider({}).get_status_config({})
        self.assertEqual(status["node"], "v22.15.0")
        self.assertEqual(status["mode"], "read-write")
        self.assertIn("store", status)


class SecretScopeTests(ProviderTestCase):
    """The extraction key is a declared secret (catalog rule 11).

    Hermes routes plugin credentials through ``agent.secret_scope``; a bare
    environment read can belong to another profile while multiplexing.
    """

    def test_secret_prefers_the_profile_scope_over_the_environment(self):
        os.environ["HARNMEM_LLM_API_KEY"] = "plain-env"
        SCOPED_SECRETS["HARNMEM_LLM_API_KEY"] = "scoped-key"
        self.assertEqual(plugin_config.secret("HARNMEM_LLM_API_KEY", "fallback"), "scoped-key")

    def test_secret_falls_back_when_hermes_is_not_available(self):
        with mock.patch.dict(sys.modules, {"agent.secret_scope": None}):
            self.assertEqual(plugin_config.secret("HARNMEM_LLM_API_KEY", "fallback"), "fallback")

    def test_secret_fails_closed_when_multiplexing_without_a_scope(self):
        os.environ["HARNMEM_LLM_API_KEY"] = "foreign-key"
        MULTIPLEX["active"] = True
        self.assertEqual(plugin_config.secret("HARNMEM_LLM_API_KEY", "fallback"), "")

    def test_resolve_config_reads_the_key_through_the_scope(self):
        SCOPED_SECRETS["HARNMEM_LLM_API_KEY"] = "scoped-key"
        config = plugin_config.resolve_config(
            {
                "llm_url": "https://llm.example.test/v1",
                "llm_model": "test-model",
                "llm_api_key": "block-key",
            }
        )
        self.assertEqual(config["llm"]["apiKey"], "scoped-key")

    def test_child_env_never_forwards_a_foreign_key_while_multiplexing(self):
        os.environ["HARNMEM_LLM_API_KEY"] = "foreign-key"
        MULTIPLEX["active"] = True
        with mock.patch.object(plugin.bridge, "resolve_node", return_value=None):
            env = plugin.bridge.child_env()
        self.assertNotIn("HARNMEM_LLM_API_KEY", env)

    def test_child_env_uses_the_scoped_key_and_honours_overrides(self):
        os.environ["HARNMEM_LLM_API_KEY"] = "plain-env"
        SCOPED_SECRETS["HARNMEM_LLM_API_KEY"] = "scoped-key"
        with mock.patch.object(plugin.bridge, "resolve_node", return_value=None):
            self.assertEqual(plugin.bridge.child_env()["HARNMEM_LLM_API_KEY"], "scoped-key")
            overridden = plugin.bridge.child_env({"HARNMEM_LLM_API_KEY": "extra-key"})
        self.assertEqual(overridden["HARNMEM_LLM_API_KEY"], "extra-key")


class InjectionTests(ProviderTestCase):
    def test_prefetch_caches_the_snapshot_and_write_invalidates_it(self):
        calls = []

        def fake_run_bridge(payload, **kwargs):
            calls.append(payload["command"])
            if payload["command"] == "context":
                return {"ok": True, "text": "ctx", "ids": ["mem_1"], "tokensEstimate": 3}
            return {"ok": True, "id": "mem_2", "action": "NEW"}

        provider = self._provider()
        with mock.patch.object(plugin.bridge, "bridge_available", return_value=True), mock.patch.object(
            plugin.bridge, "run_bridge", side_effect=fake_run_bridge
        ):
            self.assertEqual(provider.prefetch("hello"), "ctx")
            self.assertEqual(provider.prefetch("hello"), "ctx")
            self.assertEqual(calls, ["context"])
            self.assertEqual(provider.recall_status().count, 1)

            provider.handle_tool_call(
                "harnmem_write",
                {"type": "user", "title": "T", "description": "D", "content": "C"},
            )
            self.assertEqual(provider.prefetch("hello"), "ctx")
            self.assertEqual(calls, ["context", "write", "context"])

    def test_failed_render_keeps_the_previous_injection_and_backs_off(self):
        responses = [
            {"ok": True, "text": "ctx", "ids": [], "tokensEstimate": 0},
            {"ok": False, "error": "boom"},
        ]
        calls = []

        def fake_run_bridge(payload, **kwargs):
            calls.append(payload)
            return responses[len(calls) - 1]

        provider = self._provider()
        with mock.patch.object(plugin.bridge, "bridge_available", return_value=True), mock.patch.object(
            plugin.bridge, "run_bridge", side_effect=fake_run_bridge
        ):
            self.assertEqual(provider.prefetch("hello"), "ctx")
            provider._invalidate_injection()
            self.assertEqual(provider.prefetch("hello"), "ctx")
            self.assertEqual(len(calls), 2)
            # The backoff window suppresses further attempts.
            provider._invalidate_injection()
            self.assertEqual(provider.prefetch("hello"), "ctx")
            self.assertEqual(len(calls), 2)

    def test_injection_can_be_disabled(self):
        provider = self._provider({"inject": "false"})
        with mock.patch.object(plugin.bridge, "bridge_available", return_value=True), mock.patch.object(
            plugin.bridge, "run_bridge"
        ) as run_bridge:
            self.assertEqual(provider.prefetch("hello"), "")
        run_bridge.assert_not_called()

    def test_session_switch_invalidates_the_cache(self):
        calls = []

        def fake_run_bridge(payload, **kwargs):
            calls.append(payload.get("sessionId"))
            return {"ok": True, "text": "ctx", "ids": [], "tokensEstimate": 0}

        provider = self._provider()
        with mock.patch.object(plugin.bridge, "bridge_available", return_value=True), mock.patch.object(
            plugin.bridge, "run_bridge", side_effect=fake_run_bridge
        ):
            provider.prefetch("hello")
            provider.on_session_switch("session-2")
            provider.prefetch("hello")
        self.assertEqual(calls, ["session-1", "session-2"])


class ToolTests(ProviderTestCase):
    def test_tool_schemas_are_unique_and_well_formed(self):
        schemas = plugin.HarnmemMemoryProvider({}).get_tool_schemas()
        names = [schema["name"] for schema in schemas]
        self.assertEqual(
            names,
            ["harnmem_search", "harnmem_write", "harnmem_read", "harnmem_forget", "harnmem_status"],
        )
        self.assertEqual(len(names), len(set(names)))
        for schema in schemas:
            self.assertIsInstance(schema["description"], str)
            self.assertEqual(schema["parameters"]["type"], "object")

    def test_unknown_tool_and_engine_errors_become_json_errors(self):
        provider = self._provider()
        with mock.patch.object(plugin.bridge, "bridge_available", return_value=True):
            self.assertIn("unknown harnmem tool", provider.handle_tool_call("nope", {}))
            with mock.patch.object(plugin.bridge, "run_bridge", return_value={"ok": False, "error": "boom"}):
                result = json.loads(provider.handle_tool_call("harnmem_search", {"query": "x"}))
                self.assertEqual(result["error"], "boom")

    def test_write_is_rejected_for_read_only_sessions(self):
        provider = self._provider({"read_only": "true"})
        with mock.patch.object(plugin.bridge, "bridge_available", return_value=True), mock.patch.object(
            plugin.bridge, "run_bridge"
        ) as run_bridge:
            result = json.loads(
                provider.handle_tool_call(
                    "harnmem_write",
                    {"type": "user", "title": "T", "description": "D", "content": "C"},
                )
            )
        self.assertIn("read-only", result["error"])
        run_bridge.assert_not_called()

    def test_write_payload_carries_harness_provenance(self):
        captured = {}

        def fake_run_bridge(payload, **kwargs):
            captured.update(payload)
            return {"ok": True, "id": "mem_1", "action": "NEW"}

        provider = self._provider()
        with mock.patch.object(plugin.bridge, "bridge_available", return_value=True), mock.patch.object(
            plugin.bridge, "run_bridge", side_effect=fake_run_bridge
        ):
            provider.handle_tool_call(
                "harnmem_write",
                {
                    "type": "project",
                    "title": "Uses pnpm",
                    "description": "Package manager",
                    "content": "pnpm 10",
                    "tags": ["tooling"],
                },
            )
        self.assertEqual(captured["command"], "write")
        self.assertEqual(captured["input"]["source"], {"harness": "hermes", "session": "session-1"})
        self.assertEqual(captured["input"]["tags"], ["tooling"])
        self.assertEqual(captured["sessionId"], "session-1")

    def test_search_response_is_trimmed_to_model_fields(self):
        hit = {
            "id": "mem_1",
            "type": "user",
            "scope": "user",
            "title": "T",
            "description": "D",
            "snippet": "S",
            "score": 0.9,
            "status": "active",
            "raw": "do not leak",
        }
        provider = self._provider()
        with mock.patch.object(plugin.bridge, "bridge_available", return_value=True), mock.patch.object(
            plugin.bridge,
            "run_bridge",
            return_value={"ok": True, "query": "q", "total": 1, "abstained": False, "results": [hit]},
        ):
            result = json.loads(provider.handle_tool_call("harnmem_search", {"query": "q"}))
        self.assertEqual(result["total"], 1)
        self.assertNotIn("raw", result["results"][0])
        self.assertEqual(result["results"][0]["id"], "mem_1")

    def test_status_flattens_shards(self):
        provider = self._provider()
        with mock.patch.object(plugin.bridge, "bridge_available", return_value=True), mock.patch.object(
            plugin.bridge,
            "run_bridge",
            return_value={
                "ok": True,
                "home": "/store",
                "shards": [{"name": "user", "total": 2, "active": 2, "pinned": 1, "superseded": 0}],
                "index": {"stale": False},
                "health": {"ok": True},
                "extraction": {"backlog": 0},
            },
        ):
            result = json.loads(provider.handle_tool_call("harnmem_status", {}))
        self.assertEqual(result["shards"]["user"]["pinned"], 1)


class ExtractionTests(ProviderTestCase):
    def test_transcript_conversion_flattens_and_filters(self):
        messages = [
            {"role": "user", "content": "hello", "timestamp": 1_700_000_000},
            {"role": "assistant", "content": [{"type": "text", "text": "hi"}, {"text": "there"}]},
            {"role": "tool", "content": "result", "tool_name": "shell"},
            {"role": "weird", "content": "skip"},
            {"role": "user", "content": "   "},
            {"role": "user", "content": "x" * 25_000},
        ]
        transcript = plugin.transcript_from_messages(messages)
        self.assertEqual([entry["role"] for entry in transcript], ["user", "assistant", "tool", "user"])
        self.assertEqual(transcript[0]["ts"], 1_700_000_000_000.0)
        self.assertEqual(transcript[1]["text"], "hi\nthere")
        self.assertEqual(transcript[2]["name"], "shell")
        self.assertIn("[...truncated by harnmem adapter]", transcript[3]["text"])

    def test_session_end_spawns_a_detached_extraction(self):
        captured = {}
        SCOPED_SECRETS["HARNMEM_LLM_API_KEY"] = "scoped-key"

        def fake_detached(payload, *, label, env_extra=None):
            captured["payload"] = payload
            captured["label"] = label
            captured["env_extra"] = env_extra
            return "/tmp/payload.json"

        provider = self._provider(
            {
                "auto_extract": "true",
                "llm_url": "https://llm.example.test/v1",
                "llm_model": "test-model",
                "llm_api_key": "block-key",
            }
        )
        with mock.patch.object(plugin.bridge, "run_detached", side_effect=fake_detached), mock.patch.object(
            plugin.bridge, "sweep_payloads"
        ):
            result = provider.on_session_end(
                [
                    {"role": "user", "content": "remember this"},
                    {"role": "assistant", "content": "ok"},
                ]
            )
        self.assertIsNone(result)
        self.assertEqual(captured["label"], "session-end")
        self.assertEqual(captured["payload"]["command"], "session-end")
        self.assertTrue(captured["payload"]["autoExtract"])
        self.assertEqual(captured["payload"]["messages"][0]["role"], "user")
        # The key goes through the child environment, never the on-disk payload.
        self.assertEqual(captured["payload"]["llm"], {"url": "https://llm.example.test/v1", "model": "test-model"})
        self.assertEqual(captured["env_extra"], {"HARNMEM_LLM_API_KEY": "scoped-key"})

    def test_session_end_does_nothing_without_auto_extract(self):
        provider = self._provider()
        with mock.patch.object(plugin.bridge, "run_detached") as run_detached:
            provider.on_session_end([{"role": "user", "content": "hello"}])
        run_detached.assert_not_called()

    def test_session_end_does_nothing_for_subagents(self):
        provider = plugin.HarnmemMemoryProvider({"auto_extract": "true"})
        provider.initialize("session-1", hermes_home="/tmp/hermes-home", agent_context="subagent")
        with mock.patch.object(plugin.bridge, "run_detached") as run_detached:
            provider.on_session_end([{"role": "user", "content": "hello"}])
        run_detached.assert_not_called()

    def test_session_end_needs_at_least_one_user_message(self):
        provider = self._provider({"auto_extract": "true"})
        with mock.patch.object(plugin.bridge, "run_detached") as run_detached:
            provider.on_session_end([{"role": "assistant", "content": "only me"}])
        run_detached.assert_not_called()


class RegistrationTests(ProviderTestCase):
    def test_register_publishes_one_provider_instance(self):
        published = []

        class Context:
            def register_memory_provider(self, provider):
                published.append(provider)

        plugin.register(Context())
        self.assertEqual(len(published), 1)
        self.assertIsInstance(published[0], plugin.HarnmemMemoryProvider)
        self.assertEqual(published[0].name, "harnmem")


class CliTests(ProviderTestCase):
    def _search_result(self):
        return {
            "ok": True,
            "query": "pnpm",
            "total": 1,
            "abstained": False,
            "results": [
                {
                    "id": "mem_1",
                    "type": "user",
                    "scope": "user",
                    "title": "Uses pnpm",
                    "description": "Package manager",
                    "score": 0.9,
                    "status": "active",
                }
            ],
        }

    def test_cli_registers_subcommands_and_handlers(self):
        parser = _parser()
        self.assertIs(parser.parse_args(["harnmem"]).func, cli.harnmem_command)
        self.assertIs(parser.parse_args(["harnmem", "search", "pnpm"]).func, cli._cmd_search)
        self.assertIs(parser.parse_args(["harnmem", "status"]).func, cli._cmd_status)

    def test_cli_handler_alias_survives_odd_provider_names(self):
        # Hermes looks up ``<provider>_command``; a profile installed under a
        # different directory name must still resolve the handler.
        self.assertIs(getattr(cli, "hermes-harnmem_command"), cli.harnmem_command)
        with self.assertRaises(AttributeError):
            cli.not_a_handler

    def test_cli_module_loads_in_hermes_synthetic_shell(self):
        # Hermes imports cli.py through a synthetic package shell *without*
        # executing the package __init__ (the provider module is not loaded at
        # argparse-setup time), so cli.py must not import the provider class.
        name = "harnmem_synthetic_probe"
        parent = types.ModuleType(name)
        parent.__path__ = [str(PACKAGE_DIR)]
        sys.modules[name] = parent
        module_name = name + ".cli"
        try:
            spec = importlib.util.spec_from_file_location(module_name, str(PACKAGE_DIR / "cli.py"))
            module = importlib.util.module_from_spec(spec)
            sys.modules[module_name] = module
            spec.loader.exec_module(module)
            self.assertTrue(callable(module.register_cli))
            self.assertTrue(callable(module.harnmem_command))
            parser = argparse.ArgumentParser(prog="probe")
            subparsers = parser.add_subparsers(dest="command")
            plugin_parser = subparsers.add_parser("harnmem")
            module.register_cli(plugin_parser)
            self.assertIs(parser.parse_args(["harnmem", "status"]).func, module._cmd_status)
        finally:
            sys.modules.pop(module_name, None)
            sys.modules.pop(name, None)

    def test_search_json_output(self):
        args = _parser().parse_args(["harnmem", "search", "pnpm", "--json"])
        with mock.patch.object(plugin.bridge, "run_bridge", return_value=self._search_result()):
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                code = args.func(args)
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(output.getvalue())["total"], 1)

    def test_failed_bridge_result_prints_the_error_not_a_blank_record(self):
        # A failed bridge call answers {"ok": False, "error": ...}; rendering an
        # empty result record would print a blank table and hide the cause.
        args = _parser().parse_args(["harnmem", "search", "pnpm"])
        failure = {"ok": False, "error": "engine said no"}
        with mock.patch.object(plugin.bridge, "run_bridge", return_value=failure):
            stdout, stderr = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                code = args.func(args)
        self.assertEqual(code, 1)
        self.assertEqual(stdout.getvalue(), "")
        self.assertIn("engine said no", stderr.getvalue())

    def test_write_command_reads_a_content_file(self):
        captured = {}

        def fake_run_bridge(payload, **kwargs):
            captured.update(payload)
            return {"ok": True, "id": "mem_1", "action": "NEW"}

        with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False, encoding="utf-8") as handle:
            handle.write("body from file")
            content_file = handle.name
        self.addCleanup(lambda: os.unlink(content_file))

        args = _parser().parse_args(
            [
                "harnmem",
                "write",
                "--type",
                "user",
                "--title",
                "T",
                "--description",
                "D",
                "--content-file",
                content_file,
                "--json",
            ]
        )
        with mock.patch.object(plugin.bridge, "run_bridge", side_effect=fake_run_bridge):
            with contextlib.redirect_stdout(io.StringIO()):
                code = args.func(args)
        self.assertEqual(code, 0)
        self.assertEqual(captured["input"]["content"], "body from file")
        self.assertEqual(captured["input"]["source"], {"harness": "hermes"})

    def test_bare_command_prints_usage(self):
        args = _parser().parse_args(["harnmem"])
        output = io.StringIO()
        with contextlib.redirect_stderr(output):
            code = cli.harnmem_command(args)
        self.assertEqual(code, 2)
        self.assertIn("hermes harnmem", output.getvalue())


if __name__ == "__main__":
    unittest.main()
