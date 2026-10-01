"""Installer and oddjob coverage for fresh GPO editor provisioning."""

import importlib.util
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

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
DELETE_HANDLER = (
    REPOSITORY
    / "plugin/dbus_handlers/org.freeipa.server.delete-gpo-structure"
)
GUID = "{11111111-2222-3333-4444-555555555555}"
TEST_USER = "ipaapi-test"
TEST_GROUP = "ipaapi-test"


def test_state_directory_is_private_and_preserves_pending_records(
    tmp_path, monkeypatch
):
    state = tmp_path / "gpo-editor-state"
    monkeypatch.setattr(
        "ipa_gpo_install.filesystem.pwd.getpwnam",
        lambda _name: SimpleNamespace(pw_uid=os.getuid()),
    )
    monkeypatch.setattr(
        "ipa_gpo_install.filesystem.grp.getgrnam",
        lambda _name: SimpleNamespace(gr_gid=os.getgid()),
    )

    ensure_editor_state_directory(state, TEST_USER, TEST_GROUP)
    pending = state / "pending-publication.json"
    pending.write_text('{"token": "preserve-me"}', encoding="utf-8")

    ensure_editor_state_directory(state, TEST_USER, TEST_GROUP)

    info = state.stat()
    assert info.st_mode & 0o777 == 0o700
    assert info.st_uid == os.getuid()
    assert info.st_gid == os.getgid()
    assert pending.read_text(encoding="utf-8") == '{"token": "preserve-me"}'


def test_new_gpo_acl_provisioning_is_bounded_to_the_fresh_tree(tmp_path):
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

    ensure_new_gpo_acls(policies, policies / GUID, TEST_USER, runner)

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
        "u:{0}:r-x,d:u:{0}:rwx".format(TEST_USER) in command
        for command in calls
    )
    assert any(
        "u:{0}:rwx,d:u:{0}:rwx".format(TEST_USER) in command
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
            TEST_USER,
            runner=lambda *_args, **_kwargs: subprocess.CompletedProcess([], 0),
        )


def _load_handler(path, module_name):
    spec = importlib.util.spec_from_file_location(
        module_name, path
    )
    if spec is None or spec.loader is None:
        from importlib.machinery import SourceFileLoader
        loader = SourceFileLoader(module_name, str(path))
        spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_create_handler():
    return _load_handler(CREATE_HANDLER, "create_gpo_structure_test")


def _load_delete_handler():
    return _load_handler(DELETE_HANDLER, "delete_gpo_structure_test")


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
    assert (policy / "Machine/Scripts/Startup").is_dir()
    assert (policy / "Machine/Scripts/Shutdown").is_dir()
    assert (policy / "User/Scripts/Logon").is_dir()
    assert (policy / "User/Scripts/Logoff").is_dir()
    assert (policy / "GPT.INI").read_text(encoding="utf-8") == (
        "[General]\ndisplayName=Example policy\nVersion=0\n"
    )


@pytest.mark.parametrize(
    "argv",
    [
        [str(CREATE_HANDLER)],
        [str(CREATE_HANDLER), "invalid-guid", "example.test"],
        [str(CREATE_HANDLER), GUID, "invalid/domain"],
    ],
)
def test_create_gpo_handler_rejects_invalid_arguments(monkeypatch, argv):
    handler = _load_create_handler()
    path_calls = []
    monkeypatch.setattr(
        handler,
        "get_policies_path",
        lambda *args: path_calls.append(args),
    )
    monkeypatch.setattr(sys, "argv", argv)

    assert handler.main() == 1
    assert path_calls == []


def test_create_gpo_handler_reports_policies_root_failure(monkeypatch):
    handler = _load_create_handler()
    monkeypatch.setattr(handler.os.path, "exists", lambda _path: False)
    monkeypatch.setattr(
        handler.os,
        "makedirs",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            OSError("read-only filesystem")
        ),
    )
    monkeypatch.setattr(sys, "argv", [
        str(CREATE_HANDLER),
        GUID,
        "example.test",
    ])

    assert handler.main() == 1


