'use strict';
/* ============================================================
   ШинаСервис — сервер с БД SQLite (единый источник данных).

   Запуск:  node server/server.js            (порт 3000)
   или      PORT=8080 node server/server.js
   Требования: Node.js >= 22.5 (встроенный модуль node:sqlite),
   внешних зависимостей нет.

   Что делает:
   - отдаёт сайт (../index.html) по http://localhost:PORT/;
   - хранит все данные (услуги, настройки, сотрудники, записи)
     в SQLite: server/data/shina.db — переживает перезапуски;
   - публичный сайт читает обезличенную копию (GET /api/state):
     без пароля, ПИН-кодов и данных клиентов;
   - клиент создаёт записи через POST /api/bookings, личный
     кабинет — GET /api/my и POST /api/booking-op;
   - сотрудник/админ после единого входа (код доступа) читают и
     пишут полную базу: GET/POST /api/db — так данные видны на
     всех устройствах, а не только в одном браузере.

   Безопасность: запускайте сервер в доверенной сети или за
   reverse-proxy с HTTPS; пароль/ПИН-коды хранятся в БД —
   смените демо-пароль admin123 в настройках админки.
   ============================================================ */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = path.join(__dirname, 'data', 'shina.db');
const ROOT = path.join(__dirname, '..');
const INDEX = path.join(ROOT, 'index.html');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS state(
  id INTEGER PRIMARY KEY CHECK(id=1),
  json TEXT NOT NULL,
  updated INTEGER NOT NULL
);`);
const selState = db.prepare('SELECT json, updated FROM state WHERE id=1');
const putState = db.prepare(
  'INSERT INTO state(id,json,updated) VALUES(1,?,?) ' +
  'ON CONFLICT(id) DO UPDATE SET json=excluded.json, updated=excluded.updated');

function readState() {
  const r = selState.get();
  return r ? { db: JSON.parse(r.json), updated: r.updated } : null;
}
function writeState(d) {
  const updated = Date.now();
  putState.run(JSON.stringify(d), updated);
  return updated;
}
if (!readState()) console.log('БД пуста — инициализируется при первом открытии сайта.');

/* --- публичная копия: без секретов и личных данных клиентов --- */
function redact(d) {
  const s = d.settings || {};
  return {
    settings: {
      companyName: s.companyName, phone: s.phone, address: s.address, ipTitle: s.ipTitle || '',
      workDays: s.workDays, workStart: s.workStart, workEnd: s.workEnd,
      interval: s.interval, posts: s.posts, blockedDates: s.blockedDates || [],
      stats: s.stats || [], shiftStart: s.shiftStart, shiftFirst: s.shiftFirst,
      shiftOverrides: s.shiftOverrides || {}, smsChannel: s.smsChannel, panelSlug: s.panelSlug || 'panel',
      employees: (s.employees || []).map(e => ({
        id: e.id, name: e.name, color: e.color, active: e.active, flex: e.flex
      }))
    },
    services: d.services || [],
    bookings: (d.bookings || []).map(b => ({
      code: b.code, date: b.date, time: b.time, employeeId: b.employeeId || null,
      empAuto: b.empAuto !== false, status: b.status, total: b.total || 0,
      services: b.services || [], source: b.source || 'online', createdAt: b.createdAt || 0
    }))
  };
}

function verifyCode(d, code) {
  const c = String(code || '').trim();
  if (!c) return null;
  if (c === d.settings.adminPass) return 'admin';
  const e = (d.settings.employees || []).find(e => e.active && e.pin === c);
  return e ? e.id : null;
}

/* --- авторизация по телефону + SMS/MAX-код (клиенты и персонал) --- */
const crypto = require('node:crypto');
const authCodes = new Map(); // digits -> {code, exp, tries, role|null}
const tokens = new Map();    // token -> {role, exp}
const digitsOf = p => String(p || '').replace(/\D/g, '');
const TOKEN_TTL = 7 * 864e5;

function sendAuthCode(s, phone, text) {
  const url = String(s.smsWebhook || '').trim();
  if (!url) return Promise.resolve(false);
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: s.smsChannel === 'max' ? 'max' : 'sms', phone, text, code: '', kind: 'auth' })
  }).then(r => r.ok).catch(() => false);
}
function checkToken(t) {
  const tk = tokens.get(String(t || ''));
  if (tk && tk.exp > Date.now() && tk.role !== 'client') return tk.role;
  return null;
}
function panelRole(d, phone) {
  const ph = digitsOf(phone);
  if (digitsOf(d.settings.adminPhone) === ph) return 'admin';
  const e = (d.settings.employees || []).find(e => digitsOf(e.phone) === ph && e.active);
  return e ? String(e.id) : null;
}
/* полный доступ: ПИН/пароль или токен после входа по телефону */
function fullRole(st, u, body) {
  const bodyTok = body && body.token ? body.token : null;
  const role = checkToken(bodyTok) || checkToken(u.searchParams.get('token'));
  if (role) return role;
  return verifyCode(st.db, body && body.code ? body.code : u.searchParams.get('code'));
}

const STS = ['new', 'confirmed', 'done', 'cancelled'];
const ALLOWED = ['status', 'notices', 'date', 'time', 'services', 'total',
  'car', 'plate', 'comment', 'employeeId', 'empAuto', 'source'];

function slotFree(d, date, time, exceptCode) {
  return !d.bookings.some(b => b.date === date && b.time === time &&
    b.status !== 'cancelled' && b.code !== exceptCode);
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};
function send(res, code, obj) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS));
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '', n = 0;
    req.on('data', c => {
      n += c.length;
      if (n > 5 * 1024 * 1024) { reject(new Error('too large')); req.destroy(); }
      else s += c;
    });
    req.on('end', () => resolve(s));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
  try {
    if (p === '/api/ping') return send(res, 200, { ok: true, initialized: !!readState() });

    const st = readState();

    /* --- публичные эндпоинты --- */
    if (p === '/api/state') {
      if (!st) return send(res, 200, { ok: true, empty: true });
      return send(res, 200, { ok: true, updated: st.updated, db: redact(st.db) });
    }
    if (p === '/api/init' && req.method === 'POST') {
      if (st) return send(res, 409, { ok: false, err: 'initialized' });
      const body = JSON.parse(await readBody(req) || '{}');
      if (!body.db || !body.db.settings || !Array.isArray(body.db.bookings))
        return send(res, 400, { ok: false, err: 'bad' });
      const updated = writeState(body.db);
      console.log('БД инициализирована демо-данными сайта.');
      return send(res, 200, { ok: true, updated, db: redact(body.db) });
    }
    if (p === '/api/my') {
      if (!st) return send(res, 200, { ok: true, bookings: [] });
      const digits = String(u.searchParams.get('phone') || '').replace(/\D/g, '');
      const bookings = st.db.bookings
        .filter(b => String(b.phone || '').replace(/\D/g, '') === digits)
        .sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
      return send(res, 200, { ok: true, bookings });
    }
    if (p === '/api/auth/request' && req.method === 'POST') {
      if (!st) return send(res, 409, { ok: false, err: 'empty' });
      const body = JSON.parse(await readBody(req) || '{}');
      const ph = digitsOf(body.phone);
      if (ph.length !== 11) return send(res, 400, { ok: false, err: 'badphone' });
      const purpose = body.purpose === 'panel' ? 'panel' : 'client';
      let role = null;
      if (purpose === 'panel') {
        role = panelRole(st.db, ph);
        if (!role) return send(res, 403, { ok: false, err: 'notstaff' });
      }
      const code = String(Math.floor(100000 + Math.random() * 900000));
      authCodes.set(ph, { code, exp: Date.now() + 5 * 60000, tries: 0, role });
      const delivered = await sendAuthCode(st.db.settings, ph,
        st.db.settings.companyName + ': код входа ' + code + '. Никому его не сообщайте.');
      if (delivered) console.log('Код входа отправлен:', ph.slice(0, 4) + '***' + ph.slice(-2));
      return send(res, 200, { ok: true, delivered, demo: !delivered, role, code: delivered ? '' : code });
    }
    if (p === '/api/auth/verify' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const ph = digitsOf(body.phone);
      const c = authCodes.get(ph);
      if (!c || c.exp < Date.now()) return send(res, 200, { ok: false, err: 'nocode' });
      if (c.tries >= 5) { authCodes.delete(ph); return send(res, 200, { ok: false, err: 'tries' }); }
      if (String(body.code || '').trim() !== c.code) { c.tries++; return send(res, 200, { ok: false, err: 'wrong' }); }
      authCodes.delete(ph);
      const role = c.role || 'client';
      const token = crypto.randomUUID();
      tokens.set(token, { role, exp: Date.now() + TOKEN_TTL });
      if (role !== 'client') console.log('Вход по телефону:', ph.slice(0, 4) + '***' + ph.slice(-2), '→', role === 'admin' ? 'админ' : 'сотрудник');
      return send(res, 200, { ok: true, token, role });
    }
    if (p === '/api/bookings' && req.method === 'POST') {
      if (!st) return send(res, 409, { ok: false, err: 'empty' });
      const body = JSON.parse(await readBody(req) || '{}');
      const b = body.booking || {};
      if (!b.code || !b.name || !b.phone || !b.date || !b.time ||
          !Array.isArray(b.services) || !b.services.length)
        return send(res, 400, { ok: false, err: 'bad' });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date) || b.date < new Date().toISOString().slice(0, 10))
        return send(res, 400, { ok: false, err: 'date' });
      if (st.db.bookings.some(x => x.code === b.code))
        return send(res, 200, { ok: false, err: 'code' });
      if (!slotFree(st.db, b.date, b.time)) return send(res, 200, { ok: false, err: 'slot' });
      st.db.bookings.push(Object.assign(
        { status: 'new', empAuto: true, source: 'online', createdAt: Date.now(), notices: [] }, b));
      const updated = writeState(st.db);
      console.log('Новая запись из сайта:', b.code, b.date, b.time);
      return send(res, 200, { ok: true, updated, db: redact(st.db) });
    }
    if (p === '/api/booking-op' && req.method === 'POST') {
      if (!st) return send(res, 409, { ok: false, err: 'empty' });
      const body = JSON.parse(await readBody(req) || '{}');
      const b = st.db.bookings.find(x => x.code === String(body.code || ''));
      if (!b) return send(res, 404, { ok: false, err: 'nobooking' });
      const patch = body.patch || {};
      const nD = patch.date || b.date, nT = patch.time || b.time;
      if ((patch.date && patch.date !== b.date) || (patch.time && patch.time !== b.time)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(nD)) return send(res, 400, { ok: false, err: 'date' });
        if (!slotFree(st.db, nD, nT, b.code)) return send(res, 200, { ok: false, err: 'slot' });
      }
      ALLOWED.forEach(k => {
        if (patch[k] === undefined) return;
        if (k === 'status' && !STS.includes(patch[k])) return;
        b[k] = patch[k];
      });
      const updated = writeState(st.db);
      return send(res, 200, { ok: true, updated, db: redact(st.db) });
    }

    /* --- доступ сотрудника/админа: полный дамп БД по ПИН/паролю или токену входа --- */
    if (p === '/api/db' && req.method === 'GET') {
      if (!st) return send(res, 200, { ok: true, empty: true });
      const role = fullRole(st, u, null);
      if (!role) return send(res, 403, { ok: false, err: 'badcode' });
      return send(res, 200, { ok: true, updated: st.updated, db: st.db, role });
    }
    if (p === '/api/db' && req.method === 'POST') {
      if (!st) return send(res, 409, { ok: false, err: 'empty' });
      const body = JSON.parse(await readBody(req) || '{}');
      const role = fullRole(st, u, body);
      if (!role) return send(res, 403, { ok: false, err: 'badcode' });
      if (!body.db || !body.db.settings || !Array.isArray(body.db.bookings))
        return send(res, 400, { ok: false, err: 'bad' });
      const updated = writeState(body.db);
      return send(res, 200, { ok: true, updated, role });
    }

    /* --- сайт: 5 статических страниц из корня репозитория --- */
    if (req.method === 'GET') {
      const PAGES = { '/': 'index.html', '/index.html': 'index.html', '/cabinet.html': 'cabinet.html',
        '/panel.html': 'panel.html', '/admin.html': 'admin.html', '/staff.html': 'staff.html' };
      const file = PAGES[p];
      if (file) {
        try {
          const html = fs.readFileSync(path.join(ROOT, file));
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
          return;
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(file + ' не найден — соберите сайт: python3 src/build_site.py src/site_parts .');
          return;
        }
      }
    }
    send(res, 404, { ok: false, err: 'notfound' });
  } catch (e) {
    send(res, 500, { ok: false, err: 'server', message: String((e && e.message) || e) });
  }
});

server.listen(PORT, () => {
  console.log('ШинаСервис запущен: http://localhost:' + PORT + '  (БД: ' + DB_PATH + ')');
});
