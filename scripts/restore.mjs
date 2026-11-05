import { DatabaseSync,backup } from 'node:sqlite';
import { resolve,dirname } from 'node:path';
import { access,mkdir } from 'node:fs/promises';
// Run only after stopping every service process. Requires an explicit acknowledgement.
if(!process.argv.includes('--service-stopped'))throw Error('请先停止所有服务，再加 --service-stopped 恢复；运行中的服务不能恢复。');
const args=process.argv.slice(2).filter(a=>!a.startsWith('--'));
if(!args[0])throw Error('用法：node scripts/restore.mjs <备份.sqlite> [目标.db] --service-stopped');
const source=resolve(args[0]),target=resolve(args[1]||process.env.FLASH_DB||'data/production.db');
if(source===target)throw Error('源备份与恢复目标不能相同');
const input=new DatabaseSync(source,{readOnly:true});
try{
  if(input.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('备份完整性检查失败');
  if(input.prepare('PRAGMA user_version').get().user_version!==1)throw Error('不支持此数据库版本');
  if(input.prepare('PRAGMA foreign_key_check').all().length)throw Error('备份外键检查失败');
  if(!input.prepare("SELECT id FROM admins WHERE role='superadmin' AND enabled=1 LIMIT 1").get())throw Error('备份中没有有效的超级管理员');
  await mkdir(dirname(target),{recursive:true});
  let exists=false;try{await access(target);exists=true;}catch{}
  if(exists){const old=new DatabaseSync(target);try{await backup(old,target+`.before-restore-${Date.now()}.sqlite`);}finally{old.close();}}
  // SQLite backup restores pages transactionally and handles WAL correctly.
  await backup(input,target);
}finally{input.close();}
const restored=new DatabaseSync(target);
try{restored.exec('DELETE FROM auth_sessions; DELETE FROM rate_limits;');}finally{restored.close();}
console.log('已恢复：'+target+'；旧登录会话已失效。请重新启动预约服务。');
