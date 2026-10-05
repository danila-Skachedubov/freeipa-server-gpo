"""Installer data migrations are checked independently of schema existence."""

import re
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from ipalib import errors
from ipapython.dn import DN

from ipa_gpo_install import actions as actions_module, cli
from ipa_gpo_install.actions import IPAActions
from ipa_gpo_install.checks import IPAChecker
from ipa_gpo_install.config import REQUIRED_GROUP_POLICY_ENTRIES


BASEDN = DN(("dc", "example"), ("dc", "test"))
ASSETS = tuple(
    (directory, name)
    for directory, names in (
        (actions_module.TARGET_SCHEMA_DIR,
         ("75-chain.ldif", "75-gpc.ldif", "75-gpmaster.ldif")),
        (actions_module.TARGET_UPDATE_DIR,
         ("75-chain.update", "75-gpc.update", "75-gpmaster.update")),
    )
    for name in names
)


def infrastructure_checker():
    backend = MagicMock()
    entries = {
        DN(DN(relative), BASEDN): {"objectclass": [expected]}
        for _name, relative, expected in REQUIRED_GROUP_POLICY_ENTRIES
    }
    backend.get_entry.side_effect = lambda dn, **_options: entries[dn]
    api = SimpleNamespace(
        env=SimpleNamespace(basedn=BASEDN),
        Backend=SimpleNamespace(ldap2=backend),
    )
    return IPAChecker(api_instance=api), backend, entries


def test_infrastructure_checks_all_entries_and_is_read_only():
    checker, backend, _entries = infrastructure_checker()

    assert checker.check_group_policy_infrastructure() is True

    assert [call.args[0] for call in backend.get_entry.call_args_list] == [
        DN(DN(relative), BASEDN)
        for _name, relative, _expected in REQUIRED_GROUP_POLICY_ENTRIES
    ]
    assert all(
        call.kwargs == {"attrs_list": ["objectclass"]}
        for call in backend.get_entry.call_args_list
    )
    backend.add_entry.assert_not_called()
    backend.update_entry.assert_not_called()
    backend.delete_entry.assert_not_called()


def test_master_health_check_matches_packaged_data_update():
    checker, _backend, entries = infrastructure_checker()
    update_path = (
        Path(__file__).resolve().parents[1]
        / "plugin/update/75-gpmaster.update"
    )
    object_classes = re.findall(
        r"^default: objectClass:\s*(\S+)$",
        update_path.read_text(encoding="utf-8"),
        re.MULTILINE,
    )
    assert object_classes
    master_dn = DN(("cn", "grouppolicymaster"), ("cn", "etc"), BASEDN)
    entries[master_dn] = {"objectclass": object_classes}

    assert checker.check_group_policy_infrastructure() is True


@pytest.mark.parametrize("missing", range(len(REQUIRED_GROUP_POLICY_ENTRIES)))
def test_missing_infrastructure_fails_even_with_schema_installed(missing, caplog):
    checker, backend, entries = infrastructure_checker()
    name, relative, _expected = REQUIRED_GROUP_POLICY_ENTRIES[missing]
    missing_dn = DN(DN(relative), BASEDN)

    def lookup(dn, **_options):
        if dn == missing_dn:
            raise errors.NotFound(reason="missing infrastructure")
        return entries[dn]

    backend.get_entry.side_effect = lookup

    assert checker.check_group_policy_infrastructure() is False
    assert name in caplog.text
    assert "missing" in caplog.text
    backend.add_entry.assert_not_called()


@pytest.mark.parametrize("invalid", range(len(REQUIRED_GROUP_POLICY_ENTRIES)))
def test_wrong_infrastructure_class_is_not_accepted(invalid, caplog):
    checker, _backend, entries = infrastructure_checker()
    name, relative, _expected = REQUIRED_GROUP_POLICY_ENTRIES[invalid]
    entries[DN(DN(relative), BASEDN)] = {"objectclass": ["top", "person"]}

    assert checker.check_group_policy_infrastructure() is False
    assert name in caplog.text
    assert "unexpected object class" in caplog.text


@pytest.mark.parametrize(
    "failure", [errors.ACIError(info="denied"), RuntimeError("LDAP unavailable")]
)
def test_infrastructure_read_failure_is_not_reported_as_missing(failure, caplog):
    checker, backend, _entries = infrastructure_checker()
    backend.get_entry.side_effect = failure

    assert checker.check_group_policy_infrastructure() is False
    assert "Unable to verify" in caplog.text
    assert "is missing" not in caplog.text


