import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter,once } from 'node:events';
import { scrypt,randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import http from 'node:http';
import { clientIp } from '../lib/request-security.mjs';
import { bookingQueue } from '../lib/booking-queue.mjs';
import { openStore,passwordHash,reserve } from '../lib/store.mjs';
import { createApp } from '../lib/app.mjs';
const derive=promisify(scrypt);
async function fixture(t,options={}){
  const store=openStore(':memory:',{password:options.password||'security-test-password'});
  const app=createApp(store,{demo:false,wechat:{enabled:true,login:async code=>'openid_'+code},...options});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  t.after(()=>{app.server.closeAllConnections();app.server.close();store.close();});
  const admin=store.get('SELECT * FROM admins LIMIT 1');
  const cookie='flash_admin='+store.session(admin.id,'admin');
  const base='http://127.0.0.1:'+app.server.address().port;
  async function call(path,body,method=body?'POST':'GET',extra={}){
    return fetch(base+path,{method,headers:{Cookie:cookie,...(body?{'Content-Type':'application/json'}:{}),...extra},body:body?JSON.stringify(body):undefined});
  }
  return {store,app,admin,cookie,base,call};
}
test('默认忽略伪造代理头，显式信任时按最后一跳有效 IP 处理',()=>{
  const req={socket:{remoteAddress:'127.0.0.1'},headers:{'x-forwarded-for':'fake, 203.0.113.9'}};
  assert.equal(clientIp(req), '127.0.0.1');assert.equal(clientIp(req,true),'203.0.113.9');
  req.headers['x-forwarded-for']='203.0.113.9, invalid';assert.equal(clientIp(req,true),'127.0.0.1');
});
test('有首尾空格的初始管理员密码可以原样登录',async t=>{
  const f=await fixture(t,{password:'  security-test-password  '});
  assert.equal((await f.call('/api/auth/login',{username:'admin',password:'  security-test-password  '})).status,200);
  assert.equal((await f.call('/api/auth/login',{username:'admin',password:'security-test-password'})).status,401);
});
test('同一门店 NAT 下 1000 个不同用户不会被原先的 100 次限流误伤',async t=>{
  const f=await fixture(t);
  for(let i=0;i<1000;i++)assert.equal((await f.call('/api/user/login',{code:'unique-user-'+i})).status,200);
  assert.equal(f.store.get('SELECT COUNT(*) n FROM users').n,1000);
  assert.equal(f.store.get("SELECT COUNT(*) n FROM audit WHERE action='用户登录'").n,1000);
});
test('信任反向代理后不同访客的登录限流分开计数',async t=>{
  const f=await fixture(t,{trustProxy:true});f.store.run('INSERT INTO settings VALUES(?,?)','user_login_limit','1');
  assert.equal((await f.call('/api/user/login',{code:'alice'},'POST',{'X-Forwarded-For':'203.0.113.1'})).status,200);
  assert.equal((await f.call('/api/user/login',{code:'bob'},'POST',{'X-Forwarded-For':'203.0.113.1'})).status,429);
  assert.equal((await f.call('/api/user/login',{code:'bob'},'POST',{'X-Forwarded-For':'203.0.113.2'})).status,200);
});
test('后台登出既注销会话也记录操作日志',async t=>{
  const f=await fixture(t);assert.equal((await f.call('/api/auth/logout',{})).status,200);
  assert.equal((await f.call('/api/auth/me')).status,401);
  assert.equal(f.store.get("SELECT COUNT(*) n FROM audit WHERE action='退出后台'").n,1);
});
test('密码校验进行中停用账号，不能签发一个新会话',async t=>{
  let resume,started;const entered=new Promise(r=>started=r),gate=new Promise(r=>resume=r);
  const f=await fixture(t,{derivePassword:async(...args)=>{started();await gate;return derive(...args);}});
  const pending=f.call('/api/auth/login',{username:'admin',password:'security-test-password'});
  await entered;f.store.run('UPDATE admins SET enabled=0 WHERE id=?',f.admin.id);resume();
  assert.equal((await pending).status,401);
});
test('异步创建账号过程中管理员被降权，写入前重新验证权限',async t=>{
  let resume,started;const entered=new Promise(r=>started=r),gate=new Promise(r=>resume=r);
  const f=await fixture(t,{derivePassword:async(...args)=>{started();await gate;return derive(...args);}});
  const pending=f.call('/api/admin/accounts',{username:'new-operator',name:'测试运营',password:'security-test-new-password',role:'operator'});
  await entered;f.store.run("UPDATE admins SET role='readonly' WHERE id=?",f.admin.id);resume();
  assert.equal((await pending).status,403);
  assert.equal(f.store.get("SELECT COUNT(*) n FROM admins WHERE username='new-operator'").n,0);
});
test('自然结束的活动不能通过延长时间重新开放',async t=>{
  const f=await fixture(t),now=Date.now();
  f.store.run('INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)','past-event','已结束活动','测试地点','','','forest',now-30000,now-20000,now-10000,'published',1,0,now);
  const r=await f.call('/api/admin/events/past-event',{starts_at:now+10000,ends_at:now+20000},'PATCH');assert.equal(r.status,409);
});
test('跨网络数据块分开的中文 UTF-8 字符不会损坏',async t=>{
  const f=await fixture(t);const raw=Buffer.from(JSON.stringify({store_name:'中文门店'}));
  const offset=raw.indexOf(Buffer.from('中'))+1;
  const response=await new Promise((resolve,reject)=>{
    const req=http.request(f.base+'/api/admin/settings',{method:'PATCH',headers:{Cookie:f.cookie,'Content-Type':'application/json','Content-Length':raw.length}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
    req.on('error',reject);req.write(raw.subarray(0,offset));setTimeout(()=>req.end(raw.subarray(offset)),20);
  });
  assert.equal(response,200);assert.equal(f.store.settings().store_name,'中文门店');
});
test('错误编码地址返回 400，随后健康接口仍正常',async t=>{
  const f=await fixture(t);assert.equal((await f.call('/%ZZ')).status,400);assert.equal((await f.call('/api/health')).status,200);
});
test('过期会话和陈旧限流计数可清理，不删除有效会话与预约',()=>{
  const s=openStore(':memory:',{password:'maintenance-test-password'});try{
    s.run('INSERT INTO auth_sessions VALUES(?,?,?,?)','expired','a','admin',100);
    s.run('INSERT INTO auth_sessions VALUES(?,?,?,?)','valid','a','admin',200000000);
    s.run('INSERT INTO rate_limits VALUES(?,?,?)','old',1,100);s.run('INSERT INTO rate_limits VALUES(?,?,?)','fresh',1,100000000);
    assert.deepEqual(s.maintain(100000000),{sessions:1,counters:1});assert.equal(s.get('SELECT COUNT(*) n FROM auth_sessions').n,1);
  }finally{s.close();}
});
test('非法场次类型被拒绝为 400',()=>{
  const s=openStore(':memory:',{password:'bad-slot-test-password'});try{assert.throws(()=>reserve(s,{id:'user'},{slot_id:{id:'bad'},request_key:randomUUID()}),e=>e.status===400);}finally{s.close();}
});
test('预约线程未就绪时拒绝请求，异常退出后重启，停止后不再重启',async()=>{
  const workers=[];
  class FakeWorker extends EventEmitter{postMessage(job){this.last=job;}terminate(){this.emit('exit',0);return Promise.resolve(0);}}
  const q=bookingQueue('test-only',{createWorker:()=>{const worker=new FakeWorker();workers.push(worker);return worker;},restartDelay:5});
  try{
    assert.equal(q.healthy(),false);await assert.rejects(q.reserve('u',{},''),e=>e.status===503);
    workers[0].emit('message',{ready:true});assert.equal(q.healthy(),true);
    const pending=q.reserve('u',{},'');const rejected=assert.rejects(pending,e=>e.status===503);workers[0].emit('exit',1);await rejected;
    await new Promise(r=>setTimeout(r,20));assert.equal(workers.length,2);assert.equal(q.healthy(),false);
    workers[1].emit('message',{ready:true});assert.equal(q.healthy(),true);
    const value=q.reserve('u',{},'');workers[1].emit('message',{id:workers[1].last.id,value:{id:'ok'}});assert.deepEqual(await value,{id:'ok'});
  }finally{await q.close();}
  await new Promise(r=>setTimeout(r,20));assert.equal(workers.length,2);assert.equal(q.healthy(),false);
});
