# Архитектура freeipa-server-gpo

## 1. Обзор

**freeipa-server-gpo** — пакет, добавляющий управление групповыми
политиками (Group Policy Objects, GPO) в FreeIPA на базе ALT Linux.
Аналог — Group Policy Management Console (GPMC) в Microsoft Active
Directory.

Пакет позволяет:

- Создавать и удалять GPO через веб-интерфейс или CLI
- Редактировать административные шаблоны (ADMX) и preferences (GPP)
- Связывать GPO с группами пользователей и компьютеров через цепочки
- Управлять порядком применения политик
- Применять политики на клиентах через gpupdate

## 2. Компоненты

```
┌──────────────┐   JSON-RPC    ┌──────────────────────────┐
│  Веб-редактор│──────────────▶│  FreeIPA ipaserver       │
│  GPUI (JS)   │◀──────────────│  gpo.py / chain.py /     │
│              │               │  gpmaster.py (ipaapi)    │
└──────────────┘               └──────┬───────────┬───────┘
                                      │ D-Bus     │ LDAP
                                      ▼           ▼
┌──────────────────┐         ┌─────────────┐ ┌──────────────┐
│ ipa-gpo-install  │         │ oddjob      │ │ 389-DS       │
│ (установщик)     │         │ (root)      │ │              │
│ - проверки       │         │ create/del  │ │ groupPolicy* │
│ - SYSVOL+ACL     │         │ GPO в       │ │ objectClass  │
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
│ ACLs: ipaapi rwx на GPO, r-x на Policies │
└──────────────────────────────────────────┘

libadmix (Rust binding):
  gpo.py ──adm──▶ HighLevelApi ──▶ SYSVOL файлы
  состояние: /var/lib/freeipa/gpo-editor-state
  шаблоны: /usr/share/PolicyDefinitions
```

### 2.1. ipa-gpo-install

CLI-утилита (`/usr/bin/ipa-gpo-install`). Запускается на каждом
контроллере домена (DC). Выполняет:

1. **Проверки** — Kerberos-тикет, права администратора, сервисы
   FreeIPA, AD Trust, наличие SYSVOL, схема LDAP.
2. **Расширение схемы** — применяет `.ldif` файлы через
   `ipa-server-upgrade` (3 objectClass, атрибуты).
3. **Создание SYSVOL** — директории `sysvol/<domain>/Policies/`,
   `sysvol/<domain>/Chains/`, `sysvol/<domain>/scripts/`.
4. **Настройка ACL** — права для `ipaapi` на SYSVOL.
5. **Создание Samba-share** — `SysVol` для доступа клиентов.
6. **Активация плагинов** — перезапуск oddjob.

Файлы: `ipa_gpo_install/{cli,checks,actions,config,filesystem}.py`

### 2.2. FreeIPA-плагины

Три модуля в `/usr/lib64/python3/site-packages/ipaserver/plugins/`.
Работают в процессе Apache/WSGI под пользователем `ipaapi`.

**gpo.py** (~2900 строк) — CRUD GPO + редактор политик:
- `gpo_add` / `gpo_del` / `gpo_show` / `gpo_find` / `gpo_mod`
- `gpo_editor_*` (~20 команд) — управление ADMX-политиками,
  preferences, скриптами через libadmix
- `_call_dbus_method()` — мост к oddjob для операций с SYSVOL
- `_load_admix()` — загрузка Rust-биндинга libadmix

**chain.py** (~1000 строк) — цепочки политик:
- `chain_add` / `chain_del` / `chain_show` / `chain_find`
- `chain_enable` / `chain_disable` — управление активностью
- `chain_add_gpo` / `chain_remove_gpo` — привязка GPO к цепочке
- `chain_resolve_for_user` / `chain_resolve_for_host` — определение
  применимых политик для клиента (вызывается gpupdate)

**gpmaster.py** (~500 строк) — синглтон конфигурации:
- `gpmaster_show` — список активных цепочек (chainList)
- `gpmaster_mod` — add/remove/move цепочек
- `gpmaster_show_pdc` — PDC-эмулятор

### 2.3. libadmix

Rust-библиотека (`python3-module-admix`). Заменяет бывший D-Bus
сервис `gpuiservice`. Вызывается напрямую из процесса Apache
через Python FFI.

