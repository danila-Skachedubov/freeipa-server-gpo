PACKAGE_NAME = ipa-gpo-install
VERSION = 0.0.1

PREFIX ?= /usr
DESTDIR =
PYTHON_SITELIBDIR = /usr/lib64/python3/site-packages

.PHONY: all build install clean dist rpm compile-po

all: build

build: compile-po
	@echo "Building $(PACKAGE_NAME) $(VERSION)..."

compile-po:
	@find locale -name "*.po" -exec sh -c 'msgfmt "$$1" -o "$${1%.po}.mo"' _ {} \; 2>/dev/null || true

install: build
	@echo "Installing $(PACKAGE_NAME)..."

	# Main executable
	install -D -m 755 bin/$(PACKAGE_NAME) $(DESTDIR)$(PREFIX)/bin/$(PACKAGE_NAME)

	# Python modules
	@mkdir -p $(DESTDIR)$(PYTHON_SITELIB)
	cp -r ipa_gpo_install $(DESTDIR)$(PYTHON_SITELIB)/

	# IPA plugins
	install -D -m 644 plugin/ipaserver/plugins/gpo.py $(DESTDIR)$(PYTHON_SITELIB)/ipaserver/plugins/gpo.py
	install -D -m 644 plugin/ipaserver/plugins/chain.py $(DESTDIR)$(PYTHON_SITELIB)/ipaserver/plugins/chain.py
	install -D -m 644 plugin/ipaserver/plugins/gpmaster.py $(DESTDIR)$(PYTHON_SITELIB)/ipaserver/plugins/gpmaster.py

	# IPA UI plugins
	install -D -m 644 plugin/ui/grouppolicy/chain.js $(DESTDIR)$(PREFIX)/share/ipa/ui/js/plugins/grouppolicy/chain.js
	install -D -m 644 plugin/ui/grouppolicy/gpo.js $(DESTDIR)$(PREFIX)/share/ipa/ui/js/plugins/grouppolicy/gpo.js

	# IPA schemas and updates
	@for schema in plugin/schema.d/*.ldif; do \
		install -D -m 644 "$$schema" "$(DESTDIR)$(PREFIX)/share/ipa/schema.d/$$(basename $$schema)"; \
	done
	@for update in plugin/update/*.update; do \
		install -D -m 644 "$$update" "$(DESTDIR)$(PREFIX)/share/ipa/updates/$$(basename $$update)"; \
	done

	# DBUS configuration and handlers
	install -D -m 644 plugin/dbus_handlers/ipa-gpo.conf $(DESTDIR)/etc/oddjobd.conf.d/ipa-gpo.conf	
	install -D -m 755 plugin/dbus_handlers/org.freeipa.server.create-gpo-structure $(DESTDIR)$(PREFIX)/libexec/ipa/oddjob/org.freeipa.server.create-gpo-structure
	install -D -m 755 plugin/dbus_handlers/org.freeipa.server.delete-gpo-structure $(DESTDIR)$(PREFIX)/libexec/ipa/oddjob/org.freeipa.server.delete-gpo-structure

	# Documentation
	install -D -m 644 doc/$(PACKAGE_NAME).8 $(DESTDIR)$(PREFIX)/share/man/man8/$(PACKAGE_NAME).8
	install -D -m 644 doc/ru/$(PACKAGE_NAME).8 $(DESTDIR)$(PREFIX)/share/man/ru/man8/$(PACKAGE_NAME).8

	# Bash completion
	install -D -m 644 completions/$(PACKAGE_NAME) $(DESTDIR)$(PREFIX)/share/bash-completion/completions/$(PACKAGE_NAME)

	# Translations
	@for mo_file in locale/*/LC_MESSAGES/*.mo; do \
		if [ -f "$$mo_file" ]; then \
			locale_dir=$$(echo $$mo_file | sed 's|locale/||' | sed 's|/LC_MESSAGES/.*||'); \
			install -D -m 644 "$$mo_file" "$(DESTDIR)$(PREFIX)/share/locale/$$locale_dir/LC_MESSAGES/$(PACKAGE_NAME).mo"; \
		fi; \
	done

clean:
	find . -name "*.mo" -delete
	find . -name "*.pyc" -delete