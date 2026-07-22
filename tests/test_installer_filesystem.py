"""Installer and oddjob coverage for fresh GPO editor provisioning."""

import grp
import importlib.util
import os
import pwd
import subprocess
import sys
from pathlib import Path

import pytest

from ipa_gpo_install import checks as checks_module
from ipa_gpo_install.checks import IPAChecker
from ipa_gpo_install.cli import execute_required_actions
from ipa_gpo_install.filesystem import (
    FilesystemConfigurationError,
    ensure_editor_state_directory,
    ensure_new_gpo_acls,
)


REPOSITORY = Path(__file__).resolve().parents[1]
CREATE_HANDLER = (
    REPOSITORY
    / "plugin/dbus_handlers/org.freeipa.server.create-gpo-structure"
)
GUID = "{11111111-2222-3333-4444-555555555555}"


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


def test_new_gpo_acl_provisioning_is_bounded_to_the_fresh_tree(tmp_path):
    username = pwd.getpwuid(os.getuid()).pw_name
    policies = tmp_path / "Policies"
    machine = policies / GUID / "Machine"
    machine.mkdir(parents=True)
    user = policies / GUID / "User"
    user.mkdir()
    existing = machine / "pre-existing"
    existing.mkdir()
    calls = []

    def runner(command, **_kwargs):
        calls.append(command)
        return subprocess.CompletedProcess(command, 0, "", "")

    ensure_new_gpo_acls(policies, policies / GUID, username, runner)

    targets = [
        path for command in calls for path in command
        if str(path).startswith(str(policies))
    ]
    assert str(policies) in targets
    assert str(policies / GUID) in targets
    assert str(machine) in targets
    assert str(user) in targets
    assert str(existing) not in targets
    assert any(
        "u:{}:r-x,d:u:{}:rwx".format(username, username) in command
        for command in calls
    )
    assert any(
        "u:{}:rwx,d:u:{}:rwx".format(username, username) in command
        for command in calls
    )


def test_new_gpo_acl_provisioning_rejects_symlink_child(tmp_path):
    policies = tmp_path / "Policies"
    machine = policies / GUID / "Machine"
    machine.mkdir(parents=True)
    (policies / GUID / "User").symlink_to(machine, target_is_directory=True)

    with pytest.raises(FilesystemConfigurationError, match="not a real directory"):
        ensure_new_gpo_acls(
            policies,
            policies / GUID,
            pwd.getpwuid(os.getuid()).pw_name,
            runner=lambda *_args, **_kwargs: subprocess.CompletedProcess([], 0),
        )


def _load_create_handler():
    spec = importlib.util.spec_from_file_location(
        "create_gpo_structure_test", CREATE_HANDLER
    )
    if spec is None or spec.loader is None:
        from importlib.machinery import SourceFileLoader
        loader = SourceFileLoader("create_gpo_structure_test", str(CREATE_HANDLER))
        spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_new_gpo_handler_applies_editor_acls_after_creation(tmp_path, monkeypatch):
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
    tmp_path, monkeypatch
):
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
        lambda _path: {"user:ipaapi:r-x", "default:user:ipaapi:rwx"},
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


def test_install_configures_fresh_filesystem_and_health_check():
    calls = []

    class Actions:
        def configure_editor_filesystem(self):
            calls.append("filesystem")
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
    assert calls == ["filesystem", "health", "plugins", "oddjob"]
