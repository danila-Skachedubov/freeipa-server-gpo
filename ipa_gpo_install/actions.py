#!/usr/bin/env python3
"""Actions module for IPA GPO installation - handles system operations."""

import os
import logging
import gettext
import locale
from pathlib import Path

from ipalib import api
from ipapython import ipautil
from .config import LOCALE_DIR, FREEIPA_BASE_PATH, get_domain_sysvol_path

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

class IPAActions:
    """Class for performing actions in IPA environment"""

    def __init__(self, logger=None, api_instance=None):
        """
        Initialize the actions handler

        Args:
            logger: Logger instance, if None - will use default logger
            api_instance: Existing IPA API instance, if None - will try to use global api
        """
        self.logger = logger or logging.getLogger('ipa-gpo-install')
        self.api = api_instance or api

    def install_adtrust(self):
        """
        Install and configure AD Trust support

        Returns:
            True if installation was successful, False otherwise
        """
        try:
            self.logger.info(_("Installing AD Trust support"))
            if not os.path.exists('/usr/sbin/ipa-adtrust-install'):
                self.logger.error(_("ipa-adtrust-install not found"))
                return False
            cmd = ['/usr/sbin/ipa-adtrust-install', '-U']

            self.logger.debug(_("Running: {}").format(' '.join(cmd)))
            result = ipautil.run(cmd, raiseonerr=False)

            if result.returncode != 0:
                self.logger.error(_("Failed to install AD Trust: {}").format(result.error_output))
                return False
            self.logger.info(_("AD Trust installed successfully"))
            return True

        except Exception as e:
            self.logger.error(_("Error installing AD Trust: {}").format(e))
            return False

    def create_sysvol_directory(self):
        """
        Create SYSVOL directory structure with inherited permissions.
        Returns True if creation was successful, False otherwise.
        """
        try:
            freeipa_dir = Path(FREEIPA_BASE_PATH)
            sysvol_path_str = get_domain_sysvol_path(self.api.env.domain)
            sysvol_path = Path(sysvol_path_str)
            policies_path = sysvol_path / "Policies"
            scripts_path = sysvol_path / "scripts"

            freeipa_dir.mkdir(parents=True, exist_ok=True)
            acl_set = self._set_default_acl(freeipa_dir)

            for path in [sysvol_path, policies_path, scripts_path]:
                path.mkdir(parents=True, exist_ok=True)
                self.logger.debug(_("Created directory: {}").format(path))

            if not acl_set:
                self.logger.warning(_("Using standard permissions for SYSVOL directories"))
                for path in [sysvol_path, policies_path, scripts_path]:
                    os.chmod(path, 0o755)

            self.logger.info(_("SYSVOL directory structure created successfully"))
            return True

        except Exception as e:
            self.logger.error(_("Error creating SYSVOL directory: {}").format(e))
            return False

    def _set_default_acl(self, path: Path) -> bool:
        """
        Tries to set default ACLs on the given path.
        Returns True if successful, False otherwise.
        """
        if ipautil.run(["which", "setfacl"], raiseonerr=False).returncode != 0:
            return False

        self.logger.info(_("Setting default ACLs on {}").format(path))
        cmd = ["setfacl", "-d", "-m", "g:admins:rwx,o::r-x", str(path)]
        result = ipautil.run(cmd, raiseonerr=False)

        if result.returncode != 0:
            self.logger.warning(_("Failed to set ACLs on {}: {}").format(path, result.error_output))
            return False

        self.logger.info(_("Successfully set default ACLs on {}").format(path))
        return True

    def create_sysvol_share(self):
        """
        Create SYSVOL Samba share

        Returns:
            True if creation was successful, False otherwise
        """
        try:
            sysvol_path = f"/var/lib/freeipa/sysvol"
            self.logger.info(_("Creating SYSVOL share for: {}").format(sysvol_path))

            if not os.path.exists(sysvol_path):
                self.logger.error(
                    _("Cannot create share: directory {} does not exist").format(sysvol_path)
                )
                return False

            cmd = ["net", "conf", "addshare", "sysvol", sysvol_path, "writeable=y", "guest_ok=N"]
            self.logger.debug(_("Running: {}").format(' '.join(cmd)))
            result = ipautil.run(cmd, raiseonerr=False)

            if result.returncode != 0:
                self.logger.error(
                    _("Failed to create SYSVOL share: {}").format(result.error_output)
                )
                return False

            cmd_setparm = ["net", "conf", "setparm", "sysvol", "create mask", "0664"]
            self.logger.debug(_("Running: {}").format(' '.join(cmd_setparm)))
            result_setparm = ipautil.run(cmd_setparm, raiseonerr=False)

            if result_setparm.returncode != 0:
                self.logger.warning(_("Failed to set create mask parameter: {}").format(result_setparm.error_output))

            self.logger.info(_("SYSVOL share created successfully"))
            return True

        except Exception as e:
            self.logger.error(_("Error creating SYSVOL share: {}").format(e))
            return False

    def run_ipa_server_upgrade(self):
        """
        Запустить ipa-server-upgrade для применения схем и обновлений
        
        Returns:
            True если обновление прошло успешно, False иначе
        """
        try:
            self.logger.info(_("Running ipa-server-upgrade to apply schema changes"))
            cmd = ['/usr/sbin/ipa-server-upgrade']
            self.logger.debug(_("Running: {}").format(' '.join(cmd)))
            result = ipautil.run(cmd, raiseonerr=False)

            if result.returncode == 0:
                self.logger.info(_("ipa-server-upgrade completed successfully"))
                return True

            error_msg = result.error_output or _("Unknown error")
            self.logger.error(_("ipa-server-upgrade failed: {}").format(error_msg))
            return False

        except Exception as e:
            self.logger.error(_("Error running ipa-server-upgrade: {}").format(e))
            return False

    def restart_oddjob(self):
        """
        Перезапустить службу oddjob для подхвата новых D-Bus обработчиков
        
        Returns:
            True если перезапуск прошел успешно, False иначе
        """
        try:
            self.logger.info(_("Restarting oddjob service"))

            status_cmd = ['systemctl', 'is-active', 'oddjob']
            status_result = ipautil.run(status_cmd, raiseonerr=False)

            if status_result.returncode != 0:
                self.logger.info(_("oddjob service is not running, starting it"))
                start_cmd = ['systemctl', 'start', 'oddjob']
                result = ipautil.run(start_cmd, raiseonerr=False)
            else:
                self.logger.info(_("Restarting oddjob service"))
                restart_cmd = ['systemctl', 'restart', 'oddjob']
                result = ipautil.run(restart_cmd, raiseonerr=False)

            if result.returncode == 0:
                self.logger.info(_("oddjob service restarted successfully"))

                return True
            else:
                error_msg = result.error_output or _("Unknown error")
                self.logger.error(_("Failed to restart oddjob: {}").format(error_msg))
                return False

        except Exception as e:
            self.logger.error(_("Error restarting oddjob service: {}").format(e))
            return False
