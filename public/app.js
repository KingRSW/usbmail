'use strict';
/* U盘邮 前端 — 纯原生 JS, 无框架无外部依赖, 保证离线可用 */

const $ = (id) => document.getElementById(id);
const state = {
  accounts: [], activeId: null, settings: {},
  boxes: [], box: 'INBOX',
  messages: [], selected: null, query: '',
  presets: {}, loading: false,
};

/* ---------------- 基础工具 ---------------- */

async function api(path, opts) {
  const res = await fetch(path, opts);
  let data;
  try { data = await res.json(); } catch (_) { data = {}; }
  if (!res.ok) throw new Error(data.error || ('请求失败 ' + res.status));
  return data;
}

function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._tm);
  t._tm = setTimeout(() => { t.hidden = true; }, ms);
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtSize(n) {
  if (!n) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

function fmtDate(ts, raw) {
  if (!ts) return '';
  const d = new Date(ts), now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const pad = (x) => String(x).padStart(2, '0');
  if (sameDay) return pad(d.getHours()) + ':' + pad(d.getMinutes());
  if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  return d.getFullYear() + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate());
}

function dispName(list, fallback) {
  if (!list || !list.length) return fallback || '(未知)';
  const a = list[0];
  if (a.name) return a.name;
  return a.email || fallback || '(未知)';
}

/* ---------------- 账户 ---------------- */

async function loadAccounts() {
  const d = await api('/api/accounts');
  state.accounts = d.accounts;
  state.activeId = d.activeId;
  state.settings = d.settings || {};
  renderAccounts();
}

function renderAccounts() {
  const el = $('accList');
  if (!state.accounts.length) {
    el.innerHTML = '<div style="padding:6px 9px;font-size:12px;color:var(--txt-3)">还没有账户</div>';
    return;
  }
  el.innerHTML = state.accounts.map((a) => `
    <button class="acc-item ${a.id === state.activeId ? 'on' : ''}" data-id="${esc(a.id)}" title="${esc(a.email)}${a.ok === false ? ' — 授权码需要重新输入' : ''}">
      <span class="acc-dot"${a.ok === false ? ' style="background:#e0a33e"' : ''}></span>
      <span class="acc-name">${esc(a.label || a.email)}${a.ok === false ? ' ⚠' : ''}</span>
    </button>`).join('');
  el.querySelectorAll('.acc-item').forEach((b) => {
    b.onclick = () => selectAccount(b.dataset.id);
  });
}

