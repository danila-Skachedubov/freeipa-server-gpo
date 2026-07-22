"""Opt-in publication integration tests against the local FreeIPA 389-DS.

These tests mutate the local server and are skipped unless both safeguards are
set explicitly::

    FREEIPA_GPO_RUN_389DS=1
    FREEIPA_GPO_INTEGRATION_ACK=CREATE_AND_DELETE_ISOLATED_GPOS

``FREEIPA_GPO_EXPECTED_DOMAIN`` is also required and must equal the configured
FreeIPA domain.  Each test creates a cryptographically unique GPO through the
normal ``gpo_add`` command and deletes that exact GPO in fixture teardown.  The
suite never looks up, opens, or mutates ``Test_Policy``.

Run this file alone, as root on a disposable/local FreeIPA test server, after
installing the current working tree.  The fixture uses FreeIPA's local root
LDAPI autobind for its isolated CRUD and publication checks; it does not read
or create administrator credentials.  Do not enable it in generic CI.
"""

from __future__ import annotations

import base64
import configparser
import hashlib
import json
import multiprocessing
import os
from pathlib import Path
import shutil
import uuid
import warnings

import pytest


ACKNOWLEDGEMENT = "CREATE_AND_DELETE_ISOLATED_GPOS"
OPTED_IN = (
    os.environ.get("FREEIPA_GPO_RUN_389DS") == "1"
    and os.environ.get("FREEIPA_GPO_INTEGRATION_ACK") == ACKNOWLEDGEMENT
)

pytestmark = pytest.mark.skipif(
    not OPTED_IN,
    reason=(
        "live 389-DS mutation is disabled; set the documented opt-in and "
        "acknowledgement variables"
    ),
)

POLICY_ID = "BaseALTKDE:kde-filesearch"
PARAMETER_ID = "kde-basicsettings_setter"
POLICY_DEFINITIONS = Path("/usr/share/PolicyDefinitions")
MACHINE_EXTENSION = (
    "[{35378EAC-683F-11D2-A89A-00C04FBBCFA2}"
    "{D02B1F72-3407-48AE-BA88-E8213C6761F1}]"
)
USER_EXTENSION = (
    "[{35378EAC-683F-11D2-A89A-00C04FBBCFA2}"
    "{D02B1F73-3407-48AE-BA88-E8213C6761F1}]"
)
ENVIRONMENT_FIELDS = [
    {
        "id": "properties.action",
        "value": {"kind": "action", "value": "update"},
    },
    {
        "id": "properties.name",
        "value": {"kind": "text", "value": "CODEX_GPO_INTEGRATION"},
    },
    {
        "id": "properties.value",
        "value": {"kind": "text", "value": "initial"},
    },
]
COMPUTER_FILTER_FIELDS = [
    {
        "id": "filter.bool",
        "value": {"kind": "filter_combine", "value": "and"},
    },
    {
        "id": "filter.not",
        "value": {"kind": "boolean", "value": False},
    },
    {
        "id": "filter.type",
        "value": {"kind": "text", "value": "NETBIOS"},
    },
    {
        "id": "filter.name",
        "value": {"kind": "text", "value": "DC1"},
    },
]


def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _gpt_version(path: Path) -> int:
    document = configparser.ConfigParser()
    document.read_string(path.read_text(encoding="utf-8"))
    return document.getint("General", "Version")


def _single(value):
    if isinstance(value, (list, tuple)):
        assert len(value) == 1
        return value[0]
    return value


def _enabled_fixed_element_parameters(policy):
    """Mirror the UI's default materialization for an Enabled transition."""
    parameters = []
    explicit_parameter_found = False
    for parameter in policy["parameters"]:
        parameter_id = parameter["id"]
        if parameter_id == PARAMETER_ID:
            value = {"kind": "boolean", "value": False}
            explicit_parameter_found = True
        else:
            value = parameter.get("default_value")
            if value is None or value.get("kind") == "unsupported":
                continue
        parameters.append({
            "parameter_id": parameter_id,
            "value": value,
        })

    assert explicit_parameter_found
    return parameters


def _publication_plan(snapshot, target_version, machine, user):
    return {
        "identity": dict(snapshot["identity"]),
        "expected_version": snapshot["version_number"],
        "target_version": target_version,
        "machine_extension_names": machine,
        "user_extension_names": user,
        "idempotency_token": str(uuid.uuid4()),
        "affected_scopes": {"computer": True, "user": True},
    }


