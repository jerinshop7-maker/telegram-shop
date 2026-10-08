const tg = window.Telegram && window.Telegram.WebApp;
if (tg) { tg.ready(); tg.expand(); }
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ST = { pending: 'অপেক্ষমাণ', approved: 'অনুমোদিত', rejected: 'বাতিল', completed: 'সম্পন্ন' };
const taka = n => '৳' + Number(n || 0);
const dt = s => new Date(s.replace(' ', 'T') + 'Z').toLocaleString('bn-BD');

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.className = 'show';
  setTimeout(() => t.className = '', 3000);
}

async function api(url, opt = {}) {
  opt.headers = Object.assign({ 'x-init-data': (tg && tg.initData) || '' }, opt.headers);
  if (opt.json !== undefined) {
    opt.method = opt.method || 'POST';
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(opt.json || {});
  } else if (opt.method === 'DELETE') opt.headers['Content-Type'] = 'application/json';
  const r = await fetch(url, opt);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'সমস্যা হয়েছে');
  return d;
}
