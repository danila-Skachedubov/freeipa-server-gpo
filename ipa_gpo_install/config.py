#!/usr/bin/env python3

import os


FREEIPA_BASE_PATH = "/var/lib/freeipa"
FREEIPA_SYSVOL_PATH = os.path.join(FREEIPA_BASE_PATH, "sysvol")

LOG_FILE_PATH = "/var/log/freeipa/ipa-gpo-install.log"
LOCALE_DIR = "/usr/share/locale"

SCHEMA_LDIF_PATH = "/usr/share/ipa-gpo-install/data/74alt-group-policy.ldif"

REQUIRED_SCHEMA_CLASSES = ['altOrganizationalUnit', 'groupPolicyContainer']

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