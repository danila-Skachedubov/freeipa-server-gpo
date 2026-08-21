"""Focused unit tests for Group Policy Chain helper functions."""

import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, call

import pytest
from ipalib import errors
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
USER_GROUP_DN = DN(("cn", "users"), ("cn", "groups"), BASEDN)
COMPUTER_GROUP_DN = DN(("cn", "workstations"), ("cn", "hostgroups"), BASEDN)
GPO_DN = DN(("cn", "policy-guid"), ("cn", "Policies"), ("cn", "System"), BASEDN)


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


def _chain_subject():
    ldap = MagicMock()
    group = MagicMock()
    hostgroup = MagicMock()
    subject = SimpleNamespace(
        api=SimpleNamespace(
            Backend=SimpleNamespace(ldap2=ldap),
            Object={"group": group, "hostgroup": hostgroup},
        ),
        find_gp_by_displayname=MagicMock(),
    )
    return subject, ldap, group, hostgroup


@pytest.mark.parametrize(
    ("attr_name", "name", "object_name", "resolved_dn"),
    [
        ("usergroup", "users", "group", USER_GROUP_DN),
        ("computergroup", "workstations", "hostgroup", COMPUTER_GROUP_DN),
    ],
)
def test_resolve_object_name_uses_freeipa_group_object(
    attr_name,
    name,
    object_name,
    resolved_dn,
):
    subject, ldap, group, hostgroup = _chain_subject()
    objects = {"group": group, "hostgroup": hostgroup}
    objects[object_name].get_dn.return_value = resolved_dn

    result = CHAIN.chain.resolve_object_name(subject, attr_name, name)

    assert result == str(resolved_dn)
    objects[object_name].get_dn.assert_called_once_with(name)
    ldap.get_entry.assert_not_called()


def test_resolve_object_name_strict_mode_verifies_group_in_ldap():
    subject, ldap, group, _hostgroup = _chain_subject()
    group.get_dn.return_value = USER_GROUP_DN

    result = CHAIN.chain.resolve_object_name(
        subject,
        "usergroup",
        "users",
        strict=True,
    )

    assert result == str(USER_GROUP_DN)
    ldap.get_entry.assert_called_once_with(USER_GROUP_DN, attrs_list=["cn"])


def test_resolve_object_name_delegates_gpo_display_name_lookup():
    subject, ldap, _group, _hostgroup = _chain_subject()
    subject.find_gp_by_displayname.return_value = GPO_DN

    result = CHAIN.chain.resolve_object_name(
        subject,
        "gplink",
        "Workstation policy",
        strict=True,
    )

    assert result == str(GPO_DN)
    subject.find_gp_by_displayname.assert_called_once_with("Workstation policy")
    ldap.get_entry.assert_not_called()


@pytest.mark.parametrize(
    ("attr_name", "dn", "attrs"),
    [
        ("usergroup", USER_GROUP_DN, ["cn"]),
        ("computergroup", COMPUTER_GROUP_DN, ["cn"]),
        ("gplink", GPO_DN, ["displayName", "cn"]),
    ],
)
def test_strict_explicit_dn_is_verified_in_ldap(attr_name, dn, attrs):
    subject, ldap, group, hostgroup = _chain_subject()

    result = CHAIN.chain.resolve_object_name(
        subject,
        attr_name,
        str(dn),
        strict=True,
    )

    assert result == str(dn)
    ldap.get_entry.assert_called_once_with(dn, attrs_list=attrs)
    group.get_dn.assert_not_called()
    hostgroup.get_dn.assert_not_called()
    subject.find_gp_by_displayname.assert_not_called()


def test_non_strict_explicit_dn_is_preserved_without_ldap_lookup():
    subject, ldap, group, hostgroup = _chain_subject()

    result = CHAIN.chain.resolve_object_name(
        subject,
        "usergroup",
        str(USER_GROUP_DN).upper(),
    )

    assert result == str(USER_GROUP_DN).upper()
    ldap.get_entry.assert_not_called()
    group.get_dn.assert_not_called()
    hostgroup.get_dn.assert_not_called()


def test_resolve_object_name_preserves_missing_name_in_non_strict_mode():
    subject, _ldap, group, _hostgroup = _chain_subject()
    group.get_dn.side_effect = errors.NotFound(reason="missing")

    assert CHAIN.chain.resolve_object_name(
        subject,
        "usergroup",
        "missing",
    ) == "missing"


def test_resolve_object_name_reports_missing_name_in_strict_mode():
    subject, _ldap, group, _hostgroup = _chain_subject()
    group.get_dn.side_effect = errors.NotFound(reason="missing")

    with pytest.raises(errors.NotFound, match="Group 'missing' not found"):
        CHAIN.chain.resolve_object_name(
            subject,
            "usergroup",
            "missing",
            strict=True,
        )


