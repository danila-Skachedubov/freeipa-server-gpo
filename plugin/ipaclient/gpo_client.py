# Authors: GPO Plugin Client-side overrides
#
# This module provides CLI output formatting for GPO commands.
# It overrides the dynamically generated client-side classes
# that are built from server schema, adding custom output_for_cli methods.

import logging

from ipalib.plugable import Registry
from ipalib.text import _

logger = logging.getLogger(__name__)

register = Registry()


def _get_base_class(name):
    """
    Safely retrieve a base command class from ipaserver plugins.
    Returns None if not available (e.g. on a pure client without ipaserver).
    """
    try:
        from ipaserver.plugins import gpo as _gpo_module
        return getattr(_gpo_module, name, None)
    except ImportError:
        return None


# ---------------------------------------------------------------------------
# gpo_get_policy
# ---------------------------------------------------------------------------

_base_get_policy = _get_base_class('gpo_get_policy')
if _base_get_policy is not None:
    @register(override=True, no_fail=True)
    class gpo_get_policy(_base_get_policy):
        def output_for_cli(self, textui, output, *args, **options):
            """
            Print policy value as formatted key:value pairs.
            Summary already contains the formatted content for policy entries.
            """
            summary = output.get('summary', '')
            if summary:
                textui.print_plain(summary)
            return 0


# ---------------------------------------------------------------------------
# gpo_list_children
# ---------------------------------------------------------------------------

_base_list_children = _get_base_class('gpo_list_children')
if _base_list_children is not None:
    @register(override=True, no_fail=True)
    class gpo_list_children(_base_list_children):
        def output_for_cli(self, textui, output, *args, **options):
            """
            Print summary line followed by child policy names, one per line.
            """
            summary = output.get('summary', '')
            if summary:
                textui.print_summary(summary)

            for entry in output.get('result', []):
                if isinstance(entry, dict):
                    name = entry.get('name')
                else:
                    name = str(entry)
                if name:
                    textui.print_plain(str(name))

            return 0


# ---------------------------------------------------------------------------
# gpo_set_policy
# ---------------------------------------------------------------------------

_base_set_policy = _get_base_class('gpo_set_policy')
if _base_set_policy is not None:
    @register(override=True, no_fail=True)
    class gpo_set_policy(_base_set_policy):
        def output_for_cli(self, textui, output, *args, **options):
            """
            Print operation result: success or failure message.
            """
            summary = output.get('summary', '')
            if summary:
                textui.print_summary(summary)
            return 0


# ---------------------------------------------------------------------------
# gpo_get_current_value
# ---------------------------------------------------------------------------

_base_get_current_value = _get_base_class('gpo_get_current_value')
if _base_get_current_value is not None:
    @register(override=True, no_fail=True)
    class gpo_get_current_value(_base_get_current_value):
        def output_for_cli(self, textui, output, *args, **options):
            """
            Print current registry value with type information.
            """
            result = output.get('result', {})
            if result and isinstance(result, dict):
                value_data = result.get('value_data', '')
                value_type = result.get('value_type', '')
                if value_data is not None:
                    textui.print_plain('Value: %s' % value_data)
                if value_type:
                    textui.print_plain('Type:  %s' % value_type)
            else:
                summary = output.get('summary', '')
                if summary:
                    textui.print_summary(summary)
            return 0