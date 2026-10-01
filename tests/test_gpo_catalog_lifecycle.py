"""Read-only AT catalog startup, background refresh, and generation contracts."""

import copy
import importlib.util
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest


MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "plugin/ipaserver/plugins/gpo.py"
)
SPEC = importlib.util.spec_from_file_location("gpo_catalog_under_test", MODULE_PATH)
GPO = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GPO)


@pytest.fixture(autouse=True)
def reset_catalog_runtime():
    GPO._reset_editor_globals_for_tests()
    yield
    GPO._reset_editor_globals_for_tests()


class Catalog:
    """Mutable native-handle double whose published generations are immutable."""

    def __init__(self, root, all_locales=False):
        assert root == str(GPO.GPO_TEMPLATE_ROOT)
        assert all_locales is True
        self.number = 1
        self.refreshes = 0
        self.refresh_action = None

    def generation(self):
        return {
            "number": self.number,
            "content_fingerprint": f"content-{self.number}",
            "inventory_fingerprint": f"files-{self.number}",
            "loaded_locales": ["en-US", "ru-RU"],
        }

    def diagnostics(self):
        return []

    def refresh_if_changed(self):
        self.refreshes += 1
        if self.refresh_action:
            return self.refresh_action()
        return {
            "status": "unchanged",
            "previous_generation": self.number,
            "current_generation": self.number,
            "parse_performed": False,
            "content_fingerprint": f"content-{self.number}",
            "inventory_fingerprint": f"files-{self.number}",
            "diagnostics": [],
            "failure": None,
        }


def binding(factory=Catalog):
    return SimpleNamespace(TemplateCatalog=factory)


def wait_until(predicate, timeout=2.0):
    deadline = time.monotonic() + timeout
    tick = threading.Event()
    while time.monotonic() < deadline:
        if predicate():
            return True
        tick.wait(0.005)
    return bool(predicate())


def failed_refresh():
    return {
        "status": "failed",
        "previous_generation": 1,
        "current_generation": 1,
        "parse_performed": True,
        "content_fingerprint": "content-1",
        "inventory_fingerprint": "broken-files",
        "diagnostics": [{
            "message": "Cannot parse /usr/share/PolicyDefinitions/private.admx",
            "path": "/usr/share/PolicyDefinitions/private.admx",
        }],
        "failure": {
            "code": "unusable_snapshot",
            "message": "Private source /usr/share/PolicyDefinitions/private.admx",
            "diagnostics": [],
        },
    }


def test_prepared_reads_never_run_refresh_or_replace_a_cached_generation():
    module = binding()
    GPO._refresh_catalog(module, now=10.0)
    catalog, first = GPO._get_catalog(module, now=10.0)

    # Even an overdue request must not parse files on the request thread.
    second_catalog, second = GPO._get_catalog(module, now=1_000_000.0)

    assert second_catalog is catalog
    assert second["generation"] == first["generation"]
    assert catalog.refreshes == 0


def test_cached_state_is_isolated_from_request_mutation():
    module = binding()
    GPO._refresh_catalog(module, now=10.0)
    _, request_state = GPO._get_catalog(module)
    request_state["generation"]["loaded_locales"].append("xx-XX")
    request_state["generation"]["number"] = 1000
    request_state["diagnostics"].append({"message": "request-only"})

    _, next_request = GPO._get_catalog(module)

    assert next_request["generation"]["number"] == 1
    assert next_request["generation"]["loaded_locales"] == ["en-US", "ru-RU"]
    assert next_request["diagnostics"] == []


def test_background_refresh_is_throttled_and_failed_inputs_are_retryable():
    module = binding()
    GPO._refresh_catalog(module, now=10.0)
    catalog, _ = GPO._get_catalog(module)
    catalog.refresh_action = failed_refresh

    GPO._refresh_catalog(module, now=12.0)
    assert catalog.refreshes == 0
    GPO._refresh_catalog(module, now=20.0)
    _, retained = GPO._get_catalog(module)

    assert catalog.refreshes == 1
    assert retained["generation"]["number"] == 1
    assert retained["refresh"]["status"] == "failed"
    assert "/usr/share/PolicyDefinitions" not in str(retained)

    def repair():
        catalog.number = 2
        return {
            **catalog.generation(),
            "status": "changed",
            "previous_generation": 1,
            "current_generation": 2,
            "parse_performed": True,
            "diagnostics": [],
            "failure": None,
        }

    catalog.refresh_action = repair
    GPO._refresh_catalog(module, now=30.0)
    _, repaired = GPO._get_catalog(module)

    assert catalog.refreshes == 2
    assert repaired["generation"]["number"] == 2
    assert repaired["refresh"]["status"] == "changed"


