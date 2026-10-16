"""Protect paired benchmarks from silently changed or misread audio."""
import hashlib
import importlib.util
import tempfile
import unittest
import wave
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    'gpu_bench', Path(__file__).parents[1] / 'tools/benchmark-ruen-gpu.py')
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)


class AudioContractTests(unittest.TestCase):
    def make_audio(self, directory, channels=1):
        path = Path(directory) / 'audio.wav'
        with wave.open(str(path), 'wb') as wav:
            wav.setnchannels(channels)
            wav.setsampwidth(2)
            wav.setframerate(16000)
            wav.writeframes(b'\x00\x80\x00\x00\xff\x7f' * channels)
        return dict(file=str(path), sha256=hashlib.sha256(path.read_bytes()).hexdigest())

    def test_pcm_amplitude_and_sample_count_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            audio = bench.audio_file(self.make_audio(directory))
            self.assertEqual(len(audio), 3)
            self.assertEqual(audio.tolist(), [-1., 0., 32767 / 32768])

    def test_modified_audio_rejected_before_inference(self):
        with tempfile.TemporaryDirectory() as directory:
            row = self.make_audio(directory)
            with open(row['file'], 'ab') as output:
                output.write(b'changed')
            with self.assertRaisesRegex(ValueError, 'integrity'):
                bench.audio_file(row)

    def test_stereo_cannot_silently_double_audio_duration(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, 'mono'):
                bench.audio_file(self.make_audio(directory, channels=2))
