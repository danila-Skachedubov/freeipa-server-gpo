# freeipa-server-gpo Architecture

## 1. Overview

**freeipa-server-gpo** is a package that adds Group Policy Object
(GPO) management to FreeIPA on ALT Linux. The analog is Group Policy
Management Console (GPMC) in Microsoft Active Directory.

The package enables:

- Creating and deleting GPOs via web UI or CLI
- Editing administrative templates (ADMX) and preferences (GPP)
- Linking GPOs to user and computer groups via chains
- Managing policy application order
- Applying policies on clients via gpupdate

## 2. Components

```
┌──────────────┐   JSON-RPC    ┌──────────────────────────┐
│  Web Editor  │──────────────▶│  FreeIPA ipaserver       │
│  GPUI (JS)   │◀──────────────│  gpo.py / chain.py /     │
│              │               │  gpmaster.py (ipaapi)    │
└──────────────┘               └──────┬───────────┬───────┘
                                      │ D-Bus     │ LDAP
                                      ▼           ▼
┌──────────────────┐         ┌─────────────┐ ┌──────────────┐
│ ipa-gpo-install  │         │ oddjob      │ │ 389-DS       │
│ (installer)      │         │ (root)      │ │              │
│ - checks         │         │ create/del  │ │ groupPolicy* │
│ - SYSVOL+ACL     │         │ GPO in      │ │ objectClass  │
│ - schema         │         │ SYSVOL      │ │              │
└──────────────────┘         └──────┬──────┘ └──────────────┘
                                    │
     ┌──────────────────────────────┘
     ▼
┌──────────────────────────────────────────┐
│ /var/lib/freeipa/sysvol/<domain>/        │
│   Policies/{GUID}/Machine/Registry.pol   │
│   Policies/{GUID}/User/Registry.pol      │
│   Policies/{GUID}/GPT.INI                │
│   scripts/                               │
│ ACLs: ipaapi rwx on GPO, r-x on Policies │
└──────────────────────────────────────────┘

libadmix (Rust binding):
  gpo.py ──adm──▶ HighLevelApi ──▶ SYSVOL files
  state: /var/lib/freeipa/gpo-editor-state
  templates: /usr/share/PolicyDefinitions
```

### 2.1. ipa-gpo-install

CLI utility (`/usr/bin/ipa-gpo-install`). Runs on each domain
controller (DC). Performs:

1. **Checks** — Kerberos ticket, admin privileges, FreeIPA
   services, AD Trust, SYSVOL presence, LDAP schema.
2. **Schema extension** — applies `.ldif` files via
   `ipa-server-upgrade` (3 objectClasses, attributes).
3. **SYSVOL creation** — directories `sysvol/<domain>/Policies/`,
   `sysvol/<domain>/Chains/`, `sysvol/<domain>/scripts/`.
4. **ACL configuration** — permissions for `ipaapi` on SYSVOL.
5. **Samba share setup** — `SysVol` share for client access.
6. **Plugin activation** — oddjob restart.

Files: `ipa_gpo_install/{cli,checks,actions,config,filesystem}.py`

### 2.2. FreeIPA Plugins

Three modules in
`/usr/lib64/python3/site-packages/ipaserver/plugins/`.
Run inside the Apache/WSGI process as user `ipaapi`.

**gpo.py** (~2900 lines) — GPO CRUD + policy editor:
- `gpo_add` / `gpo_del` / `gpo_show` / `gpo_find` / `gpo_mod`
- `gpo_editor_*` (~20 commands) — manage ADMX policies,
  preferences, scripts via libadmix
- `_call_dbus_method()` — bridge to oddjob for SYSVOL operations
- `_load_admix()` — load the libadmix Rust binding

**chain.py** (~1000 lines) — policy chains:
- `chain_add` / `chain_del` / `chain_show` / `chain_find`
- `chain_enable` / `chain_disable` — manage active state
- `chain_add_gpo` / `chain_remove_gpo` — link GPOs to chain
- `chain_resolve_for_user` / `chain_resolve_for_host` — determine
  applicable policies for a client (called by gpupdate)

**gpmaster.py** (~500 lines) — configuration singleton:
- `gpmaster_show` — list of active chains (chainList)
- `gpmaster_mod` — add/remove/move chains
- `gpmaster_show_pdc` — PDC emulator

### 2.3. libadmix

Rust library (`python3-module-admix`). Replaces the former D-Bus
service `gpuiservice`. Called directly from the Apache process
via Python FFI.

- Parses ADMX/ADML templates
- Reads/writes Registry.pol
- Reads/writes GPP XML (preferences)
- Atomic publication: compare-and-modify via LDAP
- State: `/var/lib/freeipa/gpo-editor-state/` (mode 0700,
  owner ipaapi)

