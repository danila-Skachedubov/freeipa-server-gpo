"""Installer and oddjob coverage for GPO editor filesystem provisioning."""

import grp
import importlib.util
import os
import pwd
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from ipa_gpo_install import checks as checks_module
from ipa_gpo_install import filesystem as filesystem_module
from ipa_gpo_install.checks import IPAChecker
from ipa_gpo_install.cli import execute_required_actions
from ipa_gpo_install.filesystem import (
    LEGACY_EDITOR_RETIREMENT_MARKER,
    ensure_editor_state_directory,
    migrate_policies_acls,
    retire_legacy_editor_runtime,
)


REPOSITORY = Path(__file__).resolve().parents[1]
CREATE_HANDLER = (
    REPOSITORY
    / "plugin/dbus_handlers/org.freeipa.server.create-gpo-structure"
)
GUID = "{11111111-2222-3333-4444-555555555555}"


def _acl_entries(path):
    result = subprocess.run(
        ["getfacl", "-cp", str(path)],
        capture_output=True,
        text=True,
        check=True,
    )
    return {
        line.partition("#")[0].strip()
        for line in result.stdout.splitlines()
        if line and not line.startswith("#")
    }


def test_state_directory_is_private_and_preserves_pending_records(tmp_path):
    state = tmp_path / "gpo-editor-state"
    username = pwd.getpwuid(os.getuid()).pw_name
    groupname = grp.getgrgid(os.getgid()).gr_name

    ensure_editor_state_directory(state, username, groupname)
    pending = state / "pending-publication.json"
    pending.write_text('{"token": "preserve-me"}', encoding="utf-8")

    ensure_editor_state_directory(state, username, groupname)

    info = state.stat()
    assert info.st_mode & 0o777 == 0o700
    assert info.st_uid == os.getuid()
    assert info.st_gid == os.getgid()
    assert pending.read_text(encoding="utf-8") == '{"token": "preserve-me"}'


@pytest.mark.skipif(
    shutil.which("setfacl") is None or shutil.which("getfacl") is None,
    reason="POSIX ACL tools are not installed",
)
def test_existing_policy_acl_migration_is_recursive_and_idempotent(tmp_path):
    username = pwd.getpwuid(os.getuid()).pw_name
    policies = tmp_path / "Policies"
    machine = policies / GUID / "Machine"
    machine.mkdir(parents=True)
    payload = machine / "Registry.pol"
    payload.write_bytes(b"policy")
    payload.chmod(0o600)

    migrate_policies_acls(policies, username)
    migrate_policies_acls(policies, username)

    policies_entries = _acl_entries(policies)
    assert "user:{}:r-x".format(username) in policies_entries
    assert "user:{}:rwx".format(username) not in policies_entries
    assert "default:user:{}:rwx".format(username) in policies_entries

    for directory in (policies / GUID, machine):
        entries = _acl_entries(directory)
        assert "user:{}:rwx".format(username) in entries
        assert "default:user:{}:rwx".format(username) in entries
        assert all(
            "w" not in entry
            for entry in entries
            if entry.startswith("other::")
        )

    payload_entries = _acl_entries(payload)
    assert "user:{}:rw-".format(username) in payload_entries
    assert "other::---" in payload_entries
    assert "user:{}:rwx".format(username) not in payload_entries


def _load_create_handler():
    spec = importlib.util.spec_from_file_location(
        "create_gpo_structure_test", CREATE_HANDLER
    )
    if spec is None or spec.loader is None:
        # Extension-less executable paths need an explicit source loader.
        from importlib.machinery import SourceFileLoader
        loader = SourceFileLoader("create_gpo_structure_test", str(CREATE_HANDLER))
        spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_new_gpo_handler_applies_editor_acls_after_creation(
        tmp_path, monkeypatch):
    handler = _load_create_handler()
    policies = tmp_path / "Policies"
    policy = policies / GUID
    calls = []

    monkeypatch.setattr(handler, "get_policies_path", lambda _domain: str(policies))
    monkeypatch.setattr(
        handler, "get_policy_path", lambda _domain, _guid: str(policy)
    )
    monkeypatch.setattr(
        handler,
        "get_gpt_ini_path",
        lambda _domain, _guid: str(policy / "GPT.INI"),
    )
    monkeypatch.setattr(
        handler,
        "ensure_new_gpo_acls",
        lambda policies_path, policy_path: calls.append(
            (policies_path, policy_path)
        ),
    )
    monkeypatch.setattr(
        sys,
        "argv",
        [str(CREATE_HANDLER), GUID, "example.test", "Example policy"],
    )

    assert handler.main() == 0
    assert calls == [(str(policies), str(policy))]
    assert (policy / "Machine").is_dir()
    assert (policy / "User").is_dir()
    assert (policy / "GPT.INI").read_text(encoding="utf-8") == (
        "[General]\ndisplayName=Example policy\nVersion=0\n"
    )


