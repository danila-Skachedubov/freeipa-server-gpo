"""Focused unit tests for installer filesystem safety checks."""

import grp
import os
import pwd
import subprocess

import pytest

from ipa_gpo_install.filesystem import (
    FilesystemConfigurationError,
    _run_checked,
    editor_state_directory_status,
    ensure_editor_state_directory,
)


def test_run_checked_passes_safe_subprocess_options():
    calls = []

    def runner(command, **kwargs):
        calls.append((command, kwargs))
        return subprocess.CompletedProcess(command, 0, "ok", "")

    _run_checked(["setfacl", "--version"], runner=runner)

    assert calls == [
        (
            ["setfacl", "--version"],
            {"capture_output": True, "text": True, "check": False},
        )
    ]


@pytest.mark.parametrize(
    ("stdout", "stderr", "detail"),
    [
        ("", "permission denied\n", "permission denied"),
        ("fallback output\n", "", "fallback output"),
        ("", "", "unknown error"),
    ],
)
def test_run_checked_reports_command_failure(stdout, stderr, detail):
    def runner(command, **_kwargs):
        return subprocess.CompletedProcess(command, 1, stdout, stderr)

    with pytest.raises(
        FilesystemConfigurationError,
        match="setfacl failed: {}".format(detail),
    ):
        _run_checked(["setfacl", "-m", "acl"], runner=runner)


def test_state_directory_rejects_symlink(tmp_path):
    target = tmp_path / "target"
    target.mkdir()
    state = tmp_path / "state"
    state.symlink_to(target, target_is_directory=True)

    with pytest.raises(
        FilesystemConfigurationError,
        match="must not be a symbolic link",
    ):
        ensure_editor_state_directory(state)


def test_state_directory_reports_missing_identity(tmp_path):
    with pytest.raises(
        FilesystemConfigurationError,
        match="editor identity is not available",
    ):
        ensure_editor_state_directory(
            tmp_path / "state",
            editor_user="ipa-gpo-user-that-does-not-exist",
            editor_group="ipa-gpo-group-that-does-not-exist",
        )


def test_state_directory_status_reports_missing_path(tmp_path):
    healthy, reason = editor_state_directory_status(
        tmp_path / "missing",
        editor_user="unused",
        editor_group="unused",
    )

    assert healthy is False
    assert reason


def test_state_directory_status_rejects_wrong_mode(tmp_path):
    state = tmp_path / "state"
    state.mkdir(mode=0o755)
    os.chmod(state, 0o755)

    healthy, reason = editor_state_directory_status(
        state,
        editor_user=pwd.getpwuid(os.getuid()).pw_name,
        editor_group=grp.getgrgid(os.getgid()).gr_name,
    )

    assert healthy is False
    assert reason == "mode is not 0700"