### 2.4. oddjob Handlers

Scripts in `/usr/libexec/ipa/oddjob/`. Run as **root** via
oddjobd/D-Bus. Perform privileged SYSVOL operations that `ipaapi`
cannot do directly:

- `org.freeipa.server.create-gpo-structure` — creates the GPO
  directory tree + GPT.INI + applies ACLs
- `org.freeipa.server.delete-gpo-structure` — removes the GPO
  directory tree

### 2.5. Web Editor GPUI

JavaScript SPA in `/usr/share/ipa/ui/js/plugins/chain/`. Loaded
as a FreeIPA Web UI plugin.

- `app.js` — main module, routing, tree navigation
- `API.js` — JSON-RPC client (~20 methods to gpo_editor_*)
- `preferences-view-template.js` — preferences editor
- `admx-template.js` — ADMX form rendering
- `tree-view-list.js` / `tree-view-list-data.js` — navigation tree
- `locales/{en,ru}.js` — localization

The UI never receives filesystem paths — only opaque identifiers
from the server.

## 3. LDAP Schema

All OIDs are under `1.3.6.1.4.1.9999` (needs replacement with a
registered IANA PEN).

### DIT Structure

```
$SUFFIX (e.g. dc=ipa,dc=test)
├── cn=etc
│   └── cn=grouppolicymaster              (groupPolicyMaster — singleton)
│       ├── pdcEmulator: dc1.ipa.test
│       └── chainList: cn=Prod,cn=Chains,...
│
└── cn=System
    ├── cn=Policies                        (nsContainer)
    │   └── cn={GUID}                     (groupPolicyContainer — GPO)
    │       ├── displayName: KDE Settings
    │       ├── gPCFileSysPath: \\...\SysVol\...\Policies\{GUID}
    │       └── versionNumber: 3
    │
    └── cn=Chains                          (nsContainer)
        └── cn=Production                 (groupPolicyChain)
            ├── description: Production chain
            ├── userGroup: cn=developers,...
            ├── computerGroup: cn=workstations,...
            └── gpLink: cn={GUID1},cn=Policies,...
```

### ObjectClasses

| objectClass | OID | Purpose | MUST | MAY |
|---|---|---|---|---|
| `groupPolicyContainer` | ...2.1.1 | GPO object | `cn` | `displayName`, `flags`, `gPCFileSysPath`, `gPCMachineExtensionNames`, `gPCUserExtensionNames`, `versionNumber` |
| `groupPolicyChain` | ...2.1.3 | Chain (GPO → groups) | `cn` | `userGroup`, `computerGroup`, `gpLink`, `description` |
| `groupPolicyMaster` | ...2.1.2 | PDC + chainList | `cn`, `pdcEmulator` | `chainList` |

### Chain Attributes

| Attribute | Type | Description |
|---|---|---|
| `cn` | Str | Chain name (primary_key) |
| `description` | Str | Description (optional) |
| `userGroup` | DN | User group |
| `computerGroup` | DN | Computer group |
| `gpLink` | DN (multi) | Ordered list of GPOs |

The "active/inactive" status is **not stored in LDAP** — it is
computed dynamically based on whether the chain appears in the
`chainList` attribute of the `groupPolicyMaster` object.

### Referential Integrity

The `gpLink`, `userGroup`, `computerGroup`, and `chainList`
attributes are registered with the 389-DS referential integrity
plugin (`plugin/update/75-chain.update`, `75-gpmaster.update`).
When an object is deleted or renamed, references are automatically
cleaned up.

## 4. SYSVOL Structure

```
/var/lib/freeipa/sysvol/<domain>/
├── Policies/
│   ├── {GUID1}/
│   │   ├── GPT.INI                    (version, displayName)
│   │   ├── Machine/
│   │   │   ├── Registry.pol           (administrative templates)
│   │   │   ├── Scripts/
│   │   │   │   ├── scripts.ini        (Startup/Shutdown)
│   │   │   │   └── psscripts.ini      (PS Startup/Shutdown)
│   │   │   └── Preferences/
│   │   │       ├── Files/Files.xml
│   │   │       ├── Folders/Folders.xml
│   │   │       ├── Shortcuts/Shortcuts.xml
│   │   │       └── ...
│   │   ├── User/
│   │   │   ├── Registry.pol
│   │   │   └── Preferences/...
│   │   └── comment.cmtx               (policy comments)
│   └── {GUID2}/ ...
└── scripts/                            (shared scripts)
```

The Samba share `SysVol` exports this directory for clients:
`\\<dc>\SysVol\<domain>\Policies\...`

