"""Unit tests for installer command-line option parsing."""

from types import SimpleNamespace
from unittest.mock import MagicMock, call

from ipa_gpo_install import cli


def test_parse_options_configures_parser_and_returns_safe_options(monkeypatch):
    options = SimpleNamespace(debuglevel=2, check_only=True)
    safe_options = {"debuglevel": 2, "check_only": True}
    parser = MagicMock()
    parser.parse_args.return_value = (options, ["ignored-positional"])
    parser.get_safe_opts.return_value = safe_options
    parser_factory = MagicMock(return_value=parser)
    cleanup = MagicMock()
    argv = ["ipa-gpo-install", "--debuglevel", "2", "--check-only"]

    monkeypatch.setattr(cli, "IPAOptionParser", parser_factory)
    monkeypatch.setattr(cli, "admin_cleanup_global_argv", cleanup)
    monkeypatch.setattr(cli.sys, "argv", argv)
    monkeypatch.setattr(cli, "_", lambda text: text)

    result = cli.parse_options()

    assert result == (safe_options, options)
    parser_factory.assert_called_once_with(version=cli.__version__)
    assert parser.add_option.call_args_list == [
        call(
            "--debuglevel",
            type="int",
            dest="debuglevel",
            default=0,
            metavar="LEVEL",
            help="Debug level: 0=errors, 1=warnings, 2=debug",
        ),
        call(
            "--check-only",
            dest="check_only",
            action="store_true",
            default=False,
            help="Only perform checks without making changes",
        ),
    ]
    parser.parse_args.assert_called_once_with()
    parser.get_safe_opts.assert_called_once_with(options)
    cleanup.assert_called_once_with(parser, options, argv)
