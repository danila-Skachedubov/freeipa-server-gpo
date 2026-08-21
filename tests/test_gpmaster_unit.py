"""Focused unit tests for the Group Policy Master FreeIPA plugin."""

import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, call

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
CHAIN_DN = DN(
    ("cn", "primary"), ("cn", "Chains"), ("cn", "System"), BASEDN
)
SECOND_CHAIN_DN = DN(
    ("cn", "fallback"), ("cn", "Chains"), ("cn", "System"), BASEDN
)
MASTER_DN = DN(("cn", "grouppolicymaster"), ("cn", "etc"), BASEDN)


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
def test_non_strict_resolution_preserves_existing_dn(chain_dn):
    subject, chain, ldap = _resolver()

    result = GPMASTER.gpmaster.resolve_chain_name(subject, chain_dn)

    assert result == chain_dn
    chain.get_dn.assert_not_called()
    ldap.get_entry.assert_not_called()


def test_strict_explicit_dn_verifies_ldap_entry():
    subject, chain, ldap = _resolver()

    result = GPMASTER.gpmaster.resolve_chain_name(
        subject, str(CHAIN_DN), strict=True
    )

    assert result == str(CHAIN_DN)
    chain.get_dn.assert_not_called()
    ldap.get_entry.assert_called_once_with(CHAIN_DN, attrs_list=["cn"])


def test_strict_explicit_dn_reports_missing_chain():
    subject, _chain, ldap = _resolver()
    ldap.get_entry.side_effect = errors.NotFound(reason="missing")

    with pytest.raises(errors.NotFound):
        GPMASTER.gpmaster.resolve_chain_name(
            subject, str(CHAIN_DN), strict=True
        )


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
    missing_dn = str(DN(
        ("cn", "missing"), ("cn", "Chains"), ("cn", "System"), BASEDN
    ))
    broken_dn = str(DN(
        ("cn", "broken"), ("cn", "Chains"), ("cn", "System"), BASEDN
    ))
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


def _modifier(current_chains=()):
    ldap = MagicMock()
    ldap.get_entry.return_value = {"chainlist": list(current_chains)}
    obj = MagicMock()
    obj.get_gpmaster_dn.return_value = DN(
        ("cn", "grouppolicymaster"), ("cn", "etc"), BASEDN
    )
    subject = SimpleNamespace(
        api=SimpleNamespace(Backend=SimpleNamespace(ldap2=ldap)),
        obj=obj,
    )
    return subject, obj, ldap


def test_add_chain_appends_new_dn_without_duplicate():
    subject, obj, _ldap = _modifier([CHAIN_DN])
    second_dn = SECOND_CHAIN_DN
    obj.resolve_chain_name.side_effect = [str(CHAIN_DN), str(second_dn)]
    entry_attrs = {}

    GPMASTER.gpmaster_mod._handle_add_operations(
        subject,
        entry_attrs,
        {"add_chain": ("primary", "fallback")},
    )

    assert entry_attrs["chainlist"] == [str(CHAIN_DN), str(second_dn)]
    assert obj.resolve_chain_name.call_args_list == [
        call("primary", strict=True),
        call("fallback", strict=True),
    ]


def test_add_chain_reports_missing_chain():
    subject, obj, _ldap = _modifier()
    obj.resolve_chain_name.side_effect = errors.NotFound(reason="missing")

    with pytest.raises(errors.NotFound):
        GPMASTER.gpmaster_mod._handle_add_operations(
            subject, {}, {"add_chain": "missing"}
        )


def test_remove_chain_rejects_empty_master():
    subject, _obj, ldap = _modifier()

    with pytest.raises(errors.ValidationError) as failure:
        GPMASTER.gpmaster_mod._handle_remove_operations(
            subject,
            ldap,
            {"chainlist": []},
            {},
            {"remove_chain": "primary"},
        )

    assert failure.value.name == "remove_chain"


