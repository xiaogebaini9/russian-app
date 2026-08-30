#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
//  接入码管理工具（只在荣荣的电脑上用，软件里没有这个功能）
//  用法：
//    node gen-codes.js 8            → 生成 8 个 7 位接入码
//    node gen-codes.js key sk-xxx   → 保存 DeepSeek API Key（隐藏到服务端）
//    node gen-codes.js list         → 查看所有码和今日用量
//    node gen-codes.js del 4826159  → 停用某个码
// ═══════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const CODES_FILE = path.join(__dirname, 'codes.json');
const KEYS_FILE = path.join(__dirname, 'keys.json');

function loadCodes() {
  try { return JSON.parse(fs.readFileSync(CODES_FILE, 'utf8')); }
  catch { return { dailyLimit: 100, codes: {} }; }
}
function saveCodes(db) { fs.writeFileSync(CODES_FILE, JSON.stringify(db, null, 2)); }
const today = () => new Date().toISOString().slice(0, 10);

const cmd = process.argv[2];
const arg = process.argv[3];

// ── 保存 key ──
if (cmd === 'key') {
  if (!arg || !arg.startsWith('sk-')) { console.log('用法：node gen-codes.js key sk-xxxx  （key 要以 sk- 开头）'); process.exit(1); }
  fs.writeFileSync(KEYS_FILE, JSON.stringify({ key: arg.trim() }, null, 2));
  console.log('[OK] API Key 已保存到 keys.json（该文件已列入 .gitignore，不会上传 GitHub）');
  process.exit(0);
}

// ── 查看码和用量 ──
if (cmd === 'list') {
  const db = loadCodes();
  const t = today();
  const keys = Object.keys(db.codes);
  if (!keys.length) { console.log('还没有接入码，先用 node gen-codes.js 8 生成'); process.exit(0); }
  console.log('共 ' + keys.length + ' 个码，每日限额 ' + (db.dailyLimit || 100) + ' 次：');
  keys.forEach(c => {
    const e = db.codes[c];
    const used = (e.used && e.used[t]) || 0;
    console.log('  ' + c + '  ' + (e.name || '') + '  今日 ' + used + '/' + (db.dailyLimit || 100));
  });
  process.exit(0);
}

// ── 停用码 ──
if (cmd === 'del') {
  const db = loadCodes();
  if (!arg || !db.codes[arg]) { console.log('没找到这个码：' + arg); process.exit(1); }
  delete db.codes[arg];
  saveCodes(db);
  console.log('[OK] 已停用 ' + arg + '（立即生效，不用重启代理）');
  process.exit(0);
}

// ── 生成码（默认命令）──
const n = Math.max(1, Math.min(100, parseInt(cmd, 10) || 8));
const db = loadCodes();
const made = [];
while (made.length < n) {
  let c = '';
  for (let i = 0; i < 7; i++) c += Math.floor(Math.random() * 10);
  if (db.codes[c]) continue;
  db.codes[c] = { name: '码' + (Object.keys(db.codes).length + 1), used: {} };
  made.push(c);
}
saveCodes(db);
console.log('[OK] 已生成 ' + made.length + ' 个接入码（每码每日 ' + (db.dailyLimit || 100) + ' 次），发给需要的人：');
made.forEach((c, i) => console.log('  ' + (i + 1) + '. ' + c));
console.log('提示：改备注名可用 node gen-codes.js list 查看；停用用 node gen-codes.js del <码>');
