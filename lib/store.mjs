import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID, randomBytes, scryptSync, createHash } from 'node:crypto';

export class AppError extends Error {
  constructor(status, message, code = 'INVALID_REQUEST') { super(message); this.status = status; this.code = code; }
}
export const fail = (status, message, code) => { throw new AppError(status, message, code); };
export const tokenHash = token => createHash('sha256').update(token).digest('hex');
export function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export const roles = ['superadmin', 'operator', 'verifier', 'readonly'];
export const DEFAULT_SETTINGS = {
  store_name: '山屿快闪', booking_limit: 30, login_limit: 20, user_login_limit: 2000,
  template_id: '', reminder_minutes: 10,
  template_name_key: 'thing1', template_time_key: 'time2', template_location_key: 'thing3',
};

export function openStore(filename, options = {}) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS admins (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      password TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('superadmin','operator','verifier','readonly')),
      enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, openid TEXT NOT NULL UNIQUE, nickname TEXT NOT NULL,
      phone TEXT UNIQUE, blocked INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY, principal_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('admin','user')),
      expires_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS auth_principal ON auth_sessions(principal_id);
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, location TEXT NOT NULL, notices TEXT NOT NULL,
      banner TEXT NOT NULL DEFAULT '', theme TEXT NOT NULL DEFAULT 'forest',
      release_at INTEGER NOT NULL, starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('draft','published','ended')), per_limit INTEGER NOT NULL CHECK(per_limit BETWEEN 1 AND 10),
      demo INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS slots (
      id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id), label TEXT NOT NULL,
      starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL,
      total INTEGER NOT NULL CHECK(total>=0), sold INTEGER NOT NULL DEFAULT 0 CHECK(sold>=0),
      locked INTEGER NOT NULL DEFAULT 0 CHECK(locked>=0), paused INTEGER NOT NULL DEFAULT 0,
      next_number INTEGER NOT NULL DEFAULT 0, CHECK(total>=sold+locked));
    CREATE INDEX IF NOT EXISTS slots_event ON slots(event_id);
    CREATE TABLE IF NOT EXISTS reservations (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), event_id TEXT NOT NULL REFERENCES events(id),
      slot_id TEXT NOT NULL REFERENCES slots(id), phone TEXT NOT NULL,
      ordinal INTEGER NOT NULL, number INTEGER NOT NULL, code TEXT NOT NULL UNIQUE,
      request_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved','redeemed')),
      created_at INTEGER NOT NULL, redeemed_at INTEGER,
      UNIQUE(event_id,user_id,ordinal), UNIQUE(event_id,phone,ordinal), UNIQUE(slot_id,number), UNIQUE(user_id,request_key));
    CREATE INDEX IF NOT EXISTS reservation_time ON reservations(created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS reservation_event_number ON reservations(event_id,number);
    CREATE TABLE IF NOT EXISTS redemptions (
      id TEXT PRIMARY KEY, reservation_id TEXT NOT NULL REFERENCES reservations(id),
      actor_id TEXT NOT NULL REFERENCES admins(id), actor_name TEXT NOT NULL, action TEXT NOT NULL,
      device TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL,
      target TEXT NOT NULL, detail TEXT NOT NULL, ip TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), event_id TEXT NOT NULL REFERENCES events(id),
      status TEXT NOT NULL DEFAULT 'pending', error TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, sent_at INTEGER, UNIQUE(user_id,event_id));
    CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_at INTEGER NOT NULL);
    PRAGMA user_version=1;
  `);
  const store = {
    filename,
    db,
    get(sql, ...args) { return db.prepare(sql).get(...args); },
    all(sql, ...args) { return db.prepare(sql).all(...args); },
    run(sql, ...args) { return db.prepare(sql).run(...args); },
    tx(fn) {
      db.exec('BEGIN IMMEDIATE');
      try { const value = fn(); db.exec('COMMIT'); return value; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    audit(actor, action, target = '', detail = {}, ip = '') {
      this.run('INSERT INTO audit(actor,action,target,detail,ip,created_at) VALUES(?,?,?,?,?,?)',
        actor, action, target, JSON.stringify(detail), ip, Date.now());
    },
    settings() {
      return { ...DEFAULT_SETTINGS, ...Object.fromEntries(this.all('SELECT * FROM settings').map(r => [r.key, JSON.parse(r.value)])) };
    },
    session(id, kind) {
      const token = randomBytes(32).toString('base64url');
      this.run('INSERT INTO auth_sessions VALUES(?,?,?,?)', tokenHash(token), id, kind, Date.now() + (kind === 'admin' ? 8 : 168) * 3600000);
      return token;
    },
    rate(key, limit, window = 60000) {
      const now = Date.now();
      // A durable, atomic counter also applies when multiple processes share this database.
      const r = rateDb.prepare(`INSERT INTO rate_limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET
        count=CASE WHEN window_at<=? THEN 1 ELSE count+1 END,
        window_at=CASE WHEN window_at<=? THEN excluded.window_at ELSE window_at END RETURNING count`)
        .get(key, now, now-window, now-window);
      if (r.count > limit) fail(429, '操作过于频繁，请稍后重试', 'RATE_LIMITED');
    },
    close() { if(rateDb!==db)rateDb.close();db.close(); },
    maintain(now=Date.now()) {
      return this.tx(()=>({sessions:this.run('DELETE FROM auth_sessions WHERE expires_at<=?',now).changes,
        counters:this.run('DELETE FROM rate_limits WHERE window_at<?',now-86400000).changes}));
    },
  };
  // Rate counters are not booking records. Use NORMAL on a separate connection
  // so 900 rejected requests do not each force a disk fsync. Booking commits keep
  // synchronous=FULL, while rate counters remain shared and atomic across workers.
  const rateDb=filename===':memory:'?db:new DatabaseSync(filename);
  if(rateDb!==db)rateDb.exec('PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000');
  if (!store.get('SELECT id FROM admins LIMIT 1')) {
    if (!options.password) fail(500, '首次启动请设置 FLASH_ADMIN_PASSWORD（至少 12 位）');
    store.run('INSERT INTO admins VALUES(?,?,?,?,?,?,?)', randomUUID(), options.username || 'admin', '门店管理员', passwordHash(options.password), 'superadmin', 1, Date.now());
  }
  return store;
}

export function phase(event, now = Date.now()) {
  if (event.state === 'draft') return 'draft';
  if (event.state === 'ended' || now >= event.ends_at) return 'ended';
  return now < event.release_at ? 'upcoming' : 'live';
}
export function eventView(store, event, publicView = false) {
  const slots = store.all('SELECT * FROM slots WHERE event_id=? ORDER BY starts_at,id', event.id).map(s => ({
    ...s, available: Math.max(0, s.total - s.sold - s.locked),
    has_stock: phase(event) === 'live' && !s.paused && s.total>s.sold+s.locked && Date.now()<s.ends_at,
  }));
  const view = { ...event, phase: phase(event), slots,
    total: slots.reduce((n,s)=>n+s.total,0), sold: slots.reduce((n,s)=>n+s.sold,0),
    locked: slots.reduce((n,s)=>n+s.locked,0), available: slots.reduce((n,s)=>n+s.available,0),
    has_stock: slots.some(s=>s.has_stock), server_now: Date.now(),
  };
  if (publicView) delete view.created_at;
  return view;
}

export function reserve(store, user, data, ip = '') {
  if(typeof data.slot_id!=='string'||!/^[-A-Za-z0-9_]{1,100}$/.test(data.slot_id))fail(400,'场次标识无效');
  if (typeof data.request_key !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(data.request_key)) fail(400, '预约请求标识无效');
  return store.tx(() => {
    const fresh = store.get('SELECT * FROM users WHERE id=?', user.id);
    if (!fresh || fresh.blocked) fail(403, '此账号已被限制预约', 'BLOCKED');
    if (!fresh.phone) fail(400, '请先授权手机号', 'PHONE_REQUIRED');
    const existing = store.get('SELECT * FROM reservations WHERE user_id=? AND request_key=?', user.id, data.request_key);
    if (existing) {
      if (existing.slot_id !== data.slot_id) fail(409, '该请求标识已用于其他场次');
      return { ...existing, replayed: true };
    }
    const slot = store.get('SELECT * FROM slots WHERE id=?', data.slot_id || '');
    if (!slot) fail(404, '场次不存在');
    const event = store.get('SELECT * FROM events WHERE id=?', slot.event_id);
    if (phase(event) !== 'live' || Date.now() >= slot.ends_at) fail(409, '当前不在预约时间内', 'NOT_OPEN');
    if (slot.paused) fail(409, '当前场次已暂停放号', 'PAUSED');
    const count = store.get('SELECT COUNT(*) AS n FROM reservations WHERE event_id=? AND (user_id=? OR phone=?)', event.id, user.id, fresh.phone).n;
    if (count >= event.per_limit) fail(409, '已达到本活动每人预约上限', 'LIMIT_REACHED');
    const allocated = store.get(`UPDATE slots SET sold=sold+1,next_number=next_number+1
      WHERE id=? AND paused=0 AND total-sold-locked>0 RETURNING next_number`, slot.id);
    if (!allocated) fail(409, '本场号源已抢完', 'SOLD_OUT');
    const record = { id: randomUUID(), user_id: user.id, event_id: event.id, slot_id: slot.id,
      phone: fresh.phone, ordinal: count+1,
      number: store.get('SELECT COALESCE(MAX(number),0)+1 AS next FROM reservations WHERE event_id=?',event.id).next,
      code: randomBytes(10).toString('hex').toUpperCase(), request_key: data.request_key,
      status: 'reserved', created_at: Date.now(), redeemed_at: null };
    store.run('INSERT INTO reservations VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', ...Object.values(record));
    store.audit(user.id, '预约成功', record.id, { event: event.name, slot: slot.label, number: record.number }, ip);
    return record;
  });
}

export function redeem(store, actor, data, undo = false, ip = '') {
  const code = String(data.code || '').replace(/[\s-]/g,'').toUpperCase();
  if (!/^[A-F0-9]{20}$/.test(code)) fail(400, '请输入完整的 20 位购买码');
  if (undo && (!data.reason || String(data.reason).trim().length < 2)) fail(400, '撤销核销需填写原因');
  return store.tx(() => {
    const record = store.get('SELECT * FROM reservations WHERE code=?', code);
    if (!record) fail(404, '购买码不存在', 'CODE_NOT_FOUND');
    if (record.status === (undo ? 'reserved' : 'redeemed')) fail(409, undo ? '该购买码尚未核销' : '该购买码已核销，请勿重复操作', 'ALREADY_PROCESSED');
    const device = String(data.device || '管理后台').slice(0,120);
    store.run('UPDATE reservations SET status=?,redeemed_at=? WHERE id=?', undo?'reserved':'redeemed', undo?null:Date.now(), record.id);
    store.run('INSERT INTO redemptions VALUES(?,?,?,?,?,?,?,?)', randomUUID(), record.id, actor.id, actor.name,
      undo?'撤销核销':'核销', device, String(data.reason || '').slice(0,500), Date.now());
    store.audit(actor.name, undo?'撤销核销':'核销购买码', record.id, { device, reason: data.reason || '' }, ip);
    return { ...record, status: undo?'reserved':'redeemed' };
  });
}

export function seedDemo(store) {
  if (store.get('SELECT id FROM events LIMIT 1')) return;
  const now = Date.now();
  const examples = [
    ['周末见面计划 · 秋日快闪', 'forest', now-3600000, now+86400000, now+2*86400000, 'published', 100],
    ['城市漫游 · 限定好物集', 'clay', now+86400000, now+2*86400000, now+3*86400000, 'published', 80],
    ['一间周末商店 · 冬日预告', 'blue', now+3*86400000, now+4*86400000, now+5*86400000, 'draft', 120],
  ];
  store.tx(()=> {
    for (const [name,theme,release,starts,ends,state,total] of examples) {
      const id = randomUUID();
      store.run('INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', id, name, '山屿生活方式店 · 一层快闪空间',
        '请在预约时段内到店，出示购买码核销。每人限约 1 个名额；购买码仅限本人使用。此为本地演示活动。', '', theme,
        release, starts, ends, state, 1, 1, now);
      store.run('INSERT INTO slots(id,event_id,label,starts_at,ends_at,total) VALUES(?,?,?,?,?,?)', randomUUID(), id, '首场 · 自由入场', starts, ends, total);
    }
    store.audit('系统', '初始化演示活动', '', { notice: '仅演示活动，不包含虚构预约数据' });
  });
}
