import { readdir,readFile } from 'node:fs/promises';
import { join,extname } from 'node:path';
import { spawnSync } from 'node:child_process';
async function files(dir){return (await Promise.all((await readdir(dir,{withFileTypes:true})).filter(x=>!['.git','data','artifacts','node_modules'].includes(x.name)).map(x=>x.isDirectory()?files(join(dir,x.name)):join(dir,x.name)))).flat();}
let count=0;
for(const file of await files('.')){if(['.js','.mjs'].includes(extname(file))){const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});if(result.status!==0)throw Error(file+'\n'+result.stderr);count++;}if(extname(file)==='.json')JSON.parse(await readFile(file,'utf8'));}
console.log(`语法检查通过：${count} 个 JS 模块；JSON 文件均可解析。`);