def test_unexpected_refresh_failure_retains_last_good_and_retries():
    module = binding()
    GPO._refresh_catalog(module, now=10.0)
    catalog, first = GPO._get_catalog(module)

    def fail():
        raise RuntimeError("Failure at /usr/share/PolicyDefinitions/private.admx")

    catalog.refresh_action = fail
    GPO._refresh_catalog(module, now=20.0)
    same_catalog, retained = GPO._get_catalog(module)

    assert same_catalog is catalog
    assert retained["generation"] == first["generation"]
    assert retained["refresh"]["failure"]
    assert "/usr/share/PolicyDefinitions" not in str(retained)

    catalog.refresh_action = None
    GPO._refresh_catalog(module, now=30.0)
    _, recovered = GPO._get_catalog(module)
    assert catalog.refreshes == 2
    assert recovered["refresh"]["status"] == "unchanged"


def test_blocked_refresh_does_not_block_a_reader_or_mutate_its_metadata():
    module = binding()
    GPO._refresh_catalog(module, now=10.0)
    catalog, before = GPO._get_catalog(module)
    entered = threading.Event()
    release = threading.Event()
    completed = threading.Event()
    result = []
    failures = []

    def slow_refresh():
        entered.set()
        assert release.wait(5.0), "Test did not release the blocked native refresh"
        catalog.number = 2
        return {
            "status": "changed",
            "previous_generation": 1,
            "current_generation": 2,
            "parse_performed": True,
            "content_fingerprint": "content-2",
            "inventory_fingerprint": "files-2",
            "diagnostics": [],
            "failure": None,
        }

    def read():
        try:
            result.append(GPO._get_catalog(module, now=1000.0))
        except BaseException as exc:
            failures.append(exc)
        finally:
            completed.set()

    catalog.refresh_action = slow_refresh
    refresher = threading.Thread(target=GPO._refresh_catalog, args=(module, 20.0))
    reader = threading.Thread(target=read)
    try:
        refresher.start()
        assert entered.wait(2.0)
        reader.start()
        assert completed.wait(1.0), "A catalog read waited for the blocked refresh"
        assert not failures
        assert result[0][1]["generation"]["number"] == 1
    finally:
        release.set()
        refresher.join(3.0)
        if reader.ident is not None:
            reader.join(3.0)

    assert not refresher.is_alive()
    assert not reader.is_alive()
    _, after = GPO._get_catalog(module)
    assert after["generation"]["number"] == 2
    assert before["generation"]["number"] == 1
    assert result[0][1]["generation"]["number"] == 1


def test_concurrent_refresh_attempts_are_serialized_and_recheck_interval():
    module = binding()
    GPO._refresh_catalog(module, now=10.0)
    catalog, _ = GPO._get_catalog(module)
    entered = threading.Event()
    release = threading.Event()

    def refresh():
        entered.set()
        assert release.wait(5.0)
        return {
            "status": "unchanged",
            "previous_generation": 1,
            "current_generation": 1,
            "parse_performed": False,
            "content_fingerprint": "content-1",
            "inventory_fingerprint": "files-1",
            "diagnostics": [],
            "failure": None,
        }

    catalog.refresh_action = refresh
    first = threading.Thread(target=GPO._refresh_catalog, args=(module, 20.0))
    second = threading.Thread(target=GPO._refresh_catalog, args=(module, 20.0))
    try:
        first.start()
        assert entered.wait(2.0)
        second.start()
    finally:
        release.set()
        first.join(3.0)
        if second.ident is not None:
            second.join(3.0)

    assert not first.is_alive()
    assert not second.is_alive()
    assert catalog.refreshes == 1


def test_cold_non_server_fallback_constructs_once_and_is_structured_on_failure():
    factory = MagicMock(side_effect=Catalog)
    module = binding(factory)

    first, _ = GPO._get_catalog(module, now=10.0)
    second, _ = GPO._get_catalog(module, now=20.0)

    assert first is second
    factory.assert_called_once_with(str(GPO.GPO_TEMPLATE_ROOT), all_locales=True)

    GPO._reset_editor_globals_for_tests()
    broken = binding(MagicMock(side_effect=RuntimeError("initial load failed")))
    with pytest.raises(GPO.EditorFailure) as failure:
        GPO._get_catalog(broken, now=10.0)
    assert failure.value.category == "operational"
    assert GPO._catalog is None


