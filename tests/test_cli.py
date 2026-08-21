import logging
from unittest.mock import MagicMock

from ipa_gpo_install import cli


def _make_checker(**kwargs):
    logger = logging.getLogger('test-cli-checker')
    api = MagicMock()
    api.env.domain = kwargs.get('domain', 'test.example.com')
    checker = MagicMock(spec=cli.IPAChecker)
    checker.logger = logger
    checker.api = api
    return checker


def _make_actions():
    actions = MagicMock(spec=cli.IPAActions)
    actions.logger = logging.getLogger('test-cli-actions')
    actions.api = MagicMock()
    return actions


class TestCheckCriticalRequirements:
    """
    check_critical_requirements(checker) -> bool

    Checks three conditions in order:
      1. Kerberos ticket
      2. Admin privileges
      3. IPA services

    Returns False on first failure.
    """

    def test_all_pass(self):
        checker = _make_checker()
        checker.check_kerberos_ticket.return_value = True
        checker.check_admin_privileges.return_value = True
        checker.check_ipa_services.return_value = True
        assert cli.check_critical_requirements(checker) is True

    def test_kerberos_fails(self):
        checker = _make_checker()
        checker.check_kerberos_ticket.return_value = False
        assert cli.check_critical_requirements(checker) is False

    def test_admin_fails(self):
        checker = _make_checker()
        checker.check_kerberos_ticket.return_value = True
        checker.check_admin_privileges.return_value = False
        assert cli.check_critical_requirements(checker) is False

    def test_services_fails(self):
        checker = _make_checker()
        checker.check_kerberos_ticket.return_value = True
        checker.check_admin_privileges.return_value = True
        checker.check_ipa_services.return_value = False
        assert cli.check_critical_requirements(checker) is False


class TestPerformConfigurationChecks:
    """
    perform_configuration_checks(checker) -> dict

    Runs non-critical checks and returns results dict:
      - schema_complete
      - adtrust_enabled
      - sysvol_directory
      - sysvol_share
      - editor_filesystem
    """

    def test_all_pass(self):
        checker = _make_checker()
        checker.check_schema_complete.return_value = True
        checker.check_adtrust_installed.return_value = True
        checker.check_sysvol_directory.return_value = True
        checker.check_sysvol_share.return_value = True
        checker.check_editor_filesystem.return_value = True
        results = cli.perform_configuration_checks(checker)
        assert results['schema_complete'] is True
        assert results['adtrust_enabled'] is True
        assert results['sysvol_directory'] is True
        assert results['sysvol_share'] is True
        assert results['editor_filesystem'] is True

    def test_all_fail(self):
        checker = _make_checker()
        checker.check_schema_complete.return_value = False
        checker.check_adtrust_installed.return_value = False
        checker.check_sysvol_directory.return_value = False
        checker.check_sysvol_share.return_value = False
        checker.check_editor_filesystem.return_value = False
        results = cli.perform_configuration_checks(checker)
        assert all(v is False for v in results.values())

    def test_mixed_results(self):
        checker = _make_checker()
        checker.check_schema_complete.return_value = True
        checker.check_adtrust_installed.return_value = False
        checker.check_sysvol_directory.return_value = True
        checker.check_sysvol_share.return_value = False
        checker.check_editor_filesystem.return_value = True
        results = cli.perform_configuration_checks(checker)
        assert results['schema_complete'] is True
        assert results['adtrust_enabled'] is False


class TestRunTask:
    """
    run_task(name, task_func, *args) -> bool

    Runs a callable and returns its result.
    On exception returns False.
    """

    def test_success(self):
        assert cli.run_task('test', lambda: True) is True

    def test_failure(self):
        assert cli.run_task('test', lambda: False) is False

    def test_exception_returns_false(self):
        def boom():
            raise RuntimeError('oops')
        assert cli.run_task('test', boom) is False

    def test_passes_args(self):
        called_with = []
        def capture(a, b):
            called_with.append((a, b))
            return True
        cli.run_task('test', capture, 1, 2)
        assert called_with == [(1, 2)]


