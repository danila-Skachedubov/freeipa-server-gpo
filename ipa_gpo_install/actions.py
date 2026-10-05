#!/usr/bin/env python3
"""Actions module for IPA GPO installation - handles system operations."""

import os
import logging
import gettext
import locale
from pathlib import Path

from ipalib import api
from ipaplatform.services import knownservices
from ipapython import ipautil
from .config import (
    LOCALE_DIR, FREEIPA_BASE_PATH, FREEIPA_SYSVOL_PATH,
    get_domain_sysvol_path, get_policies_path,
    TARGET_PYTHON_PLUGINS, TARGET_UI_PLUGINS, TARGET_SCHEMA_DIR,
    TARGET_UPDATE_DIR, TARGET_DBUS_CONFIG_DIR, TARGET_DBUS_HANDLERS_DIR
)
from .filesystem import (
    ensure_editor_state_directory,
    ensure_path_traversal_acls,
    ensure_policies_root_acl,
)


UI_PLUGIN_FILES = (
    'chain.js',
    'gpo.js',
    'css/main.css',
    'css/icons.css',
    'css/other.css',
    'img/arrow.svg',
    'img/close.svg',
    'img/svg/arrow.svg',
    'img/svg/close.svg',
    'img/svg/ico/computer.svg',
    'img/svg/ico/file.svg',
    'img/svg/ico/folder.svg',
    'img/svg/ico/user.svg',
    'img/svg/ico/applications.svg',
    'img/svg/ico/battery.svg',
    'img/svg/ico/browser.svg',
    'img/svg/ico/calendar.svg',
    'img/svg/ico/clock.svg',
    'img/svg/ico/collection.svg',
    'img/svg/ico/components.svg',
    'img/svg/ico/connection.svg',
    'img/svg/ico/cpu.svg',
    'img/svg/ico/database.svg',
    'img/svg/ico/device.svg',
    'img/svg/ico/directory-query.svg',
    'img/svg/ico/domain.svg',
    'img/svg/ico/drive.svg',
    'img/svg/ico/environment.svg',
    'img/svg/ico/expansion-card.svg',
    'img/svg/ico/file-match.svg',
    'img/svg/ico/files.svg',
    'img/svg/ico/filter-unknown.svg',
    'img/svg/ico/folder-settings.svg',
    'img/svg/ico/globe.svg',
    'img/svg/ico/ini.svg',
    'img/svg/ico/ip-range.svg',
    'img/svg/ico/language.svg',
    'img/svg/ico/laptop.svg',
    'img/svg/ico/memory.svg',
    'img/svg/ico/network-card.svg',
    'img/svg/ico/network.svg',
    'img/svg/ico/org-unit.svg',
    'img/svg/ico/other-settings.svg',
    'img/svg/ico/package-query.svg',
    'img/svg/ico/power.svg',
    'img/svg/ico/powershell.svg',
    'img/svg/ico/preferences.svg',
    'img/svg/ico/printer.svg',
    'img/svg/ico/processing.svg',
    'img/svg/ico/registry.svg',
    'img/svg/ico/run-once.svg',
    'img/svg/ico/scheduled-task.svg',
    'img/svg/ico/script-logoff.svg',
    'img/svg/ico/script-logon.svg',
    'img/svg/ico/script-start.svg',
    'img/svg/ico/script-stop.svg',
    'img/svg/ico/script.svg',
    'img/svg/ico/security-group.svg',
    'img/svg/ico/services.svg',
    'img/svg/ico/shared-folder.svg',
    'img/svg/ico/shortcut.svg',
    'img/svg/ico/site.svg',
    'img/svg/ico/start-menu.svg',
    'img/svg/ico/system-query.svg',
    'img/svg/ico/system-settings.svg',
    'img/svg/ico/system.svg',
    'img/svg/ico/terminal.svg',
    'img/svg/ico/users.svg',
    'js/app.js',
    'js/components/category-path.js',
    'js/components/editor-icons.js',
    'js/components/list-navigation.js',
    'js/components/collection-control.js',
    'js/components/collection-dialog.js',
    'js/components/divider/divider.js',
    'js/components/editor-dialog.js',
    'js/components/editor-status.js',
    'js/components/footer/footer.js',
    'js/components/header/header.js',
    'js/components/main/main.js',
    'js/components/confirmation-dialog.js',
    'js/components/templates/admx-template.js',
    'js/components/templates/advanced-audit-template.js',
    'js/components/templates/advanced-audit/model.js',
    'js/components/templates/all-policies-template.js',
    'js/components/templates/all-policies/model.js',
    'js/components/templates/default-template.js',
    'js/components/templates/folder-template.js',
    'js/components/templates/preference/layouts/applications.js',
    'js/components/templates/preference/layouts/control-panel.js',
    'js/components/templates/preference/layouts/data-sources.js',
    'js/components/templates/preference/layouts/devices.js',
    'js/components/templates/preference/layouts/drives.js',
    'js/components/templates/preference/layouts/environment-variables.js',
    'js/components/templates/preference/layouts/files.js',
    'js/components/templates/preference/layouts/folder-options.js',
    'js/components/templates/preference/layouts/folders.js',
    'js/components/templates/preference/layouts/index.js',
    'js/components/templates/preference/layouts/ini-files.js',
    'js/components/templates/preference/layouts/internet-settings.js',
    'js/components/templates/preference/layouts/local-users-and-groups.js',
    'js/components/templates/preference/layouts/network-options.js',
    'js/components/templates/preference/layouts/network-shares.js',
    'js/components/templates/preference/layouts/power-options.js',
    'js/components/templates/preference/layouts/printers.js',
    'js/components/templates/preference/layouts/regional-options.js',
    'js/components/templates/preference/layouts/registry.js',
    'js/components/templates/preference/layouts/scheduled-tasks.js',
    'js/components/templates/preference/layouts/services.js',
    'js/components/templates/preference/layouts/shortcuts.js',
    'js/components/templates/preference/layouts/start-menu.js',
    'js/components/templates/preference/preferences-view-template.js',
    'js/components/templates/preference/targeting-editor.js',
    'js/components/templates/preference/targeting-presentations.js',
    'js/components/templates/preference/targeting-operand-editor.js',
    'js/components/templates/preference/targeting-typed-input.js',
    'js/components/templates/security-template.js',
    'js/components/templates/security/dialog.js',
    'js/components/templates/security/dependency-plan.js',
    'js/components/templates/security/header-actions.js',
    'js/components/templates/security/model.js',
    'js/components/templates/security/value-editor.js',
    'js/components/templates/security/workbench.js',
    'js/components/templates/script-template.js',
    'js/components/tree-view/tree-view-list-data.js',
    'js/components/tree-view/tree-view-list.js',
    'js/components/tree-view/tree-view.js',
    'js/components/workspace/workspace.js',
    'js/locales/en.js',
    'js/locales/ru.js',
    'js/locales/translations.js',
    'js/util/API.js',
    'js/util/collection-value.js',
    'js/util/editor-dto.js',
    'js/util/targeting-tree-draft.js',
    'js/util/element-creator.js',
    'js/util/resizable.js',
)

