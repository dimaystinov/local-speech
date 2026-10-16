import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('cascade', Path(__file__).parents[1]/'tools/asr-cascade.py')
cascade = importlib.util.module_from_spec(spec); spec.loader.exec_module(cascade)


def row(identity, duration, text, errors, split='development', logprob=-.4):
    return dict(id=identity, reference='эталон', split=split, hypothesis=text,
                diagnostics=dict(avgLogprob=logprob), errors=errors, words=10,
                language='ru', audioSeconds=duration, chunkSeconds=[.1])


class CascadeTests(unittest.TestCase):
    def test_holdout_must_never_choose_threshold(self):
        a=row('a',1,'слово',2,split='holdout')
        with self.assertRaisesRegex(ValueError,'development'):
            cascade.choose_policy([(a,a)],.5)

    def test_budget_measures_duration_not_clip_count(self):
        a=row('long',100,'Docker работает',5)
        b=row('short',1,'работает',0)
        result=cascade.summary([(a,dict(a,errors=0)),(b,b)],
                               dict(kind='mixed-or-confidence',threshold=-1))
        self.assertAlmostEqual(result['refinedAudioFraction'],100/101)

    def test_no_improvement_keeps_small_only(self):
        a=row('a',1,'текст',0)
        policy,_,_=cascade.choose_policy([(a,dict(a,errors=3))],1)
        self.assertEqual(policy['kind'],'small-only')

    def test_missing_confidence_is_not_confident(self):
        self.assertTrue(cascade.route('текст',{},dict(kind='confidence',threshold=-.5)))
        self.assertTrue(cascade.route('текст',dict(avgLogprob=float('nan')),
                                      dict(kind='confidence',threshold=-.5)))

    def test_low_confidence_is_routing_not_language_relabeling(self):
        policy=dict(kind='confidence',threshold=-.5)
        self.assertTrue(cascade.route('обычное русское слово',dict(avgLogprob=-.9),policy))
        self.assertFalse(cascade.route('обычное русское слово',dict(avgLogprob=-.1),policy))

    def test_paired_reports_require_same_audio(self):
        a=dict(complete=True,corpusSHA256='one',rows=[])
        with self.assertRaisesRegex(ValueError,'Corpus'):
            cascade.paired(a,dict(a,corpusSHA256='two'))

    def test_partial_baseline_cannot_choose_policy(self):
        with self.assertRaisesRegex(ValueError,'Incomplete'):
            cascade.paired(dict(complete=False),dict(complete=True))

    def test_confidence_aggregation_weights_tokens(self):
        result=cascade.bench.confidence_features(dict(segments=[
            dict(avg_logprob=-1,tokens=[1]), dict(avg_logprob=-.2,tokens=[1,2,3])]))
        self.assertAlmostEqual(result['avgLogprob'],-.4)
