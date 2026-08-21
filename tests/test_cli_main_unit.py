"""Unit tests for the installer CLI orchestration entry point."""

from types import SimpleNamespace
from unittest.mock import MagicMock

from ipa_gpo_install import cli


def _prepare_main(monkeypatch, *, check_only=False, connected=True):
    options = SimpleNamespace(check_only=check_only, debuglevel=0)
    api = MagicMock()
    api.Backend.ldap2.isconnected.return_value = connected
    checker = MagicMock()
    actions = MagicMock()

    monkeypatch.setattr(cli, "api", api)
    monkeypatch.setattr(
        cli, "parse_options", MagicMock(return_value=({}, options))
    )
    monkeypatch.setattr(cli, "setup_environment", MagicMock(return_value=True))
    checker_factory = MagicMock(return_value=checker)
    actions_factory = MagicMock(return_value=actions)
    monkeypatch.setattr(cli, "IPAChecker", checker_factory)
    monkeypatch.setattr(cli, "IPAActions", actions_factory)
    monkeypatch.setattr(
        cli, "check_critical_requirements", MagicMock(return_value=True)
    )
    monkeypatch.setattr(
        cli,
        "perform_configuration_checks",
        MagicMock(return_value={"schema_complete": True}),
    )
    monkeypatch.setattr(
        cli, "execute_required_actions", MagicMock(return_value=True)
    )
    return api, options, checker, actions, checker_factory, actions_factory


def test_main_stops_when_environment_setup_fails(monkeypatch):
    parse_options = MagicMock(
        return_value=({}, SimpleNamespace(check_only=False, debuglevel=0))
    )
    setup_environment = MagicMock(return_value=False)
    checker_factory = MagicMock()
    monkeypatch.setattr(cli, "parse_options", parse_options)
    monkeypatch.setattr(cli, "setup_environment", setup_environment)
    monkeypatch.setattr(cli, "IPAChecker", checker_factory)

    assert cli.main() == 1
    setup_environment.assert_called_once_with(parse_options.return_value[1])
    checker_factory.assert_not_called()


def test_main_stops_when_critical_requirements_fail(monkeypatch):
    api, _options, checker, _actions, checker_factory, actions_factory = (
        _prepare_main(monkeypatch, connected=False)
    )
    cli.check_critical_requirements.return_value = False

    assert cli.main() == 1
    checker_factory.assert_called_once_with(cli.logger, api)
    cli.perform_configuration_checks.assert_not_called()
    actions_factory.assert_not_called()
    api.Backend.ldap2.disconnect.assert_not_called()


def test_main_check_only_skips_actions_and_disconnects(monkeypatch, capsys):
    api, _options, checker, _actions, _checker_factory, actions_factory = (
        _prepare_main(monkeypatch, check_only=True)
    )

    assert cli.main() == 0
    cli.perform_configuration_checks.assert_called_once_with(checker)
    actions_factory.assert_not_called()
    cli.execute_required_actions.assert_not_called()
    api.Backend.ldap2.disconnect.assert_called_once_with()
    assert "Check-only mode" in capsys.readouterr().out


def test_main_returns_failure_when_required_action_fails(monkeypatch):
    api, _options, checker, actions, _checker_factory, actions_factory = (
        _prepare_main(monkeypatch)
    )
    cli.execute_required_actions.return_value = False

    assert cli.main() == 1
    actions_factory.assert_called_once_with(cli.logger, api)
    cli.execute_required_actions.assert_called_once_with(
        actions,
        cli.perform_configuration_checks.return_value,
        checker,
    )
    api.Backend.ldap2.disconnect.assert_called_once_with()


def test_main_completes_installation_and_disconnects(monkeypatch, capsys):
    api, _options, checker, actions, _checker_factory, _actions_factory = (
        _prepare_main(monkeypatch)
    )

    assert cli.main() == 0
    cli.execute_required_actions.assert_called_once_with(
        actions,
        cli.perform_configuration_checks.return_value,
        checker,
    )
    api.Backend.ldap2.disconnect.assert_called_once_with()
    assert "Setup complete" in capsys.readouterr().out
