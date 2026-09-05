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
//    node gen-codes.js backup           → 把云端码库备份到本地 codes.json
//    node gen-codes.js feedback         → 查看用户反馈
//    node gen-codes.js feedback-done <id> → 标记某条反馈已处理
//    node gen-codes.js plan <邮箱> <天数> [每日次数] → 给登录用户绑套餐
//    node gen-codes.js users           → 查看注册用户
//    node gen-codes.js devices         → 查看设备登记（防刷额度）
//    node gen-codes.js device-block <设备号> [on|off] → 封禁/解封设备
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

// 把云端码库拉回本地 codes.json（每次生成/停用码后自动执行，保证本地永远有最新备份）
async function backupLocal() {
  try {
    const r = await fetch(API + '/admin/export', { headers: H, signal: AbortSignal.timeout(15000) });
    const d = await r.json();
    if (d && d.codes) { fs.writeFileSync(path.join(__dirname, 'codes.json'), JSON.stringify(d, null, 2)); return true; }
  } catch (e) {}
  return false;
}

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
    if (await backupLocal()) console.log('（本地 codes.json 备份已同步）');
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

  // ── 云端码库备份到本地 codes.json ──
  if (cmd === 'backup') {
    if (await backupLocal()) console.log('[OK] 本地 codes.json 已同步为云端最新（每次生成/停用码也会自动备份）');
    else { console.log('❌ 备份失败'); process.exit(1); }
    return;
  }

  // ── 账号套餐：绑到登录用户的邮箱 ──
  if (cmd === 'plan') {
    if (!argv[1] || !argv[2]) { console.log('用法：node gen-codes.js plan <邮箱> <天数> [每日次数]'); process.exit(1); }
    const r = await fetch(API + '/admin/plan', { method: 'POST', headers: H, body: JSON.stringify({ email: argv[1].trim(), days: parseInt(argv[2]), dailyLimit: parseInt(argv[3] || 100) }) });
    const d = await r.json();
    if (d.ok) console.log(`[OK] ${d.email} 套餐：${d.days} 天 × 每天 ${d.dailyLimit} 次（${d.start} 起）`);
    else { console.log('❌ ' + (d.error || r.status)); process.exit(1); }
    return;
  }

  // ── 查看注册用户 ──
  if (cmd === 'users') {
    const r = await fetch(API + '/admin/users', { headers: H });
    const d = await r.json();
    if (!d.users) { console.log('❌ ' + (d.error || r.status)); process.exit(1); }
    if (!d.users.length) { console.log('还没有注册用户'); return; }
    console.log('共 ' + d.users.length + ' 个注册用户：');
    d.users.forEach(u => {
      const bits = ['  ' + u.email];
      if (u.plan_days > 0) bits.push(`套餐 ${u.plan_days}天×${u.plan_daily}/天（${u.plan_start} 起）`);
      else if (u.trial_start) bits.push(`试用（${u.trial_start} 起）`);
      bits.push(`今日 ${u.used_count || 0} 次`);
      console.log(bits.join('  '));
    });
    return;
  }

  // ── 查看设备登记（防刷额度）──
  if (cmd === 'devices') {
    const r = await fetch(API + '/admin/devices', { headers: H });
    const d = await r.json();
    if (!d.items) { console.log('❌ ' + (d.error || r.status)); process.exit(1); }
    if (!d.items.length) { console.log('还没有设备登记记录（用户用过深度功能/注册/登录后出现）'); return; }
    console.log('共 ' + d.total + ' 台设备（' + d.blockedCount + ' 台已封禁），按最近活跃排序：');
    d.items.forEach(v => {
      console.log((v.blocked ? ' ⛔ ' : '    ') + v.did);
      console.log('      IP ' + (v.ip || '?') + ' · 首次 ' + (v.created || '?') + ' · 最近活跃 ' + (v.last_seen || '?'));
      if (v.emails.length) console.log('      注册: ' + v.emails.join(', '));
      const extra = v.logins.filter(e => v.emails.indexOf(e) < 0);
      if (extra.length) console.log('      登录过: ' + extra.join(', '));
    });
    console.log('封禁/解封：node gen-codes.js device-block <设备号> [on|off]');
    return;
  }

  // ── 封禁/解封设备（封禁后不给试用、不能再注册账号）──
  if (cmd === 'device-block') {
    if (!argv[1]) { console.log('用法：node gen-codes.js device-block <设备号> [on|off]'); process.exit(1); }
    const on = (argv[2] || 'on').toLowerCase() !== 'off';
    const r = await fetch(API + '/admin/device-block', { method: 'POST', headers: H, body: JSON.stringify({ did: argv[1].trim(), blocked: on }) });
    const d = await r.json();
    if (d.ok) console.log('[OK] 设备 ' + d.did + (d.blocked ? ' 已封禁（不再给试用、不能再注册）' : ' 已解封'));
    else { console.log('❌ ' + (d.error || r.status)); process.exit(1); }
    return;
  }

  // ── 查看用户反馈 ──
  if (cmd === 'feedback') {
    const r = await fetch(API + '/admin/feedback', { headers: H });
    const d = await r.json();
    if (!d.items) { console.log('❌ ' + (d.error || r.status)); process.exit(1); }
    if (!d.items.length) { console.log('暂无反馈'); return; }
    console.log('共 ' + d.total + ' 条（' + d.newCount + ' 条未处理）：');
    d.items.forEach(f => {
      const tag = f.status === 'new' ? '🆕' : '✅';
      console.log('  ' + tag + ' [' + f.id + '] ' + (f.time || '').slice(0, 16).replace('T', ' '));
      console.log('      ' + f.text + (f.contact ? '\n      联系方式: ' + f.contact : ''));
    });
    console.log('处理命令：node gen-codes.js feedback-done <id>');
    return;
  }

  // ── 标记反馈已处理 ──
  if (cmd === 'feedback-done') {
    if (!argv[1]) { console.log('用法：node gen-codes.js feedback-done <id>'); process.exit(1); }
    const r = await fetch(API + '/admin/feedback-done', { method: 'POST', headers: H, body: JSON.stringify({ id: argv[1].trim() }) });
    const d = await r.json();
    if (d.ok) console.log('[OK] 已标记处理 ' + argv[1]);
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
  if (await backupLocal()) console.log('（本地 codes.json 备份已同步）');
}

main().catch(e => { console.log('❌ 连不上云端：' + e.message); process.exit(1); });
