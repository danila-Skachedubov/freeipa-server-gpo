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
GPTWorker - Worker for GPT policy file (.pol) creation and parsing
Uses Samba GPPolParser for reading/writing Group Policy registry.pol files
"""

import logging
from pathlib import Path
import traceback

logger = logging.getLogger('gpuiservice')

class GPTWorker:
    """
    Worker for GPT policy file (.pol) creation and parsing

    This class provides functionality to create and parse Group Policy
    registry.pol files using Samba's GPPolParser. It integrates with
    GPODataStore to enable writing policy values to GPT structures.

    Typical usage:
        worker = GPTWorker(sysvol_path='/var/lib/freeipa/sysvol')
        worker.update_policy_value(
            gpo_path='domain.example.com/Policies/{GUID}',
            key='Software\\BaseALT\\Policies\\SomePolicy',
            value_name='SomeValue',
            value_data=1,
            value_type='REG_DWORD'
        )
    """

    def __init__(self, sysvol_path='/var/lib/freeipa/sysvol'):
        """
        Initialize GPT policy worker

        Args:
            sysvol_path: Path to FreeIPA sysvol directory where GPT structures are stored
        """
        self.sysvol_path = Path(sysvol_path)
        self.pol_parser = None

        # Try to import Samba GPPolParser
        try:
            from samba.gp_parse.gp_pol import GPPolParser
            from samba.dcerpc import misc, preg
            self.pol_parser = GPPolParser
            self.preg = preg
            self.reg_constants = misc
            # Build registry type mapping
            self.reg_type_map = {
                'REG_SZ': misc.REG_SZ,
                'REG_EXPAND_SZ': misc.REG_EXPAND_SZ,
                'REG_BINARY': misc.REG_BINARY,
                'REG_DWORD': misc.REG_DWORD,
                'REG_DWORD_BIG_ENDIAN': misc.REG_DWORD_BIG_ENDIAN,
                'REG_LINK': misc.REG_LINK,
                'REG_MULTI_SZ': misc.REG_MULTI_SZ,
                'REG_QWORD': misc.REG_QWORD,
                'REG_NONE': misc.REG_NONE,
            }
            self.reg_type_reverse = {v: k for k, v in self.reg_type_map.items()}
            logger.debug("Samba GPPolParser imported successfully")
        except ImportError as exp:
            logger.warning(f"Samba GPPolParser not available: {exp}")
            logger.warning("GPT policy file operations will be limited")

    def _get_pol_file_path(self, gpo_path, policy_type='Machine'):
        """
        Get the path to registry.pol file for a given GPO

        Args:
            gpo_path: Relative path to GPO within sysvol (e.g., 'domain/Policies/{GUID}')
            policy_type: 'Machine' or 'User' policy file

        Returns:
            Path object to the registry.pol file
        """
        gpo_full_path = self.sysvol_path / gpo_path
        if policy_type == 'Machine':
            return gpo_full_path / 'Machine' / 'Registry.pol'
        else:  # User
            return gpo_full_path / 'User' / 'Registry.pol'

    def create_pol_file(self, gpo_path, policy_type='Machine', policies=None):
        """
        Create a new registry.pol file with given policies

        Args:
            gpo_path: Relative path to GPO within sysvol
            policy_type: 'Machine' or 'User' policy file
            policies: Dictionary of policies to write, where key is registry path
                     and value is tuple (value_name, value_data, value_type)
                     Example: {
                         'Software\\BaseALT\\Policies\\GPUpdate':
                         ('SomeValue', 1, 'REG_DWORD')
                     }

        Returns:
            True if successful, False otherwise
        """
        if not self.pol_parser:
            logger.error("Cannot create .pol file: Samba GPPolParser not available")
            return False

        pol_file_path = self._get_pol_file_path(gpo_path, policy_type)

        try:
            # Ensure parent directory exists
            pol_file_path.parent.mkdir(parents=True, exist_ok=True)

            # Create new GPPolParser instance
            parser = self.pol_parser()
            # Initialize pol_file with signature and version
            parser.pol_file = self.preg.file()
            parser.pol_file.header.signature = 'PReg'
            parser.pol_file.header.version = 1
            parser.pol_file.num_entries = len(policies) if policies else 0
            entries = []

            if policies:
                for key_path, (value_name, value_data, value_type) in policies.items():
                    # Convert value type to Samba constant
                    samba_type = self._convert_to_samba_type(value_type)
                    # Create entry
                    entry = self.preg.entry()
                    entry.type = samba_type
                    entry.keyname = key_path
                    entry.valuename = value_name if value_name is not None else ''
                    # Convert value data to appropriate format
                    entry.data = self._value_to_samba_data(value_data, samba_type)
                    # size is automatically calculated by NDR packing
                    entry.size = 0
                    entries.append(entry)

            parser.pol_file.entries = entries
            # Write binary file
            parser.write_binary(str(pol_file_path))

            logger.info(f"Created registry.pol file at {pol_file_path} with {len(policies or {})} policies")
            return True

        except Exception as exp:
            logger.error(f"Failed to create registry.pol file at {pol_file_path}: {exp}")
            logger.error(traceback.format_exc())
            return False

    def read_pol_file(self, gpo_path, policy_type='Machine'):
        """
        Read and parse a registry.pol file

        Args:
            gpo_path: Relative path to GPO within sysvol
            policy_type: 'Machine' or 'User' policy file

        Returns:
            Dictionary of policies where key is registry path and value is
            tuple (value_name, value_data, value_type), or empty dict if file doesn't exist
        """
        if not self.pol_parser:
            logger.error("Cannot read .pol file: Samba GPPolParser not available")
            return {}

        pol_file_path = self._get_pol_file_path(gpo_path, policy_type)

        if not pol_file_path.exists():
            logger.debug(f"registry.pol file not found at {pol_file_path}")
            return {}

        try:
            # Parse existing file
            parser = self.pol_parser()
            with open(pol_file_path, 'rb') as f:
                parser.parse(f.read())

            # Extract policies from pol_file entries
            policies = {}
            if parser.pol_file and parser.pol_file.entries:
                for entry in parser.pol_file.entries:
                    key_path = entry.keyname
                    value_name = entry.valuename
                    # Convert Samba data to Python value
                    value_data = self._samba_data_to_value(entry.data, entry.type)
                    value_type = self._convert_from_samba_type(entry.type)
                    policies[key_path] = (value_name, value_data, value_type)

            logger.debug(f"Read {len(policies)} policies from {pol_file_path}")
            return policies

        except Exception as exp:
            logger.error(f"Failed to read registry.pol file at {pol_file_path}: {exp}")
            logger.error(traceback.format_exc())
            return {}

    def update_policy_value(self, gpo_path, key_path, value_name, value_data,
                           value_type='REG_DWORD', policy_type='Machine'):
        """
        Update a single policy value in registry.pol file

        This method reads the existing file, updates or adds the specified policy,
        and writes the file back.

        Args:
            gpo_path: Relative path to GPO within sysvol
            key_path: Registry key path (e.g., 'Software\\BaseALT\\Policies\\GPUpdate')
            value_name: Name of the value to set
            value_data: Data to set (type depends on value_type)
            value_type: Registry value type ('REG_SZ', 'REG_DWORD', 'REG_QWORD', 'REG_BINARY', etc.)
            policy_type: 'Machine' or 'User' policy file

        Returns:
            True if successful, False otherwise
        """
        if not self.pol_parser:
            logger.error("Cannot update policy: Samba GPPolParser not available")
            return False

        pol_file_path = self._get_pol_file_path(gpo_path, policy_type)

        try:
            # Read existing policies
            existing_policies = self.read_pol_file(gpo_path, policy_type)

            # Update or add the policy
            existing_policies[key_path] = (value_name, value_data, value_type)

            # Convert policies to format expected by create_pol_file
            policies_dict = {}
            for k, (vn, vd, vt) in existing_policies.items():
                policies_dict[k] = (vn, vd, vt)

            # Create/update the file
            return self.create_pol_file(gpo_path, policy_type, policies_dict)

        except Exception as exp:
            logger.error(f"Failed to update policy value in {pol_file_path}: {exp}")
            logger.error(traceback.format_exc())
            return False

    def get_policy_value(self, gpo_path, key_path, value_name, policy_type='Machine'):
        """
        Get a specific policy value from registry.pol file

        Args:
            gpo_path: Relative path to GPO within sysvol
            key_path: Registry key path
            value_name: Name of the value to retrieve
            policy_type: 'Machine' or 'User' policy file

        Returns:
            Tuple of (value_data, value_type) if found, None otherwise
        """
        policies = self.read_pol_file(gpo_path, policy_type)

        if key_path in policies:
            v_name, v_data, v_type = policies[key_path]
            if v_name == value_name:
                return v_data, v_type

        logger.debug(f"Policy value not found: {key_path}\\{value_name}")
        return None

    def delete_policy_value(self, gpo_path, key_path, value_name, policy_type='Machine'):
        """
        Delete a specific policy value from registry.pol file

        Args:
            gpo_path: Relative path to GPO within sysvol
            key_path: Registry key path
            value_name: Name of the value to delete
            policy_type: 'Machine' or 'User' policy file

        Returns:
            True if successful (or value didn't exist), False on error
        """
        if not self.pol_parser:
            logger.error("Cannot delete policy: Samba GPPolParser not available")
            return False

        pol_file_path = self._get_pol_file_path(gpo_path, policy_type)

        if not pol_file_path.exists():
            logger.debug(f"registry.pol file not found at {pol_file_path}")
            return True

        try:
            # Read existing policies
            existing_policies = self.read_pol_file(gpo_path, policy_type)

            # Remove the policy if it exists
            if key_path in existing_policies:
                v_name, _, _ = existing_policies[key_path]
                if v_name == value_name:
                    del existing_policies[key_path]
                else:
                    # Key exists but value name doesn't match
                    logger.debug(f"Value name mismatch: expected {value_name}, found {v_name}")
                    return True
            else:
                # Policy doesn't exist
                return True

            # Convert policies to format expected by create_pol_file
            policies_dict = {}
            for k, (vn, vd, vt) in existing_policies.items():
                policies_dict[k] = (vn, vd, vt)

            # Write updated file (or delete if empty)
            if policies_dict:
                return self.create_pol_file(gpo_path, policy_type, policies_dict)
            else:
                # Delete empty file
                pol_file_path.unlink()
                logger.info(f"Deleted empty registry.pol file at {pol_file_path}")
                return True

        except Exception as exp:
            logger.error(f"Failed to delete policy value from {pol_file_path}: {exp}")
            logger.error(traceback.format_exc())
            return False

    def _convert_to_samba_type(self, reg_type):
        """
        Convert registry type string to Samba constant

        Args:
            reg_type: Registry type string ('REG_SZ', 'REG_DWORD', etc.)

        Returns:
            Samba constant for the registry type
        """
        if hasattr(self, 'reg_type_map'):
            return self.reg_type_map.get(reg_type, self.reg_constants.REG_SZ)
        # Fallback mapping if Samba not available
        fallback_map = {
            'REG_SZ': 1,
            'REG_EXPAND_SZ': 2,
            'REG_BINARY': 3,
            'REG_DWORD': 4,
            'REG_DWORD_BIG_ENDIAN': 5,
            'REG_LINK': 6,
            'REG_MULTI_SZ': 7,
            'REG_QWORD': 11,
            'REG_NONE': 0,
        }
        return fallback_map.get(reg_type, 1)  # Default to REG_SZ

    def _convert_from_samba_type(self, samba_type):
        """
        Convert Samba constant to registry type string

        Args:
            samba_type: Samba constant for registry type

        Returns:
            Registry type string
        """
        if hasattr(self, 'reg_type_reverse'):
            return self.reg_type_reverse.get(samba_type, 'REG_SZ')
        # Fallback mapping
        fallback_map = {
            1: 'REG_SZ',
            2: 'REG_EXPAND_SZ',
            3: 'REG_BINARY',
            4: 'REG_DWORD',
            5: 'REG_DWORD_BIG_ENDIAN',
            6: 'REG_LINK',
            7: 'REG_MULTI_SZ',
            11: 'REG_QWORD',
            0: 'REG_NONE',
        }
        return fallback_map.get(samba_type, 'REG_SZ')

    def _value_to_samba_data(self, value_data, reg_type):
        """
        Convert Python value to appropriate Samba entry data format

        Args:
            value_data: Python value (str, int, list, bytes)
            reg_type: Registry type constant (from samba.dcerpc.misc)

        Returns:
            Data formatted for preg.entry.data field
        """
        from samba.dcerpc import misc
        if reg_type == misc.REG_SZ or reg_type == misc.REG_EXPAND_SZ:
            return str(value_data) if value_data is not None else ''
        elif reg_type == misc.REG_DWORD or reg_type == misc.REG_DWORD_BIG_ENDIAN or reg_type == misc.REG_QWORD:
            return int(value_data)
        elif reg_type == misc.REG_MULTI_SZ:
            if isinstance(value_data, list):
                # Join with null characters, double null terminate
                if not value_data:
                    return u'\x00'.encode('utf-16le')
                # Ensure each element is string
                strings = [str(item) for item in value_data]
                data = u'\x00'.join(strings) + u'\x00\x00'
                return data.encode('utf-16le')
            else:
                # Assume it's a single string with embedded nulls? Not supported.
                raise ValueError("REG_MULTI_SZ value must be a list of strings")
        elif reg_type == misc.REG_BINARY:
            if isinstance(value_data, bytes):
                return value_data
            elif isinstance(value_data, str):
                # Assume hex string? For simplicity, encode as bytes
                return value_data.encode('utf-8')
            else:
                raise ValueError("REG_BINARY value must be bytes or string")
        elif reg_type == misc.REG_NONE:
            return None
        else:
            # Unknown type, treat as binary
            logger.warning(f"Unknown registry type {reg_type}, treating as binary")
            if isinstance(value_data, bytes):
                return value_data
            else:
                return str(value_data).encode('utf-8')

    def _samba_data_to_value(self, entry_data, reg_type):
        """
        Convert Samba entry data to Python value

        Args:
            entry_data: Data from preg.entry.data field
            reg_type: Registry type constant

        Returns:
            Python value (str, int, list, bytes)
        """
        from samba.dcerpc import misc
        if reg_type == misc.REG_SZ or reg_type == misc.REG_EXPAND_SZ:
            return entry_data if entry_data is not None else ''
        elif reg_type == misc.REG_DWORD or reg_type == misc.REG_DWORD_BIG_ENDIAN or reg_type == misc.REG_QWORD:
            return int(entry_data) if entry_data is not None else 0
        elif reg_type == misc.REG_MULTI_SZ:
            if entry_data is None:
                return []
            # Decode utf-16le, strip trailing nulls, split by null
            decoded = entry_data.decode('utf-16le').rstrip(u'\x00')
            if decoded == u'':
                return []
            return decoded.split(u'\x00')
        elif reg_type == misc.REG_BINARY:
            return entry_data if entry_data is not None else b''
        elif reg_type == misc.REG_NONE:
            return None
        else:
            # Unknown type, return as is
            logger.warning(f"Unknown registry type {reg_type}, returning raw data")
            return entry_data
