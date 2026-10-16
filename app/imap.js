'use strict';
/**
 * 零依赖 IMAP4rev1 客户端 (仅用 Node 内置 tls/net)
 * 支持: 登录、列表邮箱、选箱、按 UID 拉取头部/正文/附件
 * 面向 QQ邮箱 / 163邮箱 / 任意标准 IMAP 服务器
 */
const tls = require('tls');
const net = require('net');
const { EventEmitter } = require('events');

const CRLF = '\r\n';

class ImapClient extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.socket = null;
    this.buf = '';
    this.tagN = 0;
    this.pending = new Map(); // tag -> {resolve, reject, lines, literals}
    this.ready = false;
    this.capabilities = [];
    this._collector = null;
  }

  _tag() {
    this.tagN += 1;
    return 'A' + String(this.tagN).padStart(4, '0');
  }

  connect() {
    const { host, port, secure, servername } = this.opts;
    return new Promise((resolve, reject) => {
      const onError = (err) => reject(err);
      const onReady = () => {
        this.socket.removeListener('error', onError);
        this.ready = true;
        resolve();
      };
      if (secure) {
        this.socket = tls.connect(
          { host, port, servername: servername || host, rejectUnauthorized: false },
          onReady
        );
      } else {
        this.socket = net.connect({ host, port }, onReady);
      }
      this.socket.setTimeout(this.opts.timeout || 30000, () => {
        this.socket.destroy(new Error('IMAP 连接超时'));
      });
      this.socket.once('error', onError);
      this.socket.on('data', (d) => this._onData(d));
      this.socket.on('close', () => {
        this.ready = false;
        for (const [, p] of this.pending) p.reject(new Error('连接已关闭'));
        this.pending.clear();
      });
    });
  }

  _onData(chunk) {
    this.buf += chunk.toString('binary');
    this._parse();
  }

  /**
   * 逐行解析。IMAP 的 literal 形如 {123}\r\n<123 bytes>
   * 关键点: literal 前缀本身是一行的一部分, 例如
   *   * 1 FETCH (UID 103 BODY[...] {57}\r\n<57 bytes>)\r\n
   * 必须把 "{57}" 之前的文本先作为一行交出去, 否则 FETCH 起始行会丢失。
   */
  _parse() {
    while (true) {
      const nl = this.buf.indexOf('\n');
      if (nl === -1) return;
      const line = this.buf.slice(0, nl + 1);
      const lit = /\{(\d+)\}\r?\n$/.exec(line);
      if (lit) {
        const size = parseInt(lit[1], 10);
        if (this.buf.length < nl + 1 + size) return; // 等待 literal 到齐
        const prefix = line.slice(0, lit.index);
        const payload = this.buf.slice(nl + 1, nl + 1 + size);
        this.buf = this.buf.slice(nl + 1 + size);
        if (prefix.trim()) this._push('LINE', prefix.replace(/\r?\n$/, ''));
        this._push('LIT:' + size, payload);
        continue;
      }
      this.buf = this.buf.slice(nl + 1);
      this._push('LINE', line.replace(/\r?\n$/, ''));
    }
  }

  _push(kind, value) {
    if (this._collector) {
      this._collector.push({ kind, value });
      this._checkCollectorDone();
      return;
    }
    // 无 collector: 解析 untagged 响应 / 完成 tagged 响应
    if (kind === 'LINE') {
      const m = /^(\S+)\s+(OK|NO|BAD|BYE|PREAUTH)\b(.*)$/i.exec(value);
      if (m && this.pending.has(m[1])) {
        const p = this.pending.get(m[1]);
        this.pending.delete(m[1]);
        const status = m[2].toUpperCase();
        if (status === 'OK' || status === 'PREAUTH') p.resolve({ status, text: m[3].trim(), lines: p.lines });
        else p.reject(new Error('IMAP ' + status + ': ' + m[3].trim()));
        return;
      }
      if (/^\*\s+CAPABILITY/i.test(value)) {
        this.capabilities = value.replace(/^\*\s+CAPABILITY\s*/i, '').trim().split(/\s+/);
      }
      this.emit('untagged', value);
    }
  }

  /**
   * 执行一条命令并收集其全部响应（含 literals）。
   * 返回 { status, text, items:[{kind,value}] }
   */
  exec(command, opts = {}) {
    const tag = this._tag();
    const full = tag + ' ' + command + CRLF;
    return new Promise((resolve, reject) => {
      const p = { resolve, reject, lines: [] };
      this.pending.set(tag, p);
      this._collector = [];
      this._activeTag = tag;

      const timer = setTimeout(() => {
        if (this.pending.has(tag)) {
          this.pending.delete(tag);
          this._collector = null;
          reject(new Error('IMAP 命令超时: ' + command.split(' ')[0]));
        }
      }, opts.timeout || 60000);

      const done = () => clearTimeout(timer);
      p.resolve = (v) => { done(); resolve(v); };
      p.reject = (e) => { done(); reject(e); };

      p.collector = this._collector;
      this._checkCollectorDone = () => {
        const c = this._collector;
        if (!c) return;
        const last = c[c.length - 1];
        if (last && last.kind === 'LINE') {
          const m = /^(\S+)\s+(OK|NO|BAD|BYE|PREAUTH)\b(.*)$/i.exec(last.value);
          if (m && m[1] === this._activeTag) {
            this._collector = null;
            this._checkCollectorDone = null;
            const status = m[2].toUpperCase();
            const text = m[3].trim();
            const items = c.slice(0, -1);
            if (status === 'OK') p.resolve({ status, text, items });
            else p.reject(new Error('IMAP ' + status + ': ' + text));
            return;
          }
        }
        // 防止永久挂起: 命令执行期间若 collector 一直没有 tagged 结束
        if (c.length > 500000) {
          this._collector = null;
          p.reject(new Error('响应过大'));
        }
      };

      this.socket.write(full, 'binary');
    });
  }

  async login() {
    await this.connect();
    await this.exec('CAPABILITY');
    const cap = this.capabilities.join(' ').toUpperCase();
    const { user, pass } = this.opts;
    const esc = (s) => '"' + String(s).replace(/([\\"])/g, '\\$1') + '"';
    // 优先 AUTH=PLAIN / LOGIN, 否则用 LOGIN 命令 (QQ/163 都支持 LOGIN)
    try {
      const r = await this.exec('LOGIN ' + esc(user) + ' ' + esc(pass));
      return r;
    } catch (e) {
      if (/AUTHENTICATIONFAILED|invalid|unable/i.test(e.message)) {
        throw new Error('邮箱账号或授权码错误（QQ/163 需使用「授权码」而非登录密码）');
      }
      throw e;
    }
  }

  async listMailboxes() {
    const r = await this.exec('LIST "" "*"');
    const boxes = [];
    for (const it of r.items) {
      if (it.kind !== 'LINE') continue;
      const line = it.value;
      if (!/^\*\s+LIST/i.test(line)) continue;
      const m = /^\*\s+LIST\s+\((?<flags>[^)]*)\)\s+(?<delim>"(?:[^"]*)"|NIL)\s+(?<name>.+)$/i.exec(line);
      if (!m) continue;
      let name = m.groups.name.trim();
      if (name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1).replace(/\\(.)/g, '$1');
      boxes.push({ name, flags: m.groups.flags.trim().split(/\s+/).filter(Boolean) });
    }
    return boxes;
  }

  /**
   * 解析 FETCH 响应里的 literal 段落, 组装出原始 RFC822 文本。
   * 响应形状多样, 例如:
   *   * 1 FETCH (UID 1 BODY[] {57}\r\n<data>)\r\n
   *   * 1 FETCH (UID 1 BODY[] {57}\r\n<data> UID 1)\r\n     <- literal 后还有内容
   *   * 1 FETCH (UID 1 FLAGS (\Seen))\r\n                     <- 无 literal
   */
  static assembleFetch(items) {
    const out = [];
    let cur = null;
    for (const it of items) {
      if (it.kind === 'LINE') {
        const v = it.value;
        if (/^\*\s+\d+\s+FETCH/i.test(v)) {
          cur = { head: v, parts: [], tail: '' };
          out.push(cur);
          // 同一行内闭合 (无 literal 的情况)
          if (/\)\s*$/.test(v)) cur = null;
          continue;
        }
        if (cur) {
          cur.tail += (cur.tail ? ' ' : '') + v.trim();
          if (/\)\s*$/.test(v)) cur = null;
        }
      } else if (it.kind.startsWith('LIT:') && cur) {
        cur.parts.push(it.value);
      }
    }
    return out;
  }

  async select(mailbox, readonly = true) {
    const esc = '"' + mailbox.replace(/([\\"])/g, '\\$1') + '"';
    const r = await this.exec('SELECT ' + esc + (readonly ? '' : ''));
    const info = { exists: 0, uidvalidity: 0, uidnext: 0 };
    for (const it of r.items) {
      if (it.kind !== 'LINE') continue;
      let m;
      if ((m = /^\*\s+(\d+)\s+EXISTS/i.exec(it.value))) info.exists = parseInt(m[1], 10);
      if ((m = /UIDVALIDITY\s+(\d+)/i.exec(it.value))) info.uidvalidity = parseInt(m[1], 10);
      if ((m = /UIDNEXT\s+(\d+)/i.exec(it.value))) info.uidnext = parseInt(m[1], 10);
    }
    return info;
  }

  /** 拉取最近 N 封的 UID 列表 (倒序) */
  async searchRecent(limit) {
    const r = await this.exec('UID SEARCH ALL');
    let uids = [];
    for (const it of r.items) {
      if (it.kind !== 'LINE') continue;
      const m = /^\*\s+SEARCH(?: (.*))?$/i.exec(it.value);
      if (m) uids = (m[1] || '').trim().split(/\s+/).filter(Boolean).map(Number);
    }
    uids.sort((a, b) => a - b);
    return uids.slice(-limit).reverse();
  }

  async fetchHeaders(uids) {
    if (!uids.length) return [];
    const set = uids.join(',');
    const cmd =
      'UID FETCH ' + set + ' (UID FLAGS RFC822.SIZE BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID IN-REPLY-TO)])';
    const r = await this.exec(cmd, { timeout: 120000 });
    const groups = ImapClient.assembleFetch(r.items);
    return groups.map((g) => {
      const uidM = /UID\s+(\d+)/i.exec(g.head);
      const sizeM = /RFC822\.SIZE\s+(\d+)/i.exec(g.head);
      const flagM = /FLAGS\s+\(([^)]*)\)/i.exec(g.head);
      const raw = g.parts.map((p) => Buffer.from(p, 'binary').toString('utf8')).join('');
      const h = parseHeaders(raw);
      return {
        uid: uidM ? parseInt(uidM[1], 10) : 0,
        size: sizeM ? parseInt(sizeM[1], 10) : 0,
        seen: /\\Seen/i.test(flagM ? flagM[1] : ''),
        flagged: /\\Flagged/i.test(flagM ? flagM[1] : ''),
        // 头部可能含 RFC2047 编码字 (=?UTF-8?B?...?=), 必须在这里就解码,
        // 否则列表页会直接显示乱码原文。
        from: decodeMimeWords(h.from || ''),
        to: decodeMimeWords(h.to || ''),
        cc: decodeMimeWords(h.cc || ''),
        subject: decodeMimeWords(h.subject || '') || '(无主题)',
        date: h.date || '',
        ts: parseDate(h.date),
        messageId: h['message-id'] || '',
      };
    }).filter((x) => x.uid);
  }

  async fetchBody(uid) {
    const r = await this.exec('UID FETCH ' + uid + ' (BODY.PEEK[])', { timeout: 120000 });
    const groups = ImapClient.assembleFetch(r.items);
    if (!groups.length) throw new Error('邮件不存在');
    const raw = groups[0].parts.map((p) => p).join('');
    return raw; // binary string
  }

  async setFlag(uid, flag, add) {
    const cmd = (add ? 'UID STORE ' + uid + ' +FLAGS.SILENT (' : 'UID STORE ' + uid + ' -FLAGS.SILENT (') + flag + ')';
    return this.exec(cmd);
  }

  close() {
    try {
      if (this.socket && this.ready) this.socket.write('ZZZZ LOGOUT' + CRLF, 'binary');
      if (this.socket) this.socket.end();
    } catch (_) {}
    this.ready = false;
  }
}

/* ---------------- 头部解析工具 ---------------- */

function parseHeaders(raw) {
  const out = {};
  const lines = raw.split(/\r?\n/);
  let key = null;
  for (const line of lines) {
    if (!line) continue;
    if (/^\s/.test(line) && key) {
      out[key] += ' ' + line.trim();
      continue;
    }
    const i = line.indexOf(':');
    if (i === -1) continue;
    key = line.slice(0, i).trim().toLowerCase();
    out[key] = line.slice(i + 1).trim();
  }
  return out;
}

function parseDate(s) {
  if (!s) return 0;
  const t = Date.parse(s);
  return isNaN(t) ? 0 : t;
}

/** 从 Content-Type 头里取 boundary / charset / mime */
function parseContentType(v) {
  if (!v) return { mime: 'text/plain', charset: 'utf-8', boundary: null };
  const mime = (v.split(';')[0] || 'text/plain').trim().toLowerCase();
  const b = /boundary\s*=\s*("([^"]+)"|([^;\s]+))/i.exec(v);
  const c = /charset\s*=\s*"?([^";\s]+)"?/i.exec(v);
  const name = /name\s*=\s*("([^"]*)"|([^;\s]+))/i.exec(v);
  return {
    mime,
    charset: (c ? c[1] : 'utf-8').toLowerCase(),
    boundary: b ? (b[2] || b[3]) : null,
    name: name ? decodeMimeWords(name[2] || name[3] || '') : null,
  };
}