def test_resolve_object_name_translates_backend_error_in_strict_mode():
    subject, _ldap, group, _hostgroup = _chain_subject()
    group.get_dn.side_effect = RuntimeError("LDAP unavailable")

    with pytest.raises(errors.ValidationError) as failure:
        CHAIN.chain.resolve_object_name(
            subject,
            "usergroup",
            "users",
            strict=True,
        )

    assert failure.value.name == "usergroup"
    assert "LDAP unavailable" in str(failure.value)


@pytest.mark.parametrize(
    ("gplinks", "expected_names"),
    [
        ("first", ["first"]),
        (("first", "second"), ["first", "second"]),
        (["first", "second"], ["first", "second"]),
    ],
)
def test_convert_names_to_dns_normalizes_gplink_values(
    gplinks,
    expected_names,
):
    subject = SimpleNamespace(resolve_object_name=MagicMock())
    subject.resolve_object_name.side_effect = (
        lambda attr_name, name, strict: "dn:{}".format(name)
    )

    result = CHAIN.chain.convert_names_to_dns(
        subject,
        {
            "usergroup": "users",
            "computergroup": "workstations",
            "gplink": gplinks,
        },
        strict=True,
    )

    assert result == {
        "usergroup": "dn:users",
        "computergroup": "dn:workstations",
        "gplink": ["dn:{}".format(name) for name in expected_names],
    }
    assert subject.resolve_object_name.call_args_list == [
        call("usergroup", "users", True),
        call("computergroup", "workstations", True),
        *[call("gplink", name, True) for name in expected_names],
    ]


def test_convert_names_to_dns_ignores_missing_and_empty_options():
    subject = SimpleNamespace(resolve_object_name=MagicMock())

    assert CHAIN.chain.convert_names_to_dns(
        subject,
        {"usergroup": None, "computergroup": "", "gplink": ()},
    ) == {}
    subject.resolve_object_name.assert_not_called()


def test_convert_groups_uses_cn_for_both_group_fields(monkeypatch):
    converter = MagicMock()
    entries = [{"usergroup": [str(USER_GROUP_DN)]}]
    ldap = MagicMock()
    monkeypatch.setattr(CHAIN, "convert_dns_in_entries", converter)

    CHAIN.chain._convert_groups(SimpleNamespace(), entries, ldap)

    converter.assert_called_once_with(
        entries,
        ldap,
        attrs_by_field={"usergroup": ["cn"], "computergroup": ["cn"]},
    )


def test_convert_gpos_populates_association_field(monkeypatch):
    entries = [{"gplink": [str(GPO_DN)]}]
    ldap = MagicMock()
    monkeypatch.setattr(
        CHAIN,
        "resolve_dns_to_names",
        MagicMock(return_value={str(GPO_DN): "Workstation policy"}),
    )

    CHAIN.chain._convert_gpos(SimpleNamespace(), entries, ldap)

    assert entries == [
        {
            "gplink": ["Workstation policy"],
            "gplink_gpo": ["Workstation policy"],
        }
    ]


def _command_api(monkeypatch):
    commands = SimpleNamespace(
        gpmaster_show=MagicMock(),
        gpmaster_mod=MagicMock(),
        chain_show=MagicMock(),
    )
    monkeypatch.setattr(CHAIN, "api", SimpleNamespace(Command=commands))
    return commands


@pytest.mark.parametrize(
    ("active_chains", "expected"),
    [
        (["primary", "fallback"], True),
        (["fallback"], False),
        ([], False),
    ],
)
def test_chain_show_sets_computed_active_state(
    monkeypatch,
    active_chains,
    expected,
):
    commands = _command_api(monkeypatch)
    commands.gpmaster_show.return_value = {
        "result": {"chainlist": active_chains}
    }
    subject = SimpleNamespace(
        obj=SimpleNamespace(convert_attribute_members=MagicMock())
    )
    ldap = MagicMock()
    entry = {"cn": ["primary"]}

    result = CHAIN.chain_show.post_callback(
        subject,
        ldap,
        FIRST_DN,
        entry,
        "primary",
    )

    assert result == FIRST_DN
    assert entry["active"] == [expected]
    subject.obj.convert_attribute_members.assert_called_once_with(
        entry,
        "primary",
    )
    commands.gpmaster_show.assert_called_once_with()


def test_chain_show_raw_mode_preserves_members(monkeypatch):
    commands = _command_api(monkeypatch)
    commands.gpmaster_show.return_value = {"result": {"chainlist": []}}
    subject = SimpleNamespace(
        obj=SimpleNamespace(convert_attribute_members=MagicMock())
    )
    entry = {"gplink": [str(GPO_DN)]}

    CHAIN.chain_show.post_callback(
        subject,
        MagicMock(),
        FIRST_DN,
        entry,
        "primary",
        raw=True,
    )

    assert entry == {"gplink": [str(GPO_DN)], "active": [False]}
    subject.obj.convert_attribute_members.assert_not_called()


