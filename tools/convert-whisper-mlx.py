"""Convert local HF Whisper safetensors to MLX FP16; no remote code execution.

Name mapping follows Apple's mlx-examples/whisper/convert.py (MIT).
"""
import argparse
import json
from pathlib import Path
import mlx.core as mx
from mlx_whisper.whisper import ModelDimensions, Whisper

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('source', type=Path)
p.add_argument('output', type=Path)
a = p.parse_args()
if a.output.exists():
    raise ValueError('Output exists')
c = json.loads((a.source / 'config.json').read_text())
d = dict(n_mels=c['num_mel_bins'], n_audio_ctx=c['max_source_positions'],
         n_audio_state=c['d_model'], n_audio_head=c['encoder_attention_heads'],
         n_audio_layer=c['encoder_layers'], n_vocab=c['vocab_size'],
         n_text_ctx=c['max_target_positions'], n_text_state=c['d_model'],
         n_text_head=c['decoder_attention_heads'], n_text_layer=c['decoder_layers'])
weights = mx.load(str(a.source / 'model.safetensors'))
converted = {}
for key, value in weights.items():
    if key in ('proj_out.weight', 'model.encoder.embed_positions.weight'):
        continue
    key = key.removeprefix('model.')
    for old, new in [('.layers', '.blocks'), ('.self_attn', '.attn'),
                     ('.attn_layer_norm', '.attn_ln'), ('.encoder_attn.', '.cross_attn.'),
                     ('.encoder_attn_layer_norm', '.cross_attn_ln'),
                     ('.final_layer_norm', '.mlp_ln'), ('.q_proj', '.query'),
                     ('.k_proj', '.key'), ('.v_proj', '.value'), ('.out_proj', '.out'),
                     ('.fc1', '.mlp1'), ('.fc2', '.mlp2'),
                     ('embed_positions.weight', 'positional_embedding'),
                     ('decoder.embed_tokens', 'decoder.token_embedding'),
                     ('encoder.layer_norm', 'encoder.ln_post'), ('decoder.layer_norm', 'decoder.ln')]:
        key = key.replace(old, new)
    if 'conv' in key and value.ndim == 3:
        value = value.swapaxes(1, 2)
    converted[key] = value.astype(mx.float16)
model = Whisper(ModelDimensions(**d), mx.float16)
# MLX owns a default alignment-head buffer absent from HF checkpoints. No word
# timestamps are requested in this benchmark; retain the runtime's default.
converted['alignment_heads'] = model.alignment_heads
model.load_weights(list(converted.items()), strict=True)
mx.eval(model.parameters())
a.output.mkdir(parents=True)
mx.save_safetensors(str(a.output / 'weights.safetensors'), converted)
(a.output / 'config.json').write_text(json.dumps(d, indent=2) + '\n')
print('Converted with strict key/shape validation:', a.output)
