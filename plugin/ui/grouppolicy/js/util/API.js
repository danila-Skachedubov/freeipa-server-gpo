/**
 * High-level GPO editor RPC client.
 *
 * The browser intentionally retains only the selected GPO display name and
 * opaque identifiers returned by the server.  Filesystem, registry and
 * libadmix binding details never cross this boundary.
 */
define(["freeipa/ipa", "freeipa/rpc", "../locales/translations"], function(IPA, rpc, translations) {
    "use strict";

    var selectedDisplayName = null;
    var editorOpenPromise = null;
    var editorOpenResult = null;

    function clone(value) {
        if (value === undefined) return undefined;
        return JSON.parse(JSON.stringify(value));
    }

    function unwrapResponse(data) {
        var outer = data && data.result !== undefined ? data.result : data;
        var payload = outer && outer.result !== undefined ? outer.result : outer;
        return payload === null || payload === undefined ? {} : payload;
    }

    function firstObject(candidates) {
        for (var i = 0; i < candidates.length; i += 1) {
            if (candidates[i] && typeof candidates[i] === "object") {
                return candidates[i];
            }
        }
        return {};
    }

    function EditorError(message, details) {
        var info = details || {};
        this.name = "GpoEditorError";
        this.message = message || "GPO editor request failed";
        var inferredCategory = info.category || info.error_category || null;
        var errorName = String(info.name || info.error_name || "");
        if (!inferredCategory && /ACIError|Authorization|NotAllowed/i.test(errorName + " " + (message || ""))) {
            inferredCategory = "authorization";
        }
        this.category = inferredCategory || (typeof info.code === "string" ? info.code : null) || "operational";
        this.code = info.code || this.category;
        this.field = info.field || null;
        this.path = info.path || null;
        var parsedDetails = info.details;
        if (typeof parsedDetails === "string") {
            try { parsedDetails = JSON.parse(parsedDetails); } catch (ignore) {}
        }
        this.details = parsedDetails && typeof parsedDetails === "object" ? parsedDetails : info;
        this.pendingPublication = info.pending_publication
            || info.pendingPublication
            || (this.details && this.details.pending_publication)
            || null;
        if (Error.captureStackTrace) Error.captureStackTrace(this, EditorError);
    }
    EditorError.prototype = Object.create(Error.prototype);
    EditorError.prototype.constructor = EditorError;

    function normalizeError(xhr, textStatus, thrown) {
        if (thrown instanceof EditorError) return thrown;

        var response = xhr && (xhr.responseJSON || xhr.response || xhr.data);
        var responseError = response && response.error ? response.error : response;
        var thrownData = thrown && (thrown.data || thrown.details || thrown.error);
        var details = firstObject([
            thrownData && thrownData.data,
            thrownData,
            responseError && responseError.data,
            responseError,
            thrown
        ]);
        var message = details.message
            || (thrown && thrown.message)
            || (responseError && responseError.message)
            || textStatus
            || "GPO editor request failed";

        return new EditorError(String(message), details);
    }

    function normalizeLocale(locale) {
        var value = String(locale || "").replace("_", "-");
        var parts = value.split("-").filter(Boolean);
        if (parts.length === 0) return "en-US";
        var language = parts[0].toLowerCase();
        if (parts.length === 1) {
            if (language === "ru") return "ru-RU";
            if (language === "en") return "en-US";
            return language;
        }
        return language + "-" + parts[1].toUpperCase();
    }

    function localePreferences() {
        var uiLocale = translations && typeof translations.getLanguage === "function"
            ? translations.getLanguage()
            : null;
        var browserLocales = [];
        if (typeof navigator !== "undefined") {
            browserLocales = Array.isArray(navigator.languages) && navigator.languages.length
                ? navigator.languages
                : [navigator.language];
        }

        var result = [];
        [uiLocale].concat(browserLocales, ["en-US"]).forEach(function(locale) {
            var normalized = normalizeLocale(locale);
            if (normalized && result.indexOf(normalized) === -1) result.push(normalized);
        });
        return result;
    }

    function requireDisplayName() {
        if (!selectedDisplayName) {
            throw new EditorError("No GPO is selected", { category: "validation", field: "displayname" });
        }
        return selectedDisplayName;
    }

    function execute(method, args, options) {
        var displayName;
        try {
            displayName = requireDisplayName();
        } catch (error) {
            return Promise.reject(error);
        }

        return new Promise(function(resolve, reject) {
            var commandOptions = Object.assign({ version: IPA.api_version }, clone(options || {}));
            rpc.command({
                entity: "gpo",
                method: method,
                args: [displayName].concat(clone(args || [])),
                options: commandOptions,
                on_success: function(data) {
                    resolve(unwrapResponse(data));
                },
                on_error: function(xhr, textStatus, thrown) {
                    reject(normalizeError(xhr, textStatus, thrown));
                }
            }).execute();
        });
    }

    function withLocales(options) {
        return Object.assign({}, options || {}, { locales: localePreferences() });
    }

    function rememberEnvelope(result) {
        if (!editorOpenResult || !result || typeof result !== "object") return result;
        ["gpo", "template", "diagnostics", "pending_publication"].forEach(function(key) {
            if (Object.prototype.hasOwnProperty.call(result, key)) {
                editorOpenResult[key] = clone(result[key]);
            }
        });
        return result;
    }

    function initialize(displayName) {
        selectedDisplayName = displayName ? String(displayName) : null;
        editorOpenResult = null;
        editorOpenPromise = selectedDisplayName
            ? execute("editor_open", [], withLocales()).then(function(result) {
                editorOpenResult = result;
                return result;
            })
            : Promise.reject(new EditorError("No GPO is selected", {
                category: "validation",
                field: "displayname"
            }));
        return editorOpenPromise;
    }

    function open(options) {
        if (!options && editorOpenResult) return Promise.resolve(editorOpenResult);
        if (!options && editorOpenPromise) return editorOpenPromise;
        return execute("editor_open", [], withLocales(options)).then(function(result) {
            editorOpenResult = result;
            return result;
        });
    }

    function children(scope, categoryId) {
        var options = {};
        if (categoryId !== null && categoryId !== undefined) options.category_id = categoryId;
        return execute("editor_children", [scope], withLocales(options));
    }

    function policyShow(scope, policyId) {
        return execute("editor_policy_show", [scope, policyId], withLocales());
    }

    function policyUpdate(scope, policyId, request) {
        return execute("editor_policy_update", [scope, policyId], withLocales({
            request: clone(request || {})
        })).then(rememberEnvelope);
    }

    function preferenceDocuments() {
        return execute("editor_preference_documents", [], {});
    }

    function preferenceItems(scope, kind) {
        return execute("editor_preference_items", [scope, kind], {});
    }

    function preferenceShow(scope, kind, identity) {
        return execute("editor_preference_show", [scope, kind], {
            request: { identity: identity === undefined ? null : clone(identity) }
        });
    }

    function preferenceCreate(scope, kind, request) {
        return execute("editor_preference_create", [scope, kind], {
            request: clone(request || {})
        }).then(rememberEnvelope);
    }

    function preferenceUpdate(scope, kind, request) {
        return execute("editor_preference_update", [scope, kind], {
            request: clone(request || {})
        }).then(rememberEnvelope);
    }

    function preferenceDelete(scope, kind, identity) {
        return execute("editor_preference_delete", [scope, kind], {
            request: { identity: clone(identity) }
        }).then(rememberEnvelope);
    }

    function reconcile() {
        return execute("editor_reconcile", [], {}).then(rememberEnvelope);
    }

    return {
        EditorError: EditorError,
        initialize: initialize,
        open: open,
        children: children,
        policyShow: policyShow,
        policyUpdate: policyUpdate,
        preferenceDocuments: preferenceDocuments,
        preferenceItems: preferenceItems,
        preferenceShow: preferenceShow,
        preferenceCreate: preferenceCreate,
        preferenceUpdate: preferenceUpdate,
        preferenceDelete: preferenceDelete,
        reconcile: reconcile,
        getDisplayName: function() { return selectedDisplayName; },
        getOpenResult: function() { return editorOpenResult; },
        localePreferences: localePreferences,
        _test: {
            unwrapResponse: unwrapResponse,
            normalizeError: normalizeError,
            normalizeLocale: normalizeLocale
        }
    };
});
