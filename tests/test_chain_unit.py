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
SECOND_GPO_DN = DN(
    ("cn", "second-policy-guid"),
    ("cn", "Policies"),
    ("cn", "System"),
    BASEDN,
)


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


def test_verify_gpo_schema_reads_policy_container():
    ldap = MagicMock()
    plugin_api = SimpleNamespace(env=SimpleNamespace(basedn=BASEDN))

    CHAIN.verify_gpo_schema(ldap, plugin_api)

    ldap.get_entry.assert_called_once_with(
        DN(("cn", "Policies"), ("cn", "System"), BASEDN),
        attrs_list=["cn"],
    )


def test_verify_gpo_schema_reports_missing_container():
    ldap = MagicMock()
    ldap.get_entry.side_effect = errors.NotFound(reason="missing")
    plugin_api = SimpleNamespace(env=SimpleNamespace(basedn=BASEDN))

    with pytest.raises(errors.NotFound, match="schema is not installed"):
        CHAIN.verify_gpo_schema(ldap, plugin_api)


def test_verify_gpo_schema_translates_schema_backend_error():
    ldap = MagicMock()
    ldap.get_entry.side_effect = errors.DatabaseError(
        desc="LDAP schema",
        info="undefined object class",
    )
    plugin_api = SimpleNamespace(env=SimpleNamespace(basedn=BASEDN))

    with pytest.raises(errors.NotFound, match="groupPolicyContainer"):
        CHAIN.verify_gpo_schema(ldap, plugin_api)


def test_verify_gpo_schema_logs_unexpected_internal_error(monkeypatch):
    ldap = MagicMock()
    ldap.get_entry.side_effect = RuntimeError("LDAP unavailable")
    plugin_api = SimpleNamespace(env=SimpleNamespace(basedn=BASEDN))
    debug = MagicMock()
    monkeypatch.setattr(CHAIN.logger, "debug", debug)

    CHAIN.verify_gpo_schema(ldap, plugin_api)

    debug.assert_called_once_with(
        "GPO schema check error: %s",
        "LDAP unavailable",
    )


def _chain_add_subject():
    return SimpleNamespace(
        api=SimpleNamespace(env=SimpleNamespace(basedn=BASEDN)),
        obj=SimpleNamespace(convert_names_to_dns=MagicMock()),
    )


def test_chain_add_pre_callback_validates_and_converts_references(monkeypatch):
    schema_check = MagicMock()
    monkeypatch.setattr(CHAIN, "verify_gpo_schema", schema_check)
    subject = _chain_add_subject()
    subject.obj.convert_names_to_dns.return_value = {
        "usergroup": str(USER_GROUP_DN),
        "gplink": [str(GPO_DN)],
    }
    ldap = MagicMock()
    entry_attrs = {"description": "Primary chain"}
    options = {
        "usergroup": "users",
        "gplink": ("Workstation policy",),
    }

    result = CHAIN.chain_add.pre_callback(
        subject,
        ldap,
        FIRST_DN,
        entry_attrs,
        [],
        "primary",
        **options,
    )

    assert result == FIRST_DN
    assert entry_attrs == {
        "description": "Primary chain",
        "usergroup": str(USER_GROUP_DN),
        "gplink": [str(GPO_DN)],
    }
    schema_check.assert_called_once_with(ldap, subject.api)
    subject.obj.convert_names_to_dns.assert_called_once_with(
        options,
        strict=True,
    )


def test_chain_add_pre_callback_rejects_invalid_name(monkeypatch):
    schema_check = MagicMock()
    monkeypatch.setattr(CHAIN, "verify_gpo_schema", schema_check)
    subject = _chain_add_subject()
    ldap = MagicMock()

    with pytest.raises(errors.ValidationError) as failure:
        CHAIN.chain_add.pre_callback(
            subject,
            ldap,
            FIRST_DN,
            {},
            [],
            "invalid/name",
        )

    assert failure.value.name == "cn"
    schema_check.assert_called_once_with(ldap, subject.api)
    subject.obj.convert_names_to_dns.assert_not_called()


def test_chain_add_pre_callback_propagates_reference_validation_error(
    monkeypatch,
):
    monkeypatch.setattr(CHAIN, "verify_gpo_schema", MagicMock())
    subject = _chain_add_subject()
    subject.obj.convert_names_to_dns.side_effect = errors.NotFound(
        reason="missing group"
    )

    with pytest.raises(errors.NotFound, match="missing group"):
        CHAIN.chain_add.pre_callback(
            subject,
            MagicMock(),
            FIRST_DN,
            {},
            [],
            "primary",
            usergroup="missing",
        )


