Name:           ipa-gpo-install
Version:        0.0.1
Release:        alt1

Summary:        Prepare FreeIPA for Group Policy Management
License:        GPLv3+
Group:          System/Configuration/Other
Url:            https://github.com/danila-Skachedubov/ipa-gpo-install
ExcludeArch: %ix86

BuildRequires: rpm-build-python3
BuildRequires: gettext-tools

Requires: python3-module-freeipa
Requires: python3-module-ipaserver
Requires: freeipa-server-trust-ad
Requires: samba-common-tools
Source0: %name-%version.tar

%description
A utility for preparing FreeIPA for Group Policy Management.
Extends the LDAP schema with Group Policy related object classes
and creates the necessary directory structure.

%prep
%setup -q

%build
%make_build compile-po

%install
make install PREFIX=%{_prefix} DESTDIR=%{buildroot} PYTHON_SITELIB=%{python3_sitelibdir}


%files
%doc README.md
%{_bindir}/%{name}
%{python3_sitelibdir}/ipa_gpo_install/
%{python3_sitelibdir}/ipaserver/plugins/gpc.py*
%{python3_sitelibdir}/ipaserver/plugins/chain.py*
%{python3_sitelibdir}/ipaserver/plugins/gpmaster.py*
%{_datadir}/ipa/schema.d/75-gpc.ldif
%{_datadir}/ipa/schema.d/75-chain.ldif
%{_datadir}/ipa/schema.d/75-gpmaster.ldif
%{_datadir}/ipa/updates/75-gpc.update
%{_datadir}/ipa/updates/75-chain.update
%{_datadir}/ipa/updates/75-gpmaster.update
%config(noreplace) %{_sysconfdir}/oddjobd.conf.d/ipa-gpo.conf
%{_prefix}/libexec/ipa/oddjob/org.freeipa.server.create-gpo-structure
%{_prefix}/libexec/ipa/oddjob/org.freeipa.server.delete-gpo-structure
%{_mandir}/man8/%{name}.8*
%{_mandir}/ru/man8/%{name}.8*
%{_datadir}/bash-completion/completions/%{name}
%{_datadir}/locale/*/LC_MESSAGES/%{name}.mo

%changelog
* Wed Apr 16 2025 Danila Skachedubov <skachedubov@altlinux.org> 0.0.1-alt1
- Initial build
