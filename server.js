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
  ADMIN_CHAT_ID, BASE_URL = '', DATA_DIR = './data', PORT = 3000, RESEND_API_KEY, MONO_TOKEN, MONO_SECRET,
  MAIL_TO = 'beatshop228@gmail.com', MAIL_FROM = 'BEATSHOP <onboarding@resend.dev>' } = process.env;
if (!JWT_SECRET || !ADMIN_KEY) throw new Error('Задай JWT_SECRET и ADMIN_KEY');

// ---------- хранилище (JSON-файл + папки на диске) ----------
for (const d of ['previews', 'full', 'tmp']) fs.mkdirSync(path.join(DATA_DIR, d), { recursive: true });
const dbFile = path.join(DATA_DIR, 'db.json');
const db = fs.existsSync(dbFile) ? JSON.parse(fs.readFileSync(dbFile, 'utf8')) : { users: {}, beats: [], orders: [] };
const save = () => fs.writeFileSync(dbFile, JSON.stringify(db));

const CATALOG = JSON.parse(fs.readFileSync(new URL('./catalog.json', import.meta.url), 'utf8'));
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

app.get('/api/config', (_q, r) => r.json({ googleClientId: GOOGLE_CLIENT_ID || '', telegramBot: TELEGRAM_BOT_USERNAME || '', uahPerUsd: RATE }));
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
  if (req.body.rights !== '1') return fail(400, 'Подтверди, что ты автор бита и имеешь право его продавать');
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
const RATE = Number(process.env.UAH_PER_USD) || 44.68;
const PLAN_UAH = { pro: 500, promax: 1000 };
const conv = (u, cur) => cur === 'RUB' ? Math.round(u * 1.5 / 5) * 5 : cur === 'USD' ? Math.max(1, Math.round(u / RATE)) : u;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mine = (req) => db.orders.find(x => x.id === Number(req.params.id) && x.userId === req.user.id);

async function mail(subject, html) {
  if (!RESEND_API_KEY) return;
  try {
    await fetch('https://api.resend.com/emails', { method: 'POST',
      headers: { authorization: 'Bearer ' + RESEND_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ from: MAIL_FROM, to: [MAIL_TO], subject, html }) });
  } catch { /* письмо не критично */ }
}
const orderText = o => `${o.plan ? 'Подписка ' + PLANS[o.plan].name : 'Заказ'} ${o.code}: ${o.amount} ${o.cur}\nПокупатель: ${o.userName} (${o.userId})\nКонтакт: ${o.contact}\n${o.items.join(', ')}`;
function notifyAdmin(title, o, withLink) {
  const link = withLink ? `${BASE_URL}/confirm?t=${jwt.sign({ oid: o.id }, JWT_SECRET, { expiresIn: '7d' })}` : '';
  notify(`${title}\n${orderText(o)}${link ? '\nПодтвердить оплату: ' + link : ''}`);
  mail(`BEATSHOP: ${title} ${o.code}`, `<p>${esc(title)}</p><pre>${esc(orderText(o))}</pre>${link ? `<p><a href="${link}">Проверить и подтвердить оплату</a></p>` : ''}<p><a href="${BASE_URL}/admin">Админка</a></p>`);
}
// Оплата подтверждена (автоматически, по ссылке из письма или в админке)
function settle(o, how) {
  if (o.status === 'paid' || o.status === 'done') return;
  o.status = o.plan ? 'done' : 'paid'; o.paidBy = how;
  const u = db.users[o.userId];
  if (o.plan && u) { u.plan = o.plan; u.planUntil = Math.max(Date.now(), u.planUntil || 0) + 30 * DAY; }
  save();
  notifyAdmin(`Оплата получена (${how})`, o, false);
}

// Заказ создаётся ДО оплаты: сервер сам считает сумму и выдаёт код для комментария
app.post('/api/order', need, (req, res) => {
  const { contact, ids, plan, cur, terms } = req.body || {};
  if (!terms || Number(terms.v) !== 1) return res.status(400).json({ error: 'Прими пользовательское соглашение' });
  if (!/^(@?[A-Za-z0-9_]{5,32}|[^\s@]+@[^\s@]+\.[^\s@]+)$/.test(String(contact || ''))) return res.status(400).json({ error: 'Укажи почту или Telegram' });
  if (!['UAH', 'RUB', 'USD'].includes(cur)) return res.status(400).json({ error: 'Неизвестная валюта' });
  if (db.orders.filter(x => x.userId === req.user.id && x.status === 'pending').length >= 10) return res.status(429).json({ error: 'Слишком много неоплаченных заказов' });
  let items = [], amount = 0;
  if (plan) {
    if (!PLANS[plan]) return res.status(400).json({ error: 'Неизвестный тариф' });
    items = ['Подписка ' + PLANS[plan].name + ' (30 дней)']; amount = conv(PLAN_UAH[plan], cur);
  } else {
    for (const id of (Array.isArray(ids) ? ids : []).slice(0, 30)) {
      const c = CATALOG[id], b = db.beats.find(x => x.id === Number(id));
      const t = c ? c.t : b?.title, u = c ? c.u : b?.uah;
      if (!t) return res.status(400).json({ error: 'Бит не найден, обнови страницу' });
      items.push(t); amount += conv(u, cur);
    }
    if (!items.length) return res.status(400).json({ error: 'Корзина пуста' });
  }
  let code; do code = 'BS-' + (1000 + crypto.randomInt(9000)); while (db.orders.some(x => x.code === code));
  const o = { id: Date.now(), code, userId: req.user.id, userName: req.user.name, contact: String(contact), items, amount, cur,
    plan: plan || null, status: 'pending', at: Date.now(),
    terms: { v: 1, at: String(terms.at || '').slice(0, 40), ip: req.ip } };
  db.orders.push(o); save();
  res.json({ id: o.id, code, amount, cur, autoMono: !!(MONO_TOKEN && MONO_SECRET) });
});
app.get('/api/order/:id', need, (req, res) => { const o = mine(req); o ? res.json({ status: o.status }) : res.sendStatus(404); });
// Для DonationAlerts и PayPal: покупатель нажал «Я оплатил(а)», тебе уходит письмо со ссылкой подтверждения
app.post('/api/order/:id/claim', need, (req, res) => {
  const o = mine(req);
  if (!o) return res.sendStatus(404);
  if (o.status === 'pending') { o.status = 'claimed'; save(); notifyAdmin('Покупатель сообщил об оплате', o, true); }
  res.json({ ok: true });
});

