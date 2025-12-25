#!/usr/bin/env python3
"""
GPUIService - DBus service for GPO editing functionality
Analog of gpedit.msc for Linux infrastructure based on FreeIPA
"""

import sys
import signal
import logging
import logging.handlers
import asyncio
import threading
from gi.repository import GLib
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

class GPUIService(dbus.service.Object):
    """
    DBus service for GPO editing functionality
    Provides API for editing existing GPO parameters without creating new policy objects
    """

    def __init__(self, bus_name, object_path):
        super().__init__(bus_name, object_path)
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
        # TODO: Implement actual GPO parameter retrieval
        return dbus.Dictionary({}, signature='sv')

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
        # TODO: Implement actual GPO parameter setting
        return True

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
        # TODO: Implement actual child listing
        return []

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
        # TODO: Implement batch get/set functionality
        return dbus.Dictionary({}, signature='sv')

class ServiceDaemon:
    """Main daemon class managing DBus service and GLib main loop"""

    def __init__(self, daemon_mode=True):
        self.daemon_mode = daemon_mode
        self.loop = None
        self.bus = None
        self.service = None
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

            # Create service object
            print("DEBUG: Creating GPUIService object...")
            self.service = GPUIService(bus_name, '/org/altlinux/gpuiservice')

            logger.info("DBus service registered successfully")
            print("DEBUG: DBus service registered successfully")
            return True
        except Exception as e:
            logger.error(f"Failed to setup DBus: {e}")
            print(f"DEBUG: DBus setup exception: {e}")
            import traceback
            traceback.print_exc()
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
