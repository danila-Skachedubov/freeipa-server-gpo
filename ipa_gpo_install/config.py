#!/usr/bin/env python3

import os


FREEIPA_BASE_PATH = "/var/lib/freeipa"
FREEIPA_SYSVOL_PATH = os.path.join(FREEIPA_BASE_PATH, "sysvol")

LOG_FILE_PATH = "/var/log/freeipa/ipa-gpo-install.log"
LOCALE_DIR = "/usr/share/locale"

# Target directories for plugin activation
TARGET_PYTHON_PLUGINS = "/usr/lib64/python3/site-packages/ipaserver/plugins"
TARGET_UI_PLUGINS = "/usr/share/ipa/ui/js/plugins/chain"
TARGET_SCHEMA_DIR = "/usr/share/ipa/schema.d"
TARGET_UPDATE_DIR = "/usr/share/ipa/updates"
TARGET_DBUS_CONFIG_DIR = "/etc/oddjobd.conf.d"
TARGET_DBUS_HANDLERS_DIR = "/usr/libexec/ipa/oddjob"

REQUIRED_SCHEMA_CLASSES = [
    'groupPolicyContainer',
    'groupPolicyChain',
    'groupPolicyMaster'
]

def get_domain_sysvol_path(domain):
    return os.path.join(FREEIPA_SYSVOL_PATH, domain)

def get_policies_path(domain):
    return os.path.join(get_domain_sysvol_path(domain), "Policies")

def get_policy_path(domain, guid):
    return os.path.join(get_policies_path(domain), guid)

def get_scripts_path(domain):
    return os.path.join(get_domain_sysvol_path(domain), "scripts")

def get_gpt_ini_path(domain, guid):
    return os.path.join(get_policy_path(domain, guid), "GPT.INI")
