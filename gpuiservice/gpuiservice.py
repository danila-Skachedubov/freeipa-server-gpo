#!/usr/bin/env python3
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
GPUIService - DBus service for GPO editing functionality
Analog of gpedit.msc for Linux infrastructure based on FreeIPA
"""

import sys
import signal
import logging
import logging.handlers
import threading
from pathlib import Path
from gi.repository import GLib, Gio
import dbus
import dbus.service
import dbus.mainloop.glib

# Setup logging to syslog/journald
logger = logging.getLogger('gpuiservice')
logger.setLevel(logging.DEBUG)

# Try to use syslog handler
try:
    handler = logging.handlers.SysLogHandler(address='/dev/log')
    formatter = logging.Formatter('gpuiservice[%(process)d]: %(levelname)s: %(message)s')
    handler.setFormatter(formatter)
    logger.addHandler(handler)
except Exception as e:
    # Fallback to stdout if syslog is not available
    handler = logging.StreamHandler(sys.stdout)
    formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
    handler.setFormatter(formatter)
    logger.addHandler(handler)

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

class DirectoryMonitor:
    """Monitor directory for ADMX file changes and reload data"""

    def __init__(self, data_store, reload_callback=None):
        self.data_store = data_store
        self.reload_callback = reload_callback
        self.monitor = None
        self.monitored_path = None
        self.settings = None

        # Try to load settings from dconf
        try:
            self.settings = Gio.Settings.new('org.altlinux.gpuiservice')
        except Exception as e:
            logger.warning(f"Could not load dconf settings: {e}")

    def get_monitor_path(self):
        """Get path to monitor from dconf or use default"""
        default_path = '/usr/share/PolicyDefinitions'

        if self.settings:
            try:
                path = self.settings.get_string('monitor-path')
                if path:
                    logger.info(f"Using monitor path from dconf: {path}")
                    return path
            except Exception as e:
                logger.warning(f"Could not read monitor-path from dconf: {e}")

        logger.info(f"Using default monitor path: {default_path}")
        return default_path

    def on_file_changed(self, monitor, file, other_file, event_type):
        """Callback when ADMX files change in monitored directory"""
        if event_type in (Gio.FileMonitorEvent.CHANGED,
                         Gio.FileMonitorEvent.CREATED,
                         Gio.FileMonitorEvent.DELETED,
                         Gio.FileMonitorEvent.MOVED):
            logger.info(f"Directory change detected: {file.get_path()} ({event_type.value_name})")

            # Reload ADMX data from directory
            self.reload_data()

    def reload_data(self):
        """Reload ADMX data from monitored directory"""
        if self.monitored_path:
            logger.info(f"Reloading ADMX data from {self.monitored_path}")
            self.data_store.load_from_directory(self.monitored_path)

            # Call custom reload callback if provided
            if self.reload_callback:
                try:
                    self.reload_callback()
                except Exception as e:
                    logger.error(f"Error in reload callback: {e}")

    def start_monitoring(self):
        """Start monitoring the directory"""
        self.monitored_path = self.get_monitor_path()

        # Create directory if it doesn't exist
        path_obj = Path(self.monitored_path)
        try:
            path_obj.mkdir(parents=True, exist_ok=True)
        except Exception as e:
            logger.error(f"Could not create directory {self.monitored_path}: {e}")

        # Initial load
        self.reload_data()

        # Setup file monitor
        try:
            file = Gio.File.new_for_path(self.monitored_path)
            self.monitor = file.monitor_directory(Gio.FileMonitorFlags.NONE, None)
            self.monitor.connect('changed', self.on_file_changed)
            logger.info(f"Started monitoring directory: {self.monitored_path}")
        except Exception as e:
            logger.error(f"Failed to setup directory monitor: {e}")

    def stop_monitoring(self):
        """Stop monitoring"""
        if self.monitor:
            self.monitor.cancel()
            self.monitor = None
            logger.info("Stopped directory monitoring")

class GPUIService(dbus.service.Object):
    """
    DBus service for GPO editing functionality
    Uses ADMX policy definitions to generate and manage GPT structures
    Provides API for editing existing GPO parameters without creating new policy objects
    Analog of gpedit.msc for Linux infrastructure based on FreeIPA
    """

    def __init__(self, bus_name, object_path, data_store):
        super().__init__(bus_name, object_path)
        self.data_store = data_store
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
      <arg name="path" direction="in" type="s"/>
      <arg name="value" direction="in" type="v"/>
      <arg name="success" direction="out" type="b"/>
    </method>
    <method name="list_children">
      <arg name="parent_path" direction="in" type="s"/>
      <arg name="children" direction="out" type="as"/>
    </method>
    <method name="find">
      <arg name="search_pattern" direction="in" type="s"/>
      <arg name="search_type" direction="in" type="s"/>
      <arg name="results" direction="out" type="as"/>
    </method>
    <method name="get_set_values">
      <arg name="paths" direction="in" type="as"/>
      <arg name="results" direction="out" type="a{sv}"/>
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
            Value of the parameter
        """
        logger.info(f"get method called with path: {path}")
        value = self.data_store.get(path)
        if value is None:
            return dbus.Dictionary({}, signature='sv')
        return value

    @dbus.service.method('org.altlinux.GPUIService', in_signature='sv', out_signature='b')
    def set(self, path, value):
        """
        Set parameter value in GPO
        Args:
            path: Path to the parameter in GPO structure
            value: Value to set
        Returns:
            True if successful, False otherwise
        """
        logger.info(f"set method called with path: {path}, value: {value}")
        return self.data_store.set(path, value)

    @dbus.service.method('org.altlinux.GPUIService', in_signature='s', out_signature='as')
    def list_children(self, parent_path):
        """
        List child parameters under a parent path
        Args:
            parent_path: Parent path in GPO structure
        Returns:
            Array of child parameter paths
        """
        logger.info(f"list_children method called with parent_path: {parent_path}")
        return self.data_store.list_children(parent_path)

    @dbus.service.method('org.altlinux.GPUIService', in_signature='ss', out_signature='as')
    def find(self, search_pattern, search_type):
        """
        Find parameters matching search criteria
        Args:
            search_pattern: Pattern to search for
            search_type: Type of search (name, value, category, etc.)
        Returns:
            Array of matching parameter paths
        """
        logger.info(f"find method called with pattern: {search_pattern}, type: {search_type}")
        # TODO: Implement actual search functionality
        return []

    @dbus.service.method('org.altlinux.GPUIService', in_signature='as', out_signature='a{sv}')
    def get_set_values(self, paths):
        """
        Get current values and set new values for multiple parameters
        Args:
            paths: Array of parameter paths to get/set
        Returns:
            Dictionary with current values and status for each path
        """
        logger.info(f"get_set_values method called with paths: {paths}")
        results = {}
        for path in paths:
            value = self.data_store.get(path)
            if value is not None:
                results[path] = value
        return dbus.Dictionary(results, signature='sv')

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

