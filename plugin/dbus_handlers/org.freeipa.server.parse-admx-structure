#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""D-Bus handler for parsing ADMX/ADML files and generating policy dictionary."""

import sys
import json
import re
from pathlib import Path
import xml.etree.ElementTree as ET


# $(string.ID)
STRING_REF = re.compile(r"\$\(\s*string\.([A-Za-z0-9_.-]+)\s*\)")
# $(presentation.ID)
PRESENTATION_REF = re.compile(r"\$\(\s*presentation\.([A-Za-z0-9_.-]+)\s*\)")


def strip_ns(tag: str) -> str:
    """Remove XML namespace from tag."""
    return tag.split("}", 1)[-1]


def norm_ref(ref: str | None) -> str | None:
    """
    Normalize refs like:
      ALT_System
      BaseALT:ALT_System
    -> ALT_System
    """
    if ref is None:
        return None

    ref = ref.strip()
    if not ref:
        return None

    if ":" in ref:
        ref = ref.split(":", 1)[1].strip()

    return ref or None


def resolve_string(value: str | None, strings: dict) -> str | None:
    """
    Resolve $(string.X) using loaded ADML stringTable.
    If not resolvable, return the original value.
    """
    if not value:
        return None

    m = STRING_REF.fullmatch(value.strip())
    if not m:
        return value

    sid = m.group(1)
    return strings.get(sid, value)


def resolve_presentation_id(value: str | None) -> str | None:
    """
    Resolve $(presentation.X) -> X
    If not resolvable, return None.
    """
    if not value:
        return None
    m = PRESENTATION_REF.fullmatch(value.strip())
    if not m:
        return None
    return m.group(1)


# ----------------------- Locale selection -----------------------

def pick_locale_dir(base_dir: Path, requested_locale: str | None) -> str:
    """
    If requested locale is missing/None or its folder does not exist,
    fall back to 'en-US' (if exists). If 'en-US' also doesn't exist,
    fall back to the first existing locale folder that contains *.adml.
    """
    def _has_adml(locale_name: str) -> bool:
        d = base_dir / locale_name
        return d.is_dir() and any(d.rglob("*.adml"))

    if requested_locale and _has_adml(requested_locale):
        return requested_locale

    if _has_adml("en-US"):
        return "en-US"

    # last resort: any locale folder with adml
    for d in sorted([p for p in base_dir.iterdir() if p.is_dir()]):
        if any(d.rglob("*.adml")):
            return d.name

    # No locale dirs with ADML at all; keep en-US as default label
    return "en-US"


def load_adml_strings(base_dir: Path, locale: str) -> dict:
    """Load all <string id="..."> entries from <base_dir>/<locale>/*.adml"""
    locale_dir = base_dir / locale
    if not locale_dir.is_dir():
        raise RuntimeError(f"Locale directory not found: {locale_dir}")

    strings: dict[str, str] = {}

    for adml_file in locale_dir.rglob("*.adml"):
        try:
            tree = ET.parse(adml_file)
        except ET.ParseError as e:
            print(f"[WARN] ADML parse error: {adml_file}: {e}", file=sys.stderr)
            continue

        root = tree.getroot()
        for el in root.iter():
            if strip_ns(el.tag) != "string":
                continue

            sid = el.attrib.get("id")
            if not sid:
                continue

            strings[sid] = (el.text or "").strip()

    return strings


# ----------------------- supportedOn localization -----------------------

def localize_supported_on(supported_on_ref: str | None, strings: dict) -> str | None:
    if not supported_on_ref:
        return None

    ref = supported_on_ref.strip()
    if not ref:
        return None

    tail = ref.split(":", 1)[-1]

    candidates: list[str] = [tail]
    if tail.startswith("SUPPORTED_"):
        candidates.append(tail[len("SUPPORTED_"):])

    for cid in candidates:
        if cid in strings:
            return strings[cid]

    suffix = tail
    for k, v in strings.items():
        if k.endswith(suffix):
            return v
    suffix_low = suffix.lower()
    for k, v in strings.items():
        if k.lower().endswith(suffix_low):
            return v

    return supported_on_ref


