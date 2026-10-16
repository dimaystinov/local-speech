import importlib.util,unittest
from pathlib import Path
s=importlib.util.spec_from_file_location('gq',Path(__file__).resolve().parents[1]/'tools/gigaam-qwen-cascade.py');g=importlib.util.module_from_spec(s);s.loader.exec_module(g)
class Cascade(unittest.TestCase):
 def draft(self,text,score=.1):return dict(hypothesis=text,wordEvidence=[dict(word=m.group(),score=score) for m in g.words(text)])
 def test_preserves_confident_words(self):
  d=self.draft('проверяем докер сегодня');d['wordEvidence'][0]['score']=.99;d['wordEvidence'][2]['score']=.99
  self.assertEqual(g.patch(d,'проверяем Docker сегодня',dict(mode='terms',threshold=.5)),'проверяем Docker сегодня')
  self.assertEqual(g.patch(d,'проверяли Docker вчера',dict(mode='terms',threshold=.5)),d['hypothesis'])
 def test_terms_guard(self):
  d=self.draft('новый сервер');self.assertEqual(g.patch(d,'новые серверы',dict(mode='terms',threshold=.5)),d['hypothesis'])
 def test_no_insert_delete(self):
  d=self.draft('это сервер');p=dict(mode='uncertain',threshold=.5)
  self.assertEqual(g.patch(d,'это новый сервер',p),d['hypothesis']);self.assertEqual(g.patch(d,'сервер',p),d['hypothesis'])
 def test_alignment_validation(self):
  d=self.draft('два слова');d['wordEvidence'].pop()
  with self.assertRaises(ValueError):g.patch(d,'two words',dict(mode='terms',threshold=.5))
 def test_min_char_score_and_punctuation(self):
  self.assertEqual(g.evidence(list('abc de'),[.9,.2,.9,.1,.8,.7]),[dict(word='abc',score=.2),dict(word='de',score=.7)])
 def test_off_never_routes(self):self.assertFalse(g.route(self.draft('Docker'),dict(mode='off',threshold=1)))
if __name__=='__main__':unittest.main()