def test_remove_chain_by_resolved_dn():
    subject, obj, ldap = _modifier()
    obj.resolve_chain_name.return_value = str(CHAIN_DN)
    entry_attrs = {}

    GPMASTER.gpmaster_mod._handle_remove_operations(
        subject,
        ldap,
        {"chainlist": [CHAIN_DN]},
        entry_attrs,
        {"remove_chain": "primary"},
    )

    assert entry_attrs["chainlist"] == []
    ldap.get_entry.assert_not_called()


def test_remove_chain_by_readable_name_when_dn_resolution_is_unavailable():
    subject, obj, ldap = _modifier()
    obj.resolve_chain_name.return_value = "primary"
    ldap.get_entry.return_value = {"cn": ["primary"]}
    entry_attrs = {}

    GPMASTER.gpmaster_mod._handle_remove_operations(
        subject,
        ldap,
        {"chainlist": [CHAIN_DN]},
        entry_attrs,
        {"remove_chain": "primary"},
    )

    assert entry_attrs["chainlist"] == []
    ldap.get_entry.assert_called_once_with(CHAIN_DN, attrs_list=["cn"])


def test_remove_chain_reports_name_not_assigned_to_master():
    subject, obj, ldap = _modifier()
    obj.resolve_chain_name.return_value = "missing"
    ldap.get_entry.side_effect = errors.NotFound(reason="missing")

    with pytest.raises(errors.NotFound):
        GPMASTER.gpmaster_mod._handle_remove_operations(
            subject,
            ldap,
            {"chainlist": [CHAIN_DN]},
            {},
            {"remove_chain": "missing"},
        )


def test_standard_modifications_set_pdc_and_resolve_chainlist():
    subject, obj, _ldap = _modifier()
    obj.convert_chain_names_to_dns.return_value = [str(CHAIN_DN)]
    entry_attrs = {}

    GPMASTER.gpmaster_mod._handle_standard_modifications(
        subject,
        entry_attrs,
        {
            "pdcemulator": "dc1.example.test",
            "chainlist": ["primary"],
        },
    )

    assert entry_attrs == {
        "pdcemulator": "dc1.example.test",
        "chainlist": [str(CHAIN_DN)],
    }
    obj.convert_chain_names_to_dns.assert_called_once_with(
        ["primary"], strict=True
    )


class MoveLdap:
    def __init__(self, chains):
        self.master = {"chainlist": list(chains)}
        self.updated_chainlists = []
        self.chain_names = {
            str(CHAIN_DN): "primary",
            str(SECOND_CHAIN_DN): "fallback",
        }

    def get_entry(self, dn, attrs_list=None):
        if dn == MASTER_DN:
            return self.master
        return {"cn": [self.chain_names[str(dn)]]}

    def update_entry(self, entry):
        self.updated_chainlists.append(list(entry.get("chainlist", [])))


def _move_subject(ldap):
    return SimpleNamespace(
        _validate_move_operations=MagicMock(),
        obj=SimpleNamespace(),
    )


@pytest.mark.parametrize(
    ("options", "expected"),
    [
        (
            {"moveup_chain": "fallback"},
            [str(SECOND_CHAIN_DN), str(CHAIN_DN)],
        ),
        (
            {"movedown_chain": "primary"},
            [str(SECOND_CHAIN_DN), str(CHAIN_DN)],
        ),
    ],
)
def test_move_operation_reorders_with_two_ldap_updates(options, expected):
    ldap = MoveLdap([CHAIN_DN, SECOND_CHAIN_DN])
    subject = _move_subject(ldap)

    GPMASTER.gpmaster_mod._do_move_operation(
        subject, ldap, MASTER_DN, (), options
    )

    subject._validate_move_operations.assert_called_once_with(
        ldap, MASTER_DN, options
    )
    assert ldap.updated_chainlists == [[], expected]
    assert ldap.master["chainlist"] == expected


def test_move_operation_skips_ldap_updates_for_short_list():
    ldap = MoveLdap([CHAIN_DN])
    subject = _move_subject(ldap)
    options = {"moveup_chain": "primary"}

    GPMASTER.gpmaster_mod._do_move_operation(
        subject, ldap, MASTER_DN, (), options
    )

    subject._validate_move_operations.assert_called_once_with(
        ldap, MASTER_DN, options
    )
    assert ldap.updated_chainlists == []


