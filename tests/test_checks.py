import logging
from unittest.mock import patch, MagicMock, PropertyMock

from ipa_gpo_install.checks import IPAChecker


def _make_checker(api_domain='test.example.com'):
    logger = logging.getLogger('test-checker')
    api = MagicMock()
    api.env.domain = api_domain
    return IPAChecker(logger=logger, api_instance=api)


class TestCheckKerberosTicket:
    """
    check_kerberos_ticket() -> bool

    Checks if a valid Kerberos ticket exists by calling
    krb_utils.get_principal(). The function is wrapped in
    try/except, so any exception returns False.

    Cases:
      1. get_principal() returns a string  -> True
      2. get_principal() returns None      -> False
      3. get_principal() raises Exception  -> False
    """

    @patch('ipa_gpo_install.checks.krb_utils.get_principal')
    def test_ticket_exists(self, mock_principal):
        mock_principal.return_value = 'admin@EXAMPLE.COM'
        checker = _make_checker()
        assert checker.check_kerberos_ticket() is True

    @patch('ipa_gpo_install.checks.krb_utils.get_principal')
    def test_no_ticket(self, mock_principal):
        mock_principal.return_value = None
        checker = _make_checker()
        assert checker.check_kerberos_ticket() is False

    @patch('ipa_gpo_install.checks.krb_utils.get_principal')
    def test_exception_returns_false(self, mock_principal):
        mock_principal.side_effect = Exception('Kerberos error')
        checker = _make_checker()
        assert checker.check_kerberos_ticket() is False


class TestCheckAdminPrivileges:
    """
    check_admin_privileges() -> bool

    Checks if current user has admin privileges:
      1. Get principal from Kerberos -> extract username
      2. Call api.Command.user_show(username)
      3. Call api.Command.group_show('admins')
      4. Check user is in group AND group is in user's memberof

    Cases:
      1. User is admin         -> True
      2. User is not admin     -> False
      3. No Kerberos principal -> False
      4. Exception             -> False
    """

    @patch('ipa_gpo_install.checks.krb_utils.get_principal')
    def test_user_is_admin(self, mock_principal):
        mock_principal.return_value = 'admin@EXAMPLE.COM'
        checker = _make_checker()
        checker.api.Command.user_show.return_value = {
            'result': {
                'uid': ['admin'],
                'memberof_group': ['admins', 'ipausers'],
            }
        }
        checker.api.Command.group_show.return_value = {
            'result': {
                'cn': ['admins'],
                'member_user': ['admin', 'other'],
            }
        }
        assert checker.check_admin_privileges() is True

    @patch('ipa_gpo_install.checks.krb_utils.get_principal')
    def test_user_not_admin(self, mock_principal):
        mock_principal.return_value = 'user@EXAMPLE.COM'
        checker = _make_checker()
        checker.api.Command.user_show.return_value = {
            'result': {
                'uid': ['user'],
                'memberof_group': ['ipausers'],
            }
        }
        checker.api.Command.group_show.return_value = {
            'result': {
                'cn': ['admins'],
                'member_user': ['admin'],
            }
        }
        assert checker.check_admin_privileges() is False

    @patch('ipa_gpo_install.checks.krb_utils.get_principal')
    def test_no_principal(self, mock_principal):
        mock_principal.return_value = None
        checker = _make_checker()
        assert checker.check_admin_privileges() is False

    @patch('ipa_gpo_install.checks.krb_utils.get_principal')
    def test_exception_returns_false(self, mock_principal):
        mock_principal.return_value = 'admin@EXAMPLE.COM'
        checker = _make_checker()
        checker.api.Command.user_show.side_effect = Exception('API error')
        assert checker.check_admin_privileges() is False


class TestCheckAdtrustInstalled:
    """
    check_adtrust_installed() -> bool

    Checks if AD Trust support is enabled:
      1. Check api.Command has 'adtrust_is_enabled' attribute
      2. Call api.Command.adtrust_is_enabled()
      3. Return result.get('result', False)

    Cases:
      1. AD Trust enabled     -> True
      2. AD Trust not enabled -> False
      3. Command not exists   -> False
      4. Exception            -> False
    """

    def test_adtrust_enabled(self):
        checker = _make_checker()
        checker.api.Command.adtrust_is_enabled.return_value = {'result': True}
        assert checker.check_adtrust_installed() is True

    def test_adtrust_not_enabled(self):
        checker = _make_checker()
        checker.api.Command.adtrust_is_enabled.return_value = {'result': False}
        assert checker.check_adtrust_installed() is False

    def test_adtrust_no_result_key(self):
        checker = _make_checker()
        checker.api.Command.adtrust_is_enabled.return_value = {}
        assert checker.check_adtrust_installed() is False

    def test_adtrust_command_not_available(self):
        checker = _make_checker()
        del checker.api.Command.adtrust_is_enabled
        assert checker.check_adtrust_installed() is False

    def test_exception_returns_false(self):
        checker = _make_checker()
        checker.api.Command.adtrust_is_enabled.side_effect = Exception('err')
        assert checker.check_adtrust_installed() is False


