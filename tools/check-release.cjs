'use strict';
const fs=require('node:fs');
const {version}=require('../package.json');
if(!/^\d+\.\d+\.\d+$/.test(version))throw Error('Use a stable numeric SemVer version');
const tag=process.env.GITHUB_REF_TYPE==='tag'?process.env.GITHUB_REF_NAME:null;
if(tag&&tag!==`v${version}`)throw Error(`Tag ${tag} does not match package version ${version}`);
if(!fs.readFileSync('CHANGELOG.md','utf8').includes(`## ${version} `))throw Error('Missing changelog entry');
const manifest=JSON.parse(fs.readFileSync('dist/local-speech/package-manifest.json'));
if(manifest.version!==version)throw Error('Rebuild SDK for this version');
const crypto=require('node:crypto'),path=require('node:path');
for(const file of manifest.files){
 const data=fs.readFileSync(path.join('dist/local-speech',file.path));
 if(data.length!==file.bytes||crypto.createHash('sha256').update(data).digest('hex')!==file.sha256)throw Error(`Invalid asset: ${file.path}`);
}
console.log(`Verified SDK ${version}: ${manifest.files.length} assets`);
