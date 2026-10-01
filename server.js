import express from 'express';
import multer from 'multer';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import ffmpeg from 'ffmpeg-static';
import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const { TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME, GOOGLE_CLIENT_ID, JWT_SECRET, ADMIN_KEY,
  ADMIN_CHAT_ID, BASE_URL = '', DATA_DIR = './data', PORT = 3000 } = process.env;
if (!JWT_SECRET || !ADMIN_KEY) throw new Error('Задай JWT_SECRET и ADMIN_KEY');

// ---------- хранилище (JSON-файл + папки на диске) ----------
for (const d of ['previews', 'full', 'tmp']) fs.mkdirSync(path.join(DATA_DIR, d), { recursive: true });
const dbFile = path.join(DATA_DIR, 'db.json');
const db = fs.existsSync(dbFile) ? JSON.parse(fs.readFileSync(dbFile, 'utf8')) : { users: {}, beats: [], orders: [] };
const save = () => fs.writeFileSync(dbFile, JSON.stringify(db));

const PLANS = { pro: { name: 'Pro', limit: 10 }, promax: { name: 'Pro Max', limit: Infinity } };
const DAY = 864e5;
const active = u => !!(u && u.plan && u.planUntil > Date.now());
const pubUser = u => ({ id: u.id, name: u.name, provider: u.provider, plan: active(u) ? u.plan : null, planUntil: u.planUntil });
const pubBeat = b => ({ id: b.id, title: b.title, genre: b.genre, bpm: b.bpm, uah: b.uah,
  by: (db.users[b.userId]?.name || 'продавец') + (b.tier === 'promax' ? ' ★' : ''), audio: `/previews/${b.id}.mp3` });

// ---------- сессии ----------
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }), cookieParser());
app.use((req, _res, next) => {
  try { req.user = db.users[jwt.verify(req.cookies.s, JWT_SECRET).id]; } catch { /* гость */ }
  next();
});
const need = (req, res, next) => req.user ? next() : res.status(401).json({ error: 'Сначала войди в аккаунт' });
function login(res, id, name, provider, email) {
  const u = db.users[id] ||= { id, plan: null, planUntil: 0 };
  Object.assign(u, { name, provider, email: email || u.email });
  save();
  res.cookie('s', jwt.sign({ id }, JWT_SECRET, { expiresIn: '30d' }),
    { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 30 * DAY });
  res.json({ user: pubUser(u) });
}

app.get('/api/config', (_q, r) => r.json({ googleClientId: GOOGLE_CLIENT_ID || '', telegramBot: TELEGRAM_BOT_USERNAME || '' }));
app.get('/api/me', (q, r) => r.json({ user: q.user ? pubUser(q.user) : null }));
app.post('/api/logout', (_q, r) => { r.clearCookie('s'); r.json({ ok: true }); });

// Вход через Google: проверяем подпись токена на сервере
const gClient = new OAuth2Client(GOOGLE_CLIENT_ID);
app.post('/api/auth/google', async (req, res) => {
  try {
    const t = await gClient.verifyIdToken({ idToken: String(req.body.credential), audience: GOOGLE_CLIENT_ID });
    const p = t.getPayload();
    login(res, 'g:' + p.sub, p.name || p.email, 'google', p.email);
  } catch { res.status(401).json({ error: 'Google не подтвердил вход' }); }
});

// Вход через Telegram: проверяем HMAC по токену бота (токен хранится только на сервере)
function tgValid(d) {
  const { hash, ...rest } = d;
  if (!hash || !TELEGRAM_BOT_TOKEN) return false;
  const str = Object.keys(rest).sort().map(k => `${k}=${rest[k]}`).join('\n');
  const key = crypto.createHash('sha256').update(TELEGRAM_BOT_TOKEN).digest();
  const h = crypto.createHmac('sha256', key).update(str).digest('hex');
  return h.length === String(hash).length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(String(hash)))
    && Date.now() / 1000 - Number(rest.auth_date) < 86400;
}
app.post('/api/auth/telegram', (req, res) => {
  const d = req.body || {};
  if (!tgValid(d)) return res.status(401).json({ error: 'Telegram не подтвердил вход' });
  login(res, 'tg:' + d.id, [d.first_name, d.last_name].filter(Boolean).join(' ') || d.username || 'Telegram', 'telegram');
});

// ---------- превью: ищем самые громкие 10 секунд ----------
const run = args => new Promise((ok, no) => {
  const p = spawn(ffmpeg, args), out = [];
  p.stdout.on('data', c => out.push(c));
  p.on('error', no);
  p.on('close', c => c === 0 ? ok(Buffer.concat(out)) : no(new Error('ffmpeg ' + c)));
});
async function makePreview(src, dst) {
  const raw = await run(['-v', 'error', '-i', src, '-ac', '1', '-ar', '8000', '-f', 's16le', '-']);
  const n = 2000, k = Math.floor(raw.length / 2 / n), e = [], w = 40;   // кадр 0.25 с, окно 10 с
  for (let i = 0; i < k; i++) { let s = 0; for (let j = 0; j < n; j++) { const v = raw.readInt16LE((i * n + j) * 2); s += v * v; } e.push(s); }
  let best = 0;
  if (k > w) {
    let cur = e.slice(0, w).reduce((a, b) => a + b, 0), top = cur;
    for (let i = 1; i + w <= k; i++) { cur += e[i + w - 1] - e[i - 1]; if (cur > top) { top = cur; best = i; } }
  }
  await run(['-y', '-v', 'error', '-ss', String(best * 0.25), '-t', '10', '-i', src, '-ac', '1', '-ar', '32000', '-b:a', '64k',
    '-af', 'afade=t=in:d=0.3,afade=t=out:st=9.2:d=0.8', dst]);
}

