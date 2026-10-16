import copy,importlib.util,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('score',Path(__file__).resolve().parents[1]/'tools/score-asr-alternatives.py');s=importlib.util.module_from_spec(spec);spec.loader.exec_module(s)
def fixture():
 return dict(complete=True,corpusSHA256='a',modelBytes=1,mlxPeakMemoryBytes=2,processPeakRSSBytes=3,loadWarmupSeconds=1,prefixProbes=[{'computeSeconds':.1}],rows=[dict(id='x',language='mixed',reference='hello мир',words=2,errors=1,terms=1,matchedTerms=0,audioSeconds=2,chunkSeconds=[.2])])
class ComparisonChecks(unittest.TestCase):
 def test_incomplete_rejected(self):
  with self.assertRaises(ValueError):s.summarize({'a':dict(fixture(),complete=False)})
 def test_unpaired_rejected(self):
  with self.assertRaises(ValueError):s.summarize({'a':fixture(),'b':dict(fixture(),corpusSHA256='b')})
 def test_duplicate_rejected(self):
  a=fixture();a['rows']*=2
  with self.assertRaises(ValueError):s.summarize({'a':a})
 def test_changed_reference_rejected(self):
  b=fixture();b['rows'][0]['reference']='other'
  with self.assertRaises(ValueError):s.summarize({'a':fixture(),'b':b})
 def test_metrics(self):
  r=s.summarize({'a':fixture()})['a'];self.assertEqual(r['werPercent'],50);self.assertAlmostEqual(r['rtf'],.1)
if __name__=='__main__':unittest.main()
