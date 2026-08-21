"""Tests for paths and input validation used by the IPA GPO installer."""

import pytest

from ipa_gpo_install.config import (
    get_domain_sysvol_path,
    get_gpt_ini_path,
    get_policies_path,
    get_policy_path,
    get_scripts_path,
    is_valid_domain,
)


DOMAIN = "test.example.com"
GUID = "{A2B3C4D5-E6F7-4A8B-9C0D-1E2F3A4B5C6D}"


@pytest.mark.parametrize(
    "domain",
    [
        "example.com",
        "ipa-01.sub.example.com",
        "EXAMPLE.COM",
        "xn--e1afmkfd.xn--p1ai",
        "a" * 63 + ".example",
    ],
)
def test_valid_domain(domain):
    assert is_valid_domain(domain) is True


@pytest.mark.parametrize(
    "domain",
    [
        None,
        42,
        "",
        "localhost",
        "example..com",
        "example.com.",
        "example/com",
        "example\\com",
        "example .com",
        "exa_mple.com",
        "*.example",
        "-bad.example",
        "bad-.example",
        "a" * 64 + ".example",
        "a." + "b" * 252,
    ],
)
def test_invalid_domain(domain):
    assert is_valid_domain(domain) is False


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
