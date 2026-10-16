import copy,importlib.util,unittest
from pathlib import Path
s=importlib.util.spec_from_file_location('repeat',Path(__file__).resolve().parents[1]/'tools/check-cascade-repeat.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Repeat(unittest.TestCase):
 def report(self):return dict(complete=True,corpusSHA256='a',gigaam='g',qwen='q',split='holdout',policy={},pairs=[dict(case=dict(id='1',sha256='audio'),draft=dict(hypothesis='draft'),qwen=dict(hypothesis='review'))],rows=[dict(id='1',hypothesis='final')])
 def test_equal(self):self.assertTrue(m.compare(self.report(),self.report())['passed'])
 def test_changed_draft_rejects_even_if_final_equal(self):
  a=self.report();b=copy.deepcopy(a);b['pairs'][0]['draft']['hypothesis']='bad';self.assertFalse(m.compare(a,b)['passed'])
 def test_policy_mismatch(self):
  b=self.report();b['policy']={'threshold':.5}
  with self.assertRaises(ValueError):m.compare(self.report(),b)
 def test_audio_mismatch(self):
  b=self.report();b['pairs'][0]['case']['sha256']='other'
  with self.assertRaises(ValueError):m.compare(self.report(),b)
