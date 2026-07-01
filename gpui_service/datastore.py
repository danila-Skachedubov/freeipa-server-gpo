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
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program.  If not, see <http://www.gnu.org/licenses/>.
"""
GPODataStore - Storage for ADMX policy data loaded from directory
"""

import threading
from pathlib import Path
import logging
import json
import ast
import locale as locale_module
from typing import Any, Optional, Union

try:
    from .parse_admx_structure import AdmxParser
    from .admx_value_types import reg_type_for_metadata_value
    from . import utils
    from .config import set_locale as gsettings_set_locale
    from .config import DEFAULT_SYSVOL_PATH, DEFAULT_MONITOR_PATH, SUPPORTED_LOCALES
    from .admxnavigator import ADMXNavigator
except ImportError:
    from parse_admx_structure import AdmxParser
    from admx_value_types import reg_type_for_metadata_value
    import utils
    from config import set_locale as gsettings_set_locale
    from config import DEFAULT_SYSVOL_PATH, DEFAULT_MONITOR_PATH, SUPPORTED_LOCALES
    from admxnavigator import ADMXNavigator

logger = logging.getLogger('gpuiservice')



class GPODataStore:
    """Storage for ADMX policy data loaded from directory"""

    def __init__(self, sysvol_path=DEFAULT_SYSVOL_PATH):
        self._navigator = ADMXNavigator()
        self.lock = threading.RLock()
        self.sysvol_path = sysvol_path
        self.locale = self.get_system_locale()
        self.monitor_path = None
        self.gpt_worker = None
        self.gpprefs_worker = None
        self.policy_state_manager = None
        self._gpo_display_names: dict[str, str] = {}
        try:
            try:
                from .gptworker import GPTWorker
            except ImportError:
                from gptworker import GPTWorker
            self.gpt_worker = GPTWorker(sysvol_path)
            logger.debug(f"GPTWorker initialized with sysvol path: {sysvol_path}")
        except ImportError as exp:
            logger.warning(f"GPTWorker not available: {exp}")
            logger.warning("GPO policy file operations will be limited")

        try:
            try:
                from .gpprefs import GPPrefsWorker
            except ImportError:
                from gpprefs import GPPrefsWorker
            self.gpprefs_worker = GPPrefsWorker(sysvol_path)
            logger.debug(f"GPPrefsWorker initialized with sysvol path: {sysvol_path}")
        except ImportError as exp:
            logger.warning(f"GPPrefsWorker not available: {exp}")
            logger.warning("Group Policy Preferences operations will be limited")

        try:
            try:
                from .policystate import PolicyStateManager
            except ImportError:
                from policystate import PolicyStateManager
            self.policy_state_manager = PolicyStateManager(self.gpt_worker, self)
            logger.debug("PolicyStateManager initialized")
        except ImportError as exp:
            logger.warning(f"PolicyStateManager not available: {exp}")

        self.scripts_worker = None
        try:
            try:
                from .scriptsworker import ScriptsWorker
            except ImportError:
                from scriptsworker import ScriptsWorker
            self.scripts_worker = ScriptsWorker(sysvol_path)
            logger.debug("ScriptsWorker initialized")
        except ImportError as exp:
            logger.warning(f"ScriptsWorker not available: {exp}")

        self.comments_worker = None
        try:
            try:
                from .commentsworker import CommentsWorker
            except ImportError:
                from commentsworker import CommentsWorker
            self.comments_worker = CommentsWorker(sysvol_path)
            logger.debug("CommentsWorker initialized")
        except ImportError as exp:
            logger.warning(f"CommentsWorker not available: {exp}")

    @property
    def data(self):
        return self._navigator.data

    @data.setter
    def data(self, value):
        self._navigator.data = value

    @staticmethod
    def _split_key_value_name(key_path):
        """Split 'key\\value_name' into (key_path, value_name).

        If key_path has only one component, returns (key_path, '').
        """
        parts = key_path.split('\\')
        if len(parts) > 1 and parts[-1].strip():
            return '\\'.join(parts[:-1]), parts[-1]
        return key_path, ''

    def get_system_locale(self) -> str:
        """
        Get system locale in ADMX format (e.g., 'ru-RU', 'en-US').

        Returns:
            System locale string in ADMX format.
        """
        try:
            loc, _ = locale_module.getlocale()
            if loc:
                normalized = loc.split('.')[0].replace('_', '-')
                if normalized in SUPPORTED_LOCALES:
                    return normalized
                lang = normalized.split('-')[0].lower()
                locale_map = {'ru': 'ru-RU', 'en': 'en-US'}
                if lang in locale_map:
                    return locale_map[lang]
        except Exception as e:
            logger.debug(f"Could not get system locale: {e}")
        return 'en-US'

    def normalize_locale(self, locale_str: str) -> str:
        """
        Normalize locale string to ADMX format.

        Accepts various formats:
        - 'ru_RU.UTF-8' -> 'ru-RU'
        - 'ru-RU' -> 'ru-RU'
        - 'ru' -> 'ru-RU'
        - 'en' -> 'en-US'

        Args:
            locale_str: Locale string in any format.

        Returns:
            Normalized locale string in ADMX format.
        """
        if not locale_str:
            return self.get_system_locale()

        normalized = locale_str.split('.')[0].replace('_', '-')

        if normalized in SUPPORTED_LOCALES:
            return normalized

        lang = normalized.split('-')[0].lower()
        locale_map = {
            'ru': 'ru-RU',
            'en': 'en-US',
        }
        if lang in locale_map:
            return locale_map[lang]

        logger.warning(f"Unsupported locale '{locale_str}', falling back to en-US")
        return 'en-US'

    def load_from_directory(self, directory_path=DEFAULT_MONITOR_PATH, locale: str = None):
        """
        Load ADMX policy definitions from directory with specified locale.

        Args:
            directory_path: Path to directory containing ADMX files.
            locale: Locale for ADML parsing. If None, uses current locale.
        """
        with self.lock:
            if locale is None:
                locale = self.locale
            self.monitor_path = directory_path
            self.locale = self.normalize_locale(locale)
            logger.info(f"Loading ADMX data from {directory_path} with locale {self.locale}")
            self.data = AdmxParser.build_result_for_dir(directory_path, self.locale)

    def set_locale(self, locale: str) -> bool:
        """
        Set locale and reload ADMX data.

        Args:
            locale: Locale string (e.g., 'ru-RU', 'en-US', 'ru_RU.UTF-8')

        Returns:
            True if successful, False otherwise.
        """
        with self.lock:
            normalized = self.normalize_locale(locale)

            if normalized == self.locale and self.data:
                logger.info(f"Locale already set to {normalized}")
                return True

            AdmxParser.clear_cache()

            gsettings_set_locale(normalized)

            if self.monitor_path:
                self.load_from_directory(self.monitor_path, normalized)
                logger.info(f"Locale changed to {normalized}, data reloaded")
            else:
                self.locale = normalized
                logger.info(f"Locale set to {normalized}, will be used on next load")

        return True

    def get(self, path: str) -> Union[dict, list, str, int, None]:
        """
        Get value by path.

        Args:
            path: Path to retrieve (e.g., "Machine/categories/System")

        Returns:
            Value at path, or None if not found.
        """
        with self.lock:
            current, remaining, found = self._navigator._navigate_path(path)
            if not found:
                return None

            if not remaining:
                return current

            if len(remaining) == 1:
                part = remaining[0]
                if isinstance(current, dict):
                    # Direct key lookup
                    if part in current:
                        return current[part]
                    # Search by displayName in values (for policies)
                    for key, value in current.items():
                        if isinstance(value, dict) and value.get("displayName") == part:
                            return value
                    return None
                if isinstance(current, list):
                    for item in current:
                        if isinstance(item, dict):
                            if item.get("id") == part or item.get("displayName") == part:
                                return item
            return None

    def _find_metadata_by_storage_path(self, storage_path: str):
        """Find a wrapped heavy-key metadata entry by its registry storage path."""
        if not storage_path:
            return None

        normalized_path = AdmxParser.normalize_registry_key(storage_path)

        def walk(node):
            if isinstance(node, dict):
                direct = node.get(normalized_path)
                if isinstance(direct, dict) and isinstance(direct.get('metadata'), dict):
                    return direct

                for value in node.values():
                    found = walk(value)
                    if found is not None:
                        return found
            elif isinstance(node, list):
                for item in node:
                    found = walk(item)
                    if found is not None:
                        return found
            return None

        return walk(self.data)


    def set(self, path, value, name_gpt, target=None, metadata=None):
        """Set value by path

        Args:
            path: Registry key path (e.g., 'Software\\BaseALT\\Policies\\GPUpdate')
            value: Value to set - can be raw data or dict with fields:
                value_name, value_data, value_type, policy_type
            name_gpt: GPO path (relative to sysvol). Required.
            target: Policy type ('Machine' or 'User'). If None, uses policy_type from value dict or 'Machine'.
            metadata: Optional ADMX metadata path (string). If provided, used instead of extracting from value dict.

        Returns:
            True if successful, False otherwise
        """
        with self.lock:
            return self._set_unlocked(path, value, name_gpt, target, metadata)

    def _set_unlocked(self, path, value, name_gpt, target=None, metadata=None):
        val_repr = repr(value)
        if len(val_repr) > 100:
            val_repr = val_repr[:100] + '...'
        logger.info(f"set called: path={repr(path)}, value={val_repr}, name_gpt={repr(name_gpt)}, target={repr(target)}, metadata={repr(metadata)}")
        if self.gpt_worker is None:
            logger.error("GPTWorker not available, cannot write .pol file")
            return False

        if not name_gpt:
            logger.error("name_gpt parameter is required")
            return False

        # Convert path to registry key format and normalize backslashes
        key_path = AdmxParser.normalize_registry_key(path)

        # Convert DBus types to native Python types
        if hasattr(value, '__class__') and value.__class__.__module__.startswith('dbus'):
            value = str(value)
        # Strip trailing commas that may be introduced by DBus argument parsing
        if isinstance(value, str) and value.endswith(','):
            value = value.rstrip(',')

        # Try to parse value as JSON string to support complex values
        parsed_value = value
        if isinstance(value, str):
            # Limit size to prevent resource exhaustion
            if len(value) > 1024 * 1024:  # 1 MB limit
                parsed_value = value
            else:
                try:
                    parsed_value = json.loads(value)
                except (json.JSONDecodeError, ValueError):
                    # Try Python literal eval for Python-style dict syntax
                    # ast.literal_eval is safe for literals only (no code execution)
                    try:
                        if value.strip().startswith('{') and value.strip().endswith('}'):
                            parsed_value = ast.literal_eval(value)
                        else:
                            parsed_value = value  # Keep as string
                    except (SyntaxError, ValueError, MemoryError):
                        parsed_value = value  # Keep as string

        # Determine policy_type: target parameter overrides value dict
        policy_type = 'Machine'  # default
        if isinstance(parsed_value, dict) and target is None:
            # Use policy_type from value dict if target not provided
            policy_type = parsed_value.get('policy_type', policy_type)
        elif target is not None:
            # Use explicit target parameter
            policy_type = target

        value_name = ''

        value_data = ''
        value_type = 'REG_SZ'

        # Determine metadata path: use provided metadata parameter if present
        metadata_path = None
        if metadata and metadata.strip():
            metadata_path = metadata
        elif isinstance(parsed_value, dict):
            # Fallback to metadata_path from value dict
            metadata_path = parsed_value.get('metadata_path') or parsed_value.get('metadata')

        metadata_obj = None
        heavy_meta = None
        if metadata_path:
            metadata_obj = self.get(metadata_path)
            if metadata_obj is None:
                metadata_obj = self._find_metadata_by_storage_path(metadata_path)
            logger.debug(f"metadata_path={metadata_path}, metadata_obj={metadata_obj}")
            if isinstance(metadata_obj, dict):
                # Extract valueName and type from metadata
                header = metadata_obj.get('header', {})
                if isinstance(header, dict):
                    meta_value_name = header.get('valueName')
                    if meta_value_name is not None:
                        value_name = meta_value_name
                # Try to find heavy key metadata
                heavy_meta = None
                header_value_name = header.get('valueName') if isinstance(header, dict) else None
                header_key = header.get('key') if isinstance(header, dict) else None
                # Extract candidate value name from key path (last component after backslash)
                candidate_value_name = key_path.split('\\')[-1] if '\\' in key_path else key_path
                logger.debug(f"candidate_value_name from key_path: {candidate_value_name}")

                # Helper to check if metadata is wrapped heavy key
                if 'metadata' in metadata_obj and isinstance(metadata_obj['metadata'], dict):
                    # Wrapped heavy key metadata
                    heavy_meta = metadata_obj['metadata']
                elif 'type' in metadata_obj:
                    # Metadata is already the heavy key metadata
                    heavy_meta = metadata_obj
                else:
                    # Metadata is likely a policy with header and heavy keys
                    # Collect all heavy key metadata entries
                    heavy_candidates = []
                    for key, val in metadata_obj.items():
                        if key == 'header':
                            continue
                        if isinstance(val, dict) and 'metadata' in val and isinstance(val['metadata'], dict):
                            heavy_candidates.append(val['metadata'])

                    # Try to match by valueName from header
                    if header_value_name is not None:
                        for candidate in heavy_candidates:
                            if candidate.get('valueName') == header_value_name:
                                heavy_meta = candidate
                                break
                    # If header has no valueName, try to match by candidate value name from key path
                    if heavy_meta is None and candidate_value_name:
                        for candidate in heavy_candidates:
                            if candidate.get('valueName') == candidate_value_name:
                                heavy_meta = candidate
                                break
                    # If not matched, try to match by key (for list elements)
                    if heavy_meta is None and header_key is not None:
                        for candidate in heavy_candidates:
                            # List elements have 'key' field in metadata
                            if candidate.get('key') == header_key:
                                heavy_meta = candidate
                                break
                    # If still not found, take first candidate
                    if heavy_meta is None and heavy_candidates:
                        heavy_meta = heavy_candidates[0]
                        logger.debug(f"heavy_meta selected: valueName={heavy_meta.get('valueName')}, type={heavy_meta.get('type')}")

                if isinstance(heavy_meta, dict):
                    # Override value_name from metadata if present
                    meta_value_name = heavy_meta.get('valueName')
                    if meta_value_name is not None:
                        value_name = meta_value_name
        # Adjust key_path and value_name based on metadata
        if metadata_obj:
            key_path, value_name = self._extract_key_and_value_from_metadata(key_path, metadata_obj, heavy_meta)

        # Now handle parsed_value to override/extract value_data, value_name, value_type
        if isinstance(parsed_value, dict):
            # Override with explicit values if provided
            value_name = parsed_value.get('value_name', value_name)
            value_data = parsed_value.get('value_data', parsed_value.get('data', ''))
            explicit_value_type = parsed_value.get('value_type')
            if explicit_value_type:
                value_type = explicit_value_type
        else:
            # Treat value as raw data, default value_name empty (default value)
            value_data = parsed_value
            # value_name and value_type already set from metadata or defaults

        if isinstance(heavy_meta, dict) and not (
            isinstance(parsed_value, dict) and parsed_value.get('value_type')
        ):
            value_type = reg_type_for_metadata_value(heavy_meta, value_data, value_type)

        # If no metadata and value_name not set, extract from key_path
        if not metadata_obj and not value_name:
            key_path, value_name = self._split_key_value_name(key_path)

        # Call GPTWorker
        resolved_name_gpt = utils.resolve_gpo_path(name_gpt, self.sysvol_path)
        logger.debug(f"Calling GPTWorker.update_policy_value: name_gpt={name_gpt}, resolved={resolved_name_gpt}, key_path={key_path}, value_name={value_name}, value_data={value_data}, value_type={value_type}, policy_type={policy_type}")
        try:
            success = self.gpt_worker.update_policy_value(
                resolved_name_gpt, key_path, value_name, value_data, value_type, policy_type
            )
            if success:
                new_version = self._update_gpo_version(resolved_name_gpt, policy_type)
                try:
                    if new_version < 0:
                        logger.warning("Policy set but GPT.INI version update failed for %s", resolved_name_gpt)
                    return new_version if success else -1
                except TypeError:
                    return -1 if not new_version else new_version
            return -1
        except (OSError, IOError) as exp:
            logger.error(f"I/O error writing policy to {resolved_name_gpt}: {exp}")
            return -1
        except (ValueError, json.JSONDecodeError) as exp:
            logger.error(f"Data error setting policy value: {exp}")
            return -1
        except Exception as exp:
            logger.exception(f"Unexpected error setting policy value: {exp}")
            return -1

    def _extract_key_and_value_from_metadata(self, key_path, metadata_obj, heavy_meta=None):
        """Adjust key_path and value_name based on metadata header and heavy key metadata."""
        if not isinstance(metadata_obj, dict):
            return key_path, ''

        header = metadata_obj.get('header', {})
        if not isinstance(header, dict):
            return key_path, ''

        meta_key = header.get('key')
        meta_value_name = header.get('valueName')

        # If heavy_meta provided and has valueName, use it
        if isinstance(heavy_meta, dict):
            heavy_value_name = heavy_meta.get('valueName')
            if heavy_value_name is not None:
                meta_value_name = heavy_value_name
            # For list elements, heavy_meta may have 'key' field
            heavy_key = heavy_meta.get('key')
            if heavy_key is not None:
                meta_key = heavy_key

        # Default values
        adjusted_key_path = key_path
        value_name = ''

        # Normalize backslashes
        key_path_norm = AdmxParser.normalize_registry_key(key_path)
        parts = key_path_norm.split('\\')
        parent = '\\'.join(parts[:-1]) if len(parts) > 1 else ''
        last_part = parts[-1] if len(parts) >= 1 else ''

        candidate_value_name = last_part

        # Normalize meta_key if present
        meta_key_norm = None
        if meta_key:
            meta_key_norm = AdmxParser.normalize_registry_key(meta_key)
        parent_norm = AdmxParser.normalize_registry_key(parent) if parent else ''

        # If meta_key matches parent, treat last component as value name (override metadata)
        if meta_key_norm and parent_norm and meta_key_norm == parent_norm:
            # The key path includes an extra component beyond the metadata key
            # Treat that extra component as the value name (override metadata valueName)
            value_name = candidate_value_name
            adjusted_key_path = parent
        else:
            # Use metadata valueName logic
            if meta_value_name:
                if meta_value_name == candidate_value_name:
                    # Matching: strip last component, use meta_value_name
                    value_name = meta_value_name
                    adjusted_key_path = parent
                else:
                    # Mismatch: keep key_path unchanged, use meta_value_name as value_name
                    value_name = meta_value_name
                    # adjusted_key_path remains key_path
            else:
                # No meta_value_name: use last_part as value_name (if exists) and strip
                if candidate_value_name:
                    value_name = candidate_value_name
                    adjusted_key_path = parent
                # else both empty, keep defaults

        return adjusted_key_path, value_name
    def delete_policy_value(self, path, name_gpt, target=None):
        """Delete a policy value from GPO Registry.pol file

        Args:
            path: Registry key path (e.g., 'Software\\BaseALT\\Policies\\GPUpdate\\SettingName')
            name_gpt: GPO path (relative to sysvol). Required.
            target: Policy type ('Machine' or 'User'). If None, defaults to 'Machine'.

        Returns:
            True if deleted (or value didn't exist), False on error
        """
        with self.lock:
            return self._delete_policy_value_unlocked(path, name_gpt, target)

    def _delete_policy_value_unlocked(self, path, name_gpt, target=None):
        if self.gpt_worker is None:
            logger.error("GPTWorker not available")
            return False

        policy_type = 'Machine'
        if target is not None:
            policy_type = target

        key_path = AdmxParser.normalize_registry_key(path)
        key_path, value_name = self._split_key_value_name(key_path)

        resolved_name_gpt = utils.resolve_gpo_path(name_gpt, self.sysvol_path)
        logger.debug(f"Calling GPTWorker.delete_policy_value: name_gpt={name_gpt}, resolved={resolved_name_gpt}, key_path={key_path}, value_name={value_name}, policy_type={policy_type}")
        try:
            success = self.gpt_worker.delete_policy_value(
                resolved_name_gpt, key_path, value_name, policy_type
            )
            if success:
                new_version = self._update_gpo_version(resolved_name_gpt, policy_type)
                if new_version < 0:
                    logger.warning("Policy deleted but GPT.INI version update failed for %s", resolved_name_gpt)
                return new_version if success else -1
            return -1
        except (OSError, IOError) as exp:
            logger.error(f"I/O error deleting policy from {resolved_name_gpt}: {exp}")
            return False
        except (ValueError, json.JSONDecodeError) as exp:
            logger.error(f"Data error deleting policy value: {exp}")
            return False
        except Exception as exp:
            logger.exception(f"Unexpected error deleting policy value: {exp}")
            return False

    def get_policy_state(self, policy_path, name_gpt, target=None):
        """Determine current policy state from Registry.pol + ADMX metadata.

        Args:
            policy_path: Path to policy in ADMX tree (e.g., 'Machine/categories/.../PolicyName')
            name_gpt: GPO path (relative to sysvol). Required.
            target: 'Machine' or 'User'. If None, defaults to 'Machine'.

        Returns:
            dict with 'state' and 'values' keys, or None on error
        """
        with self.lock:
            if self.policy_state_manager is None:
                logger.error("PolicyStateManager not available")
                return None

            policy_type = target or 'Machine'
            policy_metadata = self.get(policy_path)
            if not policy_metadata or not isinstance(policy_metadata, dict):
                logger.error(f"Policy not found at path: {policy_path}")
                return None

            resolved_name_gpt = utils.resolve_gpo_path(name_gpt, self.sysvol_path)
            return self.policy_state_manager.determine_state(
                resolved_name_gpt, policy_type, policy_metadata
            )

    def set_policy_state(self, policy_path, name_gpt, state, target=None):
        """Atomically set policy state.

        Args:
            policy_path: Path to policy in ADMX tree
            name_gpt: GPO path (relative to sysvol). Required.
            state: 'enabled', 'disabled', or 'not_configured'
            target: 'Machine' or 'User'. If None, defaults to 'Machine'.

        Returns:
            True if successful, False otherwise
        """
        with self.lock:
            if self.policy_state_manager is None:
                logger.error("PolicyStateManager not available")
                return False

            policy_type = target or 'Machine'
            policy_metadata = self.get(policy_path)
            if not policy_metadata or not isinstance(policy_metadata, dict):
                logger.error(f"Policy not found at path: {policy_path}")
                return False

            resolved_name_gpt = utils.resolve_gpo_path(name_gpt, self.sysvol_path)
            success = self.policy_state_manager.set_state(
                resolved_name_gpt, policy_type, policy_metadata, state
            )
            if success:
                self._update_gpo_version(resolved_name_gpt, policy_type)
            return success

    def get_scripts(self, name_gpt, target, script_type):
        """Read scripts from a GPO.

        Args:
            name_gpt: GPO path (relative to sysvol)
            target: 'Machine' or 'User'
            script_type: 'scripts' or 'psscripts'

        Returns:
            dict {section: [{cmdLine, parameters}, ...]}
        """
        with self.lock:
            if self.scripts_worker is None:
                logger.error("ScriptsWorker not available")
                return {}
            resolved_name_gpt = utils.resolve_gpo_path(name_gpt, self.sysvol_path)
            return self.scripts_worker.read_scripts(resolved_name_gpt, target, script_type)

    def set_scripts(self, name_gpt, target, script_type, scripts_data):
        """Write scripts to a GPO.

        Args:
            name_gpt: GPO path (relative to sysvol)
            target: 'Machine' or 'User'
            script_type: 'scripts' or 'psscripts'
            scripts_data: dict {section: [{cmdLine, parameters}, ...]}

        Returns:
            True if successful, False otherwise
        """
        with self.lock:
            if self.scripts_worker is None:
                logger.error("ScriptsWorker not available")
                return False
            resolved_name_gpt = utils.resolve_gpo_path(name_gpt, self.sysvol_path)
            success = self.scripts_worker.write_scripts(
                resolved_name_gpt, target, script_type, scripts_data
            )
            if success:
                self._update_gpo_version(resolved_name_gpt, target)
            return success

    def get_comments(self, name_gpt, target, locale=''):
        """Read comments from a GPO.

        Args:
            name_gpt: GPO path (relative to sysvol)
            target: 'Machine' or 'User'
            locale: Locale for CMTL lookup

        Returns:
            dict {policy_name: comment_text}
        """
        with self.lock:
            if self.comments_worker is None:
                logger.error("CommentsWorker not available")
                return {}
            resolved_name_gpt = utils.resolve_gpo_path(name_gpt, self.sysvol_path)
            return self.comments_worker.read_comments(resolved_name_gpt, target, locale)

    def save_comment(self, name_gpt, target, policy_ref, comment_text, namespace=''):
        """Add or update a comment.

        Args:
            name_gpt: GPO path (relative to sysvol)
            target: 'Machine' or 'User'
            policy_ref: Policy identifier
            comment_text: Comment text
            namespace: ADMX target namespace (optional)

        Returns:
            True if successful
        """
        with self.lock:
            if self.comments_worker is None:
                logger.error("CommentsWorker not available")
                return False
            resolved_name_gpt = utils.resolve_gpo_path(name_gpt, self.sysvol_path)
            result = self.comments_worker.save_comment(
                resolved_name_gpt, target, policy_ref, comment_text, namespace
            )
            if result:
                self._update_gpo_version(resolved_name_gpt, target)
            return result

    def delete_comment(self, name_gpt, target, policy_ref):
        """Delete a comment.

        Args:
            name_gpt: GPO path (relative to sysvol)
            target: 'Machine' or 'User'
            policy_ref: Policy name or 'ns:PolicyName'

        Returns:
            True if successful
        """
        with self.lock:
            if self.comments_worker is None:
                logger.error("CommentsWorker not available")
                return False
            resolved_name_gpt = utils.resolve_gpo_path(name_gpt, self.sysvol_path)
            result = self.comments_worker.delete_comment(
                resolved_name_gpt, target, policy_ref
            )
            if result:
                self._update_gpo_version(resolved_name_gpt, target)
            return result

    def get_current_value(self, path, name_gpt, target=None):
        """Get current value from GPO policy file

        Args:
            path: Registry key path (e.g., 'Software\\BaseALT\\Policies\\GPUpdate')
            name_gpt: GPO path (relative to sysvol). Required.
            target: Policy type ('Machine' or 'User'). If None, defaults to 'Machine'.

        Returns:
            Tuple (value_data, value_type) if found, None otherwise
        """
        with self.lock:
            return self._get_current_value_unlocked(path, name_gpt, target)

    def _get_current_value_unlocked(self, path, name_gpt, target=None):
        if self.gpt_worker is None:
            logger.error("GPTWorker not available, cannot read .pol file")
            return None

        if not name_gpt:
            logger.error("name_gpt parameter is required")
            return None

        # Determine policy_type
        policy_type = 'Machine'  # default
        if target is not None:
            policy_type = target

        # Resolve UNC or absolute GPO path
        resolved_name_gpt = utils.resolve_gpo_path(name_gpt, self.sysvol_path)

        # Convert path to registry key format and normalize backslashes
        key_path = AdmxParser.normalize_registry_key(path)
        # Use empty string for default value name
        value_name = ''
        key_path, value_name = self._split_key_value_name(key_path)

        try:
            result = self.gpt_worker.get_policy_value(
                resolved_name_gpt, key_path, value_name, policy_type
            )
            return result
        except (OSError, IOError) as exp:
            logger.error(f"I/O error reading policy from {resolved_name_gpt}: {exp}")
            return None
        except (ValueError, json.JSONDecodeError) as exp:
            logger.error(f"Data error getting policy value: {exp}")
            return None
        except Exception as exp:
            logger.exception(f"Unexpected error getting policy value: {exp}")
            return None

    def list_children(self, parent_path: str) -> list[Union[str, dict]]:
        """
        List children under parent path with help text.

        Args:
            parent_path: Path to list children for

        Returns:
            List of child names (strings) or dicts with 'name' and 'help' keys.
        """
        with self.lock:
            logger.debug(f"list_children: parent_path={parent_path}")

            if not parent_path or parent_path == "/":
                return list(self.data.keys())

            current, remaining, found = self._navigator._navigate_path(parent_path)
            if not found or remaining:
                return []

            return self._navigator._format_children(current, parent_path)

    def find(self, search_pattern: str, search_type: str = 'all') -> list[str]:
        """
        Search loaded ADMX data for policies and categories matching pattern.

        Args:
            search_pattern: Text to search for (case-insensitive)
            search_type: 'name' (displayName/id), 'help' (help text),
                        'category', or 'all'

        Returns:
            List of matching paths
        """
        with self.lock:
            results = []
            pattern = search_pattern.lower()
            self._search_node(self.data, '', pattern, search_type, results)
            return results

    def _search_node(self, node, current_path, pattern, search_type, results, depth=0):
        """
        Recursively search ADMX data tree.

        Args:
            node: Current data node
            current_path: Accumulated path string
            pattern: Lowercase search pattern
            search_type: Type of search
            results: Accumulating results list
            depth: Current recursion depth (max 100)
        """
        if depth > 100:
            return
        if isinstance(node, dict):
            display_name = node.get('displayName', '')
            cat_name = node.get('category', '')
            help_text = node.get('help', '')
            node_id = node.get('id', '')

            match = False
            if search_type in ('name', 'all'):
                if pattern in display_name.lower() or pattern in node_id.lower():
                    match = True
            if search_type == 'help' and pattern in help_text.lower():
                match = True
            if search_type == 'category' and pattern in cat_name.lower():
                match = True
            if search_type == 'all' and not match:
                if pattern in help_text.lower() or pattern in cat_name.lower():
                    match = True

            if match and current_path:
                results.append(current_path)

            for key, value in node.items():
                if key in ('header', 'metadata'):
                    continue
                child_path = '{}/{}'.format(current_path, key) if current_path else key
                self._search_node(value, child_path, pattern, search_type, results, depth + 1)

        elif isinstance(node, list):
            for item in node:
                if isinstance(item, dict):
                    cat_name = item.get('category', '')
                    child_path = '{}/{}'.format(current_path, cat_name) if current_path else cat_name
                    self._search_node(item, child_path, pattern, search_type, results, depth + 1)

    def save_preference(self, name_gpt, target, pref_type, value, uid=''):
        """
        Save a single Group Policy Preference

        Args:
            name_gpt: GPO path (relative to sysvol)
            target: 'Machine' or 'User'
            pref_type: Preference type (Files, Folders, etc., NOT Registry)
            value: JSON string with type-specific properties
            uid: UID of existing preference to update, empty string to create new

        Returns:
            dict with results: {'success': bool, 'message': str, 'uid': str}
        """
        with self.lock:
            return self._save_preference_unlocked(name_gpt, target, pref_type, value, uid)

    def _save_preference_unlocked(self, name_gpt, target, pref_type, value, uid=''):
        if self.gpprefs_worker is None:
            logger.error("GPPrefsWorker not available")
            return {'success': False, 'message': 'GPPrefsWorker not available', 'uid': uid}

        if not name_gpt:
            logger.error("name_gpt parameter is required")
            return {'success': False, 'message': 'name_gpt is required', 'uid': uid}

        try:
            resolved = utils.resolve_gpo_path(name_gpt, self.sysvol_path)
            result = self.gpprefs_worker.save_preference(resolved, target, pref_type, value, uid)
            if result.get('success'):
                new_version = self._update_gpo_version(resolved, target or 'Machine')
                if new_version < 0:
                    result['message'] += ' (WARNING: GPT.INI version not updated)'
                else:
                    result['new_version'] = new_version
            return result
        except json.JSONDecodeError as exp:
            logger.error(f"Invalid JSON in preference value: {exp}")
            return {'success': False, 'message': f'Invalid JSON: {exp}', 'uid': uid}
        except (OSError, IOError) as exp:
            logger.error(f"I/O error saving preference: {exp}")
            return {'success': False, 'message': str(exp), 'uid': uid}
        except ValueError as exp:
            logger.error(f"Data error saving preference: {exp}")
            return {'success': False, 'message': str(exp), 'uid': uid}
        except Exception as exp:
            logger.exception(f"Unexpected error saving preference: {exp}")
            return {'success': False, 'message': str(exp), 'uid': uid}

    def get_preferences(self, gpo_guid, scope, pref_type=None):
        """
        Read preferences from XML files

        Args:
            gpo_guid: GUID of the GPO
            scope: 'Machine' or 'User'
            pref_type: Specific preference type to read, or None for all

        Returns:
            dict with preferences grouped by type
        """
        with self.lock:
            return self._get_preferences_unlocked(gpo_guid, scope, pref_type)

    def _get_preferences_unlocked(self, gpo_guid, scope, pref_type=None):
        if self.gpprefs_worker is None:
            logger.error("GPPrefsWorker not available")
            return {}

        try:
            resolved_gpo_guid = utils.resolve_gpo_path(gpo_guid, self.sysvol_path)
            return self.gpprefs_worker.read_preferences(resolved_gpo_guid, scope, pref_type)
        except (OSError, IOError) as exp:
            logger.error(f"I/O error reading preferences from {gpo_guid}: {exp}")
            return {}
        except (ValueError, json.JSONDecodeError) as exp:
            logger.error(f"Data error getting preferences: {exp}")
            return {}
        except Exception as exp:
            logger.exception(f"Unexpected error getting preferences: {exp}")
            return {}

    def delete_preference(self, gpo_guid, scope, pref_type, uid):
        """
        Delete a specific preference by UID

        Args:
            gpo_guid: GUID of the GPO
            scope: 'Machine' or 'User'
            pref_type: Type of preference
            uid: UID of the preference to delete

        Returns:
            True if deleted, False otherwise
        """
        with self.lock:
            return self._delete_preference_unlocked(gpo_guid, scope, pref_type, uid)

    def _delete_preference_unlocked(self, gpo_guid, scope, pref_type, uid):
        if self.gpprefs_worker is None:
            logger.error("GPPrefsWorker not available")
            return {'success': False, 'new_version': -1}

        try:
            resolved_gpo_guid = utils.resolve_gpo_path(gpo_guid, self.sysvol_path)
            success = self.gpprefs_worker.delete_preference(resolved_gpo_guid, scope, pref_type, uid)
            if success:
                new_version = self._update_gpo_version(resolved_gpo_guid, scope)
                if new_version < 0:
                    logger.warning("Preference deleted but GPT.INI version update failed for %s", resolved_gpo_guid)
                return {'success': True, 'new_version': new_version}
            return {'success': False, 'new_version': -1}
        except (OSError, IOError) as exp:
            logger.error(f"I/O error deleting preference from {gpo_guid}: {exp}")
            return {'success': False, 'new_version': -1}
        except (ValueError, json.JSONDecodeError) as exp:
            logger.error(f"Data error deleting preference: {exp}")
            return {'success': False, 'new_version': -1}
        except Exception as exp:
            logger.exception(f"Unexpected error deleting preference: {exp}")
            return {'success': False, 'new_version': -1}

    def get_display_name(self, name_gpt):
        """Get displayName for a GPO, reading from GPT.INI if not cached."""
        resolved = utils.resolve_gpo_path(name_gpt, self.sysvol_path)
        with self.lock:
            if resolved in self._gpo_display_names:
                return self._gpo_display_names[resolved]
        if self.gpt_worker:
            try:
                gpt_ini_path = self.gpt_worker._get_gpt_ini_path(resolved)
                ini_data = self.gpt_worker._parse_gpt_ini(gpt_ini_path)
                name = ini_data.get('displayName', '')
                if name:
                    with self.lock:
                        self._gpo_display_names[resolved] = name
                return name
            except Exception as exp:
                logger.debug("Could not read displayName from GPT.INI: %s", exp)
        return ''

    def set_display_name(self, name_gpt, display_name):
        """Set displayName for a GPO in GPT.INI and cache.

        Args:
            name_gpt: GPO path (relative to sysvol)
            display_name: New display name

        Returns:
            True if successful, False otherwise.
        """
        with self.lock:
            resolved = utils.resolve_gpo_path(name_gpt, self.sysvol_path)
            self._gpo_display_names[resolved] = display_name
            if self.gpt_worker is None:
                logger.warning("GPTWorker not available, cannot write displayName")
                return False
            try:
                gpt_ini_path = self.gpt_worker._get_gpt_ini_path(resolved)
                ini_data = self.gpt_worker._parse_gpt_ini(gpt_ini_path)
                ini_data['displayName'] = display_name
                self.gpt_worker._write_gpt_ini(gpt_ini_path, ini_data)
                return True
            except Exception as exp:
                logger.warning("Failed to write displayName to GPT.INI: %s", exp)
                return False

    def _update_gpo_version(self, gpo_path, scope='Machine'):
        """
        Update GPO version in GPT.INI after policy change.

        Args:
            gpo_path: Resolved GPO path (relative to sysvol)
            scope: 'Machine' or 'User'

        Returns:
            New version integer if updated successfully, -1 otherwise.
        """
        if self.gpt_worker is None:
            logger.warning("GPTWorker not available, cannot update GPT.INI version")
            return -1
        try:
            display_name = self.get_display_name(gpo_path)
            new_version = self.gpt_worker.increment_gpo_version(
                gpo_path, scope, display_name=display_name or None
            )
            return new_version
        except Exception as exp:
            logger.warning("Failed to update GPO version: %s", exp)
            return -1


def list_of_dicts_to_dict(items, key_attr):
    """
    items: list[dict]
    key_attr: 'category'
    """
    result = {}

    for item in items:
        if not isinstance(item, dict):
            continue

        key = item.get(key_attr)

        if not isinstance(key, str):
            continue

        result[key] = item

    return result