class ServiceDaemon:
    """Main daemon class managing DBus service and GLib main loop"""

    def __init__(self, daemon_mode=True):
        self.daemon_mode = daemon_mode
        self.loop = None
        self.bus = None
        self.service = None
        self.data_store = None
        self.monitor = None
        self.shutdown_event = threading.Event()

    def setup_signal_handlers(self):
        """Setup signal handlers for graceful shutdown"""
        signal.signal(signal.SIGTERM, self.signal_handler)
        signal.signal(signal.SIGINT, self.signal_handler)

    def signal_handler(self, signum, frame):
        """Handle termination signals"""
        logger.info(f"Received signal {signum}, initiating shutdown...")
        self.shutdown_event.set()
        if self.loop:
            self.loop.quit()

    def setup_dbus(self):
        """Setup DBus connection and register service"""
        try:
            print("DEBUG: Setting DBus main loop...")
            dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
            print("DEBUG: Connecting to system bus...")
            self.bus = dbus.SystemBus()
            print(f"DEBUG: System bus connected: {self.bus}")

            # Request bus name
            print("DEBUG: Requesting bus name 'org.altlinux.gpuiservice'...")
            bus_name = dbus.service.BusName('org.altlinux.gpuiservice', self.bus)
            print(f"DEBUG: Bus name acquired: {bus_name}")

            # Create data store
            self.data_store = GPODataStore()

            # Create service object
            print("DEBUG: Creating GPUIService object...")
            self.service = GPUIService(bus_name, '/org/altlinux/gpuiservice', self.data_store)

            logger.info("DBus service registered successfully")
            print("DEBUG: DBus service registered successfully")
            return True
        except Exception as e:
            logger.error(f"Failed to setup DBus: {e}")
            print(f"DEBUG: DBus setup exception: {e}")
            import traceback
            traceback.print_exc()
            return False

    def setup_monitor(self):
        """Setup directory monitoring"""
        try:
            def on_reload():
                logger.info("Data reloaded from monitored directory")

            self.monitor = DirectoryMonitor(self.data_store, reload_callback=on_reload)
            self.monitor.start_monitoring()
            logger.info("Directory monitoring started")
            return True
        except Exception as e:
            logger.error(f"Failed to setup directory monitor: {e}")
            return False

    def run(self):
        """Main daemon run method"""
        print("DEBUG: ServiceDaemon.run() called")
        logger.info("Starting GPUIService daemon")

        # Setup signal handlers
        self.setup_signal_handlers()
        print("DEBUG: Signal handlers setup")

        # Setup DBus
        print("DEBUG: Setting up DBus...")
        if not self.setup_dbus():
            logger.error("Failed to setup DBus, exiting")
            print("DEBUG: DBus setup failed")
            return 1
        print("DEBUG: DBus setup successful")

        # Setup directory monitoring
        print("DEBUG: Setting up directory monitor...")
        if not self.setup_monitor():
            logger.warning("Directory monitoring setup failed, continuing without it")
        print("DEBUG: Directory monitor setup complete")

        # Create and run GLib main loop
        self.loop = GLib.MainLoop()

        # Run in background thread if in daemon mode
        if self.daemon_mode:
            loop_thread = threading.Thread(target=self.loop.run)
            loop_thread.daemon = True
            loop_thread.start()

            logger.info("Daemon running in background mode")

            # Wait for shutdown signal
            self.shutdown_event.wait()

            # Stop monitoring
            if self.monitor:
                self.monitor.stop_monitoring()

            # Quit the loop
            self.loop.quit()
            loop_thread.join(timeout=5)
        else:
            # Run in foreground
            logger.info("Running in foreground mode")
            try:
                self.loop.run()
            except KeyboardInterrupt:
                logger.info("Keyboard interrupt received")
            finally:
                if self.monitor:
                    self.monitor.stop_monitoring()
                self.loop.quit()

        logger.info("GPUIService daemon stopped")
        return 0

def main():
    """Main entry point"""
    print(f"DEBUG: Starting GPUIService, args: {sys.argv}")
    # Check if running as daemon (background mode)
    daemon_mode = '--foreground' not in sys.argv
    print(f"DEBUG: Daemon mode: {daemon_mode}")

    daemon = ServiceDaemon(daemon_mode=daemon_mode)

    return daemon.run()

if __name__ == '__main__':
    sys.exit(main())
