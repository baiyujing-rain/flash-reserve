import { DatabaseSync,backup } from 'node:sqlite';
import { resolve,dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
const database=resolve(process.env.FLASH_DB||'data/production.db');
const target=resolve(process.argv[2]||`data/backups/backup-${Date.now()}.sqlite`);
if(target===database)throw Error('备份文件不能覆盖原数据库');
await mkdir(dirname(target),{recursive:true});
const db=new DatabaseSync(database,{readOnly:true});
try{await backup(db,target);console.log('备份已生成：'+target);}finally{db.close();}