def test_chain_add_post_callback_activates_new_chain(monkeypatch):
    commands = _command_api(monkeypatch)
    commands.gpmaster_show.return_value = {
        "result": {"chainlist": ["fallback"]}
    }

    result = CHAIN.chain_add.post_callback(
        SimpleNamespace(),
        MagicMock(),
        FIRST_DN,
        {},
        "primary",
    )

    assert result == FIRST_DN
    commands.gpmaster_mod.assert_called_once_with(add_chain=["primary"])


def test_chain_add_post_callback_does_not_duplicate_active_chain(monkeypatch):
    commands = _command_api(monkeypatch)
    commands.gpmaster_show.return_value = {
        "result": {"chainlist": ["primary"]}
    }

    CHAIN.chain_add.post_callback(
        SimpleNamespace(),
        MagicMock(),
        FIRST_DN,
        {},
        "primary",
    )

    commands.gpmaster_mod.assert_not_called()


@pytest.mark.parametrize("failing_command", ["gpmaster_show", "gpmaster_mod"])
def test_chain_add_post_callback_keeps_created_chain_on_activation_failure(
    monkeypatch,
    failing_command,
):
    commands = _command_api(monkeypatch)
    warning = MagicMock()
    monkeypatch.setattr(CHAIN.logger, "warning", warning)
    commands.gpmaster_show.return_value = {"result": {"chainlist": []}}
    getattr(commands, failing_command).side_effect = RuntimeError(
        "activation failed"
    )

    result = CHAIN.chain_add.post_callback(
        SimpleNamespace(),
        MagicMock(),
        FIRST_DN,
        {},
        "primary",
    )

    assert result == FIRST_DN
    warning.assert_called_once_with(
        "Failed to activate newly created chain '%s': %s",
        "primary",
        "activation failed",
    )


class GpoMoveLdap:
    def __init__(self, gplinks):
        self.chain = {"gplink": list(gplinks)}
        self.updated_gplinks = []
        self.gpo_entries = {
            str(GPO_DN): Entry(
                GPO_DN,
                displayName=["First policy"],
                cn=["policy-guid"],
            ),
            str(SECOND_GPO_DN): Entry(
                SECOND_GPO_DN,
                displayName=["Second policy"],
                cn=["second-policy-guid"],
            ),
        }

    def get_entry(self, dn, attrs_list=None):
        if dn == FIRST_DN:
            return self.chain
        return self.gpo_entries[str(dn)]

    def update_entry(self, entry):
        self.updated_gplinks.append(list(entry.get("gplink", [])))


@pytest.mark.parametrize(
    ("options", "expected"),
    [
        (
            {"moveup_gpc": "Second policy"},
            [str(SECOND_GPO_DN), str(GPO_DN)],
        ),
        (
            {"movedown_gpc": "First policy"},
            [str(SECOND_GPO_DN), str(GPO_DN)],
        ),
    ],
)
def test_move_gpo_reorders_links(options, expected):
    ldap = GpoMoveLdap([GPO_DN, SECOND_GPO_DN])

    CHAIN.chain_mod._do_move_operation(
        SimpleNamespace(),
        ldap,
        FIRST_DN,
        ("primary",),
        options,
    )

    assert ldap.updated_gplinks == [[], expected]
    assert ldap.chain["gplink"] == expected


def test_empty_moveup_gpo_does_not_override_movedown_direction():
    ldap = GpoMoveLdap([GPO_DN, SECOND_GPO_DN])

    CHAIN.chain_mod._do_move_operation(
        SimpleNamespace(),
        ldap,
        FIRST_DN,
        ("primary",),
        {"moveup_gpc": (), "movedown_gpc": "First policy"},
    )

    assert ldap.chain["gplink"] == [str(SECOND_GPO_DN), str(GPO_DN)]


def test_move_gpo_rejects_conflicting_directions_without_writes():
    ldap = GpoMoveLdap([GPO_DN, SECOND_GPO_DN])

    with pytest.raises(errors.ValidationError) as failure:
        CHAIN.chain_mod._do_move_operation(
            SimpleNamespace(),
            ldap,
            FIRST_DN,
            ("primary",),
            {
                "moveup_gpc": "Second policy",
                "movedown_gpc": "First policy",
            },
        )

    assert failure.value.name == "move_gpc"
    assert ldap.updated_gplinks == []


