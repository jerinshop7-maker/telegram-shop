let cache = {};
const V = $('#view');
const T = (h, rows) => `<div class="scroll"><table><tr>${h.map(x => `<th>${x}</th>`).join('')}</tr>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</table></div>`;
let tab = 'dash';

async function show(t) {
  tab = t;
  document.querySelectorAll('nav.tabs button').forEach(b => b.classList.toggle('on', b.dataset.t === t));
  V.innerHTML = 'লোড হচ্ছে...';
  try { await views[t](); } catch (e) { V.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}
async function run(url, json, method) {
  try { const r = await api(url, { json: json || {}, method }); toast('✅ সম্পন্ন'); await show(tab); return r; }
  catch (e) { toast('❌ ' + e.message); }
}

const views = {
  async dash() {
    const d = await api('/api/admin/dashboard');
    const c = [['মোট ইউজার', d.users], ['মোট পণ্য', d.products], ['available স্টক', d.stock], ['অপেক্ষমাণ ডিপোজিট', d.pending], ['মোট অর্ডার', d.orders], ['মোট বিক্রি', taka(d.sales)]];
    V.innerHTML = '<div class="grid">' + c.map(x => `<div class="card"><div class="muted">${x[0]}</div><h2>${x[1]}</h2></div>`).join('') + '</div>';
  },
  async users() {
    const u = cache.users = await api('/api/admin/users');
    V.innerHTML = T(['ID', 'নাম', 'ইউজারনেম', 'ব্যালেন্স', 'স্ট্যাটাস', 'অ্যাকশন'], u.map(x => [
      x.id, esc(x.name), esc(x.username), taka(x.balance), x.blocked ? 'ব্লকড' : 'সক্রিয়',
      `<button class="btn small" onclick="blockUser(${x.id},${x.blocked ? 0 : 1})">${x.blocked ? 'আনব্লক' : 'ব্লক'}</button>
       <button class="btn small" onclick="adjBal(${x.id})">ব্যালেন্স</button>`]));
  },
  async products() {
    const p = cache.products = await api('/api/admin/products');
    V.innerHTML = `<div class="card"><h3>নতুন পণ্য</h3>
      <input id="pn" placeholder="পণ্যের নাম"><input id="pd" placeholder="বিবরণ"><input id="pp" type="number" placeholder="দাম">
      <button class="btn" onclick="addProduct()">যোগ করুন</button></div>` +
      T(['ID', 'নাম', 'দাম', 'স্টক', 'স্ট্যাটাস', 'অ্যাকশন'], p.map(x => [
        x.id, esc(x.name), taka(x.price), x.stock, x.active ? 'সক্রিয়' : 'বন্ধ',
        `<button class="btn small" onclick="editProduct(${x.id})">এডিট</button>
         <button class="btn small" onclick="toggleProduct(${x.id})">${x.active ? 'বন্ধ' : 'চালু'}</button>`])) +
      `<div class="card"><h3>স্টক যোগ করুন</h3>
      <select id="sp">${p.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select>
      <textarea id="st" rows="5" placeholder="প্রতি লাইনে একটি স্টক আইটেম। একাধিক কলাম হলে কমা (,) দিয়ে আলাদা করুন"></textarea>
      <button class="btn" onclick="addStockText()">স্টক যোগ</button>
      <p class="muted">অথবা XLSX আপলোড (প্রতিটি সারি = ১টি স্টক):</p>
      <input type="file" id="sf" accept=".xlsx"><button class="btn" onclick="uploadStock()">XLSX আপলোড</button></div>`;
  },
  async orders() {
    const o = await api('/api/admin/orders');
    V.innerHTML = T(['#', 'ইউজার', 'পণ্য', 'পরিমাণ', 'মোট', 'তারিখ'], o.map(x => [x.id, esc(x.user_name) + ` (${x.user_id})`, esc(x.product_name), x.quantity, taka(x.total), dt(x.created_at)]));
  },
  async deposits() {
    const d = await api('/api/admin/deposits');
    V.innerHTML = T(['#', 'ইউজার', 'মেথড', 'পরিমাণ', 'TrxID', 'প্রুফ', 'স্ট্যাটাস', 'অ্যাকশন'], d.map(x => [
      x.id, esc(x.user_name) + ` (${x.user_id})`, esc(x.method), taka(x.amount), esc(x.trx_id),
      `<a href="/uploads/${esc(x.proof)}" target="_blank">দেখুন</a>`, ST[x.status],
      x.status === 'pending' ? `<button class="btn small" onclick="depAct(${x.id},'approve')">✔</button> <button class="btn small ghost" onclick="depAct(${x.id},'reject')">✖</button>` : '-']));
  },
  async payments() {
    const m = cache.methods = await api('/api/admin/payment-methods');
    V.innerHTML = `<div class="card"><h3>নতুন পেমেন্ট মেথড</h3>
      <input id="mn" placeholder="নাম (যেমন: bKash)"><textarea id="md" rows="3" placeholder="বিবরণ (নম্বর/নির্দেশনা)"></textarea>
      <button class="btn" onclick="addMethod()">যোগ করুন</button></div>` +
      T(['ID', 'নাম', 'বিবরণ', 'স্ট্যাটাস', 'অ্যাকশন'], m.map(x => [x.id, esc(x.name), esc(x.details), x.active ? 'সক্রিয়' : 'বন্ধ',
        `<button class="btn small" onclick="editMethod(${x.id})">এডিট</button> <button class="btn small" onclick="toggleMethod(${x.id})">${x.active ? 'বন্ধ' : 'চালু'}</button>`]));
  },
  async admins() {
    const a = await api('/api/admin/admins');
    V.innerHTML = `<div class="card"><h3>নতুন অ্যাডমিন (Telegram ID)</h3><input id="ai" type="number" placeholder="Telegram ID">
      <button class="btn" onclick="addAdmin()">যোগ করুন</button></div>` +
      T(['ID', 'নাম', 'অ্যাকশন'], a.map(x => [x.id, esc(x.name || '-'), `<button class="btn small ghost" onclick="delAdmin(${x.id})">সরান</button>`]));
  }
};

const blockUser = (id, b) => run(`/api/admin/users/${id}/block`, { blocked: b });
function adjBal(id) {
  const v = prompt('পরিমাণ লিখুন (যোগ করতে 100, বিয়োগ করতে -100):');
  if (v) run(`/api/admin/users/${id}/balance`, { amount: Number(v) });
}
const addProduct = () => run('/api/admin/products', { name: $('#pn').value, description: $('#pd').value, price: $('#pp').value });
function editProduct(id) {
  const p = cache.products.find(x => x.id === id);
  const name = prompt('নাম:', p.name); if (name === null) return;
  const description = prompt('বিবরণ:', p.description); if (description === null) return;
  const price = prompt('দাম:', p.price); if (price === null) return;
  run(`/api/admin/products/${id}`, { name, description, price, active: p.active }, 'PUT');
}
function toggleProduct(id) { const p = cache.products.find(x => x.id === id); run(`/api/admin/products/${id}`, { ...p, active: !p.active }, 'PUT'); }
function addStockText() { run(`/api/admin/products/${$('#sp').value}/stock`, { text: $('#st').value }); }
async function uploadStock() {
  const f = $('#sf').files[0]; if (!f) return toast('ফাইল বাছুন');
  const fd = new FormData(); fd.append('file', f);
  try { const r = await api(`/api/admin/products/${$('#sp').value}/stock-xlsx`, { method: 'POST', body: fd }); toast(`✅ ${r.added}টি স্টক যোগ হয়েছে`); show('products'); }
  catch (e) { toast('❌ ' + e.message); }
}
function depAct(id, a) { if (confirm(a === 'approve' ? 'অনুমোদন করবেন?' : 'বাতিল করবেন?')) run(`/api/admin/deposits/${id}/${a}`, {}); }
const addMethod = () => run('/api/admin/payment-methods', { name: $('#mn').value, details: $('#md').value });
function editMethod(id) {
  const m = cache.methods.find(x => x.id === id);
  const name = prompt('নাম:', m.name); if (name === null) return;
  const details = prompt('বিবরণ:', m.details); if (details === null) return;
  run(`/api/admin/payment-methods/${id}`, { name, details, active: m.active }, 'PUT');
}
function toggleMethod(id) { const m = cache.methods.find(x => x.id === id); run(`/api/admin/payment-methods/${id}`, { ...m, active: !m.active }, 'PUT'); }
const addAdmin = () => run('/api/admin/admins', { id: $('#ai').value });
function delAdmin(id) { if (confirm('অ্যাডমিন সরাবেন?')) run(`/api/admin/admins/${id}`, {}, 'DELETE'); }

document.querySelectorAll('nav.tabs button').forEach(b => b.onclick = () => show(b.dataset.t));
(async () => {
  try {
    const me = await api('/api/me');
    if (me.role === 'USER') { V.innerHTML = '<p class="err">আপনি অ্যাডমিন নন</p>'; return; }
    $('#who').textContent = me.role;
    if (me.role !== 'SUPER_ADMIN') $('#adminsTab').hidden = true;
    show('dash');
  } catch (e) { V.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
})();
