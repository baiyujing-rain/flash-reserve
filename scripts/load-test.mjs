import { mkdir,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { openStore } from '../lib/store.mjs';

// Isolated disposable test DB; never connects to the demo or production database.
const directory=resolve('artifacts');await mkdir(directory,{recursive:true});
const database=resolve(directory,`load-${Date.now()}.db`);
let store=openStore(database,{password:'isolated-load-test-only'});
const now=Date.now(),release=now+2500;
const sessions=[];
store.tx(()=>{
  store.run('INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)','load-event','1000 人抢 100 号验收','独立测试数据库','并发验收','','forest',release,now+3600000,now+7200000,'published',1,0,now);
  store.run('INSERT INTO slots(id,event_id,label,starts_at,ends_at,total) VALUES(?,?,?,?,?,?)','load-slot','load-event','100 个测试号源',now+3600000,now+7200000,100);
  store.run('INSERT INTO events SELECT ?,?,?,?,?,?,release_at,starts_at,ends_at,state,per_limit,demo,created_at FROM events WHERE id=?','observe-event','放号状态观察活动','独立测试数据库','不参与抢号，用于在抢号负载下测量状态接口','','forest','load-event');
  store.run('INSERT INTO slots(id,event_id,label,starts_at,ends_at,total) VALUES(?,?,?,?,?,?)','observe-slot','observe-event','仅观察不领取',now+3600000,now+7200000,1);
  for(let i=0;i<1000;i++){const id='load-user-'+i;store.run('INSERT INTO users VALUES(?,?,?,?,?,?,?)',id,'load-openid-'+i,'并发测试用户','138'+String(i).padStart(8,'0'),0,'',now);sessions.push({id,token:store.session(id,'user'),key:randomUUID()});}
});store.close();
const workers=[],ports=[];
const viewerCount=process.argv.includes('--viewers')?1000:0;
let viewersRunning=true,viewerRequests=0,viewerErrors=0;
const viewerTasks=[];
try{
  for(let i=0;i<2;i++){const child=fork(new URL('./load-worker.mjs',import.meta.url),{env:{...process.env,FLASH_LOAD_DB:database},stdio:['ignore','ignore','inherit','ipc']});workers.push(child);const [msg]=await once(child,'message');ports.push(msg.port);}
  let observed=null,observerRtt=null;
  const observer=fork(new URL('./load-observer.mjs',import.meta.url),{env:{...process.env,FLASH_OBSERVE_URL:`http://127.0.0.1:${ports[0]}/api/public/events/observe-event`},stdio:['ignore','ignore','inherit','ipc']});
  workers.push(observer);observer.on('message',m=>{if(m.observed){observed=m.observed;observerRtt=m.max_rtt_ms;}});
  for(let i=0;i<viewerCount;i++)viewerTasks.push((async()=>{
    await new Promise(r=>setTimeout(r,i%300));
    while(viewersRunning){const started=performance.now();try{const r=await fetch(`http://127.0.0.1:${ports[i%2]}/api/public/events/load-event`,{signal:AbortSignal.timeout(10000)});await r.arrayBuffer();viewerRequests++;if(!r.ok)viewerErrors++;}catch{viewerErrors++;}if(viewersRunning)await new Promise(r=>setTimeout(r,Math.max(0,300-(performance.now()-started))));}
  })());
  while(Date.now()<release+10)await new Promise(r=>setTimeout(r,10));
  const started=performance.now();
  const results=await Promise.all(sessions.map(async(u,i)=>{const start=performance.now();const r=await fetch(`http://127.0.0.1:${ports[i%2]}/api/user/reservations`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+u.token},body:JSON.stringify({slot_id:'load-slot',request_key:u.key}),signal:AbortSignal.timeout(20000)});return {index:i,status:r.status,data:await r.json(),ms:performance.now()-start};}));
  const elapsed=performance.now()-started;
  viewersRunning=false;await Promise.all(viewerTasks);
  // The observer is a separate, unconsumed slot at the same release instant,
  // served by the same process/database under the actual 1000-request load.
  for(let i=0;!observed&&i<5;i++)await new Promise(r=>setTimeout(r,100));
  observer.send('stop');
  const wins=results.filter(r=>r.status===201),out=results.filter(r=>r.data.code==='SOLD_OUT');
  assert.equal(wins.length,100);assert.equal(out.length,900);assert.equal(new Set(wins.map(r=>r.data.code)).size,100);assert.equal(new Set(wins.map(r=>r.data.number)).size,100);
  const u=sessions[wins[0].index];
  const retry=await Promise.all(Array.from({length:20},async(_,i)=>{const r=await fetch(`http://127.0.0.1:${ports[i%2]}/api/user/reservations`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+u.token},body:JSON.stringify({slot_id:'load-slot',request_key:u.key})});assert.equal(r.status,201);return r.json();}));
  assert.ok(retry.every(r=>r.id===wins[0].data.id));
  store=openStore(database,{password:'isolated-load-test-only'});
  assert.equal(store.get('SELECT sold FROM slots WHERE id=?','load-slot').sold,100);assert.equal(store.get('SELECT COUNT(*) n FROM reservations').n,100);
  const times=results.map(r=>r.ms).sort((a,b)=>a-b);
  const report={tested_at:new Date().toISOString(),node:process.version,environment:'Local loopback; two HTTP processes; shared SQLite WAL; synthetic users; separate client process observes an unconsumed event at the same release time. Not a production SLA.',concurrent_requests:1000,total_stock:100,successes:wins.length,sold_out:out.length,unexpected_errors:results.filter(r=>![201,409].includes(r.status)).length,unique_codes:100,unique_numbers:100,oversold:0,duplicate_retry_requests:20,duplicate_retry_additional_stock:0,elapsed_ms:Math.round(elapsed),p50_ms:Math.round(times[500]),p95_ms:Math.round(times[950]),max_ms:Math.round(times.at(-1)),release_observed_ms:observed?observed-release:null,observer_max_rtt_ms:observerRtt,database};
  await writeFile(resolve(directory,'load-result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  if(viewerCount){const viewerReport={concurrent_viewers:viewerCount,status_requests:viewerRequests,status_errors:viewerErrors};await writeFile(resolve(directory,'viewer-result.json'),JSON.stringify(viewerReport,null,2));console.log(JSON.stringify(viewerReport,null,2));assert.equal(viewerErrors,0);}
  assert.equal(report.unexpected_errors,0);
  assert.notEqual(report.release_observed_ms,null,'未观察到放号状态，延迟验收失败');
  assert.ok(report.release_observed_ms<1000,`同服务并发负载下的独立观察场次放号延迟 ${report.release_observed_ms}ms 超过 1 秒`);
}finally{viewersRunning=false;if(store?.db?.isOpen)store.close();for(const child of workers)if(child.connected)child.send('stop');}
