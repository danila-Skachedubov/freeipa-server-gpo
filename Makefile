PACKAGE_NAME = freeipa-server-gpo
VERSION = 0.0.3

PREFIX ?= /usr
DESTDIR =
PYTHON_SITELIBDIR = /usr/lib64/python3/site-packages
STAGING_DIR = $(PREFIX)/share/freeipa-server-gpo/staging

.PHONY: all build install clean dist rpm compile-po

all: build

build: compile-po
	@echo "Building $(PACKAGE_NAME) $(VERSION)..."

compile-po:
	@find locale -name "*.po" -exec sh -c 'msgfmt "$$1" -o "$${1%.po}.mo"' _ {} \; 2>/dev/null || true

install: build
	@echo "Installing $(PACKAGE_NAME)..."

	# Main executable
	install -D -m 755 bin/ipa-gpo-install $(DESTDIR)$(PREFIX)/bin/ipa-gpo-install

	# Python modules
	@mkdir -p $(DESTDIR)$(PYTHON_SITELIBDIR)
	cp -r ipa_gpo_install $(DESTDIR)$(PYTHON_SITELIBDIR)/

	# IPA plugins (staged)
	install -D -m 644 plugin/ipaserver/plugins/gpo.py $(DESTDIR)$(STAGING_DIR)/plugin/ipaserver/plugins/gpo.py
	install -D -m 644 plugin/ipaserver/plugins/chain.py $(DESTDIR)$(STAGING_DIR)/plugin/ipaserver/plugins/chain.py
	install -D -m 644 plugin/ipaserver/plugins/gpmaster.py $(DESTDIR)$(STAGING_DIR)/plugin/ipaserver/plugins/gpmaster.py

	# IPA UI plugins (staged)
	install -D -m 644 plugin/ui/grouppolicy/chain.js $(DESTDIR)$(STAGING_DIR)/plugin/ui/grouppolicy/chain.js
	install -D -m 644 plugin/ui/grouppolicy/gpo.js $(DESTDIR)$(STAGING_DIR)/plugin/ui/grouppolicy/gpo.js

	# IPA schemas and updates (staged)
	@for schema in plugin/schema.d/*.ldif; do \
		install -D -m 644 "$$schema" "$(DESTDIR)$(STAGING_DIR)/plugin/schema.d/$$(basename $$schema)"; \
	done
	@for update in plugin/update/*.update; do \
		install -D -m 644 "$$update" "$(DESTDIR)$(STAGING_DIR)/plugin/update/$$(basename $$update)"; \
	done

	# DBUS configuration and handlers (staged)
	install -D -m 644 plugin/dbus_handlers/ipa-gpo.conf $(DESTDIR)$(STAGING_DIR)/plugin/dbus_handlers/ipa-gpo.conf
	install -D -m 755 plugin/dbus_handlers/org.freeipa.server.create-gpo-structure $(DESTDIR)$(STAGING_DIR)/plugin/dbus_handlers/org.freeipa.server.create-gpo-structure
	install -D -m 755 plugin/dbus_handlers/org.freeipa.server.delete-gpo-structure $(DESTDIR)$(STAGING_DIR)/plugin/dbus_handlers/org.freeipa.server.delete-gpo-structure
	install -D -m 755 plugin/dbus_handlers/org.freeipa.server.parse-admx-structure $(DESTDIR)$(STAGING_DIR)/plugin/dbus_handlers/org.freeipa.server.parse-admx-structure

	# Documentation
	install -D -m 644 doc/ipa-gpo-install.8 $(DESTDIR)$(PREFIX)/share/man/man8/ipa-gpo-install.8
	install -D -m 644 doc/ru/ipa-gpo-install.8 $(DESTDIR)$(PREFIX)/share/man/ru/man8/ipa-gpo-install.8

	# Bash completion
	install -D -m 644 completions/ipa-gpo-install $(DESTDIR)$(PREFIX)/share/bash-completion/completions/ipa-gpo-install

	# Translations
	@for mo_file in locale/*/LC_MESSAGES/ipa-gpo-install.mo; do \
		if [ -f "$$mo_file" ]; then \
			locale_dir=$$(echo $$mo_file | sed 's|locale/||' | sed 's|/LC_MESSAGES/.*||'); \
			install -D -m 644 "$$mo_file" "$(DESTDIR)$(PREFIX)/share/locale/$$locale_dir/LC_MESSAGES/ipa-gpo-install.mo"; \
		fi; \
	done

clean:
	find . -name "*.mo" -delete
	find . -name "*.pyc" -delete