// ---------- биты ----------
app.use('/previews', express.static(path.join(DATA_DIR, 'previews'), { maxAge: '7d' }));
app.get('/api/beats', (_q, r) => {
  const list = db.beats.filter(b => active(db.users[b.userId]))
    .sort((a, b) => (b.tier === 'promax') - (a.tier === 'promax') || b.id - a.id);
  r.json(list.map(pubBeat));
});
const upload = multer({ dest: path.join(DATA_DIR, 'tmp'), limits: { fileSize: 40 * 1024 * 1024 } });
app.post('/api/beats', need, upload.single('audio'), async (req, res) => {
  const f = req.file, u = req.user;
  const fail = (code, error) => { if (f) fs.rm(f.path, () => {}); res.status(code).json({ error }); };
  if (!active(u)) return fail(402, 'Нужна активная подписка Pro или Pro Max');
  if (db.beats.filter(b => b.userId === u.id).length >= PLANS[u.plan].limit) return fail(403, 'Лимит битов на твоём тарифе. Перейди на Pro Max');
  const title = String(req.body.title || '').trim().slice(0, 80), uah = Math.round(Number(req.body.uah));
  if (!f || !title || !(uah >= 50 && uah <= 100000)) return fail(400, 'Укажи название, цену (50–100000 ₴) и файл');
  if (!/\.(mp3|wav|m4a|ogg)$/i.test(f.originalname)) return fail(400, 'Нужен аудиофайл mp3, wav, m4a или ogg');
  const id = Date.now();
  try {
    await makePreview(f.path, path.join(DATA_DIR, 'previews', id + '.mp3'));
    fs.renameSync(f.path, path.join(DATA_DIR, 'full', id + path.extname(f.originalname).toLowerCase()));
  } catch { return fail(422, 'Не удалось обработать аудио. Попробуй другой файл'); }
  const b = { id, userId: u.id, tier: u.plan, title, uah, bpm: Number(req.body.bpm) || 0,
    genre: String(req.body.genre || 'Trap').slice(0, 20) };
  db.beats.push(b); save();
  res.json(pubBeat(b));
});

// ---------- заказы и заявки на подписку ----------
async function notify(text) {
  if (!TELEGRAM_BOT_TOKEN || !ADMIN_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: ADMIN_CHAT_ID, text }) });
  } catch { /* уведомление не критично */ }
}
app.post('/api/order', need, (req, res) => {
  const { contact, items, sum, cur, plan } = req.body || {};
  if (!/^(@?[A-Za-z0-9_]{5,32}|[^\s@]+@[^\s@]+\.[^\s@]+)$/.test(String(contact || ''))) return res.status(400).json({ error: 'Укажи почту или Telegram' });
  if (plan && !PLANS[plan]) return res.status(400).json({ error: 'Неизвестный тариф' });
  const o = { id: Date.now(), userId: req.user.id, userName: req.user.name, contact: String(contact),
    items: (Array.isArray(items) ? items : []).slice(0, 30).map(s => String(s).slice(0, 80)),
    sum: String(sum || '').slice(0, 20), cur: String(cur || '').slice(0, 3), plan: plan || null, status: 'pending', at: Date.now() };
  db.orders.push(o); save();
  notify(`${o.plan ? 'Подписка ' + PLANS[o.plan].name : 'Заказ'}: ${o.sum}\nПокупатель: ${o.userName} (${o.userId})\nКонтакт: ${o.contact}\n${o.items.join(', ')}\nАдминка: ${BASE_URL}/admin`);
  res.json({ ok: true });
});

// ---------- админка ----------
const adm = (req, res, next) => req.headers['x-admin-key'] === ADMIN_KEY ? next() : res.sendStatus(403);
app.get('/admin/api/orders', adm, (_q, r) => r.json([...db.orders].reverse().slice(0, 200)));
app.post('/admin/api/done', adm, (req, res) => {
  const o = db.orders.find(x => x.id === req.body.id);
  if (!o) return res.sendStatus(404);
  if (o.plan && o.status === 'pending') {
    const u = db.users[o.userId];
    if (u) { u.plan = o.plan; u.planUntil = Math.max(Date.now(), u.planUntil || 0) + 30 * DAY; }
  }
  o.status = 'done'; save(); res.json({ ok: true });
});
app.get('/admin', (_q, r) => r.sendFile(path.resolve('public/admin.html')));

app.use(express.static('public'));
app.listen(PORT, () => console.log('BEATSHOP on :' + PORT));