def test_create_gpo_handler_uses_default_display_name(tmp_path, monkeypatch):
    handler = _load_create_handler()
    policies = tmp_path / "Policies"
    policy = policies / GUID
    monkeypatch.setattr(
        handler,
        "get_policies_path",
        lambda _domain: str(policies),
    )
    monkeypatch.setattr(
        handler,
        "get_policy_path",
        lambda _domain, _guid: str(policy),
    )
    monkeypatch.setattr(
        handler,
        "get_gpt_ini_path",
        lambda _domain, _guid: str(policy / "GPT.INI"),
    )
    monkeypatch.setattr(handler, "ensure_new_gpo_acls", lambda *_args: None)
    monkeypatch.setattr(sys, "argv", [
        str(CREATE_HANDLER),
        GUID,
        "example.test",
    ])

    assert handler.main() == 0
    assert "displayName=New Group Policy Object\n" in (
        policy / "GPT.INI"
    ).read_text(encoding="utf-8")


def test_create_gpo_handler_reports_acl_failure(tmp_path, monkeypatch):
    handler = _load_create_handler()
    policies = tmp_path / "Policies"
    policy = policies / GUID
    monkeypatch.setattr(
        handler,
        "get_policies_path",
        lambda _domain: str(policies),
    )
    monkeypatch.setattr(
        handler,
        "get_policy_path",
        lambda _domain, _guid: str(policy),
    )
    monkeypatch.setattr(
        handler,
        "get_gpt_ini_path",
        lambda _domain, _guid: str(policy / "GPT.INI"),
    )
    monkeypatch.setattr(
        handler,
        "ensure_new_gpo_acls",
        lambda *_args: (_ for _ in ()).throw(OSError("setfacl failed")),
    )
    monkeypatch.setattr(sys, "argv", [
        str(CREATE_HANDLER),
        GUID,
        "example.test",
    ])

    assert handler.main() == 1
    assert not policy.exists()


def test_create_gpo_handler_does_not_overwrite_existing_policy(
    tmp_path, monkeypatch
):
    handler = _load_create_handler()
    policies = tmp_path / "Policies"
    policy = policies / GUID
    policy.mkdir(parents=True)
    gpt_ini = policy / "GPT.INI"
    gpt_ini.write_text("existing-policy", encoding="utf-8")
    acl = MagicMock()
    monkeypatch.setattr(
        handler, "get_policies_path", lambda _domain: str(policies)
    )
    monkeypatch.setattr(
        handler, "get_policy_path", lambda _domain, _guid: str(policy)
    )
    monkeypatch.setattr(
        handler, "get_gpt_ini_path", lambda _domain, _guid: str(gpt_ini)
    )
    monkeypatch.setattr(handler, "ensure_new_gpo_acls", acl)
    monkeypatch.setattr(sys, "argv", [
        str(CREATE_HANDLER), GUID, "example.test", "replacement"
    ])

    assert handler.main() == 1
    assert gpt_ini.read_text(encoding="utf-8") == "existing-policy"
    acl.assert_not_called()


def test_create_gpo_handler_rejects_symlink_policy_without_touching_target(
    tmp_path, monkeypatch
):
    handler = _load_create_handler()
    policies = tmp_path / "Policies"
    policies.mkdir()
    external = tmp_path / "external"
    external.mkdir()
    marker = external / "keep"
    marker.write_text("safe", encoding="utf-8")
    policy = policies / GUID
    policy.symlink_to(external, target_is_directory=True)
    monkeypatch.setattr(
        handler, "get_policies_path", lambda _domain: str(policies)
    )
    monkeypatch.setattr(
        handler, "get_policy_path", lambda _domain, _guid: str(policy)
    )
    monkeypatch.setattr(sys, "argv", [
        str(CREATE_HANDLER), GUID, "example.test"
    ])

    assert handler.main() == 1
    assert policy.is_symlink()
    assert marker.read_text(encoding="utf-8") == "safe"


