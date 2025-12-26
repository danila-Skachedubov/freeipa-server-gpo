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
import logging
import logging.handlers

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

from daemon import ServiceDaemon

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