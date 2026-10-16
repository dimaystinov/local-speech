import importlib.util, pathlib, unittest
spec=importlib.util.spec_from_file_location('confidence',pathlib.Path(__file__).parents[1]/'tools/word-confidence.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class ConfidenceTests(unittest.TestCase):
 def words(self,text,p):return [dict(word=w,probability=p,start=i,end=i+1) for i,w in enumerate(text.split())]
 def test_low_confidence_term_can_change(self):
  a='Проверь докер сегодня';b='Проверь Docker сегодня'
  r=m.select(a,self.words(a,.4),self.words(b,.95),['Docker']);self.assertEqual(r['text'],b)
 def test_high_confidence_never_changes(self):
  a='Проверь докер сегодня';r=m.select(a,self.words(a,.95),self.words('Проверь Docker сегодня',.99),['Docker']);self.assertEqual(r['text'],a)
 def test_missing_baseline_evidence_never_changes(self):
  a='Проверь доктор сегодня';r=m.select(a,self.words('Проверь докер сегодня',.1),self.words('Проверь Docker сегодня',.99),['Docker']);self.assertEqual(r['text'],a)
 def test_protected_and_unlisted(self):
  for a,b,terms in [('не удаляй 10','да удаляй 20',['да','20']),('Проверь дом сегодня','Проверь home сегодня',[])]:
   self.assertEqual(m.select(a,self.words(a,.1),self.words(b,.99),terms)['text'],a)
 def test_bad_probabilities_are_unavailable(self):
  for p in [None,float('nan'),float('inf'),-1,2,True]:self.assertIsNone(m.probability(p))
 def test_insertions_rejected_and_punctuation_preserved(self):
  a='Проверь докер, сегодня!'
  self.assertEqual(m.select(a,self.words(a,.1),self.words('Проверь новый Docker сегодня',.99),['Docker'])['text'],a)
  self.assertEqual(m.select(a,self.words(a,.1),self.words('Проверь Docker сегодня',.99),['Docker'])['text'],'Проверь Docker, сегодня!')
 def test_budget_skips_second_decode(self):
  from types import SimpleNamespace as N
  from unittest.mock import patch
  class Model:
   calls=0
   def transcribe(self,*args,**kwargs):
    self.calls+=1
    return [N(words=[N(word=' докер',probability=.1,start=0,end=1)])],N(language='ru')
  model=Model()
  with patch.object(m.time,'monotonic',side_effect=[0,3,3]):r=m.recognize(model,[],None,['Docker'],budget=2.5)
  self.assertFalse(r['rechecked']);self.assertEqual(model.calls,1)
 def test_low_confidence_allows_one_bounded_recheck(self):
  from types import SimpleNamespace as N
  from unittest.mock import patch
  class Model:
   calls=0
   def transcribe(self,*args,**kwargs):
    self.calls+=1
    return [N(words=[N(word=' докер' if self.calls==1 else ' Docker',probability=.1 if self.calls==1 else .99,start=0,end=1)])],N(language='ru')
  model=Model()
  with patch.object(m.time,'monotonic',side_effect=[0,.2,.4]):r=m.recognize(model,[],None,['Docker'])
  self.assertTrue(r['rechecked']);self.assertEqual(model.calls,2);self.assertEqual(r['text'],'Docker')