/* ---------------- MIME 解码 ---------------- */

const ENC = {
  'base64': (s) => Buffer.from(s.replace(/\s+/g, ''), 'base64'),
  'quoted-printable': (s) => {
    const body = s.replace(/=\r?\n/g, '');
    const bytes = [];
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (ch === '=' && i + 2 < body.length + 1) {
        const hex = body.slice(i + 1, i + 3);
        if (/^[0-9A-Fa-f]{2}$/.test(hex)) { bytes.push(parseInt(hex, 16)); i += 2; continue; }
      }
      bytes.push(ch.charCodeAt(0) & 0xff);
    }
    return Buffer.from(bytes);
  },
};

function decodeMimeWords(s) {
  if (!s) return '';
  // RFC 2047: 相邻的两个编码字之间若只有空白, 该空白必须被丢弃。
  // 例: "=?UTF-8?B?6LSi?= =?UTF-8?B?5Yqh6YOo?=" -> "财务部" (而不是 "财 务部")
  const joined = String(s).replace(/(\?=)\s+(=\?)/g, '$1$2');
  return joined.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, cs, enc, data) => {
    try {
      let buf;
      if (enc.toUpperCase() === 'B') buf = Buffer.from(data, 'base64');
      else buf = ENC['quoted-printable'](data.replace(/_/g, ' '));
      return bufferToString(buf, cs);
    } catch (_) {
      return data;
    }
  });
}