async function selectAccount(id) {
  if (id === state.activeId) return;
  state.activeId = id;
  await api('/api/accounts/active', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  state.messages = []; state.selected = null; state.boxes = [];
  renderAccounts(); renderMessages(); showEmpty();
  await Promise.all([loadBoxes(), loadMessages()]);
}

/* ---------------- 文件夹 ---------------- */

const BOX_LABEL = {
  'INBOX': '收件箱', 'Sent Messages': '已发送', 'Sent': '已发送', 'Drafts': '草稿箱',
  'Deleted Messages': '已删除', 'Trash': '垃圾箱', 'Junk': '垃圾邮件', 'Spam': '垃圾邮件',
};

async function loadBoxes() {
  if (!state.activeId) { $('boxList').innerHTML = ''; return; }
  try {
    const d = await api('/api/boxes');
    state.boxes = d.boxes.filter((b) => !/\\Noselect/i.test(b.flags));
    renderBoxes();
  } catch (e) {
    $('boxList').innerHTML = '<div style="padding:6px 9px;font-size:12px;color:var(--txt-3)">文件夹读取失败</div>';
  }
}

function renderBoxes() {
  const el = $('boxList');
  el.innerHTML = state.boxes.map((b) => {
    const label = BOX_LABEL[b.name] || b.name;
    return `<button class="box-item ${b.name === state.box ? 'on' : ''}" data-box="${esc(b.name)}">
      <span>${esc(label)}</span></button>`;
  }).join('');
  el.querySelectorAll('.box-item').forEach((x) => {
    x.onclick = () => { state.box = x.dataset.box; renderBoxes(); loadMessages(); setView('list'); };
  });
}

/* ---------------- 邮件列表 ---------------- */

async function loadMessages() {
  if (!state.activeId) {
    $('msgList').innerHTML = '';
    $('listMeta').textContent = '';
    return;
  }
  state.loading = true;
  $('listMeta').innerHTML = '<span class="spin">↻</span> 正在收取…';
  $('msgList').innerHTML = Array.from({ length: 6 }, () =>
    '<div class="msg"><div class="skel" style="width:38%"></div>' +
    '<div class="skel" style="width:76%;margin-top:8px;height:11px"></div></div>').join('');
  try {
    const q = new URLSearchParams({ box: state.box, limit: state.settings.pageSize || 30 });
    const d = await api('/api/messages?' + q);
    state.messages = d.messages;
    renderMessages();
  } catch (e) {
    state.messages = [];
    $('msgList').innerHTML = `<div style="padding:20px 14px;color:var(--danger);font-size:13px;line-height:1.7">
      ⚠ ${esc(e.message)}</div>`;
    $('listMeta').textContent = '收取失败';
  } finally {
    state.loading = false;
  }
}

function visibleMessages() {
  const q = state.query.trim().toLowerCase();
  if (!q) return state.messages;
  return state.messages.filter((m) =>
    (m.subject || '').toLowerCase().includes(q) ||
    (m.from || '').toLowerCase().includes(q) ||
    dispName(m.fromList).toLowerCase().includes(q));
}

function renderMessages() {
  const el = $('msgList');
  const list = visibleMessages();
  const boxName = BOX_LABEL[state.box] || state.box;
  $('listMeta').innerHTML = `<span>${esc(boxName)} · ${list.length} 封</span>` +
    (state.query ? `<span>筛选“${esc(state.query)}”</span>` : '');

  if (!list.length) {
    el.innerHTML = `<div style="padding:34px 18px;text-align:center;color:var(--txt-3);font-size:13px;line-height:1.8">
      ${state.query ? '没有匹配的邮件' : '这里还没有邮件'}</div>`;
    return;
  }
  el.innerHTML = list.map((m) => `
    <div class="msg ${m.seen ? '' : 'unread'} ${state.selected && state.selected.uid === m.uid ? 'on' : ''}"
         data-uid="${m.uid}">
      <div class="msg-top">
        <div class="msg-from">${m.seen ? '' : '<span class="msg-badge"></span>'}${esc(dispName(m.fromList, m.from))}</div>
        <div class="msg-date">${esc(fmtDate(m.ts, m.date))}</div>
      </div>
      <div class="msg-subj">${esc(m.subject || '(无主题)')}</div>
    </div>`).join('');
  el.querySelectorAll('.msg').forEach((n) => {
    n.onclick = () => openMessage(Number(n.dataset.uid));
  });
}

/* ---------------- 阅读 ---------------- */

function showEmpty() {
  $('reader').className = 'reader empty';
  $('reader').innerHTML = `<div class="empty-state">
    <div class="empty-icon">📬</div>
    <h2>选择一封邮件</h2>
    <p>左侧添加你的 QQ / 163 邮箱，即可在此收取邮件。<br>所有数据保存在 U 盘里，不上传、不注册。</p>
  </div>`;
}

async function openMessage(uid) {
  const meta = state.messages.find((m) => m.uid === uid) || { uid };
  state.selected = meta;
  renderMessages();
  setView('read');

  const r = $('reader');
  r.className = 'reader';
  r.innerHTML = `
    <h1 class="r-subject">${esc(meta.subject || '(无主题)')}</h1>
    <div class="r-meta">
      <div class="r-row"><span class="r-key">发件</span><span class="r-val">${esc(dispName(meta.fromList, meta.from))}${meta.fromList && meta.fromList[0] && meta.fromList[0].name ? ' &lt;' + esc(meta.fromList[0].email) + '&gt;' : ''}</span></div>
      <div class="r-row"><span class="r-key">时间</span><span class="r-val">${esc(meta.date || '')}</span></div>
    </div>
    <div class="r-body"><div class="spin">↻</div> 正在读取正文…</div>`;

  let d;
  try {
    d = await api('/api/message?' + new URLSearchParams({ uid, box: state.box }));
  } catch (e) {
    r.innerHTML = `<h1 class="r-subject">${esc(meta.subject || '')}</h1>
      <div class="form-msg err">读取失败：${esc(e.message)}</div>`;
    return;
  }

  const atts = d.attachments || [];
  r.innerHTML = `
    <h1 class="r-subject">${esc(d.subject || '(无主题)')}</h1>
    <div class="r-meta">
      <div class="r-row"><span class="r-key">发件</span><span class="r-val"><b>${esc(dispName(d.fromList, d.from))}</b>${d.fromList && d.fromList[0] && d.fromList[0].name ? ' &lt;' + esc(d.fromList[0].email) + '&gt;' : ''}</span></div>
      <div class="r-row"><span class="r-key">收件</span><span class="r-val">${esc((d.toList || []).map((a) => a.name ? a.name + ' <' + a.email + '>' : a.email).join(', ') || d.to || '')}</span></div>
      ${(d.ccList && d.ccList.length) ? `<div class="r-row"><span class="r-key">抄送</span><span class="r-val">${esc(d.ccList.map((a) => a.email).join(', '))}</span></div>` : ''}
      <div class="r-row"><span class="r-key">时间</span><span class="r-val">${esc(d.date || '')}</span></div>
    </div>
    <div class="r-actions">
      <button id="btnRaw">查看原文</button>
      <button id="btnCopy">复制正文</button>
      <button id="btnPrint">打印 / 存 PDF</button>
    </div>
    <div class="r-body" id="bodyBox"></div>
    ${atts.length ? `<div class="att-list">${atts.map((a, i) => `
      <div class="att">
        <span class="att-icon">📎</span>
        <span class="att-name">${esc(a.filename)}</span>
        <span class="att-size">${esc(fmtSize(a.size))}</span>
        <a href="data:${esc(a.mime)};base64,${a.data}" download="${esc(a.filename)}">保存</a>
      </div>`).join('')}</div>` : ''}`;

  const box = $('bodyBox');
  if (d.html) {
    // sandbox 隔离: 邮件里的脚本不能碰我们的页面
    const ifr = document.createElement('iframe');
    ifr.setAttribute('sandbox', '');
    ifr.setAttribute('referrerpolicy', 'no-referrer');
    ifr.srcdoc = d.html;
    box.innerHTML = '';
    box.appendChild(ifr);
    ifr.onload = () => {
      try {
        const h = ifr.contentDocument.documentElement.scrollHeight;
        ifr.style.height = Math.max(320, Math.min(h + 30, 2400)) + 'px';
      } catch (_) {}
    };
  } else if (d.text) {
    box.innerHTML = '<pre>' + esc(d.text) + '</pre>';
  } else {
    box.innerHTML = '<div style="color:var(--txt-3)">（无文本内容）</div>';
  }

  $('btnCopy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(d.text || box.innerText || '');
      toast('已复制正文');
    } catch (_) { toast('复制失败，请手动选择'); }
  };
  $('btnPrint').onclick = () => window.print();
  $('btnRaw').onclick = () => {
    const w = window.open('', '_blank');
    if (!w) { toast('浏览器拦截了新窗口'); return; }
    w.document.write('<pre style="white-space:pre-wrap;word-break:break-word;font:12.5px ui-monospace,Menlo,monospace;padding:16px">' +
      esc(d.text || '(仅提供解码后的文本)') + '</pre>');
    w.document.close();
  };

  // 本地标记已读 (不打扰服务器)
  if (!meta.seen) {
    meta.seen = true;
    renderMessages();
  }
}