# ----------------------- Presentation label/defaults -----------------------

def _extract_presentation_control_label(ctrl: ET.Element, strings: dict) -> str | None:
    txt = (ctrl.text or "").strip()
    if txt:
        return resolve_string(txt, strings)

    for ch in ctrl:
        if strip_ns(ch.tag) == "label":
            t = (ch.text or "").strip()
            if t:
                return resolve_string(t, strings)

    return None


def load_adml_presentations(base_dir: Path, locale: str, strings: dict) -> dict:
    """
    presentations[presentation_id][refId] = {
      "label": "...",
      "defaultItem": "...",
      "defaultValue": "..."
    }
    """
    locale_dir = base_dir / locale
    if not locale_dir.is_dir():
        raise RuntimeError(f"Locale directory not found: {locale_dir}")

    presentations: dict[str, dict[str, dict]] = {}

    for adml_file in locale_dir.rglob("*.adml"):
        try:
            tree = ET.parse(adml_file)
        except ET.ParseError as e:
            print(f"[WARN] ADML parse error: {adml_file}: {e}", file=sys.stderr)
            continue

        root = tree.getroot()

        for pres_table in root.iter():
            if strip_ns(pres_table.tag) != "presentationTable":
                continue

            for pres in pres_table:
                if strip_ns(pres.tag) != "presentation":
                    continue

                pres_id = pres.attrib.get("id")
                if not pres_id:
                    continue

                slot = presentations.setdefault(pres_id, {})

                for ctrl in pres:
                    ref_id = ctrl.attrib.get("refId")
                    if not ref_id:
                        continue

                    info: dict[str, object] = {}

                    label = _extract_presentation_control_label(ctrl, strings)
                    if label:
                        info["label"] = label

                    if "defaultItem" in ctrl.attrib:
                        info["defaultItem"] = ctrl.attrib.get("defaultItem")
                    if "defaultValue" in ctrl.attrib:
                        info["defaultValue"] = ctrl.attrib.get("defaultValue")

                    if info:
                        if ref_id not in slot:
                            slot[ref_id] = info
                        else:
                            for k, v in info.items():
                                slot[ref_id].setdefault(k, v)

    return presentations


# ----------------------- Categories -----------------------

def parse_categories_from_admx(admx_file: Path, strings: dict) -> dict:
    categories: dict[str, dict] = {}

    try:
        tree = ET.parse(admx_file)
    except ET.ParseError as e:
        print(f"[WARN] ADMX parse error: {admx_file}: {e}", file=sys.stderr)
        return categories

    root = tree.getroot()

    for cats_block in root.iter():
        if strip_ns(cats_block.tag) != "categories":
            continue

        for cat in cats_block:
            if strip_ns(cat.tag) != "category":
                continue

            cat_id = cat.attrib.get("name")
            if not cat_id:
                continue

            parent = None
            for ch in cat:
                if strip_ns(ch.tag) == "parentCategory":
                    parent = norm_ref(ch.attrib.get("ref"))

            display_name = resolve_string(cat.attrib.get("displayName"), strings)

            categories[cat_id] = {
                "id": cat_id,
                "displayName": display_name,
                "parent": parent,
                "inherited_ids": [],
            }

    return categories


def merge_category(existing: dict, incoming: dict) -> dict:
    if not existing.get("parent") and incoming.get("parent"):
        existing["parent"] = incoming["parent"]
    if not existing.get("displayName") and incoming.get("displayName"):
        existing["displayName"] = incoming["displayName"]
    return existing


# ----------------------- Data binding -----------------------

def data_ref(heavykey: str) -> str:
    return f"Read_Path_GPT('{heavykey}')"


