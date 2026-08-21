import logging
from unittest.mock import patch, MagicMock

from ipa_gpo_install.actions import IPAActions


def _make_actions():
    logger = logging.getLogger('test-actions')
    api = MagicMock()
    api.env.domain = 'test.example.com'
    return IPAActions(logger=logger, api_instance=api)


class TestInstallAdtrust:
    """
    install_adtrust() -> bool

    Installs AD Trust support via ipa-adtrust-install -U.

    Cases:
      1. Binary exists, command succeeds  -> True
      2. Binary exists, command fails     -> False
      3. Binary not found                 -> False
      4. Exception                        -> False
    """

    @patch('ipa_gpo_install.actions.os.path.exists', return_value=True)
    @patch('ipa_gpo_install.actions.ipautil.run')
    def test_success(self, mock_run, mock_exists):
        mock_run.return_value = MagicMock(returncode=0, error_output='')
        actions = _make_actions()
        assert actions.install_adtrust() is True

    @patch('ipa_gpo_install.actions.os.path.exists', return_value=True)
    @patch('ipa_gpo_install.actions.ipautil.run')
    def test_command_fails(self, mock_run, mock_exists):
        mock_run.return_value = MagicMock(returncode=1, error_output='error')
        actions = _make_actions()
        assert actions.install_adtrust() is False

    @patch('ipa_gpo_install.actions.os.path.exists', return_value=False)
    def test_binary_not_found(self, mock_exists):
        actions = _make_actions()
        assert actions.install_adtrust() is False

    @patch('ipa_gpo_install.actions.os.path.exists', return_value=True)
    @patch('ipa_gpo_install.actions.ipautil.run', side_effect=Exception('boom'))
    def test_exception(self, mock_run, mock_exists):
        actions = _make_actions()
        assert actions.install_adtrust() is False


class TestSetDefaultAcl:
    """
    _set_default_acl(path) -> bool

    Sets default ACLs on a directory using setfacl.

    Cases:
      1. setfacl available, command succeeds  -> True
      2. setfacl available, command fails     -> False
      3. setfacl not available                -> False
    """

    @patch('ipa_gpo_install.actions.ipautil.run')
    def test_acl_set_success(self, mock_run):
        mock_run.return_value = MagicMock(returncode=0, error_output='')
        actions = _make_actions()
        from pathlib import Path
        assert actions._set_default_acl(Path('/tmp/test')) is True
        assert mock_run.call_count == 2

    @patch('ipa_gpo_install.actions.ipautil.run')
    def test_acl_set_fails(self, mock_run):
        which_ok = MagicMock(returncode=0)
        setfacl_fail = MagicMock(returncode=1, error_output='denied')
        mock_run.side_effect = [which_ok, setfacl_fail]
        actions = _make_actions()
        from pathlib import Path
        assert actions._set_default_acl(Path('/tmp/test')) is False

    @patch('ipa_gpo_install.actions.ipautil.run')
    def test_setfacl_not_available(self, mock_run):
        mock_run.return_value = MagicMock(returncode=1)
        actions = _make_actions()
        from pathlib import Path
        assert actions._set_default_acl(Path('/tmp/test')) is False
        assert mock_run.call_count == 1


class TestCreateSysvolDirectory:
    """
    create_sysvol_directory() -> bool

    Creates SYSVOL directory structure:
      /var/lib/freeipa/sysvol/{domain}/Policies
      /var/lib/freeipa/sysvol/{domain}/scripts

    Cases:
      1. All dirs created, ACL succeeds     -> True
      2. All dirs created, ACL fails (chmod) -> True (with warning)
      3. Exception                           -> False
    """

    @patch('ipa_gpo_install.actions.ipautil.run')
    @patch('ipa_gpo_install.actions.get_domain_sysvol_path')
    @patch('pathlib.Path.mkdir')
    def test_success_with_acl(self, mock_mkdir, mock_sysvol_path, mock_run):
        mock_sysvol_path.return_value = '/var/lib/freeipa/sysvol/test.example.com'
        mock_run.return_value = MagicMock(returncode=0, error_output='')
        actions = _make_actions()
        assert actions.create_sysvol_directory() is True

    @patch('ipa_gpo_install.actions.ipautil.run')
    @patch('ipa_gpo_install.actions.get_domain_sysvol_path')
    @patch('pathlib.Path.mkdir')
    @patch('os.chmod')
    def test_acl_fallback_uses_chmod(self, mock_chmod, mock_mkdir, mock_sysvol_path, mock_run):
        mock_sysvol_path.return_value = '/var/lib/freeipa/sysvol/test.example.com'
        which_fail = MagicMock(returncode=1)
        mock_run.side_effect = [which_fail]
        actions = _make_actions()
        assert actions.create_sysvol_directory() is True
        assert mock_chmod.call_count == 3

    @patch('ipa_gpo_install.actions.get_domain_sysvol_path')
    def test_exception(self, mock_sysvol_path):
        mock_sysvol_path.side_effect = Exception('no domain')
        actions = _make_actions()
        assert actions.create_sysvol_directory() is False