class TestCheckSysvolShare:
    """
    check_sysvol_share() -> bool

    Checks if SYSVOL Samba share exists by running 'net conf list'
    and searching for 'sysvol' in stdout.

    Cases:
      1. 'sysvol' in stdout       -> True
      2. 'sysvol' not in stdout   -> False
      3. Command fails (rc != 0)  -> False
      4. Exception                -> False
    """

    @patch('ipa_gpo_install.checks.subprocess.run')
    def test_share_exists(self, mock_run):
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout='[sysvol]\n  path = /var/lib/freeipa/sysvol\n'
        )
        checker = _make_checker()
        assert checker.check_sysvol_share() is True

    @patch('ipa_gpo_install.checks.subprocess.run')
    def test_share_not_exists(self, mock_run):
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout='[other_share]\n  path = /data\n'
        )
        checker = _make_checker()
        assert checker.check_sysvol_share() is False

    @patch('ipa_gpo_install.checks.subprocess.run')
    def test_similar_share_name_is_not_sysvol(self, mock_run):
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout='[not-sysvol-backup]\n  path = /data\n'
        )
        checker = _make_checker()
        assert checker.check_sysvol_share() is False

    @patch('ipa_gpo_install.checks.subprocess.run')
    def test_share_name_is_case_insensitive(self, mock_run):
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout=' [SYSVOL] \n  path = /var/lib/freeipa/sysvol\n'
        )
        checker = _make_checker()
        assert checker.check_sysvol_share() is True

    @patch('ipa_gpo_install.checks.subprocess.run')
    def test_share_with_wrong_path_is_not_healthy(self, mock_run):
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout='[sysvol]\n  path = /data/sysvol\n'
        )
        checker = _make_checker()
        assert checker.check_sysvol_share() is False

    @patch('ipa_gpo_install.checks.subprocess.run')
    def test_share_without_path_is_not_healthy(self, mock_run):
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout='[sysvol]\n  guest ok = No\n'
        )
        checker = _make_checker()
        assert checker.check_sysvol_share() is False

    @patch('ipa_gpo_install.checks.subprocess.run')
    def test_command_fails(self, mock_run):
        mock_run.return_value = MagicMock(returncode=1, stderr='error')
        checker = _make_checker()
        assert checker.check_sysvol_share() is False

    @patch('ipa_gpo_install.checks.subprocess.run')
    def test_exception_returns_false(self, mock_run):
        mock_run.side_effect = Exception('subprocess error')
        checker = _make_checker()
        assert checker.check_sysvol_share() is False


class TestCheckSysvolDirectory:
    """
    check_sysvol_directory() -> bool

    Checks SYSVOL directory structure:
      1. get_domain_sysvol_path(domain) -> base path
      2. Check base path exists and is a directory
      3. Check 'Policies' subdirectory exists
      4. Check 'scripts' subdirectory exists

    Cases:
      1. All dirs exist     -> True
      2. Base missing       -> False
      3. Policies missing   -> False
      4. Scripts missing    -> False
      5. Exception          -> False
    """

    @patch('ipa_gpo_install.checks.os.path.exists', return_value=True)
    @patch('ipa_gpo_install.checks.os.path.isdir', return_value=True)
    def test_all_dirs_exist(self, mock_isdir, mock_exists):
        checker = _make_checker('test.example.com')
        assert checker.check_sysvol_directory() is True

    @patch('ipa_gpo_install.checks.os.path.exists', return_value=False)
    def test_base_missing(self, mock_exists):
        checker = _make_checker('test.example.com')
        assert checker.check_sysvol_directory() is False

    @patch('ipa_gpo_install.checks.os.path.exists')
    @patch('ipa_gpo_install.checks.os.path.isdir', return_value=True)
    def test_policies_missing(self, mock_isdir, mock_exists):
        def exists_side_effect(path):
            if 'Policies' in path:
                return False
            return True
        mock_exists.side_effect = exists_side_effect
        checker = _make_checker('test.example.com')
        assert checker.check_sysvol_directory() is False

    @patch('ipa_gpo_install.checks.os.path.exists')
    @patch('ipa_gpo_install.checks.os.path.isdir', return_value=True)
    def test_scripts_missing(self, mock_isdir, mock_exists):
        def exists_side_effect(path):
            if 'scripts' in path:
                return False
            return True
        mock_exists.side_effect = exists_side_effect
        checker = _make_checker('test.example.com')
        assert checker.check_sysvol_directory() is False

    @patch('ipa_gpo_install.checks.os.path.exists')
    @patch('ipa_gpo_install.checks.os.path.isdir', return_value=True)
    def test_base_is_not_dir(self, mock_isdir, mock_exists):
        def isdir_side_effect(path):
            return False
        mock_isdir.side_effect = isdir_side_effect
        checker = _make_checker('test.example.com')
        assert checker.check_sysvol_directory() is False

    def test_exception_returns_false(self):
        checker = _make_checker()
        type(checker.api.env).domain = PropertyMock(side_effect=Exception('no domain'))
        assert checker.check_sysvol_directory() is False


