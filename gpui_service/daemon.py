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
ServiceDaemon - Main daemon class managing DBus service and GLib main loop
"""

import sys
import signal
import threading
import traceback
from gi.repository import GLib
import dbus
import dbus.mainloop.glib
import logging

try:
    from .datastore import GPODataStore
    from .monitor import DirectoryMonitor
    from .service import GPUIService
except ImportError:
    from datastore import GPODataStore
    from monitor import DirectoryMonitor
    from service import GPUIService

logger = logging.getLogger('gpuiservice')

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
            self.data_store_dict = self.data_store.load_from_directory()

            print('self.data_store_dict', type(self.data_store))

            # Create service object
            print("DEBUG: Creating GPUIService object...")
            self.service = GPUIService(bus_name, '/org/altlinux/gpuiservice', self.data_store)

            logger.info("DBus service registered successfully")
            print("DEBUG: DBus service registered successfully")
            return True
        except Exception as e:
            logger.error(f"Failed to setup DBus: {e}")
            print(f"DEBUG: DBus setup exception: {e}")
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
