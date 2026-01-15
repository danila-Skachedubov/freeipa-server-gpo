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
        return self.data

    def get(self, path):
        """Get value by path"""
        with self.lock:
            # Handle empty or root path
            if not path or path == "/":
                return self.data

            # Split path into components
            parts = path.strip('/').split('/')

            # Start from root dictionary
            current = self.data

            # Traverse through each level
            for i, part in enumerate(parts):
                if isinstance(current, dict) and part in current:
                    # Move to next level
                    current = current[part]
                else:
                    # Path doesn't exist
                    return None

            # Return the final value
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
                # Root level: return all top-level dictionary keys
                return list(self.data.keys())

            # Split the path into individual components
            # Remove leading/trailing slashes and split by '/'
            parts = parent_path.strip('/').split('/')

            # Start at the root dictionary
            current_level = self.data

            # Traverse through the nested structure one level at a time
            for part in parts:
                # Check if current part exists and is a dictionary
                if part in current_level and isinstance(current_level[part], dict):
                    # Move down one level in the hierarchy
                    current_level = current_level[part]
                else:
                    # Path doesn't exist or part is not a dictionary
                    # Return empty list indicating no children at this path
                    return []

            # We've reached the target level
            # Return all keys at this level as a list
            return list(current_level.keys())