def wrap_metadata_with_data(metadata: dict, heavykey: str) -> dict:
    return {"metadata": metadata, "data": data_ref(heavykey)}


# ----------------------- Values -----------------------

def _extract_value_from_value_node(value_node: ET.Element) -> str | None:
    if value_node is None:
        return None

    for ch in value_node:
        local = strip_ns(ch.tag)
        if local == "string":
            return (ch.text or "").strip()
        if local == "decimal":
            v = ch.attrib.get("value")
            return (v or "").strip() if v is not None else None

    return None


def _apply_presentation_defaults(md: dict, pres_info: dict | None) -> dict:
    if not pres_info:
        return md

    if pres_info.get("label") is not None:
        md["label"] = pres_info.get("label")

    if pres_info.get("defaultItem") is not None:
        md["defaultItem"] = pres_info.get("defaultItem")

    if pres_info.get("defaultValue") is not None:
        md["defaultValue"] = pres_info.get("defaultValue")

    return md


def _parse_enum_metadata(el: ET.Element, strings: dict, pres_info: dict | None) -> dict:
    enum_id = el.attrib.get("id")
    value_name = el.attrib.get("valueName")
    required = (el.attrib.get("required") or "").strip().lower() == "true"

    items: dict[str, str] = {}
    for item in el:
        if strip_ns(item.tag) != "item":
            continue

        disp_raw = item.attrib.get("displayName")
        disp = resolve_string(disp_raw, strings)

        val = None
        for ch in item:
            if strip_ns(ch.tag) == "value":
                val = _extract_value_from_value_node(ch)
                break
        if val is None:
            continue

        items[str(val)] = disp

    md = {
        "type": "enum",
        "id": enum_id,
        "valueName": value_name,
        "required": required,
        "items": items,
    }
    return _apply_presentation_defaults(md, pres_info)


def _parse_boolean_metadata(el: ET.Element, pres_info: dict | None) -> dict:
    bool_id = el.attrib.get("id")
    key = el.attrib.get("key")
    value_name = el.attrib.get("valueName")

    true_v = None
    false_v = None

    for ch in el:
        local = strip_ns(ch.tag)
        if local == "trueValue":
            for x in ch:
                if strip_ns(x.tag) == "decimal":
                    true_v = x.attrib.get("value")
        elif local == "falseValue":
            for x in ch:
                if strip_ns(x.tag) == "decimal":
                    false_v = x.attrib.get("value")

    def _to_num_or_str(v: str | None):
        if v is None:
            return None
        v = v.strip()
        if v.isdigit() or (v.startswith("-") and v[1:].isdigit()):
            try:
                return int(v)
            except ValueError:
                return v
        return v

    md = {
        "type": "boolean",
        "id": bool_id,
        "key": key,
        "valueName": value_name,
        "trueValue": _to_num_or_str(true_v),
        "falseValue": _to_num_or_str(false_v),
    }
    return _apply_presentation_defaults(md, pres_info)


def _parse_text_metadata(el: ET.Element, pres_info: dict | None) -> dict:
    text_id = el.attrib.get("id")
    value_name = el.attrib.get("valueName")
    md = {"type": "text", "id": text_id, "valueName": value_name, "required": False}
    return _apply_presentation_defaults(md, pres_info)


def _parse_list_metadata(el: ET.Element, pres_info: dict | None) -> dict:
    list_id = el.attrib.get("id")
    key = el.attrib.get("key")
    additive = (el.attrib.get("additive") or "").strip().lower() == "true"
    md = {"type": "list", "id": list_id, "key": key, "additive": additive}
    return _apply_presentation_defaults(md, pres_info)


