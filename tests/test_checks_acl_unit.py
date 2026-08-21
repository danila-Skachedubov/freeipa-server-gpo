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


def test_editor_directory_rejects_unreadable_acl(monkeypatch, tmp_path):
    checker = _checker()
    monkeypatch.setattr(checker, "_acl_entries", lambda _path: None)
    access = MagicMock(return_value=True)
    monkeypatch.setattr(checker, "_identity_can_access", access)

    assert checker._check_editor_directory(tmp_path) is False
    access.assert_not_called()


def test_editor_directory_rejects_incomplete_acl(monkeypatch, tmp_path):
    checker = _checker()
    monkeypatch.setattr(
        checker,
        "_acl_entries",
        lambda _path: {"user:ipaapi:rwx"},
    )
    access = MagicMock(return_value=True)
    monkeypatch.setattr(checker, "_identity_can_access", access)

    assert checker._check_editor_directory(tmp_path) is False
    access.assert_not_called()


def test_editor_directory_rejects_inaccessible_identity(
    monkeypatch, tmp_path
):
    checker = _checker()
    monkeypatch.setattr(
        checker,
        "_acl_entries",
        lambda _path: {
            "user:ipaapi:rwx",
            "default:user:ipaapi:rwx",
        },
    )
    access = MagicMock(return_value=False)
    monkeypatch.setattr(checker, "_identity_can_access", access)

    assert checker._check_editor_directory(tmp_path) is False
    access.assert_called_once_with(tmp_path, "rwx")


def test_editor_directory_accepts_acl_without_default_when_optional(
    monkeypatch, tmp_path
):
    checker = _checker()
    monkeypatch.setattr(
        checker,
        "_acl_entries",
        lambda _path: {"user:ipaapi:r-x"},
    )
    access = MagicMock(return_value=True)
    monkeypatch.setattr(checker, "_identity_can_access", access)

    assert checker._check_editor_directory(
        tmp_path,
        access_permissions="r-x",
        identity_permissions="rx",
        require_default=False,
    ) is True
    access.assert_called_once_with(tmp_path, "rx")


def _checker_for_policies(monkeypatch, policies):
    checker = _checker()
    checker.api.env.domain = "example.test"
    monkeypatch.setattr(
        checks_module, "get_policies_path", lambda _domain: str(policies)
    )
    return checker


def test_policies_access_rejects_missing_directory(monkeypatch, tmp_path):
    checker = _checker_for_policies(monkeypatch, tmp_path / "missing")
    check_directory = MagicMock(return_value=True)
    monkeypatch.setattr(checker, "_check_editor_directory", check_directory)

    assert checker.check_policies_editor_access() is False
    check_directory.assert_not_called()


def test_policies_access_rejects_root_acl_failure(monkeypatch, tmp_path):
    policies = tmp_path / "Policies"
    policies.mkdir()
    checker = _checker_for_policies(monkeypatch, policies)
    check_directory = MagicMock(return_value=False)
    monkeypatch.setattr(checker, "_check_editor_directory", check_directory)

    assert checker.check_policies_editor_access() is False
    check_directory.assert_called_once_with(
        policies,
        access_permissions="r-x",
        identity_permissions="rx",
        forbid_write=True,
    )


def test_policies_access_accepts_empty_directory(monkeypatch, tmp_path):
    policies = tmp_path / "Policies"
    policies.mkdir()
    checker = _checker_for_policies(monkeypatch, policies)
    monkeypatch.setattr(
        checker, "_check_editor_directory", MagicMock(return_value=True)
    )

    assert checker.check_policies_editor_access() is True


def test_policies_access_rejects_representative_gpo_acl(
    monkeypatch, tmp_path
):
    policies = tmp_path / "Policies"
    policy = policies / "gpo"
    policy.mkdir(parents=True)
    checker = _checker_for_policies(monkeypatch, policies)
    check_directory = MagicMock(side_effect=[True, False])
    monkeypatch.setattr(checker, "_check_editor_directory", check_directory)

    assert checker.check_policies_editor_access() is False
    assert check_directory.call_args_list[1].args == (policy,)


def test_policies_access_rejects_acl_failure_in_second_gpo(
    monkeypatch, tmp_path
):
    policies = tmp_path / "Policies"
    first = policies / "gpo-a"
    second = policies / "gpo-b"
    first.mkdir(parents=True)
    second.mkdir()
    checker = _checker_for_policies(monkeypatch, policies)
    check_directory = MagicMock(side_effect=[True, True, False])
    monkeypatch.setattr(checker, "_check_editor_directory", check_directory)

    assert checker.check_policies_editor_access() is False
    assert [call.args[0] for call in check_directory.call_args_list] == [
        policies,
        first,
        second,
    ]


def test_policies_access_rejects_nested_directory_acl_failure(
    monkeypatch, tmp_path
):
    policies = tmp_path / "Policies"
    policy = policies / "gpo"
    machine = policy / "Machine"
    machine.mkdir(parents=True)
    checker = _checker_for_policies(monkeypatch, policies)
    check_directory = MagicMock(side_effect=[True, True, False])
    monkeypatch.setattr(checker, "_check_editor_directory", check_directory)

    assert checker.check_policies_editor_access() is False
    assert check_directory.call_args_list[-1].args == (machine,)


def test_policies_access_checks_fallback_file_when_gpt_ini_is_missing(
    monkeypatch, tmp_path
):
    policies = tmp_path / "Policies"
    policy = policies / "gpo"
    nested = policy / "Machine"
    nested.mkdir(parents=True)
    fallback = nested / "Registry.pol"
    fallback.write_bytes(b"registry data")
    checker = _checker_for_policies(monkeypatch, policies)
    monkeypatch.setattr(
        checker, "_check_editor_directory", MagicMock(return_value=True)
    )
    access = MagicMock(return_value=False)
    monkeypatch.setattr(checker, "_identity_can_access", access)

    assert checker.check_policies_editor_access() is False
    access.assert_called_once_with(fallback, "rw")


def test_policies_access_handles_filesystem_error(monkeypatch, tmp_path):
    policies = tmp_path / "Policies"
    policies.mkdir()
    checker = _checker_for_policies(monkeypatch, policies)
    monkeypatch.setattr(
        checker, "_check_editor_directory", MagicMock(return_value=True)
    )
    monkeypatch.setattr(
        "pathlib.Path.iterdir", MagicMock(side_effect=OSError("read failed"))
    )

    assert checker.check_policies_editor_access() is False
