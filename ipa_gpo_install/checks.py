#!/usr/bin/env python3

import os
import subprocess
import logging
import gettext
import locale

import ldap

from ipalib import api
from ipalib import krb_utils
from ipapython import ipautil
from .config import LOCALE_DIR, get_domain_sysvol_path


try:
    locale.setlocale(locale.LC_ALL, '')
    current_locale, encoding = locale.getlocale()
    if not current_locale:
        current_locale = 'en_US'
    translation = gettext.translation('ipa-gpo-install',
                                     LOCALE_DIR,
                                     languages=[current_locale.split('_')[0]],
                                     fallback=True)
    _ = translation.gettext
except Exception as e:
    def _(text):
        return text

class IPAChecker:
    """Class for performing various checks in IPA environment"""

    def __init__(self, logger=None, api_instance=None):
        """
        Initialize the checker

        Args:
            logger: Logger instance, if None - will use default logger
            api_instance: Existing IPA API instance, if None - will try to use global api
        """
        self.logger = logger or logging.getLogger('ipa-gpo-install')
        self.api = api_instance or api

    def check_kerberos_ticket(self):
        """
        Check if a valid Kerberos ticket exists

        Returns:
            True if a ticket exists and is valid, otherwise False
        """
        try:
            self.logger.debug(_("Checking for valid Kerberos ticket"))
            principal = krb_utils.get_principal()

            if principal:
                self.logger.debug(_("Kerberos ticket exists for {}").format(principal))
                return True
            else:
                self.logger.debug(_("Valid Kerberos ticket not found"))
                return False

        except Exception as e:
            self.logger.debug(_("Error checking Kerberos ticket: {}").format(e))
            return False

    def check_admin_privileges(self):
        """
        Check if current user has admin privileges

        Returns:
            True if user has admin privileges, otherwise False
        """
        try:
            principal = krb_utils.get_principal()
            if not principal:
                self.logger.error(_("No valid Kerberos principal found"))
                return False
            username = principal.partition('@')[0].partition('/')[0]
            user = self.api.Command.user_show(username)['result']
            group = self.api.Command.group_show('admins')['result']

            has_admin = (user['uid'][0] in group['member_user'] and
                        group['cn'][0] in user['memberof_group'])

            if has_admin:
                self.logger.info(_("User {} has admin privileges").format(username))
            else:
                self.logger.warning(_("User {} does not have admin privileges").format(username))
            return has_admin

        except Exception as e:
            self.logger.error(_("Error checking admin privileges: {}").format(e))
            return False

    def check_ipa_services(self):
        """
        Check if all essential IPA services are running

        Returns:
            True if all essential services are running, otherwise False
        """
        try:
            domain = self.api.env.domain
            if not domain:
                self.logger.error(_("Cannot determine domain name for services check"))
                return False
            domain_suffix = domain.upper().replace('.', '-')

            services = [
                f'dirsrv@{domain_suffix}',
                'krb5kdc',
                'ipa',
                'sssd',
                'oddjobd'
            ]
            self.logger.debug(_("Checking IPA services"))

            for service in services:
                cmd = ['systemctl', 'is-active', service]
                self.logger.debug(_("Running: {}").format(' '.join(cmd)))

                result = ipautil.run(cmd, raiseonerr=False)

                if result.returncode != 0:
                    if service == 'oddjob':
                        self.logger.warning(_(
                            "Service {} is not active - will be started during installation"
                        ).format(service))
                    else:
                        self.logger.error(_("Service {} is not active").format(service))
                        return False
                else:
                    self.logger.debug(_("Service {} is active").format(service))

            self.logger.info(_("All essential services are running"))
            return True

        except Exception as e:
            self.logger.error(_("Error checking IPA services: {}").format(e))
            return False

    def check_schema_complete(self, object_class_names):
        """
        Check if all required object classes exist in LDAP schema

        Args:
            object_class_names: List of object class names to check

        Returns:
            True if all classes exist, False if any is missing
        """
        try:
            conn = self.api.Backend.ldap2.conn
            try:
                schema_entry = conn.search_s('cn=schema', ldap.SCOPE_BASE,
                    attrlist=['attributetypes', 'objectclasses'])[0]
            except ldap.NO_SUCH_OBJECT:
                self.logger.debug(_("cn=schema not found, fallback to cn=subschema"))
                schema_entry = conn.search_s('cn=subschema', ldap.SCOPE_BASE,
                    attrlist=['attributetypes', 'objectclasses'])[0]

            schema = ldap.schema.SubSchema(schema_entry[1])

            for class_name in object_class_names:
                if schema.get_obj(ldap.schema.ObjectClass, class_name) is None:
                    self.logger.debug(_(
                        "Object class '{}' does not exist in schema"
                    ).format(class_name))
                    return False

            self.logger.debug(_("All required object classes exist in schema"))
            return True

        except Exception as e:
            self.logger.error(_("Error checking schema object classes: {}").format(e))
            return False

    def check_adtrust_installed(self):
        """
        Check if AD Trust support is enabled in FreeIPA

        Returns:
            True if AD Trust is enabled, False otherwise
        """
        try:
            if not hasattr(self.api.Command, 'adtrust_is_enabled'):
                self.logger.error(_("AD Trust command not available"))
                return False
            result = self.api.Command.adtrust_is_enabled()
            enabled = result.get('result', False)
            if enabled:
                self.logger.info(_("AD Trust is enabled"))
            else:
                self.logger.warning(_("AD Trust is not enabled"))

            return enabled

        except Exception as e:
            self.logger.error(_("Error checking AD Trust status: {}").format(e))
            return False

    def check_sysvol_directory(self):
        """
        Check if SYSVOL directory exists

        Returns:
            True if directory exists, False otherwise
        """
        try:
            sysvol_path = get_domain_sysvol_path(self.api.env.domain)

            if os.path.exists(sysvol_path) and os.path.isdir(sysvol_path):

                policies_path = os.path.join(sysvol_path, "Policies")
                scripts_path = os.path.join(sysvol_path, "scripts")

                has_policies = os.path.exists(policies_path) and os.path.isdir(policies_path)
                has_scripts = os.path.exists(scripts_path) and os.path.isdir(scripts_path)

                if has_policies and has_scripts:
                    self.logger.info(_("SYSVOL directory exists with required structure"))
                    return True
                else:
                    self.logger.warning(_("SYSVOL directory exists but missing subdirectories"))
                    return False
            else:
                self.logger.warning(_("SYSVOL directory does not exist: {}").format(sysvol_path))
                return False

        except Exception as e:
            self.logger.error(_("Error checking SYSVOL directory: {}").format(e))
            return False

    def check_sysvol_share(self):
        """
        Check if SYSVOL share exists

        Returns:
            True if share exists, False otherwise
        """
        try:
            self.logger.debug(_("Checking if SYSVOL share exists"))
            cmd = ["net", "conf", "list"]
            result = subprocess.run(cmd, capture_output=True, text=True, check=False)
            if result.returncode != 0:
                self.logger.error(_("Error listing Samba shares: {}").format(result.stderr))
                return False

            has_share = "sysvol" in result.stdout
            if has_share:
                self.logger.info(_("SYSVOL share exists"))
            else:
                self.logger.warning(_("SYSVOL share does not exist"))

            return has_share

        except Exception as e:
            self.logger.error(_("Error checking SYSVOL share: {}").format(e))
            return False
