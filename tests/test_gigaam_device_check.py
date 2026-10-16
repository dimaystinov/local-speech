import importlib.util,unittest
from pathlib import Path
import torch
s=importlib.util.spec_from_file_location('guard',Path(__file__).resolve().parents[1]/'tools/gigaam-device-check.py');g=importlib.util.module_from_spec(s);s.loader.exec_module(g)
class DeviceCheck(unittest.TestCase):
 def test_equal_passes(self):
  a=torch.tensor([[1.,2.]]);self.assertTrue(g.assess(a,a.clone())['passed'])
 def test_nonfinite_fails(self):self.assertFalse(g.assess(torch.tensor([[1.,2.]]),torch.tensor([[1.,float('nan')]]))['passed'])
 def test_label_flip_fails_even_with_tiny_delta(self):self.assertFalse(g.assess(torch.tensor([[1.,1.00001]]),torch.tensor([[1.00001,1.]]))['passed'])
 def test_large_delta_fails(self):self.assertFalse(g.assess(torch.tensor([[1.,2.]]),torch.tensor([[1.,3.]]))['passed'])
 def test_shape_fails(self):self.assertFalse(g.assess(torch.tensor([[1.,2.]]),torch.tensor([[1.]]))['passed'])
if __name__=='__main__':unittest.main()