@pytest.mark.parametrize(
    "options",
    [
        {"moveup_chain": "primary"},
        {"movedown_chain": ("fallback",)},
    ],
)
def test_validate_move_accepts_active_chain(options):
    ldap = MoveLdap([CHAIN_DN, SECOND_CHAIN_DN])

    GPMASTER.gpmaster_mod._validate_move_operations(
        SimpleNamespace(), ldap, MASTER_DN, options
    )


@pytest.mark.parametrize(
    ("option_name", "error_name"),
    [
        ("moveup_chain", "moveup_chain"),
        ("movedown_chain", "movedown_chain"),
    ],
)
def test_validate_move_rejects_inactive_chain(option_name, error_name):
    ldap = MoveLdap([CHAIN_DN, SECOND_CHAIN_DN])

    with pytest.raises(errors.ValidationError) as failure:
        GPMASTER.gpmaster_mod._validate_move_operations(
            SimpleNamespace(),
            ldap,
            MASTER_DN,
            {option_name: "inactive"},
        )

    assert failure.value.name == error_name


def test_validate_move_rejects_conflicting_directions():
    ldap = MoveLdap([CHAIN_DN, SECOND_CHAIN_DN])

    with pytest.raises(errors.ValidationError) as failure:
        GPMASTER.gpmaster_mod._validate_move_operations(
            SimpleNamespace(),
            ldap,
            MASTER_DN,
            {
                "moveup_chain": "primary",
                "movedown_chain": "fallback",
            },
        )

    assert failure.value.name == "move_chain"


def test_empty_moveup_option_does_not_override_movedown_direction():
    ldap = MoveLdap([CHAIN_DN, SECOND_CHAIN_DN])
    subject = _move_subject(ldap)
    options = {"moveup_chain": (), "movedown_chain": "primary"}

    GPMASTER.gpmaster_mod._do_move_operation(
        subject, ldap, MASTER_DN, (), options
    )

    assert ldap.updated_chainlists == [
        [],
        [str(SECOND_CHAIN_DN), str(CHAIN_DN)],
    ]


def _command_subject(entry=None):
    ldap = MagicMock()
    ldap.get_entry.return_value = entry or {}
    obj = MagicMock()
    obj.get_gpmaster_dn.return_value = MASTER_DN
    obj.default_attributes = ["cn", "chainlist", "pdcemulator"]
    subject = SimpleNamespace(
        api=SimpleNamespace(Backend=SimpleNamespace(ldap2=ldap)),
        obj=obj,
    )
    return subject, obj, ldap


def test_show_returns_flattened_values_and_readable_chain_names():
    subject, obj, _ldap = _command_subject(
        {
            "cn": ["grouppolicymaster"],
            "chainlist": [str(CHAIN_DN)],
            "pdcemulator": ["dc1.example.test"],
        }
    )
    obj.convert_chain_dns_to_names.return_value = ["primary"]

    result = GPMASTER.gpmaster_show.execute(subject)

    assert result == {
        "result": {
            "cn": "grouppolicymaster",
            "chainlist": ["primary"],
            "pdcemulator": "dc1.example.test",
        },
        "value": "grouppolicymaster",
        "summary": None,
    }
    obj.convert_chain_dns_to_names.assert_called_once()


def test_show_raw_preserves_chain_dns():
    subject, obj, _ldap = _command_subject(
        {"cn": ["grouppolicymaster"], "chainlist": [str(CHAIN_DN)]}
    )

    result = GPMASTER.gpmaster_show.execute(subject, raw=True)

    assert result["result"]["chainlist"] == [str(CHAIN_DN)]
    obj.convert_chain_dns_to_names.assert_not_called()


def test_show_translates_missing_master():
    subject, _obj, ldap = _command_subject()
    ldap.get_entry.side_effect = errors.NotFound(reason="missing")

    with pytest.raises(errors.NotFound):
        GPMASTER.gpmaster_show.execute(subject)