- Парсинг ADMX/ADML шаблонов
- Чтение/запись Registry.pol
- Чтение/запись GPP XML (preferences)
- Атомарная публикация: compare-and-modify через LDAP
- Состояние: `/var/lib/freeipa/gpo-editor-state/` (mode 0700,
  owner ipaapi)

### 2.4. oddjob handlers

Скрипты в `/usr/libexec/ipa/oddjob/`. Запускаются от **root** через
oddjobd/D-Bus. Выполняют привилегированные операции с SYSVOL,
которые `ipaapi` не может сделать напрямую:

- `org.freeipa.server.create-gpo_structure` — создаёт дерево
  директорий GPO + GPT.INI + выставляет ACL
- `org.freeipa.server.delete-gpo-structure` — удаляет дерево GPO

### 2.5. Веб-редактор GPUI

JavaScript SPA в `/usr/share/ipa/ui/js/plugins/chain/`. Загружается
как плагин FreeIPA Web UI.

- `app.js` — главный модуль, роутинг, навигация по дереву
- `API.js` — JSON-RPC клиент (~20 методов к gpo_editor_*)
- `preferences-view-template.js` — редактор preferences
- `admx-template.js` — рендеринг ADMX-форм
- `tree-view-list.js` / `tree-view-list-data.js` — дерево навигации
- `locales/{en,ru}.js` — локализация

UI не получает путей файловой системы — только непрозрачные
идентификаторы от сервера.

## 3. LDAP-схема

Все OID под `1.3.6.1.4.1.9999` (требует замены на зарегистрированный
PEN IANA).

### DIT-структура

```
$SUFFIX (например dc=ipa,dc=test)
├── cn=etc
│   └── cn=grouppolicymaster              (groupPolicyMaster — синглтон)
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

| objectClass | OID | Назначение | MUST | MAY |
|---|---|---|---|---|
| `groupPolicyContainer` | ...2.1.1 | GPO-объект | `cn` | `displayName`, `flags`, `gPCFileSysPath`, `gPCMachineExtensionNames`, `gPCUserExtensionNames`, `versionNumber` |
| `groupPolicyChain` | ...2.1.3 | Цепочка (GPO → группы) | `cn` | `userGroup`, `computerGroup`, `gpLink`, `description` |
| `groupPolicyMaster` | ...2.1.2 | PDC + chainList | `cn`, `pdcEmulator` | `chainList` |

### Атрибуты цепочек

| Атрибут | Тип | Описание |
|---------|-----|----------|
| `cn`    | Str | Имя цепочки (primary_key) |
| `description` | Str | Описание (опциональное) |
| `userGroup` | DN | Группа пользователей |
| `computerGroup` | DN | Группа компьютеров |
| `gpLink` | DN (multi) | Упорядоченный список GPO |

Статус «активна/неактивна» **не хранится в LDAP** — вычисляется
динамически по присутствию цепочки в `chainList` объекта
`groupPolicyMaster`.

### Referential Integrity

Атрибуты `gpLink`, `userGroup`, `computerGroup`, `chainList`
зарегистрированы в плагине referential integrity 389-DS
(`plugin/update/75-chain.update`, `75-gpmaster.update`). При
удалении/переименовании объекта ссылки автоматически очищаются.

## 4. Структура SYSVOL

```
/var/lib/freeipa/sysvol/<domain>/
├── Policies/
│   ├── {GUID1}/
│   │   ├── GPT.INI                    (версия, displayName)
│   │   ├── Machine/
│   │   │   ├── Registry.pol           (административные шаблоны)
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
│   │   └── comment.cmtx               (комментарии политик)
│   └── {GUID2}/ ...
└── scripts/                            (общие скрипты)
```

Samba-share `SysVol` экспортирует эту директорию для клиентов:
`\\<dc>\SysVol\<domain>\Policies\...`

### Права доступа (ACL)

| Путь | Access ACL | Default ACL | Кто |
|---|---|---|---|
| `Policies/` | `u:ipaapi:r-x` | `d:u:ipaapi:rwx` | ipaapi (read-only на корень) |
| `Policies/{GUID}/` | `u:ipaapi:rwx` | `d:u:ipaapi:rwx` | ipaapi (полный доступ) |
| `Policies/{GUID}/Machine/` | `u:ipaapi:rwx` | `d:u:ipaapi:rwx` | ipaapi |
| `Policies/{GUID}/User/` | `u:ipaapi:rwx` | `d:u:ipaapi:rwx` | ipaapi |
| `gpo-editor-state/` | mode 0700 | — | ipaapi:ipaapi |

Принцип: `ipaapi` может редактировать содержимое GPO, но не может
создавать/удалять сами директории GPO (это делает oddjob от root).

Файлы политик (Registry.pol, XML, INI) создаются libadmix с правами
`0644` — клиенты могут читать через SMB.

## 5. Потоки данных

### 5.1. Создание GPO

```
Админ (Web/CLI)
  │
  ▼