def test_health_check_samples_existing_gpo_as_editor_identity(
        tmp_path, monkeypatch):
    policies = tmp_path / "Policies"
    policy = policies / GUID
    policy.mkdir(parents=True)
    (policy / "GPT.INI").write_text("[General]\nVersion=0\n", encoding="utf-8")

    fake_api = type(
        "FakeAPI", (), {"env": type("Env", (), {"domain": "example.test"})()}
    )()
    checker = IPAChecker(api_instance=fake_api)
    access_checks = []

    monkeypatch.setattr(
        checks_module, "editor_state_directory_status", lambda: (True, "ok")
    )
    monkeypatch.setattr(
        checks_module, "get_policies_path", lambda _domain: str(policies)
    )
    monkeypatch.setattr(
        checker,
        "_acl_entries",
        lambda path: {
            "user:ipaapi:r-x" if Path(path) == policies
            else "user:ipaapi:rwx",
            "default:user:ipaapi:rwx",
        },
    )
    monkeypatch.setattr(
        checker,
        "_identity_can_access",
        lambda path, permissions: access_checks.append(
            (Path(path), permissions)
        ) or not (Path(path) == policies and permissions == "w"),
    )

    assert checker.check_editor_filesystem() is True
    assert (policies, "rx") in access_checks
    assert (policies, "w") in access_checks
    assert (policy, "rwx") in access_checks
    assert (policy / "GPT.INI", "rw") in access_checks


def test_health_check_rejects_writable_policies_root(tmp_path, monkeypatch):
    fake_api = type(
        "FakeAPI", (), {"env": type("Env", (), {"domain": "example.test"})()}
    )()
    checker = IPAChecker(api_instance=fake_api)
    monkeypatch.setattr(
        checker,
        "_acl_entries",
        lambda _path: {
            "user:ipaapi:r-x", "default:user:ipaapi:rwx"
        },
    )
    monkeypatch.setattr(
        checker, "_identity_can_access", lambda _path, _permissions: True
    )

    assert checker._check_editor_directory(
        tmp_path,
        access_permissions="r-x",
        identity_permissions="rx",
        forbid_write=True,
    ) is False


def test_legacy_cleanup_is_idempotent_and_preserves_editor_state(
        tmp_path, monkeypatch):
    prefix = tmp_path / "usr"
    etc_root = tmp_path / "etc"
    var_root = tmp_path / "var"
    python_sitelib = prefix / "lib/python/site-packages"
    state = tmp_path / "var/lib/freeipa/gpo-editor-state"
    state.mkdir(parents=True)
    pending = state / "pending.json"
    pending.write_text("keep", encoding="utf-8")

    legacy_paths = [
        python_sitelib / "gpui_service/service.py",
        python_sitelib / "ipaclient/plugins/gpo_client.py",
        python_sitelib / "ipaclient/plugins/__pycache__/gpo_client.old.pyc",
        prefix / "sbin/gpuiservice",
        prefix / "bin/ipa-gpo-update-paths",
        prefix / "lib/systemd/system/gpuiservice.service",
        etc_root / "systemd/system/gpuiservice.service.d/override.conf",
        etc_root / "systemd/system/multi-user.target.wants/gpuiservice.service",
        etc_root / "dbus-1/system.d/org.altlinux.gpuiservice.conf",
        etc_root / "gpuiservice/legacy.conf",
        var_root / "lib/gpuiservice/legacy.state",
        prefix / "share/dbus-1/system-services/org.altlinux.gpuiservice.service",
        prefix / "share/glib-2.0/schemas/org.altlinux.gpuiservice.gschema.xml",
    ]
    for path in legacy_paths:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("legacy", encoding="utf-8")

    calls = []

    def runner(command, **_kwargs):
        calls.append(command)
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(
        filesystem_module.shutil,
        "which",
        lambda command: "/usr/bin/{}".format(command),
    )

    removed = retire_legacy_editor_runtime(
        prefix=prefix,
        etc_root=etc_root,
        var_root=var_root,
        python_sitelib=python_sitelib,
        runner=runner,
        manage_services=False,
    )
    removed_again = retire_legacy_editor_runtime(
        prefix=prefix,
        etc_root=etc_root,
        var_root=var_root,
        python_sitelib=python_sitelib,
        runner=runner,
        manage_services=False,
    )

    assert removed
    assert removed_again == []
    assert all(not path.exists() for path in legacy_paths)
    assert pending.read_text(encoding="utf-8") == "keep"
    assert any("glib-compile-schemas" in command[0] for command in calls)


