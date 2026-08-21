"""Tests for paths used by the IPA GPO installer."""

from ipa_gpo_install.config import (
    get_domain_sysvol_path,
    get_gpt_ini_path,
    get_policies_path,
    get_policy_path,
    get_scripts_path,
)


DOMAIN = "test.example.com"
GUID = "{A2B3C4D5-E6F7-4A8B-9C0D-1E2F3A4B5C6D}"


def test_get_domain_sysvol_path():
    assert get_domain_sysvol_path(DOMAIN) == (
        "/var/lib/freeipa/sysvol/test.example.com"
    )


def test_get_policies_path():
    assert get_policies_path(DOMAIN) == (
        "/var/lib/freeipa/sysvol/test.example.com/Policies"
    )


def test_get_policy_path():
    assert get_policy_path(DOMAIN, GUID) == (
        "/var/lib/freeipa/sysvol/test.example.com/Policies/" + GUID
    )


def test_get_scripts_path():
    assert get_scripts_path(DOMAIN) == (
        "/var/lib/freeipa/sysvol/test.example.com/scripts"
    )


def test_get_gpt_ini_path():
    assert get_gpt_ini_path(DOMAIN, GUID) == (
        "/var/lib/freeipa/sysvol/test.example.com/Policies/" + GUID + "/GPT.INI"
    )