/** 把字节按 charset 转成 JS 字符串。Node 内置 ICU 已支持 gbk/gb18030/big5 等中文编码 */
function bufferToString(buf, charset) {
  const cs = (charset || 'utf-8').toLowerCase().replace(/^"|"$/g, '').trim();
  const norm = (cs === 'gb2312' || cs === 'gbk' || cs === 'gb18030') ? 'gb18030'
    : cs === 'utf8' ? 'utf-8'
    : cs === 'latin1' ? 'windows-1252'
    : cs || 'utf-8';
  try {
    return new TextDecoder(norm, { fatal: false }).decode(buf);
  } catch (_) {
    // 未知编码名: 先按 UTF-8 试, 出现替换符再退回 latin1
    try {
      const s = new TextDecoder('utf-8', { fatal: false }).decode(buf);
      if (!s.includes('\uFFFD')) return s;
    } catch (__) {}
    try { return new TextDecoder('gb18030', { fatal: false }).decode(buf); } catch (__) {}
    return buf.toString('latin1');
  }
}

/* ---------------- 邮件正文提取 ---------------- */

function splitParts(raw) {
  // 按空行分离头部与正文 (binary string)
  const idx = raw.search(/\r?\n\r?\n/);
  if (idx === -1) return { head: raw, body: '' };
  const sep = /\r\n\r\n/.test(raw.slice(idx, idx + 4)) ? 4 : 2;
  return { head: raw.slice(0, idx), body: raw.slice(idx + sep) };
}

