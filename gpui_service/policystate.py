import logging

try:
    from .parse_admx_structure import AdmxParser
    from .admx_value_types import reg_type_for_metadata_value, reg_type_for_value_kind
except ImportError:
    from parse_admx_structure import AdmxParser
    from admx_value_types import reg_type_for_metadata_value, reg_type_for_value_kind

logger = logging.getLogger('gpuiservice')

STATE_NOT_CONFIGURED = 'not_configured'
STATE_ENABLED = 'enabled'
STATE_DISABLED = 'disabled'
VALID_STATES = {STATE_NOT_CONFIGURED, STATE_ENABLED, STATE_DISABLED}


class PolicyStateManager:
    """Determines and sets policy state (enabled/disabled/not_configured)."""

    def __init__(self, gpt_worker, data_store):
        self.gpt_worker = gpt_worker
        self.data_store = data_store

    def determine_state(self, name_gpt, target, policy_metadata):
        """
        Determine current policy state from Registry.pol + ADMX metadata.

        Args:
            name_gpt: GPO path (relative to sysvol)
            target: 'Machine' or 'User'
            policy_metadata: dict with policy metadata (header + heavy keys)

        Returns:
            dict with 'state' and 'values' keys
        """
        if self.gpt_worker is None:
            return {'state': STATE_NOT_CONFIGURED, 'values': []}

        policy_type = target or 'Machine'
        header = policy_metadata.get('header', {})
        base_key = header.get('key', '')
        value_name = header.get('valueName', '')

        all_values = self._collect_all_values(
            policy_metadata, name_gpt, policy_type, base_key
        )

        if not all_values:
            return {'state': STATE_NOT_CONFIGURED, 'values': []}

        has_any_data = any(v.get('has_data') for v in all_values)
        if not has_any_data:
            return {'state': STATE_NOT_CONFIGURED, 'values': all_values}

        if self._check_enabled(name_gpt, policy_metadata, all_values, base_key):
            return {'state': STATE_ENABLED, 'values': all_values}

        if self._check_disabled(name_gpt, policy_metadata, all_values, base_key):
            return {'state': STATE_DISABLED, 'values': all_values}

        return {'state': STATE_ENABLED, 'values': all_values}

    def set_state(self, name_gpt, target, policy_metadata, state):
        """
        Atomically set policy state.

        Args:
            name_gpt: GPO path (relative to sysvol)
            target: 'Machine' or 'User'
            policy_metadata: dict with policy metadata
            state: 'enabled', 'disabled', or 'not_configured'

        Returns:
            True if successful, False otherwise
        """
        if self.gpt_worker is None:
            logger.error("GPTWorker not available")
            return False

        if state not in VALID_STATES:
            logger.error(f"Invalid state: {state}")
            return False

        policy_type = target or 'Machine'
        header = policy_metadata.get('header', {})
        base_key = header.get('key', '')
        value_name = header.get('valueName', '')

        try:
            if state == STATE_ENABLED:
                self._set_enabled(name_gpt, policy_type, policy_metadata, base_key, value_name)
            elif state == STATE_DISABLED:
                self._set_disabled(name_gpt, policy_type, policy_metadata, base_key, value_name)
            elif state == STATE_NOT_CONFIGURED:
                self._set_not_configured(name_gpt, policy_type, policy_metadata, base_key, value_name)

            return True
        except Exception as e:
            logger.exception(f"Error setting policy state: {e}")
            return False

    def _collect_all_values(self, policy_metadata, name_gpt, policy_type, base_key):
        values = []
        for key, val in policy_metadata.items():
            if key == 'header':
                continue
            if not isinstance(val, dict) or 'metadata' not in val:
                continue

            meta = val['metadata']
            meta_type = meta.get('type', '')

            if meta_type == 'policyValue':
                vn = meta.get('valueName') or ''
                reg_key = base_key
                if vn:
                    full_path = f"{reg_key}\\{vn}"
                else:
                    full_path = reg_key
                result = self.gpt_worker.get_policy_value(name_gpt, reg_key, vn, policy_type)
                values.append({
                    'path': full_path,
                    'key': reg_key,
                    'valueName': vn,
                    'metadata': meta,
                    'has_data': result is not None,
                    'current_value': result[0] if result else None,
                    'current_type': result[1] if result else None,
                })
            elif meta_type in ('boolean', 'decimal', 'text', 'enum', 'list', 'longDecimal', 'multiText'):
                element_key = meta.get('key', base_key)
                vn = meta.get('valueName', '')
                result = self.gpt_worker.get_policy_value(name_gpt, element_key, vn, policy_type)
                values.append({
                    'path': key,
                    'key': element_key,
                    'valueName': vn,
                    'metadata': meta,
                    'has_data': result is not None,
                    'current_value': result[0] if result else None,
                    'current_type': result[1] if result else None,
                })

        return values

    def _check_enabled(self, name_gpt, policy_metadata, all_values, base_key):
        enabled_value = None
        enabled_list = []

        for key, val in policy_metadata.items():
            if key == 'header':
                continue
            if isinstance(val, dict) and 'metadata' in val:
                meta = val['metadata']
                if meta.get('type') == 'policyValue':
                    enabled_value = meta.get('enabledValue')
                    enabled_list = meta.get('enabledList', [])

        if enabled_value is not None:
            for v in all_values:
                if v.get('has_data') and v['metadata'].get('type') == 'policyValue':
                    if self._compare_values(v['current_value'], enabled_value):
                        return True

        if enabled_list:
            matched = 0
            for item in enabled_list:
                item_key = item.get('key') or base_key
                item_vn = item.get('valueName', '')
                result = self.gpt_worker.get_policy_value(
                    name_gpt, item_key, item_vn,
                    all_values[0].get('policy_type', 'Machine') if all_values else 'Machine'
                )
                if result is not None and self._compare_values(result[0], item.get('value')):
                    matched += 1
            if matched > 0 and matched == len(enabled_list):
                return True

        has_data_count = sum(1 for v in all_values if v.get('has_data'))
        if has_data_count > 0:
            return True

        return False

    def _check_disabled(self, name_gpt, policy_metadata, all_values, base_key):
        disabled_value = None
        disabled_list = []

        for key, val in policy_metadata.items():
            if key == 'header':
                continue
            if isinstance(val, dict) and 'metadata' in val:
                meta = val['metadata']
                if meta.get('type') == 'policyValue':
                    disabled_value = meta.get('disabledValue')
                    disabled_list = meta.get('disabledList', [])

        if disabled_value is not None:
            for v in all_values:
                if v.get('has_data') and v['metadata'].get('type') == 'policyValue':
                    if self._compare_values(v['current_value'], disabled_value):
                        return True

        if disabled_list:
            matched = 0
            for item in disabled_list:
                item_key = item.get('key') or base_key
                item_vn = item.get('valueName', '')
                result = self.gpt_worker.get_policy_value(
                    name_gpt, item_key, item_vn,
                    all_values[0].get('policy_type', 'Machine') if all_values else 'Machine'
                )
                if result is not None and self._compare_values(result[0], item.get('value')):
                    matched += 1
            if matched > 0:
                return True

        return False

    def _set_enabled(self, name_gpt, policy_type, policy_metadata, base_key, value_name):
        meta = self._get_policy_value_meta(policy_metadata)

        if meta:
            enabled_value = meta.get('enabledValue')
            enabled_list = meta.get('enabledList', [])
            disabled_list = meta.get('disabledList', [])

            if enabled_value is not None:
                vn = meta.get('valueName') or value_name or ''
                reg_type = self._meta_type_to_reg_type(meta, enabled_value)
                self.gpt_worker.update_policy_value(
                    name_gpt, base_key, vn, enabled_value, reg_type, policy_type
                )
            elif value_name:
                self.gpt_worker.update_policy_value(
                    name_gpt, base_key, value_name, 1, 'REG_DWORD', policy_type
                )

            for item in enabled_list:
                item_key = item.get('key') or base_key
                item_vn = item.get('valueName', '')
                item_val = item.get('value')
                item_type = reg_type_for_value_kind(
                    item.get('valueKind'),
                    self._infer_reg_type(item_val)
                )
                self.gpt_worker.update_policy_value(
                    name_gpt, item_key, item_vn, item_val, item_type, policy_type
                )

            for item in disabled_list:
                item_key = item.get('key') or base_key
                item_vn = item.get('valueName', '')
                try:
                    self.gpt_worker.delete_policy_value(name_gpt, item_key, item_vn, policy_type)
                except Exception:
                    logger.debug("Failed to delete disabled_list entry %s\\%s", item_key, item_vn)

        for key, val in policy_metadata.items():
            if key == 'header':
                continue
            if not isinstance(val, dict) or 'metadata' not in val:
                continue
            m = val['metadata']
            mtype = m.get('type', '')
            if mtype == 'policyValue':
                continue
            element_key = m.get('key', base_key)
            vn = m.get('valueName', '')
            default_val = self._get_element_default(m)
            reg_type = self._meta_type_to_reg_type(m, default_val)
            if default_val is not None and vn:
                self.gpt_worker.update_policy_value(
                    name_gpt, element_key, vn, default_val, reg_type, policy_type
                )

    def _set_disabled(self, name_gpt, policy_type, policy_metadata, base_key, value_name):
        meta = self._get_policy_value_meta(policy_metadata)

        if meta:
            disabled_value = meta.get('disabledValue')
            disabled_list = meta.get('disabledList', [])
            enabled_list = meta.get('enabledList', [])

            if disabled_value is not None:
                vn = meta.get('valueName') or value_name or ''
                reg_type = self._meta_type_to_reg_type(meta, disabled_value)
                self.gpt_worker.update_policy_value(
                    name_gpt, base_key, vn, disabled_value, reg_type, policy_type
                )
            elif value_name:
                self.gpt_worker.update_policy_value(
                    name_gpt, base_key, value_name, 0, 'REG_DWORD', policy_type
                )

            for item in disabled_list:
                item_key = item.get('key') or base_key
                item_vn = item.get('valueName', '')
                item_val = item.get('value')
                item_type = reg_type_for_value_kind(
                    item.get('valueKind'),
                    self._infer_reg_type(item_val)
                )
                self.gpt_worker.update_policy_value(
                    name_gpt, item_key, item_vn, item_val, item_type, policy_type
                )

            for item in enabled_list:
                item_key = item.get('key') or base_key
                item_vn = item.get('valueName', '')
                try:
                    self.gpt_worker.delete_policy_value(name_gpt, item_key, item_vn, policy_type)
                except Exception:
                    logger.debug("Failed to delete enabled_list entry %s\\%s", item_key, item_vn)

        for key, val in policy_metadata.items():
            if key == 'header':
                continue
            if not isinstance(val, dict) or 'metadata' not in val:
                continue
            m = val['metadata']
            mtype = m.get('type', '')
            if mtype == 'policyValue':
                continue
            element_key = m.get('key', base_key)
            vn = m.get('valueName', '')
            if vn:
                try:
                    self.gpt_worker.delete_policy_value(name_gpt, element_key, vn, policy_type)
                except Exception:
                    logger.debug("Failed to delete element %s\\%s", element_key, vn)

    def _set_not_configured(self, name_gpt, policy_type, policy_metadata, base_key, value_name):
        meta = self._get_policy_value_meta(policy_metadata)

        if meta:
            vn = meta.get('valueName') or value_name or ''
            if vn:
                try:
                    self.gpt_worker.delete_policy_value(name_gpt, base_key, vn, policy_type)
                except Exception:
                    logger.debug("Failed to delete policyValue %s\\%s", base_key, vn)

            for item in meta.get('enabledList', []) + meta.get('disabledList', []):
                item_key = item.get('key') or base_key
                item_vn = item.get('valueName', '')
                if item_vn:
                    try:
                        self.gpt_worker.delete_policy_value(name_gpt, item_key, item_vn, policy_type)
                    except Exception:
                        logger.debug("Failed to delete list entry %s\\%s", item_key, item_vn)

        for key, val in policy_metadata.items():
            if key == 'header':
                continue
            if not isinstance(val, dict) or 'metadata' not in val:
                continue
            m = val['metadata']
            mtype = m.get('type', '')
            if mtype == 'policyValue':
                continue
            element_key = m.get('key', base_key)
            vn = m.get('valueName', '')
            if vn:
                try:
                    self.gpt_worker.delete_policy_value(name_gpt, element_key, vn, policy_type)
                except Exception:
                    logger.debug("Failed to delete element %s\\%s", element_key, vn)
            if mtype == 'list':
                list_key = m.get('key', element_key)
                if list_key:
                    try:
                        existing = self.gpt_worker.read_pol_file(name_gpt, policy_type)
                    except Exception:
                        existing = {}
                    for ek, evs in existing.items():
                        if ek.startswith(list_key):
                            for evn in list(evs.keys()):
                                try:
                                    self.gpt_worker.delete_policy_value(name_gpt, ek, evn, policy_type)
                                except Exception:
                                    logger.debug("Failed to delete list value %s\\%s", ek, evn)

    @staticmethod
    def _get_policy_value_meta(policy_metadata):
        for key, val in policy_metadata.items():
            if key == 'header':
                continue
            if isinstance(val, dict) and 'metadata' in val:
                if val['metadata'].get('type') == 'policyValue':
                    return val['metadata']
        return None

    @staticmethod
    def _compare_values(actual, expected):
        if actual is None and expected is None:
            return True
        if actual is None or expected is None:
            return False
        try:
            return int(actual) == int(expected)
        except (ValueError, TypeError):
            pass
        return str(actual) == str(expected)

    @staticmethod
    def _infer_reg_type(value):
        if isinstance(value, int):
            return 'REG_DWORD'
        return 'REG_SZ'

    @staticmethod
    def _meta_type_to_reg_type(meta, value=None):
        return reg_type_for_metadata_value(meta, value, 'REG_SZ')

    @staticmethod
    def _get_element_default(meta):
        mtype = meta.get('type', '')
        if mtype == 'boolean':
            return meta.get('trueValue', 1)
        if mtype == 'decimal':
            return meta.get('defaultValue', 0)
        if mtype == 'text':
            return meta.get('defaultValue', '')
        if mtype == 'enum':
            return ''
        return None
