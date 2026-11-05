import { createServer } from 'node:http';
import { readFile, mkdir, rm } from 'node:fs/promises';
import { resolve, extname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { backup } from 'node:sqlite';
import { AppError, fail, roles, passwordHash, tokenHash, phase, eventView, reserve, redeem, seedDemo } from './store.mjs';
import { wechatClient } from './wechat.mjs';
import { bookingQueue } from './booking-queue.mjs';
import { clientIp,passwordValue } from './request-security.mjs';

const scryptAsync = promisify(scrypt);
const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const TYPES = { '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml' };
const integer = (v,min,max,label) => { if(!Number.isSafeInteger(v)||v<min||v>max) fail(400, `${label}必须为 ${min}–${max} 的整数`); return v; };
const str = (v,min,max,label) => { if(typeof v!=='string'||v.trim().length<min||v.length>max) fail(400, `${label}长度应为 ${min}–${max} 个字符`); return v.trim(); };
const bool = v => { if(typeof v!=='boolean') fail(400,'状态必须为布尔值'); return v?1:0; };
const timestamp = (v,label) => integer(v,1577808000000,4102416000000,label);
function eventInput(b) {
  const x = {name:str(b.name,2,80,'活动名称'),location:str(b.location,2,200,'地点'),notices:str(b.notices??'',0,3000,'须知'),
    banner:str(b.banner??'',0,1000,'Banner 链接'),theme:['forest','clay','blue','lavender'].includes(b.theme)?b.theme:'forest',
    release_at:timestamp(b.release_at,'开抢时间'),starts_at:timestamp(b.starts_at,'活动时间'),ends_at:timestamp(b.ends_at,'结束时间'),
    state:['draft','published','ended'].includes(b.state)?b.state:'draft',per_limit:integer(b.per_limit??1,1,10,'每人限约')};
  if(x.release_at>x.starts_at || x.starts_at>=x.ends_at) fail(400,'开抢时间须不晚于活动开始，结束须晚于开始');
  if(x.banner && !/^https:\/\//.test(x.banner)) fail(400,'Banner 请使用 HTTPS 图片链接');
  return x;
}
const csvCell = v => { let x=String(v??''); if (/^[\s]*[=+@-]/.test(x)) x="'"+x; return '"'+x.replaceAll('"','""')+'"'; };
const csv = (rows, columns) => '\uFEFF'+[columns.map(c=>csvCell(c[0])).join(','),...rows.map(r=>columns.map(c=>csvCell(r[c[1]])).join(','))].join('\r\n');
const BOOK_COLUMNS = [['预约时间','created_at'],['活动','event_name'],['场次','slot_label'],['昵称','nickname'],['手机号','phone'],['openid','openid'],['号码','number'],['购买码','code'],['状态','status']];
const REDEEM_COLUMNS = [['时间','created_at'],['核销员','actor_name'],['活动','event_name'],['场次','slot_label'],['购买码','code'],['操作','action'],['设备','device'],['原因','reason']];
const isoRows = rows => rows.map(r=>({...r,created_at:new Date(r.created_at).toISOString()}));

export function createApp(store, options = {}) {
  const demo = !!options.demo;
  const derivePassword=options.derivePassword||scryptAsync;
  const wechat = options.wechat || wechatClient();
  const bookings=store.filename!==':memory:'?bookingQueue(store.filename):null;
  const publicCache=new Map();
  let reminderBusy = false;
  // In-flight sends remain 'sending' across restart: do not reset another live
  // process's claim and do not risk a duplicate notification after a timeout.
  async function reminders() {
    if(reminderBusy || !wechat.enabled || !store.settings().template_id) return;
    reminderBusy=true;
    try {
      const settings=store.settings();
      const rows=store.all(`SELECT r.* FROM reminders r JOIN events e ON r.event_id=e.id
        WHERE r.status='pending' AND e.state='published' AND e.release_at>? AND e.release_at<=? LIMIT 20`, Date.now(),Date.now()+settings.reminder_minutes*60000);
      for(const r of rows) {
        const changed=store.run("UPDATE reminders SET status='sending',attempts=attempts+1 WHERE id=? AND status='pending'", r.id);
        if(!changed.changes) continue;
        const user=store.get('SELECT * FROM users WHERE id=?',r.user_id), event=store.get('SELECT * FROM events WHERE id=?',r.event_id);
        try {
          if(user.blocked) fail(403,'账号已封禁');
          await wechat.remind(user,event,settings);
          store.tx(()=>{store.run("UPDATE reminders SET status='sent',sent_at=? WHERE id=?",Date.now(),r.id); store.audit('消息服务','发送订阅提醒',r.id,{event:event.name});});
        } catch(e) { store.tx(()=>{store.run("UPDATE reminders SET status='failed',error=? WHERE id=?",e.message.slice(0,300),r.id); store.audit('消息服务','订阅提醒失败',r.id,{error:e.message});}); }
      }
      store.run("UPDATE reminders SET status='expired',error='已超过开抢时间' WHERE status='pending' AND event_id IN (SELECT id FROM events WHERE release_at<=?)",Date.now());
    } finally { reminderBusy=false; }
  }
  const timer=setInterval(()=>{ reminders().catch(e=>console.error('Reminder worker:',e.message)); },5000);
  timer.unref();
  const maintenance=setInterval(()=>{try{store.maintain();}catch(e){console.error('Session maintenance:',e.message);}},3600000);
  maintenance.unref();
  const server=createServer(async(req,res)=> {
    let url;try{url=new URL(req.url,'http://localhost');}catch{res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'请求地址无效',code:'INVALID_URL'}));return;}
    const path=url.pathname, method=req.method;
    const ip=clientIp(req,!!options.trustProxy);
    const send=(value,status=200,headers={})=> {res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});res.end(JSON.stringify(value));};
    const download=(body,filename,type='text/csv; charset=utf-8')=>{res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store','Content-Disposition':`attachment; filename="${filename}"`});res.end(body);};
    res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','same-origin'); res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
    try {
      if(!['GET','POST','PATCH'].includes(method)) fail(405,'请求方式不支持');
      if(method!=='GET' && req.headers.origin) {
        const allowed=options.origin || `http://${req.headers.host}`;
        if(req.headers.origin!==allowed) fail(403,'不允许的请求来源');
      }
      let body={};
      if(method!=='GET') {
        const chunks=[];let size=0;
        for await (const chunk of req) {size+=chunk.length;if(size>65536) fail(413,'请求内容过大');chunks.push(chunk);}
        try {body=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{fail(400,'JSON 格式无效');}
        if(!body||Array.isArray(body)||typeof body!=='object') fail(400,'请求内容应为对象');
      }
      const cookie = (req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('flash_admin='))?.slice(12);
      const bearer = req.headers.authorization?.startsWith('Bearer ')?req.headers.authorization.slice(7):null;
      const principal = kind=> {
        const token=kind==='admin'?cookie:bearer;
        if(!token) fail(401,'请先登录','UNAUTHENTICATED');
        const session=store.get('SELECT * FROM auth_sessions WHERE token_hash=? AND kind=? AND expires_at>?',tokenHash(token),kind,Date.now());
        if(!session) fail(401,'登录已过期，请重新登录','UNAUTHENTICATED');
        const p=store.get(`SELECT * FROM ${kind==='admin'?'admins':'users'} WHERE id=?`,session.principal_id);
        if(!p || (kind==='admin'?!p.enabled:p.blocked)) fail(403,'账号已停用','BLOCKED');
        return p;
      };
      const admin = (allowed=roles)=> {const p=principal('admin');if(!allowed.includes(p.role)) fail(403,'当前角色没有此操作权限','FORBIDDEN');return p;};
      const writer=()=>admin(['superadmin','operator']);
      const adminCookie=token=>`flash_admin=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token?28800:0}${options.origin?.startsWith('https:')?'; Secure':''}`;
      const safeAdmin=p=>({id:p.id,name:p.name,username:p.username,role:p.role,enabled:p.enabled});
      if(path==='/api/health') {const ok=!bookings||bookings.healthy();return send({ok,booking_ready:ok,server_now:Date.now()},ok?200:503);}
      if(path==='/api/config' && method==='GET') {const s=store.settings();return send({demo,store_name:s.store_name,wechat:wechat.enabled,template_id:s.template_id,reminder_minutes:s.reminder_minutes,server_now:Date.now()});}
      if(path==='/api/auth/login' && method==='POST') {
        const username=str(body.username,1,60,'账号'),password=passwordValue(body.password);
        const limit=store.settings().login_limit;
        store.rate('login-ip:'+ip,limit);store.rate('login-name:'+username,limit);
        const p=store.get('SELECT * FROM admins WHERE username=?',username);
        const [salt,hash]=(p?.password||'0'.repeat(32)+':'+ '0'.repeat(128)).split(':');
        const actual=await derivePassword(password,salt,64);
        if(!p||!p.enabled||!timingSafeEqual(actual,Buffer.from(hash,'hex'))) {store.audit(username,'登录失败','',{},ip);fail(401,'账号或密码错误');}
        const result=store.tx(()=>{const current=store.get('SELECT * FROM admins WHERE id=?',p.id);if(!current?.enabled||current.password!==p.password)fail(401,'账号或密码已变更，请重新登录');const token=store.session(current.id,'admin');store.audit(current.name,'登录后台','',{},ip);return {current,token};});
        return send(safeAdmin(result.current),200,{'Set-Cookie':adminCookie(result.token)});
      }
      if(path==='/api/auth/demo' && method==='POST') {
        if(!demo) fail(404,'接口不存在');
        const p=store.get("SELECT * FROM admins WHERE role='superadmin' AND enabled=1 LIMIT 1");
        const token=store.session(p.id,'admin');store.audit(p.name,'本地演示登录','',{},ip);
        return send(safeAdmin(p),200,{'Set-Cookie':adminCookie(token)});
      }
      if(path==='/api/auth/me' && method==='GET') return send(safeAdmin(admin()));
      if(path==='/api/auth/logout' && method==='POST') {if(cookie)store.tx(()=>{const old=store.get("SELECT a.name FROM auth_sessions s JOIN admins a ON a.id=s.principal_id WHERE token_hash=? AND kind='admin'",tokenHash(cookie));store.run('DELETE FROM auth_sessions WHERE token_hash=?',tokenHash(cookie));if(old)store.audit(old.name,'退出后台','',{},ip);});return send({ok:true},200,{'Set-Cookie':adminCookie('')});}
      if(path==='/api/user/login' && method==='POST') {
        store.rate('user-login:'+ip,store.settings().user_login_limit);
        let openid;
        if(demo && body.demo_id) openid='demo_'+tokenHash(str(body.demo_id,3,100,'演示身份')).slice(0,28);
        else openid=await wechat.login(str(body.code,1,200,'微信登录凭证'));
        store.rate('openid-login:'+tokenHash(openid),20);
        let user=store.get('SELECT * FROM users WHERE openid=?',openid);
        if(!user) {
          const id=randomUUID();
          store.run('INSERT INTO users VALUES(?,?,?,?,?,?,?) ON CONFLICT(openid) DO NOTHING',id,openid,demo?'演示访客':'微信用户',null,0,'',Date.now());
          user=store.get('SELECT * FROM users WHERE openid=?',openid);
        }
        if(user.blocked) fail(403,'账号已被限制预约','BLOCKED');
        const token=store.tx(()=>{const token=store.session(user.id,'user');store.audit(user.id,'用户登录','',{},ip);return token;});
        return send({token,user:{id:user.id,nickname:user.nickname,phone:user.phone}});
      }
      if(path==='/api/user/me' && method==='GET') {const u=principal('user');return send({id:u.id,nickname:u.nickname,phone:u.phone});}
      if(path==='/api/user/phone' && method==='POST') {
        const u=principal('user');store.rate('phone:'+u.id,10);
        let phone;
        if(demo && body.phone) {phone=str(body.phone,11,11,'演示手机号');if(!/^1\d{10}$/.test(phone)) fail(400,'手机号格式错误');}
        else phone=await wechat.phone(str(body.code,1,200,'手机号凭证'));
        store.tx(()=>{principal('user');store.run('UPDATE users SET phone=? WHERE id=?',phone,u.id);store.audit(u.id,'绑定手机号',u.id,{},ip);});
        return send({phone});
      }
      if(path==='/api/public/events' && method==='GET') return send({items:store.all("SELECT * FROM events WHERE state!='draft' ORDER BY release_at DESC").map(e=>eventView(store,e,true)),server_now:Date.now()});
      const publicEvent=path.match(/^\/api\/public\/events\/([^/]+)$/);
      if(publicEvent && method==='GET') {
        const cached=publicCache.get(publicEvent[1]);
        if(cached && cached.expires>Date.now())return send({...cached.value,server_now:Date.now()});
        const e=store.get("SELECT * FROM events WHERE id=? AND state!='draft'",publicEvent[1]);
        if(!e) fail(404,'活动未发布或不存在');
        const value=eventView(store,e,true);
        if(publicCache.size>=500)publicCache.delete(publicCache.keys().next().value);
        publicCache.set(e.id,{value,expires:Date.now()+100});
        return send(value);
      }
      if(path==='/api/user/reservations' && method==='POST') {
        const u=principal('user');
        if(bookings)return send(await bookings.reserve(u.id,body,ip),201);
        store.rate('book:'+u.id,store.settings().booking_limit);
        return send(reserve(store,u,body,ip),201);
      }
      if(path==='/api/user/reservations' && method==='GET') {const u=principal('user');return send({items:store.all(`SELECT r.*,e.name AS event_name,e.location,s.label AS slot_label,s.starts_at,s.ends_at FROM reservations r JOIN events e ON e.id=r.event_id JOIN slots s ON s.id=r.slot_id WHERE r.user_id=? ORDER BY r.created_at DESC`,u.id)});}
      if(path==='/api/user/reminders' && method==='POST') {
        const u=principal('user'),e=store.get("SELECT * FROM events WHERE id=? AND state='published'",String(body.event_id||''));
        if(!e || phase(e)!=='upcoming') fail(400,'仅可订阅未开抢的活动');
        if(!wechat.enabled || !store.settings().template_id) fail(503,'尚未开通微信订阅提醒');
        if(body.accepted!==true) fail(400,'请先在微信内同意订阅消息');
        store.tx(()=>{store.run(`INSERT INTO reminders(id,user_id,event_id,created_at) VALUES(?,?,?,?) ON CONFLICT(user_id,event_id) DO UPDATE SET status='pending',error='' WHERE status IN ('failed','expired')`,randomUUID(),u.id,e.id,Date.now());store.audit(u.id,'订阅放号提醒',e.id,{},ip);});
        return send({ok:true});
      }
      if(path==='/api/admin/overview' && method==='GET') {
        admin();const now=Date.now();const dayStart=Math.floor((now+8*3600000)/86400000)*86400000-8*3600000;
        const events=store.all('SELECT * FROM events ORDER BY created_at DESC').map(e=>eventView(store,e));
        const stats={events:events.length,live:events.filter(e=>e.phase==='live').length,
          reservations:store.get('SELECT COUNT(*) n FROM reservations').n,
          today:store.get('SELECT COUNT(*) n FROM reservations WHERE created_at>=?',dayStart).n,
          redeemed:store.get("SELECT COUNT(*) n FROM reservations WHERE status='redeemed'").n,
          available:events.filter(e=>e.phase==='live'||e.phase==='upcoming').reduce((n,e)=>n+e.available,0)};
        const trend=Array.from({length:7},(_,i)=>{const start=dayStart-(6-i)*86400000;return {day:start,count:store.get('SELECT COUNT(*) n FROM reservations WHERE created_at>=? AND created_at<?',start,start+86400000).n};});
        return send({stats,events,trend,recent:store.all('SELECT * FROM audit ORDER BY id DESC LIMIT 5'),server_now:now});
      }
      if(path==='/api/admin/events' && method==='GET') {admin();return send({items:store.all('SELECT * FROM events ORDER BY created_at DESC').map(e=>eventView(store,e))});}
      if(path==='/api/admin/events' && method==='POST') {
        const a=writer(),e=eventInput(body),id=randomUUID();
        const capacity=integer(body.total,1,100000,'总号源');
        const label=str(body.slot_label||'首场 · 自由入场',1,60,'场次名称');
        store.tx(()=>{store.run('INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',id,...Object.values(e),demo?1:0,Date.now());
          store.run('INSERT INTO slots(id,event_id,label,starts_at,ends_at,total) VALUES(?,?,?,?,?,?)',randomUUID(),id,label,e.starts_at,e.ends_at,capacity);
          store.audit(a.name,'创建活动',id,{name:e.name,total:capacity},ip);});
        return send(eventView(store,store.get('SELECT * FROM events WHERE id=?',id)),201);
      }
      const eventRoute=path.match(/^\/api\/admin\/events\/([^/]+)$/);
      if(eventRoute && method==='PATCH') {
        const a=writer(),id=eventRoute[1];
        store.tx(()=>{
          const old=store.get('SELECT * FROM events WHERE id=?',id);if(!old) fail(404,'活动不存在');
          const e=eventInput({...old,...body});
          if(old.state!=='draft' && e.state==='draft') fail(409,'已发布活动不能退回草稿');
          if(old.state==='ended' && e.state!=='ended') fail(409,'已结束活动不能重新发布');
          if(phase(old)==='ended'&&phase(e)!=='ended')fail(409,'已结束活动不能通过修改时间重新开放');
          if(store.get('SELECT COUNT(*) n FROM reservations WHERE event_id=?',id).n && (e.starts_at!==old.starts_at || e.ends_at!==old.ends_at || e.per_limit!==old.per_limit)) fail(409,'已有预约，不能修改活动时间或每人限约');
          const occupied=store.get('SELECT COUNT(*) n FROM slots WHERE event_id=? AND (starts_at<? OR ends_at>?)',id,e.starts_at,e.ends_at).n;
          if(occupied && store.get('SELECT COUNT(*) n FROM slots WHERE event_id=?',id).n>1) fail(409,'请先调整场次时间，使其处于活动时间内');
          store.run('UPDATE events SET name=?,location=?,notices=?,banner=?,theme=?,release_at=?,starts_at=?,ends_at=?,state=?,per_limit=? WHERE id=?',...Object.values(e),id);
          if(store.get('SELECT COUNT(*) n FROM slots WHERE event_id=?',id).n===1) store.run('UPDATE slots SET starts_at=?,ends_at=? WHERE event_id=?',e.starts_at,e.ends_at,id);
          store.audit(a.name,'编辑活动',id,{before:old,after:e},ip);
        });return send(eventView(store,store.get('SELECT * FROM events WHERE id=?',id)));
      }
      const addSlot=path.match(/^\/api\/admin\/events\/([^/]+)\/slots$/);
      if(addSlot && method==='POST') {
        const a=writer(),e=store.get('SELECT * FROM events WHERE id=?',addSlot[1]);if(!e) fail(404,'活动不存在');
        const id=randomUUID(),label=str(body.label,1,60,'场次名称'),starts=timestamp(body.starts_at,'开始时间'),ends=timestamp(body.ends_at,'结束时间'),total=integer(body.total,1,100000,'号源');
        if(starts<e.starts_at || ends>e.ends_at || starts>=ends) fail(400,'场次时间必须在活动时间范围内');
        store.tx(()=>{store.run('INSERT INTO slots(id,event_id,label,starts_at,ends_at,total) VALUES(?,?,?,?,?,?)',id,e.id,label,starts,ends,total);store.audit(a.name,'新增场次',id,{event:e.name,total},ip);});return send({id},201);
      }
      const stock=path.match(/^\/api\/admin\/slots\/([^/]+)$/);
      if(stock && method==='PATCH') {
        const a=writer(),id=stock[1];
        const result=store.tx(()=>{
          const old=store.get('SELECT * FROM slots WHERE id=?',id);if(!old) fail(404,'场次不存在');
          if(!body.reason || typeof body.reason!=='string' || body.reason.trim().length<2) fail(400,'请填写调整原因');
          const total=body.delta===undefined?old.total:old.total+integer(body.delta,-100000,100000,'库存调整量');
          const locked=body.locked===undefined?old.locked:integer(body.locked,0,100000,'锁定库存');
          const paused=body.paused===undefined?old.paused:bool(body.paused);
          if(total<old.sold+locked || total>100000) fail(409,'调整后总量不能小于已预约加锁定数量，或超过 100000');
          store.run('UPDATE slots SET total=?,locked=?,paused=? WHERE id=?',total,locked,paused,id);
          store.audit(a.name,'调整场次库存',id,{before:old,after:{total,locked,paused},reason:body.reason},ip);
          return store.get('SELECT * FROM slots WHERE id=?',id);
        });return send(result);
      }
      if(path==='/api/admin/pause' && method==='POST') {const a=writer();const paused=bool(body.paused);store.tx(()=>{store.run('UPDATE slots SET paused=? WHERE event_id IN (SELECT id FROM events WHERE state=\'published\' AND ends_at>?)',paused,Date.now());store.audit(a.name,paused?'暂停全部放号':'恢复全部放号','',{},ip);});return send({ok:true});}
      const listRoute=['/api/admin/reservations','/api/admin/redemptions','/api/admin/audit','/api/admin/users','/api/admin/reminders'];
      if(listRoute.includes(path) && method==='GET') {
        const a=admin();
        if(path==='/api/admin/audit'||path==='/api/admin/users') admin(['superadmin','operator','readonly']);
        let query,where=' WHERE 1=1',args=[];
        const search=(url.searchParams.get('q')||'').slice(0,100), event=url.searchParams.get('event'),status=url.searchParams.get('status');
        if(path.endsWith('reservations')) {
          query='SELECT r.*,u.nickname,u.openid,e.name AS event_name,s.label AS slot_label FROM reservations r JOIN users u ON u.id=r.user_id JOIN events e ON e.id=r.event_id JOIN slots s ON s.id=r.slot_id';
          if(search){where+=' AND (r.phone LIKE ? OR u.nickname LIKE ? OR r.code LIKE ? OR CAST(r.number AS TEXT)=?)';args.push('%'+search+'%','%'+search+'%','%'+search+'%',search);}
          if(event){where+=' AND r.event_id=?';args.push(event);}
          if(status){where+=' AND r.status=?';args.push(status);}
        } else if(path.endsWith('redemptions')) {
          query='SELECT x.*,r.code,e.name AS event_name,s.label AS slot_label FROM redemptions x JOIN reservations r ON r.id=x.reservation_id JOIN events e ON e.id=r.event_id JOIN slots s ON s.id=r.slot_id';
          if(search){where+=' AND (r.code LIKE ? OR x.actor_name LIKE ?)';args.push('%'+search+'%','%'+search+'%');}
          if(event){where+=' AND r.event_id=?';args.push(event);}
          if(status){where+=' AND x.action=?';args.push(status);}
        } else if(path.endsWith('audit')) {
          query='SELECT * FROM audit'; if(search){where+=' AND (actor LIKE ? OR action LIKE ?)';args.push('%'+search+'%','%'+search+'%');}
        } else if(path.endsWith('reminders')) {
          query='SELECT r.*,u.nickname,e.name AS event_name FROM reminders r JOIN users u ON u.id=r.user_id JOIN events e ON e.id=r.event_id';
        } else {
          query='SELECT id,openid,nickname,phone,blocked,reason,created_at FROM users';
          if(search){where+=' AND (phone LIKE ? OR nickname LIKE ? OR openid LIKE ?)';args.push('%'+search+'%','%'+search+'%','%'+search+'%');}
          if(status==='blocked') where+=' AND blocked=1';
        }
        const total=store.get(`SELECT COUNT(*) n FROM (${query+where})`,...args).n;
        const maxRows=10000;
        if(url.searchParams.get('export')==='csv') {
          if(total>maxRows) fail(400,'单次最多导出 10000 条，请按活动筛选');
          const rows=store.all(query+where+' ORDER BY created_at DESC LIMIT '+maxRows,...args);
          const columns=path.endsWith('reservations')?BOOK_COLUMNS:path.endsWith('redemptions')?REDEEM_COLUMNS:Object.keys(rows[0]||{created_at:''}).map(k=>[k,k]);
          store.audit(a.name,'导出数据',path,{count:rows.length},ip);return download(csv(isoRows(rows),columns),path.split('/').pop()+'.csv');
        }
        const page=Math.floor(Math.max(1,Math.min(100000,Number(url.searchParams.get('page'))||1))),size=20;
        const rows=store.all(query+where+' ORDER BY created_at DESC LIMIT ? OFFSET ?',...args,size,(page-1)*size);
        return send({items:rows,total,page,page_size:size});
      }
      if(path==='/api/admin/redeem' && method==='POST') {const a=admin(['superadmin','operator','verifier']);return send(redeem(store,a,body,false,ip));}
      if(path==='/api/admin/redeem/undo' && method==='POST') {const a=writer();return send(redeem(store,a,body,true,ip));}
      const block=path.match(/^\/api\/admin\/users\/([^/]+)$/);
      if(block && method==='PATCH') {
        const a=writer(),blocked=bool(body.blocked),reason=str(body.reason,2,300,'操作原因');
        store.tx(()=>{if(!store.get('SELECT id FROM users WHERE id=?',block[1])) fail(404,'用户不存在');store.run('UPDATE users SET blocked=?,reason=? WHERE id=?',blocked,reason,block[1]);if(blocked)store.run("DELETE FROM auth_sessions WHERE principal_id=? AND kind='user'",block[1]);store.audit(a.name,blocked?'封禁用户':'解除封禁',block[1],{reason},ip);});return send({ok:true});
      }
      if(path==='/api/admin/settings' && method==='GET') {admin(['superadmin','operator','readonly']);return send({...store.settings(),wechat:wechat.enabled,demo});}
      if(path==='/api/admin/settings' && method==='PATCH') {
        const a=admin(['superadmin']),s={...store.settings(),...body};
        const allowed={store_name:str(s.store_name,2,30,'门店名称'),booking_limit:integer(s.booking_limit,1,300,'每分钟预约限流'),login_limit:integer(s.login_limit,5,100,'每分钟登录限流'),user_login_limit:integer(s.user_login_limit,100,10000,'每 IP 每分钟用户登录限流'),template_id:str(s.template_id,0,100,'模板 ID'),reminder_minutes:integer(s.reminder_minutes,1,120,'提醒提前分钟数'),template_name_key:str(s.template_name_key,2,30,'活动模板字段'),template_time_key:str(s.template_time_key,2,30,'时间模板字段'),template_location_key:str(s.template_location_key,2,30,'地点模板字段')};
        for(const key of ['template_name_key','template_time_key','template_location_key']) if(!/^[a-z]+\d+$/.test(allowed[key])) fail(400,'模板字段格式应如 thing1、time2');
        store.tx(()=>{for(const[k,v]of Object.entries(allowed))store.run('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',k,JSON.stringify(v));store.audit(a.name,'更新系统配置','',allowed,ip);});return send(allowed);
      }
      if(path==='/api/admin/accounts' && method==='GET') {admin(['superadmin']);return send({items:store.all('SELECT id,username,name,role,enabled,created_at FROM admins ORDER BY created_at')});}
      if(path==='/api/admin/accounts' && method==='POST') {
        const a=admin(['superadmin']),id=randomUUID(),username=str(body.username,3,40,'账号'),name=str(body.name,2,30,'名称'),password=passwordValue(body.password,12,128);
        if(!/^[A-Za-z0-9_-]+$/.test(username)||!roles.includes(body.role)) fail(400,'账号或角色格式错误');
        // scrypt runs off the event loop so login/account provisioning cannot block release polling.
        const salt=randomBytes(16).toString('hex'),hash=await derivePassword(password,salt,64);
        store.tx(()=>{admin(['superadmin']);store.run('INSERT INTO admins VALUES(?,?,?,?,?,?,?)',id,username,name,salt+':'+hash.toString('hex'),body.role,1,Date.now());store.audit(a.name,'新增管理账号',id,{username,role:body.role},ip);});return send({id},201);
      }
      const account=path.match(/^\/api\/admin\/accounts\/([^/]+)$/);
      if(account && method==='PATCH') {
        const a=admin(['superadmin']),id=account[1];
        let password=null;
        if(body.password) {const p=passwordValue(body.password,12,128),salt=randomBytes(16).toString('hex');password=salt+':'+(await derivePassword(p,salt,64)).toString('hex');}
        store.tx(()=>{
          admin(['superadmin']);
          const old=store.get('SELECT * FROM admins WHERE id=?',id);if(!old)fail(404,'账号不存在');
          const role=body.role??old.role,enabled=body.enabled===undefined?old.enabled:bool(body.enabled);
          if(!roles.includes(role))fail(400,'角色不存在');
          if(old.role==='superadmin' && (role!=='superadmin'||!enabled) && store.get("SELECT COUNT(*) n FROM admins WHERE role='superadmin' AND enabled=1").n<=1) fail(409,'必须保留至少一个启用的超级管理员');
          if(a.id===id&&!enabled)fail(409,'不能停用当前账号');
          store.run('UPDATE admins SET name=?,role=?,enabled=?,password=? WHERE id=?',body.name===undefined?old.name:str(body.name,2,30,'名称'),role,enabled,password||old.password,id);
          store.run('DELETE FROM auth_sessions WHERE principal_id=?',id);
          store.audit(a.name,'更新管理账号',id,{role,enabled,password_changed:!!password},ip);
        });return send({ok:true});
      }
      if(path==='/api/admin/backup' && method==='POST') {
        const a=admin(['superadmin']);const directory=resolve(options.dataDir||'data','backups');await mkdir(directory,{recursive:true});
        const filename=`backup-${Date.now()}-${randomBytes(3).toString('hex')}.sqlite`,target=join(directory,filename);
        store.audit(a.name,'导出数据库备份','',{filename},ip);
        await backup(store.db,target);
        const raw=await readFile(target);await rm(target);return download(raw,filename,'application/vnd.sqlite3');
      }
      if(path.startsWith('/api/')) fail(404,'接口不存在');
      if(method!=='GET') fail(405,'请求方式不支持');
      const relative=path==='/'?'index.html':path==='/book'?'book.html':decodeURIComponent(path.slice(1));
      const filename=resolve(PUBLIC,relative);
      if(!filename.startsWith(resolve(PUBLIC)+sep) || !TYPES[extname(filename)]) fail(404,'页面不存在');
      let data;try{data=await readFile(filename);}catch{fail(404,'页面不存在');}
      res.writeHead(200,{'Content-Type':TYPES[extname(filename)],'Cache-Control':'no-cache'});res.end(data);
    } catch(e) {
      if(res.headersSent){res.end();return;}
      if(e instanceof AppError) return send({error:e.message,code:e.code},e.status,e.status===429?{'Retry-After':'60'}:{});
      if(e instanceof URIError)return send({error:'请求地址编码无效',code:'INVALID_URL'},400);
      if(e.code==='ERR_SQLITE_ERROR' && /UNIQUE constraint/.test(e.message)) return send({error:'该账号、手机号或记录已存在',code:'CONFLICT'},409);
      console.error('Request failed:',method,path,e.message);
      send({error:'服务暂不可用，请稍后重试',code:'INTERNAL_ERROR'},500);
    }
  });
  server.requestTimeout=15000;server.headersTimeout=16000;server.keepAliveTimeout=5000;
  server.on('close',()=>{clearInterval(timer);clearInterval(maintenance);bookings?.close();});
  return {server,reminders};
}
