import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openStore, seedDemo } from './lib/store.mjs';
import { createApp } from './lib/app.mjs';

const demo=process.argv.includes('--demo')||process.env.FLASH_DEMO==='1';
const host=process.env.HOST||'127.0.0.1', port=Number(process.env.PORT||3210);
if(demo&&!['127.0.0.1','localhost','::1'].includes(host)) throw new Error('演示模式只允许监听本机；公网部署请关闭 FLASH_DEMO');
const password=process.env.FLASH_ADMIN_PASSWORD || (demo?randomBytes(24).toString('base64url'):'');
if(password.length<12) throw new Error('请设置至少 12 位 FLASH_ADMIN_PASSWORD，或使用 npm run demo 本地体验');
const database=resolve(process.env.FLASH_DB||`data/${demo?'demo':'production'}.db`);
const store=openStore(database,{password,username:process.env.FLASH_ADMIN_USERNAME});
if(demo) seedDemo(store);
const {server}=createApp(store,{demo,origin:process.env.PUBLIC_ORIGIN,trustProxy:process.env.TRUST_PROXY==='1',dataDir:resolve('data')});
server.listen(port,host,()=>console.log(`山屿快闪 ${demo?'本地演示':'预约服务'}\nLocal: http://${host}:${port}\n数据库: ${database}\n${demo?'演示数据已明确标注，可点击页面内的本地演示登录。':'请使用已配置的管理账号登录。'}`));
function shutdown(){server.close(()=>{store.close();process.exit(0);});setTimeout(()=>process.exit(1),5000).unref();}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