class TestCreateSysvolShare:
    """
    create_sysvol_share() -> bool

    Creates SYSVOL Samba share via 'net conf addshare'.

    Cases:
      1. Dir exists, addshare + setparm succeed  -> True
      2. Dir exists, addshare succeeds, setparm fails -> True (warning)
      3. Dir exists, addshare fails              -> False
      4. Dir does not exist                      -> False
      5. Exception                               -> False
    """

    @patch('ipa_gpo_install.actions.os.path.exists', return_value=True)
    @patch('ipa_gpo_install.actions.ipautil.run')
    def test_success(self, mock_run, mock_exists):
        mock_run.return_value = MagicMock(returncode=0, error_output='')
        actions = _make_actions()
        assert actions.create_sysvol_share() is True
        assert mock_run.call_count == 2

    @patch('ipa_gpo_install.actions.os.path.exists', return_value=True)
    @patch('ipa_gpo_install.actions.ipautil.run')
    def test_setparm_fails_ok(self, mock_run, mock_exists):
        addshare_ok = MagicMock(returncode=0, error_output='')
        setparm_fail = MagicMock(returncode=1, error_output='parm error')
        mock_run.side_effect = [addshare_ok, setparm_fail]
        actions = _make_actions()
        assert actions.create_sysvol_share() is True

    @patch('ipa_gpo_install.actions.os.path.exists', return_value=True)
    @patch('ipa_gpo_install.actions.ipautil.run')
    def test_addshare_fails(self, mock_run, mock_exists):
        mock_run.return_value = MagicMock(returncode=1, error_output='share error')
        actions = _make_actions()
        assert actions.create_sysvol_share() is False

    @patch('ipa_gpo_install.actions.os.path.exists', return_value=False)
    def test_dir_not_exists(self, mock_exists):
        actions = _make_actions()
        assert actions.create_sysvol_share() is False

    @patch('ipa_gpo_install.actions.os.path.exists', return_value=True)
    @patch('ipa_gpo_install.actions.ipautil.run', side_effect=Exception('boom'))
    def test_exception(self, mock_run, mock_exists):
        actions = _make_actions()
        assert actions.create_sysvol_share() is False


class TestRunIpaServerUpgrade:
    """
    run_ipa_server_upgrade() -> bool

    Runs /usr/sbin/ipa-server-upgrade.

    Cases:
      1. Command succeeds  -> True
      2. Command fails     -> False
      3. Exception         -> False
    """

    @patch('ipa_gpo_install.actions.ipautil.run')
    def test_success(self, mock_run):
        mock_run.return_value = MagicMock(returncode=0, error_output='')
        actions = _make_actions()
        assert actions.run_ipa_server_upgrade() is True

    @patch('ipa_gpo_install.actions.ipautil.run')
    def test_fails(self, mock_run):
        mock_run.return_value = MagicMock(returncode=1, error_output='upgrade error')
        actions = _make_actions()
        assert actions.run_ipa_server_upgrade() is False

    @patch('ipa_gpo_install.actions.ipautil.run', side_effect=Exception('err'))
    def test_exception(self, mock_run):
        actions = _make_actions()
        assert actions.run_ipa_server_upgrade() is False


