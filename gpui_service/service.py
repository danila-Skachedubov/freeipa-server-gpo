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
GPUIService - DBus service for GPO editing functionality
"""

import dbus
import dbus.service
import logging
import json

logger = logging.getLogger('gpuiservice')

class GPUIService(dbus.service.Object):
    """
    DBus service for GPO editing functionality
    Uses ADMX policy definitions to generate and manage GPT structures
    Provides API for editing existing GPO parameters without creating new policy objects
    Analog of gpedit.msc for Linux infrastructure based on FreeIPA
    """

    def __init__(self, bus_name, object_path, data_store_dict):
        super().__init__(bus_name, object_path)
        self.data_store = data_store_dict
        logger.info(f"GPUIService initialized at {object_path}")

    @dbus.service.method(dbus_interface='org.freedesktop.DBus.Introspectable',
                         out_signature='s',
                         connection_keyword='connection')
    def Introspect(self, connection=None):
        """
        Provide introspection data for DBus clients
        Required for clients to discover methods and interfaces
        """
        return """<!DOCTYPE node PUBLIC "-//freedesktop//DTD D-BUS Object Introspection 1.0//EN"
                "http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd">
                <node name="/org/altlinux/gpuiservice">
                <interface name="org.altlinux.GPUIService">
                    <method name="get">
                    <arg name="path" direction="in" type="s"/>
                    <arg name="value" direction="out" type="v"/>
                    </method>
                    <method name="set">
                    <arg name="name_gpt" direction="in" type="s"/>
                    <arg name="target" direction="in" type="s"/>
                    <arg name="path" direction="in" type="s"/>
                    <arg name="value" direction="in" type="s"/>
                    <arg name="success" direction="out" type="b"/>
                    </method>
                    <method name="list_children">
                    <arg name="parent_path" direction="in" type="s"/>
                    <arg name="children" direction="out" type="v"/>
                    </method>
                    <method name="find">
                    <arg name="search_pattern" direction="in" type="s"/>
                    <arg name="search_type" direction="in" type="s"/>
                    <arg name="results" direction="out" type="v"/>
                    </method>
                    <method name="get_current_value">
                    <arg name="paths" direction="in" type="sss"/>
                    <arg name="results" direction="out" type="v"/>
                    </method>
                    <method name="reload">
                    <arg name="success" direction="out" type="b"/>
                    </method>
                </interface>
                <interface name="org.freedesktop.DBus.Introspectable">
                    <method name="Introspect">
                    <arg name="data" direction="out" type="s"/>
                    </method>
                </interface>
                <interface name="org.freedesktop.DBus.Properties">
                    <method name="Get">
                    <arg name="interface" direction="in" type="s"/>
                    <arg name="property" direction="in" type="s"/>
                    <arg name="value" direction="out" type="v"/>
                    </method>
                    <method name="Set">
                    <arg name="interface" direction="in" type="s"/>
                    <arg name="property" direction="in" type="s"/>
                    <arg name="value" direction="in" type="v"/>
                    </method>
                    <method name="GetAll">
                    <arg name="interface" direction="in" type="s"/>
                    <arg name="properties" direction="out" type="a{sv}"/>
                    </method>
                </interface>
                </node>"""

    @dbus.service.method('org.altlinux.GPUIService', in_signature='s', out_signature='v')
    def get(self, path):
        """
        Get parameter value from GPO
        Args:
            path: Path to the parameter in GPO structure
        Returns:
            Value of the parameter as JSON string for complex types
        """
        logger.info(f"get method called with path: {path}")
        value = self.data_store.get(path)
        if value is None:
            return ""

        if isinstance(value, (dict, list, tuple, set)):
            return json.dumps(value, default=str)
        elif isinstance(value, (int, float, bool)):
            return value
        else:
            return str(value)

    @dbus.service.method('org.altlinux.GPUIService', in_signature='ssss', out_signature='b')
    def set(self, name_gpt, target, path, value):
        """
        Set parameter value in GPO
        Args:
            path: Path to the parameter in GPO structure (registry key)
            name_gpt: GPO path (relative to sysvol)
            target: Policy type ('Machine' or 'User'), empty string for default
            value: Value to set
        Returns:
            True if successful, False otherwise
        """
        logger.info(f"set method called with path: {path}, name_gpt: {name_gpt}, target: {target}, value: {value}")
        # Convert empty target to None (use defaults)
        target_param = target if target else None
        return self.data_store.set(path, value, name_gpt, target_param)

    @dbus.service.method('org.altlinux.GPUIService', in_signature='s', out_signature='v')
    def list_children(self, parent_path):
        """
        List child parameters under a parent path
        Args:
            parent_path: Parent path in GPO structure
        Returns:
            Array of child parameter paths as JSON string
        """
        logger.info(f"list_children method called with parent_path: {parent_path}")
        result = self.data_store.list_children(parent_path)
        if isinstance(result, (dict, list, tuple, set)):
            return json.dumps(result, default=str)
        elif isinstance(result, (int, float, bool)):
            return result
        else:
            return str(result)


    @dbus.service.method('org.altlinux.GPUIService', in_signature='ss', out_signature='v')
    def find(self, search_pattern, search_type):
        """
        Find parameters matching search criteria
        Args:
            search_pattern: Pattern to search for
            search_type: Type of search (name, value, category, etc.)
        Returns:
            Array of matching parameter paths as JSON string
        """
        logger.info(f"find method called with pattern: {search_pattern}, type: {search_type}")
        # TODO: Implement actual search functionality
        result = []
        return json.dumps(result)

    @dbus.service.method('org.altlinux.GPUIService', in_signature='sss', out_signature='v')
    def get_current_value(self, name_gpt, target, path):
        """
        """
        logger.info(f"get_current_value method called with path: {path}")
        results = {}

        return json.dumps(results, default=str)

    @dbus.service.method('org.altlinux.GPUIService', out_signature='b')
    def reload(self):
        """
        Manually trigger reload of ADMX data for GPO generation
        Returns:
            True if successful
        """
        logger.info("Manual reload requested")
        # The reload will be handled by the monitor
        return True
