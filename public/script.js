let me = null, products = [], methods = [], current = null;

function closeModals() { document.querySelectorAll('.modal').forEach(m => m.hidden = true); }

async function loadMe() {
  me = await api('/api/me');
  $('#pName').textContent = me.name;
  $('#pUser').textContent = me.username ? '@' + me.username : 'ইউজারনেম নেই';
  $('#pId').textContent = 'Telegram ID: ' + me.id;
  $('#pBal').textContent = taka(me.balance);
}

async function loadProducts() {
  products = await api('/api/products');
  $('#products').innerHTML = products.length ? products.map(p => `
    <div class="card">
      <b>${esc(p.name)}</b>
      <p class="muted">${esc(p.description)}</p>
      <div class="row"><span>${taka(p.price)} • স্টক: ${p.stock}</span>
      <button class="btn small" ${p.stock < 1 ? 'disabled' : ''} onclick="openBuy(${p.id})">${p.stock < 1 ? 'স্টক নেই' : 'কিনুন'}</button></div>
    </div>`).join('') : '<p class="muted">কোনো পণ্য নেই</p>';
}

async function loadOrders() {
  const [o, d] = await Promise.all([api('/api/orders'), api('/api/deposits')]);
  $('#orderList').innerHTML = o.length ? o.map(x => `
    <div class="card"><b>অর্ডার #${x.id}</b> <span class="tag">${ST[x.status] || x.status}</span>
    <p>${esc(x.product_name)} × ${x.quantity} = ${taka(x.total)}</p><p class="muted">${dt(x.created_at)}</p></div>`).join('') : '<p class="muted">কোনো অর্ডার নেই</p>';
  $('#depList').innerHTML = d.length ? d.map(x => `
    <div class="card"><b>${taka(x.amount)}</b> <span class="tag ${x.status}">${ST[x.status]}</span>
    <p class="muted">${esc(x.method)} • ${esc(x.trx_id)} • ${dt(x.created_at)}</p></div>`).join('') : '<p class="muted">কোনো ডিপোজিট নেই</p>';
}

function openBuy(id) {
  current = products.find(p => p.id === id);
  $('#bName').textContent = current.name;
  $('#bPrice').textContent = current.price;
  $('#bStock').textContent = current.stock;
  $('#bQty').value = 1; $('#bQty').max = current.stock;
  updTotal();
  $('#buyModal').hidden = false;
}
function updTotal() { $('#bTotal').textContent = Math.round(current.price * (Number($('#bQty').value) || 0) * 100) / 100; }
$('#bQty').addEventListener('input', updTotal);

$('#bConfirm').onclick = async () => {
  const btn = $('#bConfirm'); btn.disabled = true;
  try {
    const r = await api('/api/buy', { json: { product_id: current.id, quantity: Number($('#bQty').value) } });
    closeModals();
    toast(`✅ অর্ডার #${r.order_id} সম্পন্ন! ফাইল টেলিগ্রামে পাঠানো হয়েছে।`);
    await Promise.all([loadMe(), loadProducts()]);
  } catch (e) { toast('❌ ' + e.message); }
  btn.disabled = false;
};

async function openDeposit() {
  try { methods = await api('/api/payment-methods'); } catch (e) { return toast(e.message); }
  if (!methods.length) return toast('এখনো কোনো পেমেন্ট মেথড নেই');
  $('#dMethod').innerHTML = methods.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
  showDetails();
  $('#depModal').hidden = false;
}
function showDetails() {
  const m = methods.find(x => x.id == $('#dMethod').value);
  $('#dDetails').textContent = m ? m.details : '';
}
$('#dMethod').onchange = showDetails;

$('#dSubmit').onclick = async () => {
  const fd = new FormData();
  fd.append('method_id', $('#dMethod').value);
  fd.append('amount', $('#dAmount').value);
  fd.append('trx_id', $('#dTrx').value);
  if ($('#dProof').files[0]) fd.append('proof', $('#dProof').files[0]);
  const btn = $('#dSubmit'); btn.disabled = true;
  try {
    await api('/api/deposit', { method: 'POST', body: fd });
    closeModals(); toast('✅ ডিপোজিট জমা হয়েছে, অনুমোদনের অপেক্ষায় আছে');
    $('#dAmount').value = ''; $('#dTrx').value = ''; $('#dProof').value = '';
  } catch (e) { toast('❌ ' + e.message); }
  btn.disabled = false;
};

document.querySelectorAll('nav.bottom button').forEach(b => b.onclick = () => {
  document.querySelectorAll('nav.bottom button').forEach(x => x.classList.toggle('on', x === b));
  document.querySelectorAll('.tab').forEach(t => t.hidden = t.id !== b.dataset.tab);
  if (b.dataset.tab === 'orders') loadOrders().catch(e => toast(e.message));
  if (b.dataset.tab === 'home') { loadMe(); loadProducts(); }
});

(async () => {
  try { await loadMe(); await loadProducts(); }
  catch (e) { $('main').innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
})();
