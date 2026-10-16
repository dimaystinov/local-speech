import importlib.util,unittest
from pathlib import Path
s=importlib.util.spec_from_file_location('g',Path(__file__).resolve().parents[1]/'tools/benchmark-gigaam-mps.py');g=importlib.util.module_from_spec(s);s.loader.exec_module(g)
class CTC(unittest.TestCase):
 def test_blank_separates_repeat(self):self.assertEqual(g.collapse_ctc([1,1,0,1,1],0),[1,1])
 def test_edges_and_empty(self):
  self.assertEqual(g.collapse_ctc([0,0,1,2,2,0],0),[1,2]);self.assertEqual(g.collapse_ctc([],0),[])
 def test_all_blank(self):self.assertEqual(g.collapse_ctc([0,0,0],0),[])
if __name__=='__main__':unittest.main()