def test_move_gpo_rejects_unlinked_policy_without_writes():
    ldap = GpoMoveLdap([GPO_DN, SECOND_GPO_DN])

    with pytest.raises(errors.ValidationError) as failure:
        CHAIN.chain_mod._do_move_operation(
            SimpleNamespace(),
            ldap,
            FIRST_DN,
            ("primary",),
            {"moveup_gpc": "Missing policy"},
        )

    assert failure.value.name == "moveup_gpc"
    assert ldap.updated_gplinks == []


def test_move_gpo_propagates_link_lookup_failure_without_writes():
    ldap = GpoMoveLdap([GPO_DN, SECOND_GPO_DN])
    original_get_entry = ldap.get_entry

    def get_entry(dn, attrs_list=None):
        if dn == FIRST_DN:
            return original_get_entry(dn, attrs_list)
        raise RuntimeError("LDAP unavailable")

    ldap.get_entry = get_entry

    with pytest.raises(RuntimeError, match="LDAP unavailable"):
        CHAIN.chain_mod._do_move_operation(
            SimpleNamespace(),
            ldap,
            FIRST_DN,
            ("primary",),
            {"moveup_gpc": "Second policy"},
        )

    assert ldap.updated_gplinks == []


@pytest.mark.parametrize(
    ("options", "gplinks"),
    [
        ({"moveup_gpc": "First policy"}, [GPO_DN, SECOND_GPO_DN]),
        ({"movedown_gpc": "Second policy"}, [GPO_DN, SECOND_GPO_DN]),
        ({"moveup_gpc": "First policy"}, [GPO_DN]),
    ],
)
def test_move_gpo_boundary_and_short_list_do_not_write(options, gplinks):
    ldap = GpoMoveLdap(gplinks)

    CHAIN.chain_mod._do_move_operation(
        SimpleNamespace(),
        ldap,
        FIRST_DN,
        ("primary",),
        options,
    )

    assert ldap.updated_gplinks == []


def test_move_gpo_uses_cn_when_display_name_is_empty():
    ldap = GpoMoveLdap([GPO_DN, SECOND_GPO_DN])
    ldap.gpo_entries[str(SECOND_GPO_DN)]["displayName"] = []

    CHAIN.chain_mod._do_move_operation(
        SimpleNamespace(),
        ldap,
        FIRST_DN,
        ("primary",),
        {"moveup_gpc": "second-policy-guid"},
    )

    assert ldap.chain["gplink"] == [str(SECOND_GPO_DN), str(GPO_DN)]


@pytest.mark.parametrize(
    ("options", "error_name"),
    [
        (
            {"add_usergroup": "users", "remove_usergroup": True},
            "usergroup",
        ),
        (
            {"add_computergroup": "workstations", "remove_computergroup": True},
            "computergroup",
        ),
        (
            {"usergroup": "users", "add_usergroup": "admins"},
            "usergroup",
        ),
        (
            {"computergroup": "workstations", "remove_computergroup": True},
            "computergroup",
        ),
        (
            {"moveup_gpc": "Second policy", "description": "Changed"},
            "move_gpc",
        ),
        (
            {"movedown_gpc": "First policy", "rename": "renamed"},
            "move_gpc",
        ),
    ],
)
def test_chain_mod_rejects_conflicting_options(options, error_name):
    with pytest.raises(errors.ValidationError) as failure:
        CHAIN.chain_mod._validate_modification_options(
            SimpleNamespace(),
            options,
        )

    assert failure.value.name == error_name


@pytest.mark.parametrize(
    "options",
    [
        {"add_usergroup": "users"},
        {"remove_computergroup": True},
        {"description": "Changed"},
        {"moveup_gpc": "Second policy", "raw": True},
    ],
)
def test_chain_mod_accepts_non_conflicting_options(options):
    CHAIN.chain_mod._validate_modification_options(
        SimpleNamespace(),
        options,
    )


