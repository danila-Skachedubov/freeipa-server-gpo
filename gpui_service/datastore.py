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
from parse_admx_structure import AdmxParser

logger = logging.getLogger('gpuiservice')

class GPODataStore:
    """Storage for ADMX policy data loaded from directory"""

    def __init__(self, sysvol_path='/var/lib/freeipa/sysvol'):
        self.data = {}
        self.lock = threading.RLock()
        self.sysvol_path = sysvol_path
        self.gpt_worker = None
        try:
            from gptworker import GPTWorker
            self.gpt_worker = GPTWorker(sysvol_path)
            logger.debug(f"GPTWorker initialized with sysvol path: {sysvol_path}")
        except ImportError as exp:
            logger.warning(f"GPTWorker not available: {exp}")
            logger.warning("GPO policy file operations will be limited")

    def load_from_directory(self, directory_path='/usr/share/PolicyDefinitions'):
        """Load ADMX policy definitions from directory"""
        self.data = AdmxParser.build_result_for_dir(directory_path)

    def get(self, path):
        with self.lock:
            if not path or path == "/":
                return self.data

            parts = path.strip("/").split("/")
            current = self.data

            i = 0
            while i < len(parts):
                part = parts[i]

                if isinstance(current, dict):

                    # POLICIES: terminal node
                    if part == "policies":
                        policy_name = "/".join(parts[i+1:])
                        policy_name = bytes(policy_name, "utf-8").decode("unicode_escape")
                        return current.get("policies", {}).get(policy_name)

                    if part not in current:
                        return None

                    current = current[part]
                    i += 1
                    continue

                if isinstance(current, list):
                    found = next(
                        (x for x in current
                        if isinstance(x, dict) and x.get("category") == part),
                        None
                    )
                    if not found:
                        return None

                    current = found
                    i += 1
                    continue

                return None

            return current


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
        logger.info(f"set called: path={repr(path)}, value={repr(value)}, name_gpt={repr(name_gpt)}, target={repr(target)}, metadata={repr(metadata)}")
        if self.gpt_worker is None:
            logger.error("GPTWorker not available, cannot write .pol file")
            return False

        if not name_gpt:
            logger.error("name_gpt parameter is required")
            return False

        # Convert path to registry key format (forward slashes to backslashes)
        key_path = path.replace("/", "\\") if "/" in path else path

        # Convert DBus types to native Python types
        if hasattr(value, '__class__') and value.__class__.__module__.startswith('dbus'):
            value = str(value)
        # Strip trailing commas that may be introduced by DBus argument parsing
        if isinstance(value, str) and value.endswith(','):
            value = value.rstrip(',')

        # Try to parse value as JSON string to support complex values
        parsed_value = value
        if isinstance(value, str):
            try:
                parsed_value = json.loads(value)
            except (json.JSONDecodeError, ValueError):
                # Try Python literal eval for Python-style dict syntax
                try:
                    if value.strip().startswith('{') and value.strip().endswith('}'):
                        parsed_value = ast.literal_eval(value)
                    else:
                        parsed_value = value  # Keep as string
                except (SyntaxError, ValueError):
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
                    meta_type = heavy_meta.get('type')
                    if meta_type:
                        # Map ADMX metadata type to registry type
                        type_map = {
                            'text': 'REG_SZ',
                            'decimal': 'REG_DWORD',
                            'boolean': 'REG_DWORD',
                            'enum': 'REG_SZ',
                            'list': 'REG_MULTI_SZ',
                            'policyValue': 'REG_DWORD',
                        }
                        value_type = type_map.get(meta_type, value_type)
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
            value_type = parsed_value.get('value_type', value_type)
        else:
            # Treat value as raw data, default value_name empty (default value)
            value_data = parsed_value
            # value_name and value_type already set from metadata or defaults

        # Call GPTWorker
        logger.debug(f"Calling GPTWorker.update_policy_value: name_gpt={name_gpt}, key_path={key_path}, value_name={value_name}, value_data={value_data}, value_type={value_type}, policy_type={policy_type}")
        try:
            success = self.gpt_worker.update_policy_value(
                name_gpt, key_path, value_name, value_data, value_type, policy_type
            )
            return success
        except Exception as exp:
            logger.error(f"Failed to set policy value: {exp}")
            return False

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
        key_path_norm = key_path.replace('/', '\\')
        parts = key_path_norm.split('\\')
        parent = '\\'.join(parts[:-1]) if len(parts) > 1 else ''
        last_part = parts[-1] if len(parts) >= 1 else ''

        candidate_value_name = last_part

        # Normalize meta_key if present
        meta_key_norm = None
        if meta_key:
            meta_key_norm = meta_key.replace('/', '\\')
        parent_norm = parent.replace('/', '\\') if parent else ''

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
    def get_current_value(self, path, name_gpt, target=None):
        """Get current value from GPO policy file

        Args:
            path: Registry key path (e.g., 'Software\\BaseALT\\Policies\\GPUpdate')
            name_gpt: GPO path (relative to sysvol). Required.
            target: Policy type ('Machine' or 'User'). If None, defaults to 'Machine'.

        Returns:
            Tuple (value_data, value_type) if found, None otherwise
        """
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

        # Convert path to registry key format (forward slashes to backslashes)
        key_path = path.replace("/", "\\") if "/" in path else path
        # Use empty string for default value name
        value_name = ''
        # Try to extract value_name from key_path (last component)
        key_parts = key_path.split('\\')
        if len(key_parts) > 1:
            potential_value_name = key_parts[-1]
            # Check if potential_value_name is not empty and not purely numeric?
            if potential_value_name.strip():
                value_name = potential_value_name
                # Adjust key_path to parent
                key_path = '\\'.join(key_parts[:-1])

        try:
            result = self.gpt_worker.get_policy_value(
                name_gpt, key_path, value_name, policy_type
            )
            return result
        except Exception as exp:
            logger.error(f"Failed to get policy value: {exp}")
            return None

    def list_children(self, parent_path):
        """List children under parent path"""
        with self.lock:
            # Handle root or empty path - return top-level keys
            if not parent_path or parent_path == "/":
                return list(self.data.keys())

            parts = parent_path.strip("/").split("/")
            current = self.data

            i = 0
            while i < len(parts):
                part = parts[i]

                # Case 1: next level is a dictionary
                if isinstance(current, dict):

                    # POLICIES: terminal node
                    if part == "policies":
                        policies = current.get("policies", {})
                        if isinstance(policies, dict):
                            return list(policies.keys())
                        return []

                    if part not in current:
                        return []

                    current = current[part]
                    i += 1
                    continue

                # Case 2: list of categories
                if isinstance(current, list):
                    found = next(
                        (
                            item for item in current
                            if isinstance(item, dict)
                            and item.get("category") == part
                        ),
                        None
                    )
                    if not found:
                        return []

                    current = found
                    i += 1
                    continue

                return []

            # We've reached the target level
            if isinstance(current, dict):
                return list(current.keys())

            if isinstance(current, list):
                return [
                    item.get("category")
                    for item in current
                    if isinstance(item, dict) and "category" in item
                ]

            return []



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