"""Focused unit tests for the FreeIPA Group Policy Object CRUD plugin."""

import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, call

import pytest
from ipalib import errors
from ipapython.dn import DN


MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "plugin/ipaserver/plugins/gpo.py"
)
SPEC = importlib.util.spec_from_file_location("gpo_crud_under_test", MODULE_PATH)
GPO = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GPO)

BASEDN = DN(("dc", "example"), ("dc", "test"))
CONTAINER_DN = DN(("cn", "Policies"), ("cn", "System"))
GUID = "{E361BAA9-67B3-4828-84C1-6A74AADB9D06}"
GPO_DN = DN(("cn", GUID), CONTAINER_DN, BASEDN)


def _plugin_api():
    return SimpleNamespace(env=SimpleNamespace(
        basedn=BASEDN,
        container_grouppolicy=CONTAINER_DN,
        domain="EXAMPLE.TEST",
    ))


def _crud_subject():
    return SimpleNamespace(
        api=_plugin_api(),
        obj=SimpleNamespace(
            find_gpo_by_displayname=MagicMock(),
            _call_dbus_method=MagicMock(),
        ),
    )


def test_gpo_json_delegates_when_schema_metadata_is_available(monkeypatch):
    subject = object.__new__(GPO.gpo)
    expected = {"name": "from-base"}
    monkeypatch.setattr(
        GPO.LDAPObject,
        "__json__",
        MagicMock(return_value=expected),
    )

    assert GPO.gpo.__json__(subject) is expected


def test_gpo_json_falls_back_when_schema_metadata_is_missing(monkeypatch):
    subject = object.__new__(GPO.gpo)
    monkeypatch.setattr(
        GPO.LDAPObject,
        "__json__",
        MagicMock(side_effect=KeyError("groupPolicyContainer")),
    )

    result = GPO.gpo.__json__(subject)

    assert result["name"] == "gpo"
    assert result["object_class"] == ["groupPolicyContainer"]
    assert [parameter["name"] for parameter in result["takes_params"]] == [
        "displayname",
        "cn",
        "distinguishedname",
        "flags",
        "gpcfilesyspath",
        "versionnumber",
        "gpcmachineextensionnames",
        "gpcuserextensionnames",
    ]
    assert result["default_attributes"] == subject.default_attributes


def test_gpo_json_propagates_unrelated_metadata_failure(monkeypatch):
    subject = object.__new__(GPO.gpo)
    monkeypatch.setattr(
        GPO.LDAPObject,
        "__json__",
        MagicMock(side_effect=KeyError("unrelated schema")),
    )

    with pytest.raises(KeyError, match="unrelated schema"):
        GPO.gpo.__json__(subject)


def test_gpo_finalize_merges_plugin_containers(monkeypatch):
    subject = object.__new__(GPO.gpo)
    env = SimpleNamespace()

    def merge(**values):
        for name, value in values.items():
            setattr(env, name, value)

    env._merge = merge
    monkeypatch.setattr(GPO.gpo, "env", env, raising=False)
    base_finalize = MagicMock()
    monkeypatch.setattr(GPO.LDAPObject, "_on_finalize", base_finalize)

    GPO.gpo._on_finalize(subject)

    assert env.container_system == DN(("cn", "System"))
    assert env.container_grouppolicy == CONTAINER_DN
    assert subject.container_dn == CONTAINER_DN
    base_finalize.assert_called_once_with()


def test_find_gpo_by_displayname_uses_policy_container():
    subject = SimpleNamespace(env=_plugin_api().env)
    ldap = MagicMock()
    expected = SimpleNamespace(dn=GPO_DN)
    ldap.find_entry_by_attr.return_value = expected

    result = GPO.gpo.find_gpo_by_displayname(
        subject,
        ldap,
        "Policy-One",
    )

    assert result is expected
    ldap.find_entry_by_attr.assert_called_once_with(
        "displayName",
        "Policy-One",
        "groupPolicyContainer",
        base_dn=DN(CONTAINER_DN, BASEDN),
    )


def test_find_gpo_by_displayname_translates_not_found():
    subject = SimpleNamespace(env=_plugin_api().env)
    ldap = MagicMock()
    ldap.find_entry_by_attr.side_effect = errors.NotFound(reason="missing")

    with pytest.raises(errors.NotFound, match="Policy-One"):
        GPO.gpo.find_gpo_by_displayname(subject, ldap, "Policy-One")


