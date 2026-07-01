#
# gpuiservice - GPT Directory Management API Service
#
# Copyright (C) 2025-2026 BaseALT Ltd.
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
"""Helpers for mapping ADMX value kinds to Registry.pol value types."""

VALUE_KIND_TO_REG_TYPE = {
    'string': 'REG_SZ',
    'decimal': 'REG_DWORD',
    'longDecimal': 'REG_QWORD',
    'multiText': 'REG_MULTI_SZ',
    'list': 'REG_MULTI_SZ',
}

META_TYPE_TO_REG_TYPE = {
    'text': 'REG_SZ',
    'decimal': 'REG_DWORD',
    'boolean': 'REG_DWORD',
    'list': 'REG_MULTI_SZ',
    'multiText': 'REG_MULTI_SZ',
    'policyValue': 'REG_DWORD',
    'longDecimal': 'REG_QWORD',
}


def normalize_value_kind(value_kind):
    """Return a supported ADMX value kind or None."""
    if not value_kind:
        return None
    value_kind = str(value_kind)
    return value_kind if value_kind in VALUE_KIND_TO_REG_TYPE else None


def reg_type_for_value_kind(value_kind, default='REG_SZ'):
    """Map an ADMX value kind to a Registry.pol type."""
    normalized = normalize_value_kind(value_kind)
    if not normalized:
        return default
    return VALUE_KIND_TO_REG_TYPE.get(normalized, default)


def _kind_for_enum_value(meta, value):
    value_kinds = meta.get('itemValueKinds')
    if not isinstance(value_kinds, dict):
        return None

    candidates = [value, str(value)]
    try:
        candidates.append(str(int(value)))
    except (TypeError, ValueError):
        pass

    for candidate in candidates:
        if candidate in value_kinds:
            return value_kinds[candidate]
    return None


def _kind_for_boolean_value(meta, value):
    if value == meta.get('trueValue') or str(value) == str(meta.get('trueValue')):
        return meta.get('trueValueKind')
    if value == meta.get('falseValue') or str(value) == str(meta.get('falseValue')):
        return meta.get('falseValueKind')
    return None


def _kind_for_policy_value(meta, value):
    if value == meta.get('enabledValue') or str(value) == str(meta.get('enabledValue')):
        return meta.get('enabledValueKind')
    if value == meta.get('disabledValue') or str(value) == str(meta.get('disabledValue')):
        return meta.get('disabledValueKind')
    return None


def reg_type_for_metadata_value(meta, value=None, default='REG_SZ'):
    """Resolve Registry.pol type from ADMX metadata and the value being written."""
    if not isinstance(meta, dict):
        return default

    meta_type = meta.get('type', '')
    if meta_type == 'enum':
        value_kind = _kind_for_enum_value(meta, value)
        if value_kind:
            return reg_type_for_value_kind(value_kind, default)
        return default

    if meta_type == 'boolean':
        value_kind = _kind_for_boolean_value(meta, value)
        if value_kind:
            return reg_type_for_value_kind(value_kind, default)

    if meta_type == 'policyValue':
        value_kind = _kind_for_policy_value(meta, value)
        if value_kind:
            return reg_type_for_value_kind(value_kind, default)

    value_kind = meta.get('valueKind')
    if value_kind:
        return reg_type_for_value_kind(value_kind, default)

    return META_TYPE_TO_REG_TYPE.get(meta_type, default)
