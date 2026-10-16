import importlib.util,json,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
s=importlib.util.spec_from_file_location('cascade',ROOT/'tools/gigaam-qwen-cascade.py');c=importlib.util.module_from_spec(s);s.loader.exec_module(c)
POLICY=dict(mode='uncertain',threshold=.3,glossary=json.loads((ROOT/'experiments/term-review/glossary.json').read_text()))
def draft(text):return dict(hypothesis=text,wordEvidence=[dict(word=m.group(),score=.99) for m in c.words(text)])
class Terms(unittest.TestCase):
 def test_confident_cyrillic_routes(self):self.assertTrue(c.route(draft('проверь докер'),POLICY))
 def test_independent_acoustic_confirmation(self):
  d=draft('проверь докер завтра');self.assertEqual(c.patch(d,'проверь Docker завтра',POLICY),'проверь Docker завтра')
  self.assertEqual(c.patch(d,'проверь GitHub завтра',POLICY),d['hypothesis'])
 def test_homophones_are_not_dictionary_replaced(self):
  for text in ['купи редис','питон спит','докер работает в порту']:
   self.assertEqual(c.patch(draft(text),text,POLICY),text)
 def test_neighbor_rewrites_rejected(self):
  text='не удаляй докер';self.assertEqual(c.patch(draft(text),'удаляй Docker',POLICY),'не удаляй Docker')
  self.assertEqual(c.patch(draft('проверь докер'),'удали Docker',POLICY),'проверь докер')
 def test_multiword_alias(self):self.assertEqual(c.patch(draft('это гит хаб'),'это GitHub',POLICY),'это GitHub')
 def test_substring_does_not_trigger(self):self.assertFalse(c.route(draft('питоновый редиска'),POLICY))
 def test_ambiguous_alias(self):
  with self.assertRaises(ValueError):c.term_review.compile_glossary([dict(term='A',aliases=['тест']),dict(term='B',aliases=['тест'])])
 def test_bounded_glossary(self):
  with self.assertRaises(ValueError):c.term_review.compile_glossary([dict(term='Docker',aliases=['докер'])]*65)
if __name__=='__main__':unittest.main()