/**
 * 递归解析 MIME, 返回 { text, html, attachments:[] }
 */
function parseMime(raw) {
  const { head, body } = splitParts(raw);
  const h = parseHeaders(head);
  const ct = parseContentType(h['content-type']);
  const cte = (h['content-transfer-encoding'] || '').toLowerCase().trim();
  const disp = h['content-disposition'] || '';

  if (ct.mime.startsWith('multipart/') && ct.boundary) {
    const segs = splitByBoundary(body, ct.boundary);
    const result = { text: '', html: '', attachments: [] };
    for (const seg of segs) {
      if (!seg.trim()) continue;
      // parseMime 已经会把这个分段自身的附件放进 sub.attachments,
      // 所以只取 sub 的结果, 不能再单独调一次 getSubDisposition(会重复计入)。
      const sub = parseMime(seg);
      if (sub.text && !result.text) result.text = sub.text;
      if (sub.html && !result.html) result.html = sub.html;
      for (const a of sub.attachments) {
        // 去重: 同一文件名+大小只保留一次 (嵌套 multipart 可能重复上报)
        if (!result.attachments.some((x) => x.filename === a.filename && x.size === a.size)) {
          result.attachments.push(a);
        }
      }
    }
    return result;
  }

  let bytes;
  if (cte === 'base64') bytes = ENC['base64'](body);
  else if (cte === 'quoted-printable') bytes = ENC['quoted-printable'](body);
  else bytes = Buffer.from(body, 'binary');

  const isAttachment = /attachment/i.test(disp) || (!!ct.name && !ct.mime.startsWith('text/'));

  if (isAttachment) {
    const fnMatch = /filename\s*=\s*("([^"]*)"|([^;\s]+))/i.exec(disp);
    let filename = fnMatch ? decodeMimeWords((fnMatch[2] || fnMatch[3] || '').replace(/^"|"$/g, '')) : '';
    if (!filename) filename = ct.name || 'attachment';
    return {
      text: '', html: '',
      attachments: [{
        filename,
        mime: ct.mime,
        size: bytes.length,
        data: bytes.toString('base64'),
      }],
    };
  }

  if (ct.mime === 'text/html') {
    return { text: '', html: bufferToString(bytes, ct.charset), attachments: [] };
  }
  if (ct.mime === 'text/plain') {
    return { text: bufferToString(bytes, ct.charset), html: '', attachments: [] };
  }
  return { text: '', html: '', attachments: [] };
}