class TestExecuteRequiredActions:
    """
    execute_required_actions(actions, check_results) -> bool

    Orchestrates installation steps based on check results.

    Logic:
      - If !adtrust_enabled -> install_adtrust
      - If !sysvol_directory -> create_sysvol_directory
      - If !sysvol_share -> create_sysvol_share
      - configure_editor_filesystem (always)
      - are_plugins_activated -> if not, activate_plugins
      - restart_oddjob (always)
      - If !schema_complete -> run_ipa_server_upgrade
    """

    def test_all_checks_pass_minimal_actions(self):
        actions = _make_actions()
        actions.are_plugins_activated.return_value = True
        actions.restart_oddjob.return_value = True
        actions.configure_editor_filesystem.return_value = True
        check_results = {
            'adtrust_enabled': True,
            'sysvol_directory': True,
            'sysvol_share': True,
            'schema_complete': True,
        }
        assert cli.execute_required_actions(actions, check_results) is True
        actions.install_adtrust.assert_not_called()
        actions.create_sysvol_directory.assert_not_called()
        actions.create_sysvol_share.assert_not_called()

    def test_adtrust_not_installed_triggers_install(self):
        actions = _make_actions()
        actions.install_adtrust.return_value = True
        actions.are_plugins_activated.return_value = True
        actions.restart_oddjob.return_value = True
        actions.configure_editor_filesystem.return_value = True
        check_results = {
            'adtrust_enabled': False,
            'sysvol_directory': True,
            'sysvol_share': True,
            'schema_complete': True,
        }
        assert cli.execute_required_actions(actions, check_results) is True
        actions.install_adtrust.assert_called_once()

    def test_sysvol_missing_triggers_create(self):
        actions = _make_actions()
        actions.create_sysvol_directory.return_value = True
        actions.create_sysvol_share.return_value = True
        actions.are_plugins_activated.return_value = True
        actions.restart_oddjob.return_value = True
        actions.configure_editor_filesystem.return_value = True
        check_results = {
            'adtrust_enabled': True,
            'sysvol_directory': False,
            'sysvol_share': False,
            'schema_complete': True,
        }
        assert cli.execute_required_actions(actions, check_results) is True
        actions.create_sysvol_directory.assert_called_once()
        actions.create_sysvol_share.assert_called_once()

    def test_plugins_not_activated_triggers_activate(self):
        actions = _make_actions()
        actions.are_plugins_activated.return_value = False
        actions.activate_plugins.return_value = True
        actions.restart_oddjob.return_value = True
        actions.configure_editor_filesystem.return_value = True
        check_results = {
            'adtrust_enabled': True,
            'sysvol_directory': True,
            'sysvol_share': True,
            'schema_complete': True,
        }
        assert cli.execute_required_actions(actions, check_results) is True
        actions.activate_plugins.assert_called_once()

    def test_schema_incomplete_triggers_upgrade(self):
        actions = _make_actions()
        actions.are_plugins_activated.return_value = True
        actions.restart_oddjob.return_value = True
        actions.configure_editor_filesystem.return_value = True
        actions.run_ipa_server_upgrade.return_value = True
        check_results = {
            'adtrust_enabled': True,
            'sysvol_directory': True,
            'sysvol_share': True,
            'schema_complete': False,
        }
        assert cli.execute_required_actions(actions, check_results) is True
        actions.run_ipa_server_upgrade.assert_called_once()

    def test_task_failure_stops_execution(self):
        actions = _make_actions()
        actions.install_adtrust.return_value = False
        check_results = {
            'adtrust_enabled': False,
            'sysvol_directory': False,
            'sysvol_share': False,
            'schema_complete': False,
        }
        assert cli.execute_required_actions(actions, check_results) is False
        actions.create_sysvol_directory.assert_not_called()

    def test_plugins_activate_failure_stops(self):
        actions = _make_actions()
        actions.are_plugins_activated.return_value = False
        actions.activate_plugins.return_value = False
        check_results = {
            'adtrust_enabled': True,
            'sysvol_directory': True,
            'sysvol_share': True,
            'schema_complete': True,
        }
        assert cli.execute_required_actions(actions, check_results) is False

    def test_oddjob_failure_stops(self):
        actions = _make_actions()
        actions.are_plugins_activated.return_value = True
        actions.restart_oddjob.return_value = False
        check_results = {
            'adtrust_enabled': True,
            'sysvol_directory': True,
            'sysvol_share': True,
            'schema_complete': True,
        }
        assert cli.execute_required_actions(actions, check_results) is False

    def test_editor_filesystem_failure_stops(self):
        actions = _make_actions()
        actions.configure_editor_filesystem.return_value = False
        check_results = {
            'adtrust_enabled': True,
            'sysvol_directory': True,
            'sysvol_share': True,
            'schema_complete': True,
        }
        assert cli.execute_required_actions(actions, check_results) is False

    def test_editor_filesystem_health_check_failure_stops_later_actions(self):
        actions = _make_actions()
        actions.configure_editor_filesystem.return_value = True
        checker = _make_checker()
        checker.check_editor_filesystem.return_value = False
        check_results = {
            'adtrust_enabled': True,
            'sysvol_directory': True,
            'sysvol_share': True,
            'schema_complete': False,
        }

        assert cli.execute_required_actions(
            actions, check_results, checker
        ) is False

        actions.configure_editor_filesystem.assert_called_once_with()
        checker.check_editor_filesystem.assert_called_once_with()
        actions.are_plugins_activated.assert_not_called()
        actions.activate_plugins.assert_not_called()
        actions.restart_oddjob.assert_not_called()
        actions.run_ipa_server_upgrade.assert_not_called()

    def test_upgrade_failure_stops(self):
        actions = _make_actions()
        actions.are_plugins_activated.return_value = True
        actions.restart_oddjob.return_value = True
        actions.configure_editor_filesystem.return_value = True
        actions.run_ipa_server_upgrade.return_value = False
        check_results = {
            'adtrust_enabled': True,
            'sysvol_directory': True,
            'sysvol_share': True,
            'schema_complete': False,
        }
        assert cli.execute_required_actions(actions, check_results) is False
