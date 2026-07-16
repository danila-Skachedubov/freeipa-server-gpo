PACKAGE_NAME = freeipa-server-gpo
VERSION = 0.0.8

PREFIX ?= /usr
DESTDIR =
PYTHON_SITELIBDIR = /usr/lib64/python3/site-packages
UI_PLUGIN_TARGET = $(DESTDIR)$(PREFIX)/share/ipa/ui/js/plugins/chain

.PHONY: all build install install-ui clean dist rpm compile-po

all: build

build: compile-po
	@echo "Building $(PACKAGE_NAME) $(VERSION)..."

compile-po:
	@find locale -name "*.po" -exec sh -c 'msgfmt "$$1" -o "$${1%.po}.mo"' _ {} \; 2>/dev/null || true

install: build install-ui
	@echo "Installing $(PACKAGE_NAME)..."

	# Main executable
	install -D -m 755 bin/ipa-gpo-install $(DESTDIR)$(PREFIX)/bin/ipa-gpo-install

	# Python modules
	install -d $(DESTDIR)$(PYTHON_SITELIBDIR)/ipa_gpo_install
	install -m 644 ipa_gpo_install/*.py $(DESTDIR)$(PYTHON_SITELIBDIR)/ipa_gpo_install/

	# IPA plugins
	install -D -m 644 plugin/ipaserver/plugins/gpo.py $(DESTDIR)$(PYTHON_SITELIBDIR)/ipaserver/plugins/gpo.py
	install -D -m 644 plugin/ipaserver/plugins/chain.py $(DESTDIR)$(PYTHON_SITELIBDIR)/ipaserver/plugins/chain.py
	install -D -m 644 plugin/ipaserver/plugins/gpmaster.py $(DESTDIR)$(PYTHON_SITELIBDIR)/ipaserver/plugins/gpmaster.py

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

install-ui:
	@echo "Installing IPA UI plugin..."
	install -D -m 644 plugin/ui/grouppolicy/chain.js $(UI_PLUGIN_TARGET)/chain.js
	install -D -m 644 plugin/ui/grouppolicy/gpo.js $(UI_PLUGIN_TARGET)/gpo.js
	rm -rf -- $(UI_PLUGIN_TARGET)/css $(UI_PLUGIN_TARGET)/img $(UI_PLUGIN_TARGET)/js
	cp -a plugin/ui/grouppolicy/css $(UI_PLUGIN_TARGET)/css
	cp -a plugin/ui/grouppolicy/img $(UI_PLUGIN_TARGET)/img
	cp -a plugin/ui/grouppolicy/js $(UI_PLUGIN_TARGET)/js

clean:
	find . -name "*.mo" -delete
	find . -name "*.pyc" -delete
