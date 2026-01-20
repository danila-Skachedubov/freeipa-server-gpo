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
DirectoryMonitor - Monitor directory for ADMX file changes and reload data
"""

from pathlib import Path
from gi.repository import Gio
import logging

logger = logging.getLogger('gpuiservice')

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
            logger.debug(f"Could not load dconf settings: {e}")

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
                logger.debug(f"Could not read monitor-path from dconf: {e}")

        logger.info(f"Using default monitor path: {default_path}")
        return default_path

    def get_sysvol_path(self):
        """Get FreeIPA sysvol path from dconf or use default"""
        default_path = '/var/lib/freeipa/sysvol'

        if self.settings:
            try:
                path = self.settings.get_string('sysvol-path')
                if path:
                    logger.info(f"Using sysvol path from dconf: {path}")
                    return path
            except Exception as e:
                logger.debug(f"Could not read sysvol-path from dconf: {e}")

        logger.info(f"Using default sysvol path: {default_path}")
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