def _parse_decimal_metadata(el: ET.Element, pres_info: dict | None) -> dict:
    dec_id = el.attrib.get("id")
    value_name = el.attrib.get("valueName")
    required = (el.attrib.get("required") or "").strip().lower() == "true"

    def _as_int_or_none(v: str | None):
        if v is None:
            return None
        v = v.strip()
        try:
            return int(v)
        except ValueError:
            return None

    min_v = _as_int_or_none(el.attrib.get("minValue"))
    max_v = _as_int_or_none(el.attrib.get("maxValue"))

    md = {
        "type": "decimal",
        "id": dec_id,
        "valueName": value_name,
        "required": required,
        "minValue": min_v,
        "maxValue": max_v,
    }
    return _apply_presentation_defaults(md, pres_info)


def _parse_policy_value_enabled_disabled_metadata(pol: ET.Element) -> dict | None:
    enabled_v = None
    disabled_v = None

    def _read_value(container: ET.Element) -> str | None:
        for x in container:
            local = strip_ns(x.tag)
            if local == "decimal":
                v = x.attrib.get("value")
                return (v or "").strip() if v is not None else None
            if local == "string":
                return (x.text or "").strip()
        return None

    for ch in pol:
        local = strip_ns(ch.tag)
        if local == "enabledValue":
            enabled_v = _read_value(ch)
        elif local == "disabledValue":
            disabled_v = _read_value(ch)

    if enabled_v is None and disabled_v is None:
        return None

    def _to_num_or_str(v: str | None):
        if v is None:
            return None
        v = v.strip()
        if v.isdigit() or (v.startswith("-") and v[1:].isdigit()):
            try:
                return int(v)
            except ValueError:
                return v
        return v

    return {
        "type": "policyValue",
        "enabledValue": _to_num_or_str(enabled_v),
        "disabledValue": _to_num_or_str(disabled_v),
    }


# ----------------------- Policy parse -----------------------

def parse_policy_to_flat_json(pol: ET.Element, strings: dict, presentations: dict) -> dict:
    header = {
        "class": pol.attrib.get("class"),
        "name": pol.attrib.get("name"),
        "displayName": resolve_string(pol.attrib.get("displayName"), strings),
        "explainText": resolve_string(pol.attrib.get("explainText"), strings),
        "key": (pol.attrib.get("key") or "").replace("/", "\\"),
        "valueName": pol.attrib.get("valueName") or pol.attrib.get("valuename"),
        "presentation": pol.attrib.get("presentation"),
        "parentCategory": None,
        "supportedOn": None,
    }

    for ch in pol:
        local = strip_ns(ch.tag)
        if local == "parentCategory":
            header["parentCategory"] = ch.attrib.get("ref")
        elif local == "supportedOn":
            header["supportedOn"] = localize_supported_on(ch.attrib.get("ref"), strings)

    policy_obj: dict = {"header": header}

    pres_id = resolve_presentation_id(header.get("presentation"))
    pres_map = presentations.get(pres_id, {}) if pres_id else {}

    def pres_info_for_refid(ref_id: str | None) -> dict | None:
        if not ref_id:
            return None
        v = pres_map.get(ref_id)
        return v if isinstance(v, dict) else None

    pv_meta = _parse_policy_value_enabled_disabled_metadata(pol)
    if pv_meta is not None:
        base_key = header.get("key") or ""
        vn = header.get("valueName") or ""
        heavykey = f"{base_key}\\{vn}".rstrip("\\")
        policy_obj[heavykey] = wrap_metadata_with_data(pv_meta, heavykey)
        return policy_obj

    base_key = header.get("key") or ""
    elements_node = None
    for ch in pol:
        if strip_ns(ch.tag) == "elements":
            elements_node = ch
            break

    if elements_node is None:
        return policy_obj

    for el in elements_node:
        local = strip_ns(el.tag)
        el_id = el.attrib.get("id")
        pres_info = pres_info_for_refid(el_id)

        if local == "enum":
            meta = _parse_enum_metadata(el, strings, pres_info)
            vn = (el.attrib.get("valueName") or "").strip()
            heavykey = f"{base_key}\\{vn}".rstrip("\\")
            policy_obj[heavykey] = wrap_metadata_with_data(meta, heavykey)

        elif local == "boolean":
            meta = _parse_boolean_metadata(el, pres_info)
            k = (el.attrib.get("key") or "").replace("/", "\\")
            vn = (el.attrib.get("valueName") or "").strip()
            heavykey = f"{k}\\{vn}".rstrip("\\")
            policy_obj[heavykey] = wrap_metadata_with_data(meta, heavykey)

        elif local == "text":
            meta = _parse_text_metadata(el, pres_info)
            vn = (el.attrib.get("valueName") or "").strip()
            heavykey = f"{base_key}\\{vn}".rstrip("\\")
            policy_obj[heavykey] = wrap_metadata_with_data(meta, heavykey)

        elif local == "list":
            meta = _parse_list_metadata(el, pres_info)
            k = (el.attrib.get("key") or "").replace("/", "\\")
            policy_obj[k] = wrap_metadata_with_data(meta, k)

        elif local == "decimal":
            meta = _parse_decimal_metadata(el, pres_info)
            vn = (el.attrib.get("valueName") or "").strip()
            heavykey = f"{base_key}\\{vn}".rstrip("\\")
            policy_obj[heavykey] = wrap_metadata_with_data(meta, heavykey)

    return policy_obj


