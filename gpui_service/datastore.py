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

    def __init__(self):
        self.data = {}
        self.lock = threading.RLock()

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


    def set(self, path, value):
        """Set value by path"""
        # with self.lock:
        #     self.data[path] = value
        #     return True
        pass

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