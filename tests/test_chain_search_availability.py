"""Chain search regression coverage using FreeIPA's actual LDAPSearch flow."""

import importlib.util
import subprocess
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from ipalib import errors
from ipalib.request import context
from ipalib.text import GettextFactory
from ipapython.dn import DN
from ipaserver.plugins import baseldap


MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "plugin/ipaserver/plugins/chain.py"
)
SPEC = importlib.util.spec_from_file_location("chain_search_under_test", MODULE_PATH)
CHAIN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHAIN)

BASEDN = DN(("dc", "example"), ("dc", "test"))
CONTAINER_DN = DN(("cn", "Chains"), ("cn", "System"))


class Entry(dict):
    def __init__(self, name):
        super().__init__(cn=[name])
        self.dn = DN(("cn", name), CONTAINER_DN, BASEDN)


class SearchHarness(CHAIN.chain_find):
    """Mock frontend metadata, not LDAPSearch.execute or its exception wrapper."""

    @property
    def obj(self):
        return self._test_obj

    @property
    def api(self):
        return self._test_api

    @property
    def args(self):
        return {"criteria": None}

    def args_options_2_entry(self, *args, **options):
        return {}

    def get_attr_filter(self, ldap, **options):
        return "(objectclass=groupPolicyChain)"

    def get_term_filter(self, ldap, term):
        return ""

    def get_member_filter(self, ldap, **options):
        return ""


@pytest.fixture
def search(monkeypatch):
    ldap = MagicMock()
    ldap.SCOPE_ONELEVEL = 1
    ldap.find_entries.return_value = ([], False)
    obj = SimpleNamespace(
        backend=ldap,
        parent_object="",
        container_dn=CONTAINER_DN,
        search_display_attributes=None,
        default_attributes=["cn"],
        attribute_members={},
        primary_key=SimpleNamespace(name="cn"),
        get_indirect_members=MagicMock(),
        convert_attribute_members=MagicMock(),
    )
    commands = SimpleNamespace(
        gpmaster_show=MagicMock(return_value={"result": {"chainlist": []}})
    )
    api = SimpleNamespace(
        env=SimpleNamespace(basedn=BASEDN),
        Object={},
        Command=commands,
    )
    monkeypatch.setattr(baseldap, "api", api)
    monkeypatch.setattr(CHAIN, "api", api)
    subject = object.__new__(SearchHarness)
    object.__setattr__(subject, "_test_obj", obj)
    object.__setattr__(subject, "_test_api", api)
    return subject, ldap, commands


@pytest.mark.parametrize("criteria", ["", "search-term"])
@pytest.mark.parametrize("options", [{}, {"raw": True}, {"active": True}])
def test_missing_container_reports_installation_error(search, criteria, options):
    subject, ldap, commands = search
    ldap.find_entries.side_effect = errors.NotFound(reason="missing container")

    with pytest.raises(errors.DatabaseError) as caught:
        subject.execute(criteria, **options)

    assert "Group Policy installation is incomplete" in str(caught.value)
    assert "Chains LDAP container is missing" in str(caught.value)
    assert "ipa-gpo-install" in str(caught.value)
    assert subject.execute.__func__ is baseldap.LDAPSearch.execute
    assert list(subject.get_callbacks("exc")) == [CHAIN.chain_find.exc_callback]
    ldap.find_entries.assert_called_once()
    assert ldap.find_entries.call_args.args[2] == DN(CONTAINER_DN, BASEDN)
    commands.gpmaster_show.assert_not_called()
    ldap.add_entry.assert_not_called()
    ldap.update_entry.assert_not_called()
    ldap.delete_entry.assert_not_called()


@pytest.mark.parametrize(
    ("language", "expected"),
    [
        ("en", "The Chains LDAP container is missing."),
        ("ru", "Отсутствует контейнер Chains в LDAP."),
    ],
)
def test_missing_container_error_uses_request_language(
        search, monkeypatch, tmp_path, language, expected):
    mo = tmp_path / "ru/LC_MESSAGES/ipa-gpo-install.mo"
    mo.parent.mkdir(parents=True)
    subprocess.run(
        ["msgfmt", "--check", "-o", str(mo),
         str(MODULE_PATH.parents[3] / "locale/ru/LC_MESSAGES/ipa-gpo-install.po")],
        check=True,
        capture_output=True,
    )
    monkeypatch.setattr(
        CHAIN, "_gpo", GettextFactory(domain="ipa-gpo-install", localedir=str(tmp_path))
    )
    monkeypatch.setattr(context, "languages", [language], raising=False)
    subject, ldap, _commands = search
    ldap.find_entries.side_effect = errors.NotFound(reason="missing container")

    with pytest.raises(errors.DatabaseError) as caught:
        subject.execute("")

    assert expected in str(caught.value)
    assert "ipa-gpo-install" in str(caught.value)


@pytest.mark.parametrize(
    "failure",
    [
        errors.ACIError(info="search denied"),
        RuntimeError("LDAP unavailable"),
        KeyError("unrelated key"),
    ],
)
def test_search_failure_is_not_hidden(search, failure):
    subject, ldap, _commands = search
    ldap.find_entries.side_effect = failure

    with pytest.raises(type(failure)) as caught:
        subject.execute("")

    assert caught.value is failure


def test_missing_entry_from_non_search_call_is_not_an_empty_result(search):
    subject, ldap, _commands = search
    failure = errors.NotFound(reason="missing unrelated entry")

    with pytest.raises(errors.NotFound) as caught:
        subject.exc_callback((), {}, failure, ldap.get_entry, DN(CONTAINER_DN, BASEDN))

    assert caught.value is failure


def test_active_filter_missing_master_is_not_an_empty_result(search):
    subject, ldap, commands = search
    ldap.find_entries.return_value = ([Entry("first")], False)
    failure = errors.NotFound(reason="missing master")
    commands.gpmaster_show.side_effect = failure

    with pytest.raises(errors.NotFound) as caught:
        subject.execute("", active=True)

    assert caught.value is failure
    commands.gpmaster_show.assert_called_once_with()


def test_post_callback_not_found_is_not_an_empty_result(search, monkeypatch):
    subject, _ldap, _commands = search
    failure = errors.NotFound(reason="missing callback dependency")

    def post_callback(*args, **kwargs):
        raise failure

    monkeypatch.setattr(SearchHarness, "post_callback", post_callback)

    with pytest.raises(errors.NotFound) as caught:
        subject.execute("")

    assert caught.value is failure


def test_existing_entries_keep_master_order_and_active_state(search):
    subject, ldap, commands = search
    ldap.find_entries.return_value = (
        [Entry("zulu"), Entry("first"), Entry("alpha"), Entry("second")],
        False,
    )
    commands.gpmaster_show.return_value = {
        "result": {"chainlist": ["second", "first"]}
    }

    result = subject.execute("")

    assert result["count"] == 4
    assert result["truncated"] is False
    assert [entry["cn"][0] for entry in result["result"]] == [
        "second", "first", "alpha", "zulu"
    ]
    assert [entry["active"] for entry in result["result"]] == [
        [True], [True], [False], [False]
    ]


@pytest.mark.parametrize("missing_matches", [False, True])
def test_existing_empty_result_behavior_is_preserved(search, missing_matches):
    subject, ldap, _commands = search
    if missing_matches:
        ldap.find_entries.side_effect = errors.EmptyResult(reason="no matches")

    assert subject.execute("") == {"result": [], "count": 0, "truncated": False}
