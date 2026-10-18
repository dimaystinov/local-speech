import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, process.argv[2] || '../../dist/local-speech');
const manifest = JSON.parse(await fs.readFile(path.join(source,'package-manifest.json')));
if (manifest.package !== 'local-speech-sdk') throw Error('Not an SDK distribution');
const destination = path.join(here,'public/speech',manifest.version);
// Versioned directory; never remove host files or overwrite an active version.
try { await fs.access(destination); throw Error('Version already copied. Use a new version or remove this example copy explicitly.'); }
catch(e) { if(e.code !== 'ENOENT') throw e; }
await fs.mkdir(path.dirname(destination),{recursive:true});
await fs.cp(source,destination,{recursive:true});
await fs.writeFile(path.join(here,'public/speech-version.json'),JSON.stringify({version:manifest.version}));
console.log('SDK copied:',manifest.version,'weights bundled:',manifest.weightsIncluded);
