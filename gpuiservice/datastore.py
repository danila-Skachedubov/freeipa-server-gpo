#
# gpuiservice - GPT Directory Management API Service
#
# Copyright (C) 2025 BaseALT Ltd.
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

logger = logging.getLogger('gpuiservice')

class GPODataStore:
    """Storage for ADMX policy data loaded from directory"""

    def __init__(self):
        self.data = {}
        self.lock = threading.RLock()

    def load_from_directory(self, directory_path):
        """Load ADMX policy definitions from directory"""
        with self.lock:
            logger.info(f"Loading ADMX data from {directory_path}")
            # TODO: Implement actual ADMX parsing logic
            # This is where you parse ADMX files and populate self.data
            self.data.clear()

            path = Path(directory_path)
            if not path.exists():
                logger.warning(f"Directory {directory_path} does not exist")
                return

            # Example: scan for ADMX files
            for admx_file in path.rglob("*.admx"):
                logger.debug(f"Found ADMX file: {admx_file}")
                # Parse ADMX policy definitions and store data
                # self.data[policy_path] = policy_definition

    def get(self, path):
        """Get value by path"""
        with self.lock:
            return self.data.get(path)

    def set(self, path, value):
        """Set value by path"""
        with self.lock:
            self.data[path] = value
            return True

    def list_children(self, parent_path):
        """List children under parent path"""
        with self.lock:
            children = []
            prefix = parent_path.rstrip('/') + '/'
            for key in self.data.keys():
                if key.startswith(prefix):
                    child = key[len(prefix):].split('/')[0]
                    if child not in children:
                        children.append(child)
            return children