def test_chain_show_defaults_to_inactive_when_gpmaster_is_unavailable(
    monkeypatch,
):
    commands = _command_api(monkeypatch)
    commands.gpmaster_show.side_effect = RuntimeError("LDAP unavailable")
    subject = SimpleNamespace(
        obj=SimpleNamespace(convert_attribute_members=MagicMock())
    )
    entry = {}

    CHAIN.chain_show.post_callback(
        subject,
        MagicMock(),
        FIRST_DN,
        entry,
        "primary",
    )

    assert entry["active"] == [False]


def test_chain_show_without_key_does_not_query_gpmaster(monkeypatch):
    commands = _command_api(monkeypatch)
    subject = SimpleNamespace(
        obj=SimpleNamespace(convert_attribute_members=MagicMock())
    )
    entry = {}

    CHAIN.chain_show.post_callback(
        subject,
        MagicMock(),
        FIRST_DN,
        entry,
    )

    assert "active" not in entry
    commands.gpmaster_show.assert_not_called()


@pytest.mark.parametrize(
    ("enable", "current_chains", "modification"),
    [
        (True, ["fallback"], {"add_chain": ["primary"]}),
        (False, ["primary", "fallback"], {"remove_chain": ["primary"]}),
    ],
)
def test_toggle_chain_updates_gpmaster_and_returns_fresh_entry(
    monkeypatch,
    enable,
    current_chains,
    modification,
):
    commands = _command_api(monkeypatch)
    commands.gpmaster_show.return_value = {
        "result": {"chainlist": current_chains}
    }
    commands.chain_show.return_value = {
        "result": {"cn": ["primary"], "active": [enable]}
    }

    result = CHAIN.chain_toggle_base._toggle_chain(
        SimpleNamespace(),
        "primary",
        enable=enable,
    )

    assert result == {
        "result": {"cn": ["primary"], "active": [enable]}
    }
    commands.gpmaster_mod.assert_called_once_with(**modification)
    commands.chain_show.assert_called_once_with("primary")


@pytest.mark.parametrize(
    ("enable", "current_chains", "message"),
    [
        (True, ["primary"], "already enabled"),
        (False, [], "already disabled"),
    ],
)
def test_toggle_chain_rejects_state_that_is_already_set(
    monkeypatch,
    enable,
    current_chains,
    message,
):
    commands = _command_api(monkeypatch)
    commands.gpmaster_show.return_value = {
        "result": {"chainlist": current_chains}
    }

    with pytest.raises(errors.ValidationError, match=message):
        CHAIN.chain_toggle_base._toggle_chain(
            SimpleNamespace(),
            "primary",
            enable=enable,
        )

    commands.gpmaster_mod.assert_not_called()
    commands.chain_show.assert_not_called()


@pytest.mark.parametrize("enable", [True, False])
def test_toggle_chain_propagates_gpmaster_update_failure(monkeypatch, enable):
    commands = _command_api(monkeypatch)
    commands.gpmaster_show.return_value = {
        "result": {"chainlist": [] if enable else ["primary"]}
    }
    commands.gpmaster_mod.side_effect = RuntimeError("update failed")

    with pytest.raises(RuntimeError, match="update failed"):
        CHAIN.chain_toggle_base._toggle_chain(
            SimpleNamespace(),
            "primary",
            enable=enable,
        )

    commands.chain_show.assert_not_called()


def test_toggle_chain_propagates_gpmaster_read_failure(monkeypatch):
    commands = _command_api(monkeypatch)
    commands.gpmaster_show.side_effect = RuntimeError("read failed")

    with pytest.raises(RuntimeError, match="read failed"):
        CHAIN.chain_toggle_base._toggle_chain(
            SimpleNamespace(),
            "primary",
        )

    commands.gpmaster_mod.assert_not_called()
    commands.chain_show.assert_not_called()


def test_toggle_chain_propagates_refresh_failure_after_update(monkeypatch):
    commands = _command_api(monkeypatch)
    commands.gpmaster_show.return_value = {"result": {"chainlist": []}}
    commands.chain_show.side_effect = RuntimeError("refresh failed")

    with pytest.raises(RuntimeError, match="refresh failed"):
        CHAIN.chain_toggle_base._toggle_chain(
            SimpleNamespace(),
            "primary",
            enable=True,
        )

    commands.gpmaster_mod.assert_called_once_with(add_chain=["primary"])


@pytest.mark.parametrize(
    ("command_class", "enable"),
    [(CHAIN.chain_enable, True), (CHAIN.chain_disable, False)],
)
def test_toggle_commands_delegate_with_expected_direction(
    command_class,
    enable,
):
    subject = SimpleNamespace(_toggle_chain=MagicMock(return_value={"result": {}}))

    result = command_class.execute(subject, "primary", ignored=True)

    assert result == {"result": {}}
    subject._toggle_chain.assert_called_once_with("primary", enable=enable)
