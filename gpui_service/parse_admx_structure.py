#
# gpuiservice - GPT Directory Management API Service
#
# Copyright (C) 2025 BaseALT Ltd.
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program.  If not, see <http://www.gnu.org/licenses/>.

import sys
import json
import re
from pathlib import Path
import xml.etree.ElementTree as ET


# $(string.ID)
STRING_REF = re.compile(r"\$\(\s*string\.([A-Za-z0-9_.-]+)\s*\)")
# $(presentation.ID)
PRESENTATION_REF = re.compile(r"\$\(\s*presentation\.([A-Za-z0-9_.-]+)\s*\)")


class AdmxParser:
    """Parser for ADMX/ADML files."""

    # Class-level caches for strings and presentations to avoid redundant loading
    _strings_cache: dict[tuple[Path, str], dict] = {}
    _presentations_cache: dict[tuple[Path, str], dict] = {}

    def __init__(self, admx_filepath: str, locale: str = "en-US"):
        """
        Initialize parser for a single ADMX file.

        Args:
            admx_filepath: Path to the ADMX file
            locale: Locale for loading ADML strings and presentations
        """
        self.admx_filepath = Path(admx_filepath) if admx_filepath else Path()
        self.base_dir = self.admx_filepath.parent if admx_filepath else Path()
        self.locale = locale
        self.strings = {}
        self.presentations = {}
        self.categories = {}
        self.policies = []

    # --- JSON helpers (as requested) ---

    @staticmethod
    def dumps(obj: dict, *, ensure_ascii: bool = False, indent: int = 2) -> str:
        """Provide json.dumps(...) from AdmxParser."""
        return json.dumps(obj, ensure_ascii=ensure_ascii, indent=indent)

    @classmethod
    def build_result_for_dir(cls, policy_definitions_path: str, locale: str = "en-US") -> dict:
        """
        Build the final result (meta + Machine/User trees) for a directory
        containing multiple *.admx files and locale subfolders with *.adml.
        """
        base_dir = Path(policy_definitions_path).resolve()
        if not base_dir.is_dir():
            raise RuntimeError(f"Policy definitions path does not exist: {base_dir}")

        # Aggregate categories and policies from all ADMX files
        all_categories: dict[str, dict] = {}
        all_policies: list[dict] = []
        seen_policy_keys: set[tuple] = set()
        duplicates_removed = 0

        # Track actually used locales (parser may fallback per file)
        used_locales: set[str] = set()

        for admx_file in base_dir.rglob("*.admx"):
            parser = cls(str(admx_file), locale)
            parser.parse()
            used_locales.add(parser.locale)

            # Merge categories
            for cat_id, cat in parser.get_categories().items():
                if cat_id not in all_categories:
                    all_categories[cat_id] = cat
                else:
                    all_categories[cat_id] = merge_category(all_categories[cat_id], cat)

            # Deduplicate policies by (class, categoryRef, name)
            for policy in parser.get_policies():
                policy_json = policy.get("policyJson", {})
                header = policy_json.get("header", {}) if isinstance(policy_json, dict) else {}
                name = header.get("name")
                if name is not None:
                    key = (policy.get("class"), policy.get("categoryRef"), name)
                    if key in seen_policy_keys:
                        duplicates_removed += 1
                        continue
                    seen_policy_keys.add(key)
                all_policies.append(policy)

        link_category_inherited(all_categories)

        policy_index = build_policy_index_expanded(all_policies, all_categories)

        machine_tree = build_category_tree_for_class_expanded(all_categories, policy_index["Machine"])
        user_tree = build_category_tree_for_class_expanded(all_categories, policy_index["User"])

        unc_machine = policy_index["Machine"].get("__UNCATEGORIZED__", {})
        unc_user = policy_index["User"].get("__UNCATEGORIZED__", {})

        locale_used = None
        if len(used_locales) == 1:
            locale_used = next(iter(used_locales))
        elif len(used_locales) > 1:
            # Mixed fallbacks across files; expose all
            locale_used = sorted(used_locales)

        return {
            "meta": {
                "baseDir": str(base_dir),
                "localeRequested": locale,
                "localeUsed": locale_used or locale,
                "Total categories": len(all_categories),
                "Total policies": len(all_policies),
                "Duplicates removed": duplicates_removed,
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

    # --- Core parsing logic ---

    @staticmethod
    def strip_ns(tag: str) -> str:
        """Remove XML namespace from tag."""
        return tag.split("}", 1)[-1]

    @staticmethod
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

    def resolve_string(self, value: str | None) -> str | None:
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
        return self.strings.get(sid, value)

    @staticmethod
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

    def _pick_locale_dir(self, requested_locale: str | None) -> str:
        """
        If requested locale is missing/None or its folder does not exist,
        fall back to 'en-US' (if exists). If 'en-US' also doesn't exist,
        fall back to the first existing locale folder that contains *.adml.
        """
        def _has_adml(locale_name: str) -> bool:
            d = self.base_dir / locale_name
            return d.is_dir() and any(d.rglob("*.adml"))

        if requested_locale and _has_adml(requested_locale):
            return requested_locale

        if _has_adml("en-US"):
            return "en-US"

        # last resort: any locale folder with adml
        for d in sorted([p for p in self.base_dir.iterdir() if p.is_dir()]):
            if any(d.rglob("*.adml")):
                return d.name

        # No locale dirs with ADML at all; keep en-US as default label
        return "en-US"

    def load_strings(self) -> None:
        """Load all <string id="..."> entries from <base_dir>/<locale>/*.adml"""
        chosen_locale = self._pick_locale_dir(self.locale)
        locale_dir = self.base_dir / chosen_locale
        if not locale_dir.is_dir():
            raise RuntimeError(f"Locale directory not found: {locale_dir}")

        cache_key = (self.base_dir, chosen_locale)
        if cache_key in AdmxParser._strings_cache:
            self.strings = AdmxParser._strings_cache[cache_key]
            self.locale = chosen_locale
            return

        strings = {}
        for adml_file in locale_dir.rglob("*.adml"):
            try:
                tree = ET.parse(adml_file)
            except ET.ParseError as e:
                print(f"[WARN] ADML parse error: {adml_file}: {e}", file=sys.stderr)
                continue

            root = tree.getroot()
            for el in root.iter():
                if self.strip_ns(el.tag) != "string":
                    continue

                sid = el.attrib.get("id")
                if not sid:
                    continue

                strings[sid] = (el.text or "").strip()

        self.strings = strings
        self.locale = chosen_locale  # update locale to the actual one used
        AdmxParser._strings_cache[cache_key] = strings

    def _extract_presentation_control_label(self, ctrl: ET.Element) -> str | None:
        txt = (ctrl.text or "").strip()
        if txt:
            return self.resolve_string(txt)

        for ch in ctrl:
            if self.strip_ns(ch.tag) == "label":
                t = (ch.text or "").strip()
                if t:
                    return self.resolve_string(t)

        return None

    def load_presentations(self) -> None:
        """
        presentations[presentation_id][refId] = {
          "label": "...",
          "defaultItem": "...",
          "defaultValue": "..."
        }
        """
        locale_dir = self.base_dir / self.locale
        if not locale_dir.is_dir():
            raise RuntimeError(f"Locale directory not found: {locale_dir}")

        cache_key = (self.base_dir, self.locale)
        if cache_key in AdmxParser._presentations_cache:
            self.presentations = AdmxParser._presentations_cache[cache_key]
            return

        presentations = {}
        for adml_file in locale_dir.rglob("*.adml"):
            try:
                tree = ET.parse(adml_file)
            except ET.ParseError as e:
                print(f"[WARN] ADML parse error: {adml_file}: {e}", file=sys.stderr)
                continue

            root = tree.getroot()
            for pres_table in root.iter():
                if self.strip_ns(pres_table.tag) != "presentationTable":
                    continue

                for pres in pres_table:
                    if self.strip_ns(pres.tag) != "presentation":
                        continue

                    pres_id = pres.attrib.get("id")
                    if not pres_id:
                        continue

                    slot = presentations.setdefault(pres_id, {})

                    for ctrl in pres:
                        ref_id = ctrl.attrib.get("refId")
                        if not ref_id:
                            continue

                        info = {}
                        label = self._extract_presentation_control_label(ctrl)
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

        self.presentations = presentations
        AdmxParser._presentations_cache[cache_key] = presentations

    def localize_supported_on(self, supported_on_ref: str | None) -> str | None:
        if not supported_on_ref:
            return None

        ref = supported_on_ref.strip()
        if not ref:
            return None

        tail = ref.split(":", 1)[-1]

        candidates = [tail]
        if tail.startswith("SUPPORTED_"):
            candidates.append(tail[len("SUPPORTED_"):])

        for cid in candidates:
            if cid in self.strings:
                return self.strings[cid]

        suffix = tail
        for k, v in self.strings.items():
            if k.endswith(suffix):
                return v
        suffix_low = suffix.lower()
        for k, v in self.strings.items():
            if k.lower().endswith(suffix_low):
                return v

        return supported_on_ref

    @staticmethod
    def data_ref(heavykey: str) -> str:
        return f"Read_Path_GPT('{heavykey}')"

    @staticmethod
    def wrap_metadata_with_data(metadata: dict, heavykey: str) -> dict:
        return {"metadata": metadata, "data": AdmxParser.data_ref(heavykey)}

    @staticmethod
    def _extract_value_from_value_node(value_node: ET.Element) -> str | None:
        if value_node is None:
            return None

        for ch in value_node:
            local = AdmxParser.strip_ns(ch.tag)
            if local == "string":
                return (ch.text or "").strip()
            if local == "decimal":
                v = ch.attrib.get("value")
                return (v or "").strip() if v is not None else None

        return None

    @staticmethod
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

    def _parse_enum_metadata(self, el: ET.Element, pres_info: dict | None) -> dict:
        enum_id = el.attrib.get("id")
        value_name = el.attrib.get("valueName")
        required = (el.attrib.get("required") or "").strip().lower() == "true"

        items = {}
        for item in el:
            if self.strip_ns(item.tag) != "item":
                continue

            disp_raw = item.attrib.get("displayName")
            disp = self.resolve_string(disp_raw)

            val = None
            for ch in item:
                if self.strip_ns(ch.tag) == "value":
                    val = self._extract_value_from_value_node(ch)
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
        return self._apply_presentation_defaults(md, pres_info)

    def _parse_boolean_metadata(self, el: ET.Element, pres_info: dict | None) -> dict:
        bool_id = el.attrib.get("id")
        key = el.attrib.get("key")
        value_name = el.attrib.get("valueName")

        true_v = None
        false_v = None

        for ch in el:
            local = self.strip_ns(ch.tag)
            if local == "trueValue":
                for x in ch:
                    if self.strip_ns(x.tag) == "decimal":
                        true_v = x.attrib.get("value")
            elif local == "falseValue":
                for x in ch:
                    if self.strip_ns(x.tag) == "decimal":
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
        return self._apply_presentation_defaults(md, pres_info)

    def _parse_text_metadata(self, el: ET.Element, pres_info: dict | None) -> dict:
        text_id = el.attrib.get("id")
        value_name = el.attrib.get("valueName")
        md = {"type": "text", "id": text_id, "valueName": value_name, "required": False}
        return self._apply_presentation_defaults(md, pres_info)

    def _parse_list_metadata(self, el: ET.Element, pres_info: dict | None) -> dict:
        list_id = el.attrib.get("id")
        key = el.attrib.get("key")
        additive = (el.attrib.get("additive") or "").strip().lower() == "true"
        md = {"type": "list", "id": list_id, "key": key, "additive": additive}
        return self._apply_presentation_defaults(md, pres_info)

    def _parse_decimal_metadata(self, el: ET.Element, pres_info: dict | None) -> dict:
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
        return self._apply_presentation_defaults(md, pres_info)

    def _parse_policy_value_enabled_disabled_metadata(self, pol: ET.Element) -> dict | None:
        enabled_v = None
        disabled_v = None

        def _read_value(container: ET.Element) -> str | None:
            for x in container:
                local = self.strip_ns(x.tag)
                if local == "decimal":
                    v = x.attrib.get("value")
                    return (v or "").strip() if v is not None else None
                if local == "string":
                    return (x.text or "").strip()
            return None

        for ch in pol:
            local = self.strip_ns(ch.tag)
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

    def _parse_policy_to_flat_json(self, pol: ET.Element) -> dict:
        header = {
            "class": pol.attrib.get("class"),
            "name": pol.attrib.get("name"),
            "displayName": self.resolve_string(pol.attrib.get("displayName")),
            "explainText": self.resolve_string(pol.attrib.get("explainText")),
            "key": (pol.attrib.get("key") or "").replace("/", "\\"),
            "valueName": pol.attrib.get("valueName") or pol.attrib.get("valuename"),
            "presentation": pol.attrib.get("presentation"),
            "parentCategory": None,
            "supportedOn": None,
        }

        for ch in pol:
            local = self.strip_ns(ch.tag)
            if local == "parentCategory":
                header["parentCategory"] = ch.attrib.get("ref")
            elif local == "supportedOn":
                header["supportedOn"] = self.localize_supported_on(ch.attrib.get("ref"))

        policy_obj = {"header": header}

        pres_id = self.resolve_presentation_id(header.get("presentation"))
        pres_map = self.presentations.get(pres_id, {}) if pres_id else {}

        def pres_info_for_refid(ref_id: str | None) -> dict | None:
            if not ref_id:
                return None
            v = pres_map.get(ref_id)
            return v if isinstance(v, dict) else None

        pv_meta = self._parse_policy_value_enabled_disabled_metadata(pol)
        if pv_meta is not None:
            base_key = header.get("key") or ""
            vn = header.get("valueName") or ""
            heavykey = f"{base_key}\\{vn}".rstrip("\\")
            policy_obj[heavykey] = self.wrap_metadata_with_data(pv_meta, heavykey)
            return policy_obj

        base_key = header.get("key") or ""
        elements_node = None
        for ch in pol:
            if self.strip_ns(ch.tag) == "elements":
                elements_node = ch
                break

        if elements_node is None:
            return policy_obj

        for el in elements_node:
            local = self.strip_ns(el.tag)
            el_id = el.attrib.get("id")
            pres_info = pres_info_for_refid(el_id)

            if local == "enum":
                meta = self._parse_enum_metadata(el, pres_info)
                vn = (el.attrib.get("valueName") or "").strip()
                heavykey = f"{base_key}\\{vn}".rstrip("\\")
                policy_obj[heavykey] = self.wrap_metadata_with_data(meta, heavykey)

            elif local == "boolean":
                meta = self._parse_boolean_metadata(el, pres_info)
                k = (el.attrib.get("key") or "").replace("/", "\\")
                vn = (el.attrib.get("valueName") or "").strip()
                heavykey = f"{k}\\{vn}".rstrip("\\")
                policy_obj[heavykey] = self.wrap_metadata_with_data(meta, heavykey)

            elif local == "text":
                meta = self._parse_text_metadata(el, pres_info)
                vn = (el.attrib.get("valueName") or "").strip()
                heavykey = f"{base_key}\\{vn}".rstrip("\\")
                policy_obj[heavykey] = self.wrap_metadata_with_data(meta, heavykey)

            elif local == "list":
                meta = self._parse_list_metadata(el, pres_info)
                k = (el.attrib.get("key") or "").replace("/", "\\")
                policy_obj[k] = self.wrap_metadata_with_data(meta, k)

            elif local == "decimal":
                meta = self._parse_decimal_metadata(el, pres_info)
                vn = (el.attrib.get("valueName") or "").strip()
                heavykey = f"{base_key}\\{vn}".rstrip("\\")
                policy_obj[heavykey] = self.wrap_metadata_with_data(meta, heavykey)

        return policy_obj

    def parse_categories(self) -> None:
        """Parse categories from the ADMX file."""
        try:
            tree = ET.parse(self.admx_filepath)
        except ET.ParseError as e:
            print(f"[WARN] ADMX parse error: {self.admx_filepath}: {e}", file=sys.stderr)
            return

        root = tree.getroot()
        categories = {}

        for cats_block in root.iter():
            if self.strip_ns(cats_block.tag) != "categories":
                continue

            for cat in cats_block:
                if self.strip_ns(cat.tag) != "category":
                    continue

                cat_id = cat.attrib.get("name")
                if not cat_id:
                    continue

                parent = None
                for ch in cat:
                    if self.strip_ns(ch.tag) == "parentCategory":
                        parent = self.norm_ref(ch.attrib.get("ref"))

                display_name = self.resolve_string(cat.attrib.get("displayName"))

                categories[cat_id] = {
                    "id": cat_id,
                    "displayName": display_name,
                    "parent": parent,
                    "inherited_ids": [],
                }

        self.categories = categories

    def parse_policies(self) -> None:
        """Parse policies from the ADMX file."""
        try:
            tree = ET.parse(self.admx_filepath)
        except ET.ParseError as e:
            print(f"[WARN] ADMX parse error: {self.admx_filepath}: {e}", file=sys.stderr)
            return

        root = tree.getroot()
        policies = []

        for pol_block in root.iter():
            if self.strip_ns(pol_block.tag) != "policies":
                continue

            for pol in pol_block:
                if self.strip_ns(pol.tag) != "policy":
                    continue

                pol_class = (pol.attrib.get("class") or "").strip()
                pol_display = self.resolve_string(pol.attrib.get("displayName"))

                cat_ref = None
                for ch in pol:
                    local = self.strip_ns(ch.tag)
                    if local in ("category", "parentCategory"):
                        cat_ref = self.norm_ref(ch.attrib.get("ref"))
                        if cat_ref:
                            break

                policies.append({
                    "class": pol_class,
                    "displayName": pol_display,
                    "categoryRef": cat_ref,
                    "policyJson": self._parse_policy_to_flat_json(pol),
                })

        self.policies = policies

    def parse(self) -> None:
        """Load strings, presentations, categories and policies."""
        self.load_strings()
        self.load_presentations()
        self.parse_categories()
        self.parse_policies()

    def get_categories(self) -> dict:
        """Return parsed categories."""
        return self.categories

    def get_policies(self) -> list:
        """Return parsed policies."""
        return self.policies

    def get_strings(self) -> dict:
        """Return loaded strings."""
        return self.strings

    def get_presentations(self) -> dict:
        """Return loaded presentations."""
        return self.presentations


# ----------------------- Helper functions for multiple ADMX files -----------------------

def merge_category(existing: dict, incoming: dict) -> dict:
    # Warn about conflicting parent definitions
    if existing.get("parent") and incoming.get("parent") and existing["parent"] != incoming["parent"]:
        print(f"[WARN] Category parent conflict: '{existing.get('id')}' has parent '{existing['parent']}', "
              f"new definition wants parent '{incoming['parent']}' (keeping existing)", file=sys.stderr)

    # Warn about conflicting displayName definitions
    if existing.get("displayName") and incoming.get("displayName") and existing["displayName"] != incoming["displayName"]:
        print(f"[WARN] Category displayName conflict: '{existing.get('id')}' has displayName '{existing['displayName']}', "
              f"new definition wants '{incoming['displayName']}' (keeping existing)", file=sys.stderr)

    if not existing.get("parent") and incoming.get("parent"):
        existing["parent"] = incoming["parent"]
    if not existing.get("displayName") and incoming.get("displayName"):
        existing["displayName"] = incoming["displayName"]
    return existing


def detect_and_break_cycles(categories: dict[str, dict]) -> None:
    """Detect and break circular parent references in categories."""
    visited = set()
    for cat_id in categories:
        current = cat_id
        path = []
        while current is not None:
            if current in path:
                # Cycle detected
                cycle_start = path.index(current)
                cycle = path[cycle_start:] + [current]
                print(f"[WARN] Circular parent reference detected: {' -> '.join(cycle)}", file=sys.stderr)
                # Break cycle by removing parent from the last element in cycle
                broken_cat = cycle[-2] if len(cycle) > 1 else current
                if broken_cat in categories:
                    categories[broken_cat]["parent"] = None
                    print(f"[WARN] Removed parent from category '{broken_cat}' to break cycle", file=sys.stderr)
                break
            path.append(current)
            parent = categories[current].get("parent") if current in categories else None
            if parent not in categories:
                break
            current = parent
        visited.add(cat_id)


def link_category_inherited(categories: dict[str, dict]) -> None:
    # Detect and break any circular parent references
    detect_and_break_cycles(categories)

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
        # Generate unique key for policy: category + displayName (as requested)
        header = item.get("header", {})
        display_name = item.get("displayName") or header.get("displayName") or header.get("name") or "unknown"
        # Use cat_id:display_name as key, ensure uniqueness
        key = f"{cat_id}:{display_name}"
        if key in idx[cls].get(cat_id, {}):
            # If duplicate, append suffix
            suffix = 2
            while f"{key}_{suffix}" in idx[cls].get(cat_id, {}):
                suffix += 1
            key = f"{key}_{suffix}"
        idx[cls].setdefault(cat_id, {})[key] = item

    for p in policies:
        cls_raw = (p.get("class") or "").strip()
        cat = p.get("categoryRef") or "__UNCATEGORIZED__"

        if cat != "__UNCATEGORIZED__" and cat not in categories:
            print(f"[WARN] Policy '{p.get('displayName') or 'unknown'}' references unknown category '{cat}', moving to uncategorized", file=sys.stderr)
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

    # No sorting needed for dict, but we can sort keys if desired
    # For consistency, sort policies within each category by displayName
    for cls in ("Machine", "User"):
        for cat_id in idx[cls]:
            # Convert dict to sorted list by displayName, then reassign as dict
            policies_dict = idx[cls][cat_id]
            sorted_items = sorted(policies_dict.items(), key=lambda kv: (kv[1].get("displayName") or ""))
            idx[cls][cat_id] = dict(sorted_items)

    return idx


def build_category_tree_for_class_expanded(
    categories: dict[str, dict],
    policy_index_for_class: dict[str, dict[str, dict]],
) -> list[dict]:
    def make_node(cat_id: str) -> dict:
        cat = categories[cat_id]
        node = {
            "category": cat.get("displayName") or cat_id,
            "policies": policy_index_for_class.get(cat_id, {}),
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

    try:
        result = AdmxParser.build_result_for_dir(policy_definitions_path, requested_locale)
    except RuntimeError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1

    # JSON -> stdout (provided by AdmxParser)
    print(AdmxParser.dumps(result, ensure_ascii=False, indent=2))

    print(f"\nParsing completed:", file=sys.stderr)
    print(f"  - Total policies: {result['meta']['Total policies']}", file=sys.stderr)
    print(f"  - Total categories: {result['meta']['Total categories']}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    sys.exit(main())
