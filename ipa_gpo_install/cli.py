#!/usr/bin/env python3

import os
import sys
import logging
import gettext
import locale
from typing import Dict, Tuple, Any, Callable

from ipapython.config import IPAOptionParser
from ipapython.admintool import  admin_cleanup_global_argv
from ipapython import version
from ipapython.ipa_log_manager import standard_logging_setup
from ipalib import api, errors
from ipaplatform.paths import paths
#from ipaserver.install.installutils import run_script
from ipaserver.install.installutils import (run_script)

from ipa_gpo_install.checks import IPAChecker
from ipa_gpo_install.actions import IPAActions
from .config import LOG_FILE_PATH, REQUIRED_SCHEMA_CLASSES, LOCALE_DIR


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

logger = logging.getLogger(os.path.basename(__file__))

def parse_options() -> Tuple[Dict, Any]:
    """Parse command line arguments"""
    parser = IPAOptionParser(version=version.VERSION)
    parser.add_option("--debuglevel", type="int", dest="debuglevel",
                      default=0, metavar="LEVEL",
                      help=_("Debug level: 0=errors, 1=warnings, 2=debug"))
    parser.add_option("--check-only", dest="check_only", action="store_true",
                      default=False, help=_("Only perform checks without making changes"))

    options, _args = parser.parse_args()
    safe_options = parser.get_safe_opts(options)
    admin_cleanup_global_argv(parser, options, sys.argv)

    return safe_options, options

def setup_environment(options: Any) -> bool:
    """Set up environment and initialize API"""
    try:
        if os.geteuid() != 0:
            logger.error(_("Must be root to setup Group Policy features on server"))
            return False

        verbose, debug = options.debuglevel >= 1, options.debuglevel >= 2
        os.makedirs(os.path.dirname(LOG_FILE_PATH), exist_ok=True)
        standard_logging_setup(LOG_FILE_PATH, verbose=verbose, debug=debug, filemode='a')
        print(_("The log file for this installation can be found in {}").format(LOG_FILE_PATH))

        for log_module in ['ipalib', 'ipapython', 'ipaserver', 'ipaplatform']:
            logging.getLogger(log_module).setLevel(logging.CRITICAL)

        logger.info(_("Initializing IPA API"))
        api.bootstrap(in_server=True, debug=False, context='installer', confdir=paths.ETC_IPA)
        api.finalize()

        try:
            api.Backend.ldap2.connect()
            logger.info(_("Connected to LDAP server"))
            return True
        except errors.ACIError:
            logger.error(_("Outdated Kerberos credentials. Use kdestroy and kinit to update your ticket"))
            return False
        except errors.DatabaseError:
            logger.error(_("Cannot connect to the LDAP database. Please check if IPA is running"))
            return False

    except Exception as e:
        logger.error(_("Error setting up environment: {}").format(e))
        return False

def check_critical_requirements(checker: IPAChecker) -> bool:
    """Check critical requirements that must be met before proceeding"""

    logger.info(_("Checking Kerberos ticket"))
    if not checker.check_kerberos_ticket():
        logger.error(_("Missing Kerberos ticket. Run 'kinit' to obtain a valid ticket."))
        return False

    logger.info(_("Checking admin privileges"))
    if not checker.check_admin_privileges():
        logger.error(_("Administrative privileges required."))
        return False

    logger.info(_("Checking IPA services"))
    if not checker.check_ipa_services():
        logger.error(_("Essential IPA services are not running."))
        return False

    return True

def perform_configuration_checks(checker: IPAChecker) -> Dict[str, Any]:
    """Perform non-critical checks to determine what actions are needed"""
    results = {}

    logger.info(_("Checking LDAP schema for required object classes"))
    results['schema_complete'] = checker.check_schema_complete(REQUIRED_SCHEMA_CLASSES)

    logger.info(_("Checking if AD Trust is enabled"))
    results['adtrust_enabled'] = checker.check_adtrust_installed()

    logger.info(_("Checking SYSVOL directory and share"))
    results['sysvol_directory'] = checker.check_sysvol_directory()
    results['sysvol_share'] = checker.check_sysvol_share()

    return results


def run_task(name: str, task_func: Callable, *args) -> bool:
    """Run a task with proper logging"""
    logger.info(_("Running task: {}").format(name))
    try:
        result = task_func(*args)
        if result:
            logger.info(_("Task succeeded: {}").format(name))
        else:
            logger.error(_("Task failed: {}").format(name))
        return result
    except Exception as e:
        logger.error(_("Task failed with error: {} - {}").format(name, e))
        return False


def execute_required_actions(actions: IPAActions, check_results: Dict[str, Any]) -> bool:
    """Execute required actions based on check results"""
    tasks = []

    if not check_results['adtrust_enabled']:
        tasks.append((_("Install AD Trust"), actions.install_adtrust))

    if not check_results['sysvol_directory']:
        tasks.append((_("Create SYSVOL directory"), actions.create_sysvol_directory))

    if not check_results['sysvol_share']:
        tasks.append((_("Create SYSVOL share"), actions.create_sysvol_share))

    for task in tasks:
        if not run_task(*task):
            return False

    if not check_results['schema_complete']:
        logger.warning(_("About to perform irreversible schema update"))
        if not run_task(_("Run ipa-server-upgrade"), actions.run_ipa_server_upgrade):
            return False

    return True


def main():
    """Main entry point for the application"""

    _safe_options, options = parse_options()
    if not setup_environment(options):
        return 1
    try:
        checker = IPAChecker(logger, api)
        logger.info(_("Checking critical requirements"))
        if not check_critical_requirements(checker):
            return 1

        logger.info(_("Performing configuration environment checks"))
        check_results = perform_configuration_checks(checker)

        if options.check_only:
            print(_("Check-only mode: all checks completed"))
            return 0

        actions = IPAActions(logger, api)
        if not execute_required_actions(actions, check_results):
            return 1

        print(_("""
=============================================================================
Setup complete

The IPA LDAP schema has been extended with Group Policy related object classes.
You can now proceed with Group Policy configuration.
=============================================================================
"""))

        return 0
    finally:
        if api.Backend.ldap2.isconnected():
            api.Backend.ldap2.disconnect()


if __name__ == '__main__':
    run_script(main, log_file_name=LOG_FILE_PATH, operation_name='ipa-gpo-install')