def test_legacy_cleanup_stops_service_and_verifies_it_is_inactive(
        tmp_path, monkeypatch):
    calls = []
    legacy_unit = tmp_path / "usr/lib/systemd/system/gpuiservice.service"
    legacy_unit.parent.mkdir(parents=True)
    legacy_unit.write_text("legacy", encoding="utf-8")

    def runner(command, **_kwargs):
        calls.append(command)
        returncode = 3 if "is-active" in command else 0
        return subprocess.CompletedProcess(command, returncode, "", "")

    monkeypatch.setattr(
        filesystem_module.shutil,
        "which",
        lambda command: "/usr/bin/systemctl" if command == "systemctl" else None,
    )

    retire_legacy_editor_runtime(
        prefix=tmp_path / "usr",
        etc_root=tmp_path / "etc",
        var_root=tmp_path / "var",
        python_sitelib=tmp_path / "site-packages",
        runner=runner,
    )

    assert any(command[1:] == ["stop", "gpuiservice.service"]
               for command in calls)
    assert any(command[1:] == ["disable", "gpuiservice.service"]
               for command in calls)
    assert any(command[1:] == ["daemon-reload"] for command in calls)
    assert any(command[1:] == ["is-active", "gpuiservice.service"]
               for command in calls)


def test_completed_retirement_marker_skips_all_service_work(
        tmp_path, monkeypatch):
    calls = []
    marker = (
        tmp_path / "var/lib/freeipa" / LEGACY_EDITOR_RETIREMENT_MARKER
    )
    marker.parent.mkdir(parents=True)
    marker.write_text("", encoding="utf-8")

    def runner(command, **_kwargs):
        calls.append(command)
        raise AssertionError("runner must not be called after retirement")

    monkeypatch.setattr(
        filesystem_module.shutil,
        "which",
        lambda _command: pytest.fail(
            "service discovery must not run after retirement"
        ),
    )

    assert retire_legacy_editor_runtime(
        prefix=tmp_path / "usr",
        etc_root=tmp_path / "etc",
        var_root=tmp_path / "var",
        python_sitelib=tmp_path / "site-packages",
        runner=runner,
    ) == []
    assert calls == []


def test_cleanup_stops_loaded_service_even_when_files_are_already_absent(
        tmp_path, monkeypatch):
    calls = []
    active_checks = 0

    def runner(command, **_kwargs):
        nonlocal active_checks
        calls.append(command)
        if "is-active" in command:
            active_checks += 1
            returncode = 0 if active_checks == 1 else 3
        else:
            returncode = 0
        return subprocess.CompletedProcess(command, returncode, "", "")

    monkeypatch.setattr(
        filesystem_module.shutil,
        "which",
        lambda command: "/usr/bin/systemctl" if command == "systemctl" else None,
    )

    arguments = {
        "prefix": tmp_path / "usr",
        "etc_root": tmp_path / "etc",
        "var_root": tmp_path / "var",
        "python_sitelib": tmp_path / "site-packages",
        "runner": runner,
    }

    assert retire_legacy_editor_runtime(
        **arguments,
    ) == []
    marker = (
        tmp_path / "var/lib/freeipa" / LEGACY_EDITOR_RETIREMENT_MARKER
    )
    assert marker.is_file()
    assert marker.stat().st_mode & 0o777 == 0o600
    calls_after_first_migration = list(calls)

    assert retire_legacy_editor_runtime(
        **arguments,
    ) == []
    assert calls == calls_after_first_migration
    assert any(command[1:] == ["stop", "gpuiservice.service"]
               for command in calls)
    assert any(command[1:] == ["disable", "gpuiservice.service"]
               for command in calls)
    assert any(command[1:] == ["daemon-reload"] for command in calls)
    assert active_checks == 2