function getSubDisposition(seg) {
  const { head } = splitParts(seg);
  const h = parseHeaders(head);
  const disp = h['content-disposition'] || '';
  const fn = /filename\s*=\s*("([^"]*)"|([^;\s]+))/i.exec(disp);
  if (!fn) return {};
  const { body } = splitParts(seg);
  const cte = (h['content-transfer-encoding'] || '').toLowerCase().trim();
  let bytes;
  if (cte === 'base64') bytes = ENC['base64'](body);
  else if (cte === 'quoted-printable') bytes = ENC['quoted-printable'](body);
  else bytes = Buffer.from(body, 'binary');
  const ct = parseContentType(h['content-type']);
  return {
    filename: decodeMimeWords((fn[2] || fn[3] || '').replace(/^"|"$/g, '')),
    mime: ct.mime,
    size: bytes.length,
    data: bytes.toString('base64'),
  };
}

/**
 * 从一封完整邮件的 binary string 中取出并解码头部。
 * 注意: 传入的是 binary(latin1) 字符串, 必须先按 UTF-8 还原成真正的文本,
 * 否则未编码的中文头部(如 Subject: 项目周报)会变成乱码。
 */
function extractHeaders(raw) {
  const head = splitParts(raw).head;
  return parseHeaders(Buffer.from(head, 'binary').toString('utf8'));
}

function splitByBoundary(body, boundary) {
  const marker = '--' + boundary;
  const parts = [];
  const lines = body.split(/\r?\n/);
  let cur = null;
  for (const line of lines) {
    if (line.trim() === marker) { if (cur) parts.push(cur.join('\r\n')); cur = []; continue; }
    if (line.trim() === marker + '--') { if (cur) parts.push(cur.join('\r\n')); cur = null; break; }
    if (cur) cur.push(line);
  }
  if (cur && cur.length) parts.push(cur.join('\r\n'));
  return parts;
}

module.exports = {
  ImapClient,
  parseHeaders,
  parseMime,
  parseContentType,
  decodeMimeWords,
  bufferToString,
  splitByBoundary,
  extractHeaders,
};