@pytest.mark.parametrize(
    ("entry", "expected"),
    [
        ({"pdcemulator": ["dc1.example.test"]}, "dc1.example.test"),
        ({}, "Not configured"),
        ({"pdcemulator": []}, "Not configured"),
    ],
)
def test_show_pdc_returns_configured_or_default_value(entry, expected):
    subject, _obj, _ldap = _command_subject(entry)

    assert GPMASTER.gpmaster_show_pdc.execute(subject) == {
        "result": {"pdc_emulator": expected}
    }


def test_show_pdc_translates_missing_master():
    subject, _obj, ldap = _command_subject()
    ldap.get_entry.side_effect = errors.NotFound(reason="missing")

    with pytest.raises(errors.NotFound):
        GPMASTER.gpmaster_show_pdc.execute(subject)


def test_move_execute_returns_converted_and_flattened_result():
    subject, obj, ldap = _command_subject(
        {
            "cn": ["grouppolicymaster"],
            "chainlist": [str(CHAIN_DN)],
            "pdcemulator": ["dc1.example.test"],
        }
    )
    subject._do_move_operation = MagicMock()
    subject.msg_summary = 'Modified Group Policy Master "%(value)s"'
    obj.convert_chain_dns_to_names.return_value = ["primary"]
    options = {"moveup_chain": "primary"}

    result = GPMASTER.gpmaster_mod.execute(subject, "custom-master", **options)

    subject._do_move_operation.assert_called_once_with(
        ldap, MASTER_DN, ("custom-master",), options
    )
    assert result == {
        "result": {
            "cn": "grouppolicymaster",
            "chainlist": ["primary"],
            "pdcemulator": "dc1.example.test",
        },
        "value": "custom-master",
        "summary": 'Modified Group Policy Master "custom-master"',
    }


def test_pre_callback_runs_add_remove_and_standard_handlers_in_order():
    subject, _obj, ldap = _command_subject({"chainlist": [str(CHAIN_DN)]})
    calls = []
    subject._handle_add_operations = MagicMock(
        side_effect=lambda *_args: calls.append("add")
    )
    subject._handle_remove_operations = MagicMock(
        side_effect=lambda *_args: calls.append("remove")
    )
    subject._handle_standard_modifications = MagicMock(
        side_effect=lambda *_args: calls.append("standard")
    )
    entry_attrs = {}
    options = {"add_chain": "primary"}

    result = GPMASTER.gpmaster_mod.pre_callback(
        subject, ldap, MASTER_DN, entry_attrs, [], "grouppolicymaster", **options
    )

    assert result == MASTER_DN
    assert calls == ["add", "remove", "standard"]


def test_pre_callback_combines_add_and_remove_on_one_chainlist_snapshot():
    class ModifierHarness:
        _handle_add_operations = GPMASTER.gpmaster_mod._handle_add_operations
        _handle_remove_operations = GPMASTER.gpmaster_mod._handle_remove_operations
        _handle_standard_modifications = (
            GPMASTER.gpmaster_mod._handle_standard_modifications
        )

    ldap = MagicMock()
    ldap.get_entry.return_value = {"chainlist": [CHAIN_DN]}
    obj = MagicMock()
    obj.get_gpmaster_dn.return_value = MASTER_DN

    def resolve(name, strict=False):
        if name == "fallback" and strict:
            return str(SECOND_CHAIN_DN)
        if name == "primary" and not strict:
            return str(CHAIN_DN)
        raise AssertionError("unexpected resolution: {} {}".format(name, strict))

    obj.resolve_chain_name.side_effect = resolve
    subject = ModifierHarness()
    subject.api = SimpleNamespace(Backend=SimpleNamespace(ldap2=ldap))
    subject.obj = obj
    entry_attrs = {}
    options = {"add_chain": "fallback", "remove_chain": "primary"}

    result = GPMASTER.gpmaster_mod.pre_callback(
        subject,
        ldap,
        MASTER_DN,
        entry_attrs,
        [],
        "grouppolicymaster",
        **options,
    )

    assert result == MASTER_DN
    assert entry_attrs["chainlist"] == [str(SECOND_CHAIN_DN)]
