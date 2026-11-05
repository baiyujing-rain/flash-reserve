import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { openStore, reserve, redeem, eventView, passwordHash } from '../lib/store.mjs';
import { createApp } from '../lib/app.mjs';

function fixture(t,{total=100,limit=1}={}){
  const s=openStore(':memory:',{password:'test-password-only'});t.after(()=>s.db.close());
  const now=Date.now(),event='event',slot='slot';
  s.run('INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',event,'测试快闪','测试门店','预约须知','','forest',now-10000,now+3600000,now+7200000,'published',limit,0,now);
  s.run('INSERT INTO slots(id,event_id,label,starts_at,ends_at,total) VALUES(?,?,?,?,?,?)',slot,event,'测试场次',now+3600000,now+7200000,total);
  const user=(i=0)=>{const id='u'+i;s.run('INSERT INTO users VALUES(?,?,?,?,?,?,?)',id,'openid_'+i,'测试用户'+i,'139'+String(i).padStart(8,'0'),0,'',now);return s.get('SELECT * FROM users WHERE id=?',id);};
  return {s,event,slot,user,admin:s.get('SELECT * FROM admins LIMIT 1')};
}
const booking=(slot='slot',request_key=randomUUID())=>({slot_id:slot,request_key});
const errorCode=(fn,code)=>assert.throws(fn,e=>e.code===code);