/* ---------------- 弹窗 ---------------- */

function openAccModal() {
  $('accModal').hidden = false;
  $('accMsg').className = 'form-msg';
  $('accMsg').textContent = '';
  const row = $('presetRow');
  row.innerHTML = Object.entries(state.presets).map(([k, p]) =>
    `<button class="preset" data-k="${esc(k)}">${esc(p.label)}</button>`).join('');
  row.querySelectorAll('.preset').forEach((b) => {
    b.onclick = () => applyPreset(b.dataset.k);
  });
  applyPreset('qq');
  $('fEmail').focus();
}

function applyPreset(k) {
  const p = state.presets[k];
  if (!p) return;
  $('presetRow').querySelectorAll('.preset').forEach((b) => b.classList.toggle('on', b.dataset.k === k));
  $('fHost').value = p.host;
  $('fPort').value = p.port;
  $('passHint').textContent = p.hint || '';
  const em = $('fEmail').value.trim();
  if (!em && p.host) {
    const guess = { qq: '@qq.com', '163': '@163.com', '126': '@126.com', gmail: '@gmail.com', outlook: '@outlook.com' }[k];
    if (guess) $('fEmail').placeholder = 'yourname' + guess;
  }
  const hostMap = { qq: 'imap.qq.com', '163': 'imap.163.com', '126': 'imap.126.com', gmail: 'imap.gmail.com', outlook: 'outlook.office365.com' };
  if (hostMap[k]) $('fEmail').value = em || '';
}

function accForm() {
  return {
    email: $('fEmail').value.trim(),
    host: $('fHost').value.trim(),
    port: Number($('fPort').value) || 993,
    secure: true,
    pass: $('fPass').value,
    label: $('fLabel').value.trim() || $('fEmail').value.trim(),
  };
}