PLUGIN_FILE_GROUPS = (
    (TARGET_PYTHON_PLUGINS, ('chain.py', 'gpmaster.py', 'gpo.py')),
    (TARGET_UI_PLUGINS, UI_PLUGIN_FILES),
    (TARGET_SCHEMA_DIR, (
        '75-chain.ldif', '75-gpc.ldif', '75-gpmaster.ldif',
    )),
    (TARGET_UPDATE_DIR, (
        '75-chain.update', '75-gpc.update', '75-gpmaster.update',
    )),
    (TARGET_DBUS_CONFIG_DIR, ('ipa-gpo.conf',)),
    (TARGET_DBUS_HANDLERS_DIR, (
        'org.freeipa.server.create-gpo-structure',
        'org.freeipa.server.delete-gpo-structure',
    )),
)


def _plugin_file_is_healthy(target_dir, filename):
    target_path = os.path.join(target_dir, filename)
    if not os.path.isfile(target_path):
        return False
    if target_dir == TARGET_DBUS_HANDLERS_DIR:
        return os.access(target_path, os.X_OK)
    return True

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

    def configure_editor_filesystem(self):
        """Provision private editor state and the fresh Policies root."""
        try:
            policies_path = Path(get_policies_path(self.api.env.domain))
            self.logger.info(_("Configuring private GPO editor state"))
            ensure_editor_state_directory()

            self.logger.info(
                _("Configuring GPO editor ACLs on {}").format(policies_path)
            )
            ensure_path_traversal_acls((
                Path(FREEIPA_BASE_PATH),
                Path(FREEIPA_SYSVOL_PATH),
                policies_path.parent,
            ))
            ensure_policies_root_acl(policies_path)
            self.logger.info(_("GPO editor filesystem configured successfully"))
            return True
        except Exception as exc:
            self.logger.error(
                _("Error configuring GPO editor filesystem: {}").format(exc)
            )
            return False

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
                self.logger.error(
                    _("Failed to set create mask parameter: {}").format(
                        result_setparm.error_output
                    )
                )
                return False

            self.logger.info(_("SYSVOL share created successfully"))
            return True

        except Exception as e:
            self.logger.error(_("Error creating SYSVOL share: {}").format(e))
            return False

    def check_group_policy_update_assets(self):
        """Fail before installation mutates anything if update assets are missing."""
        for target_dir, filenames in (
                (TARGET_SCHEMA_DIR, ('75-chain.ldif', '75-gpc.ldif', '75-gpmaster.ldif')),
                (TARGET_UPDATE_DIR, ('75-chain.update', '75-gpc.update', '75-gpmaster.update'))):
            for filename in filenames:
                path = os.path.join(target_dir, filename)
                if not os.path.isfile(path) or not os.access(path, os.R_OK):
                    self.logger.error(
                        _("Required Group Policy update asset '{}' is missing or unreadable. Reinstall the freeipa-server-gpo package.").format(path)
                    )
                    return False
        return True

    def run_ipa_server_upgrade(self):
        """
        Run ipa-server-upgrade to apply schema changes and updates.
        
        Returns:
            True if the upgrade succeeds, otherwise False.
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
        Restart the oddjob service to load new D-Bus handlers.
        
        Returns:
            True if the restart succeeds, otherwise False.
        """
        try:
            self.logger.info(_("Restarting oddjob service"))

            restart_cmd = ['systemctl', 'restart', 'oddjobd']
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

    def restart_httpd(self):
        """Restart Apache so its IPA workers load the installed plugins."""
        try:
            self.logger.info(_("Restarting httpd service"))

            # FreeIPA maps the logical ``httpd`` service to the native unit
            # name (``httpd2.service`` on ALT Linux).
            knownservices.httpd.restart()
            self.logger.info(_("httpd service restarted successfully"))
            return True

        except Exception as e:
            self.logger.error(
                _("Error restarting httpd service: {}").format(e)
            )
            return False

    def are_plugins_activated(self):
        """
        Check if plugin files are present in target directories.

        Returns:
            True if all plugin files are present in target directories,
            False if any are missing.
        """
        for target_dir, filenames in PLUGIN_FILE_GROUPS:
            for filename in filenames:
                target_path = os.path.join(target_dir, filename)
                if not _plugin_file_is_healthy(target_dir, filename):
                    self.logger.debug(
                        _("Plugin file not found: {}").format(target_path)
                    )
                    return False
        return True

    def activate_plugins(self) -> bool:
        """
        Verify that plugin files are present in target directories.
        Since staging directories have been removed, this method only
        checks that files are already installed by the package.

        Returns:
            True if all plugin files are present, False otherwise.
        """
        self.logger.info(_("Checking plugin files installation"))
        missing_files = []
        for target_dir, filenames in PLUGIN_FILE_GROUPS:
            for filename in filenames:
                target_path = os.path.join(target_dir, filename)
                if not _plugin_file_is_healthy(target_dir, filename):
                    missing_files.append(target_path)
                    self.logger.error(
                        _("Plugin file not found: {}").format(target_path)
                    )

        if missing_files:
            self.logger.error(
                _("Plugin files missing. Please ensure the freeipa-server-gpo package is installed.")
            )
            return False

        self.logger.info(_("All plugin files are present"))
        return True