@pytest.mark.parametrize("target", ASSETS)
@pytest.mark.parametrize("unreadable", [False, True])
def test_missing_or_unreadable_update_assets_fail_preflight(
        monkeypatch, target, unreadable, caplog):
    missing_path = "/".join(target)
    monkeypatch.setattr(
        actions_module.os.path, "isfile",
        lambda path: unreadable or path != missing_path,
    )
    monkeypatch.setattr(
        actions_module.os, "access",
        lambda path, _mode: not unreadable or path != missing_path,
    )
    actions = IPAActions(api_instance=MagicMock())

    assert actions.check_group_policy_update_assets() is False
    assert missing_path in caplog.text
    assert "Reinstall the freeipa-server-gpo package" in caplog.text


def test_healthy_update_assets_pass_preflight(monkeypatch):
    checked = []
    monkeypatch.setattr(actions_module.os.path, "isfile", lambda _path: True)
    monkeypatch.setattr(
        actions_module.os, "access",
        lambda path, _mode: checked.append(path) or True,
    )

    assert IPAActions(api_instance=MagicMock()).check_group_policy_update_assets()
    assert checked == ["/".join(item) for item in ASSETS]


def installer_scenario(**initial):
    actions = MagicMock(spec=IPAActions)
    for method in (
            "check_group_policy_update_assets", "configure_editor_filesystem",
            "are_plugins_activated", "restart_oddjob", "run_ipa_server_upgrade",
            "restart_httpd"):
        getattr(actions, method).return_value = True
    checker = MagicMock(spec=IPAChecker)
    checker.check_editor_filesystem.return_value = True
    checker.check_schema_complete.return_value = True
    checker.check_group_policy_infrastructure.return_value = True
    checks = {
        "adtrust_enabled": True,
        "sysvol_directory": True,
        "sysvol_share": True,
        "schema_complete": True,
        "ldap_infrastructure": True,
        **initial,
    }
    return actions, checker, checks


def test_complete_schema_does_not_skip_missing_container_migration():
    actions, checker, checks = installer_scenario(ldap_infrastructure=False)
    ordered = MagicMock()
    ordered.attach_mock(actions.run_ipa_server_upgrade, "upgrade")
    ordered.attach_mock(checker.check_schema_complete, "schema")
    ordered.attach_mock(checker.check_group_policy_infrastructure, "infrastructure")
    ordered.attach_mock(actions.restart_httpd, "httpd")

    assert cli.execute_required_actions(actions, checks, checker) is True

    assert [call[0] for call in ordered.mock_calls] == [
        "upgrade", "schema", "infrastructure", "httpd"
    ]


@pytest.mark.parametrize("method", ["check_schema_complete", "check_group_policy_infrastructure"])
def test_incomplete_post_upgrade_health_blocks_success_and_httpd(method, caplog):
    actions, checker, checks = installer_scenario(ldap_infrastructure=False)
    getattr(checker, method).return_value = False

    assert cli.execute_required_actions(actions, checks, checker) is False
    actions.run_ipa_server_upgrade.assert_called_once_with()
    actions.restart_httpd.assert_not_called()
    assert "Inspect /var/log/ipaupgrade.log" in caplog.text


def test_update_preflight_failure_stops_before_any_installation_changes():
    actions, checker, checks = installer_scenario(ldap_infrastructure=False)
    actions.check_group_policy_update_assets.return_value = False

    assert cli.execute_required_actions(actions, checks, checker) is False
    actions.install_adtrust.assert_not_called()
    actions.configure_editor_filesystem.assert_not_called()
    actions.run_ipa_server_upgrade.assert_not_called()
    actions.restart_oddjob.assert_not_called()
    actions.restart_httpd.assert_not_called()


def test_healthy_installation_still_rechecks_schema_and_data_entries():
    actions, checker, checks = installer_scenario()

    assert cli.execute_required_actions(actions, checks, checker) is True
    actions.run_ipa_server_upgrade.assert_not_called()
    checker.check_schema_complete.assert_called_once()
    checker.check_group_policy_infrastructure.assert_called_once_with()
