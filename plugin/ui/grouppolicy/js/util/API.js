/**
 * API — модуль для взаимодействия с серверной частью FreeIPA.
 *
 * Содержит методы для:
 *   - Получения и хранения файлового пути GPO (nameGpt).
 *   - Загрузки политик (дерево политик) через RPC-команды.
 *
 * Зависимости:
 *   - freeipa/ipa  — объект IPA с версией API (IPA.api_version).
 *   - freeipa/rpc  — утилита для выполнения RPC-запросов к серверу FreeIPA.
 */
define(["freeipa/ipa", "freeipa/rpc"], function(IPA, rpc) {

    /** @type {string|null} Кэшированный файловый путь GPO (например: \\example.test\SysVol\...\Policies\{GUID}) */
    var _nameGpt = null;

    /** @type {string|null} Кэшированное имя политики (displayName) */
    var _policyName = null;

    /** @type {Promise|null} Промис загрузки nameGpt. Позволяет нескольким компонентам ждать один и тот же запрос. */
    var _nameGptPromise = null;

    /**
     * Нормализует значение, которое может быть массивом, строкой или null.
     * FreeIPA часто возвращает одиночные значения в виде массива — эта функция
     * извлекает первый элемент массива и приводит его к строке.
     *
     * @param {*} value — входное значение (может быть массивом, строкой, null и т.д.)
     * @returns {string|null} — строковое представление значения или null, если значение пустое
     */
    function normalizeSingleString(value) {
        if (Array.isArray(value)) {
            value = value.length > 0 ? value[0] : null;
        }
        if (value === null || value === undefined || value === "") {
            return null;
        }
        return String(value);
    }

    /**
     * Нормализует успешный RPC-ответ.
     *
     * Для некоторых методов сервер возвращает полезные данные в data.result.result,
     * а для некоторых успешный ответ может не содержать этого поля вообще.
     *
     * @param {Object} data — исходный RPC-ответ
     * @returns {*} — полезные данные ответа или объект успешного результата
     */
    function normalizeSuccessResponse(data) {
        var rpcResult = data && data.result ? data.result : null;

        if (rpcResult && rpcResult.result !== undefined && rpcResult.result !== null) {
            return rpcResult.result;
        }

        return {
            success: true,
            data: rpcResult,
            raw: data || null
        };
    }

    /**
     * Инициализирует получение файлового пути GPO (nameGpt) по имени политики.
     *
     * Вызывается один раз при инициализации приложения (app.init).
     * Отправляет RPC-запрос gpo.show, получает данные GPO и извлекает
     * поле gpcfilesyspath — путь к файловой системе групповой политики.
     *
     * Результат кэшируется в _nameGpt и становится доступен через
     * waitForNameGpt() и getNameGpt() из любого компонента.
     *
     * @param {string} policyName — имя (displayname) выбранной GPO-политики
     * @returns {Promise<string|null>} — промис, который resolve'ится с путем GPO или null
     */
    function initNameGpt(policyName) {
        _policyName = policyName || null;

        if (!policyName) {
            _nameGptPromise = Promise.resolve(null);
            return _nameGptPromise;
        }

        _nameGpt = null;
        _nameGptPromise = new Promise(function(resolve, reject) {
            rpc.command({
                entity: "gpo",
                method: "show",
                args: [policyName],
                options: {
                    version: IPA.api_version
                },
                on_success: function(data) {
                    var gpoData = (data && data.result) ? data.result.result : {};
                    _nameGpt = normalizeSingleString(gpoData.gpcfilesyspath);
                    if (!_nameGpt) {
                        reject(new Error("File System Path is empty."));
                        return;
                    }
                    resolve(_nameGpt);
                },
                on_error: function(xhr, text_status, error_thrown) {
                    var errorMessage = (error_thrown && error_thrown.message) || error_thrown || text_status || "Unknown error";
                    reject(new Error("Failed to get File System Path: " + errorMessage));
                }
            }).execute();
        });

        return _nameGptPromise;
    }

    /**
     * Асинхронно ожидает загрузки nameGpt.
     *
     * Если значение уже загружено и закэшировано — возвращает его сразу.
     * Если загрузка ещё идёт — возвращает промис, который дождётся результата.
     * Если initNameGpt ещё не вызывался — возвращает null.
     *
     * Используется в компонентах, которым нужен nameGpt для API-запросов
     * (например, loadTreeViewList, loadAdmxStateFromApi, handleApply).
     *
     * @returns {Promise<string|null>} — промис с путем GPO или null
     */
    function waitForNameGpt() {
        if (_nameGpt) {
            return Promise.resolve(_nameGpt);
        }
        return _nameGptPromise || Promise.resolve(null);
    }

    /**
     * Синхронно возвращает кэшированный путь GPO.
     *
     * Возвращает null, если initNameGpt ещё не завершён.
     * Используйте waitForNameGpt(), если нужна гарантия наличия значения.
     *
     * @returns {string|null} — закэшированный путь GPO или null
     */
    function getNameGpt() {
        return _nameGpt;
    }

    /**
     * Загружает дерево политик (определения ADMX) по указанному пути.
     *
     * Отправляет RPC-запрос gpo.get_policy с указанным путём.
     * Возвращает структуру { meta, Machine, User } с категориями и политиками.
     *
     * Используется в tree-view-list-data.js для построения дерева навигации.
     *
     * @param {string} path — путь для загрузки политик (по умолчанию '/' — корень)
     * @returns {Promise<Object>} — промис с данными политик
     */
    function getPolicy(path) {
        return new Promise(function(resolve, reject) {
            rpc.command({
                entity: 'gpo',
                method: 'get_policy',
                args: [path || '/'],
                options: {
                    version: IPA.api_version
                },
                on_success: function(data) {
                    var result = (data.result && data.result.result) || {};
                    resolve(result);
                },
                on_error: function(xhr, text_status, error_thrown) {
                    reject(error_thrown || new Error('Failed to get policy'));
                }
            }).execute();
        });
    }

    /**
     * Получает текущее значение политики по указанным параметрам.
     *
     * @param {string} nameGpt — файловый путь GPO
     * @param {string} target — область применения политики (Machine/User)
     * @param {string} path — путь политики
     * @returns {Promise<*>} — промис с текущим значением политики
     */
    function get_current_value(nameGpt, target, path) {
        return new Promise(function(resolve, reject) {
            rpc.command({
                entity: 'gpo',
                method: 'get_current_value',
                args: [
                    nameGpt || '',
                    target || '',
                    path || '/'
                ],
                options: {
                    version: IPA.api_version
                },
                on_success: function(data) {
                    var result = (data.result && data.result.result) || null;
                    resolve(result);
                },
                on_error: function(xhr, text_status, error_thrown) {
                    reject(error_thrown || new Error('Failed to get current value'));
                }
            }).execute();
        });
    }

    /**
     * Устанавливает значение политики по указанным параметрам.
     *
     * @param {string} nameGpt — файловый путь GPO
     * @param {string} target — область применения политики (Machine/User)
     * @param {string} path — путь политики
     * @param {string} value — новое значение политики
     * @param {string} metadata — путь к ADMX metadata
     * @returns {Promise<*>} — промис с результатом сохранения
     */
    function set(nameGpt, target, path, value, metadata) {
        return new Promise(function(resolve, reject) {
            rpc.command({
                entity: 'gpo',
                method: 'set_policy',
                args: [
                    nameGpt || '',
                    target || '',
                    path || '/',
                    value || '',
                    metadata || ''
                ],
                options: {
                    version: IPA.api_version
                },
                on_success: function(data) {
                    resolve(normalizeSuccessResponse(data));
                },
                on_error: function(xhr, text_status, error_thrown) {
                    reject(error_thrown || new Error('Failed to set policy'));
                }
            }).execute();
        });
    }

    /**
     * Удаляет значение политики по указанным параметрам.
     *
     * @param {string} nameGpt — файловый путь GPO
     * @param {string} target — область применения политики (Machine/User)
     * @param {string} path — путь политики
     * @returns {Promise<*>} — промис с результатом удаления
     */
    function deletePolicy(nameGpt, target, path) {
        return new Promise(function(resolve, reject) {
            rpc.command({
                entity: 'gpo',
                method: 'delete_policy',
                args: [
                    nameGpt || '',
                    target || '',
                    path || '/'
                ],
                options: {
                    version: IPA.api_version
                },
                on_success: function(data) {
                    resolve(normalizeSuccessResponse(data));
                },
                on_error: function(xhr, text_status, error_thrown) {
                    reject(error_thrown || new Error('Failed to delete policy'));
                }
            }).execute();
        });
    }

    function getLocale() {
        return new Promise(function(resolve) {
            rpc.command({
                entity: 'gpo',
                method: 'get_locale',
                args: [],
                options: { version: IPA.api_version },
                on_success: function(data) {
                    var result = (data && data.result) ? data.result : {};
                    resolve(result.result || 'en-US');
                },
                on_error: function() {
                    resolve('en-US');
                }
            }).execute();
        });
    }

    function setLocale(locale) {
        return new Promise(function(resolve, reject) {
            rpc.command({
                entity: 'gpo',
                method: 'set_locale',
                args: [locale || 'en-US'],
                options: { version: IPA.api_version },
                on_success: function(data) { resolve(data); },
                on_error: function(xhr, text_status, error_thrown) { reject(error_thrown || new Error('Failed to set locale')); }
            }).execute();
        });
    }

    function getPolicyName() {
        return _policyName;
    }

    return {
        initNameGpt: initNameGpt,
        waitForNameGpt: waitForNameGpt,
        getNameGpt: getNameGpt,
        getPolicyName: getPolicyName,
        getPolicy: getPolicy,
        get_current_value: get_current_value,
        set: set,
        deletePolicy: deletePolicy,
        getLocale: getLocale,
        setLocale: setLocale
    };
});
