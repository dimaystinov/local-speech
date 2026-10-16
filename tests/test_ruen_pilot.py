import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('pilot', Path(__file__).parents[1] / 'tools/ruen-pilot.py')
pilot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pilot)
score_spec = importlib.util.spec_from_file_location('score', Path(__file__).parents[1] / 'tools/score-ruen-pilot.py')
score = importlib.util.module_from_spec(score_spec)
score_spec.loader.exec_module(score)


class PilotIsolationTests(unittest.TestCase):
    def test_empty_holdout_is_rejected(self):
        with self.assertRaises(ValueError):
            pilot.validate_split([{'reference': 'Docker'}], [])

    def test_noise_variant_cannot_cross_partition(self):
        with self.assertRaisesRegex(ValueError, 'baseId'):
            pilot.validate_split([{'baseId': 'a', 'reference': 'one'}],
                                 [{'baseId': 'a', 'reference': 'two'}])

    def test_renamed_same_audio_cannot_cross_partition(self):
        with self.assertRaisesRegex(ValueError, 'sha256'):
            pilot.validate_split([{'sha256': 'same', 'reference': 'one'}],
                                 [{'sha256': 'same', 'reference': 'two'}])

    def test_reworded_punctuation_cannot_hide_reference_leak(self):
        with self.assertRaisesRegex(ValueError, 'reference'):
            pilot.validate_split([{'reference': 'Проверь Docker!'}],
                                 [{'reference': 'проверь docker'}])

    def test_disjoint_references_can_share_terms(self):
        pilot.validate_split([{'reference': 'Установи Docker'}],
                             [{'reference': 'Перезапусти Docker'}])

    def test_wer_preserves_negation_and_latin_spelling(self):
        self.assertEqual(pilot.errors('не удаляй Docker', 'удаляй докер'), (2, 3))
        self.assertEqual(pilot.errors('Всё: GitHub!', 'все github'), (0, 2))

    def test_wer_can_exceed_100_percent_on_hallucinated_insertions(self):
        self.assertEqual(pilot.errors('Docker', 'проверка проверка проверка'), (3, 1))

    def test_partial_benchmark_cannot_be_scored_as_complete(self):
        with self.assertRaisesRegex(ValueError, 'Incomplete'):
            score.summarize({'complete': False, 'rows': []})

    def test_summary_uses_micro_wer_not_average_sentence_wer(self):
        rows = [dict(language='mixed', variant='clean', errors=2, words=2,
                     terms=1, matchedTerms=0, chunkSeconds=[1], audioSeconds=5),
                dict(language='mixed', variant='clean', errors=0, words=8,
                     terms=1, matchedTerms=1, chunkSeconds=[2], audioSeconds=5)]
        result = score.summarize(dict(complete=True, rows=rows, modelBytes=1000000, loadSeconds=1))
        self.assertEqual(result['groups']['mixed']['werPercent'], 20)
        self.assertEqual(result['groups']['mixed']['termRecallPercent'], 50)
        self.assertEqual(result['rtf'], 0.3)


if __name__ == '__main__':
    unittest.main()
