"""Unit tests for LDAP schema lookup fallback behavior."""

import logging
from unittest.mock import MagicMock, call, patch

import ldap

from ipa_gpo_install.checks import IPAChecker


def test_schema_check_falls_back_to_subschema():
    connection = MagicMock()
    schema_entry = {
        "objectclasses": [b"( 1.2.3 NAME 'groupPolicyContainer' )"],
        "attributetypes": [],
    }

    def search(dn, scope, attrlist):
        if dn == "cn=schema":
            raise ldap.NO_SUCH_OBJECT({"desc": "No such object"})
        assert dn == "cn=subschema"
        return [(dn, schema_entry)]

    connection.search_s.side_effect = search
    api = MagicMock()
    api.Backend.ldap2.conn = connection
    checker = IPAChecker(
        logger=logging.getLogger("test-checks-schema"),
        api_instance=api,
    )
    parsed_schema = MagicMock()
    parsed_schema.get_obj.return_value = MagicMock()

    with patch(
        "ipa_gpo_install.checks.ldap.schema.SubSchema",
        return_value=parsed_schema,
    ) as parser:
        result = checker.check_schema_complete(["groupPolicyContainer"])

    assert result is True
    assert connection.search_s.call_args_list == [
        call(
            "cn=schema",
            ldap.SCOPE_BASE,
            attrlist=["attributetypes", "objectclasses"],
        ),
        call(
            "cn=subschema",
            ldap.SCOPE_BASE,
            attrlist=["attributetypes", "objectclasses"],
        ),
    ]
    parser.assert_called_once_with(schema_entry)
    parsed_schema.get_obj.assert_called_once_with(
        ldap.schema.ObjectClass, "groupPolicyContainer"
    )