def test_worker_monitor_preloads_and_duplicate_startup_does_not_spawn_twice(
    monkeypatch,
):
    monkeypatch.setattr(GPO, "GPO_CATALOG_REFRESH_INTERVAL", 60.0)
    factory = MagicMock(side_effect=Catalog)
    module = binding(factory)

    GPO._start_catalog_monitor(module)
    first_threads = [
        thread for thread in threading.enumerate()
        if thread is not threading.current_thread()
        and "catalog" in thread.name.lower()
    ]
    GPO._start_catalog_monitor(module)
    second_threads = [
        thread for thread in threading.enumerate()
        if thread in first_threads
    ]

    factory.assert_called_once_with(str(GPO.GPO_TEMPLATE_ROOT), all_locales=True)
    assert len(first_threads) == 1
    assert second_threads == first_threads
    assert first_threads[0].daemon
    assert GPO._get_catalog(module)[1]["generation"]["number"] == 1

    GPO._stop_catalog_monitor()
    assert not first_threads[0].is_alive()


def test_concurrent_monitor_startup_has_one_preload_and_one_thread():
    entered = threading.Event()
    release = threading.Event()
    factory = MagicMock()

    def construct(root, all_locales=False):
        entered.set()
        assert release.wait(5.0)
        return Catalog(root, all_locales)

    factory.side_effect = construct
    module = binding(factory)
    monitors = []
    failures = []

    def start():
        try:
            monitors.append(GPO._start_catalog_monitor(module))
        except BaseException as exc:
            failures.append(exc)

    first = threading.Thread(target=start)
    second = threading.Thread(target=start)
    try:
        first.start()
        assert entered.wait(2.0)
        second.start()
    finally:
        release.set()
        first.join(3.0)
        if second.ident is not None:
            second.join(3.0)

    assert not failures
    assert not first.is_alive()
    assert not second.is_alive()
    assert len(monitors) == 2
    assert monitors[0] is monitors[1]
    assert monitors[0].is_alive()
    assert factory.call_count == 1


def test_monitor_shutdown_joins_without_holding_the_publication_lock(monkeypatch):
    entered = threading.Event()
    release = threading.Event()
    shutdown_done = threading.Event()
    shutdown_failures = []
    catalog = Catalog(str(GPO.GPO_TEMPLATE_ROOT), all_locales=True)
    original_refresh = catalog.refresh_if_changed

    def refresh():
        entered.set()
        assert release.wait(5.0)
        catalog.refresh_action = None
        return original_refresh()

    catalog.refresh_action = refresh
    monkeypatch.setattr(GPO, "GPO_CATALOG_REFRESH_INTERVAL", 0.01)
    monitor = GPO._start_catalog_monitor(binding(lambda *a, **k: catalog))

    def stop():
        try:
            GPO._stop_catalog_monitor()
        except BaseException as exc:
            shutdown_failures.append(exc)
        finally:
            shutdown_done.set()

    stopper = threading.Thread(target=stop)
    try:
        assert entered.wait(2.0)
        stopper.start()
        release.set()
        assert shutdown_done.wait(2.0), "Monitor publication deadlocked with shutdown"
    finally:
        release.set()
        if stopper.ident is not None:
            stopper.join(3.0)
        monitor.join(3.0)

    assert not shutdown_failures
    assert not stopper.is_alive()
    assert not monitor.is_alive()


def test_initial_failure_does_not_break_startup_and_requests_do_not_retry_slowly(
    monkeypatch,
):
    monkeypatch.setattr(GPO, "GPO_CATALOG_REFRESH_INTERVAL", 0.01)
    initial_failed = threading.Event()
    retry_entered = threading.Event()
    release = threading.Event()
    loaded = threading.Event()
    calls = []

    def construct(root, all_locales=False):
        calls.append(threading.current_thread().name)
        if len(calls) == 1:
            initial_failed.set()
            raise RuntimeError("ADMX source is not available yet")
        retry_entered.set()
        assert release.wait(5.0), "Test did not release the background initial load"
        catalog = Catalog(root, all_locales)
        loaded.set()
        return catalog

    module = binding(construct)
    try:
        GPO._start_catalog_monitor(module)
        assert initial_failed.is_set()
        assert retry_entered.wait(2.0)
        with pytest.raises(GPO.EditorFailure) as failure:
            GPO._get_catalog(module)
        assert failure.value.category == "operational"
        assert len(calls) == 2
        assert calls[1] != threading.current_thread().name
    finally:
        release.set()
        assert loaded.wait(2.0)
        assert wait_until(lambda: GPO._catalog is not None)
        GPO._stop_catalog_monitor()

    assert GPO._get_catalog(module)[1]["generation"]["number"] == 1


