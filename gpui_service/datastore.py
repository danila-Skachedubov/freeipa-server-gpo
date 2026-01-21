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


    def set(self, path, value, name_gpt, target=None):
        """Set value by path

        Args:
            path: Registry key path (e.g., 'Software\\BaseALT\\Policies\\GPUpdate')
            value: Value to set - can be raw data or dict with fields:
                value_name, value_data, value_type, policy_type
            name_gpt: GPO path (relative to sysvol). Required.
            target: Policy type ('Machine' or 'User'). If None, uses policy_type from value dict or 'Machine'.

        Returns:
            True if successful, False otherwise
        """
        if self.gpt_worker is None:
            logger.error("GPTWorker not available, cannot write .pol file")
            return False

        if not name_gpt:
            logger.error("name_gpt parameter is required")
            return False

        # Convert path to registry key format (forward slashes to backslashes)
        key_path = path.replace("/", "\\") if "/" in path else path

        # Determine policy_type: target parameter overrides value dict
        policy_type = 'Machine'  # default
        if isinstance(value, dict) and target is None:
            # Use policy_type from value dict if target not provided
            policy_type = value.get('policy_type', policy_type)
        elif target is not None:
            # Use explicit target parameter
            policy_type = target

        # Determine value components
        if isinstance(value, dict):
            value_name = value.get('value_name', '')
            value_data = value.get('value_data', '')
            value_type = value.get('value_type', 'REG_SZ')
        else:
            # Treat value as raw data, default value_name empty (default value)
            value_name = ''
            value_data = value
            value_type = 'REG_SZ'

        # Call GPTWorker
        try:
            success = self.gpt_worker.update_policy_value(
                name_gpt, key_path, value_name, value_data, value_type, policy_type
            )
            return success
        except Exception as exp:
            logger.error(f"Failed to set policy value: {exp}")
            return False

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