class TestCheckIpaServices:
    """
    check_ipa_services() -> bool

    Checks essential IPA services via 'systemctl is-active'.
    Services checked: dirsrv@DOMAIN, krb5kdc, ipa, sssd, oddjobd

    Rules:
      - If core service (dirsrv, krb5kdc, ipa, sssd) inactive -> return False
      - If oddjobd is inactive -> only warning, continue
      - All active -> True

    Cases:
      1. All services active    -> True
      2. Core service inactive  -> False
      3. oddjobd inactive       -> True (warning only)
      4. No domain              -> False
      5. Exception              -> False
    """

    @patch('ipa_gpo_install.checks.ipautil.run')
    def test_all_active(self, mock_run):
        mock_run.return_value = MagicMock(returncode=0)
        checker = _make_checker()
        assert checker.check_ipa_services() is True

    @patch('ipa_gpo_install.checks.ipautil.run')
    def test_core_service_inactive(self, mock_run):
        def run_side_effect(cmd, **kwargs):
            if 'krb5kdc' in cmd:
                return MagicMock(returncode=1)
            return MagicMock(returncode=0)
        mock_run.side_effect = run_side_effect
        checker = _make_checker()
        assert checker.check_ipa_services() is False

    @patch('ipa_gpo_install.checks.ipautil.run')
    def test_oddjobd_inactive_ok(self, mock_run):
        def run_side_effect(cmd, **kwargs):
            if 'oddjobd' in cmd:
                return MagicMock(returncode=1)
            return MagicMock(returncode=0)
        mock_run.side_effect = run_side_effect
        checker = _make_checker()
        assert checker.check_ipa_services() is True

    def test_no_domain(self):
        checker = _make_checker()
        checker.api.env.domain = ''
        assert checker.check_ipa_services() is False

    @patch('ipa_gpo_install.checks.ipautil.run')
    def test_exception_returns_false(self, mock_run):
        mock_run.side_effect = Exception('run error')
        checker = _make_checker()
        assert checker.check_ipa_services() is False


class TestCheckSchemaComplete:
    """
    check_schema_complete(object_class_names) -> bool

    Checks if all required LDAP schema object classes exist.
    Uses ldap.schema.SubSchema to look up classes.

    Cases:
      1. All classes exist            -> True
      2. A class is missing           -> False
      3. cn=schema fails, cn=subschema works -> True
      4. Exception                    -> False
    """

    def test_all_classes_exist(self):
        checker = _make_checker()
        mock_conn = MagicMock()

        mock_schema_obj = MagicMock()
        mock_schema_obj.get_obj.return_value = MagicMock()

        mock_subschema = MagicMock()
        mock_subschema.get_obj.return_value = mock_schema_obj

        mock_conn.search_s.return_value = [('cn=schema', {
            'objectclasses': ['( ... )'],
            'attributetypes': [],
        })]

        with patch.object(checker.api.Backend.ldap2, 'conn', mock_conn):
            with patch('ipa_gpo_install.checks.ldap.schema.SubSchema', return_value=mock_subschema):
                result = checker.check_schema_complete(['groupPolicyContainer'])
        assert result is True

    def test_missing_class(self):
        checker = _make_checker()
        mock_conn = MagicMock()

        mock_subschema = MagicMock()
        mock_subschema.get_obj.return_value = None

        mock_conn.search_s.return_value = [('cn=schema', {
            'objectclasses': [],
            'attributetypes': [],
        })]

        with patch.object(checker.api.Backend.ldap2, 'conn', mock_conn):
            with patch('ipa_gpo_install.checks.ldap.schema.SubSchema', return_value=mock_subschema):
                result = checker.check_schema_complete(['missingClass'])
        assert result is False

    def test_exception_returns_false(self):
        checker = _make_checker()
        mock_conn = MagicMock()
        mock_conn.search_s.side_effect = Exception('LDAP error')

        with patch.object(checker.api.Backend.ldap2, 'conn', mock_conn):
            result = checker.check_schema_complete(['groupPolicyContainer'])
        assert result is False