test('1000 个用户争抢 100 个号，库存与唯一性不变量成立',t=>{
  const {s,user}=fixture(t);let ok=0,out=0;
  for(let i=0;i<1000;i++){try{reserve(s,user(i),booking());ok++;}catch(e){assert.equal(e.code,'SOLD_OUT');out++;}}
  assert.equal(ok,100);assert.equal(out,900);
  const records=s.all('SELECT * FROM reservations');
  assert.equal(new Set(records.map(r=>r.code)).size,100);assert.equal(new Set(records.map(r=>r.number)).size,100);
  assert.equal(s.get('SELECT sold FROM slots').sold,100);
});
test('相同请求重试返回原购买码且只扣一次库存',t=>{const {s,user}=fixture(t);const u=user(),b=booking();const a=reserve(s,u,b),r=reserve(s,u,b);assert.equal(a.id,r.id);assert.equal(r.replayed,true);assert.equal(s.get('SELECT sold FROM slots').sold,1);});
test('跨场次重复预约仍受全活动每人限约控制',t=>{const {s,user,event}=fixture(t);const u=user();reserve(s,u,booking());s.run('INSERT INTO slots(id,event_id,label,starts_at,ends_at,total) SELECT ?,event_id,?,starts_at,ends_at,10 FROM slots LIMIT 1','other-slot','第二场');errorCode(()=>reserve(s,u,booking('other-slot')),'LIMIT_REACHED');assert.equal(s.get('SELECT sold FROM slots WHERE id=?','other-slot').sold,0);});
test('每人限约为 2 时可领取两次，第三次被拒绝',t=>{const {s,user}=fixture(t,{limit:2});const u=user();reserve(s,u,booking());reserve(s,u,booking());errorCode(()=>reserve(s,u,booking()),'LIMIT_REACHED');});
test('同一活动跨场次分配的号码也不重复',t=>{const {s,user}=fixture(t,{limit:2});s.run('INSERT INTO slots(id,event_id,label,starts_at,ends_at,total) SELECT ?,event_id,?,starts_at,ends_at,10 FROM slots LIMIT 1','second-slot','第二场');const a=reserve(s,user(1),booking()),b=reserve(s,user(2),booking('second-slot'));assert.equal(a.number,1);assert.equal(b.number,2);});
test('幂等键不能用于其他场次',t=>{const {s,user}=fixture(t);const u=user(),b=booking();reserve(s,u,b);assert.throws(()=>reserve(s,u,{...b,slot_id:'other'}),e=>e.status===409);});
test('开抢前、草稿、已结束均不可预约',t=>{const {s,user}=fixture(t);const u=user();s.run('UPDATE events SET release_at=?',Date.now()+100000);errorCode(()=>reserve(s,u,booking()),'NOT_OPEN');s.run("UPDATE events SET state='draft',release_at=?",Date.now()-1);errorCode(()=>reserve(s,u,booking()),'NOT_OPEN');s.run("UPDATE events SET state='ended'");errorCode(()=>reserve(s,u,booking()),'NOT_OPEN');});
test('暂停与锁定库存阻止分配',t=>{const {s,user}=fixture(t,{total:2});const u=user();s.run('UPDATE slots SET paused=1');errorCode(()=>reserve(s,u,booking()),'PAUSED');s.run('UPDATE slots SET paused=0,locked=2');errorCode(()=>reserve(s,u,booking()),'SOLD_OUT');assert.equal(s.get('SELECT sold FROM slots').sold,0);});
test('场次结束后不可预约，即使活动尚未结束',t=>{const {s,user}=fixture(t);s.run('UPDATE slots SET ends_at=?',Date.now()-1);errorCode(()=>reserve(s,user(),booking()),'NOT_OPEN');});
test('封禁用户与未授权手机号用户不可预约',t=>{const {s,user}=fixture(t);const u=user();s.run('UPDATE users SET phone=NULL');errorCode(()=>reserve(s,u,booking()),'PHONE_REQUIRED');s.run('UPDATE users SET blocked=1');errorCode(()=>reserve(s,u,booking()),'BLOCKED');});
test('核销与撤销核销均幂等拒绝重复执行，不影响库存',t=>{const {s,user,admin}=fixture(t);const r=reserve(s,user(),booking());redeem(s,admin,{code:r.code,device:'测试设备'});errorCode(()=>redeem(s,admin,{code:r.code}),'ALREADY_PROCESSED');redeem(s,admin,{code:r.code,reason:'测试撤销'},true);errorCode(()=>redeem(s,admin,{code:r.code,reason:'再次撤销'},true),'ALREADY_PROCESSED');assert.equal(s.get('SELECT sold FROM slots').sold,1);assert.equal(s.get('SELECT COUNT(*) n FROM redemptions').n,2);});
test('库存扣减或日志写入失败时整笔事务回滚',t=>{const {s,user}=fixture(t);const u=user();s.db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT,'test audit failure'); END");assert.throws(()=>reserve(s,u,booking()));assert.equal(s.get('SELECT sold FROM slots').sold,0);assert.equal(s.get('SELECT COUNT(*) n FROM reservations').n,0);});
test('余量公式与开抢状态从服务器时间派生',t=>{const {s}=fixture(t,{total:100});s.run('UPDATE slots SET sold=10,locked=20');let e=eventView(s,s.get('SELECT * FROM events'));assert.equal(e.available,70);assert.equal(e.has_stock,true);s.run('UPDATE slots SET paused=1');e=eventView(s,s.get('SELECT * FROM events'));assert.equal(e.available,70);assert.equal(e.has_stock,false);});

test('HTTP 权限、业务与导出闭环',async t=>{
  const f=fixture(t),{s,admin,user}=f;
  const app=createApp(s,{demo:false,wechat:{enabled:false},dataDir:resolve('artifacts','backup-tests')});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  t.after(()=>{app.server.closeAllConnections();app.server.close();});
  const base='http://127.0.0.1:'+app.server.address().port;
  const cookie='flash_admin='+s.session(admin.id,'admin');
  const tokens={superadmin:cookie};
  for(const role of ['operator','verifier','readonly']){const id='a_'+role;s.run('INSERT INTO admins VALUES(?,?,?,?,?,?,?)',id,role,role,passwordHash('test-password-only'),role,1,Date.now());tokens[role]='flash_admin='+s.session(id,'admin');}
  async function call(path,method='GET',body,role='superadmin',extra={}){return fetch(base+path,{method,headers:{Cookie:tokens[role]||'',...(body?{'Content-Type':'application/json'}:{}),...extra},body:body?JSON.stringify(body):undefined});}
  await t.test('未登录不可读取后台数据',async()=>assert.equal((await call('/api/admin/overview','GET',null,'none')).status,401));
  await t.test('生产模式禁用演示登录和假身份',async()=>{assert.equal((await call('/api/auth/demo','POST',{})).status,404);assert.equal((await call('/api/user/login','POST',{demo_id:'fake-id'})).status,400);});
  await t.test('正式密码登录及登出',async()=>{const r=await call('/api/auth/login','POST',{username:'admin',password:'test-password-only'},'none');assert.equal(r.status,200);assert.match(r.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);assert.ok((await r.json()).role==='superadmin');});
  await t.test('只读与核销员无法修改库存',async()=>{for(const role of ['readonly','verifier'])assert.equal((await call('/api/admin/slots/slot','PATCH',{delta:5,reason:'越权测试'},role)).status,403);});
  await t.test('只读无法创建活动或核销',async()=>{assert.equal((await call('/api/admin/events','POST',{},'readonly')).status,403);assert.equal((await call('/api/admin/redeem','POST',{code:'A'.repeat(20)},'readonly')).status,403);});
  await t.test('运营可调整库存且负库存被拒绝',async()=>{assert.equal((await call('/api/admin/slots/slot','PATCH',{delta:10,reason:'测试补放'},'operator')).status,200);assert.equal((await call('/api/admin/slots/slot','PATCH',{delta:-1000,reason:'错误扣减'},'operator')).status,409);assert.equal(s.get('SELECT total FROM slots').total,110);});
  await t.test('非超级管理员不能查看账号、修改配置、备份',async()=>{for(const role of ['operator','verifier','readonly']){assert.equal((await call('/api/admin/accounts','GET',null,role)).status,403);assert.equal((await call('/api/admin/settings','PATCH',{store_name:'test'},role)).status,403);assert.equal((await call('/api/admin/backup','POST',{},role)).status,403);}});
  await t.test('恶意来源的写操作被拒绝',async()=>assert.equal((await call('/api/admin/pause','POST',{paused:true},'superadmin',{Origin:'https://evil.example'})).status,403));
  await t.test('正常创建活动、发布、添加场次',async()=>{
    const now=Date.now();let r=await call('/api/admin/events','POST',{name:'接口创建活动',location:'真实测试地点',release_at:now+1000,starts_at:now+100000,ends_at:now+200000,total:10,state:'draft'});assert.equal(r.status,201);const e=await r.json();
    assert.equal((await call('/api/public/events/'+e.id)).status,404);
    assert.equal((await call('/api/admin/events/'+e.id,'PATCH',{state:'published'})).status,200);
    assert.equal((await call('/api/admin/events/'+e.id+'/slots','POST',{label:'新增时段',starts_at:now+100001,ends_at:now+199999,total:10})).status,201);
    assert.equal((await call('/api/admin/events/'+e.id,'PATCH',{state:'draft'})).status,409);
  });
  let record;
  await t.test('用户预约与核销员核销闭环',async()=>{
    const u=user(1),token=s.session(u.id,'user');const headers={Authorization:'Bearer '+token};
    const r=await call('/api/user/reservations','POST',booking(),'none',headers);assert.equal(r.status,201);record=await r.json();
    const mine=await call('/api/user/reservations','GET',null,'none',headers);assert.equal((await mine.json()).items.length,1);
    assert.equal((await call('/api/admin/redeem','POST',{code:record.code,device:'门口扫码设备'},'verifier')).status,200);
    assert.equal((await call('/api/admin/redeem','POST',{code:record.code},'verifier')).status,409);
    assert.equal((await call('/api/admin/redeem/undo','POST',{code:record.code,reason:'越权撤销'},'verifier')).status,403);
    assert.equal((await call('/api/admin/redeem/undo','POST',{code:record.code,reason:'运营撤销'},'operator')).status,200);
  });
  await t.test('CSV 筛选、Excel BOM 与公式注入防护',async()=>{
    s.run('UPDATE users SET nickname=? WHERE id=?','=HYPERLINK("evil")','u1');
    const r=await call('/api/admin/reservations?export=csv&event=event');assert.equal(r.status,200);
    const raw=new Uint8Array(await r.arrayBuffer());assert.deepEqual([...raw.slice(0,3)],[239,187,191]);const text=new TextDecoder().decode(raw);assert.ok(text.includes("'=HYPERLINK"));assert.ok(text.includes(record.code));
    const q=await call('/api/admin/reservations?q='+encodeURIComponent(record.code));assert.equal((await q.json()).total,1);
  });
  await t.test('限流按用户计数，不误伤同 IP 下其他用户',async()=>{
    const u=user(2);s.run('INSERT INTO settings VALUES(?,?)','booking_limit','1');const headers={Authorization:'Bearer '+s.session(u.id,'user')};
    assert.equal((await call('/api/user/reservations','POST',booking(),'none',headers)).status,201);
    assert.equal((await call('/api/user/reservations','POST',booking(),'none',headers)).status,429);
    const u2=user(3);assert.equal((await call('/api/user/reservations','POST',booking(),'none',{Authorization:'Bearer '+s.session(u2.id,'user')})).status,201);
  });
  await t.test('封禁立即使用户会话失效',async()=>{
    const u=user(4),headers={Authorization:'Bearer '+s.session(u.id,'user')};assert.equal((await call('/api/admin/users/'+u.id,'PATCH',{blocked:true,reason:'测试异常用户'})).status,200);assert.equal((await call('/api/user/me','GET',null,'none',headers)).status,401);
  });
  await t.test('不能停用最后一个超级管理员',async()=>assert.equal((await call('/api/admin/accounts/'+admin.id,'PATCH',{enabled:false})).status,409));
  await t.test('角色变化使原会话失效',async()=>{assert.equal((await call('/api/admin/accounts/a_operator','PATCH',{role:'readonly'})).status,200);assert.equal((await call('/api/admin/overview','GET',null,'operator')).status,401);});
  await t.test('无微信凭证时订阅不伪报成功',async()=>{const u=user(5);const r=await call('/api/user/reminders','POST',{event_id:'event',accepted:true},'none',{Authorization:'Bearer '+s.session(u.id,'user')});assert.notEqual(r.status,200);});
  await t.test('SQL 注入文本不能改变查询结构',async()=>{const r=await call('/api/admin/reservations?q='+encodeURIComponent("' OR 1=1 --"));assert.equal(r.status,200);assert.equal((await r.json()).total,0);});
  await t.test('超级管理员下载一致性 SQLite 快照',async()=>{const r=await call('/api/admin/backup','POST',{});assert.equal(r.status,200);const bytes=Buffer.from(await r.arrayBuffer());assert.equal(bytes.subarray(0,16).toString(),'SQLite format 3\u0000');assert.equal(s.get("SELECT COUNT(*) n FROM audit WHERE action='导出数据库备份'").n,1);});
  await t.test('后台与用户静态入口可打开',async()=>{for(const p of ['/','/book','/app.js','/book.js','/storefront.svg'])assert.equal((await fetch(base+p)).status,200);});
});

test('订阅提醒只消费一次，发送失败保留原因',async t=>{
  const {s,user}=fixture(t);const u=user();s.run('UPDATE events SET release_at=?',Date.now()+60000);s.run('INSERT INTO settings VALUES(?,?)','template_id',JSON.stringify('test-template'));
  s.run('INSERT INTO reminders(id,user_id,event_id,created_at) VALUES(?,?,?,?)','reminder',u.id,'event',Date.now());
  let sends=0;const app=createApp(s,{wechat:{enabled:true,async remind(){sends++;}}});t.after(()=>app.server.emit('close'));
  await app.reminders();await app.reminders();assert.equal(sends,1);assert.equal(s.get('SELECT status FROM reminders').status,'sent');
  s.run("UPDATE reminders SET status='pending'");const failure=createApp(s,{wechat:{enabled:true,async remind(){throw Error('模拟微信拒绝发送');}}});t.after(()=>failure.server.emit('close'));
  await failure.reminders();assert.equal(s.get('SELECT status FROM reminders').status,'failed');assert.equal(s.get('SELECT error FROM reminders').error,'模拟微信拒绝发送');
});
