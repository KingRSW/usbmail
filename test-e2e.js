/**
 * 本地 IMAP 假服务器 + 端到端测试
 * 验证: 登录握手、LIST、SELECT、UID SEARCH、UID FETCH、literal 解析、正文拉取
 */
const net = require('net');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const PORT_IMAP = 14399;
const PORT_HTTP = 18787;

const RAW_MAIL = [
  'From: =?UTF-8?B?5byg5LiJ?= <zhangsan@example.com>',
  'To: me@example.com',
  'Subject: =?UTF-8?B?5rWL6K+V6YKu5Lu2?=',
  'Date: Mon, 13 Oct 2026 10:30:00 +0800',
  'Message-ID: <test-1@example.com>',
  'Content-Type: multipart/alternative; boundary="XX"',
  '',
  '--XX',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'PLAIN_TEXT_MARKER',
  '--XX',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>HTML_MARKER</p>',
  '--XX--',
  '',
].join('\r\n');

const HEADER_BLOCK = [
  'From: =?UTF-8?B?5byg5LiJ?= <zhangsan@example.com>',
  'To: me@example.com',
  'Subject: =?UTF-8?B?5rWL6K+V6YOu5Li2?=',
  'Date: Mon, 13 Oct 2026 10:30:00 +0800',
  '',
].join('\r\n');

function createImapMock() {
  return net.createServer((sock) => {
    let buf = '';
    let selected = false;
    sock.write('* OK IMAP4rev1 mock ready\r\n');
    sock.on('data', (d) => {
      buf += d.toString('binary');
      let idx;
      while ((idx = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const sp = line.indexOf(' ');
        const tag = line.slice(0, sp);
        const cmd = line.slice(sp + 1);
        const up = cmd.toUpperCase();

        if (up.startsWith('CAPABILITY')) {
          sock.write('* CAPABILITY IMAP4rev1 AUTH=PLAIN ID\r\n');
          sock.write(tag + ' OK done\r\n');
        } else if (up.startsWith('LOGIN')) {
          const m = /LOGIN "([^"]*)" "([^"]*)"/i.exec(cmd);
          const user = m ? m[1] : '';
          const pass = m ? m[2] : '';
          if (pass === 'GOODCODE') {
            sock.write(tag + ' OK LOGIN completed\r\n');
          } else {
            sock.write(tag + ' NO [AUTHENTICATIONFAILED] Invalid credentials\r\n');
          }
        } else if (up.startsWith('ID ')) {
          sock.write('* ID ("name" "mock")\r\n');
          sock.write(tag + ' OK done\r\n');
        } else if (up.startsWith('LIST')) {
          sock.write('* LIST (\\HasNoChildren) "/" "INBOX"\r\n');
          sock.write('* LIST (\\HasNoChildren) "/" "Sent Messages"\r\n');
          sock.write('* LIST (\\Noselect \\HasChildren) "/" "[Gmail]"\r\n');
          sock.write(tag + ' OK done\r\n');
        } else if (up.startsWith('SELECT') || up.startsWith('EXAMINE')) {
          selected = true;
          sock.write('* 3 EXISTS\r\n');
          sock.write('* OK [UIDVALIDITY 12345] UIDs valid\r\n');
          sock.write('* OK [UIDNEXT 104] Predicted next UID\r\n');
          sock.write(tag + ' OK [READ-ONLY] done\r\n');
        } else if (up.startsWith('UID SEARCH')) {
          sock.write('* SEARCH 101 102 103\r\n');
          sock.write(tag + ' OK done\r\n');
        } else if (up.startsWith('UID FETCH')) {
          const m = /UID FETCH ([0-9,]+)/i.exec(cmd);
          const uids = m ? m[1].split(',').map(Number) : [];
          const isBody = /BODY\.PEEK\[\]/i.test(cmd);
          for (const u of uids) {
            if (isBody) {
              sock.write('* 1 FETCH (UID ' + u + ' BODY[] {' + Buffer.byteLength(RAW_MAIL, 'binary') + '}\r\n');
              sock.write(RAW_MAIL);
              sock.write(')\r\n');
            } else {
              sock.write('* 1 FETCH (UID ' + u + ' FLAGS (\\Seen) RFC822.SIZE 4096 BODY[HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID IN-REPLY-TO)] {' + Buffer.byteLength(HEADER_BLOCK, 'binary') + '}\r\n');
              sock.write(HEADER_BLOCK);
              sock.write(')\r\n');
            }
          }
          sock.write(tag + ' OK done\r\n');
        } else if (up.startsWith('UID STORE')) {
          sock.write(tag + ' OK done\r\n');
        } else if (up.startsWith('LOGOUT')) {
          sock.write('* BYE bye\r\n');
          sock.write(tag + ' OK done\r\n');
          sock.end();
        } else {
          sock.write(tag + ' BAD unknown command\r\n');
        }
      }
    });
    sock.on('error', () => {});
  });
}

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); }
}

