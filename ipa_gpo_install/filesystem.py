#!/usr/bin/env python3
"""Filesystem provisioning shared by the installer and oddjob handlers."""

import grp
import os
import pwd
import shutil
import stat
import subprocess
from pathlib import Path

from .config import (
    GPO_EDITOR_GROUP,
    GPO_EDITOR_STATE_DIR,
    GPO_EDITOR_USER,
    TARGET_PYTHON_PLUGINS,
)


class FilesystemConfigurationError(RuntimeError):
    """Raised when editor storage cannot be provisioned safely."""


LEGACY_EDITOR_RETIREMENT_MARKER = ".gpo-editor-libadmix-migration-v1"


def _retirement_marker(var_root):
    return (
        Path(var_root)
        / "lib/freeipa"
        / LEGACY_EDITOR_RETIREMENT_MARKER
    )


def _write_retirement_marker(path):
    """Create the completed-migration marker with exact private permissions."""
    descriptor = None
    created = False
    try:
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        descriptor = os.open(path, flags, 0o600)
        created = True
        os.fchmod(descriptor, 0o600)
    except OSError as exc:
        if created:
            path.unlink(missing_ok=True)
        raise FilesystemConfigurationError(
            "cannot record completed legacy editor retirement: {}".format(exc)
        ) from exc
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _legacy_runtime_paths(prefix, etc_root, var_root, python_sitelib):
    prefix_path = Path(prefix)
    etc_path = Path(etc_root)
    var_path = Path(var_root)
    site_path = Path(python_sitelib)
    return [
        site_path / "gpui_service",
        site_path / "ipaclient/plugins/gpo_client.py",
        prefix_path / "sbin/gpuiservice",
        prefix_path / "bin/ipa-gpo-update-paths",
        prefix_path / "lib/systemd/system/gpuiservice.service",
        etc_path / "systemd/system/gpuiservice.service.d",
        etc_path / "systemd/system/multi-user.target.wants/gpuiservice.service",
        etc_path / "dbus-1/system.d/org.altlinux.gpuiservice.conf",
        etc_path / "gpuiservice",
        var_path / "lib/gpuiservice",
        prefix_path / "share/dbus-1/system-services/org.altlinux.gpuiservice.service",
        prefix_path / "share/glib-2.0/schemas/org.altlinux.gpuiservice.gschema.xml",
    ]


def _remove_legacy_path(path):
    if path.is_symlink() or path.is_file():
        path.unlink()
        return True
    if path.is_dir():
        shutil.rmtree(path)
        return True
    return False