def test_chain_mod_move_execute_checks_schema_and_returns_updated_entry(
    monkeypatch,
):
    schema_check = MagicMock()
    monkeypatch.setattr(CHAIN, "verify_gpo_schema", schema_check)
    ldap = MagicMock()
    ldap.get_entry.return_value = {
        "cn": ["primary"],
        "description": ["Primary chain"],
        "gplink": [str(GPO_DN), str(SECOND_GPO_DN)],
    }
    obj = SimpleNamespace(
        get_dn=MagicMock(return_value=FIRST_DN),
        default_attributes=["cn", "description", "gplink"],
        convert_attribute_members=MagicMock(),
    )
    subject = SimpleNamespace(
        api=SimpleNamespace(Backend=SimpleNamespace(ldap2=ldap)),
        obj=obj,
        msg_summary='Modified Group Policy Chain "%(value)s"',
        _validate_modification_options=MagicMock(),
        _do_move_operation=MagicMock(),
    )
    options = {"moveup_gpc": "Second policy"}

    result = CHAIN.chain_mod.execute(subject, "primary", **options)

    assert result == {
        "result": {
            "cn": "primary",
            "description": "Primary chain",
            "gplink": [str(GPO_DN), str(SECOND_GPO_DN)],
        },
        "value": "primary",
        "summary": 'Modified Group Policy Chain "primary"',
    }
    subject._validate_modification_options.assert_called_once_with(options)
    schema_check.assert_called_once_with(ldap, subject.api)
    subject._do_move_operation.assert_called_once_with(
        ldap,
        FIRST_DN,
        ("primary",),
        options,
    )
    obj.convert_attribute_members.assert_called_once_with(
        ldap.get_entry.return_value,
        "primary",
        **options,
    )


def test_chain_mod_move_execute_rejects_mixed_update_before_ldap_access():
    ldap = MagicMock()
    subject = SimpleNamespace(
        api=SimpleNamespace(Backend=SimpleNamespace(ldap2=ldap)),
        _validate_modification_options=lambda options: (
            CHAIN.chain_mod._validate_modification_options(
                SimpleNamespace(),
                options,
            )
        ),
    )

    with pytest.raises(errors.ValidationError) as failure:
        CHAIN.chain_mod.execute(
            subject,
            "primary",
            moveup_gpc="Second policy",
            description="Changed",
        )

    assert failure.value.name == "move_gpc"
    ldap.get_entry.assert_not_called()


@pytest.mark.parametrize(
    ("option", "current_entry", "error_name"),
    [
        ("remove_usergroup", {}, "remove_usergroup"),
        ("remove_computergroup", {}, "remove_computergroup"),
    ],
)
def test_chain_mod_remove_missing_group_uses_api_parameter_name(
    option,
    current_entry,
    error_name,
):
    with pytest.raises(errors.ValidationError) as failure:
        CHAIN.chain_mod._handle_remove_operations(
            SimpleNamespace(),
            MagicMock(),
            current_entry,
            {},
            {option: True},
        )

    assert failure.value.name == error_name


def test_chain_mod_remove_existing_groups_clears_attributes():
    entry_attrs = {}

    CHAIN.chain_mod._handle_remove_operations(
        SimpleNamespace(),
        MagicMock(),
        {"usergroup": [str(USER_GROUP_DN)], "computergroup": [str(COMPUTER_GROUP_DN)]},
        entry_attrs,
        {"remove_usergroup": True, "remove_computergroup": True},
    )

    assert entry_attrs == {"usergroup": None, "computergroup": None}


def test_chain_mod_non_move_execute_delegates_to_ldap_update(monkeypatch):
    calls = []
    expected = {"result": {"cn": ["primary"]}}

    def base_execute(subject, *keys, **options):
        calls.append((subject, keys, options))
        return expected

    monkeypatch.setattr(CHAIN.LDAPUpdate, "execute", base_execute)
    subject = object.__new__(CHAIN.chain_mod)
    options = {"description": "Changed"}

    result = CHAIN.chain_mod.execute(subject, "primary", **options)

    assert result is expected
    assert calls == [(subject, ("primary",), options)]


