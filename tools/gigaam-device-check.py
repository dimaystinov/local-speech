"""Initialize positional buffers on CPU and check MPS against CPU before READY.

A startup numeric probe is a guard, not proof that every future kernel is correct.
If it fails, retain the CPU backend instead of publishing unchecked GPU output.
"""
def assess(reference,actual):
 import torch
 if reference.shape!=actual.shape:return dict(passed=False,maxAbsoluteLogitDifference=None,argmaxEqual=False)
 finite=bool(torch.isfinite(reference).all() and torch.isfinite(actual).all())
 delta=float((actual-reference).abs().max()) if finite else None
 labels_equal=bool(torch.equal(reference.argmax(-1),actual.argmax(-1)))
 passed=finite and bool(torch.allclose(reference,actual,atol=.002,rtol=.002)) and labels_equal
 return dict(passed=passed,maxAbsoluteLogitDifference=delta,argmaxEqual=labels_equal)

def prepare(core):
 import torch
 torch.set_num_threads(4)
 for layer in core.encoder.layers:layer.self_attn.torch_sdpa_attn=False
 generator=torch.Generator(device='cpu').manual_seed(1729)
 t=torch.arange(25600,dtype=torch.float32)/16000
 audio=(.06*torch.sin(2*torch.pi*(180*t+160*t*t))+.025*torch.randn(25600,generator=generator)).unsqueeze(0)
 with torch.inference_mode():
  features,length=core.preprocessor(audio,torch.tensor([audio.size(1)]))
  # This materializes nonpersistent rotary buffers on CPU before device transfer.
  encoded,lens=core.encoder(features,length);reference=core.head(encoder_output=encoded).detach().cpu()
  if not torch.isfinite(reference).all():raise RuntimeError('Non-finite GigaAM CPU probe')
  if not torch.backends.mps.is_available():return 'cpu',dict(passed=False,reason='MPS unavailable')
  core.encoder.to('mps');core.head.to('mps')
  encoded,gpu_lens=core.encoder(features.to('mps'),length.to('mps'));actual=core.head(encoder_output=encoded).cpu();torch.mps.synchronize()
  status=assess(reference,actual)
  passed=status['passed'] and bool(torch.equal(lens,gpu_lens.cpu()))
  status.update(passed=passed,probeSamples=audio.size(1),positionalBuffers='CPU initialized')
  if not passed:
   core.encoder.to('cpu');core.head.to('cpu');torch.mps.empty_cache();status['reason']='CPU/MPS startup mismatch; CPU fallback'
  return ('mps' if passed else 'cpu'),status