def retire_legacy_editor_runtime(
    prefix="/usr",
    etc_root="/etc",
    var_root="/var",
    python_sitelib=None,
    runner=subprocess.run,
    manage_services=True,
    rebuild_schema_cache=False,
    manage_retirement_marker=True,
):
    """Stop and remove artifacts left by pre-libadmix package versions.

    This is an upgrade migration, not a continuing service lifecycle. Repeated
    calls are safe and the private libadmix publication state is intentionally
    outside the removal list.
    """
    retirement_marker = None
    if manage_retirement_marker:
        retirement_marker = _retirement_marker(var_root)
        if retirement_marker.exists():
            return []

    if python_sitelib is None:
        python_sitelib = Path(TARGET_PYTHON_PLUGINS).parents[1]

    legacy_paths = _legacy_runtime_paths(
        prefix, etc_root, var_root, python_sitelib
    )
    pycache = Path(python_sitelib) / "ipaclient/plugins/__pycache__"
    cached_paths = []
    if pycache.is_dir() and not pycache.is_symlink():
        cached_paths = list(pycache.glob("gpo_client.*"))

    has_legacy_artifacts = any(
        path.is_symlink() or path.exists()
        for path in legacy_paths + cached_paths
    )

    legacy_schema = (
        Path(prefix)
        / "share/glib-2.0/schemas/org.altlinux.gpuiservice.gschema.xml"
    )
    schema_compiler = None
    schema_directory = legacy_schema.parent
    if (
        legacy_schema.is_file()
        or legacy_schema.is_symlink()
        or rebuild_schema_cache
    ):
        schema_compiler = shutil.which("glib-compile-schemas")
        if not schema_compiler or not schema_directory.is_dir():
            raise FilesystemConfigurationError(
                "cannot rebuild the GLib schema cache before retiring the "
                "legacy editor schema"
            )

    systemctl = shutil.which("systemctl") if manage_services else None
    loaded_service_active = False
    if systemctl and not has_legacy_artifacts:
        active = runner(
            [systemctl, "is-active", "gpuiservice.service"],
            capture_output=True,
            text=True,
            check=False,
        )
        loaded_service_active = active.returncode == 0

    if (
        not has_legacy_artifacts
        and not loaded_service_active
        and not rebuild_schema_cache
    ):
        if retirement_marker is not None:
            _write_retirement_marker(retirement_marker)
        return []

    service_cleanup_needed = bool(
        systemctl and (has_legacy_artifacts or loaded_service_active)
    )
    if service_cleanup_needed:
        # A missing unit is the expected steady state, so failure here is not
        # fatal. We verify below that no old process remains active.
        for action in ("stop", "disable"):
            runner(
                [systemctl, action, "gpuiservice.service"],
                capture_output=True,
                text=True,
                check=False,
            )

    removed = []
    schema_removed = False
    for path in legacy_paths:
        if _remove_legacy_path(path):
            removed.append(str(path))
            if path.name == "org.altlinux.gpuiservice.gschema.xml":
                schema_removed = True

    for cached in cached_paths:
        if _remove_legacy_path(cached):
            removed.append(str(cached))

    if schema_removed or rebuild_schema_cache:
        _run_checked(
            [schema_compiler, str(schema_directory)], runner=runner
        )

    if service_cleanup_needed:
        _run_checked([systemctl, "daemon-reload"], runner=runner)
        active = runner(
            [systemctl, "is-active", "gpuiservice.service"],
            capture_output=True,
            text=True,
            check=False,
        )
        if active.returncode == 0:
            raise FilesystemConfigurationError(
                "legacy editor service is still active after cleanup"
            )

    if retirement_marker is not None:
        _write_retirement_marker(retirement_marker)

    return removed


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


def _directory_paths(root):
    """Return real directories beneath root without following symlinks."""
    directories = [Path(root)]
    for current, child_dirs, _files in os.walk(root, followlinks=False):
        current_path = Path(current)
        retained = []
        for name in child_dirs:
            child = current_path / name
            if child.is_symlink():
                continue
            retained.append(name)
            directories.append(child)
        child_dirs[:] = retained
    return directories


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


def migrate_gpo_tree_acls(
    policy_path,
    editor_user=GPO_EDITOR_USER,
    runner=subprocess.run,
):
    """Grant editor access and inheritance inside one existing GPO tree."""
    policy = Path(policy_path)
    if policy.is_symlink() or not policy.is_dir():
        raise FilesystemConfigurationError(
            "GPO path is not a real directory: {}".format(policy)
        )

    # X grants traversal to directories without making ordinary payload files
    # executable. -P prevents a pre-existing symlink from escaping the tree.
    _run_checked(
        [
            "setfacl", "-R", "-P", "-m",
            "u:{}:rwX".format(editor_user), "--", str(policy),
        ],
        runner=runner,
    )
    _set_directory_acls(
        _directory_paths(policy), editor_user, runner=runner
    )


def migrate_policies_acls(
    policies_path,
    editor_user=GPO_EDITOR_USER,
    runner=subprocess.run,
):
    """Idempotently grant ipaapi access to an existing Policies tree."""
    policies = Path(policies_path)
    if policies.is_symlink() or not policies.is_dir():
        raise FilesystemConfigurationError(
            "Policies path is not a real directory: {}".format(policies)
        )

    ensure_policies_root_acl(
        policies, editor_user=editor_user, runner=runner
    )
    for policy in sorted(policies.iterdir()):
        if policy.is_dir() and not policy.is_symlink():
            migrate_gpo_tree_acls(
                policy, editor_user=editor_user, runner=runner
            )


def ensure_new_gpo_acls(
    policies_path,
    policy_path,
    editor_user=GPO_EDITOR_USER,
    runner=subprocess.run,
):
    """Make a newly root-created GPO immediately usable by the IPA plugin."""
    ensure_policies_root_acl(
        policies_path, editor_user=editor_user, runner=runner
    )
    migrate_gpo_tree_acls(
        policy_path, editor_user=editor_user, runner=runner
    )


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