def test_reset_stops_monitor_before_clearing_catalog(monkeypatch):
    monkeypatch.setattr(GPO, "GPO_CATALOG_REFRESH_INTERVAL", 60.0)
    module = binding()
    GPO._start_catalog_monitor(module)
    threads = [
        thread for thread in threading.enumerate()
        if thread is not threading.current_thread()
        and "catalog" in thread.name.lower()
    ]
    assert len(threads) == 1

    GPO._reset_editor_globals_for_tests()

    assert not threads[0].is_alive()
    assert GPO._catalog is None
    # Restarting after reset must obtain a fresh initial generation.
    GPO._start_catalog_monitor(module)
    assert GPO._get_catalog(module)[1]["generation"]["number"] == 1


def test_stopped_refresh_cannot_publish_metadata_after_shutdown():
    module = binding()
    GPO._refresh_catalog(module, now=10.0)
    catalog, before = GPO._get_catalog(module)
    entered = threading.Event()
    release = threading.Event()
    stopped = threading.Event()

    def refresh():
        entered.set()
        assert release.wait(5.0)
        catalog.number = 2
        return {
            "status": "changed",
            "previous_generation": 1,
            "current_generation": 2,
            "parse_performed": True,
            "content_fingerprint": "content-2",
            "inventory_fingerprint": "files-2",
            "diagnostics": [],
            "failure": None,
        }

    catalog.refresh_action = refresh
    refresher = threading.Thread(
        target=GPO._refresh_catalog,
        kwargs={"module": module, "now": 20.0, "stop_event": stopped},
    )
    try:
        refresher.start()
        assert entered.wait(2.0)
        stopped.set()
    finally:
        release.set()
        refresher.join(3.0)

    assert not refresher.is_alive()
    _, retained = GPO._get_catalog(module)
    assert retained["generation"] == before["generation"]


def test_workspace_envelope_generation_is_pinned_when_refresh_wins_a_race(
    monkeypatch,
):
    cached_state = {
        "generation": {
            "number": 1,
            "content_fingerprint": "content-1",
            "inventory_fingerprint": "files-1",
            "loaded_locales": ["en-US", "ru-RU"],
        },
        "diagnostics": [{"message": "old generation warning"}],
        "refresh": {"status": "failed", "current_generation": 1},
    }
    pinned_generation = {
        **cached_state["generation"],
        "number": 2,
        "content_fingerprint": "content-2",
        "inventory_fingerprint": "files-2",
    }
    workspace = SimpleNamespace(template_generation=lambda: pinned_generation)
    constructor = MagicMock(return_value=workspace)
    module = SimpleNamespace(GroupPolicyWorkspace=constructor)
    catalog = object()
    monkeypatch.setattr(GPO, "_load_admix", lambda: module)
    monkeypatch.setattr(
        GPO, "_get_catalog", lambda *args: (catalog, copy.deepcopy(cached_state))
    )
    context = SimpleNamespace(guid="test-guid", gpo_root=Path("/tmp/readonly-gpo"))

    opened, runtime = GPO._open_workspace(context, ["en-US"])

    assert opened is workspace
    assert runtime["catalog"]["generation"] == pinned_generation
    assert runtime["catalog"]["diagnostics"] == []
    assert runtime["catalog"]["refresh"] is None
    assert cached_state["generation"]["number"] == 1
    assert cached_state["diagnostics"] == [{"message": "old generation warning"}]
    assert constructor.call_args.kwargs["template_catalog"] is catalog


