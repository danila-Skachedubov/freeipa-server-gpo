"""Focused unit tests for the FreeIPA Group Policy Object CRUD plugin."""

import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

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
