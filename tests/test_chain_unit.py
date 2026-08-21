"""Focused unit tests for Group Policy Chain helper functions."""

import importlib.util
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from ipapython.dn import DN


MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "plugin/ipaserver/plugins/chain.py"
)
SPEC = importlib.util.spec_from_file_location("chain_under_test", MODULE_PATH)
CHAIN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHAIN)

BASEDN = DN(("dc", "example"), ("dc", "test"))
FIRST_DN = DN(("cn", "first"), ("cn", "groups"), BASEDN)
SECOND_DN = DN(("cn", "second"), ("cn", "groups"), BASEDN)


class Entry(dict):
    """Minimal LDAP entry used by the helper-function tests."""

    def __init__(self, dn, **attributes):
        super().__init__(attributes)
        self.dn = dn


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (None, []),
        ("first", ["first"]),
        (("first", "second"), ["first", "second"]),
        (["first", "second"], ["first", "second"]),
        ({"first"}, ["first"]),
    ],
)
def test_normalize_to_list(value, expected):
    assert CHAIN._normalize_to_list(value) == expected


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (str(FIRST_DN), True),
        (str(FIRST_DN).upper(), True),
        (FIRST_DN, True),
        ("first", False),
        (None, False),
    ],
)
def test_is_dn_recognizes_cn_distinguished_names(value, expected):
    assert CHAIN.is_dn(value) is expected


@pytest.mark.parametrize(
    ("entry", "expected"),
    [
        (
            Entry(FIRST_DN, displayName=["Visible name"], cn=["first"]),
            "Visible name",
        ),
        (Entry(FIRST_DN, cn=["first"]), "first"),
        (Entry(FIRST_DN), str(FIRST_DN)),
        (Entry(FIRST_DN, displayName=[], cn=[]), str(FIRST_DN)),
    ],
)
def test_get_display_name_uses_available_fallback(entry, expected):
    assert CHAIN.get_display_name(entry) == expected


def test_safe_ldap_get_entry_converts_dn_and_returns_entry():
    ldap = MagicMock()
    expected = Entry(FIRST_DN, cn=["first"])
    ldap.get_entry.return_value = expected

    result = CHAIN.safe_ldap_get_entry(ldap, str(FIRST_DN), ("cn",))

    assert result is expected
    ldap.get_entry.assert_called_once_with(FIRST_DN, attrs_list=("cn",))


def test_safe_ldap_get_entry_returns_none_on_backend_error():
    ldap = MagicMock()
    ldap.get_entry.side_effect = RuntimeError("LDAP unavailable")

    assert CHAIN.safe_ldap_get_entry(ldap, str(FIRST_DN), ["cn"]) is None


def test_resolve_dns_to_names_uses_batch_lookup_and_filters_names():
    ldap = MagicMock()
    ldap.get_entries.return_value = [
        Entry(FIRST_DN, displayName=["First policy"]),
        Entry(SECOND_DN, cn=["second"]),
    ]

    result = CHAIN.resolve_dns_to_names(
        ldap,
        [str(FIRST_DN), "not-a-dn", SECOND_DN],
    )

    assert result == {
        str(FIRST_DN): "First policy",
        str(SECOND_DN): "second",
    }
    ldap.get_entries.assert_called_once_with(
        [FIRST_DN, SECOND_DN],
        attrs_list=["displayName", "cn"],
    )


def test_resolve_dns_to_names_skips_ldap_for_empty_dn_list():
    ldap = MagicMock()

    assert CHAIN.resolve_dns_to_names(ldap, ["first", None]) == {}
    ldap.get_entries.assert_not_called()
    ldap.get_entry.assert_not_called()


def test_resolve_dns_to_names_falls_back_to_individual_lookups():
    ldap = MagicMock()
    ldap.get_entries.side_effect = RuntimeError("batch lookup unavailable")
    ldap.get_entry.side_effect = [
        Entry(FIRST_DN, cn=["first"]),
        RuntimeError("entry unavailable"),
    ]

    result = CHAIN.resolve_dns_to_names(
        ldap,
        [str(FIRST_DN), str(SECOND_DN)],
        attrs=["cn"],
    )

    assert result == {
        str(FIRST_DN): "first",
        str(SECOND_DN): str(SECOND_DN),
    }
    assert ldap.get_entry.call_count == 2


def test_convert_dns_in_entries_updates_fields_and_runs_extra_processing(
    monkeypatch,
):
    entries = [
        {
            "usergroup": str(FIRST_DN),
            "gplink": (str(SECOND_DN), "unresolved"),
        },
        {},
    ]
    ldap = MagicMock()
    resolver = MagicMock(
        return_value={
            str(FIRST_DN): "first",
            str(SECOND_DN): "Second policy",
        }
    )
    extra_processing = MagicMock()
    monkeypatch.setattr(CHAIN, "resolve_dns_to_names", resolver)

    CHAIN.convert_dns_in_entries(
        entries,
        ldap,
        attrs_by_field={
            "usergroup": ["cn"],
            "gplink": ["displayName", "cn"],
        },
        extra_processing={"gplink": extra_processing},
    )

    assert entries == [
        {
            "usergroup": ["first"],
            "gplink": ["Second policy", "unresolved"],
        },
        {"usergroup": [], "gplink": []},
    ]
    resolver.assert_called_once()
    resolver_args, resolver_kwargs = resolver.call_args
    assert resolver_args[0] is ldap
    assert resolver_args[1] == {
        str(FIRST_DN),
        str(SECOND_DN),
        "unresolved",
    }
    assert set(resolver_kwargs["attrs"]) == {"displayName", "cn"}
    assert extra_processing.call_args_list[0].args == (
        entries[0],
        ["Second policy", "unresolved"],
    )
    assert extra_processing.call_args_list[1].args == (entries[1], [])