def test_find_gpo_by_displayname_propagates_backend_failure():
    subject = SimpleNamespace(env=_plugin_api().env)
    ldap = MagicMock()
    ldap.find_entry_by_attr.side_effect = RuntimeError("LDAP unavailable")

    with pytest.raises(RuntimeError, match="LDAP unavailable"):
        GPO.gpo.find_gpo_by_displayname(subject, ldap, "Policy-One")


def test_verify_gpo_schema_reads_policy_container():
    ldap = MagicMock()

    GPO.verify_gpo_schema(ldap, _plugin_api())

    ldap.get_entry.assert_called_once_with(
        DN(("cn", "Policies"), ("cn", "System"), BASEDN),
        attrs_list=["cn"],
    )


def test_verify_gpo_schema_reports_missing_container():
    ldap = MagicMock()
    ldap.get_entry.side_effect = errors.NotFound(reason="missing")

    with pytest.raises(errors.NotFound, match="schema is not installed"):
        GPO.verify_gpo_schema(ldap, _plugin_api())


def test_verify_gpo_schema_translates_schema_backend_error():
    ldap = MagicMock()
    ldap.get_entry.side_effect = errors.DatabaseError(
        desc="LDAP schema",
        info="undefined object class",
    )

    with pytest.raises(errors.NotFound, match="groupPolicyContainer"):
        GPO.verify_gpo_schema(ldap, _plugin_api())


def test_verify_gpo_schema_propagates_unrelated_public_error():
    ldap = MagicMock()
    ldap.get_entry.side_effect = errors.ACIError(info="access denied")

    with pytest.raises(errors.ACIError, match="access denied"):
        GPO.verify_gpo_schema(ldap, _plugin_api())


def test_verify_gpo_schema_logs_and_propagates_backend_failure(monkeypatch):
    ldap = MagicMock()
    ldap.get_entry.side_effect = RuntimeError("LDAP unavailable")
    debug = MagicMock()
    monkeypatch.setattr(GPO.logger, "debug", debug)

    with pytest.raises(RuntimeError, match="LDAP unavailable"):
        GPO.verify_gpo_schema(ldap, _plugin_api())

    debug.assert_called_once_with(
        "GPO schema check error: %s",
        "LDAP unavailable",
    )


def test_get_bus_initializes_main_loop_and_caches_system_bus(monkeypatch):
    main_loop = MagicMock()
    bus = MagicMock()
    system_bus = MagicMock(return_value=bus)
    monkeypatch.setattr(GPO.dbus.mainloop.glib, "DBusGMainLoop", main_loop)
    monkeypatch.setattr(GPO.dbus, "SystemBus", system_bus)
    monkeypatch.setattr(GPO, "_bus", None)
    monkeypatch.setattr(GPO, "_bus_initialized", False)

    assert GPO._get_bus() is bus
    assert GPO._get_bus() is bus
    main_loop.assert_called_once_with(set_as_default=True)
    system_bus.assert_called_once_with()


def test_get_bus_retries_after_initialization_failure(monkeypatch):
    main_loop = MagicMock()
    bus = MagicMock()
    system_bus = MagicMock(
        side_effect=[GPO.dbus.DBusException("service offline"), bus]
    )
    monkeypatch.setattr(GPO.dbus.mainloop.glib, "DBusGMainLoop", main_loop)
    monkeypatch.setattr(GPO.dbus, "SystemBus", system_bus)
    monkeypatch.setattr(GPO, "_bus", None)
    monkeypatch.setattr(GPO, "_bus_initialized", False)

    with pytest.raises(GPO.dbus.DBusException, match="service offline"):
        GPO._get_bus()

    assert GPO._bus_initialized is False
    assert GPO._get_bus() is bus
    assert main_loop.call_count == 2
    assert system_bus.call_count == 2


def _dbus_subject(monkeypatch, result=(0, "created", "")):
    method = MagicMock(return_value=result)
    server = SimpleNamespace(create_gpo_structure=method)
    bus_object = MagicMock()
    bus = MagicMock()
    bus.get_object.return_value = bus_object
    get_bus = MagicMock(return_value=bus)
    interface = MagicMock(return_value=server)
    monkeypatch.setattr(GPO, "_get_bus", get_bus)
    monkeypatch.setattr(GPO.dbus, "Interface", interface)
    subject = SimpleNamespace()
    return subject, method, bus, bus_object, get_bus, interface


