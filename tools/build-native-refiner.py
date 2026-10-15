"""Build optional native runtime from a pinned sherpa-onnx wheel installation. No network."""
import argparse,json,hashlib,shutil,subprocess
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--sherpa-dir',required=True);p.add_argument('--models-root',required=True);p.add_argument('--out',required=True);a=p.parse_args()
root=Path(__file__).resolve().parent.parent;source=Path(a.sherpa_dir);out=Path(a.out)
manifest=json.loads((root/'evidence/native-refiner-manifest.json').read_text())
for e in manifest['files']:
 f=source/e['path'];assert hashlib.sha256(f.read_bytes()).hexdigest()==e['sha256'],f'Runtime integrity: {f}'
models=Path(a.models_root);entries=json.loads((root/'evidence/model-manifest.json').read_text());wanted=[e for e in entries if e['model']=='whisper_small'];assert len(wanted)>=3
for e in wanted:
 f=models/'whisper_small'/e['file'];assert hashlib.sha256(f.read_bytes()).hexdigest()==e['sha256'],f'Model integrity: {f}'
(out/'lib').mkdir(parents=True,exist_ok=True);(out/'models').mkdir(exist_ok=True)
for e in manifest['files']:
 if e['path'].startswith('lib/'):shutil.copy2(source/e['path'],out/e['path'])
for e in wanted:shutil.copy2(models/'whisper_small'/e['file'],out/'models'/e['file'])
subprocess.run(['clang','-O2','-I'+str(source/'include'),str(root/'apps/mac/Native/refiner.c'),'-L'+str(out/'lib'),'-lsherpa-onnx-c-api','-Wl,-rpath,@loader_path/lib','-o',str(out/'native-refiner')],check=True)
for lib in (out/'lib').glob('*.dylib'):subprocess.run(['codesign','--force','--sign','-',str(lib)],check=True)
subprocess.run(['codesign','--force','--sign','-',str(out/'native-refiner')],check=True)
shutil.copy2(root/'evidence/native-refiner-manifest.json',out/'runtime-manifest.json')
shutil.copy2(root/'vendor/LICENSE-sherpa-onnx',out/'LICENSE-sherpa-onnx');shutil.copy2(root/'sdk/licenses/onnxruntime.txt',out/'LICENSE-onnxruntime');shutil.copy2(root/'sdk/licenses/whisper.txt',out/'LICENSE-whisper')
print(out)