def test_failed_service_retirement_does_not_write_completion_marker(
        tmp_path, monkeypatch):
    calls = []

    def runner(command, **_kwargs):
        calls.append(command)
        returncode = 0
        return subprocess.CompletedProcess(command, returncode, "", "")

    monkeypatch.setattr(
        filesystem_module.shutil,
        "which",
        lambda command: "/usr/bin/systemctl" if command == "systemctl" else None,
    )

    with pytest.raises(
            filesystem_module.FilesystemConfigurationError,
            match="still active"):
        retire_legacy_editor_runtime(
            prefix=tmp_path / "usr",
            etc_root=tmp_path / "etc",
            var_root=tmp_path / "var",
            python_sitelib=tmp_path / "site-packages",
            runner=runner,
        )

    marker = (
        tmp_path / "var/lib/freeipa" / LEGACY_EDITOR_RETIREMENT_MARKER
    )
    assert not marker.exists()
    assert any(command[1:] == ["stop", "gpuiservice.service"]
               for command in calls)


def test_schema_cleanup_requires_compiler_before_removing_xml(
        tmp_path, monkeypatch):
    schema = (
        tmp_path
        / "usr/share/glib-2.0/schemas/org.altlinux.gpuiservice.gschema.xml"
    )
    schema.parent.mkdir(parents=True)
    schema.write_text("legacy", encoding="utf-8")
    monkeypatch.setattr(filesystem_module.shutil, "which", lambda _command: None)

    with pytest.raises(
            filesystem_module.FilesystemConfigurationError,
            match="GLib schema cache"):
        retire_legacy_editor_runtime(
            prefix=tmp_path / "usr",
            etc_root=tmp_path / "etc",
            var_root=tmp_path / "var",
            python_sitelib=tmp_path / "site-packages",
        )

    assert schema.exists()


def test_schema_cache_marker_rebuilds_after_rpm_removed_legacy_xml(
        tmp_path, monkeypatch):
    schema_directory = tmp_path / "usr/share/glib-2.0/schemas"
    schema_directory.mkdir(parents=True)
    calls = []

    def runner(command, **_kwargs):
        calls.append(command)
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(
        filesystem_module.shutil,
        "which",
        lambda command: (
            "/usr/bin/glib-compile-schemas"
            if command == "glib-compile-schemas"
            else None
        ),
    )

    assert retire_legacy_editor_runtime(
        prefix=tmp_path / "usr",
        etc_root=tmp_path / "etc",
        var_root=tmp_path / "var",
        python_sitelib=tmp_path / "site-packages",
        runner=runner,
        manage_services=False,
        rebuild_schema_cache=True,
        manage_retirement_marker=False,
    ) == []
    assert calls == [[
        "/usr/bin/glib-compile-schemas", str(schema_directory)
    ]]
    marker = (
        tmp_path / "var/lib/freeipa" / LEGACY_EDITOR_RETIREMENT_MARKER
    )
    assert not marker.exists()


def test_install_and_upgrade_always_cleanup_migrate_and_health_check():
    calls = []

    class Actions:
        def retire_legacy_editor_runtime(self):
            calls.append("cleanup")
            return True

        def configure_editor_filesystem(self):
            calls.append("migrate")
            return True

        def are_plugins_activated(self):
            calls.append("plugins")
            return True

        def restart_oddjob(self):
            calls.append("oddjob")
            return True

    class Checker:
        def check_editor_filesystem(self):
            calls.append("health")
            return True

    checks = {
        "adtrust_enabled": True,
        "sysvol_directory": True,
        "sysvol_share": True,
        "schema_complete": True,
        "editor_filesystem": True,
    }

    assert execute_required_actions(Actions(), checks, Checker()) is True
    assert calls == ["cleanup", "migrate", "health", "plugins", "oddjob"]
