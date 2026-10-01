define(['../../../util/element-creator'], function(elements) {
    'use strict';

    var create = elements.createElement;
    var nextInputId = 1;
    var TYPES = {
        ipv4: { count: 4, length: 3, max: 255, separator: '.', characters: /^\d*$/, inserted: /^[\d.]*$/ },
        mac: { count: 6, length: 2, separator: ':', characters: /^[a-f\d]*$/i, inserted: /^[a-f\d:-]*$/i },
        version: { count: 4, length: 5, max: 65535, separator: '.', characters: /^\d*$/, inserted: /^[\d.]*$/ },
        guid: { inserted: /^[a-f\d{}-]*$/i },
        ipv6: { inserted: /^[a-f\d:.]*$/i }
    };
    var WORDS = {
        en: { ipv4: 'IPv4 address', ipv6: 'IPv6 address', mac: 'MAC address', version: 'Version', guid: 'GUID', octet: 'Octet', byte: 'Byte', component: 'Component', of: 'of', saved: 'saved value' },
        ru: { ipv4: 'Адрес IPv4', ipv6: 'Адрес IPv6', mac: 'MAC-адрес', version: 'Версия', guid: 'GUID', octet: 'Октет', byte: 'Байт', component: 'Компонент', of: 'из', saved: 'сохранённое значение' }
    };

    function validSegment(value, type) {
        return value.length <= type.length && type.characters.test(value)
            && (value === '' || type.max === undefined || Number(value) <= type.max);
    }

    /** A partial value is useful while editing; completeness belongs to the operand validator. */
    function splitSegments(value, name) {
        var type = TYPES[name];
        if (value === '') return [''];
        var parts;
        if (name === 'mac' && /^[a-f\d]+$/i.test(value) && value.length > 2) {
            if (value.length > 12 || value.length % 2) return null;
            parts = value.match(/.{2}/g);
        } else {
            if (name === 'mac' && value.indexOf(':') !== -1 && value.indexOf('-') !== -1) return null;
            parts = value.split(name === 'mac' ? /[:-]/ : '.');
        }
        return parts.length <= type.count && parts.every(function(part) { return validSegment(part, type); }) ? parts : null;
    }

    function joinSegments(inputs, separator) {
        var parts = inputs.map(function(input) { return input.value; });
        while (parts.length && parts[parts.length - 1] === '') parts.pop();
        return parts.join(separator);
    }

    /** Accept a GUID prefix or a complete GUID, without extracting hex from arbitrary text. */
    function guidValue(value) {
        var body = value, opening = false, closing = false;
        if (body.charAt(0) === '{') { opening = true; body = body.slice(1); }
        if (body.charAt(body.length - 1) === '}') { closing = true; body = body.slice(0, -1); }
        if (!/^[a-f\d-]*$/i.test(body) || body.length > 36 || closing && !opening) return null;
        for (var i = 0; i < body.length; i++) {
            if (body.charAt(i) === '-' && [8, 13, 18, 23].indexOf(i) === -1) return null;
        }
        var hex = body.replace(/-/g, '');
        if (hex.length > 32 || closing && hex.length !== 32) return null;
        var parts = [], offset = 0;
        [8, 4, 4, 4, 12].forEach(function(length) {
            if (offset < hex.length) parts.push(hex.slice(offset, offset + length));
            offset += length;
        });
        var formatted = parts.join('-');
        if (hex.length === 32) return '{' + formatted.toUpperCase() + '}';
        if (body.charAt(body.length - 1) === '-' && [8, 12, 16, 20].indexOf(hex.length) !== -1) formatted += '-';
        return (opening ? '{' : '') + formatted;
    }

    function replaceSelection(input, text) {
        var start = input.selectionStart === null ? input.value.length : input.selectionStart;
        var end = input.selectionEnd === null ? start : input.selectionEnd;
        return input.value.slice(0, start) + text + input.value.slice(end);
    }

    function insertedText(before, after) {
        var start = 0;
        while (start < before.length && start < after.length && before.charAt(start) === after.charAt(start)) start++;
        var endBefore = before.length, endAfter = after.length;
        while (endBefore > start && endAfter > start && before.charAt(endBefore - 1) === after.charAt(endAfter - 1)) { endBefore--; endAfter--; }
        return after.slice(start, endAfter);
    }

    function focusEnd(input) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
    }

    /**
     * The adapter owns text presentation only. Its caller retains the original DTO envelope.
     * readValue() returns the exact initial text until an accepted edit emits onChange(text).
     */
    function render(options) {
        var name = options.type;
        var type = TYPES[name];
        if (!type) throw new Error('Unsupported targeting input type: ' + name);
        var words = WORDS[options.language === 'ru' ? 'ru' : 'en'];
        var label = options.label || words[name];
        var disabled = Boolean(options.disabled);
        var original = options.value === null || options.value === undefined ? '' : String(options.value);
        var current = original;
        var inputs = [];
        var element = create('div', {
            className: ['gpo-targeting-typed-input', 'gpo-targeting-typed-input--' + name],
            attrs: { role: 'group', 'aria-label': label, 'aria-disabled': disabled ? 'true' : null }
        });
        var singleType = name === 'guid' || name === 'ipv6';
        var parts = singleType ? null : splitSegments(original, name);
        var fallback = name === 'guid' ? guidValue(original) === null : name === 'ipv6' ? !type.inserted.test(original) : parts === null;

        function emit(value) {
            if (disabled || value === current) return;
            current = value;
            if (typeof options.onChange === 'function') options.onChange(value);
        }

        function inputElement(className, inputLabel, size) {
            var input = create('input', {
                className: className,
                attrs: { id: 'gpo-targeting-typed-input-' + nextInputId++, type: 'text', 'aria-label': inputLabel, inputmode: name === 'ipv4' || name === 'version' ? 'numeric' : 'text',
                    autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', size: size,
                    disabled: disabled ? 'disabled' : null }
            }).getElement();
            inputs.push(input);
            element.append(input);
            return input;
        }

        function bindSingle(input, isFallback) {
            var accepted = original;
            input.value = original;
            function normalized(candidate) {
                if (name === 'guid') return guidValue(candidate);
                if (name === 'ipv6') return type.inserted.test(candidate) ? candidate : null;
                var parsed = splitSegments(candidate, name);
                if (!parsed) return null;
                while (parsed.length && parsed[parsed.length - 1] === '') parsed.pop();
                return parsed.join(type.separator);
            }
            function accept(candidate, paste) {
                var formatted = normalized(candidate);
                if (formatted === null) {
                    // A legacy value can be corrected incrementally, retaining the remaining text.
                    // Newly pasted or wholly replaced invalid text is never silently shortened.
                    if (!isFallback || paste || !type.inserted.test(insertedText(accepted, candidate))
                        || candidate.length >= accepted.length && normalized(accepted) !== null) return false;
                    formatted = candidate;
                }
                var caret = input.selectionStart;
                var atEnd = caret === input.value.length;
                var hexBefore = name === 'guid' && caret !== null ? (input.value.slice(0, caret).match(/[a-f\d]/gi) || []).length : 0;
                input.value = formatted;
                accepted = formatted;
                if (atEnd || paste) input.setSelectionRange(formatted.length, formatted.length);
                else if (name === 'guid' && caret !== null) {
                    var position = 0, seen = 0;
                    while (position < formatted.length && seen < hexBefore) { if (/[a-f\d]/i.test(formatted.charAt(position))) seen++; position++; }
                    input.setSelectionRange(position, position);
                }
                emit(formatted);
                return true;
            }
            function deleteGuid(inputType) {
                if (name !== 'guid' || guidValue(input.value) === null) return false;
                var start = input.selectionStart, end = input.selectionEnd;
                if (start === null || end === null) return false;
                var hex = input.value.replace(/[{}-]/g, '');
                if (!hex.length) { accept('', false); input.setSelectionRange(0, 0); return true; }
                var before = (input.value.slice(0, start).match(/[a-f\d]/gi) || []).length;
                var after = (input.value.slice(0, end).match(/[a-f\d]/gi) || []).length;
                var backward = /Backward$/.test(inputType);
                if (before === after) {
                    if (backward) before--;
                    else after++;
                }
                if (before < 0 || after > hex.length) return true;
                var remaining = hex.slice(0, before) + hex.slice(after);
                var candidate = remaining && input.value.charAt(0) === '{' ? '{' + remaining : remaining;
                accept(candidate, false);
                var position = 0, seen = 0;
                while (position < input.value.length && seen < before) { if (/[a-f\d]/i.test(input.value.charAt(position))) seen++; position++; }
                input.setSelectionRange(position, position);
                return true;
            }
            input.addEventListener('beforeinput', function(event) {
                if (disabled) { event.preventDefault(); return; }
                if (event.inputType.indexOf('delete') === 0) {
                    if (deleteGuid(event.inputType)) event.preventDefault();
                    return;
                }
                if (event.data === null || event.data === undefined) return;
                var candidate = replaceSelection(input, event.data);
                if (!type.inserted.test(event.data) || !isFallback && normalized(candidate) === null) event.preventDefault();
            });
            input.addEventListener('input', function() {
                if (disabled || !type.inserted.test(insertedText(accepted, input.value)) || !accept(input.value, false)) input.value = accepted;
            });
            input.addEventListener('paste', function(event) {
                event.preventDefault();
                if (disabled || !event.clipboardData) return;
                var text = event.clipboardData.getData('text/plain');
                if (!type.inserted.test(text)) return;
                // A complete value replaces the operand even if the caret is inside an old value.
                var whole = normalized(text);
                var complete = name === 'guid' ? whole && /^\{[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}\}$/i.test(whole)
                    : name === 'ipv6' ? whole && whole.indexOf(':') !== -1 : whole && splitSegments(text, name).length === type.count;
                accept(complete ? text : replaceSelection(input, text), true);
            });
        }

        if (fallback || singleType) {
            var single = inputElement(fallback ? 'gpo-targeting-typed-input__fallback' : ['gpo-targeting-typed-input__segment', 'gpo-targeting-typed-input__full'],
                fallback ? label + ', ' + words.saved : label, name === 'guid' ? 38 : name === 'ipv6' ? 39 : undefined);
            bindSingle(single, fallback);
        } else {
            var segmentName = name === 'ipv4' ? words.octet : name === 'mac' ? words.byte : words.component;
            for (var index = 0; index < type.count; index++) {
                if (index) element.append(create('span', { className: 'gpo-targeting-typed-input__separator', attrs: { 'aria-hidden': 'true' }, text: type.separator }));
                var segment = inputElement('gpo-targeting-typed-input__segment', label + ', ' + segmentName + ' ' + (index + 1) + ' ' + words.of + ' ' + type.count, type.length);
                segment.value = parts[index] || '';
                bindSegment(segment, index);
            }
        }

        function bindSegment(input, index) {
            function commit() {
                inputs.forEach(function(segment) { segment._targetingAccepted = segment.value; });
                emit(joinSegments(inputs, type.separator));
            }
            input._targetingAccepted = input.value;
            function restore() { input.value = input._targetingAccepted; }
            function advance() { if (inputs[index + 1]) { inputs[index + 1].focus(); inputs[index + 1].select(); } }
            input.addEventListener('keydown', function(event) {
                if (disabled || event.ctrlKey || event.metaKey || event.altKey) return;
                if (event.key === type.separator || name === 'mac' && event.key === '-') { event.preventDefault(); advance(); }
                else if (event.key === 'Backspace' && input.value === '' && index) { event.preventDefault(); focusEnd(inputs[index - 1]); }
            });
            input.addEventListener('beforeinput', function(event) {
                if (disabled) { event.preventDefault(); return; }
                if (event.data === null || event.data === undefined || event.inputType.indexOf('delete') === 0) return;
                if (event.data === type.separator || name === 'mac' && event.data === '-') { event.preventDefault(); advance(); return; }
                if (!validSegment(replaceSelection(input, event.data), type)) event.preventDefault();
            });
            input.addEventListener('input', function() {
                if (disabled || !validSegment(input.value, type)) { restore(); return; }
                commit();
            });
            input.addEventListener('paste', function(event) {
                event.preventDefault();
                if (disabled || !event.clipboardData) return;
                var text = event.clipboardData.getData('text/plain');
                var distributed = text.indexOf(type.separator) !== -1 || name === 'mac' && (text.indexOf('-') !== -1 || text.length > type.length);
                if (!distributed) {
                    var local = replaceSelection(input, text);
                    if (!validSegment(local, type)) return;
                    input.value = local;
                    focusEnd(input);
                    commit();
                    return;
                }
                var pasted = splitSegments(text, name);
                if (!pasted) return;
                var start = pasted.length === type.count ? 0 : index;
                if (start + pasted.length > type.count) return;
                for (var i = start; i < type.count; i++) inputs[i].value = pasted[i - start] || '';
                commit();
                focusEnd(inputs[Math.min(start + pasted.length - 1, type.count - 1)]);
            });
        }

        return {
            element: element,
            inputs: inputs,
            readValue: function() { return current; },
            focus: function() { if (inputs[0]) inputs[0].focus(); }
        };
    }

    return { render: render };
});