def test_create_gpo_handler_cleans_tree_after_gpt_write_failure(
    tmp_path, monkeypatch
):
    handler = _load_create_handler()
    policies = tmp_path / "Policies"
    policy = policies / GUID
    monkeypatch.setattr(
        handler, "get_policies_path", lambda _domain: str(policies)
    )
    monkeypatch.setattr(
        handler, "get_policy_path", lambda _domain, _guid: str(policy)
    )
    monkeypatch.setattr(
        handler,
        "get_gpt_ini_path",
        lambda _domain, _guid: str(policy / "Machine"),
    )
    monkeypatch.setattr(sys, "argv", [
        str(CREATE_HANDLER), GUID, "example.test"
    ])

    assert handler.main() == 1
    assert not policy.exists()


@pytest.mark.parametrize(
    "argv",
    [
        [str(DELETE_HANDLER)],
        [str(DELETE_HANDLER), "invalid-guid", "example.test"],
        [str(DELETE_HANDLER), GUID, "invalid/domain"],
    ],
)
def test_delete_gpo_handler_rejects_invalid_arguments(monkeypatch, argv):
    handler = _load_delete_handler()
    get_policy_path = SimpleNamespace(calls=[])

    def policy_path(*args):
        get_policy_path.calls.append(args)
        return "/must/not/be/used"

    monkeypatch.setattr(handler, "get_policy_path", policy_path)
    monkeypatch.setattr(sys, "argv", argv)

    assert handler.main() == 1
    assert get_policy_path.calls == []


def test_delete_gpo_handler_accepts_already_absent_directory(
    tmp_path,
    monkeypatch,
):
    handler = _load_delete_handler()
    missing = tmp_path / GUID
    monkeypatch.setattr(
        handler,
        "get_policy_path",
        lambda _domain, _guid: str(missing),
    )
    monkeypatch.setattr(sys, "argv", [
        str(DELETE_HANDLER),
        GUID,
        "example.test",
    ])

    assert handler.main() == 0


def test_delete_gpo_handler_removes_only_resolved_policy_tree(
    tmp_path,
    monkeypatch,
):
    handler = _load_delete_handler()
    policy = tmp_path / GUID
    policy.mkdir()
    sibling = tmp_path / "keep"
    sibling.mkdir()
    monkeypatch.setattr(
        handler,
        "get_policy_path",
        lambda _domain, _guid: str(policy),
    )
    monkeypatch.setattr(sys, "argv", [
        str(DELETE_HANDLER),
        GUID,
        "example.test",
    ])

    assert handler.main() == 0
    assert not policy.exists()
    assert sibling.is_dir()


def test_delete_gpo_handler_reports_removal_failure(tmp_path, monkeypatch):
    handler = _load_delete_handler()
    policy = tmp_path / GUID
    policy.mkdir()
    monkeypatch.setattr(
        handler,
        "get_policy_path",
        lambda _domain, _guid: str(policy),
    )
    monkeypatch.setattr(
        handler.shutil,
        "rmtree",
        lambda _path: (_ for _ in ()).throw(OSError("filesystem busy")),
    )
    monkeypatch.setattr(sys, "argv", [
        str(DELETE_HANDLER),
        GUID,
        "example.test",
    ])

    assert handler.main() == 1
    assert policy.is_dir()


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
        def check_group_policy_update_assets(self):
            calls.append("update assets")
            return True

        def configure_editor_filesystem(self):
            calls.append("filesystem")
            return True

        def are_plugins_activated(self):
            calls.append("plugins")
            return True

        def restart_oddjob(self):
            calls.append("oddjob")
            return True

        def restart_httpd(self):
            calls.append("httpd")
            return True

    class Checker:
        def check_schema_complete(self, _classes):
            calls.append("schema health")
            return True

        def check_group_policy_infrastructure(self):
            calls.append("LDAP health")
            return True

        def check_editor_filesystem(self):
            calls.append("health")
            return True

    checks = {
        "adtrust_enabled": True,
        "sysvol_directory": True,
        "sysvol_share": True,
        "schema_complete": True,
        "ldap_infrastructure": True,
        "editor_filesystem": True,
    }

    assert execute_required_actions(Actions(), checks, Checker()) is True
    assert calls == [
        "update assets", "filesystem", "health", "plugins", "oddjob",
        "schema health", "LDAP health", "httpd",
    ]
