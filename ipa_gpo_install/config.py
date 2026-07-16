#!/usr/bin/env python3

import os
import re


FREEIPA_BASE_PATH = "/var/lib/freeipa"
FREEIPA_SYSVOL_PATH = os.path.join(FREEIPA_BASE_PATH, "sysvol")
GPO_EDITOR_STATE_DIR = os.path.join(FREEIPA_BASE_PATH, "gpo-editor-state")
GPO_EDITOR_USER = "ipaapi"
GPO_EDITOR_GROUP = "ipaapi"

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

GUID_PATTERN = re.compile(
    r'^\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}'
    r'-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}$'
)


def is_valid_guid(guid):
    return bool(GUID_PATTERN.match(guid))


def is_valid_domain(domain):
    if not domain or '/' in domain or '\\' in domain or '..' in domain:
        return False
    parts = domain.split('.')
    return len(parts) >= 2 and all(p for p in parts)

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