### Access Control (ACL)

| Path | Access ACL | Default ACL | Who |
|---|---|---|---|
| `Policies/` | `u:ipaapi:r-x` | `d:u:ipaapi:rwx` | ipaapi (read-only on root) |
| `Policies/{GUID}/` | `u:ipaapi:rwx` | `d:u:ipaapi:rwx` | ipaapi (full access) |
| `Policies/{GUID}/Machine/` | `u:ipaapi:rwx` | `d:u:ipaapi:rwx` | ipaapi |
| `Policies/{GUID}/User/` | `u:ipaapi:rwx` | `d:u:ipaapi:rwx` | ipaapi |
| `gpo-editor-state/` | mode 0700 | — | ipaapi:ipaapi |

Principle: `ipaapi` can edit GPO contents but cannot create/delete
GPO directories themselves (that is done by oddjob as root).

Policy files (Registry.pol, XML, INI) are created by libadmix with
mode `0644` — clients can read them via SMB.

## 5. Data Flows

### 5.1. Creating a GPO

```
Admin (Web/CLI)
  │
  ▼
gpo_add(displayname="KDE Settings")
  │
  ├── LDAP: creates cn={GUID},cn=Policies,cn=System
  │         cn = random UUID
  │         gpcfilesyspath = \\domain\SysVol\...\{GUID}
  │         versionNumber = 0
  │
  └── D-Bus → oddjob (root):
              mkdir Policies/{GUID}/
              mkdir Policies/{GUID}/Machine/
              mkdir Policies/{GUID}/User/
              write GPT.INI
              setfacl (ipaapi rwx)
```

### 5.2. Editing a Policy

```
Admin (Web UI)
  │
  ▼
gpo_editor_policy_update(displayname, scope, policy_id, request)
  │
  ├── Authorization: ACI can_write on gPCFileSysPath
  ├── Resolution: displayname → GUID → SYSVOL path
  │
  ├── libadmix HighLevelApi:
  │     ├── read Registry.pol
  │     ├── apply changes (in memory)
  │     └── atomic write to SYSVOL
  │
  ├── LDAP compare-and-modify:
  │     versionNumber++ (only if LDAP version matches)
  │
  └── Response → Web UI
```

### 5.3. Applying on Client

```
Client (gpupdate)
  │
  ├── LDAP: chain_resolve_for_host(hostname)
  │         → GPMaster.chainList
  │         → filter by computerGroup
  │         → collect gpLink (GPOs in order)
  │         → [{name, file_sys_path, version}, ...]
  │
  ├── SMB: \\dc\SysVol\domain\Policies\{GUID}\Machine\Registry.pol
  │
  └── Apply policies locally
```

### 5.4. Deleting a GPO

```
Admin (Web/CLI)
  │
  ▼
gpo_del(displayname)
  │
  ├── LDAP: removes cn={GUID},cn=Policies,cn=System
  │         (referential integrity cleans gpLink in chains)
  │
  └── D-Bus → oddjob (root):
              rmtree Policies/{GUID}/
```

## 6. Multi-DC

### LDAP Replication

LDAP data (GPOs, chains, chainList) replicates automatically via
389-DS multi-master replication. Changes on one DC propagate to
all replicas.

### SYSVOL Replication — NOT Implemented

Policy files (Registry.pol, GPT.INI, preferences) are stored
locally on each DC. **Synchronization between DCs is not
implemented.**

Risks:
- Creating a GPO on DC1 → files exist only on DC1
- Client receiving policy from DC2 → `Permission denied`

**PDC Emulator.** The schema includes
`groupPolicyMaster.pdcEmulator`, but write redirect to PDC
**is not implemented**. The administrator must manually open
the PDC emulator's web UI.

Plans:
1. PDC redirect in `gpo_set_policy` (write only to PDC)
2. SYSVOL replication (rsync/DFS-R/shared FS)

## 7. Security

### Permissions (PBAC)

The `Group Policy Administrators` group (created during
installation) has Add/Modify/Delete rights on all three
objectClasses.

### Editor Authorization

Before each modification via libadmix, `can_write` is checked
on `gPCFileSysPath` and `versionNumber`.

### Filesystem Protection

- `ipaapi` cannot create directories in `Policies/` (r-x)
- Symlink attacks are prevented via `O_NOFOLLOW` and `resolve()`
- Path traversal is checked via `commonpath()`

### Sanitization

Server paths (`/var/lib/freeipa/...`) are not sent to the web UI —
replaced with `<server-path>` in diagnostics.

### Scripts

Maximum uploaded script size — 16 MiB.
Names are validated against path traversal (`/`, `\`, `..`).