def test_removed_locale_retries_constructor_and_rebuilds_comment_paths(monkeypatch):
    stale_generation = {
        "number": 1,
        "content_fingerprint": "content-1",
        "inventory_fingerprint": "files-1",
        "loaded_locales": ["en-US", "ru-RU"],
    }
    current_generation = {
        **stale_generation,
        "number": 2,
        "content_fingerprint": "content-2",
        "inventory_fingerprint": "files-2",
        "loaded_locales": ["ru-RU"],
    }
    catalog = SimpleNamespace(generation=lambda: current_generation)
    cached = {"generation": stale_generation, "diagnostics": [], "refresh": None}
    constructions = []
    workspace = SimpleNamespace(template_generation=lambda: current_generation)

    def construct(root, **kwargs):
        constructions.append(copy.deepcopy(kwargs))
        if kwargs["locales"] != ["ru-RU"]:
            # The real constructor rejects an unavailable locale before returning
            # a workspace; a post-construction generation check cannot fix this.
            raise RuntimeError("requested locale is not loaded by the template catalog")
        return workspace

    module = SimpleNamespace(GroupPolicyWorkspace=construct)
    monkeypatch.setattr(GPO, "_load_admix", lambda: module)
    monkeypatch.setattr(GPO, "_get_catalog", lambda *args: (catalog, copy.deepcopy(cached)))
    context = SimpleNamespace(guid="test-guid", gpo_root=Path("/tmp/readonly-gpo"))

    opened, runtime = GPO._open_workspace(
        context, ["en-US", "ru-RU"], comment_scope="computer",
    )

    assert opened is workspace
    assert [kwargs["locales"] for kwargs in constructions] == [["en-US", "ru-RU"], ["ru-RU"]]
    assert constructions[1]["comments"]["locale_paths"] == {
        "ru-RU": "Machine/ru-RU/comment.cmtl",
    }
    assert runtime["locales"] == ["ru-RU"]
    assert runtime["catalog"]["generation"] == current_generation
    assert cached["generation"] == stale_generation


def test_unstable_locale_generations_have_a_bounded_retry_budget(monkeypatch):
    initial = {
        "number": 1,
        "content_fingerprint": "content-1",
        "inventory_fingerprint": "files-1",
        "loaded_locales": ["en-US"],
    }
    cached = {"generation": initial, "diagnostics": [], "refresh": None}
    calls = []
    catalog = SimpleNamespace(generation=lambda: initial)

    def construct(root, **kwargs):
        calls.append(list(kwargs["locales"]))
        loaded = ["ru-RU"] if kwargs["locales"] == ["en-US"] else ["en-US"]
        generation = {
            **initial,
            "number": len(calls) + 1,
            "loaded_locales": loaded,
        }
        return SimpleNamespace(template_generation=lambda: generation)

    monkeypatch.setattr(
        GPO, "_load_admix", lambda: SimpleNamespace(GroupPolicyWorkspace=construct)
    )
    monkeypatch.setattr(GPO, "_get_catalog", lambda *args: (catalog, copy.deepcopy(cached)))
    context = SimpleNamespace(guid="test-guid", gpo_root=Path("/tmp/readonly-gpo"))

    with pytest.raises(GPO.EditorFailure) as failure:
        GPO._open_workspace(context, ["en-US", "ru-RU"])

    assert failure.value.category == "operational"
    assert len(calls) == 3
    assert calls == [["en-US"], ["ru-RU"], ["en-US"]]


def test_workspace_constructor_failure_unrelated_to_locale_is_not_retried(monkeypatch):
    generation = {
        "number": 1,
        "content_fingerprint": "content-1",
        "inventory_fingerprint": "files-1",
        "loaded_locales": ["en-US"],
    }
    cached = {"generation": generation, "diagnostics": [], "refresh": None}
    catalog = SimpleNamespace(generation=lambda: generation)
    constructor = MagicMock(side_effect=RuntimeError("GPO storage is unavailable"))
    monkeypatch.setattr(
        GPO, "_load_admix", lambda: SimpleNamespace(GroupPolicyWorkspace=constructor)
    )
    monkeypatch.setattr(GPO, "_get_catalog", lambda *args: (catalog, copy.deepcopy(cached)))
    context = SimpleNamespace(guid="test-guid", gpo_root=Path("/tmp/readonly-gpo"))

    with pytest.raises(RuntimeError, match="GPO storage is unavailable"):
        GPO._open_workspace(context, ["en-US"])

    assert constructor.call_count == 1


@pytest.mark.parametrize("context, expected", [
    ("server", 1), ("cli", 0), ("installer", 0), ("unit_test", 0),
])
def test_only_server_plugin_finalization_starts_monitor(monkeypatch, context, expected):
    subject = object.__new__(GPO.gpo)
    env = SimpleNamespace(context=context)

    def merge(**values):
        for name, value in values.items():
            setattr(env, name, value)

    env._merge = merge
    monkeypatch.setattr(GPO.gpo, "env", env, raising=False)
    monkeypatch.setattr(GPO.LDAPObject, "_on_finalize", MagicMock())
    startup = MagicMock()
    monkeypatch.setattr(GPO, "_start_catalog_monitor", startup)

    GPO.gpo._on_finalize(subject)

    assert startup.call_count == expected
