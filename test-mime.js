const { parseMime, decodeMimeWords, parseHeaders, extractHeaders } = require('./app/imap');
let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? ' :: ' + extra : '')); }
}

// 1. 主题 MIME 编码
t('base64 UTF-8 主题', decodeMimeWords('=?UTF-8?B?5L2g5aW977yM5LiW55WM?=') === '你好，世界', decodeMimeWords('=?UTF-8?B?5L2g5aW977yM5LiW55WM?='));
t('Q-encoding 主题', decodeMimeWords('=?utf-8?Q?Hello_=E4=BD=A0=E5=A5=BD?=') === 'Hello 你好', decodeMimeWords('=?utf-8?Q?Hello_=E4=BD=A0=E5=A5=BD?='));

// 2. GBK 主题 (163 老邮件)
const gbkB64 = Buffer.from([0xC4, 0xE3, 0xBA, 0xC3]).toString('base64');
t('GBK 主题解码', decodeMimeWords('=?GBK?B?' + gbkB64 + '?=') === '你好', decodeMimeWords('=?GBK?B?' + gbkB64 + '?='));

// 3. quoted-printable 正文
const qp = 'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nHello=20World=0A=E4=BD=A0=E5=A5=BD';
const r3 = parseMime(qp);
t('QP 正文解码', r3.text.includes('Hello World') && r3.text.includes('你好'), JSON.stringify(r3.text));

// 4. multipart/alternative
const PLAIN = 'PLAIN_BODY_MARKER';
const HTMLM = 'HTML_BODY_MARKER';
const alt = [
  'Content-Type: multipart/alternative; boundary="BND1"', '',
  '--BND1', 'Content-Type: text/plain; charset=utf-8', '', PLAIN,
  '--BND1', 'Content-Type: text/html; charset=utf-8', '', '<b>' + HTMLM + '</b>',
  '--BND1--', ''].join('\r\n');
const r4 = parseMime(alt);
t('multipart: text 提取', r4.text.trim() === PLAIN, JSON.stringify(r4.text));
t('multipart: html 提取', r4.html.includes(HTMLM), JSON.stringify(r4.html));

// 5. 附件
const ATT_MARK = 'ATTACH_BODY_MARKER';
const withAtt = [
  'Content-Type: multipart/mixed; boundary="B2"', '',
  '--B2', 'Content-Type: text/plain; charset=utf-8', '', ATT_MARK,
  '--B2', 'Content-Type: application/pdf; name="report.pdf"',
  'Content-Transfer-Encoding: base64',
  'Content-Disposition: attachment; filename="report.pdf"', '',
  Buffer.from('PDFDATA').toString('base64'),
  '--B2--', ''].join('\r\n');
const r5 = parseMime(withAtt);
t('附件数量正确(不重复)', r5.attachments.length === 1, JSON.stringify(r5.attachments.map(a => a.filename)));
t('附件内容还原', r5.attachments[0] && Buffer.from(r5.attachments[0].data, 'base64').toString() === 'PDFDATA');
t('附件存在时正文仍在', r5.text.trim() === ATT_MARK, JSON.stringify(r5.text));

// 6. 中文附件名 (RFC2047)
const cnAtt = [
  'Content-Type: multipart/mixed; boundary="B3"', '',
  '--B3', 'Content-Type: text/plain', '', 'x',
  '--B3', 'Content-Type: application/octet-stream',
  'Content-Transfer-Encoding: base64',
  'Content-Disposition: attachment; filename="=?UTF-8?B?' + Buffer.from('报告.pdf').toString('base64') + '?="', '',
  'QUJD', '--B3--', ''].join('\r\n');
const r6 = parseMime(cnAtt);
t('中文附件名解码', r6.attachments[0] && r6.attachments[0].filename === '报告.pdf', JSON.stringify(r6.attachments[0] && r6.attachments[0].filename));

// 7. 头部折行
const hd = parseHeaders('Subject: Line one\r\n continued here\r\nFrom: a@b.com\r\n');
t('头部折行合并', hd.subject === 'Line one continued here', JSON.stringify(hd.subject));

// 8. 嵌套 multipart (mixed 内含 alternative + 外层附件)
const OUT_ATT = 'OUT_ATT_MARKER';
const nest = [
  'Content-Type: multipart/mixed; boundary="OUT"', '',
  '--OUT', 'Content-Type: multipart/alternative; boundary="IN"', '',
  '--IN', 'Content-Type: text/plain; charset=utf-8', '', PLAIN, '--IN',
  'Content-Type: text/html; charset=utf-8', '', '<i>' + HTMLM + '</i>', '--IN--', '',
  '--OUT', 'Content-Type: text/plain', 'Content-Disposition: attachment; filename="a.txt"', '', OUT_ATT,
  '--OUT--', ''].join('\r\n');
const r8 = parseMime(nest);
t('嵌套: 正文', r8.text.trim() === PLAIN, JSON.stringify(r8.text));
t('嵌套: html', r8.html.includes(HTMLM), JSON.stringify(r8.html));
t('嵌套: 附件唯一', r8.attachments.length === 1, JSON.stringify(r8.attachments.map(a => a.filename)));

// 9. curl 逗号边界情况
const bin = 'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n' + Buffer.from('中文内容测试').toString('base64');
t('base64 正文中文', parseMime(bin).text === '中文内容测试', JSON.stringify(parseMime(bin).text));

// 10. 断裂 base64 换行
const wrapped = 'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n' +
  Buffer.from('长文本'.repeat(20)).toString('base64').replace(/(.{20})/g, '$1\r\n');
t('折行 base64 正文', parseMime(wrapped).text === '长文本'.repeat(20));

// 11. 无 Content-Type 的裸文本
t('裸文本邮件', parseMime('Subject: x\r\n\r\nhello body').text.trim() === 'hello body', JSON.stringify(parseMime('Subject: x\r\n\r\nhello body').text));

// 12. RFC2047 相邻编码字之间的空白必须丢弃 (修复过的真实 bug)
t('相邻编码字空白丢弃',
  decodeMimeWords('=?UTF-8?B?6LSi?= =?UTF-8?B?5Yqh6YOo?= <f@c.com>') === '财务部 <f@c.com>',
  decodeMimeWords('=?UTF-8?B?6LSi?= =?UTF-8?B?5Yqh6YOo?= <f@c.com>'));
t('相邻 Q 编码字', decodeMimeWords('=?utf-8?Q?a?= =?utf-8?Q?b?=') === 'ab', decodeMimeWords('=?utf-8?Q?a?= =?utf-8?Q?b?='));
t('带邮箱的编码名', decodeMimeWords('=?UTF-8?B?5byg5LiJ?= <z@e.com>') === '张三 <z@e.com>', decodeMimeWords('=?UTF-8?B?5byg5LiJ?= <z@e.com>'));

// 13. 未编码的 UTF-8 中文头部: 从 binary 字符串还原时不能变成乱码
//     (真实 bug: 阅读页主题显示为 "é¡¹ç®å¨æ¥...")
const rawMail = Buffer.from(
  'Subject: 项目周报 — 第 42 周\r\nFrom: 张三 <z@e.com>\r\n\r\nbody', 'utf8').toString('binary');
const hh = extractHeaders(rawMail);
t('binary 邮件主题解码', hh.subject === '项目周报 — 第 42 周', JSON.stringify(hh.subject));
t('binary 邮件发件人解码', hh.from === '张三 <z@e.com>', JSON.stringify(hh.from));

console.log('\n通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