def parse_policies_for_index_from_admx(admx_file: Path, strings: dict, presentations: dict) -> list[dict]:
    policies: list[dict] = []

    try:
        tree = ET.parse(admx_file)
    except ET.ParseError as e:
        print(f"[WARN] ADMX parse error: {admx_file}: {e}", file=sys.stderr)
        return policies

    root = tree.getroot()

    for pol_block in root.iter():
        if strip_ns(pol_block.tag) != "policies":
            continue

        for pol in pol_block:
            if strip_ns(pol.tag) != "policy":
                continue

            pol_class = (pol.attrib.get("class") or "").strip()
            pol_display = resolve_string(pol.attrib.get("displayName"), strings)

            cat_ref = None
            for ch in pol:
                local = strip_ns(ch.tag)
                if local in ("category", "parentCategory"):
                    cat_ref = norm_ref(ch.attrib.get("ref"))
                    if cat_ref:
                        break

            policies.append({
                "class": pol_class,
                "displayName": pol_display,
                "categoryRef": cat_ref,
                "policyJson": parse_policy_to_flat_json(pol, strings, presentations),
            })

    return policies


# ----------------------- Category tree -----------------------

def link_category_inherited(categories: dict[str, dict]) -> None:
    for c in categories.values():
        c["inherited_ids"] = []
    for c in categories.values():
        parent = c.get("parent")
        if parent and parent in categories:
            categories[parent]["inherited_ids"].append(c["id"])
    for c in categories.values():
        c["inherited_ids"].sort()


def build_policy_index_expanded(policies: list[dict], categories: dict[str, dict]) -> dict:
    idx = {"Machine": {}, "User": {}}

    def add(cls: str, cat_id: str, item: dict):
        idx[cls].setdefault(cat_id, []).append(item)

    for p in policies:
        cls_raw = (p.get("class") or "").strip()
        cat = p.get("categoryRef") or "__UNCATEGORIZED__"

        if cat != "__UNCATEGORIZED__" and cat not in categories:
            cat = "__UNCATEGORIZED__"

        flat = p.get("policyJson") or {}
        item = {"displayName": p.get("displayName") or None, **flat}

        if cls_raw == "Machine":
            add("Machine", cat, item)
        elif cls_raw == "User":
            add("User", cat, item)
        elif cls_raw == "Both":
            add("Machine", cat, item)
            add("User", cat, item)
        else:
            add("Machine", cat, item)
            add("User", cat, item)

    for cls in ("Machine", "User"):
        for cat_id in idx[cls]:
            idx[cls][cat_id].sort(key=lambda x: (x.get("displayName") or ""))

    return idx


