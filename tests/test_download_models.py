import hashlib
import importlib.util
import io
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('download_models', Path(__file__).resolve().parents[1] / 'tools/download-models.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.entry = dict(model='small', file='model.onnx', bytes=4,
                          sha256=hashlib.sha256(b'data').hexdigest(), url='https://huggingface.co/example/model')

    def test_install_and_cached_repeat_without_network(self):
        self.assertEqual(module.install(self.entry, self.root, lambda *a, **k: io.BytesIO(b'data')), 'installed')
        def no_network(*args, **kwargs):
            self.fail('verified repeat must not download')
        self.assertEqual(module.install(self.entry, self.root, no_network), 'cached')

    def test_reject_corruption_and_oversized_download_cleanup(self):
        for data in (b'evil', b'too-large', b'x'):
            with self.assertRaises(ValueError):
                module.install(self.entry, self.root, lambda *a, **k: io.BytesIO(data))
            self.assertFalse((self.root / 'models/small/model.onnx').exists())
            self.assertEqual(list(self.root.rglob('*.part')), [])

    def test_bundled_copy_is_verified(self):
        (self.root / 'vocab').write_bytes(b'data')
        entry = {**self.entry, 'bundled': 'vocab'}
        self.assertEqual(module.install(entry, self.root), 'installed')

    def test_path_traversal_rejected(self):
        for value in ('../outside', '..', 'bad\\file', '/absolute'):
            with self.assertRaises(ValueError):
                module.install({**self.entry, 'file': value}, self.root)

    def test_failed_replacement_preserves_existing_file(self):
        target = self.root / 'models/small/model.onnx'
        target.parent.mkdir(parents=True)
        target.write_bytes(b'previous')
        with self.assertRaises(ValueError):
            module.install(self.entry, self.root, lambda *a, **k: io.BytesIO(b'evil'))
        self.assertEqual(target.read_bytes(), b'previous')


if __name__ == '__main__':
    unittest.main()