def test_chain_mod_pre_callback_runs_schema_and_handlers(monkeypatch):
    schema_check = MagicMock()
    monkeypatch.setattr(CHAIN, "verify_gpo_schema", schema_check)
    ldap = MagicMock()
    current_entry = {
        "usergroup": [str(USER_GROUP_DN)],
        "computergroup": [str(COMPUTER_GROUP_DN)],
        "gplink": [str(GPO_DN)],
    }
    ldap.get_entry.return_value = current_entry
    subject = SimpleNamespace(
        api=SimpleNamespace(env=SimpleNamespace(basedn=BASEDN)),
        _handle_add_operations=MagicMock(),
        _handle_remove_operations=MagicMock(),
        _handle_standard_modifications=MagicMock(),
    )
    entry_attrs = {}
    options = {"rename": "renamed", "description": "Changed"}

    result = CHAIN.chain_mod.pre_callback(
        subject,
        ldap,
        FIRST_DN,
        entry_attrs,
        [],
        "primary",
        **options,
    )

    assert result == FIRST_DN
    schema_check.assert_called_once_with(ldap, subject.api)
    ldap.get_entry.assert_called_once_with(
        FIRST_DN,
        attrs_list=["usergroup", "computergroup", "gplink"],
    )
    subject._handle_add_operations.assert_called_once_with(
        entry_attrs,
        options,
        ("primary",),
    )
    subject._handle_remove_operations.assert_called_once_with(
        ldap,
        current_entry,
        entry_attrs,
        options,
    )
    subject._handle_standard_modifications.assert_called_once_with(
        entry_attrs,
        options,
    )


def test_chain_mod_pre_callback_rejects_invalid_rename_before_read(
    monkeypatch,
):
    schema_check = MagicMock()
    monkeypatch.setattr(CHAIN, "verify_gpo_schema", schema_check)
    ldap = MagicMock()
    subject = SimpleNamespace(
        api=SimpleNamespace(env=SimpleNamespace(basedn=BASEDN)),
    )

    with pytest.raises(errors.ValidationError) as failure:
        CHAIN.chain_mod.pre_callback(
            subject,
            ldap,
            FIRST_DN,
            {},
            [],
            "primary",
            rename="invalid/name",
        )

    assert failure.value.name == "cn"
    schema_check.assert_called_once_with(ldap, subject.api)
    ldap.get_entry.assert_not_called()


def test_chain_mod_add_group_operations_use_strict_resolution():
    obj = SimpleNamespace(convert_names_to_dns=MagicMock())
    obj.convert_names_to_dns.side_effect = [
        {"usergroup": str(USER_GROUP_DN)},
        {"computergroup": str(COMPUTER_GROUP_DN)},
    ]
    subject = SimpleNamespace(obj=obj)
    entry_attrs = {}

    CHAIN.chain_mod._handle_add_operations(
        subject,
        entry_attrs,
        {
            "add_usergroup": "users",
            "add_computergroup": "workstations",
        },
        ("primary",),
    )

    assert entry_attrs == {
        "usergroup": str(USER_GROUP_DN),
        "computergroup": str(COMPUTER_GROUP_DN),
    }
    assert obj.convert_names_to_dns.call_args_list == [
        call({"usergroup": "users"}, strict=True),
        call({"computergroup": "workstations"}, strict=True),
    ]


def test_chain_mod_standard_modifications_convert_only_supported_values():
    obj = SimpleNamespace(convert_names_to_dns=MagicMock())
    obj.convert_names_to_dns.return_value = {
        "usergroup": str(USER_GROUP_DN),
        "gplink": [str(GPO_DN)],
    }
    subject = SimpleNamespace(obj=obj)
    entry_attrs = {"description": "Changed"}

    CHAIN.chain_mod._handle_standard_modifications(
        subject,
        entry_attrs,
        {
            "usergroup": "users",
            "computergroup": "",
            "gplink": ["Workstation policy"],
            "description": "Changed",
            "raw": True,
        },
    )

    assert entry_attrs == {
        "description": "Changed",
        "usergroup": str(USER_GROUP_DN),
        "gplink": [str(GPO_DN)],
    }
    obj.convert_names_to_dns.assert_called_once_with(
        {"usergroup": "users", "gplink": ["Workstation policy"]},
        strict=True,
    )


def test_chain_mod_standard_modifications_skip_empty_values():
    obj = SimpleNamespace(convert_names_to_dns=MagicMock())
    subject = SimpleNamespace(obj=obj)
    entry_attrs = {}

    CHAIN.chain_mod._handle_standard_modifications(
        subject,
        entry_attrs,
        {"usergroup": None, "computergroup": "", "gplink": ()},
    )

    assert entry_attrs == {}
    obj.convert_names_to_dns.assert_not_called()


class ChainFindHarness(CHAIN.chain_find):
    @property
    def obj(self):
        return self._test_obj