def build_category_tree_for_class_expanded(
    categories: dict[str, dict],
    policy_index_for_class: dict[str, list[dict]],
) -> list[dict]:
    def make_node(cat_id: str) -> dict:
        cat = categories[cat_id]
        node = {
            "category": cat.get("displayName") or cat_id,
            "policies": policy_index_for_class.get(cat_id, []),
            "inherited": [make_node(child_id) for child_id in cat.get("inherited_ids", [])],
        }
        node["inherited"].sort(key=lambda x: (x.get("category") or ""))
        return node

    roots = [
        c_id for c_id, c in categories.items()
        if not c.get("parent") or c.get("parent") not in categories
    ]
    roots.sort()

    tree = [make_node(r) for r in roots]
    tree.sort(key=lambda x: (x.get("category") or ""))
    return tree


def usage(prog: str) -> None:
    print("Error: Insufficient arguments", file=sys.stderr)
    print(f"Usage: {prog} <policy_definitions_path> [language]", file=sys.stderr)


def main() -> int:
    # Match the other script's CLI:
    #   <policy_definitions_path> [language]
    if len(sys.argv) < 2:
        usage(Path(sys.argv[0]).name)
        return 1

    policy_definitions_path = sys.argv[1]
    requested_locale = sys.argv[2] if len(sys.argv) > 2 else "en-US"

    base_dir = Path(policy_definitions_path).resolve()
    if not base_dir.is_dir():
        print(f"Error: Policy definitions path does not exist: {base_dir}", file=sys.stderr)
        return 1

    # Locale fallback policy stays: if requested missing -> en-US -> any locale with ADML
    chosen_locale = pick_locale_dir(base_dir, requested_locale)

    print(f"Parsing ADMX/ADML files from: {base_dir}", file=sys.stderr)
    print(f"Language: {requested_locale}", file=sys.stderr)
    if chosen_locale != requested_locale:
        print(f"[INFO] Using locale fallback: {chosen_locale}", file=sys.stderr)

    strings = load_adml_strings(base_dir, chosen_locale)
    presentations = load_adml_presentations(base_dir, chosen_locale, strings)

    categories: dict[str, dict] = {}
    all_policies: list[dict] = []

    for admx_file in base_dir.rglob("*.admx"):
        parsed_cats = parse_categories_from_admx(admx_file, strings)
        for cat_id, cat in parsed_cats.items():
            if cat_id not in categories:
                categories[cat_id] = cat
            else:
                categories[cat_id] = merge_category(categories[cat_id], cat)

        all_policies.extend(parse_policies_for_index_from_admx(admx_file, strings, presentations))

    link_category_inherited(categories)

    policy_index = build_policy_index_expanded(all_policies, categories)

    machine_tree = build_category_tree_for_class_expanded(categories, policy_index["Machine"])
    user_tree = build_category_tree_for_class_expanded(categories, policy_index["User"])

    unc_machine = policy_index["Machine"].get("__UNCATEGORIZED__", [])
    unc_user = policy_index["User"].get("__UNCATEGORIZED__", [])

    result = {
        "meta": {
            "baseDir": str(base_dir),
            "localeRequested": requested_locale,
            "localeUsed": chosen_locale,
            "Total categories": len(categories),
            "Total policies": len(all_policies),
        },
        "Machine": {
            "categories": machine_tree,
            "uncategorizedPolicies": unc_machine,
        },
        "User": {
            "categories": user_tree,
            "uncategorizedPolicies": unc_user,
        },
    }

    # JSON -> stdout
    print(json.dumps(result, ensure_ascii=False, indent=2))

    print(f"\nParsing completed:", file=sys.stderr)
    print(f"  - Total policies: {len(all_policies)}", file=sys.stderr)
    print(f"  - Total categories: {len(categories)}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    sys.exit(main())