async function saveAccount() {
  const f = accForm();
  const msg = $('accMsg');
  if (!f.email || !f.host) { msg.className = 'form-msg err'; msg.textContent = '请填写邮箱地址和 IMAP 服务器'; return; }
  if (!f.pass) { msg.className = 'form-msg err'; msg.textContent = '请填写授权码'; return; }

  const btn = $('btnSaveAcc');
  btn.disabled = true; btn.textContent = '正在验证…';
  msg.className = 'form-msg'; msg.textContent = '正在连接邮箱服务器验证…';
  try {
    await api('/api/accounts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(f),
    });
    msg.className = 'form-msg ok'; msg.textContent = '添加成功！';
    $('accModal').hidden = true;
    $('fEmail').value = ''; $('fPass').value = ''; $('fLabel').value = '';
    await loadAccounts();
    await Promise.all([loadBoxes(), loadMessages()]);
    toast('账户已添加');
  } catch (e) {
    msg.className = 'form-msg err'; msg.textContent = e.message;
  } finally {
    btn.disabled = false; btn.textContent = '保存并收取';
  }
}

async function testAccount() {
  const f = accForm();
  const msg = $('accMsg');
  if (!f.email || !f.host || !f.pass) { msg.className = 'form-msg err'; msg.textContent = '请先填完整'; return; }
  const btn = $('btnTestAcc');
  btn.disabled = true;
  msg.className = 'form-msg'; msg.textContent = '正在测试连接…';
  try {
    const d = await api('/api/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(f),
    });
    msg.className = 'form-msg ok';
    msg.textContent = `连接成功！收件箱共 ${d.count} 封邮件，发现 ${d.mailboxes.length} 个文件夹。`;
  } catch (e) {
    msg.className = 'form-msg err'; msg.textContent = e.message;
  } finally { btn.disabled = false; }
}

function openSettings() {
  $('setModal').hidden = false;
  $('sPageSize').value = state.settings.pageSize || 30;
  $('sMarkSeen').checked = !!state.settings.markSeen;
  const cur = state.accounts.find((a) => a.id === state.activeId);
  $('setAccRow').innerHTML = cur
    ? `<span class="tip">${esc(cur.label)} — ${esc(cur.email)} @ ${esc(cur.host)}</span>`
    : '<span class="tip">无</span>';
  $('btnDeleteAcc').style.display = cur ? '' : 'none';
}

/* ---------------- 视图切换(窄屏) ---------------- */

function setView(v) {
  document.getElementById('app').dataset.view = v;
}

/* ---------------- 初始化 ---------------- */

async function init() {
  try {
    const p = await api('/api/presets');
    state.presets = p.presets;
  } catch (_) { state.presets = {}; }

  $('btnAddAcc').onclick = openAccModal;
  $('btnEmptyAdd').onclick = openAccModal;
  $('btnCancelAcc').onclick = () => { $('accModal').hidden = true; };
  $('btnSaveAcc').onclick = saveAccount;
  $('btnTestAcc').onclick = testAccount;
  $('accModal').onclick = (e) => { if (e.target === $('accModal')) $('accModal').hidden = true; };

  $('btnSettings').onclick = openSettings;
  $('btnCloseSet').onclick = () => { $('setModal').hidden = true; };
  $('setModal').onclick = (e) => { if (e.target === $('setModal')) $('setModal').hidden = true; };
  $('btnSaveSet').onclick = async () => {
    await api('/api/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pageSize: Number($('sPageSize').value) || 30,
        markSeen: $('sMarkSeen').checked,
      }),
    });
    state.settings.pageSize = Number($('sPageSize').value) || 30;
    state.settings.markSeen = $('sMarkSeen').checked;
    $('setModal').hidden = true;
    toast('设置已保存');
    loadMessages();
  };
  $('btnDeleteAcc').onclick = async () => {
    const cur = state.accounts.find((a) => a.id === state.activeId);
    if (!cur || !confirm(`删除账户「${cur.label}」？\nU盘上的账户配置会被移除（不会影响邮箱本身）。`)) return;
    await api('/api/accounts?id=' + encodeURIComponent(cur.id), { method: 'DELETE' });
    $('setModal').hidden = true;
    state.box = 'INBOX';
    await loadAccounts();
    showEmpty(); renderMessages();
    await Promise.all([loadBoxes(), loadMessages()]);
    toast('账户已删除');
  };

  $('btnRefreshAll').onclick = () => { loadBoxes(); loadMessages(); toast('正在刷新…', 1200); };
  $('btnReload').onclick = () => loadMessages();

  let st;
  $('searchInput').oninput = (e) => {
    clearTimeout(st);
    st = setTimeout(() => { state.query = e.target.value; renderMessages(); }, 140);
  };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { $('accModal').hidden = true; $('setModal').hidden = true; }
    if (e.key === 'r' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); loadMessages(); }
  });

  await loadAccounts();
  if (state.accounts.length) {
    await Promise.all([loadBoxes(), loadMessages()]);
  } else {
    showEmpty();
    setTimeout(openAccModal, 350);
  }
  // 窄屏默认进列表
  if (window.innerWidth <= 860) setView('list');
}

document.addEventListener('DOMContentLoaded', init);
