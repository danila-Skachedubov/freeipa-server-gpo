"""Unit tests for the installer's low-level editor ACL checks."""

import logging
import subprocess
from unittest.mock import MagicMock

import pytest

from ipa_gpo_install import checks as checks_module
from ipa_gpo_install.checks import IPAChecker


def _checker():
    return IPAChecker(
        logger=logging.getLogger("test-checks-acl"),
        api_instance=MagicMock(),
    )


@pytest.mark.parametrize(
    ("status", "expected"),
    [((True, "ok"), True), ((False, "wrong owner"), False)],
)
def test_editor_state_directory_uses_filesystem_status(
    monkeypatch, status, expected
):
    monkeypatch.setattr(
        checks_module, "editor_state_directory_status", lambda: status
    )

    assert _checker().check_editor_state_directory() is expected


def test_acl_entries_parse_comments_and_qualifiers(monkeypatch, tmp_path):
    completed = subprocess.CompletedProcess(
        [],
        0,
        stdout=(
            "# file: ignored\n"
            "user::rwx\n"
            "user:ipaapi:r-x        #effective:r-x\n"
            "default:user:ipaapi:rwx\n"
            "\n"
        ),
        stderr="",
    )
    run = MagicMock(return_value=completed)
    monkeypatch.setattr(checks_module.subprocess, "run", run)

    assert IPAChecker._acl_entries(tmp_path) == {
        "user::rwx",
        "user:ipaapi:r-x",
        "default:user:ipaapi:rwx",
    }
    run.assert_called_once_with(
        ["getfacl", "-cp", str(tmp_path)],
        capture_output=True,
        text=True,
        check=False,
    )


def test_acl_entries_return_none_when_getfacl_fails(monkeypatch, tmp_path):
    monkeypatch.setattr(
        checks_module.subprocess,
        "run",
        MagicMock(return_value=subprocess.CompletedProcess([], 1)),
    )

    assert IPAChecker._acl_entries(tmp_path) is None


def test_identity_access_checks_every_requested_permission(
    monkeypatch, tmp_path
):
    run = MagicMock(
        side_effect=lambda command, **_kwargs: subprocess.CompletedProcess(
            command, 0
        )
    )
    monkeypatch.setattr(checks_module.subprocess, "run", run)

    assert IPAChecker._identity_can_access(tmp_path, "rwx") is True
    assert [call.args[0][5] for call in run.call_args_list] == [
        "-r",
        "-w",
        "-x",
    ]
    assert all(call.args[0][-1] == str(tmp_path) for call in run.call_args_list)


def test_identity_access_stops_after_first_denied_permission(
    monkeypatch, tmp_path
):
    run = MagicMock(
        side_effect=[
            subprocess.CompletedProcess([], 0),
            subprocess.CompletedProcess([], 1),
        ]
    )
    monkeypatch.setattr(checks_module.subprocess, "run", run)

    assert IPAChecker._identity_can_access(tmp_path, "rwx") is False
    assert run.call_count == 2
