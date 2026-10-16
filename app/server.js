'use strict';
/**
 * U盘邮 — 本地邮件服务器
 * 零依赖: 只用 Node 内置模块。启动后浏览器打开 http://127.0.0.1:<port>
 * 数据全部保存在 U盘上的 data/ 目录, 不登录、不上传。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ImapClient, parseMime, splitByBoundary, parseHeaders, extractHeaders } = require('./imap');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
// 允许用环境变量覆盖数据目录 (便于测试), 默认始终在 U 盘上的 data/
const DATA_DIR = process.env.USBMAIL_DATA
  ? path.resolve(process.env.USBMAIL_DATA)
  : path.join(ROOT, 'data');
const CFG_FILE = path.join(DATA_DIR, 'config.json');
const CACHE_DIR = path.join(DATA_DIR, 'cache');

for (const d of [DATA_DIR, CACHE_DIR]) {
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
}

/* ---------- 配置读写 ---------- */

const DEFAULT_CFG = {
  accounts: [],       // [{id,label,email,host,port,secure,passEnc}]
  activeId: null,
  settings: { pageSize: 30, maxFetch: 200, markSeen: false, signature: '' },
};

function loadCfg() {
  try {
    const j = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
    return { ...DEFAULT_CFG, ...j, settings: { ...DEFAULT_CFG.settings, ...(j.settings || {}) } };
  } catch (_) {
    return JSON.parse(JSON.stringify(DEFAULT_CFG));
  }
}

function saveCfg(cfg) {
  const data = JSON.stringify(cfg, null, 2);
  // 先试原子写(临时文件+改名)。某些 U 盘文件系统(exFAT + noowners)上
  // rename 到已存在的文件会失败, 所以失败后退回直接写。
  try {
    const tmp = CFG_FILE + '.tmp';
    fs.writeFileSync(tmp, data, 'utf8');
    fs.renameSync(tmp, CFG_FILE);
    return;
  } catch (_) {
    try { fs.rmSync(CFG_FILE + '.tmp', { force: true }); } catch (__) {}
  }
  try {
    fs.writeFileSync(CFG_FILE, data, 'utf8');
  } catch (e) {
    // 最后手段: 先删掉旧文件再写 (可能是权限/占用问题)
    try {
      fs.rmSync(CFG_FILE, { force: true });
      fs.writeFileSync(CFG_FILE, data, 'utf8');
    } catch (e2) {
      throw new Error('无法保存配置到 U 盘: ' + e2.message + '（请检查 U 盘是否写保护或已满）');
    }
  }
}

/* ---------- 授权码加密 (AES-256-GCM) ----------
 * 密钥 = U盘 data/ 目录下的随机密钥文件 (data/.keyfile)
 *
 * 为什么不用「机器名+路径」派生: 那样把 usbmail 文件夹拷到 U 盘、
 * 或换个盘符/用户名, 密文就解不开了 —— 而"拷到U盘带走"正是主要用法。
 * 现在密钥随文件夹一起走, 复制到哪都能解开。
 *
 * 诚实说明它防住的是: 别人只看到 config.json 时, 看不到明文授权码。
 * 它防不住: 拿到整个 U 盘的人 (密钥文件也在盘上)。
 * 这是"不裸奔", 不是保险箱。
 */

let _keyCache = null;

function machineKey() {
  if (_keyCache) return _keyCache;
  const keyFile = path.join(DATA_DIR, '.keyfile');
  try {
    const b = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');
    if (b.length === 32) { _keyCache = b; return b; }
  } catch (_) {}
  // 首次运行: 生成密钥文件 (尽量藏起来)
  const k = crypto.randomBytes(32);
  try {
    fs.writeFileSync(keyFile, k.toString('hex'), { mode: 0o600 });
    try { fs.chmodSync(keyFile, 0o600); } catch (_) {}
  } catch (_) {}
  _keyCache = k;
  return k;
}