def _write_worker_result(path, payload):
    """Persist child-process evidence before an intentional hard exit."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as stream:
        json.dump(payload, stream, sort_keys=True)
        stream.flush()
        os.fsync(stream.fileno())


def _concurrent_publication_worker(
    role,
    gpo_root,
    state_directory,
    state_key,
    snapshot,
    parameter_value,
    ready,
    publisher_finished,
    result_path,
):
    """Run one independently opened libadmix workspace in a spawned process."""
    from admix import AdmixError, HighLevelApi, TemplateCatalog

    try:
        catalog = TemplateCatalog(
            str(POLICY_DEFINITIONS), all_locales=True
        )
        workspace = HighLevelApi(
            str(gpo_root),
            template_catalog=catalog,
            locales=["en-US"],
            load_preferences=False,
            state_directory=str(state_directory),
            state_key=state_key,
        )
        updated = workspace.update_policy(
            "computer",
            POLICY_ID,
            state="enabled",
            set_parameters=[{
                "parameter_id": PARAMETER_ID,
                "value": {
                    "kind": "boolean",
                    "value": parameter_value,
                },
            }],
            locales=["en-US"],
        )
        if not updated["dirty"]:
            raise RuntimeError("spawned workspace did not become dirty")

        # Both processes must hold a workspace opened against the same file
        # revisions before either one is allowed to commit.
        ready.wait(timeout=45)
        if role == "publisher":
            committed = workspace.commit_external(snapshot)
            pending = workspace.pending_external_publication()
            if pending is None:
                raise RuntimeError("external commit did not persist pending state")
            _write_worker_result(result_path, {
                "status": "committed",
                "publication_plan": committed["publication_plan"],
                "pending": pending,
            })
            publisher_finished.set()

            # Deliberately bypass Python and Rust object destructors.  The
            # parent must recover only from the durable record written by
            # commit_external(), exactly as after abrupt worker termination.
            os._exit(0)

        if role != "stale":
            raise RuntimeError("unknown spawned worker role: {}".format(role))
        if not publisher_finished.wait(timeout=45):
            raise RuntimeError("publisher did not finish before timeout")
        try:
            committed = workspace.commit_external(snapshot)
        except AdmixError as exc:
            _write_worker_result(result_path, {
                "status": "admix_error",
                "code": exc.code,
                "field": exc.field,
                "path": exc.path,
            })
        else:
            _write_worker_result(result_path, {
                "status": "unexpected_commit",
                "publication_plan": committed["publication_plan"],
            })
    except BaseException as exc:
        if role == "publisher":
            publisher_finished.set()
        _write_worker_result(result_path, {
            "status": "worker_failure",
            "exception": type(exc).__name__,
            "message": str(exc),
        })
        raise


def _fresh_freeipa_worker(expected_domain, state_directory):
    """Bootstrap one installed FreeIPA server API in a spawned process."""
    from ipalib import api
    from ipaplatform.paths import paths

    if not api.isdone("bootstrap"):
        api.bootstrap(
            in_server=True,
            debug=False,
            context="installer",
            confdir=paths.ETC_IPA,
        )
    if not api.isdone("finalize"):
        api.finalize()
    if str(api.env.domain).lower() != str(expected_domain).lower():
        raise RuntimeError("spawned FreeIPA worker domain does not match")

    from ipaserver.plugins import gpo as plugin

    plugin.GPO_EDITOR_STATE_DIRECTORY = Path(state_directory)
    if not api.Backend.ldap2.isconnected():
        api.Backend.ldap2.connect()
    return api, plugin


def _snapshot_evidence(snapshot):
    identity = snapshot.get("identity") or {}
    return {
        "guid": identity.get("guid"),
        "version_number": snapshot.get("version_number"),
        "machine_extension_names": snapshot.get(
            "machine_extension_names", ""
        ),
        "user_extension_names": snapshot.get("user_extension_names", ""),
    }


def _fresh_freeipa_policy_race_worker(
    role,
    expected_domain,
    displayname,
    state_directory,
    parameter_value,
    ready,
    winner_finished,
    result_path,
):
    """Invoke policy_update from one fresh, barrier-controlled IPA worker."""
    api = None
    try:
        api, plugin = _fresh_freeipa_worker(
            expected_domain, state_directory
        )
        original_recovery = plugin._recover_before_mutation
        recovery_evidence = {}

        def synchronized_recovery(workspace, ldap_backend, context):
            recovered = original_recovery(workspace, ldap_backend, context)
            recovery_evidence["kind"] = recovered[0]["kind"]
            # Both command workers have opened independent workspaces and
            # completed the normal pending-state recovery check at this point.
            ready.wait(timeout=45)
            if role == "stale" and not winner_finished.wait(timeout=45):
                raise RuntimeError("winning FreeIPA worker did not finish")
            return recovered

        plugin._recover_before_mutation = synchronized_recovery
        try:
            response = api.Command.gpo_editor_policy_update(
                displayname,
                "computer",
                POLICY_ID,
                request={
                    "state": "enabled",
                    "set_parameters": [{
                        "parameter_id": PARAMETER_ID,
                        "value": {
                            "kind": "boolean",
                            "value": parameter_value,
                        },
                    }],
                },
                locales=["en-US"],
            )["result"]
        except Exception as exc:
            error = getattr(exc, "kw", {}) or {}
            _write_worker_result(result_path, {
                "status": "command_error",
                "recovery_kind": recovery_evidence.get("kind"),
                "category": error.get("error_category"),
                "exception": type(exc).__name__,
                "message": str(exc),
            })
        else:
            publication = response["publication"]
            _write_worker_result(result_path, {
                "status": "success",
                "recovery_kind": recovery_evidence.get("kind"),
                "changed": publication["changed"],
                "pending_publication": publication["pending_publication"],
                "snapshot": _snapshot_evidence(publication["snapshot"]),
            })
    except BaseException as exc:
        _write_worker_result(result_path, {
            "status": "worker_failure",
            "exception": type(exc).__name__,
            "message": str(exc),
        })
        raise
    finally:
        if role == "winner":
            winner_finished.set()
        if api is not None and api.Backend.ldap2.isconnected():
            api.Backend.ldap2.disconnect()


def _fresh_freeipa_exit_after_ldap_worker(
    expected_domain,
    displayname,
    state_directory,
    result_path,
):
    """Hard-exit an IPA command after LDAP modify and before acknowledge."""
    api = None
    try:
        api, plugin = _fresh_freeipa_worker(
            expected_domain, state_directory
        )

        def exit_instead_of_acknowledging(workspace, plan, snapshot):
            pending = workspace.pending_external_publication()
            _write_worker_result(result_path, {
                "status": "ldap_published_unacknowledged",
                "plan": {
                    "idempotency_token": plan["idempotency_token"],
                    "expected_version": plan["expected_version"],
                    "target_version": plan["target_version"],
                    "machine_extension_names": plan[
                        "machine_extension_names"
                    ],
                    "user_extension_names": plan["user_extension_names"],
                    "identity_guid": plan["identity"]["guid"],
                },
                "snapshot": _snapshot_evidence(snapshot),
                "pending_phase": (
                    pending.get("phase") if pending is not None else None
                ),
            })
            # Bypass command cleanup and object destructors just after the
            # directory result is durable, leaving the pending record intact.
            os._exit(0)

        plugin._acknowledge_publication = exit_instead_of_acknowledging
        response = api.Command.gpo_editor_policy_update(
            displayname,
            "computer",
            POLICY_ID,
            request={
                "state": "enabled",
                "set_parameters": [{
                    "parameter_id": PARAMETER_ID,
                    "value": {"kind": "boolean", "value": False},
                }],
            },
            locales=["en-US"],
        )
        _write_worker_result(result_path, {
            "status": "unexpected_command_return",
            "summary": response.get("summary"),
        })
    except BaseException as exc:
        _write_worker_result(result_path, {
            "status": "worker_failure",
            "exception": type(exc).__name__,
            "message": str(exc),
        })
        raise
    finally:
        if api is not None and api.Backend.ldap2.isconnected():
            api.Backend.ldap2.disconnect()


def _fresh_freeipa_reconcile_worker(
    expected_domain,
    displayname,
    state_directory,
    result_path,
):
    """Invoke public reconciliation from a separate fresh IPA process."""
    api = None
    try:
        api, _plugin = _fresh_freeipa_worker(
            expected_domain, state_directory
        )
        result = api.Command.gpo_editor_reconcile(displayname)["result"]
        _write_worker_result(result_path, {
            "status": "success",
            "recovery_kind": result["recovery"]["kind"],
            "pending_publication": result["pending_publication"],
            "snapshot": _snapshot_evidence(result["snapshot"]),
        })
    except BaseException as exc:
        _write_worker_result(result_path, {
            "status": "worker_failure",
            "exception": type(exc).__name__,
            "message": str(exc),
        })
        raise
    finally:
        if api is not None and api.Backend.ldap2.isconnected():
            api.Backend.ldap2.disconnect()


def _state_tree_manifest(root):
    """Describe a private state tree without exposing its record contents."""
    root = Path(root)
    assert root.is_dir() and not root.is_symlink()
    manifest = {
        ".": {
            "kind": "directory",
            "mode": root.stat().st_mode & 0o777,
        }
    }
    for path in sorted(root.rglob("*")):
        assert not path.is_symlink()
        relative = str(path.relative_to(root))
        mode = path.stat().st_mode & 0o777
        if path.is_dir():
            manifest[relative] = {"kind": "directory", "mode": mode}
        elif path.is_file():
            manifest[relative] = {
                "kind": "file",
                "mode": mode,
                "digest": _digest(path),
            }
        else:
            raise AssertionError("unexpected state-tree entry: {}".format(path))
    return manifest


class _LiveServer:
    def __init__(self, api, plugin):
        self.api = api
        self.plugin = plugin
        self.ldap = api.Backend.ldap2
        self.created = []

    def create_gpo(self):
        # The random name is recorded before creation so teardown can recover
        # safely even if the oddjob-backed post-callback fails halfway through.
        displayname = "codex-integration-{}".format(uuid.uuid4().hex)
        record = {"displayname": displayname, "guid": None}
        self.created.append(record)

        result = self.api.Command.gpo_add(displayname)
        record["guid"] = self.plugin._canonical_guid(
            _single(result["result"]["cn"])
        )
        context = self.plugin._resolve_editor_context(
            self.ldap, self.api, displayname, write=True
        )
        assert context.guid == record["guid"]
        assert context.displayname != "Test_Policy"
        return context

    def _entry_if_present(self, displayname):
        try:
            return self.api.Object.gpo.find_gpo_by_displayname(
                self.ldap, displayname
            )
        except Exception as exc:
            from ipalib import errors

            if isinstance(exc, errors.NotFound):
                return None
            raise

    def cleanup(self):
        failures = []
        for record in reversed(self.created):
            displayname = record["displayname"]
            entry = self._entry_if_present(displayname)
            if entry is None:
                continue
            guid = self.plugin._canonical_guid(_single(entry["cn"]))
            if record["guid"] is not None and guid != record["guid"]:
                failures.append(
                    "refused cleanup after GUID mismatch for {}".format(
                        displayname
                    )
                )
                continue

            try:
                self.api.Command.gpo_del(displayname)
                policy_path = (
                    self.plugin.GPO_SYSVOL_ROOT
                    / str(self.api.env.domain).lower()
                    / "Policies"
                    / guid
                )
                if policy_path.exists() or policy_path.is_symlink():
                    self.api.Object.gpo._call_dbus_method(
                        "delete_gpo_structure",
                        guid,
                        str(self.api.env.domain).lower(),
                        fail_on_error=True,
                    )
                continue
            except Exception as exc:
                warnings.warn(
                    "normal cleanup failed for {}; using exact-object "
                    "fallback: {}".format(displayname, exc),
                    RuntimeWarning,
                )

            # Fallback is deliberately bounded to the exact random entry.  The
            # filesystem helper validates the canonical GUID and domain again.
            try:
                self.api.Object.gpo._call_dbus_method(
                    "delete_gpo_structure",
                    guid,
                    str(self.api.env.domain).lower(),
                    fail_on_error=True,
                )
                self.ldap.delete_entry(entry)
            except Exception as exc:
                failures.append("{}: {}".format(displayname, exc))

        if failures:
            raise RuntimeError(
                "isolated GPO cleanup failed: {}".format("; ".join(failures))
            )


@pytest.fixture(scope="module")
def live_server():
    if os.geteuid() != 0:
        pytest.fail("live 389-DS integration tests must run as root")

    expected_domain = os.environ.get("FREEIPA_GPO_EXPECTED_DOMAIN")
    if not expected_domain:
        pytest.fail("FREEIPA_GPO_EXPECTED_DOMAIN is required")

    from ipalib import api
    from ipaplatform.paths import paths

    if not api.isdone("bootstrap"):
        api.bootstrap(
            in_server=True,
            debug=False,
            context="installer",
            confdir=paths.ETC_IPA,
        )
    if not api.isdone("finalize"):
        api.finalize()

    actual_domain = str(api.env.domain).lower()
    if actual_domain != expected_domain.lower():
        pytest.fail(
            "refusing live mutation: configured domain {!r} does not match "
            "FREEIPA_GPO_EXPECTED_DOMAIN {!r}".format(
                actual_domain, expected_domain
            )
        )

    from ipaserver.plugins import gpo as plugin

    from ipa_gpo_install import filesystem as filesystem_helper

    state_healthy, state_reason = (
        filesystem_helper.editor_state_directory_status()
    )
    if not state_healthy:
        pytest.fail(
            "editor state directory preflight failed: {}".format(state_reason)
        )

    catalog, catalog_state = plugin._get_catalog()
    if catalog_state["diagnostics"]:
        pytest.fail(
            "template catalog diagnostics must be resolved before live tests: "
            "{}".format(catalog_state["diagnostics"])
        )
    # Catalog parsing is checked before anything is created.  The specific
    # policy is opened only inside the isolated GPO used by the recovery test.
    assert catalog is not None

    connected_here = False
    if not api.Backend.ldap2.isconnected():
        api.Backend.ldap2.connect()
        connected_here = True

    server = _LiveServer(api, plugin)
    try:
        yield server
    finally:
        try:
            server.cleanup()
        finally:
            if connected_here and api.Backend.ldap2.isconnected():
                api.Backend.ldap2.disconnect()


def test_atomic_cas_success_conflict_and_absent_attributes(live_server):
    plugin = live_server.plugin
    ldap_backend = live_server.ldap
    context = live_server.create_gpo()
    gpt_ini = context.gpo_root / "GPT.INI"
    machine_registry = context.gpo_root / "Machine/Registry.pol"
    user_registry = context.gpo_root / "User/Registry.pol"
    initial_gpt = gpt_ini.read_bytes()
    assert not machine_registry.exists()
    assert not user_registry.exists()

    initial, initial_presence = plugin._read_gpc_snapshot(
        ldap_backend, context
    )
    assert initial_presence["machine_extension_names"] is False
    assert initial_presence["user_extension_names"] is False

    success_plan = _publication_plan(
        initial,
        initial["version_number"] + 1,
        MACHINE_EXTENSION,
        USER_EXTENSION,
    )
    plugin._apply_publication_plan(
        ldap_backend,
        context,
        success_plan,
        initial,
        initial_presence,
    )
    published, published_presence = plugin._read_gpc_snapshot(
        ldap_backend, context
    )
    assert published["version_number"] == success_plan["target_version"]
    assert published["machine_extension_names"] == MACHINE_EXTENSION
    assert published["user_extension_names"] == USER_EXTENSION
    assert published_presence["machine_extension_names"] is True
    assert published_presence["user_extension_names"] is True

    stale = published
    stale_presence = published_presence
    competing_version = published["version_number"] + 17
    ldap_backend.conn.modify_ext_s(
        str(context.dn),
        [(
            plugin._ldap.MOD_REPLACE,
            "versionNumber",
            plugin._ldap_value(ldap_backend, competing_version),
        )],
    )
    remove_cache_entry = getattr(ldap_backend, "remove_cache_entry", None)
    if remove_cache_entry is not None:
        remove_cache_entry(context.dn)

    stale_plan = _publication_plan(
        stale,
        stale["version_number"] + 1,
        "would-overwrite-machine",
        "would-overwrite-user",
    )
    with pytest.raises(plugin.EditorFailure) as conflict:
        plugin._apply_publication_plan(
            ldap_backend,
            context,
            stale_plan,
            stale,
            stale_presence,
        )
    assert conflict.value.category == "publication_conflict"
    assert "version" in conflict.value.details["conflict_fields"]

    observed, _ = plugin._read_gpc_snapshot(ldap_backend, context)
    assert observed["version_number"] == competing_version
    assert observed["machine_extension_names"] == MACHINE_EXTENSION
    assert observed["user_extension_names"] == USER_EXTENSION
    # The losing LDAP publication cannot have any side effect on SYSVOL.  This
    # test starts with no policy payload, so absence is part of the invariant.
    assert gpt_ini.read_bytes() == initial_gpt
    assert not machine_registry.exists()
    assert not user_registry.exists()


def test_libadmix_commit_recovers_before_and_after_ldap_modify(
    live_server, tmp_path
):
    from admix import HighLevelApi

    plugin = live_server.plugin
    ldap_backend = live_server.ldap
    context = live_server.create_gpo()
    catalog, _ = plugin._get_catalog()
    state_directory = tmp_path / "publication-state"

    def workspace():
        return HighLevelApi(
            str(context.gpo_root),
            template_catalog=catalog,
            locales=["en-US"],
            load_preferences=False,
            state_directory=str(state_directory),
            state_key=context.guid,
        )

    clean_snapshot, _ = plugin._read_gpc_snapshot(ldap_backend, context)
    gpt_ini = context.gpo_root / "GPT.INI"
    clean_gpt = gpt_ini.read_bytes()
    clean_workspace = workspace()
    no_op = plugin._commit_external_once(
        clean_workspace, ldap_backend, context
    )
    assert no_op["changed"] is False
    assert no_op["pending_publication"] is None
    assert clean_workspace.pending_external_publication() is None
    assert no_op["snapshot"]["version_number"] == (
        clean_snapshot["version_number"]
    )
    assert gpt_ini.read_bytes() == clean_gpt

    before_files, _ = plugin._read_gpc_snapshot(ldap_backend, context)
    first = workspace()
    changed = first.update_policy(
        "computer",
        POLICY_ID,
        state="enabled",
        set_parameters=[{
            "parameter_id": PARAMETER_ID,
            "value": {"kind": "boolean", "value": False},
        }],
        locales=["en-US"],
    )
    assert changed["dirty"] is True
    committed = first.commit_external(before_files)
    first_plan = committed["publication_plan"]
    assert committed["files"]["paths"]
    assert first.pending_external_publication() is not None

    # Simulate process termination after the file commit but before LDAP.
    recovered_before_ldap = workspace()
    action, after_first = plugin._reconcile_workspace(
        recovered_before_ldap, ldap_backend, context
    )
    assert action["kind"] == "apply"
    assert after_first["version_number"] == first_plan["target_version"]
    assert recovered_before_ldap.pending_external_publication() is None

    second = workspace()
    changed_again = second.update_policy(
        "computer",
        POLICY_ID,
        set_parameters=[{
            "parameter_id": PARAMETER_ID,
            "value": {"kind": "boolean", "value": True},
        }],
        locales=["en-US"],
    )
    assert changed_again["dirty"] is True
    before_second, before_second_presence = plugin._read_gpc_snapshot(
        ldap_backend, context
    )
    committed_again = second.commit_external(before_second)
    second_plan = committed_again["publication_plan"]
    plugin._apply_publication_plan(
        ldap_backend,
        context,
        second_plan,
        before_second,
        before_second_presence,
    )
    assert second.pending_external_publication() is not None

    # Simulate process termination after LDAP but before acknowledge_external.
    recovered_after_ldap = workspace()
    action, after_second = plugin._reconcile_workspace(
        recovered_after_ldap, ldap_backend, context
    )
    assert action["kind"] == "acknowledge"
    assert after_second["version_number"] == second_plan["target_version"]
    assert recovered_after_ldap.pending_external_publication() is None


def test_spawned_workers_recover_backed_up_pending_publication_once(
    live_server, tmp_path
):
    from admix import HighLevelApi

    plugin = live_server.plugin
    ldap_backend = live_server.ldap
    context = live_server.create_gpo()
    catalog, _ = plugin._get_catalog()
    initial, _ = plugin._read_gpc_snapshot(ldap_backend, context)

    # Separate state subdirectories let this scenario reach the shared-payload
    # revision check.  The production shared state key adds another guard, but
    # would turn the stale worker into publication_pending before that check.
    state_root = tmp_path / "spawned-worker-state"
    publisher_state = state_root / "publisher"
    stale_state = state_root / "stale"
    publisher_result_path = tmp_path / "publisher-result.json"
    stale_result_path = tmp_path / "stale-result.json"

    process_context = multiprocessing.get_context("spawn")
    ready = process_context.Barrier(3)
    publisher_finished = process_context.Event()
    publisher = process_context.Process(
        name="gpo-integration-publisher",
        target=_concurrent_publication_worker,
        args=(
            "publisher",
            context.gpo_root,
            publisher_state,
            context.guid,
            initial,
            False,
            ready,
            publisher_finished,
            publisher_result_path,
        ),
    )
    stale = process_context.Process(
        name="gpo-integration-stale-worker",
        target=_concurrent_publication_worker,
        args=(
            "stale",
            context.gpo_root,
            stale_state,
            context.guid,
            initial,
            True,
            ready,
            publisher_finished,
            stale_result_path,
        ),
    )
    processes = [publisher, stale]
    try:
        for process in processes:
            process.start()
        # Releasing this barrier proves both processes opened and dirtied
        # independent workspaces before the publisher changed the payload.
        ready.wait(timeout=45)
        for process in processes:
            process.join(timeout=45)
    finally:
        for process in processes:
            if process.is_alive():
                process.terminate()
                process.join(timeout=10)

    publisher_result = (
        json.loads(publisher_result_path.read_text(encoding="utf-8"))
        if publisher_result_path.is_file()
        else None
    )
    stale_result = (
        json.loads(stale_result_path.read_text(encoding="utf-8"))
        if stale_result_path.is_file()
        else None
    )
    assert publisher.exitcode == 0, publisher_result
    assert stale.exitcode == 0, stale_result
    assert publisher_result is not None
    assert publisher_result["status"] == "committed"
    assert publisher_result["pending"]["phase"] == (
        "awaiting_directory_publication"
    )
    assert stale_result is not None
    assert stale_result["status"] == "admix_error"
    assert stale_result["code"] == "conflict"
    assert stale_result["field"] is None
    assert stale_result["path"] in {"Machine/Registry.pol", "GPT.INI"}

    plan = publisher_result["publication_plan"]
    assert plan["target_version"] == initial["version_number"] + 1
    assert plan["machine_extension_names"] == MACHINE_EXTENSION
    assert plan["user_extension_names"] == ""
    assert publisher_result["pending"]["plan"]["idempotency_token"] == (
        plan["idempotency_token"]
    )
    gpt_ini = context.gpo_root / "GPT.INI"
    machine_registry = context.gpo_root / "Machine/Registry.pol"
    user_registry = context.gpo_root / "User/Registry.pol"
    assert machine_registry.is_file()
    assert not user_registry.exists()
    conflicted_gpt = gpt_ini.read_bytes()
    conflicted_machine_digest = _digest(machine_registry)
    assert _gpt_version(gpt_ini) == plan["target_version"]
    before_recovery, _ = plugin._read_gpc_snapshot(ldap_backend, context)
    assert before_recovery == initial

    # Back up the quiescent durable record after the publisher's hard exit,
    # restore it twice, and prove both restored copies describe the same exact
    # attempt.  All paths are beneath pytest's private temporary directory.
    pending_backup = tmp_path / "pending-state-backup"
    apply_restore = tmp_path / "pending-state-restore-apply"
    duplicate_restore = tmp_path / "pending-state-restore-duplicate"
    shutil.copytree(publisher_state, pending_backup, copy_function=shutil.copy2)
    shutil.copytree(pending_backup, apply_restore, copy_function=shutil.copy2)
    shutil.copytree(
        pending_backup,
        duplicate_restore,
        copy_function=shutil.copy2,
    )
    expected_manifest = _state_tree_manifest(publisher_state)
    assert _state_tree_manifest(pending_backup) == expected_manifest
    assert _state_tree_manifest(apply_restore) == expected_manifest
    assert _state_tree_manifest(duplicate_restore) == expected_manifest

    def workspace(state_directory):
        return HighLevelApi(
            str(context.gpo_root),
            template_catalog=catalog,
            locales=["en-US"],
            load_preferences=False,
            state_directory=str(state_directory),
            state_key=context.guid,
        )

    recovered = workspace(apply_restore)
    recovered_pending = recovered.pending_external_publication()
    assert recovered_pending is not None
    assert recovered_pending["plan"]["idempotency_token"] == (
        plan["idempotency_token"]
    )
    action, after_apply = plugin._reconcile_workspace(
        recovered, ldap_backend, context
    )
    assert action["kind"] == "apply"
    assert after_apply["version_number"] == plan["target_version"]
    assert after_apply["machine_extension_names"] == MACHINE_EXTENSION
    assert after_apply["user_extension_names"] == ""
    assert gpt_ini.read_bytes() == conflicted_gpt
    assert _digest(machine_registry) == conflicted_machine_digest
    assert not user_registry.exists()
    assert recovered.pending_external_publication() is None

    # A second restored copy of the same pending attempt must acknowledge the
    # already-published result.  It must not apply a second version increment.
    before_duplicate, _ = plugin._read_gpc_snapshot(ldap_backend, context)
    duplicate = workspace(duplicate_restore)
    duplicate_pending = duplicate.pending_external_publication()
    assert duplicate_pending is not None
    assert duplicate_pending["plan"]["idempotency_token"] == (
        plan["idempotency_token"]
    )
    duplicate_action, after_duplicate = plugin._reconcile_workspace(
        duplicate, ldap_backend, context
    )
    final, _ = plugin._read_gpc_snapshot(ldap_backend, context)
    assert duplicate_action["kind"] == "acknowledge"
    assert before_duplicate == after_duplicate == final
    assert final["version_number"] == plan["target_version"]
    assert final["machine_extension_names"] == MACHINE_EXTENSION
    assert final["user_extension_names"] == ""
    assert gpt_ini.read_bytes() == conflicted_gpt
    assert _gpt_version(gpt_ini) == plan["target_version"]
    assert _digest(machine_registry) == conflicted_machine_digest
    assert not user_registry.exists()
    assert duplicate.pending_external_publication() is None


def test_fresh_freeipa_command_workers_resolve_one_policy_update_race(
    live_server, tmp_path, monkeypatch
):
    plugin = live_server.plugin
    context = live_server.create_gpo()
    state_directory = tmp_path / "shared-command-race-state"
    state_directory.mkdir(mode=0o700)
    monkeypatch.setattr(
        plugin, "GPO_EDITOR_STATE_DIRECTORY", state_directory
    )
    initial, _ = plugin._read_gpc_snapshot(live_server.ldap, context)

    process_context = multiprocessing.get_context("spawn")
    ready = process_context.Barrier(3)
    winner_finished = process_context.Event()
    winner_result_path = tmp_path / "command-race-winner.json"
    stale_result_path = tmp_path / "command-race-stale.json"
    common = (
        str(live_server.api.env.domain),
        context.displayname,
        state_directory,
    )
    winner = process_context.Process(
        name="gpo-command-race-winner",
        target=_fresh_freeipa_policy_race_worker,
        args=(
            "winner",
            *common,
            False,
            ready,
            winner_finished,
            winner_result_path,
        ),
    )
    stale = process_context.Process(
        name="gpo-command-race-stale",
        target=_fresh_freeipa_policy_race_worker,
        args=(
            "stale",
            *common,
            True,
            ready,
            winner_finished,
            stale_result_path,
        ),
    )
    processes = [winner, stale]
    try:
        for process in processes:
            process.start()
        # The child hook reaches this barrier only after each public command
        # has opened its workspace and completed recovery against shared state.
        ready.wait(timeout=45)
        for process in processes:
            process.join(timeout=45)
    finally:
        for process in processes:
            if process.is_alive():
                process.terminate()
                process.join(timeout=10)

    winner_result = (
        json.loads(winner_result_path.read_text(encoding="utf-8"))
        if winner_result_path.is_file()
        else None
    )
    stale_result = (
        json.loads(stale_result_path.read_text(encoding="utf-8"))
        if stale_result_path.is_file()
        else None
    )
    assert winner.exitcode == 0, winner_result
    assert stale.exitcode == 0, stale_result
    assert winner_result is not None
    assert stale_result is not None
    assert [winner_result["status"], stale_result["status"]].count(
        "success"
    ) == 1
    assert winner_result["status"] == "success"
    assert winner_result["recovery_kind"] == "clean"
    assert winner_result["changed"] is True
    assert winner_result["pending_publication"] is None
    assert stale_result["status"] == "command_error"
    assert stale_result["recovery_kind"] == "clean"
    assert stale_result["category"] == "storage_conflict"

    target_version = initial["version_number"] + 1
    winner_snapshot = winner_result["snapshot"]
    assert winner_snapshot["guid"] == context.guid
    assert winner_snapshot["version_number"] == target_version
    assert winner_snapshot["machine_extension_names"] == MACHINE_EXTENSION
    assert winner_snapshot["user_extension_names"] == ""
    observed, presence = plugin._read_gpc_snapshot(
        live_server.ldap, context
    )
    assert observed["version_number"] == target_version
    assert observed["machine_extension_names"] == MACHINE_EXTENSION
    assert observed["user_extension_names"] == ""
    assert presence["machine_extension_names"] is True
    assert presence["user_extension_names"] is False
    assert _gpt_version(context.gpo_root / "GPT.INI") == target_version
    assert (context.gpo_root / "Machine/Registry.pol").is_file()
    assert not (context.gpo_root / "User/Registry.pol").exists()

    opened = live_server.api.Command.gpo_editor_open(
        context.displayname, locales=["en-US"]
    )["result"]
    assert opened["pending_publication"] is None
    assert opened["snapshot"]["version_number"] == target_version


def test_fresh_freeipa_command_recovers_hard_exit_after_ldap_once(
    live_server, tmp_path, monkeypatch
):
    plugin = live_server.plugin
    context = live_server.create_gpo()
    state_directory = tmp_path / "after-ldap-command-state"
    state_directory.mkdir(mode=0o700)
    monkeypatch.setattr(
        plugin, "GPO_EDITOR_STATE_DIRECTORY", state_directory
    )
    initial, _ = plugin._read_gpc_snapshot(live_server.ldap, context)
    expected_domain = str(live_server.api.env.domain)
    process_context = multiprocessing.get_context("spawn")

    crash_result_path = tmp_path / "after-ldap-hard-exit.json"
    crashing_worker = process_context.Process(
        name="gpo-command-exit-after-ldap",
        target=_fresh_freeipa_exit_after_ldap_worker,
        args=(
            expected_domain,
            context.displayname,
            state_directory,
            crash_result_path,
        ),
    )
    try:
        crashing_worker.start()
        crashing_worker.join(timeout=45)
    finally:
        if crashing_worker.is_alive():
            crashing_worker.terminate()
            crashing_worker.join(timeout=10)

    crash_result = (
        json.loads(crash_result_path.read_text(encoding="utf-8"))
        if crash_result_path.is_file()
        else None
    )
    assert crashing_worker.exitcode == 0, crash_result
    assert crash_result is not None
    assert crash_result["status"] == "ldap_published_unacknowledged"
    assert crash_result["pending_phase"] == "awaiting_directory_publication"
    plan = crash_result["plan"]
    target_version = initial["version_number"] + 1
    assert plan["identity_guid"] == context.guid
    assert plan["expected_version"] == initial["version_number"]
    assert plan["target_version"] == target_version
    assert plan["machine_extension_names"] == MACHINE_EXTENSION
    assert plan["user_extension_names"] == ""
    assert crash_result["snapshot"] == {
        "guid": context.guid,
        "version_number": target_version,
        "machine_extension_names": MACHINE_EXTENSION,
        "user_extension_names": "",
    }

    after_crash, _ = plugin._read_gpc_snapshot(live_server.ldap, context)
    assert _snapshot_evidence(after_crash) == crash_result["snapshot"]
    gpt_ini = context.gpo_root / "GPT.INI"
    machine_registry = context.gpo_root / "Machine/Registry.pol"
    user_registry = context.gpo_root / "User/Registry.pol"
    assert _gpt_version(gpt_ini) == target_version
    assert machine_registry.is_file()
    assert not user_registry.exists()
    published_gpt = gpt_ini.read_bytes()
    published_machine_digest = _digest(machine_registry)

    reconcile_result_path = tmp_path / "fresh-command-reconcile.json"
    reconciling_worker = process_context.Process(
        name="gpo-command-reconcile-after-exit",
        target=_fresh_freeipa_reconcile_worker,
        args=(
            expected_domain,
            context.displayname,
            state_directory,
            reconcile_result_path,
        ),
    )
    try:
        reconciling_worker.start()
        reconciling_worker.join(timeout=45)
    finally:
        if reconciling_worker.is_alive():
            reconciling_worker.terminate()
            reconciling_worker.join(timeout=10)

    reconcile_result = (
        json.loads(reconcile_result_path.read_text(encoding="utf-8"))
        if reconcile_result_path.is_file()
        else None
    )
    assert reconciling_worker.exitcode == 0, reconcile_result
    assert reconcile_result is not None
    assert reconcile_result["status"] == "success"
    assert reconcile_result["recovery_kind"] == "acknowledge"
    assert reconcile_result["pending_publication"] is None
    assert reconcile_result["snapshot"] == crash_result["snapshot"]

    final, _ = plugin._read_gpc_snapshot(live_server.ldap, context)
    assert final == after_crash
    assert final["version_number"] == target_version
    assert gpt_ini.read_bytes() == published_gpt
    assert _gpt_version(gpt_ini) == target_version
    assert _digest(machine_registry) == published_machine_digest
    assert not user_registry.exists()
    opened = live_server.api.Command.gpo_editor_open(
        context.displayname, locales=["en-US"]
    )["result"]
    assert opened["pending_publication"] is None
    assert opened["snapshot"]["version_number"] == target_version


def test_installed_high_level_command_flow_is_path_free(
    live_server, tmp_path, monkeypatch
):
    plugin = live_server.plugin
    api = live_server.api
    context = live_server.create_gpo()
    displayname = context.displayname
    monkeypatch.setattr(
        plugin, "GPO_EDITOR_STATE_DIRECTORY", tmp_path / "command-state"
    )

    opened = api.Command.gpo_editor_open(
        displayname, locales=["zz-ZZ"]
    )["result"]
    assert opened["locales"] == ["en-US"]
    assert opened["binding"]["api_version"] == 1
    assert opened["pending_publication"] is None

    policy = api.Command.gpo_editor_policy_show(
        displayname,
        "computer",
        POLICY_ID,
        locales=["en-US"],
    )["result"]["policy"]
    assert policy["policy_id"] == POLICY_ID

    updated = api.Command.gpo_editor_policy_update(
        displayname,
        "computer",
        POLICY_ID,
        request={
            "state": "enabled",
            "set_parameters": _enabled_fixed_element_parameters(policy),
            "comment": {
                "action": "set",
                "target": "embedded",
                "text": "389-DS integration comment",
            },
        },
        locales=["en-US"],
    )["result"]
    assert updated["publication"]["changed"] is True
    assert updated["policy"]["comment"]["text"] == (
        "389-DS integration comment"
    )

    documents = api.Command.gpo_editor_preference_documents(
        displayname
    )["result"]["documents"]
    assert any(
        document["scope"] == "computer"
        and document["kind"] == "environment_variables"
        and document["editable"] is True
        for document in documents
    )

    new_form = api.Command.gpo_editor_preference_show(
        displayname,
        "computer",
        "environment_variables",
        request={"identity": None},
    )["result"]
    assert new_form["item"] is None
    assert new_form["new_item_fields"]

    created = api.Command.gpo_editor_preference_create(
        displayname,
        "computer",
        "environment_variables",
        request={"fields": ENVIRONMENT_FIELDS},
    )["result"]
    identity = created["item"]["identity"]
    assert created["publication"]["changed"] is True

    changed_value = [{
        "id": "properties.value",
        "value": {"kind": "text", "value": "updated"},
    }]
    edited = api.Command.gpo_editor_preference_update(
        displayname,
        "computer",
        "environment_variables",
        request={
            "identity": identity,
            "fields": changed_value,
            "filters": [{
                "op": "insert",
                "collection_path": [],
                "index": 0,
                "filter_kind": "computer",
                "fields": COMPUTER_FILTER_FIELDS,
            }],
        },
    )["result"]
    assert edited["publication"]["changed"] is True
    assert edited["filters"]

    listed = api.Command.gpo_editor_preference_items(
        displayname, "computer", "environment_variables"
    )["result"]["items"]
    assert any(item["identity"] == identity for item in listed)

    deleted = api.Command.gpo_editor_preference_delete(
        displayname,
        "computer",
        "environment_variables",
        request={"identity": identity},
    )["result"]
    assert deleted["deleted_identity"] == identity
    assert deleted["publication"]["changed"] is True

    reconciled = api.Command.gpo_editor_reconcile(displayname)["result"]
    assert reconciled["recovery"]["kind"] == "clean"

    public_payload = json.dumps(
        {
            "open": opened,
            "policy": updated,
            "preferences": edited,
            "reconcile": reconciled,
        },
        sort_keys=True,
    )
    for private_fragment in (
        "/var/lib/freeipa",
        "Registry.pol",
        "GPT.INI",
        "Machine/Preferences",
        "gPCFileSysPath",
        "file_sys_path",
    ):
        assert private_fragment not in public_payload


def test_scripts_api_publishes_both_scopes_and_recovers_pending_acknowledgement(
    live_server, tmp_path, monkeypatch
):
    """Run isolated public scripts lifecycles through live LDAP publication."""
    plugin = live_server.plugin
    api = live_server.api
    context = live_server.create_gpo()
    displayname = context.displayname
    monkeypatch.setattr(
        plugin, "GPO_EDITOR_STATE_DIRECTORY", tmp_path / "scripts-state"
    )

    def show(scope, event):
        return api.Command.gpo_editor_scripts_show(
            displayname, scope, event
        )["result"]["scripts"]

    def encoded(value):
        return base64.b64encode(value).decode("ascii")

    computer = show("computer", "startup")
    computer_classic = api.Command.gpo_editor_script_upload_and_add(
        displayname,
        "computer",
        "startup",
        request={
            "executable_group": "classic",
            "snapshot": computer["classic"]["snapshot"],
            "name": "computer.cmd",
            "content_base64": encoded(b"echo computer\r\n"),
            "parameters": "/quiet",
        },
    )["result"]
    assert computer_classic["publication"]["changed"] is True
    assert (context.gpo_root / "Machine/Scripts/Startup/computer.cmd").is_file()

    computer = computer_classic["scripts"]
    computer_powershell = api.Command.gpo_editor_script_entry_add(
        displayname,
        "computer",
        "startup",
        request={
            "mode": "external_command",
            "executable_group": "powershell",
            "snapshot": computer["powershell"]["snapshot"],
            "command_line": r"\\server\share\computer.ps1",
            "parameters": "-NoProfile",
        },
    )["result"]
    assert computer_powershell["publication"]["changed"] is True

    user = show("user", "logon")
    user_classic = api.Command.gpo_editor_script_entry_add(
        displayname,
        "user",
        "logon",
        request={
            "mode": "external_command",
            "executable_group": "classic",
            "snapshot": user["classic"]["snapshot"],
            "command_line": "user-logon.cmd",
            "parameters": "",
        },
    )["result"]
    assert user_classic["publication"]["changed"] is True

    user = user_classic["scripts"]
    user_powershell = api.Command.gpo_editor_script_upload_and_add(
        displayname,
        "user",
        "logon",
        request={
            "executable_group": "powershell",
            "snapshot": user["powershell"]["snapshot"],
            "name": "user.ps1",
            "content_base64": encoded(b"Write-Output user\r\n"),
            "parameters": "",
        },
    )["result"]
    assert user_powershell["publication"]["changed"] is True
    assert (context.gpo_root / "User/Scripts/Logon/user.ps1").is_file()

    # Leave one successful LDAP update unacknowledged, then use a new public
    # mutation to prove that recovery acknowledges the old plan before it
    # publishes the next plan.
    original_acknowledge = plugin._acknowledge_publication
    acknowledgements = []

    def acknowledge_after_first(workspace, plan, snapshot):
        acknowledgements.append(plan["idempotency_token"])
        if len(acknowledgements) > 1:
            return original_acknowledge(workspace, plan, snapshot)
        return None

    monkeypatch.setattr(
        plugin, "_acknowledge_publication", acknowledge_after_first
    )
    computer = show("computer", "startup")
    asset = next(
        item for item in computer["assets"] if item["name"] == "computer.cmd"
    )
    left_pending = api.Command.gpo_editor_script_asset_replace(
        displayname,
        "computer",
        "startup",
        request={
            "name": asset["name"],
            "revision": asset["revision"],
            "content_base64": encoded(b"echo replaced\r\n"),
        },
    )["result"]
    assert left_pending["pending_publication"] is not None

    recovered = api.Command.gpo_editor_script_order_update(
        displayname,
        "computer",
        "startup",
        request={
            "snapshot": computer["powershell"]["snapshot"],
            "execution_order": "powershell_first",
        },
    )["result"]
    assert len(acknowledgements) >= 3
    assert recovered["pending_publication"] is None
    assert recovered["publication"]["changed"] is True

    published, _ = plugin._read_gpc_snapshot(live_server.ldap, context)
    assert "{42B5FAAE-6536-11D2-AE5A-0000F87571E3}" in (
        published["machine_extension_names"]
    )
    assert "{42B5FAAE-6536-11D2-AE5A-0000F87571E3}" in (
        published["user_extension_names"]
    )
    public_payload = json.dumps(recovered, sort_keys=True)
    for private_fragment in (
        str(context.gpo_root),
        "Machine/Scripts",
        "User/Scripts",
        "echo replaced",
    ):
        assert private_fragment not in public_payload


def test_installed_preference_descriptor_parent_and_subtype_round_trip(
    live_server, tmp_path, monkeypatch
):
    plugin = live_server.plugin
    api = live_server.api
    context = live_server.create_gpo()
    displayname = context.displayname
    monkeypatch.setattr(
        plugin,
        "GPO_EDITOR_STATE_DIRECTORY",
        tmp_path / "preference-contract-state",
    )

    registry_path = (
        context.gpo_root
        / "Machine/Preferences/Registry/Registry.xml"
    )
    registry_path.parent.mkdir(parents=True, exist_ok=True)
    registry_path.write_text(
        """<?xml version="1.0" encoding="utf-8"?>
