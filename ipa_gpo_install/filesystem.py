#!/usr/bin/env python3
"""Filesystem provisioning shared by the installer and oddjob handlers."""

import grp
import os
import pwd
import stat
import subprocess
from pathlib import Path

from .config import (
    GPO_EDITOR_GROUP,
    GPO_EDITOR_STATE_DIR,
    GPO_EDITOR_USER,
)


class FilesystemConfigurationError(RuntimeError):
    """Raised when editor storage cannot be provisioned safely."""


def _run_checked(command, runner=subprocess.run):
    result = runner(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "unknown error").strip()
        raise FilesystemConfigurationError(
            "{} failed: {}".format(command[0], detail)
        )


def ensure_editor_state_directory(
    path=GPO_EDITOR_STATE_DIR,
    editor_user=GPO_EDITOR_USER,
    editor_group=GPO_EDITOR_GROUP,
):
    """Create the private state directory without touching existing records."""
    state_path = Path(path)
    if state_path.is_symlink():
        raise FilesystemConfigurationError(
            "editor state path must not be a symbolic link: {}".format(state_path)
        )

    state_path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if state_path.is_symlink() or not state_path.is_dir():
        raise FilesystemConfigurationError(
            "editor state path is not a directory: {}".format(state_path)
        )

    try:
        uid = pwd.getpwnam(editor_user).pw_uid
        gid = grp.getgrnam(editor_group).gr_gid
    except KeyError as exc:
        raise FilesystemConfigurationError(
            "editor identity is not available: {}:{}".format(
                editor_user, editor_group
            )
        ) from exc

    flags = os.O_RDONLY | os.O_DIRECTORY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(state_path, flags)
    try:
        os.fchown(descriptor, uid, gid)
        os.fchmod(descriptor, 0o700)
    finally:
        os.close(descriptor)


def _set_directory_acls(
    directories,
    editor_user,
    access_permissions="rwx",
    default_permissions="rwx",
    runner=subprocess.run,
):
    # Keep argv below ordinary ARG_MAX limits for large policy collections.
    acl = "u:{0}:{1},d:u:{0}:{2}".format(
        editor_user, access_permissions, default_permissions
    )
    for offset in range(0, len(directories), 128):
        batch = directories[offset:offset + 128]
        _run_checked(
            ["setfacl", "-m", acl, "--"] + [str(path) for path in batch],
            runner=runner,
        )


def ensure_directory_editor_acl(
    path,
    editor_user=GPO_EDITOR_USER,
    runner=subprocess.run,
):
    """Grant access and inheritance on one trusted directory."""
    directory = Path(path)
    if directory.is_symlink() or not directory.is_dir():
        raise FilesystemConfigurationError(
            "ACL target is not a real directory: {}".format(directory)
        )
    _set_directory_acls([directory], editor_user, runner=runner)


def ensure_policies_root_acl(
    path,
    editor_user=GPO_EDITOR_USER,
    runner=subprocess.run,
):
    """Keep the editor read-only on Policies while inheriting writable GPOs."""
    policies = Path(path)
    if policies.is_symlink() or not policies.is_dir():
        raise FilesystemConfigurationError(
            "Policies path is not a real directory: {}".format(policies)
        )
    _set_directory_acls(
        [policies],
        editor_user,
        access_permissions="r-x",
        default_permissions="rwx",
        runner=runner,
    )


def ensure_new_gpo_acls(
    policies_path,
    policy_path,
    editor_user=GPO_EDITOR_USER,
    runner=subprocess.run,
):
    """Make a newly created GPO immediately usable by the IPA plugin."""
    ensure_policies_root_acl(
        policies_path, editor_user=editor_user, runner=runner
    )
    policy = Path(policy_path)
    if policy.is_symlink() or not policy.is_dir():
        raise FilesystemConfigurationError(
            "GPO path is not a real directory: {}".format(policy)
        )
    directories = [policy]
    for name in ("Machine", "User"):
        directory = policy / name
        if directory.is_symlink() or not directory.is_dir():
            raise FilesystemConfigurationError(
                "new GPO directory is not a real directory: {}".format(
                    directory
                )
            )
        directories.append(directory)
    _set_directory_acls(directories, editor_user, runner=runner)


def editor_state_directory_status(
    path=GPO_EDITOR_STATE_DIR,
    editor_user=GPO_EDITOR_USER,
    editor_group=GPO_EDITOR_GROUP,
):
    """Return (healthy, reason) for the private publication-state directory."""
    state_path = Path(path)
    try:
        info = state_path.lstat()
        expected_uid = pwd.getpwnam(editor_user).pw_uid
        expected_gid = grp.getgrnam(editor_group).gr_gid
    except (FileNotFoundError, KeyError) as exc:
        return False, str(exc)

    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        return False, "path is not a real directory"
    if stat.S_IMODE(info.st_mode) != 0o700:
        return False, "mode is not 0700"
    if info.st_uid != expected_uid or info.st_gid != expected_gid:
        return False, "owner is not {}:{}".format(editor_user, editor_group)
    return True, "ok"