@pytest.mark.parametrize(
    ("return_stdout", "expected"),
    [(False, None), (True, "created")],
)
def test_call_dbus_method_returns_requested_success_value(
    monkeypatch,
    return_stdout,
    expected,
):
    subject, method, bus, bus_object, get_bus, interface = _dbus_subject(
        monkeypatch
    )

    result = GPO.gpo._call_dbus_method(
        subject,
        "create_gpo_structure",
        "{GUID}",
        "example.test",
        "Policy",
        return_stdout=return_stdout,
    )

    assert result == expected
    get_bus.assert_called_once_with()
    bus.get_object.assert_called_once_with(
        "org.freeipa.server",
        "/",
        follow_name_owner_changes=True,
    )
    interface.assert_called_once_with(bus_object, "org.freeipa.server")
    method.assert_called_once_with("{GUID}", "example.test", "Policy")


def test_call_dbus_method_raises_on_failed_required_operation(monkeypatch):
    subject, _method, _bus, _obj, _get_bus, _interface = _dbus_subject(
        monkeypatch,
        result=(1, "partial output", "permission denied"),
    )

    with pytest.raises(errors.ExecutionError, match="permission denied"):
        GPO.gpo._call_dbus_method(
            subject,
            "create_gpo_structure",
            "{GUID}",
        )


def test_call_dbus_method_logs_failed_best_effort_operation(monkeypatch):
    subject, _method, _bus, _obj, _get_bus, _interface = _dbus_subject(
        monkeypatch,
        result=(1, "partial output", "permission denied"),
    )
    warning = MagicMock()
    monkeypatch.setattr(GPO.logger, "warning", warning)

    result = GPO.gpo._call_dbus_method(
        subject,
        "create_gpo_structure",
        "{GUID}",
        fail_on_error=False,
        return_stdout=True,
    )

    assert result == "partial output"
    warning.assert_called_once_with(
        "Failed to create gpo structure: permission denied"
    )


@pytest.mark.parametrize("fail_on_error", [True, False])
def test_call_dbus_method_handles_transport_failure(
    monkeypatch,
    fail_on_error,
):
    subject, _method, bus, _obj, _get_bus, _interface = _dbus_subject(
        monkeypatch
    )
    bus.get_object.side_effect = GPO.dbus.DBusException("service offline")
    warning = MagicMock()
    monkeypatch.setattr(GPO.logger, "warning", warning)

    if fail_on_error:
        with pytest.raises(
            errors.ExecutionError,
            match="Failed to communicate with D-Bus service",
        ):
            GPO.gpo._call_dbus_method(
                subject,
                "create_gpo_structure",
                fail_on_error=True,
            )
        warning.assert_not_called()
    else:
        assert GPO.gpo._call_dbus_method(
            subject,
            "create_gpo_structure",
            fail_on_error=False,
        ) is None
        warning.assert_has_calls([
            call(
                "Failed to call D-Bus create_gpo_structure: service offline"
            )
        ])


@pytest.mark.parametrize("result", [None, (), (0, "stdout"), (0, "out", "", "extra")])
@pytest.mark.parametrize("fail_on_error", [True, False])
def test_call_dbus_method_handles_malformed_response(
    monkeypatch,
    result,
    fail_on_error,
):
    subject, _method, _bus, _obj, _get_bus, _interface = _dbus_subject(
        monkeypatch,
        result=result,
    )

    if fail_on_error:
        with pytest.raises(
            errors.ExecutionError,
            match="Invalid response from D-Bus service",
        ):
            GPO.gpo._call_dbus_method(
                subject,
                "create_gpo_structure",
                fail_on_error=True,
            )
    else:
        assert GPO.gpo._call_dbus_method(
            subject,
            "create_gpo_structure",
            fail_on_error=False,
        ) is None


@pytest.mark.parametrize("fail_on_error", [True, False])
def test_call_dbus_method_handles_unexpected_method_failure(
    monkeypatch,
    fail_on_error,
):
    subject, method, _bus, _obj, _get_bus, _interface = _dbus_subject(
        monkeypatch
    )
    method.side_effect = RuntimeError("broken proxy")

    if fail_on_error:
        with pytest.raises(
            errors.ExecutionError,
            match="Unexpected D-Bus service failure",
        ):
            GPO.gpo._call_dbus_method(
                subject,
                "create_gpo_structure",
                fail_on_error=True,
            )
    else:
        assert GPO.gpo._call_dbus_method(
            subject,
            "create_gpo_structure",
            fail_on_error=False,
        ) is None