gpo_add(displayname="KDE Settings")
  │
  ├── LDAP: создаёт cn={GUID},cn=Policies,cn=System
  │         cn = случайный UUID
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

### 5.2. Редактирование политики

```
Админ (Web UI)
  │
  ▼
gpo_editor_policy_update(displayname, scope, policy_id, request)
  │
  ├── Авторизация: ACI can_write на gPCFileSysPath
  ├── Резолвинг: displayname → GUID → SYSVOL путь
  │
  ├── libadmix HighLevelApi:
  │     ├── чтение Registry.pol
  │     ├── применение изменений (в памяти)
  │     └── атомарная запись в SYSVOL
  │
  ├── LDAP compare-and-modify:
  │     versionNumber++ (только если LDAP-версия совпадает)
  │
  └── Ответ → Web UI
```

### 5.3. Применение на клиенте

```
Клиент (gpupdate)
  │
  ├── LDAP: chain_resolve_for_host(hostname)
  │         → GPMaster.chainList
  │         → фильтр по computerGroup
  │         → сбор gpLink (GPO в порядке)
  │         → [{name, file_sys_path, version}, ...]
  │
  ├── SMB: \\dc\SysVol\domain\Policies\{GUID}\Machine\Registry.pol
  │
  └── Применение политик локально
```

### 5.4. Удаление GPO

```
Админ (Web/CLI)
  │
  ▼
gpo_del(displayname)
  │
  ├── LDAP: удаляет cn={GUID},cn=Policies,cn=System
  │         (referential integrity очищает gpLink в цепочках)
  │
  └── D-Bus → oddjob (root):
              rmtree Policies/{GUID}/
```

## 6. Мульти-DC

### LDAP-репликация

LDAP-данные (GPO, цепочки, chainList) реплицируются автоматически
через 389-DS multi-master replication. Изменения на одном DC
распространяются на все реплики.

### SYSVOL-репликация — НЕ реализована

Файлы политик (Registry.pol, GPT.INI, preferences) хранятся
локально на каждом DC. **Синхронизация между DC отсутствует.**

Риски:
- Создание GPO на DC1 → файлы только на DC1
- Клиент, получивший политику с DC2 → `Permission denied`

**PDC-эмулятор.** В схеме есть `groupPolicyMaster.pdcEmulator`,
но redirect записи на PDC **не реализован**. Администратор должен
вручную открывать веб-интерфейс PDC-эмулятора.

Планы:
1. PDC-redirect в `gpo_set_policy` (запись только на PDC)
2. Репликация SYSVOL (rsync/DFS-R/общая ФС)

## 7. Безопасность

### Права (PBAC)

Группа `Group Policy Administrators` (создаётся при установке)
имеет права Add/Modify/Delete на все три objectClass.

### Авторизация редактора

Перед каждым изменением через libadmix проверяется
`can_write` на `gPCFileSysPath` и `versionNumber`.

### Защита файловой системы

- `ipaapi` не может создавать директории в `Policies/` (r-x)
- Symlink-атаки предотвращаются через `O_NOFOLLOW` и `resolve()`
- Path traversal проверяется через `commonpath()`

### Санитизация

Серверные пути (`/var/lib/freeipa/...`) не передаются в
веб-интерфейс — заменяются на `<server-path>` в diagnostics.

### Скрипты

Размер загружаемого скрипта — максимум 16 МиБ.
Имена проверяются на path traversal (`/`, `\`, `..`).
