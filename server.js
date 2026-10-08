require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@libsql/client');
const multer = require('multer');
const XLSX = require('xlsx');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const APP_URL = (process.env.TELEGRAM_MINI_APP_URL || '').replace(/\/$/, '');
const SUPER = Number(process.env.SUPER_ADMIN_TELEGRAM_ID || 0);
const DEV = process.env.DEV_MODE === 'true';
const PORT = process.env.PORT || 3000;
const TURSO_URL = process.env.TURSO_DATABASE_URL || '';
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN || '';
const UPLOADS = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS);

let db;
const round = n => Math.round(n * 100) / 100;
const fail = msg => { throw new Error(msg); };
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function initDatabase() {
  if (!TURSO_URL || !TURSO_TOKEN) {
    throw new Error('Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in .env');
  }
  db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN, intMode: 'number' });
  await db.batch([
    `CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT, username TEXT, balance REAL NOT NULL DEFAULT 0, blocked INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS admins(id INTEGER PRIMARY KEY)`,
    `CREATE TABLE IF NOT EXISTS payment_methods(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, details TEXT, active INTEGER NOT NULL DEFAULT 1)`,
    `CREATE TABLE IF NOT EXISTS deposits(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, method TEXT, amount REAL NOT NULL, trx_id TEXT NOT NULL UNIQUE, proof TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT, price REAL NOT NULL, active INTEGER NOT NULL DEFAULT 1)`,
    `CREATE TABLE IF NOT EXISTS stock_items(id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL, data TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'available', order_id INTEGER)`,
    `CREATE INDEX IF NOT EXISTS idx_stock ON stock_items(product_id, status)`,
    `CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, product_id INTEGER, product_name TEXT, quantity INTEGER NOT NULL, total REAL NOT NULL, status TEXT NOT NULL DEFAULT 'completed', created_at TEXT DEFAULT CURRENT_TIMESTAMP)`
  ], 'write');
}

async function all(sql, args = []) {
  const result = await db.execute({ sql, args });
  return result.rows;
}

async function get(sql, args = []) {
  const result = await db.execute({ sql, args });
  return result.rows[0];
}

async function run(sql, args = []) {
  return db.execute({ sql, args });
}

async function transaction(fn) {
  const tx = await db.transaction('write');
  try {
    const result = await fn(tx);
    await tx.commit();
    return result;
  } catch (e) {
    await tx.rollback().catch(() => {});
    throw e;
  }
}

// ---------- Telegram helpers ----------
async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  return r.json();
}
const notify = (id, text) => tg('sendMessage', { chat_id: id, text }).catch(() => {});

