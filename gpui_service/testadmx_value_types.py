import unittest
import xml.etree.ElementTree as ET

try:
    from .datastore import GPODataStore
    from .parse_admx_structure import AdmxParser
except ImportError:
    from datastore import GPODataStore
    from parse_admx_structure import AdmxParser


class FakeGPTWorker:
    def __init__(self):
        self.updated = []

    def update_policy_value(self, gpo_path, key_path, value_name, value_data,
                            value_type='REG_DWORD', policy_type='Machine'):
        self.updated.append({
            'gpo_path': gpo_path,
            'key_path': key_path,
            'value_name': value_name,
            'value_data': value_data,
            'value_type': value_type,
            'policy_type': policy_type,
        })
        return True


class AdmxValueTypeTests(unittest.TestCase):
    def test_enum_metadata_preserves_decimal_and_string_value_kinds(self):
        parser = AdmxParser("")
        enum_el = ET.fromstring("""
            <enum id="cursor-size" valueName="cursor-size" required="true">
              <item displayName="decimal-item">
                <value><decimal value="24" /></value>
              </item>
              <item displayName="string-item">
                <value><string>32</string></value>
              </item>
            </enum>
        """)

        metadata = parser._parse_enum_metadata(enum_el, None)

        self.assertEqual(metadata['items']['24'], 'decimal-item')
        self.assertEqual(metadata['items']['32'], 'string-item')
        self.assertEqual(metadata['itemValueKinds']['24'], 'decimal')
        self.assertEqual(metadata['itemValueKinds']['32'], 'string')

    def _make_store(self, metadata):
        store = GPODataStore(sysvol_path='/tmp')
        store.gpt_worker = FakeGPTWorker()
        store._update_gpo_version = lambda *args, **kwargs: 1
        store.data = {
            'Machine': {
                'categories': [{
                    'category': 'Test',
                    'policies': {
                        'TestPolicy': {
                            'header': {
                                'key': 'Software\\Example',
                                'valueName': None,
                            },
                            'Software\\Example\\Setting': {
                                'metadata': metadata,
                                'data': "Read_Path_GPT('Software\\Example\\Setting')",
                            },
                        },
                    },
                }],
            },
        }
        return store

    def test_decimal_enum_save_uses_reg_dword(self):
        store = self._make_store({
            'type': 'enum',
            'valueName': 'Setting',
            'items': {'24': '24px'},
            'itemValueKinds': {'24': 'decimal'},
        })

        result = store._set_unlocked(
            'Software\\Example\\Setting',
            '24',
            'domain/Policies/{GUID}',
            'Machine',
            'Software\\Example\\Setting',
        )

        self.assertEqual(result, 1)
        self.assertEqual(store.gpt_worker.updated[-1]['value_type'], 'REG_DWORD')
        self.assertEqual(store.gpt_worker.updated[-1]['value_data'], 24)

    def test_string_enum_save_uses_reg_sz(self):
        store = self._make_store({
            'type': 'enum',
            'valueName': 'Setting',
            'items': {'24': '24px'},
            'itemValueKinds': {'24': 'string'},
        })

        store._set_unlocked(
            'Software\\Example\\Setting',
            '24',
            'domain/Policies/{GUID}',
            'Machine',
            'Software\\Example\\Setting',
        )

        self.assertEqual(store.gpt_worker.updated[-1]['value_type'], 'REG_SZ')

    def test_long_decimal_enum_save_uses_reg_qword(self):
        store = self._make_store({
            'type': 'enum',
            'valueName': 'Setting',
            'items': {'4294967296': 'large'},
            'itemValueKinds': {'4294967296': 'longDecimal'},
        })

        store._set_unlocked(
            'Software\\Example\\Setting',
            '4294967296',
            'domain/Policies/{GUID}',
            'Machine',
            'Software\\Example\\Setting',
        )

        self.assertEqual(store.gpt_worker.updated[-1]['value_type'], 'REG_QWORD')

    def test_metadata_less_save_keeps_existing_reg_sz_fallback(self):
        store = self._make_store({})

        store._set_unlocked(
            'Software\\Example\\Setting',
            '24',
            'domain/Policies/{GUID}',
            'Machine',
            '',
        )

        self.assertEqual(store.gpt_worker.updated[-1]['value_type'], 'REG_SZ')


if __name__ == '__main__':
    unittest.main()
