"""Focused unit tests for installer filesystem safety checks."""

import os
import subprocess
from types import SimpleNamespace

import pytest

from ipa_gpo_install.filesystem import (
    FilesystemConfigurationError,
    _run_checked,
    _set_directory_acls,
    editor_state_directory_status,
    ensure_directory_editor_acl,
    ensure_editor_state_directory,
    ensure_new_gpo_acls,
    ensure_policies_root_acl,
)


TEST_USER = "ipaapi-test"
TEST_GROUP = "ipaapi-test"


def _mock_current_identity(monkeypatch):
    monkeypatch.setattr(
        "ipa_gpo_install.filesystem.pwd.getpwnam",
        lambda _name: SimpleNamespace(pw_uid=os.getuid()),
    )
    monkeypatch.setattr(
        "ipa_gpo_install.filesystem.grp.getgrnam",
        lambda _name: SimpleNamespace(gr_gid=os.getgid()),
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


def test_state_directory_status_rejects_wrong_mode(tmp_path, monkeypatch):
    state = tmp_path / "state"
    state.mkdir(mode=0o755)
    os.chmod(state, 0o755)

    _mock_current_identity(monkeypatch)
    healthy, reason = editor_state_directory_status(
        state, TEST_USER, TEST_GROUP
    )

    assert healthy is False
    assert reason == "mode is not 0700"


@pytest.mark.parametrize(
    "provisioner",
    [ensure_directory_editor_acl, ensure_policies_root_acl],
)
def test_acl_provisioner_rejects_regular_file(tmp_path, provisioner):
    target = tmp_path / "not-a-directory"
    target.write_text("data", encoding="utf-8")

    with pytest.raises(
        FilesystemConfigurationError,
        match="not a real directory",
    ):
        provisioner(target, runner=lambda *_args, **_kwargs: None)


def test_new_gpo_acls_reject_missing_policy_directory(tmp_path):
    policies = tmp_path / "Policies"
    policies.mkdir()

    with pytest.raises(
        FilesystemConfigurationError,
        match="GPO path is not a real directory",
    ):
        ensure_new_gpo_acls(
            policies,
            policies / "missing-gpo",
            runner=lambda command, **_kwargs: subprocess.CompletedProcess(
                command, 0
            ),
        )


@pytest.mark.parametrize("missing_name", ["Machine", "User"])
def test_new_gpo_acls_require_scope_directories(tmp_path, missing_name):
    policies = tmp_path / "Policies"
    policy = policies / "gpo"
    policy.mkdir(parents=True)
    for name in {"Machine", "User"} - {missing_name}:
        (policy / name).mkdir()

    with pytest.raises(
        FilesystemConfigurationError,
        match="new GPO directory is not a real directory",
    ):
        ensure_new_gpo_acls(
            policies,
            policy,
            runner=lambda command, **_kwargs: subprocess.CompletedProcess(
                command, 0
            ),
        )


def test_directory_acls_are_split_into_bounded_batches():
    directories = ["directory-{}".format(index) for index in range(257)]
    calls = []

    def runner(command, **_kwargs):
        calls.append(command)
        return subprocess.CompletedProcess(command, 0)

    _set_directory_acls(directories, "ipaapi", runner=runner)

    assert [len(command[4:]) for command in calls] == [128, 128, 1]
    assert [path for command in calls for path in command[4:]] == directories


def test_state_directory_status_rejects_wrong_owner(tmp_path, monkeypatch):
    state = tmp_path / "state"
    state.mkdir(mode=0o700)
    os.chmod(state, 0o700)
    info = state.stat()

    monkeypatch.setattr(
        "ipa_gpo_install.filesystem.pwd.getpwnam",
        lambda _name: SimpleNamespace(pw_uid=info.st_uid + 1),
    )
    monkeypatch.setattr(
        "ipa_gpo_install.filesystem.grp.getgrnam",
        lambda _name: SimpleNamespace(gr_gid=info.st_gid + 1),
    )

    healthy, reason = editor_state_directory_status(state, "ipaapi", "ipaapi")

    assert healthy is False
    assert reason == "owner is not ipaapi:ipaapi"


def test_state_directory_rechecks_type_after_creation(tmp_path, monkeypatch):
    state = tmp_path / "state"
    monkeypatch.setattr("pathlib.Path.mkdir", lambda *_args, **_kwargs: None)

    with pytest.raises(
        FilesystemConfigurationError,
        match="editor state path is not a directory",
    ):
        ensure_editor_state_directory(state)


def test_directory_editor_acl_applies_access_and_default_acl(tmp_path):
    directory = tmp_path / "gpo"
    directory.mkdir()
    calls = []

    def runner(command, **_kwargs):
        calls.append(command)
        return subprocess.CompletedProcess(command, 0)

    ensure_directory_editor_acl(directory, "ipaapi", runner=runner)

    assert calls == [
        [
            "setfacl",
            "-m",
            "u:ipaapi:rwx,d:u:ipaapi:rwx",
            "--",
            str(directory),
        ]
    ]


def test_state_directory_status_rejects_regular_file(tmp_path, monkeypatch):
    state = tmp_path / "state"
    state.write_text("not a directory", encoding="utf-8")
    _mock_current_identity(monkeypatch)

    healthy, reason = editor_state_directory_status(
        state, TEST_USER, TEST_GROUP
    )

    assert healthy is False
    assert reason == "path is not a real directory"


def test_state_directory_status_accepts_healthy_directory(tmp_path, monkeypatch):
    state = tmp_path / "state"
    state.mkdir(mode=0o700)
    os.chmod(state, 0o700)
    _mock_current_identity(monkeypatch)

    healthy, reason = editor_state_directory_status(
        state, TEST_USER, TEST_GROUP
    )

    assert healthy is True
    assert reason == "ok"
