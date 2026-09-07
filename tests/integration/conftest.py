"""Require a real, complete integration run when this suite gates a release."""

import os

import pytest


def pytest_sessionfinish(session, exitstatus):
    if os.environ.get("FREEIPA_GPO_REQUIRE_TESTS") != "1" or exitstatus != 0:
        return
    reporter = session.config.pluginmanager.get_plugin("terminalreporter")
    if reporter is None or not reporter.stats.get("passed") or any(
        reporter.stats.get(outcome) for outcome in ("skipped", "xfailed", "xpassed")
    ):
        session.exitstatus = pytest.ExitCode.TESTS_FAILED
        if reporter is not None:
            reporter.write_sep("=", "CI requires passing integration tests without skips or xfails")