def test_gpo_add_pre_callback_builds_complete_initial_entry(monkeypatch):
    subject = _crud_subject()
    ldap = MagicMock()
    subject.obj.find_gpo_by_displayname.side_effect = errors.NotFound(
        reason="not found"
    )
    schema_check = MagicMock()
    generated_uuid = MagicMock()
    generated_uuid.__str__.return_value = GUID[1:-1].lower()
    monkeypatch.setattr(GPO, "verify_gpo_schema", schema_check)
    monkeypatch.setattr(GPO.uuid, "uuid4", MagicMock(return_value=generated_uuid))
    entry_attrs = {"displayname": "Policy-One"}

    result = GPO.gpo_add.pre_callback(
        subject,
        ldap,
        MagicMock(),
        entry_attrs,
        ["cn"],
        "Policy-One",
    )

    assert result == GPO_DN
    assert entry_attrs == {
        "displayname": "Policy-One",
        "cn": GUID,
        "distinguishedname": str(GPO_DN),
        "gpcfilesyspath": (
            f"\\\\EXAMPLE.TEST\\SysVol\\EXAMPLE.TEST\\Policies\\{GUID}"
        ),
        "flags": 0,
        "versionnumber": 0,
    }
    schema_check.assert_called_once_with(ldap, subject.api)
    subject.obj.find_gpo_by_displayname.assert_called_once_with(
        ldap,
        "Policy-One",
    )


def test_gpo_add_pre_callback_rejects_invalid_display_name(monkeypatch):
    subject = _crud_subject()
    monkeypatch.setattr(GPO, "verify_gpo_schema", MagicMock())

    with pytest.raises(errors.ValidationError):
        GPO.gpo_add.pre_callback(
            subject,
            MagicMock(),
            GPO_DN,
            {},
            [],
            "invalid/name",
        )

    subject.obj.find_gpo_by_displayname.assert_not_called()


def test_gpo_add_pre_callback_rejects_duplicate_display_name(monkeypatch):
    subject = _crud_subject()
    subject.obj.find_gpo_by_displayname.return_value = SimpleNamespace(
        dn=GPO_DN
    )
    monkeypatch.setattr(GPO, "verify_gpo_schema", MagicMock())

    with pytest.raises(errors.InvocationError, match="already exists"):
        GPO.gpo_add.pre_callback(
            subject,
            MagicMock(),
            GPO_DN,
            {},
            [],
            "Policy-One",
        )


def test_gpo_add_post_callback_creates_sysvol_structure():
    subject = _crud_subject()
    ldap = MagicMock()

    result = GPO.gpo_add.post_callback(
        subject,
        ldap,
        GPO_DN,
        {},
        "Policy One",
    )

    assert result == GPO_DN
    subject.obj._call_dbus_method.assert_called_once_with(
        "create_gpo_structure",
        GUID,
        "example.test",
        "Policy One",
        fail_on_error=True,
    )
    ldap.delete_entry.assert_not_called()


def test_gpo_add_post_callback_rolls_back_sysvol_and_ldap_on_failure():
    subject = _crud_subject()
    primary = errors.ExecutionError(message="create failed")
    subject.obj._call_dbus_method.side_effect = [primary, None]
    ldap = MagicMock()

    with pytest.raises(errors.ExecutionError) as failure:
        GPO.gpo_add.post_callback(
            subject,
            ldap,
            GPO_DN,
            {},
            "Policy One",
        )

    assert failure.value is primary
    assert subject.obj._call_dbus_method.call_args_list == [
        call(
            "create_gpo_structure",
            GUID,
            "example.test",
            "Policy One",
            fail_on_error=True,
        ),
        call(
            "delete_gpo_structure",
            GUID,
            "example.test",
            fail_on_error=False,
        ),
    ]
    ldap.delete_entry.assert_called_once_with(GPO_DN)