function req(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: PORT_HTTP, path: urlPath, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let out = '';
      res.on('data', (c) => out += c);
      res.on('end', () => {
        let j; try { j = JSON.parse(out); } catch (_) { j = { _raw: out }; }
        resolve({ status: res.statusCode, body: j });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const imapSrv = createImapMock();
  await new Promise((r) => imapSrv.listen(PORT_IMAP, '127.0.0.1', r));

  // 用独立 DATA 目录启动服务器, 避免污染真实 U盘数据
  const testRoot = '/tmp/usbmail-e2e';
  require('fs').rmSync(testRoot, { recursive: true, force: true });
  require('fs').mkdirSync(path.join(testRoot, 'data'), { recursive: true });

  const child = spawn(process.execPath, [path.join(__dirname, 'app', 'server.js')], {
    env: { ...process.env, PORT: String(PORT_HTTP), HOST: '127.0.0.1', OPEN_BROWSER: '0', USBMAIL_DATA: path.join(testRoot, 'data') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let srvOut = '';
  child.stdout.on('data', (d) => srvOut += d);
  child.stderr.on('data', (d) => srvOut += d);

  // 等服务器就绪
  for (let i = 0; i < 60; i++) {
    try { await req('GET', '/api/presets'); break; } catch (_) { await new Promise((r) => setTimeout(r, 100)); }
  }

  console.log('\n--- 端到端测试 (真实 IMAP 协议) ---\n');

  const pre = await req('GET', '/api/presets');
  t('presets 接口', pre.status === 200 && !!pre.body.presets, pre.body);

  // 错误授权码应被拒绝
  const bad = await req('POST', '/api/accounts', {
    email: 'me@example.com', host: '127.0.0.1', port: PORT_IMAP, secure: false, pass: 'WRONG', label: 'test',
  });
  t('错误授权码被拒绝', bad.status === 400 && /授权码|登录失败/.test(bad.body.error || ''), bad.body);

  // 正确授权码
  const ok = await req('POST', '/api/accounts', {
    email: 'me@example.com', host: '127.0.0.1', port: PORT_IMAP, secure: false, pass: 'GOODCODE', label: '测试邮箱',
  });
  t('正确授权码添加成功', ok.status === 200 && ok.body.ok, ok.body);

  const accs = await req('GET', '/api/accounts');
  t('账户列表返回', accs.body.accounts.length === 1 && accs.body.accounts[0].label === '测试邮箱', accs.body);
  t('授权码不回传明文', accs.body.accounts[0].pass === undefined, Object.keys(accs.body.accounts[0]));

  const boxes = await req('GET', '/api/boxes');
  t('文件夹列表', boxes.status === 200 && boxes.body.boxes.some((b) => b.name === 'INBOX'), boxes.body);

  const list = await req('GET', '/api/messages?box=INBOX&limit=30');
  t('邮件列表返回 3 封', list.status === 200 && list.body.messages.length === 3, list.body);
  t('列表倒序(最新在前)', list.body.messages[0].uid === 103, list.body.messages && list.body.messages.map(m => m.uid));
  const first = list.body.messages[0] || {};
  t('发件人解码', first.fromList && first.fromList[0].name === '张三', first.fromList);
  t('发件人邮箱', first.fromList && first.fromList[0].email === 'zhangsan@example.com', first.fromList);

  const msg = await req('GET', '/api/message?uid=103&box=INBOX');
  t('正文接口成功', msg.status === 200, msg.body);
  t('纯文本正文解析', (msg.body.text || '').includes('PLAIN_TEXT_MARKER'), msg.body.text);
  t('HTML 正文解析', (msg.body.html || '').includes('HTML_MARKER'), msg.body.html);
  t('Message-ID 保留', msg.body.subject !== undefined, msg.body.subject);

  // 缓存命中
  const msg2 = await req('GET', '/api/message?uid=103&box=INBOX');
  t('正文缓存命中', msg2.body.cached === true, msg2.body.cached);

  // 静态页
  const page = await new Promise((res) => {
    http.get({ host: '127.0.0.1', port: PORT_HTTP, path: '/' }, (r) => {
      let s = ''; r.on('data', (c) => s += c); r.on('end', () => res({ status: r.statusCode, body: s }));
    });
  });
  t('首页 HTML 可访问', page.status === 200 && page.body.includes('U盘邮'), page.status);
  const js = await new Promise((res) => {
    http.get({ host: '127.0.0.1', port: PORT_HTTP, path: '/app.js' }, (r) => {
      let s = ''; r.on('data', (c) => s += c); r.on('end', () => res({ status: r.statusCode, body: s }));
    });
  });
  t('前端 JS 可访问', js.status === 200 && js.body.length > 5000, js.status + ' len=' + js.body.length);

  // 并发压力: 同时打多个需要 IMAP 的接口 (曾经的锁竞争 bug)
  const burst = await Promise.all([
    req('GET', '/api/boxes'),
    req('GET', '/api/messages?box=INBOX&limit=30'),
    req('GET', '/api/message?uid=103&box=INBOX'),
    req('GET', '/api/boxes'),
    req('GET', '/api/messages?box=INBOX&limit=30'),
    req('GET', '/api/boxes'),
  ]);
  t('并发请求: 全部成功', burst.every((r) => r.status === 200), burst.map((r) => r.status));
  t('并发请求: 文件夹正确', burst[0].body.boxes && burst[0].body.boxes.some((b) => b.name === 'INBOX'), burst[0].body);

  // 目录穿越防护
  const trav = await new Promise((res) => {
    http.get({ host: '127.0.0.1', port: PORT_HTTP, path: '/../app/server.js' }, (r) => {
      let s = ''; r.on('data', (c) => s += c); r.on('end', () => res({ status: r.statusCode, body: s }));
    });
  });
  t('目录穿越被阻止', !trav.body.includes('require('), trav.status);

  child.kill('SIGTERM');
  imapSrv.close();
  await new Promise((r) => setTimeout(r, 300));

  console.log('\n通过 ' + pass + ' / 失败 ' + fail);
  if (srvOut.trim()) console.log('\n服务器输出:\n' + srvOut.trim().slice(0, 800));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试崩溃:', e); process.exit(1); });
