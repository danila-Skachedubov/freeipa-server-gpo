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
        """Get value by path"""
        with self.lock:
            if not path or path == "/":
                return self.data

            parts = path.strip("/").split("/")
            current = self.data

            for part in parts:
                # CASE 1
                if isinstance(current, dict):
                    if part not in current:
                        return None
                    current = current[part]
                    continue

                # CASE 2
                if isinstance(current, list):
                    found = None
                    for item in current:
                        if (
                            isinstance(item, dict)
                            and item.get("category") == part
                        ):
                            found = item
                            break

                    if found is None:
                        return None

                    current = found
                    continue

                return None

            return current


    def set(self, path, value):
        """Set value by path"""
        # with self.lock:
        #     self.data[path] = value
        #     return True
        pass

    def list_children(self, parent_path, target=None):
        """List children under parent path"""

        with self.lock:
            # Handle root or empty path - return top-level keys
            if not parent_path or parent_path == "/":
                return list(self.data.keys())

            # Split the path into individual components
            parts = parent_path.strip('/').split('/')

            # Start at the root dictionary
            current_level = self.data

            # Traverse through the nested structure one level at a time
            for part in parts:
                if isinstance(current_level, dict) and part in current_level:

                    # Case 1: next level is a dictionary
                    if isinstance(current_level[part], dict):
                        current_level = current_level[part]

                    # Case 2: next level is a list -> convert to dict
                    elif isinstance(current_level[part], list):
                        if not current_level[part]:
                            return []

                        if not isinstance(current_level[part][0], dict):
                            return []

                        cpart = 'category'
                        current_level = list_of_dicts_to_dict(
                            current_level[part],
                            cpart
                        )

                    else:
                        return []
                else:
                    return []

            # We've reached the target level
            if isinstance(current_level, dict):
                return list(current_level.keys())

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