def test_gpo_add_post_callback_preserves_primary_failure_when_cleanup_fails():
    subject = _crud_subject()
    primary = errors.ExecutionError(message="create failed")
    subject.obj._call_dbus_method.side_effect = [
        primary,
        RuntimeError("SYSVOL cleanup failed"),
    ]
    ldap = MagicMock()
    ldap.delete_entry.side_effect = RuntimeError("LDAP rollback failed")

    with pytest.raises(errors.ExecutionError) as failure:
        GPO.gpo_add.post_callback(
            subject,
            ldap,
            GPO_DN,
            {},
            "Policy One",
        )

    assert failure.value is primary
    ldap.delete_entry.assert_called_once_with(GPO_DN)


@pytest.mark.parametrize(
    "callback",
    [GPO.gpo_del.pre_callback, GPO.gpo_show.pre_callback],
)
def test_gpo_lookup_callbacks_resolve_display_name(
    monkeypatch,
    callback,
):
    subject = _crud_subject()
    ldap = MagicMock()
    subject.obj.find_gpo_by_displayname.return_value = SimpleNamespace(
        dn=GPO_DN
    )
    schema_check = MagicMock()
    monkeypatch.setattr(GPO, "verify_gpo_schema", schema_check)

    if callback is GPO.gpo_show.pre_callback:
        result = callback(subject, ldap, MagicMock(), [], "Policy One")
    else:
        result = callback(subject, ldap, MagicMock(), "Policy One")

    assert result == GPO_DN
    schema_check.assert_called_once_with(ldap, subject.api)
    subject.obj.find_gpo_by_displayname.assert_called_once_with(
        ldap,
        "Policy One",
    )


def test_gpo_delete_post_callback_removes_sysvol_best_effort():
    subject = _crud_subject()

    result = GPO.gpo_del.post_callback(
        subject,
        MagicMock(),
        GPO_DN,
        {},
        "Policy One",
    )

    assert result == GPO_DN
    subject.obj._call_dbus_method.assert_called_once_with(
        "delete_gpo_structure",
        GUID,
        "example.test",
        fail_on_error=False,
    )


def _gpo_find_subject(monkeypatch):
    ldap = MagicMock()
    plugin_api = _plugin_api()
    plugin_api.Backend = SimpleNamespace(ldap2=ldap)
    monkeypatch.setattr(GPO.gpo_find, "api", plugin_api, raising=False)
    return object.__new__(GPO.gpo_find), plugin_api, ldap


def test_gpo_find_checks_schema_and_returns_search_result(monkeypatch):
    subject, plugin_api, ldap = _gpo_find_subject(monkeypatch)
    expected = {
        "result": [{"displayname": ["Policy-One"]}],
        "count": 1,
        "truncated": False,
    }
    schema_check = MagicMock()
    base_execute = MagicMock(return_value=expected)
    monkeypatch.setattr(GPO, "verify_gpo_schema", schema_check)
    monkeypatch.setattr(GPO.LDAPSearch, "execute", base_execute)

    result = GPO.gpo_find.execute(subject, "Policy", sizelimit=10)

    assert result is expected
    schema_check.assert_called_once_with(ldap, plugin_api)
    base_execute.assert_called_once_with("Policy", sizelimit=10)


def test_gpo_find_returns_empty_result_for_not_found(monkeypatch):
    subject, _plugin_api_value, _ldap = _gpo_find_subject(monkeypatch)
    monkeypatch.setattr(GPO, "verify_gpo_schema", MagicMock())
    monkeypatch.setattr(
        GPO.LDAPSearch,
        "execute",
        MagicMock(side_effect=errors.NotFound(reason="none")),
    )

    result = GPO.gpo_find.execute(subject)

    assert result["result"] == []
    assert result["count"] == 0
    assert result["truncated"] is False


@pytest.mark.parametrize(
    "failure",
    [errors.ACIError(info="denied"), RuntimeError("LDAP unavailable")],
)
def test_gpo_find_propagates_unexpected_search_failure(
    monkeypatch,
    failure,
):
    subject, _plugin_api_value, _ldap = _gpo_find_subject(monkeypatch)
    monkeypatch.setattr(GPO, "verify_gpo_schema", MagicMock())
    monkeypatch.setattr(
        GPO.LDAPSearch,
        "execute",
        MagicMock(side_effect=failure),
    )

    with pytest.raises(type(failure), match=str(failure)):
        GPO.gpo_find.execute(subject)


