import { execFileSync } from 'node:child_process';
import { readFile,lstat } from 'node:fs/promises';
const files=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
if(!files.length)throw Error('No tracked source files; stage the intended source before checking publication.');
const failures=[];
for(const file of files){
  if(/(^|\/)(?:data|artifacts|node_modules)\//.test(file)||/(^|\/)\.env(?:\.|$)/.test(file)&&file!=='.env.example'||/\.(?:db|sqlite|sqlite3)(?:-|$)|\.(?:pem|key)$|project\.private\.config\.json$/.test(file)){
    failures.push(file+': runtime/private file must not be published');continue;
  }
  const stat=await lstat(file);if(stat.isSymbolicLink()){failures.push(file+': symbolic links are not part of this source delivery');continue;}
  if(stat.size>2*1024*1024){failures.push(file+': unexpectedly large source file');continue;}
  const body=await readFile(file,'utf8');
  if(/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/.test(body)||/[-]{5}BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY[-]{5}/.test(body))failures.push(file+': credential-like content detected');
}
if(failures.length)throw Error(failures.join('\n'));
console.log(`Publication check passed: ${files.length} source files; runtime databases, environment files, credentials and archives excluded.`);