function encrypt(text) {
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', machineKey(), iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}

function decrypt(payload) {
  if (!payload) return '';
  try {
    const b = Buffer.from(payload, 'base64');
    const iv = b.slice(0, 12), tag = b.slice(12, 28), data = b.slice(28);
    const d = crypto.createDecipheriv('aes-256-gcm', machineKey(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString('utf8');
  } catch (_) {
    return '';
  }
}

/** 判断某个账户的授权码能否在本机(U盘当前位置)解密 */
function canDecrypt(acc) {
  if (!acc || !acc.passEnc) return false;
  const p = decrypt(acc.passEnc);
  return typeof p === 'string' && p.length > 0;
}

/* ---------- 常见服务商预设 ---------- */

const PRESETS = {
  qq:   { label: 'QQ邮箱',   host: 'imap.qq.com',   port: 993, secure: true, hint: '设置→账户→开启IMAP/SMTP→生成授权码' },
  '163':{ label: '163邮箱',  host: 'imap.163.com',  port: 993, secure: true, hint: '设置→POP3/SMTP/IMAP→开启IMAP→获取授权码' },
  '126':{ label: '126邮箱',  host: 'imap.126.com',  port: 993, secure: true, hint: '同163, 需获取授权码' },
  gmail:{ label: 'Gmail',    host: 'imap.gmail.com',port: 993, secure: true, hint: '需开启两步验证并生成应用专用密码' },
  outlook:{ label:'Outlook', host: 'outlook.office365.com', port: 993, secure: true, hint: '需开启双重验证并生成应用密码' },
  custom:{ label:'自定义',   host: '',              port: 993, secure: true, hint: '填入服务商提供的 IMAP 服务器地址' },
};

/* ---------- IMAP 连接池 ---------- */

const pool = new Map(); // accountId -> {client, ts, box}
/* 每条 IMAP 连接同一时刻只能跑一条命令。前端会并行请求
 * (例如同时刷新文件夹列表和邮件列表), 若不串行化, 两条命令会
 * 在同一条 socket 上交错写入并互相打乱响应, 导致莫名其妙的失败。 */
const locks = new Map(); // accountId -> Promise

function withLock(accId, fn) {
  const prev = locks.get(accId) || Promise.resolve();
  const next = prev.then(fn, fn);
  // 保存一个不会 reject 的尾巴, 避免队列被单次失败卡死
  locks.set(accId, next.then(() => {}, () => {}));
  return next;
}

function accountById(cfg, id) {
  return cfg.accounts.find((a) => a.id === id) || cfg.accounts[0] || null;
}

async function getClient(cfg, acc) {
  const key = acc.id;
  let entry = pool.get(key);
  if (entry && entry.client && entry.client.ready) return entry;
  if (entry) { try { entry.client.close(); } catch (_) {} }
  const pass = decrypt(acc.passEnc);
  if (!pass) {
    throw new Error('这个账户的授权码无法读取（可能是从别的电脑拷过来的旧配置）。'
      + '请在设置里删除该账户，用授权码重新添加一次。');
  }
  const client = new ImapClient({
    host: acc.host,
    port: acc.port || 993,
    secure: acc.secure !== false,
    user: acc.email,
    pass,
    timeout: 30000,
  });
  await client.login();
  // 163 需要 ID 命令才允许取信
  try {
    if (/163\.com|126\.com/i.test(acc.host)) {
      await client.exec('ID ("name" "usbmail" "version" "1.0" "vendor" "usbmail")');
    }
  } catch (_) {}
  entry = { client, ts: Date.now(), box: null };
  pool.set(key, entry);
  return entry;
}

async function ensureBox(cfg, acc, box) {
  const entry = await getClient(cfg, acc);
  const name = box || 'INBOX';
  if (entry.box !== name) {
    await entry.client.select(name);
    entry.box = name;
  }
  return entry;
}

/* ---------- 正文缓存 (U盘上, 换机器也能读) ---------- */

function cacheKey(accId, uid) {
  return crypto.createHash('sha1').update(accId + ':' + uid).digest('hex');
}

function readCache(accId, uid) {
  const f = path.join(CACHE_DIR, cacheKey(accId, uid) + '.json');
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; }
}

function writeCache(accId, uid, obj) {
  try {
    fs.writeFileSync(path.join(CACHE_DIR, cacheKey(accId, uid) + '.json'), JSON.stringify(obj), 'utf8');
  } catch (_) {}
}

/* ---------- 工具 ---------- */

function addrList(s) {
  if (!s) return [];
  const { decodeMimeWords } = require('./imap');
  return String(s).split(/,(?![^<]*>)/).map((x) => {
    const m = /^\s*(?:"?([^"<]*)"?\s*)?<([^>]+)>/.exec(x);
    if (m) return { name: decodeMimeWords((m[1] || '').trim()), email: (m[2] || '').trim() };
    return { name: '', email: decodeMimeWords(x.trim()) };
  }).filter((a) => a.email);
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > 20 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
};

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = path.join(PUBLIC_DIR, rel);
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404'); return; }
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

/* ---------- API 路由 ---------- */

async function handleApi(req, res, urlPath) {
  const cfg = loadCfg();
  const q = new URL(urlPath, 'http://x').searchParams;
  const route = urlPath.split('?')[0];

  /* --- 预设 --- */
  if (route === '/api/presets') return json(res, 200, { presets: PRESETS });

  /* --- 账户 --- */
  if (route === '/api/accounts' && req.method === 'GET') {
    return json(res, 200, {
      accounts: cfg.accounts.map((a) => ({
        id: a.id, label: a.label, email: a.email, host: a.host,
        port: a.port, secure: a.secure !== false,
        // 如果这条授权码在本机解不开(例如从别处拷来的旧密文), 前端据此提示重新输入
        ok: canDecrypt(a),
      })),
      activeId: cfg.activeId,
      settings: cfg.settings,
    });
  }

  if (route === '/api/accounts' && req.method === 'POST') {
    const b = await readBody(req);
    const acc = {
      id: crypto.randomUUID(),
      label: b.label || b.email || '邮箱',
      email: b.email,
      host: b.host,
      port: Number(b.port) || 993,
      secure: b.secure !== false,
      passEnc: encrypt(b.pass || ''),
    };
    if (!acc.email || !acc.host || !b.pass) return json(res, 400, { error: '请填写邮箱、IMAP服务器和授权码' });

    // 立即验证凭据, 避免存下错配置
    try {
      const c = new ImapClient({ host: acc.host, port: acc.port, secure: acc.secure, user: acc.email, pass: b.pass, timeout: 20000 });
      await c.login();
      try {
        if (/163\.com|126\.com/i.test(acc.host)) {
          await c.exec('ID ("name" "usbmail" "version" "1.0" "vendor" "usbmail")');
        }
        await c.select('INBOX');
      } catch (_) {}
      c.close();
    } catch (e) {
      const msg = /授权码|AUTHENTICATIONFAILED|LOGIN|invalid/i.test(e.message)
        ? '登录失败：QQ/163 邮箱必须使用「授权码」，不是网页登录密码。请在邮箱设置里开启 IMAP 并生成授权码。'
        : ('连接失败：' + e.message);
      return json(res, 400, { error: msg });
    }

    cfg.accounts.push(acc);
    cfg.activeId = acc.id;
    saveCfg(cfg);
    return json(res, 200, { ok: true, id: acc.id });
  }

  if (route === '/api/accounts' && req.method === 'DELETE') {
    const id = q.get('id');
    const acc = cfg.accounts.find((a) => a.id === id);
    if (acc) { try { const e = pool.get(id); if (e) e.client.close(); } catch (_) {} pool.delete(id); }
    cfg.accounts = cfg.accounts.filter((a) => a.id !== id);
    if (cfg.activeId === id) cfg.activeId = cfg.accounts[0] ? cfg.accounts[0].id : null;
    saveCfg(cfg);
    return json(res, 200, { ok: true });
  }

  if (route === '/api/accounts/active' && req.method === 'POST') {
    const b = await readBody(req);
    cfg.activeId = b.id;
    saveCfg(cfg);
    return json(res, 200, { ok: true });
  }

  /* --- 设置 --- */
  if (route === '/api/settings' && req.method === 'POST') {
    const b = await readBody(req);
    cfg.settings = { ...cfg.settings, ...b };
    saveCfg(cfg);
    return json(res, 200, { ok: true, settings: cfg.settings });
  }

  /* --- 测试连接 --- */
  if (route === '/api/test' && req.method === 'POST') {
    const b = await readBody(req);
    try {
      const c = new ImapClient({ host: b.host, port: Number(b.port) || 993, secure: b.secure !== false, user: b.email, pass: b.pass, timeout: 20000 });
      await c.login();
      if (/163\.com|126\.com/i.test(b.host)) {
        try { await c.exec('ID ("name" "usbmail" "version" "1.0" "vendor" "usbmail")'); } catch (_) {}
      }
      const boxes = await c.listMailboxes();
      const info = await c.select('INBOX');
      c.close();
      return json(res, 200, { ok: true, count: info.exists, mailboxes: boxes.map((x) => x.name) });
    } catch (e) {
      return json(res, 400, { ok: false, error: e.message });
    }
  }

  /* --- 邮件列表 --- */
  if (route === '/api/messages') {
    const acc = accountById(cfg, q.get('account') || cfg.activeId);
    if (!acc) return json(res, 400, { error: '请先添加邮箱账户' });
    const box = q.get('box') || 'INBOX';
    const limit = Math.min(Number(q.get('limit')) || cfg.settings.pageSize, cfg.settings.maxFetch);
    try {
      return await withLock(acc.id, async () => {
        const entry = await ensureBox(cfg, acc, box);
        const uids = await entry.client.searchRecent(limit);
        if (!uids.length) return json(res, 200, { messages: [], box, total: 0 });
        const list = await entry.client.fetchHeaders(uids);
        const byUid = new Map(list.map((m) => [m.uid, m]));
        const ordered = uids.map((u) => byUid.get(u)).filter(Boolean);
        return json(res, 200, {
          messages: ordered.map((m) => ({
            ...m,
            fromList: addrList(m.from),
            toList: addrList(m.to),
          })),
          box, total: ordered.length,
        });
      });
    } catch (e) {
      pool.delete(acc.id);
      return json(res, 500, { error: '收取失败：' + e.message });
    }
  }

  /* --- 邮件正文 --- */
  if (route === '/api/message') {
    const acc = accountById(cfg, q.get('account') || cfg.activeId);
    if (!acc) return json(res, 400, { error: '无账户' });
    const uid = Number(q.get('uid'));
    const box = q.get('box') || 'INBOX';
    if (!uid) return json(res, 400, { error: '缺少 uid' });

    let cached = readCache(acc.id, uid);
    if (cached && cached.box === box) {
      return json(res, 200, { ...cached, cached: true });
    }
    try {
      return await withLock(acc.id, async () => {
        const entry = await ensureBox(cfg, acc, box);
        const raw = await entry.client.fetchBody(uid);
        const parsed = parseMime(raw);
        // 用统一helper解码头部: 处理 binary->utf8 与 RFC2047
        const h = extractHeaders(raw);
        const { decodeMimeWords } = require('./imap');
        const out = {
          uid,
          box,
          subject: decodeMimeWords(h.subject || '') || '(无主题)',
          from: decodeMimeWords(h.from || ''), to: decodeMimeWords(h.to || ''), cc: decodeMimeWords(h.cc || ''),
          fromList: addrList(h.from), toList: addrList(h.to), ccList: addrList(h.cc),
          date: h.date || '', ts: Date.parse(h.date) || 0,
          html: parsed.html || '',
          text: parsed.text || '',
          attachments: parsed.attachments.map((a) => ({
            filename: a.filename, mime: a.mime, size: a.size, data: a.data,
          })),
        };
        writeCache(acc.id, uid, out);
        if (cfg.settings.markSeen) {
          try { await entry.client.setFlag(uid, '\\Seen', true); } catch (_) {}
        }
        return json(res, 200, out);
      });
    } catch (e) {
      pool.delete(acc.id);
      return json(res, 500, { error: '读取失败：' + e.message });
    }
  }

  /* --- 已读标记 --- */
  if (route === '/api/flag' && req.method === 'POST') {
    const b = await readBody(req);
    const acc = accountById(cfg, b.account || cfg.activeId);
    if (!acc) return json(res, 400, { error: '无账户' });
    try {
      return await withLock(acc.id, async () => {
        const entry = await ensureBox(cfg, acc, b.box || 'INBOX');
        await entry.client.setFlag(Number(b.uid), b.flag || '\\Seen', b.add !== false);
        return json(res, 200, { ok: true });
      });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  /* --- 邮箱文件夹 --- */
  if (route === '/api/boxes') {
    const acc = accountById(cfg, q.get('account') || cfg.activeId);
    if (!acc) return json(res, 400, { error: '无账户' });
    try {
      return await withLock(acc.id, async () => {
        const entry = await getClient(cfg, acc);
        const boxes = await entry.client.listMailboxes();
        return json(res, 200, { boxes });
      });
    } catch (e) {
      pool.delete(acc.id);
      return json(res, 500, { error: e.message });
    }
  }

  /* --- 从 U盘导出/备份 --- */
  if (route === '/api/export') {
    const safe = cfg.accounts.map((a) => ({ ...a, passEnc: undefined, hasPass: !!a.passEnc }));
    return json(res, 200, { exportedAt: new Date().toISOString(), accounts: safe, settings: cfg.settings });
  }

  return json(res, 404, { error: 'not found' });
}

/* ---------- 启动 ---------- */

const server = http.createServer((req, res) => {
  const urlPath = req.url || '/';
  if (urlPath.startsWith('/api/')) {
    handleApi(req, res, urlPath).catch((e) => {
      try { json(res, 500, { error: e.message }); } catch (_) {}
    });
    return;
  }
  serveStatic(req, res, urlPath);
});

function listen(port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server.address().port));
  });
}