def _chain_find_harness(obj=None):
    subject = object.__new__(ChainFindHarness)
    object.__setattr__(subject, "_test_obj", obj or SimpleNamespace())
    return subject


def test_chain_find_converts_filters_and_removes_computed_active(
    monkeypatch,
):
    converted_options = []

    def convert_names_to_dns(options, strict):
        converted_options.append((dict(options), strict))
        return {"usergroup": str(USER_GROUP_DN)}

    obj = SimpleNamespace(convert_names_to_dns=MagicMock(
        side_effect=convert_names_to_dns
    ))
    subject = _chain_find_harness(obj)
    base_calls = []

    def base_args_options(instance, *args, **options):
        base_calls.append((instance, args, options))
        return options

    monkeypatch.setattr(
        CHAIN.LDAPSearch,
        "args_options_2_entry",
        base_args_options,
    )

    result = CHAIN.chain_find.args_options_2_entry(
        subject,
        "criteria",
        usergroup="users",
        active=True,
        sizelimit=10,
    )

    assert result == {
        "usergroup": str(USER_GROUP_DN),
        "sizelimit": 10,
    }
    assert converted_options == [
        ({"usergroup": "users", "sizelimit": 10}, False)
    ]
    assert base_calls == [
        (
            subject,
            ("criteria",),
            {"usergroup": str(USER_GROUP_DN), "sizelimit": 10},
        )
    ]


def _chain_find_post_subject():
    obj = SimpleNamespace(
        _convert_groups=MagicMock(),
        _convert_gpos=MagicMock(),
    )
    subject = SimpleNamespace(obj=obj)
    subject._order_by_gpmaster = lambda entries, order: (
        CHAIN.chain_find._order_by_gpmaster(subject, entries, order)
    )
    return subject, obj


def test_chain_find_post_callback_converts_marks_and_orders(monkeypatch):
    commands = _command_api(monkeypatch)
    commands.gpmaster_show.return_value = {
        "result": {"chainlist": ["second", "first"]}
    }
    entries = [
        {"cn": ["third"]},
        {"cn": ["first"]},
        {"cn": ["second"]},
        {"cn": ["alpha"]},
    ]
    subject, obj = _chain_find_post_subject()
    ldap = MagicMock()

    result = CHAIN.chain_find.post_callback(
        subject,
        ldap,
        entries,
        True,
    )

    assert result is True
    assert [entry["cn"][0] for entry in entries] == [
        "second",
        "first",
        "alpha",
        "third",
    ]
    assert [entry["active"] for entry in entries] == [
        [True],
        [True],
        [False],
        [False],
    ]
    assert all("_chain_find_processed" not in entry for entry in entries)
    obj._convert_groups.assert_not_called()
    obj._convert_gpos.assert_not_called()


def test_chain_find_post_callback_raw_mode_preserves_entries(monkeypatch):
    commands = _command_api(monkeypatch)
    entries = [
        {"cn": ["second"], "gplink": [str(SECOND_GPO_DN)]},
        {"cn": ["first"], "gplink": [str(GPO_DN)]},
    ]
    expected = [dict(entry) for entry in entries]
    subject, obj = _chain_find_post_subject()

    result = CHAIN.chain_find.post_callback(
        subject,
        MagicMock(),
        entries,
        False,
        raw=True,
    )

    assert result is False
    assert entries == expected
    obj._convert_groups.assert_not_called()
    obj._convert_gpos.assert_not_called()
    commands.gpmaster_show.assert_not_called()


def test_chain_find_post_callback_uses_inactive_fallback_on_gpmaster_error(
    monkeypatch,
):
    commands = _command_api(monkeypatch)
    commands.gpmaster_show.side_effect = RuntimeError("LDAP unavailable")
    entries = [{"cn": ["second"]}, {"cn": ["first"]}]
    subject, _obj = _chain_find_post_subject()

    CHAIN.chain_find.post_callback(
        subject,
        MagicMock(),
        entries,
        False,
    )

    assert [entry["cn"][0] for entry in entries] == ["first", "second"]
    assert [entry["active"] for entry in entries] == [[False], [False]]


def test_chain_find_post_callback_handles_empty_result(monkeypatch):
    commands = _command_api(monkeypatch)
    entries = []
    subject, obj = _chain_find_post_subject()

    result = CHAIN.chain_find.post_callback(
        subject,
        MagicMock(),
        entries,
        False,
    )

    assert result is False
    assert entries == []
    obj._convert_groups.assert_not_called()
    commands.gpmaster_show.assert_not_called()


