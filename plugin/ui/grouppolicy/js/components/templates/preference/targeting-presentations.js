/**
 * Presentation-only adapters for the 29 native item-level targeting kinds.
 *
 * Tokens and numeric widths follow the active libadmix/gpreface schemas. They
 * are not new persistence types: selectors retain each native field envelope.
 * Sources: MS-GPPREF 2.2.1.22 and Appendix A, plus the GPMC targeting help.
 */
define([], function() {
    'use strict';

    function pair(en, ru) { return [en, ru]; }
    var kinds = {
        battery: pair('Battery', 'Наличие батареи'),
        computer: pair('Computer name', 'Имя компьютера'),
        cpu: pair('CPU speed', 'Скорость ЦП'),
        date: pair('Date match', 'Сопоставление дат'),
        disk: pair('Disk space', 'Место на диске'),
        domain: pair('Domain', 'Домен'),
        dun: pair('Network connection', 'Сетевое подключение'),
        file: pair('File match', 'Соответствие файлов'),
        ip_range: pair('IP address range', 'Диапазон IP-адресов'),
        language: pair('Language', 'Язык'),
        ldap: pair('LDAP query', 'Запрос LDAP'),
        mac_range: pair('MAC address range', 'Диапазон MAC-адресов'),
        msi: pair('MSI query', 'Запрос MSI'),
        org_unit: pair('Organizational unit', 'Подразделение'),
        pcmcia: pair('PCMCIA present', 'Присутствие PCMCIA'),
        portable: pair('Portable computer', 'Переносной компьютер'),
        proc_mode: pair('Processing mode', 'Режим обработки'),
        ram: pair('RAM', 'Оперативная память'),
        run_once: pair('Run once', 'Однократное выполнение'),
        site: pair('Site', 'Сайт'),
        terminal: pair('Terminal session', 'Терминальный сеанс'),
        time: pair('Time range', 'Диапазон времени'),
        user: pair('User', 'Пользователь'),
        variable: pair('Environment variable', 'Переменная среды'),
        os: pair('Operating system', 'Операционная система'),
        registry: pair('Registry match', 'Сопоставление реестра'),
        wmi: pair('WMI query', 'Запрос WMI'),
        group: pair('Security group', 'Группа безопасности'),
        collection: pair('Collection', 'Коллекция')
    };

    // Only specific operands belong here. bool/not/hidden are toolbar or
    // preserved metadata, never ordinary inputs in the lower operand pane.
    var fields = {
        battery: {},
        computer: {
            type: pair('Name type', 'Тип имени'),
            name: pair('Computer name', 'Имя компьютера')
        },
        cpu: { speedMHz: pair('Minimum CPU speed (MHz)', 'Минимальная скорость ЦП (МГц)') },
        date: {
            period: pair('Period', 'Период'),
            dow: pair('Day of week', 'День недели'),
            day: pair('Day of month', 'Число месяца'),
            month: pair('Month', 'Месяц'),
            year: pair('Year', 'Год')
        },
        disk: {
            drive: pair('Drive', 'Диск'),
            freeSpace: pair('Minimum free space (KB)', 'Минимальное свободное место (КБ)')
        },
        domain: {
            name: pair('Domain name', 'Имя домена'),
            userContext: pair('Context', 'Контекст')
        },
        dun: { type: pair('Connection type', 'Тип подключения') },
        file: {
            path: pair('Path', 'Путь'),
            type: pair('Match type', 'Тип соответствия'),
            folder: pair('Match a folder', 'Проверять папку'),
            min: pair('Minimum version', 'Минимальная версия'),
            max: pair('Maximum version', 'Максимальная версия'),
            gte: pair('Include minimum version', 'Включая минимальную версию'),
            lte: pair('Include maximum version', 'Включая максимальную версию')
        },
        ip_range: {
            useIPv6: pair('Use IPv6', 'Использовать IPv6'),
            min: pair('First IP address', 'Начальный IP-адрес'),
            max: pair('Last IP address', 'Конечный IP-адрес')
        },
        language: {
            languageLocale: pair('Language', 'Язык'),
            default: pair('User', 'Пользователь'),
            system: pair('System', 'Системный'),
            native: pair('Native', 'Собственный')
        },
        ldap: {
            binding: pair('LDAP binding', 'Привязка LDAP'),
            searchFilter: pair('LDAP filter', 'Фильтр LDAP'),
            variableName: pair('Environment variable name', 'Имя переменной среды'),
            attribute: pair('Attribute to return', 'Возвращаемый атрибут')
        },
        mac_range: {
            min: pair('First MAC address', 'Начальный MAC-адрес'),
            max: pair('Last MAC address', 'Конечный MAC-адрес')
        },
        msi: {
            type: pair('Installer object', 'Объект установщика'),
            subtype: pair('Match type', 'Тип соответствия'),
            code: pair('Product, patch or component code', 'Код продукта, исправления или компонента'),
            item: pair('Property or information item', 'Свойство или элемент сведений'),
            value: pair('Value to match', 'Значение для сравнения'),
            min: pair('Minimum version', 'Минимальная версия'),
            max: pair('Maximum version', 'Максимальная версия'),
            gte: pair('Include minimum version', 'Включая минимальную версию'),
            lte: pair('Include maximum version', 'Включая максимальную версию')
        },
        org_unit: {
            name: pair('Organizational unit', 'Подразделение'),
            userContext: pair('Context', 'Контекст'),
            directMember: pair('Direct member only', 'Только непосредственное членство')
        },
        pcmcia: {},
        portable: {
            unknown: pair('Docking state is unknown', 'Состояние подключения к док-станции неизвестно'),
            docked: pair('Docked', 'Подключён к док-станции'),
            undocked: pair('Undocked', 'Не подключён к док-станции')
        },
        proc_mode: {
            synchFore: pair('Synchronous foreground processing', 'Синхронная обработка на переднем плане'),
            asynchFore: pair('Asynchronous foreground processing', 'Асинхронная обработка на переднем плане'),
            backRefr: pair('Background refresh', 'Фоновое обновление'),
            forceRefr: pair('Forced refresh', 'Принудительное обновление'),
            linkTrns: pair('Link speed has changed', 'Скорость подключения изменилась'),
            noChg: pair('No changes during processing', 'При обработке не было изменений'),
            rsopTrns: pair('RSoP transaction', 'Транзакция результирующей политики (RSoP)'),
            safeBoot: pair('Safe boot', 'Безопасная загрузка'),
            slowLink: pair('Slow network link', 'Медленное сетевое подключение'),
            verbLog: pair('Verbose logging enabled', 'Подробное журналирование включено'),
            rsopEnbl: pair('RSoP enabled', 'Результирующая политика (RSoP) включена')
        },
        ram: { totalMB: pair('Minimum memory (MB)', 'Минимальный объём памяти (МБ)') },
        run_once: {
            id: pair('Tracking identifier', 'Идентификатор выполнения'),
            userContext: pair('Context', 'Контекст'),
            comments: pair('Description', 'Описание')
        },
        site: { name: pair('Site name', 'Имя сайта') },
        terminal: {
            type: pair('Session type', 'Тип сеанса'),
            option: pair('Session property', 'Свойство сеанса'),
            value: pair('Value to match', 'Значение для сравнения'),
            min: pair('First client IP address', 'Начальный IP-адрес клиента'),
            max: pair('Last client IP address', 'Конечный IP-адрес клиента')
        },
        time: {
            begin: pair('From', 'С'),
            end: pair('Until', 'До')
        },
        user: {
            name: pair('User name', 'Имя пользователя'),
            sid: pair('User SID', 'SID пользователя')
        },
        variable: {
            variableName: pair('Variable name', 'Имя переменной'),
            value: pair('Value to match', 'Значение для сравнения')
        },
        os: {
            class: pair('System family', 'Семейство систем'),
            version: pair('Operating system', 'Операционная система'),
            type: pair('Product type', 'Тип продукта'),
            edition: pair('Edition', 'Редакция'),
            sp: pair('Service pack', 'Пакет обновления')
        },
        registry: {
            type: pair('Match type', 'Тип соответствия'),
            subtype: pair('Comparison', 'Сравнение'),
            valueName: pair('Value name', 'Имя параметра'),
            valueType: pair('Value type', 'Тип параметра'),
            valueData: pair('Value data', 'Значение параметра'),
            variableName: pair('Environment variable name', 'Имя переменной среды'),
            key: pair('Key path', 'Путь раздела'),
            hive: pair('Hive', 'Куст реестра'),
            min: pair('Minimum version', 'Минимальная версия'),
            max: pair('Maximum version', 'Максимальная версия'),
            gte: pair('Include minimum version', 'Включая минимальную версию'),
            lte: pair('Include maximum version', 'Включая максимальную версию'),
            version: pair('Version to match', 'Версия для сравнения')
        },
        wmi: {
            query: pair('WMI query', 'Запрос WMI'),
            nameSpace: pair('Namespace', 'Пространство имён'),
            property: pair('Property to return', 'Возвращаемое свойство'),
            variableName: pair('Environment variable name', 'Имя переменной среды')
        },
        group: {
            name: pair('Group name', 'Имя группы'),
            sid: pair('Group SID', 'SID группы'),
            userContext: pair('Context', 'Контекст'),
            primaryGroup: pair('Primary group', 'Основная группа'),
            localGroup: pair('Local group', 'Локальная группа')
        },
        collection: { name: pair('Collection name', 'Имя коллекции') }
    };

    function option(key, en, ru) { return { key: key, label: pair(en, ru) }; }
    var any = function() { return option('NE', 'Any', 'Любой'); };
    var enumerations = {
        computer: { type: [
            option('NETBIOS', 'NetBIOS name', 'NetBIOS-имя'),
            option('DNS', 'DNS name', 'DNS-имя')
        ] },
        date: {
            period: [option('WEEKLY', 'Weekly', 'Еженедельно'), option('MONTHLY', 'Monthly', 'Ежемесячно'), option('YEARLY', 'Date', 'Дата')],
            dow: [
                option('MON', 'Monday', 'Понедельник'), option('TUE', 'Tuesday', 'Вторник'),
                option('WED', 'Wednesday', 'Среда'), option('THU', 'Thursday', 'Четверг'),
                option('FRI', 'Friday', 'Пятница'), option('SAT', 'Saturday', 'Суббота'),
                option('SUN', 'Sunday', 'Воскресенье')
            ]
        },
        dun: { type: [
            option('', 'Any connection', 'Любое подключение'),
            option('modem', 'Modem', 'Модем'), option('isdn', 'ISDN', 'ISDN'),
            option('x25', 'X.25', 'X.25'), option('vpn', 'VPN', 'VPN'),
            option('pad', 'Packet assembler/disassembler (PAD)', 'Сборщик/разборщик пакетов (PAD)'),
            option('GENERIC', 'Generic network', 'Обычная сеть'),
            option('SERIAL', 'Serial connection', 'Последовательное подключение'),
            option('FRAMERELAY', 'Frame Relay', 'Frame Relay'), option('ATM', 'ATM', 'ATM'),
            option('SONET', 'SONET', 'SONET'), option('SW56', 'Switched 56K', 'Коммутируемое подключение 56K'),
            option('IRDA', 'Infrared (IrDA)', 'Инфракрасное подключение (IrDA)'),
            option('PARALLEL', 'Parallel connection', 'Параллельное подключение'),
            option('PPPoE', 'PPPoE', 'PPPoE')
        ] },
        file: { type: [option('EXISTS', 'File exists', 'Файл существует'), option('VERSION', 'File version', 'Версия файла')] },
        msi: {
            type: [option('PRODUCT', 'Product', 'Продукт'), option('PATCH', 'Patch', 'Исправление'), option('FILECOMPONENT', 'File component', 'Файловый компонент')],
            subtype: [
                option('EXISTS', 'Exists', 'Существует'), option('VERSION', 'Version', 'Версия'),
                option('GET_PROPERTY', 'Get property', 'Получить свойство'),
                option('GET_INFORMATION', 'Get information', 'Получить сведения'),
                option('MATCH_PROPERTY', 'Match property', 'Сравнить свойство'),
                option('MATCH_INFORMATION', 'Match information', 'Сравнить сведения')
            ]
        },
        terminal: {
            type: [any(), option('TS', 'Remote Desktop', 'Удалённый рабочий стол'), option('CONSOLE', 'Console', 'Консоль')],
            option: [
                option('APPLICATION', 'Application name', 'Имя приложения'),
                option('PROGRAM', 'Initial program', 'Начальная программа'),
                option('CLIENT', 'Client product ID', 'Идентификатор продукта клиента'),
                option('SESSION', 'Session information', 'Сведения о сеансе'),
                option('DIRECTORY', 'Client directory', 'Каталог клиента'),
                option('IP', 'Client IP address range', 'Диапазон IP-адресов клиента'), any()
            ]
        },
        os: {
            class: [any(), option('9X', 'Windows 9x', 'Windows 9x'), option('NT', 'Windows NT family', 'Семейство Windows NT')],
            version: [
                any(), option('95', 'Windows 95', 'Windows 95'), option('98', 'Windows 98', 'Windows 98'),
                option('ME', 'Windows Me', 'Windows Me'), option('NT', 'Windows NT', 'Windows NT'),
                option('2K', 'Windows 2000', 'Windows 2000'), option('XP', 'Windows XP', 'Windows XP'),
                option('2K3', 'Windows Server 2003', 'Windows Server 2003'), option('2K3R2', 'Windows Server 2003 R2', 'Windows Server 2003 R2'),
                option('VISTA', 'Windows Vista', 'Windows Vista'), option('Vista', 'Windows Vista (Vista)', 'Windows Vista (Vista)'),
                option('2K8', 'Windows Server 2008', 'Windows Server 2008'), option('WIN7', 'Windows 7', 'Windows 7'),
                option('2K8R2', 'Windows Server 2008 R2', 'Windows Server 2008 R2'), option('WIN8', 'Windows 8', 'Windows 8'),
                option('WIN8S', 'Windows Server 2012', 'Windows Server 2012'), option('WINBLUE', 'Windows 8.1', 'Windows 8.1'),
                option('WINBLUESRV', 'Windows Server 2012 R2', 'Windows Server 2012 R2'),
                option('WINTHRESHOLD', 'Windows 10', 'Windows 10'), option('WINTHRESHOLDSRV', 'Windows Server 2016 and later', 'Windows Server 2016 и новее')
            ],
            type: [
                any(), option('R2', 'R2', 'R2'), option('SE', 'Standard Edition', 'Стандартная редакция'),
                option('WS', 'Workstation', 'Рабочая станция'), option('SV', 'Server', 'Сервер'),
                option('DC', 'Domain controller', 'Контроллер домена'),
                option('PRO', 'Professional', 'Профессиональная редакция'), option('PR', 'Professional (PR)', 'Профессиональная редакция (PR)')
            ],
            edition: [
                any(), option('64EP', '64-bit Enterprise', 'Корпоративная, 64-разрядная'),
                option('64DC', '64-bit Datacenter', 'Центр обработки данных, 64-разрядная'),
                option('AS', 'Advanced Server', 'Расширенный сервер'), option('DTC', 'Datacenter', 'Центр обработки данных'),
                option('EP', 'Enterprise', 'Корпоративная'), option('WEB', 'Web', 'Веб-сервер'),
                option('64', '64-bit', '64-разрядная'), option('HM', 'Home', 'Домашняя'),
                option('MC', 'Media Center', 'Медиацентр'), option('TPC', 'Tablet PC', 'Планшетный ПК'),
                option('SRV', 'Server', 'Сервер'), option('STD', 'Standard', 'Стандартная'),
                option('TSE', 'Terminal Server', 'Терминальный сервер'), option('SBS', 'Small Business Server', 'Сервер для малого бизнеса'),
                option('PRO', 'Professional', 'Профессиональная'),
                option('64STGSTD', '64-bit Storage Server Standard', 'Сервер хранения, стандартная, 64-разрядная'),
                // The published prose says Premium for this Workgroup-like
                // token. Do not guess either meaning or change its encoding.
                option('64STGWKGRP', '64-bit Storage Server (64STGWKGRP)', 'Сервер хранения, 64-разрядная (64STGWKGRP)'),
                option('64MPSTD', '64-bit MultiPoint Server Standard', 'Сервер MultiPoint, стандартная, 64-разрядная'),
                option('64MPPREM', '64-bit MultiPoint Server Premium', 'Сервер MultiPoint, расширенная, 64-разрядная'),
                option('64ESSSOL', '64-bit Essentials', 'Essentials, 64-разрядная')
            ],
            sp: [
                any(), option('Gold', 'No service pack', 'Без пакета обновления'),
                option('Service Pack 1', 'Service Pack 1', 'Пакет обновления 1'),
                option('Service Pack 2', 'Service Pack 2', 'Пакет обновления 2'),
                option('Service Pack 3', 'Service Pack 3', 'Пакет обновления 3'),
                option('Service Pack 4', 'Service Pack 4', 'Пакет обновления 4'),
                option('Service Pack 5', 'Service Pack 5', 'Пакет обновления 5'),
                option('Service Pack 6', 'Service Pack 6', 'Пакет обновления 6')
            ]
        },
        registry: {
            type: [
                option('VALUEEXISTS', 'Value exists', 'Параметр существует'), option('KEYEXISTS', 'Key exists', 'Раздел существует'),
                option('MATCHVALUE', 'Match value', 'Сравнить значение'), option('GETVALUE', 'Get value', 'Получить значение')
            ],
            subtype: [
                option('EQUALHEX', 'Equal (hexadecimal)', 'Равно (шестнадцатеричное)'),
                option('EQUALDEC', 'Equal (decimal)', 'Равно (десятичное)'),
                option('SUBSTRING', 'Contains text', 'Содержит текст'), option('VERSION', 'Version range', 'Диапазон версий')
            ],
            valueType: [
                option('REG_SZ', 'String (REG_SZ)', 'Строка (REG_SZ)'),
                option('REG_EXPAND_SZ', 'Expandable string (REG_EXPAND_SZ)', 'Расширяемая строка (REG_EXPAND_SZ)'),
                option('REG_MULTI_SZ', 'Multi-string (REG_MULTI_SZ)', 'Многострочное значение (REG_MULTI_SZ)'),
                option('REG_DWORD', '32-bit integer (REG_DWORD)', '32-разрядное число (REG_DWORD)'),
                option('REG_BINARY', 'Binary (REG_BINARY)', 'Двоичное значение (REG_BINARY)'),
                option('', 'Any value type', 'Любой тип параметра')
            ],
            hive: [
                option('HKEY_LOCAL_MACHINE', 'Local machine (HKEY_LOCAL_MACHINE)', 'Компьютер (HKEY_LOCAL_MACHINE)'),
                option('HKEY_CLASSES_ROOT', 'Classes root (HKEY_CLASSES_ROOT)', 'Классы (HKEY_CLASSES_ROOT)'),
                option('HKEY_CURRENT_USER', 'Current user (HKEY_CURRENT_USER)', 'Текущий пользователь (HKEY_CURRENT_USER)'),
                option('HKEY_CURRENT_CONFIG', 'Current configuration (HKEY_CURRENT_CONFIG)', 'Текущая конфигурация (HKEY_CURRENT_CONFIG)'),
                option('HKEY_USERS', 'Users (HKEY_USERS)', 'Пользователи (HKEY_USERS)')
            ]
        }
    };

    var numbers = {
        cpu: { speedMHz: { min: 0, max: 65535, step: 1 } },
        date: {
            day: { min: 1, max: 31, step: 1 },
            month: { min: 1, max: 12, step: 1 },
            year: { min: 1, max: 65535, step: 1 }
        },
        disk: { freeSpace: { min: 0, max: 255, step: 1 } },
        ram: { totalMB: { min: 0, max: 65535, step: 1 } }
    };
    var notes = {
        battery: pair('Matches when the computer is running on battery power.', 'Условие выполняется, когда компьютер работает от батареи.'),
        pcmcia: pair('Matches when the computer has PCMCIA card slots.', 'Условие выполняется, если в компьютере есть слоты PCMCIA.'),
        disk: pair('The current library supports only 0–255 KB for this condition. Larger thresholds are not yet supported.', 'Текущая библиотека поддерживает для этого условия только 0–255 КБ. Большие значения пока не поддерживаются.'),
        user: pair('If a SID is specified, it takes precedence over the user name.', 'Если задан SID, он используется вместо имени пользователя.'),
        run_once: pair('The tracking identifier records whether this condition has already been processed.', 'По идентификатору определяется, выполнялось ли это условие ранее.')
    };

    function languageIndex(language) { return /^ru(?:[-_]|$)/i.test(String(language || 'en')) ? 1 : 0; }
    function localized(value, language) { return value[languageIndex(language)]; }
    function operand(id) { return String(id || '').replace(/^filter\./, ''); }
    function own(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }
    function lookup(table, kind, id) {
        return own(table, kind) && own(table[kind], operand(id)) ? table[kind][operand(id)] : null;
    }
    return {
        supportedKinds: Object.freeze(Object.keys(kinds)),
        kindLabel: function(kind, fallback, language) {
            return own(kinds, kind) ? localized(kinds[kind], language) : fallback || String(kind || '');
        },
        fieldLabel: function(kind, id, fallback, language) {
            var label = lookup(fields, kind, id);
            return label ? localized(label, language) : fallback || String(id || '');
        },
        choices: function(kind, id, language) {
            var values = lookup(enumerations, kind, id);
            return values ? values.map(function(value) { return { key: value.key, label: localized(value.label, language) }; }) : null;
        },
        numeric: function(kind, id) {
            var value = lookup(numbers, kind, id);
            return value ? { min: value.min, max: value.max, step: value.step } : null;
        },
        isTextarea: function(kind, id) {
            var key = operand(id);
            return kind === 'wmi' && key === 'query' || kind === 'ldap' && key === 'searchFilter' ||
                kind === 'run_once' && key === 'comments' || kind === 'registry' && key === 'valueData';
        },
        note: function(kind, language) { return own(notes, kind) ? localized(notes[kind], language) : ''; }
    };
});
