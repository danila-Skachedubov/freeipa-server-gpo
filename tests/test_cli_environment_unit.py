"""Unit tests for installer environment initialization."""

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from ipalib import errors

from ipa_gpo_install import cli


def _options(debuglevel=0):
    return SimpleNamespace(debuglevel=debuglevel)


def _mock_environment(monkeypatch, connect_error=None):
    api = MagicMock()
    if connect_error is not None:
        api.Backend.ldap2.connect.side_effect = connect_error
    monkeypatch.setattr(cli, "api", api)
    monkeypatch.setattr(cli.os, "geteuid", lambda: 0)
    makedirs = MagicMock()
    logging_setup = MagicMock()
    monkeypatch.setattr(cli.os, "makedirs", makedirs)
    monkeypatch.setattr(cli, "standard_logging_setup", logging_setup)
    return api, makedirs, logging_setup


def test_setup_environment_rejects_non_root(monkeypatch):
    api = MagicMock()
    monkeypatch.setattr(cli, "api", api)
    monkeypatch.setattr(cli.os, "geteuid", lambda: 1000)

    assert cli.setup_environment(_options()) is False
    api.bootstrap.assert_not_called()


@pytest.mark.parametrize(
    ("debuglevel", "verbose", "debug"),
    [(0, False, False), (1, True, False), (2, True, True)],
)
def test_setup_environment_initializes_api_and_ldap(
    monkeypatch, debuglevel, verbose, debug
):
    api, makedirs, logging_setup = _mock_environment(monkeypatch)

    assert cli.setup_environment(_options(debuglevel)) is True
    makedirs.assert_called_once_with(
        cli.os.path.dirname(cli.LOG_FILE_PATH), exist_ok=True
    )
    logging_setup.assert_called_once_with(
        cli.LOG_FILE_PATH,
        verbose=verbose,
        debug=debug,
        filemode="a",
    )
    api.bootstrap.assert_called_once_with(
        in_server=True,
        debug=False,
        context="installer",
        confdir=cli.paths.ETC_IPA,
    )
    api.finalize.assert_called_once_with()
    api.Backend.ldap2.connect.assert_called_once_with()


@pytest.mark.parametrize(
    "connection_error",
    [
        errors.ACIError(message="credentials rejected"),
        errors.DatabaseError(message="database unavailable"),
    ],
)
def test_setup_environment_handles_expected_ldap_errors(
    monkeypatch, connection_error
):
    api, _makedirs, _logging_setup = _mock_environment(
        monkeypatch, connect_error=connection_error
    )

    assert cli.setup_environment(_options()) is False
    api.bootstrap.assert_called_once()
    api.finalize.assert_called_once()


def test_setup_environment_handles_unexpected_initialization_error(monkeypatch):
    _api, makedirs, _logging_setup = _mock_environment(monkeypatch)
    makedirs.side_effect = OSError("read-only filesystem")

    assert cli.setup_environment(_options()) is False