@pytest.mark.parametrize(
    ("requested_active", "expected_names"),
    [(True, ["second"]), (False, ["first", "third"])],
)
def test_chain_find_post_callback_filters_computed_active_state(
    monkeypatch,
    requested_active,
    expected_names,
):
    commands = _command_api(monkeypatch)
    commands.gpmaster_show.return_value = {
        "result": {"chainlist": ["second"]}
    }
    entries = [
        {"cn": ["third"]},
        {"cn": ["second"]},
        {"cn": ["first"]},
    ]
    subject, _obj = _chain_find_post_subject()

    CHAIN.chain_find.post_callback(
        subject,
        MagicMock(),
        entries,
        False,
        active=requested_active,
    )

    assert [entry["cn"][0] for entry in entries] == expected_names
    assert all(entry["active"] == [requested_active] for entry in entries)


def test_chain_find_active_filter_propagates_gpmaster_failure(monkeypatch):
    commands = _command_api(monkeypatch)
    commands.gpmaster_show.side_effect = RuntimeError("LDAP unavailable")
    entries = [{"cn": ["first"]}]
    subject, _obj = _chain_find_post_subject()

    with pytest.raises(RuntimeError, match="LDAP unavailable"):
        CHAIN.chain_find.post_callback(
            subject,
            MagicMock(),
            entries,
            False,
            active=True,
        )


def test_chain_find_raw_active_filter_preserves_raw_values(monkeypatch):
    commands = _command_api(monkeypatch)
    commands.gpmaster_show.return_value = {
        "result": {"chainlist": ["second"]}
    }
    entries = [
        {"cn": ["first"], "gplink": [str(GPO_DN)]},
        {"cn": ["second"], "gplink": [str(SECOND_GPO_DN)]},
    ]
    subject, obj = _chain_find_post_subject()

    CHAIN.chain_find.post_callback(
        subject,
        MagicMock(),
        entries,
        False,
        raw=True,
        active=True,
    )

    assert entries == [
        {"cn": ["second"], "gplink": [str(SECOND_GPO_DN)]}
    ]
    obj._convert_groups.assert_not_called()
    obj._convert_gpos.assert_not_called()


def test_chain_find_order_places_active_first_and_sorts_inactive():
    entries = [
        {"cn": ["zulu"]},
        {"cn": ["first"]},
        {"cn": ["alpha"]},
        {"cn": ["second"]},
    ]

    result = CHAIN.chain_find._order_by_gpmaster(
        SimpleNamespace(),
        entries,
        ["second", "first"],
    )

    assert [entry["cn"][0] for entry in result] == [
        "second",
        "first",
        "alpha",
        "zulu",
    ]


def test_chain_find_execute_preserves_callback_order_without_shared_state(
    monkeypatch,
):
    base_entries = [
        {"cn": ["second"], "description": ["Second"]},
        {"cn": ["first"], "description": ["First"]},
    ]
    base_result = {
        "result": base_entries,
        "count": 2,
        "truncated": False,
    }

    def base_execute(instance, *args, **options):
        return base_result

    monkeypatch.setattr(CHAIN.LDAPSearch, "execute", base_execute)
    subject = _chain_find_harness()

    result = CHAIN.chain_find.execute(subject, criteria="all")

    assert CHAIN.chain_find.sort_result_entries is False
    assert result["result"] == base_entries
    assert result["count"] == 2


def test_chain_find_execute_returns_empty_result_for_not_found(monkeypatch):
    def base_execute(instance, *args, **options):
        raise errors.NotFound(reason="missing")

    monkeypatch.setattr(CHAIN.LDAPSearch, "execute", base_execute)
    subject = _chain_find_harness()

    result = CHAIN.chain_find.execute(subject)

    assert result == {
        "result": [],
        "count": 0,
        "truncated": False,
        "summary": subject.msg_summary % {"count": 0},
    }


def test_chain_find_execute_propagates_unexpected_backend_error(monkeypatch):
    def base_execute(instance, *args, **options):
        raise RuntimeError("LDAP unavailable")

    monkeypatch.setattr(CHAIN.LDAPSearch, "execute", base_execute)
    subject = _chain_find_harness()

    with pytest.raises(RuntimeError, match="LDAP unavailable"):
        CHAIN.chain_find.execute(subject)