class TestRestartOddjob:
    """
    restart_oddjob() -> bool

    Runs systemctl restart oddjobd.

    Cases:
      1. Restart succeeds  -> True
      2. Restart fails     -> False
      3. Exception         -> False
    """

    @patch('ipa_gpo_install.actions.ipautil.run')
    def test_success(self, mock_run):
        mock_run.return_value = MagicMock(returncode=0, error_output='')
        actions = _make_actions()
        assert actions.restart_oddjob() is True

    @patch('ipa_gpo_install.actions.ipautil.run')
    def test_fails(self, mock_run):
        mock_run.return_value = MagicMock(returncode=1, error_output='no service')
        actions = _make_actions()
        assert actions.restart_oddjob() is False

    @patch('ipa_gpo_install.actions.ipautil.run', side_effect=Exception('err'))
    def test_exception(self, mock_run):
        actions = _make_actions()
        assert actions.restart_oddjob() is False


class TestConfigureEditorFilesystem:
    """Tests for provisioning the filesystem used by the current editor."""

    @patch('ipa_gpo_install.actions.ensure_policies_root_acl')
    @patch('ipa_gpo_install.actions.ensure_editor_state_directory')
    @patch('ipa_gpo_install.actions.get_policies_path')
    def test_success(self, mock_path, mock_state, mock_acl):
        mock_path.return_value = '/var/lib/freeipa/sysvol/test/Policies'

        actions = _make_actions()

        assert actions.configure_editor_filesystem() is True
        mock_state.assert_called_once_with()
        mock_acl.assert_called_once()
        assert str(mock_acl.call_args.args[0]).endswith('/test/Policies')

    @patch(
        'ipa_gpo_install.actions.ensure_editor_state_directory',
        side_effect=RuntimeError('state error'),
    )
    def test_state_directory_failure(self, mock_state):
        actions = _make_actions()

        assert actions.configure_editor_filesystem() is False
        mock_state.assert_called_once_with()

    @patch(
        'ipa_gpo_install.actions.ensure_policies_root_acl',
        side_effect=RuntimeError('ACL error'),
    )
    @patch('ipa_gpo_install.actions.ensure_editor_state_directory')
    def test_policies_acl_failure(self, mock_state, mock_acl):
        actions = _make_actions()

        assert actions.configure_editor_filesystem() is False
        mock_state.assert_called_once_with()
        mock_acl.assert_called_once()


class TestArePluginsActivated:
    """
    are_plugins_activated() -> bool

    Checks if all plugin files exist in target directories.
    Returns False as soon as any file is missing.

    File groups:
      - Python plugins: chain.py, gpmaster.py, gpo.py
      - UI plugins: chain.js, gpo.js
      - Schema: 75-chain.ldif, 75-gpc.ldif, 75-gpmaster.ldif
      - Updates: 75-chain.update, 75-gpc.update, 75-gpmaster.update
      - DBus config: ipa-gpo.conf
      - DBus handlers: create/delete-gpo-structure
    """

    @patch('ipa_gpo_install.actions.os.path.exists', return_value=True)
    def test_all_present(self, mock_exists):
        actions = _make_actions()
        assert actions.are_plugins_activated() is True

    @patch('ipa_gpo_install.actions.os.path.exists', return_value=False)
    def test_missing_file(self, mock_exists):
        actions = _make_actions()
        assert actions.are_plugins_activated() is False

    @patch('ipa_gpo_install.actions.os.path.exists')
    def test_first_missing_stops_early(self, mock_exists):
        mock_exists.return_value = False
        actions = _make_actions()
        assert actions.are_plugins_activated() is False
        assert mock_exists.call_count == 1


class TestActivatePlugins:
    """
    activate_plugins() -> bool

    Checks all plugin files are present (same list as are_plugins_activated).
    Returns False with list of missing files.

    Cases:
      1. All files present     -> True
      2. Some files missing    -> False
      3. All files missing     -> False
    """

    @patch('ipa_gpo_install.actions.os.path.exists', return_value=True)
    def test_all_present(self, mock_exists):
        actions = _make_actions()
        assert actions.activate_plugins() is True

    @patch('ipa_gpo_install.actions.os.path.exists', return_value=False)
    def test_all_missing(self, mock_exists):
        actions = _make_actions()
        assert actions.activate_plugins() is False

    @patch('ipa_gpo_install.actions.os.path.exists')
    def test_checks_all_files(self, mock_exists):
        mock_exists.return_value = True
        actions = _make_actions()
        actions.activate_plugins()
        assert mock_exists.call_count == 14

    @patch('ipa_gpo_install.actions.os.path.exists')
    def test_reports_missing(self, mock_exists):
        mock_exists.side_effect = lambda p: 'chain.py' not in p
        actions = _make_actions()
        assert actions.activate_plugins() is False