def test_gpo_find_does_not_search_when_schema_check_fails(monkeypatch):
    subject, _plugin_api_value, _ldap = _gpo_find_subject(monkeypatch)
    base_execute = MagicMock()
    monkeypatch.setattr(
        GPO,
        "verify_gpo_schema",
        MagicMock(side_effect=errors.NotFound(reason="schema missing")),
    )
    monkeypatch.setattr(GPO.LDAPSearch, "execute", base_execute)

    with pytest.raises(errors.NotFound, match="schema missing"):
        GPO.gpo_find.execute(subject)

    base_execute.assert_not_called()


def test_gpo_mod_without_rename_resolves_current_entry(monkeypatch):
    subject = _crud_subject()
    ldap = MagicMock()
    subject.obj.find_gpo_by_displayname.return_value = SimpleNamespace(
        dn=GPO_DN
    )
    schema_check = MagicMock()
    monkeypatch.setattr(GPO, "verify_gpo_schema", schema_check)

    result = GPO.gpo_mod.pre_callback(
        subject,
        ldap,
        GPO_DN,
        {"flags": 1},
        ["flags"],
        "Policy-One",
    )

    assert result == GPO_DN
    schema_check.assert_called_once_with(ldap, subject.api)
    subject.obj.find_gpo_by_displayname.assert_called_once_with(
        ldap,
        "Policy-One",
    )


def test_gpo_mod_accepts_available_rename(monkeypatch):
    subject = _crud_subject()
    ldap = MagicMock()
    subject.obj.find_gpo_by_displayname.side_effect = [
        SimpleNamespace(dn=GPO_DN),
        errors.NotFound(reason="new name is available"),
    ]
    monkeypatch.setattr(GPO, "verify_gpo_schema", MagicMock())

    result = GPO.gpo_mod.pre_callback(
        subject,
        ldap,
        GPO_DN,
        {},
        [],
        "Policy-One",
        rename="Policy-Two",
    )

    assert result == GPO_DN
    assert subject.obj.find_gpo_by_displayname.call_args_list == [
        call(ldap, "Policy-One"),
        call(ldap, "Policy-Two"),
    ]


@pytest.mark.parametrize(
    ("rename", "error_type"),
    [
        ("invalid/name", errors.ValidationError),
        ("Policy-One", errors.ValidationError),
    ],
)
def test_gpo_mod_rejects_invalid_or_unchanged_rename(
    monkeypatch,
    rename,
    error_type,
):
    subject = _crud_subject()
    ldap = MagicMock()
    subject.obj.find_gpo_by_displayname.return_value = SimpleNamespace(
        dn=GPO_DN
    )
    monkeypatch.setattr(GPO, "verify_gpo_schema", MagicMock())

    with pytest.raises(error_type):
        GPO.gpo_mod.pre_callback(
            subject,
            ldap,
            GPO_DN,
            {},
            [],
            "Policy-One",
            rename=rename,
        )

    subject.obj.find_gpo_by_displayname.assert_called_once_with(
        ldap,
        "Policy-One",
    )


def test_gpo_mod_rejects_duplicate_rename(monkeypatch):
    subject = _crud_subject()
    ldap = MagicMock()
    subject.obj.find_gpo_by_displayname.side_effect = [
        SimpleNamespace(dn=GPO_DN),
        SimpleNamespace(dn=GPO_DN),
    ]
    monkeypatch.setattr(GPO, "verify_gpo_schema", MagicMock())

    with pytest.raises(errors.DuplicateEntry, match="already exists"):
        GPO.gpo_mod.pre_callback(
            subject,
            ldap,
            GPO_DN,
            {},
            [],
            "Policy-One",
            rename="Policy-Two",
        )


def test_gpo_mod_propagates_rename_lookup_failure(monkeypatch):
    subject = _crud_subject()
    ldap = MagicMock()
    subject.obj.find_gpo_by_displayname.side_effect = [
        SimpleNamespace(dn=GPO_DN),
        RuntimeError("LDAP unavailable"),
    ]
    monkeypatch.setattr(GPO, "verify_gpo_schema", MagicMock())

    with pytest.raises(RuntimeError, match="LDAP unavailable"):
        GPO.gpo_mod.pre_callback(
            subject,
            ldap,
            GPO_DN,
            {},
            [],
            "Policy-One",
            rename="Policy-Two",
        )