async function sendOrderFile(userId, orderId, rows) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Order');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const form = new FormData();
  form.append('chat_id', String(userId));
  form.append('caption', `✅ আপনার অর্ডার #${orderId} সম্পন্ন হয়েছে।`);
  form.append('document', new Blob([buf]), `order-${orderId}.xlsx`);
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendDocument`, { method: 'POST', body: form });
  return r.json();
}

// ---------- Auth: validate Telegram initData ----------
function parseInitData(raw) {
  try {
    const p = new URLSearchParams(raw);
    const hash = p.get('hash');
    p.delete('hash');
    const str = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
    const calc = crypto.createHmac('sha256', secret).update(str).digest('hex');
    if (!hash || hash.length !== calc.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
    if (Date.now() / 1000 - Number(p.get('auth_date')) > 86400) return null;
    return JSON.parse(p.get('user'));
  } catch { return null; }
}

const auth = asyncRoute(async (req, res, next) => {
  const raw = req.get('x-init-data');
  let u = raw ? parseInitData(raw) : null;
  if (!raw && DEV) u = { id: SUPER || 1, first_name: 'Dev User', username: 'dev' };
  if (!u) return res.status(401).json({ error: 'টেলিগ্রাম থেকে অ্যাপটি খুলুন' });
  await run(`INSERT INTO users(id,name,username) VALUES(?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, username=excluded.username`,
  [u.id, [u.first_name, u.last_name].filter(Boolean).join(' '), u.username || '']);
  const user = await get('SELECT * FROM users WHERE id=?', [u.id]);
  if (user.blocked) return res.status(403).json({ error: 'আপনার অ্যাকাউন্ট ব্লক করা হয়েছে' });
  user.role = u.id === SUPER ? 'SUPER_ADMIN' : await get('SELECT 1 FROM admins WHERE id=?', [u.id]) ? 'ADMIN' : 'USER';
  req.user = user;
  next();
});
const adminOnly = [auth, (req, res, next) => req.user.role === 'USER' ? res.status(403).json({ error: 'অনুমতি নেই' }) : next()];
const superOnly = [auth, (req, res, next) => req.user.role === 'SUPER_ADMIN' ? next() : res.status(403).json({ error: 'শুধু সুপার অ্যাডমিন' })];

// ---------- Upload ----------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const IMG_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

async function addStock(productId, rows) {
  return transaction(async tx => {
    await tx.batch(rows.map(row => ({
      sql: 'INSERT INTO stock_items(product_id,data) VALUES(?,?)',
      args: [productId, JSON.stringify(row)]
    })));
    return rows.length;
  });
}

// ---------- App ----------
const app = express();
app.set('view engine', 'ejs');
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS)); // file names are random & unguessable

app.get('/', (req, res) => res.render('shop'));
app.get('/admin', (req, res) => res.render('admin'));

// Telegram webhook (/start)
app.post('/webhook/:token', asyncRoute(async (req, res) => {
  if (req.params.token !== TOKEN) return res.sendStatus(200);
  const m = req.body.message;
  if (m && m.text && m.text.startsWith('/start')) {
    const id = m.from.id;
    const isAdmin = id === SUPER || await get('SELECT 1 FROM admins WHERE id=?', [id]);
    const kb = [[{ text: '🛍️ Shop Open করুন', web_app: { url: APP_URL } }]];
    if (isAdmin) kb.push([{ text: '⚙️ Admin Panel', web_app: { url: APP_URL + '/admin' } }]);
    tg('sendMessage', { chat_id: id, text: 'স্বাগতম! শপ খুলতে নিচের বাটনে চাপুন 👇', reply_markup: { inline_keyboard: kb } }).catch(console.error);
  }
  res.sendStatus(200);
}));

// ---------- Customer API ----------
app.get('/api/me', auth, (req, res) => {
  const { id, name, username, balance, role } = req.user;
  res.json({ id, name, username, balance, role });
});

app.get('/api/products', auth, asyncRoute(async (req, res) => res.json(await all(`
  SELECT p.id,p.name,p.description,p.price,
  (SELECT COUNT(*) FROM stock_items s WHERE s.product_id=p.id AND s.status='available') AS stock
  FROM products p WHERE p.active=1 ORDER BY p.id DESC`))));

app.get('/api/payment-methods', auth, asyncRoute(async (req, res) =>
  res.json(await all('SELECT id,name,details FROM payment_methods WHERE active=1'))));

app.post('/api/deposit', auth, upload.single('proof'), asyncRoute(async (req, res) => {
  const amount = round(Number(req.body.amount));
  const trx = String(req.body.trx_id || '').trim().slice(0, 100);
  const method = await get('SELECT * FROM payment_methods WHERE id=? AND active=1', [Number(req.body.method_id)]);
  if (!method) fail('পেমেন্ট মেথড সঠিক নয়');
  if (!(amount > 0 && amount <= 1000000)) fail('টাকার পরিমাণ সঠিক নয়');
  if (!trx) fail('লেনদেনের আইডি দিন');
  if (!req.file || !IMG_EXT[req.file.mimetype]) fail('পেমেন্ট প্রুফ হিসেবে ছবি (JPG/PNG/WEBP) দিন');
  const file = crypto.randomBytes(16).toString('hex') + IMG_EXT[req.file.mimetype];
  try {
    await run('INSERT INTO deposits(user_id,method,amount,trx_id,proof) VALUES(?,?,?,?,?)',
      [req.user.id, method.name, amount, trx, file]);
  } catch (e) { fail('এই লেনদেনের আইডি আগেই ব্যবহার করা হয়েছে'); }
  fs.writeFileSync(path.join(UPLOADS, file), req.file.buffer);
  res.json({ ok: true });
}));

app.get('/api/deposits', auth, asyncRoute(async (req, res) => res.json(await all(
  'SELECT id,method,amount,trx_id,status,created_at FROM deposits WHERE user_id=? ORDER BY id DESC LIMIT 50', [req.user.id]))));

app.get('/api/orders', auth, asyncRoute(async (req, res) => res.json(await all(
  'SELECT id,product_name,quantity,total,status,created_at FROM orders WHERE user_id=? ORDER BY id DESC LIMIT 100', [req.user.id]))));

app.post('/api/buy', auth, asyncRoute(async (req, res) => {
  const pid = Number(req.body.product_id);
  const qty = Math.floor(Number(req.body.quantity));
  if (!(qty >= 1 && qty <= 1000)) fail('পরিমাণ সঠিক নয়');
  const done = await transaction(async tx => {
    const p = (await tx.execute({ sql: 'SELECT * FROM products WHERE id=? AND active=1', args: [pid] })).rows[0]
      || fail('পণ্যটি পাওয়া যায়নি');
    const items = (await tx.execute({
      sql: "SELECT id,data FROM stock_items WHERE product_id=? AND status='available' ORDER BY id LIMIT ?",
      args: [pid, qty]
    })).rows;
    if (items.length < qty) fail('দুঃখিত, পর্যাপ্ত স্টক নেই');
    const total = round(p.price * qty); // price always from database
    const upd = await tx.execute({
      sql: 'UPDATE users SET balance=balance-? WHERE id=? AND balance>=?', args: [total, req.user.id, total]
    });
    if (!upd.rowsAffected) fail('আপনার ব্যালেন্স পর্যাপ্ত নয়, আগে ডিপোজিট করুন');
    const order = await tx.execute({
      sql: 'INSERT INTO orders(user_id,product_id,product_name,quantity,total) VALUES(?,?,?,?,?)',
      args: [req.user.id, p.id, p.name, qty, total]
    });
    const orderId = Number(order.lastInsertRowid);
    for (const item of items) {
      const mark = await tx.execute({
        sql: "UPDATE stock_items SET status='sold',order_id=? WHERE id=? AND status='available'",
        args: [orderId, item.id]
      });
      if (!mark.rowsAffected) fail('স্টক সমস্যা হয়েছে, আবার চেষ্টা করুন');
    }
    return { orderId, total, rows: items.map(item => JSON.parse(item.data)) };
  });
  sendOrderFile(req.user.id, done.orderId, done.rows).catch(e => console.error('sendDocument failed', e));
  res.json({ ok: true, order_id: done.orderId, total: done.total });
}));

// ---------- Admin API ----------
const A = '/api/admin';
app.get(`${A}/dashboard`, adminOnly, asyncRoute(async (req, res) => res.json(await get(`SELECT
  (SELECT COUNT(*) FROM users) users,
  (SELECT COUNT(*) FROM products) products,
  (SELECT COUNT(*) FROM stock_items WHERE status='available') stock,
  (SELECT COUNT(*) FROM deposits WHERE status='pending') pending,
  (SELECT COUNT(*) FROM orders) orders,
  (SELECT COALESCE(SUM(total),0) FROM orders) sales`))));

app.get(`${A}/users`, adminOnly, asyncRoute(async (req, res) => res.json(await all('SELECT * FROM users ORDER BY created_at DESC LIMIT 500'))));
app.post(`${A}/users/:id/block`, adminOnly, asyncRoute(async (req, res) => {
  if (Number(req.params.id) === SUPER) fail('সুপার অ্যাডমিনকে ব্লক করা যাবে না');
  await run('UPDATE users SET blocked=? WHERE id=?', [req.body.blocked ? 1 : 0, req.params.id]);
  res.json({ ok: true });
}));
app.post(`${A}/users/:id/balance`, adminOnly, asyncRoute(async (req, res) => {
  const amt = round(Number(req.body.amount));
  if (!amt) fail('সঠিক পরিমাণ দিন');
  const r = await run('UPDATE users SET balance=balance+? WHERE id=? AND balance+?>=0', [amt, req.params.id, amt]);
  if (!r.rowsAffected) fail('ব্যালেন্স যোগ/বিয়োগ করা যায়নি (ব্যালেন্স ০ এর নিচে যাবে)');
  res.json({ ok: true });
}));

app.get(`${A}/products`, adminOnly, asyncRoute(async (req, res) => res.json(await all(`
  SELECT p.*, (SELECT COUNT(*) FROM stock_items s WHERE s.product_id=p.id AND s.status='available') AS stock
  FROM products p ORDER BY p.id DESC`))));
app.post(`${A}/products`, adminOnly, asyncRoute(async (req, res) => {
  const { name, description, price } = req.body;
  if (!String(name || '').trim() || !(Number(price) >= 0)) fail('নাম ও সঠিক দাম দিন');
  await run('INSERT INTO products(name,description,price) VALUES(?,?,?)', [name.trim(), description || '', round(Number(price))]);
  res.json({ ok: true });
}));
app.put(`${A}/products/:id`, adminOnly, asyncRoute(async (req, res) => {
  const { name, description, price, active } = req.body;
  if (!String(name || '').trim() || !(Number(price) >= 0)) fail('নাম ও সঠিক দাম দিন');
  await run('UPDATE products SET name=?,description=?,price=?,active=? WHERE id=?',
    [name.trim(), description || '', round(Number(price)), active ? 1 : 0, req.params.id]);
  res.json({ ok: true });
}));
app.post(`${A}/products/:id/stock`, adminOnly, asyncRoute(async (req, res) => {
  const rows = String(req.body.text || '').split('\n').map(l => l.trim()).filter(Boolean)
    .slice(0, 20000).map(l => l.split(',').map(c => c.trim()));
  if (!rows.length) fail('কোনো স্টক দেওয়া হয়নি');
  if (!await get('SELECT 1 FROM products WHERE id=?', [req.params.id])) fail('পণ্য পাওয়া যায়নি');
  res.json({ ok: true, added: await addStock(req.params.id, rows) });
}));
app.post(`${A}/products/:id/stock-xlsx`, adminOnly, upload.single('file'), asyncRoute(async (req, res) => {
  const f = req.file;
  if (!f || !/\.xlsx$/i.test(f.originalname) || f.buffer.slice(0, 2).toString() !== 'PK') fail('শুধু .xlsx ফাইল দিন');
  if (!await get('SELECT 1 FROM products WHERE id=?', [req.params.id])) fail('পণ্য পাওয়া যায়নি');
  let sheet;
  try { const wb = XLSX.read(f.buffer, { type: 'buffer' }); sheet = wb.Sheets[wb.SheetNames[0]]; }
  catch { fail('XLSX ফাইলটি পড়া যায়নি'); }
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' })
    .map(r => r.map(c => String(c).trim())).filter(r => r.some(Boolean)).slice(0, 20000);
  if (!rows.length) fail('ফাইলে কোনো ডেটা নেই');
  res.json({ ok: true, added: await addStock(req.params.id, rows) });
}));

app.get(`${A}/orders`, adminOnly, asyncRoute(async (req, res) => res.json(await all(
  'SELECT o.*, u.name user_name FROM orders o LEFT JOIN users u ON u.id=o.user_id ORDER BY o.id DESC LIMIT 500'))));
app.get(`${A}/deposits`, adminOnly, asyncRoute(async (req, res) => res.json(await all(
  'SELECT d.*, u.name user_name FROM deposits d LEFT JOIN users u ON u.id=d.user_id ORDER BY d.id DESC LIMIT 500'))));
app.post(`${A}/deposits/:id/:action`, adminOnly, asyncRoute(async (req, res) => {
  const { id, action } = req.params;
  if (!['approve', 'reject'].includes(action)) fail('ভুল অ্যাকশন');
  const d = await transaction(async tx => {
    const dep = (await tx.execute({ sql: 'SELECT * FROM deposits WHERE id=?', args: [id] })).rows[0]
      || fail('ডিপোজিট পাওয়া যায়নি');
    const r = await tx.execute({
      sql: "UPDATE deposits SET status=? WHERE id=? AND status='pending'",
      args: [action === 'approve' ? 'approved' : 'rejected', id]
    });
    if (!r.rowsAffected) fail('এই ডিপোজিট আগেই প্রসেস করা হয়েছে');
    if (action === 'approve') {
      await tx.execute({ sql: 'UPDATE users SET balance=balance+? WHERE id=?', args: [dep.amount, dep.user_id] });
    }
    return dep;
  });
  notify(d.user_id, action === 'approve' ? `✅ আপনার ৳${d.amount} ডিপোজিট অনুমোদিত হয়েছে।` : `❌ আপনার ৳${d.amount} ডিপোজিট বাতিল করা হয়েছে।`);
  res.json({ ok: true });
}));

app.get(`${A}/payment-methods`, adminOnly, asyncRoute(async (req, res) => res.json(await all('SELECT * FROM payment_methods ORDER BY id DESC'))));
app.post(`${A}/payment-methods`, adminOnly, asyncRoute(async (req, res) => {
  if (!String(req.body.name || '').trim()) fail('নাম দিন');
  await run('INSERT INTO payment_methods(name,details) VALUES(?,?)', [req.body.name.trim(), req.body.details || '']);
  res.json({ ok: true });
}));
app.put(`${A}/payment-methods/:id`, adminOnly, asyncRoute(async (req, res) => {
  if (!String(req.body.name || '').trim()) fail('নাম দিন');
  await run('UPDATE payment_methods SET name=?,details=?,active=? WHERE id=?',
    [req.body.name.trim(), req.body.details || '', req.body.active ? 1 : 0, req.params.id]);
  res.json({ ok: true });
}));

app.get(`${A}/admins`, superOnly, asyncRoute(async (req, res) => res.json(await all(
  'SELECT a.id, u.name, u.username FROM admins a LEFT JOIN users u ON u.id=a.id'))));
app.post(`${A}/admins`, superOnly, asyncRoute(async (req, res) => {
  const id = Number(req.body.id);
  if (!Number.isInteger(id) || id <= 0) fail('সঠিক টেলিগ্রাম আইডি দিন');
  await run('INSERT OR IGNORE INTO admins(id) VALUES(?)', [id]);
  res.json({ ok: true });
}));
app.delete(`${A}/admins/:id`, superOnly, asyncRoute(async (req, res) => {
  await run('DELETE FROM admins WHERE id=?', [req.params.id]);
  res.json({ ok: true });
}));

// Errors -> JSON message
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'ফাইল ৫MB এর বেশি বড় হতে পারবে না' });
  res.status(400).json({ error: err.message || 'সমস্যা হয়েছে' });
});

async function start() {
  await initDatabase();
  app.listen(PORT, async () => {
    console.log('Server running on port ' + PORT);
    if (TOKEN && APP_URL.startsWith('https://')) {
      const r = await tg('setWebhook', { url: `${APP_URL}/webhook/${TOKEN}` }).catch(e => ({ error: e.message }));
      console.log('Webhook:', JSON.stringify(r));
    } else console.log('Webhook skipped (set TELEGRAM_MINI_APP_URL to an https URL)');
  });
}

start().catch(e => {
  console.error('Startup failed:', e.message);
  process.exit(1);
});
