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


def _plugin_api():
    return SimpleNamespace(env=SimpleNamespace(basedn=BASEDN))


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
