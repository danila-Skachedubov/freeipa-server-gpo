"""Focused unit tests for the Group Policy Master FreeIPA plugin."""

import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from ipalib import errors
from ipapython.dn import DN


MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "plugin/ipaserver/plugins/gpmaster.py"
)
SPEC = importlib.util.spec_from_file_location("gpmaster_under_test", MODULE_PATH)
GPMASTER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GPMASTER)

BASEDN = DN(("dc", "example"), ("dc", "test"))
CHAIN_DN = DN(("cn", "primary"), ("cn", "gpo-chains"), BASEDN)


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("primary", ["primary"]),
        (("primary", "fallback"), ["primary", "fallback"]),
        (["primary", "fallback"], ["primary", "fallback"]),
    ],
)
def test_normalize_to_list(value, expected):
    assert GPMASTER._normalize_to_list(value) == expected


def _resolver(chain_object=None, ldap=None):
    chain = chain_object or MagicMock()
    backend = ldap or MagicMock()
    subject = SimpleNamespace(
        api=SimpleNamespace(
            Object=SimpleNamespace(chain=chain),
            Backend=SimpleNamespace(ldap2=backend),
        )
    )
    return subject, chain, backend


@pytest.mark.parametrize("chain_dn", [str(CHAIN_DN), str(CHAIN_DN).upper()])
def test_resolve_chain_name_preserves_existing_dn(chain_dn):
    subject, chain, ldap = _resolver()

    result = GPMASTER.gpmaster.resolve_chain_name(subject, chain_dn, strict=True)

    assert result == chain_dn
    chain.get_dn.assert_not_called()
    ldap.get_entry.assert_not_called()


def test_resolve_chain_name_uses_chain_object():
    subject, chain, ldap = _resolver()
    chain.get_dn.return_value = CHAIN_DN

    result = GPMASTER.gpmaster.resolve_chain_name(subject, "primary")

    assert result == str(CHAIN_DN)
    chain.get_dn.assert_called_once_with("primary")
    ldap.get_entry.assert_not_called()


def test_strict_chain_resolution_verifies_ldap_entry():
    subject, chain, ldap = _resolver()
    chain.get_dn.return_value = CHAIN_DN

    result = GPMASTER.gpmaster.resolve_chain_name(
        subject, "primary", strict=True
    )

    assert result == str(CHAIN_DN)
    ldap.get_entry.assert_called_once_with(CHAIN_DN, attrs_list=["cn"])


def test_non_strict_chain_resolution_preserves_unknown_name():
    subject, chain, _ldap = _resolver()
    chain.get_dn.side_effect = errors.NotFound(reason="missing")

    assert GPMASTER.gpmaster.resolve_chain_name(subject, "missing") == "missing"


def test_strict_chain_resolution_reports_unknown_chain():
    subject, chain, _ldap = _resolver()
    chain.get_dn.side_effect = errors.NotFound(reason="missing")

    with pytest.raises(errors.NotFound, match="Chain 'missing' not found"):
        GPMASTER.gpmaster.resolve_chain_name(subject, "missing", strict=True)


def test_strict_chain_resolution_translates_backend_error():
    subject, chain, _ldap = _resolver()
    chain.get_dn.side_effect = RuntimeError("LDAP unavailable")

    with pytest.raises(errors.ValidationError, match="LDAP unavailable"):
        GPMASTER.gpmaster.resolve_chain_name(subject, "primary", strict=True)


def test_convert_chain_names_to_dns_normalizes_input_types():
    subject = SimpleNamespace(
        resolve_chain_name=MagicMock(
            side_effect=lambda name, _strict: name.upper()
        )
    )

    assert GPMASTER.gpmaster.convert_chain_names_to_dns(subject, None) == []
    assert GPMASTER.gpmaster.convert_chain_names_to_dns(subject, "one") == [
        "ONE"
    ]
    assert GPMASTER.gpmaster.convert_chain_names_to_dns(
        subject, ("one", "two")
    ) == ["ONE", "TWO"]
    assert GPMASTER.gpmaster.convert_chain_names_to_dns(
        subject, ["three"]
    ) == ["THREE"]


def test_convert_chain_dns_to_names_keeps_unresolved_values():
    first_dn = str(CHAIN_DN)
    missing_dn = str(DN(("cn", "missing"), ("cn", "gpo-chains"), BASEDN))
    broken_dn = str(DN(("cn", "broken"), ("cn", "gpo-chains"), BASEDN))
    ldap = MagicMock()

    def get_entry(dn, attrs_list):
        if str(dn) == first_dn:
            return {"cn": ["primary"]}
        if str(dn) == missing_dn:
            raise errors.NotFound(reason="missing")
        raise RuntimeError("LDAP unavailable")

    ldap.get_entry.side_effect = get_entry

    result = GPMASTER.gpmaster.convert_chain_dns_to_names(
        SimpleNamespace(), ldap, [first_dn, missing_dn, broken_dn]
    )

    assert result == ["primary", missing_dn, broken_dn]
    assert GPMASTER.gpmaster.convert_chain_dns_to_names(
        SimpleNamespace(), ldap, None
    ) == []


def test_get_gpmaster_dn_uses_global_basedn(monkeypatch):
    monkeypatch.setattr(
        GPMASTER, "api", SimpleNamespace(env=SimpleNamespace(basedn=BASEDN))
    )

    assert GPMASTER.gpmaster.get_gpmaster_dn(SimpleNamespace()) == DN(
        ("cn", "grouppolicymaster"),
        ("cn", "etc"),
        BASEDN,
    )