// Страница из письма: GET только показывает кнопку, подтверждает POST (чтобы почтовые сканеры не нажимали сами)
app.get('/confirm', (req, res) => {
  try {
    const { oid } = jwt.verify(String(req.query.t), JWT_SECRET);
    const o = db.orders.find(x => x.id === oid); if (!o) throw 0;
    res.send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Подтверждение оплаты</title><body style="font:16px system-ui;max-width:520px;margin:30px auto;padding:0 16px"><h2>Деньги пришли?</h2><pre style="white-space:pre-wrap">${esc(orderText(o))}</pre><p>Статус: ${esc(o.status)}</p><button id="b" style="padding:12px 20px;font-size:16px">Да, оплата получена</button><p id="m"></p><script>b.onclick=async()=>{const r=await fetch("/confirm",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({t:${JSON.stringify(String(req.query.t))}})});m.textContent=r.ok?"Готово, оплата подтверждена.":"Ошибка";b.disabled=true}</script>`);
  } catch { res.status(400).send('Ссылка недействительна или устарела'); }
});
app.post('/confirm', (req, res) => {
  try { const { oid } = jwt.verify(String(req.body.t), JWT_SECRET); const o = db.orders.find(x => x.id === oid); if (!o) throw 0; settle(o, 'почта'); res.json({ ok: true }); }
  catch { res.sendStatus(400); }
});

// Monobank: банк сам присылает каждое поступление на карту. Ищем код заказа в комментарии и сверяем сумму
app.get('/api/mono/:secret', (req, res) => res.sendStatus(MONO_SECRET && req.params.secret === MONO_SECRET ? 200 : 404));
app.post('/api/mono/:secret', (req, res) => {
  if (!MONO_SECRET || req.params.secret !== MONO_SECRET) return res.sendStatus(404);
  res.sendStatus(200);
  const it = req.body?.data?.statementItem;
  if (!it || !(it.amount > 0)) return;
  const m = `${it.comment || ''} ${it.description || ''}`.toUpperCase().match(/BS-\d{4}/);
  const o = m && db.orders.find(x => x.code === m[0] && x.cur === 'UAH' && (x.status === 'pending' || x.status === 'claimed'));
  if (!o) return;
  if (it.amount / 100 + 0.01 < o.amount) return notifyAdmin(`Недоплата: пришло ${it.amount / 100} ₴ из ${o.amount} ₴`, o, true);
  settle(o, 'Monobank');
});
function registerMono() {
  if (!MONO_TOKEN || !MONO_SECRET || !BASE_URL) return;
  fetch('https://api.monobank.ua/personal/webhook', { method: 'POST', headers: { 'X-Token': MONO_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ webHookUrl: `${BASE_URL}/api/mono/${MONO_SECRET}` }) })
    .then(r => console.log('Monobank webhook:', r.status)).catch(e => console.log('Monobank webhook error', e.message));
}

// ---------- админка ----------
const adm = (req, res, next) => req.headers['x-admin-key'] === ADMIN_KEY ? next() : res.sendStatus(403);
app.get('/admin/api/orders', adm, (_q, r) => r.json([...db.orders].reverse().slice(0, 200)));
app.post('/admin/api/done', adm, (req, res) => {
  const o = db.orders.find(x => x.id === req.body.id);
  if (!o) return res.sendStatus(404);
  if (o.status === 'pending' || o.status === 'claimed') settle(o, 'админка');
  else if (o.status === 'paid') { o.status = 'done'; save(); }
  res.json({ ok: true });
});
app.get('/admin', (_q, r) => r.sendFile(path.resolve('public/admin.html')));

app.get('/terms', (_q, r) => r.redirect('/terms.html'));
app.use(express.static('public'));
app.listen(PORT, () => { console.log('BEATSHOP on :' + PORT); setTimeout(registerMono, 3000); });
