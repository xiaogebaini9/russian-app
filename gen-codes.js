#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
//  接入码管理工具（云端版 — 码存在 Cloudflare KV，只在你的电脑上用）
//  依赖同目录 cloud.json：{"url":"https://xxx.workers.dev","adminToken":"..."}
//  用法：
//    node gen-codes.js 8                → 生成 8 个 7 位接入码（每天 100 次，永久有效）
//    node gen-codes.js 8 --days 30      → 月卡：30 天后过期
//    node gen-codes.js 8 --total 3000   → 次数卡：总共可用 3000 次
//    node gen-codes.js 8 --name 客户A   → 给码加备注名
//    node gen-codes.js list             → 查看所有码和今日用量
//    node gen-codes.js del 4826159      → 停用某个码
//    node gen-codes.js key sk-xxx       → 更新服务端 DeepSeek API Key
//    node gen-codes.js import           → 把本地 codes.json 一键同步到云端（恢复码库）
// ═══════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');

let conf;
try {
  conf = JSON.parse(fs.readFileSync(path.join(__dirname, 'cloud.json'), 'utf8'));
  if (!conf.url || !conf.adminToken) throw new Error('bad');
} catch {
  console.log('❌ 没读到 cloud.json（需要 {"url","adminToken"}），请先完成云端部署');
  process.exit(1);
}
const API = conf.url.replace(/\/$/, '');
const H = { 'Authorization': 'Bearer ' + conf.adminToken, 'Content-Type': 'application/json' };

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const opt = (name, dflt) => {
    const i = argv.indexOf('--' + name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
  };

  // ── 更新服务端 Key ──
  if (cmd === 'key') {
    if (!argv[1] || !argv[1].startsWith('sk-')) { console.log('用法：node gen-codes.js key sk-xxxx  （key 要以 sk- 开头）'); process.exit(1); }
    const r = await fetch(API + '/admin/setkey', { method: 'POST', headers: H, body: JSON.stringify({ key: argv[1].trim() }) });
    const d = await r.json();
    if (d.ok) console.log('[OK] 服务端 API Key 已更新（' + d.keyMasked + '），立即生效，不用重新部署');
    else { console.log('❌ ' + (d.error || r.status)); process.exit(1); }
    return;
  }

  // ── 查看码和用量 ──
  if (cmd === 'list') {
    const r = await fetch(API + '/admin/list', { headers: H });
    const d = await r.json();
    if (!d.codes) { console.log('❌ ' + (d.error || r.status)); process.exit(1); }
    if (!d.codes.length) { console.log('还没有接入码，先用 node gen-codes.js 8 生成'); return; }
    console.log('共 ' + d.codes.length + ' 个码，默认每码每日 ' + d.dailyLimit + ' 次：');
    d.codes.forEach(e => {
      const bits = [e.code, e.name, `今日 ${e.usedToday}/${e.dailyLimit}`];
      if (e.expiry) bits.push(`有效期至 ${e.expiry}`);
      if (e.totalLimit) bits.push(`总 ${e.totalUsed}/${e.totalLimit} 次`);
      console.log('  ' + bits.join('  '));
    });
    return;
  }

  // ── 停用码 ──
  if (cmd === 'del') {
    if (!argv[1]) { console.log('用法：node gen-codes.js del <码>'); process.exit(1); }
    const r = await fetch(API + '/admin/delete', { method: 'POST', headers: H, body: JSON.stringify({ code: argv[1].trim() }) });
    const d = await r.json();
    if (d.ok) console.log('[OK] 已停用 ' + argv[1] + '（立即生效）');
    else { console.log('❌ ' + (d.error || r.status)); process.exit(1); }
    return;
  }

  // ── 一键恢复码库（把本地 codes.json 完整同步到云端，云端数据丢失时用）──
  if (cmd === 'import') {
    const db = JSON.parse(fs.readFileSync(path.join(__dirname, 'codes.json'), 'utf8'));
    const r = await fetch(API + '/admin/import', { method: 'POST', headers: H, body: JSON.stringify(db) });
    const d = await r.json();
    if (d.ok) console.log('[OK] 已把本地 codes.json 的 ' + d.count + ' 个码同步到云端');
    else { console.log('❌ ' + (d.error || r.status)); process.exit(1); }
    return;
  }

  // ── 生成码（默认命令）──
  const n = Math.max(1, Math.min(100, parseInt(cmd, 10) || 8));
  const body = { n };
  if (opt('days')) body.days = parseInt(opt('days'));
  if (opt('total')) body.total = parseInt(opt('total'));
  if (opt('name')) body.name = opt('name');
  if (opt('daily')) body.dailyLimit = parseInt(opt('daily'));
  const r = await fetch(API + '/admin/generate', { method: 'POST', headers: H, body: JSON.stringify(body) });
  const d = await r.json();
  if (!d.codes) { console.log('❌ ' + (d.error || r.status)); process.exit(1); }
  const tag = [];
  if (body.days) tag.push(body.days + ' 天有效');
  if (body.total) tag.push('共 ' + body.total + ' 次');
  console.log('[OK] 已生成 ' + d.codes.length + ' 个接入码（每码每日 ' + d.dailyLimit + ' 次' + (tag.length ? '，' + tag.join('，') : '') + '），发给需要的人：');
  d.codes.forEach((e, i) => console.log('  ' + (i + 1) + '. ' + e.code + (e.expiry ? '（至 ' + e.expiry + '）' : '')));
  console.log('提示：node gen-codes.js list 查看；停用用 node gen-codes.js del <码>');
}

main().catch(e => { console.log('❌ 连不上云端：' + e.message); process.exit(1); });