(async () => {
  const want = Number(process.env.PORT) || 8787;
  const host = process.env.HOST || '127.0.0.1';
  let port = want;
  for (let i = 0; i < 20; i++) {
    try {
      port = await listen(want + i, host);
      break;
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
      if (i === 19) throw new Error('端口被占用');
    }
  }
  const url = `http://${host}:${port}/`;
  console.log('');
  console.log('  ┌──────────────────────────────────────────┐');
  console.log('  │   U盘邮 已启动                            │');
  console.log('  └──────────────────────────────────────────┘');
  console.log('   请在浏览器打开:  ' + url);
  console.log('   数据保存在:      ' + DATA_DIR);
  console.log('   关闭此窗口即停止服务。');
  console.log('');
  if (process.env.OPEN_BROWSER !== '0') {
    const { spawn } = require('child_process');
    try {
      if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
      else if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
      else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    } catch (_) {}
  }
  // pid 文件只是方便排查, 绝不能因为它写不进去就让整个服务崩掉。
  // 在某些 U 盘 (exFAT/noowners) 或只读介质上, 覆盖已存在的文件会抛 EPERM。
  const pidFile = path.join(DATA_DIR, 'server.pid');
  try {
    fs.writeFileSync(pidFile, String(process.pid));
  } catch (_) {
    try { fs.rmSync(pidFile, { force: true }); fs.writeFileSync(pidFile, String(process.pid)); } catch (__) {}
  }
  const shutdown = () => {
    for (const [, e] of pool) { try { e.client.close(); } catch (_) {} }
    try { fs.unlinkSync(path.join(DATA_DIR, 'server.pid')); } catch (_) {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
})().catch((e) => {
  console.error('启动失败: ' + e.message);
  process.exit(1);
});