<RegistrySettings clsid="{A3CCFC41-DFDB-43a5-8D26-0FE8B954DA51}">
  <Collection clsid="{53B533F5-224C-47e3-B01B-CA3B3F3FF4BF}" name="Outer">
    <Collection clsid="{53B533F5-224C-47e3-B01B-CA3B3F3FF4BF}" name="Empty child" />
  </Collection>
</RegistrySettings>
""",
        encoding="utf-8",
    )

    controls = {
        "text",
        "toggle",
        "optional_toggle",
        "unsigned_byte",
        "optional_boolean_u8",
        "action",
        "filter_combine",
        "directory_path",
        "file_path",
        "generated_timestamp",
        "generated_status",
        "generated_image",
    }

    def editable_fields(descriptors, overrides):
        ids = [field["id"] for field in descriptors]
        assert len(ids) == len(set(ids))
        assert all(field["control"] in controls for field in descriptors)
        assert set(overrides).issubset(ids)
        result = []
        for field in descriptors:
            if not field["editable"]:
                continue
            value = overrides.get(field["id"], field["value"])
            result.append({
                "id": field["id"],
                "value": json.loads(json.dumps(value)),
            })
        assert set(overrides).issubset(field["id"] for field in result)
        return result

    expected_version = 0

    def assert_computer_publication(result, *, extension_present):
        nonlocal expected_version
        expected_version += 1
        publication = result["publication"]
        snapshot = publication["snapshot"]
        assert publication["changed"] is True
        assert publication["affected_scopes"]["computer"] is True
        assert publication["affected_scopes"]["user"] is False
        assert publication["pending_publication"] is None
        assert snapshot["version_number"] == expected_version
        assert bool(snapshot["machine_extension_names"]) is extension_present
        assert snapshot["user_extension_names"] == ""
        assert _gpt_version(context.gpo_root / "GPT.INI") == (
            expected_version
        )

    groups_form = api.Command.gpo_editor_preference_show(
        displayname,
        "computer",
        "local_users_and_groups",
        request={"identity": None},
    )["result"]
    assert groups_form["item"] is None
    assert groups_form["fields"] == groups_form["new_item_fields"]
    assert groups_form["parent_candidates"] == [{
        "identity": None,
        "label": "Root",
        "parent_identity": None,
        "depth": 0,
    }]
    group_fields_by_id = {
        field["id"]: field for field in groups_form["fields"]
    }
    assert group_fields_by_id["properties.element"]["value"] == {
        "kind": "text",
        "value": "User",
    }
    assert group_fields_by_id["properties.element"]["editable"] is False
    assert group_fields_by_id["properties.element"]["control"] == "text"
    group_fields = editable_fields(
        groups_form["fields"],
        {
            "properties.userName": {
                "kind": "text",
                "value": "CODEX_GPO_PREFERENCE_USER",
            },
        },
    )
    assert all(
        field["id"] != "properties.element" for field in group_fields
    )

    group_created = api.Command.gpo_editor_preference_create(
        displayname,
        "computer",
        "local_users_and_groups",
        request={"fields": group_fields},
    )["result"]
    group_identity = group_created["item"]["identity"]
    assert_computer_publication(group_created, extension_present=True)
    created_group_fields = {
        field["id"]: field for field in group_created["fields"]
    }
    assert created_group_fields["properties.element"]["value"] == {
        "kind": "text",
        "value": "User",
    }
    assert created_group_fields["properties.element"]["editable"] is False
    assert created_group_fields["properties.element"]["control"] == "text"

    group_edited = api.Command.gpo_editor_preference_update(
        displayname,
        "computer",
        "local_users_and_groups",
        request={
            "identity": group_identity,
            "fields": [{
                "id": "properties.description",
                "value": {
                    "kind": "optional_text",
                    "value": "typed update",
                },
            }],
            "filters": [{
                "op": "insert",
                "collection_path": [],
                "index": 0,
                "filter_kind": "computer",
                "fields": COMPUTER_FILTER_FIELDS,
            }],
        },
    )["result"]
    assert_computer_publication(group_edited, extension_present=True)
    edited_group_fields = {
        field["id"]: field for field in group_edited["fields"]
    }
    assert edited_group_fields["properties.description"]["value"] == {
        "kind": "optional_text",
        "value": "typed update",
    }
    assert group_edited["filters"][0]["kind"] == "computer"
    assert all(
        field["control"] in controls
        for detail in group_edited["filter_fields"]
        for field in detail["fields"]
    )

    group_deleted = api.Command.gpo_editor_preference_delete(
        displayname,
        "computer",
        "local_users_and_groups",
        request={"identity": group_identity},
    )["result"]
    assert group_deleted["deleted_identity"] == group_identity
    assert_computer_publication(group_deleted, extension_present=False)

    registry_form = api.Command.gpo_editor_preference_show(
        displayname,
        "computer",
        "registry",
        request={"identity": None},
    )["result"]
    editable_fields(registry_form["fields"], {})
    root_candidate = registry_form["parent_candidates"][0]
    assert root_candidate == {
        "identity": None,
        "label": "Root",
        "parent_identity": None,
        "depth": 0,
    }
    outer_candidate = next(
        candidate
        for candidate in registry_form["parent_candidates"]
        if candidate["label"] == "Outer"
    )
    empty_candidate = next(
        candidate
        for candidate in registry_form["parent_candidates"]
        if candidate["label"] == "Empty child"
    )
    assert outer_candidate["identity"]
    assert outer_candidate["parent_identity"] is None
    assert outer_candidate["depth"] == 1
    assert empty_candidate["identity"]
    assert empty_candidate["parent_identity"] == outer_candidate["identity"]
    assert empty_candidate["depth"] == 2

    registry_fields = editable_fields(
        registry_form["fields"],
        {
            "properties.hive": {
                "kind": "text",
                "value": "HKEY_LOCAL_MACHINE",
            },
            "properties.key": {
                "kind": "text",
                "value": "Software\\Admix\\Nested",
            },
        },
    )
    registry_created = api.Command.gpo_editor_preference_create(
        displayname,
        "computer",
        "registry",
        request={
            "fields": registry_fields,
            "parent": empty_candidate["identity"],
        },
    )["result"]
    registry_identity = registry_created["item"]["identity"]
    assert registry_identity[:len(empty_candidate["identity"])] == (
        empty_candidate["identity"]
    )
    assert_computer_publication(registry_created, extension_present=True)

    registry_edited = api.Command.gpo_editor_preference_update(
        displayname,
        "computer",
        "registry",
        request={
            "identity": registry_identity,
            "fields": [{
                "id": "properties.key",
                "value": {
                    "kind": "text",
                    "value": "Software\\Admix\\NestedUpdated",
                },
            }],
        },
    )["result"]
    assert_computer_publication(registry_edited, extension_present=True)
    registry_fields_by_id = {
        field["id"]: field for field in registry_edited["fields"]
    }
    assert registry_fields_by_id["properties.key"]["value"] == {
        "kind": "text",
        "value": "Software\\Admix\\NestedUpdated",
    }

    registry_deleted = api.Command.gpo_editor_preference_delete(
        displayname,
        "computer",
        "registry",
        request={"identity": registry_identity},
    )["result"]
    assert registry_deleted["deleted_identity"] == registry_identity
    assert_computer_publication(registry_deleted, extension_present=False)

    registry_reopened = api.Command.gpo_editor_preference_show(
        displayname,
        "computer",
        "registry",
        request={"identity": None},
    )["result"]
    assert any(
        candidate["identity"] == empty_candidate["identity"]
        and candidate["parent_identity"] == outer_candidate["identity"]
        for candidate in registry_reopened["parent_candidates"]
    )
    reconciled = api.Command.gpo_editor_reconcile(displayname)["result"]
    assert reconciled["recovery"]["kind"] == "clean"


def test_installed_fixed_element_policy_state_publication_round_trip(
    live_server, tmp_path, monkeypatch
):
    plugin = live_server.plugin
    api = live_server.api
    context = live_server.create_gpo()
    displayname = context.displayname
    monkeypatch.setattr(
        plugin, "GPO_EDITOR_STATE_DIRECTORY", tmp_path / "policy-state"
    )

    initial = api.Command.gpo_editor_policy_show(
        displayname,
        "computer",
        POLICY_ID,
        locales=["en-US"],
    )["result"]["policy"]
    assert initial["state"] == "not_configured"
    assert initial["state_actions"]["enabled"] == {
        "available": True,
        "mode": "element_values",
        "requires_parameters": True,
    }
    assert initial["state_actions"]["disabled"] == {
        "available": True,
        "mode": "delete_element_bindings",
        "requires_parameters": False,
    }

    enabled = api.Command.gpo_editor_policy_update(
        displayname,
        "computer",
        POLICY_ID,
        request={
            "state": "enabled",
            "set_parameters": _enabled_fixed_element_parameters(initial),
        },
        locales=["en-US"],
    )["result"]
    assert enabled["policy"]["state"] == "enabled"
    assert enabled["publication"]["changed"] is True
    assert enabled["publication"]["snapshot"]["version_number"] == 1

    reopened_enabled = api.Command.gpo_editor_policy_show(
        displayname, "computer", POLICY_ID, locales=["en-US"]
    )["result"]["policy"]
    assert reopened_enabled["state"] == "enabled"

    disabled = api.Command.gpo_editor_policy_update(
        displayname,
        "computer",
        POLICY_ID,
        request={"state": "disabled"},
        locales=["en-US"],
    )["result"]
    assert disabled["policy"]["state"] == "disabled"
    assert disabled["publication"]["changed"] is True
    assert disabled["publication"]["snapshot"]["version_number"] == 2

    reopened_disabled = api.Command.gpo_editor_policy_show(
        displayname, "computer", POLICY_ID, locales=["en-US"]
    )["result"]["policy"]
    assert reopened_disabled["state"] == "disabled"
    assert all(
        parameter["value"] is None
        for parameter in reopened_disabled["parameters"]
    )

    cleared = api.Command.gpo_editor_policy_update(
        displayname,
        "computer",
        POLICY_ID,
        request={"state": "not_configured"},
        locales=["en-US"],
    )["result"]
    assert cleared["policy"]["state"] == "not_configured"
    assert cleared["publication"]["changed"] is True
    assert cleared["publication"]["snapshot"]["version_number"] == 3
    assert cleared["publication"]["snapshot"][
        "machine_extension_names"
    ] == ""

    reopened_cleared = api.Command.gpo_editor_policy_show(
        displayname, "computer", POLICY_ID, locales=["en-US"]
    )["result"]["policy"]
    assert reopened_cleared["state"] == "not_configured"

    repeated = api.Command.gpo_editor_policy_update(
        displayname,
        "computer",
        POLICY_ID,
        request={"state": "not_configured"},
        locales=["en-US"],
    )["result"]
    assert repeated["publication"]["changed"] is False
    assert repeated["publication"]["snapshot"]["version_number"] == 3


def test_scope_updates_publish_exact_packed_versions_and_payloads(
    live_server, tmp_path, monkeypatch
):
    plugin = live_server.plugin
    api = live_server.api
    context = live_server.create_gpo()
    displayname = context.displayname
    monkeypatch.setattr(
        plugin, "GPO_EDITOR_STATE_DIRECTORY", tmp_path / "scope-state"
    )
    gpt_ini = context.gpo_root / "GPT.INI"
    machine_registry = context.gpo_root / "Machine/Registry.pol"
    user_registry = context.gpo_root / "User/Registry.pol"

    def update(scope, value):
        return api.Command.gpo_editor_policy_update(
            displayname,
            scope,
            POLICY_ID,
            request={
                "state": "enabled",
                "set_parameters": [{
                    "parameter_id": PARAMETER_ID,
                    "value": {"kind": "boolean", "value": value},
                }],
            },
            locales=["en-US"],
        )["result"]

    computer_first = update("computer", False)
    computer_version = computer_first["publication"]["snapshot"][
        "version_number"
    ]
    assert computer_version == 1
    assert _gpt_version(gpt_ini) == computer_version
    assert machine_registry.is_file()
    assert not user_registry.exists()
    machine_first_digest = _digest(machine_registry)
    first_snapshot, _ = plugin._read_gpc_snapshot(
        live_server.ldap, context
    )
    assert first_snapshot["version_number"] == computer_version
    machine_extensions = first_snapshot["machine_extension_names"]
    assert machine_extensions == MACHINE_EXTENSION
    assert first_snapshot["user_extension_names"] == ""

    user_first = update("user", False)
    user_version = user_first["publication"]["snapshot"]["version_number"]
    assert user_version == (1 << 16) | 1
    assert _gpt_version(gpt_ini) == user_version
    assert user_registry.is_file()
    assert _digest(machine_registry) == machine_first_digest
    user_first_digest = _digest(user_registry)
    second_snapshot, _ = plugin._read_gpc_snapshot(
        live_server.ldap, context
    )
    assert second_snapshot["version_number"] == user_version
    assert second_snapshot["machine_extension_names"] == MACHINE_EXTENSION
    user_extensions = second_snapshot["user_extension_names"]
    assert user_extensions == USER_EXTENSION

    computer_second = update("computer", True)
    combined_version = computer_second["publication"]["snapshot"][
        "version_number"
    ]
    assert combined_version == (1 << 16) | 2
    assert _gpt_version(gpt_ini) == combined_version
    assert _digest(machine_registry) != machine_first_digest
    assert _digest(user_registry) == user_first_digest

    user_second = update("user", True)
    final_version = user_second["publication"]["snapshot"][
        "version_number"
    ]
    assert final_version == (2 << 16) | 2
    assert _gpt_version(gpt_ini) == final_version
    assert _digest(user_registry) != user_first_digest
    final_snapshot, _ = plugin._read_gpc_snapshot(
        live_server.ldap, context
    )
    assert final_snapshot["version_number"] == final_version
    assert final_snapshot["machine_extension_names"] == MACHINE_EXTENSION
    assert final_snapshot["user_extension_names"] == USER_EXTENSION

    # Reapplying the exact committed policy is a full no-op: neither SYSVOL
    # payload, the packed GPT version, nor either LDAP extension may change.
    before_no_op_gpt = gpt_ini.read_bytes()
    before_no_op_machine = _digest(machine_registry)
    before_no_op_user = _digest(user_registry)
    no_op = update("user", True)
    assert no_op["publication"]["changed"] is False
    assert no_op["publication"]["pending_publication"] is None
    assert no_op["publication"]["snapshot"]["version_number"] == final_version
    assert no_op["publication"]["snapshot"][
        "machine_extension_names"
    ] == MACHINE_EXTENSION
    assert no_op["publication"]["snapshot"][
        "user_extension_names"
    ] == USER_EXTENSION
    assert gpt_ini.read_bytes() == before_no_op_gpt
    assert _gpt_version(gpt_ini) == final_version
    assert _digest(machine_registry) == before_no_op_machine
    assert _digest(user_registry) == before_no_op_user
    after_no_op, _ = plugin._read_gpc_snapshot(live_server.ldap, context)
    assert after_no_op == final_snapshot


def test_user_only_scope_publishes_exact_version_payload_and_extensions(
    live_server, tmp_path, monkeypatch
):
    plugin = live_server.plugin
    api = live_server.api
    context = live_server.create_gpo()
    monkeypatch.setattr(
        plugin, "GPO_EDITOR_STATE_DIRECTORY", tmp_path / "user-only-state"
    )
    gpt_ini = context.gpo_root / "GPT.INI"
    machine_registry = context.gpo_root / "Machine/Registry.pol"
    user_registry = context.gpo_root / "User/Registry.pol"

    updated = api.Command.gpo_editor_policy_update(
        context.displayname,
        "user",
        POLICY_ID,
        request={
            "state": "enabled",
            "set_parameters": [{
                "parameter_id": PARAMETER_ID,
                "value": {"kind": "boolean", "value": False},
            }],
        },
        locales=["en-US"],
    )["result"]

    expected_version = 1 << 16
    assert updated["publication"]["changed"] is True
    assert updated["publication"]["snapshot"]["version_number"] == (
        expected_version
    )
    assert updated["publication"]["snapshot"][
        "machine_extension_names"
    ] == ""
    assert updated["publication"]["snapshot"][
        "user_extension_names"
    ] == USER_EXTENSION
    assert _gpt_version(gpt_ini) == expected_version
    assert not machine_registry.exists()
    assert user_registry.is_file()
    assert user_registry.stat().st_size > 0

    snapshot, presence = plugin._read_gpc_snapshot(live_server.ldap, context)
    assert snapshot["version_number"] == expected_version
    assert snapshot["machine_extension_names"] == ""
    assert snapshot["user_extension_names"] == USER_EXTENSION
    assert presence["machine_extension_names"] is False
    assert presence["user_extension_names"] is True
