// ═══════════════════════════════════════════════════════════════
//  云端代理 — 部署在 Cloudflare Workers（由本地 proxy.js 移植）
//  职责：校验接入码 → 扣次数 → 调 DeepSeek → 返回结果（缓存命中不计次数）
//  存储：KV
//    codes  = { dailyLimit, codes: { "1234567": { name, used, expiry?, totalLimit?, totalUsed? } } }
//    config = { deepseekKey }
//    c:wa:<hash>  单词分析缓存（30天）  c:sa:<hash>  句子解析缓存（7天）
//  管理接口（gen-codes.js 调用，需 Authorization: Bearer <ADMIN_TOKEN>）：
//    POST /admin/generate {n, name?, days?, total?, dailyLimit?}
//    GET  /admin/list
//    POST /admin/delete  {code}
//    POST /admin/setkey  {key}
//    POST /admin/import  {dailyLimit, codes}   ← 一次性迁移本地 codes.json 用
//    GET  /admin/status
//    GET  /admin/devices                    ← 设备登记清单（防刷额度）
//    POST /admin/device-block {did, blocked} ← 封禁(true)/解封(false)设备
//  静态页面（index.html 等）由 [assets] 自动托管，本脚本只处理 /api/ 和 /admin/
// ═══════════════════════════════════════════════════════════════

const CODES_KEY = 'codes';
const CONFIG_KEY = 'config';
// DeepSeek 上游地址：默认官方，可在 wrangler.toml [vars] 里用 DS_BASE_URL 覆盖（指向中转）
let DS_BASE = 'https://api.deepseek.com';
const MAX_BODY = 1000000;

// ── KV 读写（get 必须用 {type:'json'} 对象写法，字符串写法在线上运行时不可用）──
async function loadCodes(env) {
  try { return await env.KV.get(CODES_KEY, { type: 'json' }) || { dailyLimit: 100, codes: {} }; }
  catch { return { dailyLimit: 100, codes: {} }; }
}
async function loadConfig(env) {
  try { return await env.KV.get(CONFIG_KEY, { type: 'json' }) || {}; }
  catch { return {}; }
}

// ── 取主 Key（支持 config.keys 数组轮询，未来多 Key 分流零改代码）──
function masterKey(config) {
  if (config.keys && config.keys.length) return config.keys[Math.floor(Math.random() * config.keys.length)];
  return config.deepseekKey || '';
}

// ── 剩余次数（接入码和试用通用）──
function remainingOf(info) {
  if (!info || !info.entry) return undefined;
  const used = (info.entry.used && info.entry.used[info.today]) || 0;
  return Math.max(0, info.limit - used);
}

// ── 接入码校验（与本地 proxy.js 逻辑一致，新增 过期/总次数 检查）──
// raw = 完整 sk- key 直通；4~8 位数字码查名单
async function resolveAccess(env, raw) {
  const k = String(raw || '').trim();
  if (/^sk-/.test(k)) return { ok: true, key: k };
  if (!/^\d{4,8}$/.test(k)) return { ok: false, status: 403, msg: '请先在设置中填写接入码（管理员发放的数字）或 API Key' };
  const db = await loadCodes(env);
  const entry = db.codes && db.codes[k];
  if (!entry) return { ok: false, status: 403, msg: '接入码无效，请联系管理员' };
  const today = new Date().toISOString().slice(0, 10);
  if (entry.expiry && today > entry.expiry) {
    return { ok: false, status: 403, msg: `接入码已过期（有效期至 ${entry.expiry}），请联系管理员续期` };
  }
  if (entry.totalLimit && (entry.totalUsed || 0) >= entry.totalLimit) {
    return { ok: false, status: 429, msg: `接入码总次数已用完（共 ${entry.totalLimit} 次），请联系管理员` };
  }
  const used = (entry.used && entry.used[today]) || 0;
  const limit = entry.dailyLimit || db.dailyLimit || 100;
  if (used >= limit) return { ok: false, status: 429, msg: `今日额度已用完（每码每天 ${limit} 次），明天再来` };
  const config = await loadConfig(env);
  const mk = masterKey(config);
  if (!mk) return { ok: false, status: 500, msg: '服务端还没配置 API Key，请管理员运行 node gen-codes.js key sk-xxx' };
  return { ok: true, key: mk, code: k, entry, today, limit };
}

// ═══ 免费试用：未填码的设备按 deviceId 记 3 天 × 每天 N 次（参数可调）═══
const TRIAL_KEY = 'trials';
async function loadTrials(env) {
  try { return await env.KV.get(TRIAL_KEY, { type: 'json' }) || {}; }
  catch { return {}; }
}
function addDaysTo(baseDate, n) {
  return new Date(new Date(baseDate + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);
}

// ═══ 设备登记（防刷额度：设备永久留档，管理员可查可封）═══
// 每台设备最多注册的账号数（防多账号叠加每日额度）
const MAX_ACC_PER_DEVICE = 2;
// 每个真实 IP 每天最多注册的账号数（防脚本批量刷号）
const MAX_REG_PER_IP_DAY = 5;
// 每台设备最多记录的邮箱数（防字段膨胀）
const MAX_EMAILS_TRACKED = 20;

// 登记设备并返回其档案；DB 异常时返回 null（登记失败不影响主流程）
// opts: { regEmail } 注册成功后把邮箱挂到设备；{ loginEmail } 登录成功后记录绑定
async function recordDevice(env, did, ip, opts) {
  did = String(did || '').trim();
  if (!/^[A-Za-z0-9-]{8,64}$/.test(did)) return null;
  const o = opts || {};
  try {
    await ensureDB(env);
    const row = await env.DB.prepare('SELECT last_seen, ip, emails, logins, blocked FROM devices WHERE did=?').bind(did).first();
    const td = today();
    if (!row) {
      const emails = o.regEmail ? [o.regEmail] : [];
      const logins = o.loginEmail ? [o.loginEmail] : [];
      await env.DB.prepare('INSERT INTO devices (did, created, last_seen, ip, emails, logins, blocked) VALUES (?1,?2,?2,?3,?4,?5,0)')
        .bind(did, td, ip || '', JSON.stringify(emails), JSON.stringify(logins)).run();
      return { emails, logins, blocked: 0 };
    }
    let emails = [], logins = [];
    try { emails = JSON.parse(row.emails || '[]'); } catch (e) {}
    try { logins = JSON.parse(row.logins || '[]'); } catch (e) {}
    if (o.regEmail && emails.length < MAX_EMAILS_TRACKED && !emails.includes(o.regEmail)) emails.push(o.regEmail);
    if (o.loginEmail && logins.length < MAX_EMAILS_TRACKED && !logins.includes(o.loginEmail)) logins.push(o.loginEmail);
    const newE = JSON.stringify(emails), newL = JSON.stringify(logins);
    const changed = row.last_seen !== td || (ip && row.ip !== ip) || newE !== (row.emails || '[]') || newL !== (row.logins || '[]');
    if (changed) {
      await env.DB.prepare('UPDATE devices SET last_seen=?1, ip=?2, emails=?3, logins=?4 WHERE did=?5')
        .bind(td, ip || row.ip || '', newE, newL, did).run();
    }
    return { emails, logins, blocked: row.blocked };
  } catch (e) { return null; }
}

async function resolveTrial(env, deviceId, ip) {
  const did = String(deviceId || '').trim();
  if (!/^[A-Za-z0-9-]{8,64}$/.test(did)) {
    return { ok: false, status: 403, msg: '请先在设置中填写接入码（管理员发放的数字）。新用户可免费试用 3 天，每天 25 次' };
  }
  // 顺手登记设备；被封禁的设备不给试用（接入码用户不受影响）
  const dev = await recordDevice(env, did, ip);
  if (dev && dev.blocked) return { ok: false, status: 403, msg: '此设备已被限制免费试用，请在设置中填入接入码继续使用' };
  const config = await loadConfig(env);
  const t = config.trial || {};
  const days = Math.max(1, parseInt(t.days) || 3);
  const limit = Math.max(1, parseInt(t.dailyLimit) || 25);
  const today = new Date().toISOString().slice(0, 10);
  const trials = await loadTrials(env);
  let e = trials[did];
  if (!e) {
    // 同 IP 软限制：窗口期内同一 IP 最多 5 个新试用设备，防一台手机刷量
    const cutoff = addDaysTo(today, -days);
    const sameIp = Object.values(trials).filter(x => x.ip === ip && x.created >= cutoff).length;
    if (sameIp >= 5) return { ok: false, status: 403, msg: '此网络的新用户试用名额已用完，请联系管理员获取接入码' };
    e = trials[did] = { created: today, ip: ip || '', used: {} };
  }
  // 顺手清理 30 天前的旧记录，防膨胀
  const cutoff30 = addDaysTo(today, -30);
  Object.keys(trials).forEach(k => { if ((trials[k].created || '') < cutoff30) delete trials[k]; });
  if (today > addDaysTo(e.created, days)) {
    return { ok: false, status: 403, msg: '免费试用已结束，请在设置中填入接入码继续使用' };
  }
  const used = (e.used && e.used[today]) || 0;
  if (used >= limit) return { ok: false, status: 429, msg: `今日试用次数已用完（试用每天 ${limit} 次），填入接入码立即解锁全部功能` };
  const mk = masterKey(config);
  if (!mk) return { ok: false, status: 500, msg: '服务端还没配置 API Key，请管理员运行 node gen-codes.js key sk-xxx' };
  return { ok: true, key: mk, trial: true, deviceId: did, entry: e, today, limit, trials };
}

// ── 统一鉴权：sk-直通 > 登录账号 > 接入码 > 设备试用 ──
async function authorize(env, request, body) {
  const raw = String((body && body.key) || '').trim();
  if (/^sk-/.test(raw)) return await resolveAccess(env, raw);
  const did = String((body && body.deviceId) || request.headers.get('x-device-id') || '').trim();
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const acct = await resolveAccount(env, request);
  if (acct) {
    if (did) await recordDevice(env, did, ip);
    return accountAccess(acct.user, await loadConfig(env));
  }
  if (raw) {
    if (did) await recordDevice(env, did, ip);
    return await resolveAccess(env, raw);
  }
  // 试用路径在 resolveTrial 内自行登记（含封禁检查）
  return await resolveTrial(env, did, ip);
}

// ── 扣次数（sk- 直通不计；接入码和试用分库计）──
async function countUse(env, info) {
  if (!info || !info.entry) return;
  info.entry.used = info.entry.used || {};
  info.entry.used[info.today] = (info.entry.used[info.today] || 0) + 1;
  if (info.trial) {
    await env.KV.put(TRIAL_KEY, JSON.stringify(info.trials));
    return;
  }
  if (info.acct) {
    const next = info.entry.used[info.today] || 0;
    await env.DB.prepare('UPDATE users SET used_date=?1, used_count=?2 WHERE email=?3').bind(info.today, next, info.email).run();
    return;
  }
  if (!info.code) return;
  info.entry.totalUsed = (info.entry.totalUsed || 0) + 1;
  const db = await loadCodes(env);
  const entry = db.codes && db.codes[info.code];
  if (!entry) return;
  entry.used = entry.used || {};
  entry.used[info.today] = (entry.used[info.today] || 0) + 1;
  entry.totalUsed = (entry.totalUsed || 0) + 1;
  await env.KV.put(CODES_KEY, JSON.stringify(db));
}

// ═══ 邮箱账号体系（D1 存储：注册/登录/套餐/收藏同步）═══
const SESSION_DAYS = 30;
// 登录用户的课堂免费体验量（按句计，75 句 ≈ 15 分钟），终身一次
const CLASSROOM_TRIAL_SENTENCES = 75;

async function ensureDB(env) {
  if (env._dbReady) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (
      email TEXT PRIMARY KEY, pass TEXT, salt TEXT, created TEXT,
      trial_start TEXT, trial_daily INTEGER DEFAULT 25,
      plan_days INTEGER DEFAULT 0, plan_daily INTEGER DEFAULT 100, plan_start TEXT,
      used_date TEXT, used_count INTEGER DEFAULT 0, favs TEXT DEFAULT '[]',
      classroom_used INTEGER DEFAULT 0)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, email TEXT, created TEXT)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS devices (
      did TEXT PRIMARY KEY, created TEXT, last_seen TEXT, ip TEXT,
      emails TEXT DEFAULT '[]', logins TEXT DEFAULT '[]', blocked INTEGER DEFAULT 0)`)
  ]);
  try { await env.DB.prepare('ALTER TABLE users ADD COLUMN classroom_used INTEGER DEFAULT 0').run(); } catch (e) {}
  env._dbReady = true;
}
function randomHex(bytes) {
  const a = new Uint8Array(bytes); crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function hashPass(pass, saltHex) {
  const salt = new Uint8Array(saltHex.match(/../g).map(h => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256);
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// 会话 → 账号（无会话返回 null，走码/试用）
async function resolveAccount(env, request) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  await ensureDB(env);
  const sess = await env.DB.prepare('SELECT email, created FROM sessions WHERE token=?').bind(token).first();
  if (!sess) return null;
  if (Date.now() - new Date(sess.created + 'T00:00:00Z').getTime() > SESSION_DAYS * 86400000) {
    await env.DB.prepare('DELETE FROM sessions WHERE token=?').bind(token).run();
    return null;
  }
  const u = await env.DB.prepare('SELECT * FROM users WHERE email=?').bind(sess.email).first();
  if (!u) return null;
  return { user: u, email: sess.email, token: token };
}

// 账号额度：套餐（管理员绑定）优先，否则注册时继承的设备试用期
function accountAccess(u, config) {
  const today = new Date().toISOString().slice(0, 10);
  const mk = masterKey(config);
  if (!mk) return { ok: false, status: 500, msg: '服务端还没配置 API Key' };
  const used = (u.used_date === today) ? (u.used_count || 0) : 0;
  const entry = { used: { [today]: used } };
  if (u.plan_days > 0 && u.plan_start) {
    const expiry = addDaysTo(u.plan_start, u.plan_days);
    if (today > expiry) return { ok: false, status: 403, msg: `账号套餐已过期（${expiry}），请联系管理员续费` };
    const limit = u.plan_daily || 100;
    if (used >= limit) return { ok: false, status: 429, msg: `今日次数已用完（套餐每天 ${limit} 次），明天再来` };
    return { ok: true, key: mk, acct: true, email: u.email, today, limit, entry };
  }
  const t = config.trial || {};
  const days = Math.max(1, parseInt(t.days) || 3);
  const limit = Math.max(1, parseInt(t.dailyLimit) || 25);
  if (!u.trial_start) return { ok: false, status: 403, msg: '账号暂无套餐，请联系管理员购买' };
  const expiry = addDaysTo(u.trial_start, days);
  if (today > expiry) return { ok: false, status: 403, msg: '免费试用已结束，请联系管理员购买接入套餐' };
  if (used >= limit) return { ok: false, status: 429, msg: `今日试用次数已用完（每天 ${limit} 次），购买套餐立即解锁` };
  return { ok: true, key: mk, acct: true, email: u.email, today, limit, entry };
}

// ── 缓存（命中不计次数、不调 DeepSeek）──
async function sha256(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, '0')).join('');
}

// ── DeepSeek 调用（模型回退：第一个模型失败时自动试下一个）──
async function callDeepSeek(key, messages, maxTokens, timeoutMs, models, useJsonMode) {
  const list = models || ['deepseek-v4-flash', 'deepseek-chat'];
  let lastErr = null;
  for (const model of list) {
    try {
      const body = { model, max_tokens: maxTokens, temperature: 0.1, messages };
      if (useJsonMode) body.response_format = { type: 'json_object' };
      const resp = await fetch(`${DS_BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
      const d = await resp.json();
      if (d.error) {
        const msg = typeof d.error === 'string' ? d.error : (d.error.message || JSON.stringify(d.error));
        if (/auth|invalid api key|authentication/i.test(msg)) throw new Error(msg);
        lastErr = new Error(msg);
        continue;
      }
      return { data: d, model };
    } catch (e) {
      if (/auth|invalid api key|authentication/i.test(e.message || '')) throw e;
      lastErr = e;
    }
  }
  throw lastErr || new Error('DeepSeek调用失败');
}

// ── 从模型输出中提取 JSON（多级容错，与本地版一致）──
function extractJson(raw) {
  if (!raw) return null;
  let s = raw.replace(/```(?:json)?\s*\n?([\s\S]*?)\n?```/g, '$1').trim();
  try { return JSON.parse(s); } catch (e) {}
  const b = s.indexOf('{'), e2 = s.lastIndexOf('}');
  if (b >= 0 && e2 > b) {
    let seg = s.slice(b, e2 + 1);
    seg = seg.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n"]*/g, '');
    seg = seg.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
    try { return JSON.parse(seg); } catch (e) {}
  }
  const ab = s.indexOf('['), ae = s.lastIndexOf(']');
  if (ab >= 0 && ae > ab) {
    let seg = s.slice(ab, ae + 1);
    seg = seg.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n"]*/g, '');
    seg = seg.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
    try { return JSON.parse(seg); } catch (e) {}
  }
  return null;
}

async function requestJsonAnalysis(key, messages, maxTokens, timeoutMs) {
  let r = await callDeepSeek(key, messages, maxTokens, timeoutMs, ['deepseek-v4-flash'], true);
  let raw = r.data.choices?.[0]?.message?.content?.trim() || '';
  let parsed = extractJson(raw);
  if (parsed) return { parsed, raw, model: r.model };
  r = await callDeepSeek(key, messages, maxTokens, timeoutMs, ['deepseek-chat'], true);
  raw = r.data.choices?.[0]?.message?.content?.trim() || '';
  parsed = extractJson(raw);
  if (parsed) return { parsed, raw, model: r.model };
  const snippet = raw.length > 200 ? raw.slice(0, 200) + '…' : raw;
  return { parsed: null, raw, model: r.model, snippet };
}

// ── 请求体读取（上限 1MB）──
async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) return null;
  try { return JSON.parse(text); } catch { return undefined; } // undefined = 格式错
}

// ── 管理员鉴权 ──
function isAdmin(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = (env.ADMIN_TOKEN || '').trim();
  if (!token) return false;
  return auth === `Bearer ${token}`;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

// ── 生成 7 位接入码（去重）──
function randCode(existing) {
  while (true) {
    const a = new Uint32Array(7);
    crypto.getRandomValues(a);
    const c = Array.from(a, x => x % 10).join('');
    if (!existing[c]) return c;
  }
}
const today = () => new Date().toISOString().slice(0, 10);
function addDays(days) {
  const d = new Date(Date.now() + days * 86400000);
  return d.toISOString().slice(0, 10);
}

// ═══════════════════════════════════════════════════════════════
//  主入口
// ═══════════════════════════════════════════════════════════════
export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, Authorization'
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });

    if (env.DS_BASE_URL) DS_BASE = String(env.DS_BASE_URL).replace(/\/v1\/?$/, '');
    const url = new URL(request.url);
    const path = url.pathname;
    let res;
    try {
      res = await route(request, env, ctx, path);
    } catch (e) {
      res = json({ error: e.message || '服务器内部错误' }, 500);
    }
    // 统一补 CORS（APK 的 capacitor:// 来源需要）
    const out = new Response(res.body, res);
    corsHeaders && Object.keys(corsHeaders).forEach(k => out.headers.set(k, corsHeaders[k]));
    return out;
  }
};

async function route(request, env, ctx, path) {
  const method = request.method;

  // ── 管理接口 ──
  if (path.startsWith('/admin/')) {
    if (!isAdmin(request, env)) return json({ error: '管理令牌无效（ADMIN_TOKEN 不对或未配置）' }, 401);

    if (method === 'POST' && path === '/admin/generate') {
      const body = await readJson(request);
      if (body === null || body === undefined) return json({ error: '请求体格式错误' }, 400);
      const n = Math.min(100, Math.max(1, parseInt(body.n) || 8));
      const db = await loadCodes(env);
      const made = [];
      for (let i = 0; i < n; i++) {
        const c = randCode(db.codes);
        db.codes[c] = { name: body.name || ('码' + (Object.keys(db.codes).length + 1)) };
        if (body.days) db.codes[c].expiry = addDays(parseInt(body.days));
        if (body.total) db.codes[c].totalLimit = Math.max(1, parseInt(body.total));
        if (body.dailyLimit) db.codes[c].dailyLimit = Math.max(1, parseInt(body.dailyLimit));
        made.push(c);
      }
      if (body.dailyLimit) db.dailyLimit = Math.max(1, parseInt(body.dailyLimit));
      await env.KV.put(CODES_KEY, JSON.stringify(db));
      return json({ ok: true, codes: made.map(c => ({ code: c, ...db.codes[c] })), dailyLimit: db.dailyLimit });
    }

    if (method === 'GET' && path === '/admin/list') {
      const db = await loadCodes(env);
      const t = today();
      const list = Object.entries(db.codes).map(([code, e]) => ({
        code, name: e.name || '',
        usedToday: (e.used && e.used[t]) || 0,
        dailyLimit: e.dailyLimit || db.dailyLimit || 100,
        expiry: e.expiry || null,
        totalUsed: e.totalUsed || 0,
        totalLimit: e.totalLimit || null
      }));
      return json({ dailyLimit: db.dailyLimit || 100, codes: list });
    }

    if (method === 'POST' && path === '/admin/delete') {
      const body = await readJson(request);
      const db = await loadCodes(env);
      const code = String((body && body.code) || '').trim();
      if (!db.codes[code]) return json({ error: '没找到这个码：' + code }, 404);
      delete db.codes[code];
      await env.KV.put(CODES_KEY, JSON.stringify(db));
      return json({ ok: true });
    }

    if (method === 'POST' && path === '/admin/setkey') {
      const body = await readJson(request);
      const key = String((body && body.key) || '').trim();
      if (!key.startsWith('sk-')) return json({ error: 'key 要以 sk- 开头' }, 400);
      const config = await loadConfig(env);
      config.deepseekKey = key;
      await env.KV.put(CONFIG_KEY, JSON.stringify(config));
      return json({ ok: true, keyMasked: key.slice(0, 6) + '***' + key.slice(-4) });
    }

    if (method === 'POST' && path === '/admin/import') {
      const body = await readJson(request);
      if (!body || !body.codes || typeof body.codes !== 'object') return json({ error: '格式应为 {dailyLimit, codes}' }, 400);
      await env.KV.put(CODES_KEY, JSON.stringify({ dailyLimit: body.dailyLimit || 100, codes: body.codes }));
      return json({ ok: true, count: Object.keys(body.codes).length });
    }

    if (method === 'GET' && path === '/admin/status') {
      const [db, config] = await Promise.all([loadCodes(env), loadConfig(env)]);
      const k = masterKey(config);
      return json({
        hasKey: !!k, keyMasked: k ? k.slice(0, 6) + '***' + k.slice(-4) : null,
        dailyLimit: db.dailyLimit || 100, codeCount: Object.keys(db.codes).length,
        trial: config.trial || { days: 3, dailyLimit: 25 },
        hasPushplus: !!config.pushplusToken
      });
    }

    // ── 导出原始码库（gen-codes.js 做本地备份用）──
    if (method === 'GET' && path === '/admin/export') {
      const db = await loadCodes(env);
      return json(db);
    }

    // ── 账号套餐：把套餐绑到邮箱（用户登录后即生效）──
    if (method === 'POST' && path === '/admin/plan') {
      const body = await readJson(request);
      const email = String((body && body.email) || '').trim().toLowerCase();
      const days = Math.max(1, Math.min(3650, parseInt(body && body.days) || 30));
      const dailyLimit = Math.max(1, Math.min(10000, parseInt(body && body.dailyLimit) || 100));
      await ensureDB(env);
      const u = await env.DB.prepare('SELECT email FROM users WHERE email=?').bind(email).first();
      if (!u) return json({ error: '没有这个邮箱的账号' }, 404);
      await env.DB.prepare('UPDATE users SET plan_days=?1, plan_daily=?2, plan_start=?3 WHERE email=?4').bind(days, dailyLimit, today(), email).run();
      return json({ ok: true, email, days, dailyLimit, start: today() });
    }
    if (method === 'GET' && path === '/admin/users') {
      await ensureDB(env);
      const rs = await env.DB.prepare('SELECT email, created, plan_days, plan_daily, plan_start, trial_start, used_date, used_count FROM users ORDER BY created DESC LIMIT 200').all();
      return json({ users: rs.results || [] });
    }

    // ── 试用参数（天数/每日次数，实时生效）──
    if (method === 'POST' && path === '/admin/trial') {
      const body = await readJson(request);
      const config = await loadConfig(env);
      config.trial = {
        days: Math.max(1, Math.min(365, parseInt(body && body.days) || 3)),
        dailyLimit: Math.max(1, Math.min(1000, parseInt(body && body.dailyLimit) || 25))
      };
      await env.KV.put(CONFIG_KEY, JSON.stringify(config));
      return json({ ok: true, trial: config.trial });
    }

    // ── PushPlus 微信推送令牌（pushplus.plus 免费申请；传空串=关闭推送）──
    if (method === 'POST' && path === '/admin/pushplus') {
      const body = await readJson(request);
      const config = await loadConfig(env);
      config.pushplusToken = String((body && body.token) || '').trim().slice(0, 100);
      await env.KV.put(CONFIG_KEY, JSON.stringify(config));
      return json({ ok: true, enabled: !!config.pushplusToken });
    }

    // ── 反馈查看/处理 ──
    if (method === 'GET' && path === '/admin/feedback') {
      let fb = {};
      try { fb = await env.KV.get('feedback', { type: 'json' }) || {}; } catch { fb = {}; }
      const list = Object.entries(fb).map(([id, f]) => ({ id, ...f }))
        .sort((a, b) => (b.time || '').localeCompare(a.time || ''));
      return json({ total: list.length, newCount: list.filter(f => f.status === 'new').length, items: list });
    }
    if (method === 'POST' && path === '/admin/feedback-done') {
      const body = await readJson(request);
      let fb = {};
      try { fb = await env.KV.get('feedback', { type: 'json' }) || {}; } catch { fb = {}; }
      const id = String((body && body.id) || '');
      if (!fb[id]) return json({ error: '没找到这条反馈' }, 404);
      fb[id].status = 'done';
      await env.KV.put('feedback', JSON.stringify(fb));
      return json({ ok: true });
    }
    if (method === 'POST' && path === '/admin/feedback-del') {
      const body = await readJson(request);
      let fb = {};
      try { fb = await env.KV.get('feedback', { type: 'json' }) || {}; } catch { fb = {}; }
      const id = String((body && body.id) || '');
      if (!fb[id]) return json({ error: '没找到这条反馈' }, 404);
      delete fb[id];
      await env.KV.put('feedback', JSON.stringify(fb));
      return json({ ok: true });
    }

    // ── 设备登记：查看 / 封禁（防刷额度）──
    if (method === 'GET' && path === '/admin/devices') {
      await ensureDB(env);
      const rs = await env.DB.prepare('SELECT did, created, last_seen, ip, emails, logins, blocked FROM devices ORDER BY last_seen DESC LIMIT 200').all();
      const items = (rs.results || []).map(d => {
        let emails = [], logins = [];
        try { emails = JSON.parse(d.emails || '[]'); } catch (e) {}
        try { logins = JSON.parse(d.logins || '[]'); } catch (e) {}
        return { did: d.did, created: d.created, last_seen: d.last_seen, ip: d.ip, emails, logins, blocked: !!d.blocked };
      });
      return json({ total: items.length, blockedCount: items.filter(x => x.blocked).length, items });
    }
    if (method === 'POST' && path === '/admin/device-block') {
      const body = await readJson(request);
      const did = String((body && body.did) || '').trim();
      const blocked = (body && body.blocked === false) || (body && body.blocked === 'off') ? 0 : 1;
      await ensureDB(env);
      const r = await env.DB.prepare('UPDATE devices SET blocked=?1 WHERE did=?2').bind(blocked, did).run();
      if (!r.meta || !r.meta.changes) return json({ error: '设备清单里没有这个设备号' }, 404);
      return json({ ok: true, did, blocked: !!blocked });
    }

    return json({ error: '未知管理接口' }, 404);
  }

  // ── 业务 API（以下路径与本地 proxy.js 完全一致）──
  if (method === 'GET' && path === '/api/config') {
    return json({ isOfficial: DS_BASE === 'https://api.deepseek.com' });
  }

  if (method === 'GET' && path === '/api/testkey') {
    const rawKey = (request.headers.get('x-api-key') || '').trim();
    if (!rawKey) {
      // 没填码：登录账号 → 报告账号额度；否则报告设备试用状态
      const acct = await resolveAccount(env, request);
      if (acct) {
        const a = accountAccess(acct.user, await loadConfig(env));
        if (!a.ok) return json({ error: a.msg, acct: true });
        return json({ ok: true, acct: true, remaining: remainingOf(a) });
      }
      const access = await resolveTrial(env, request.headers.get('x-device-id'), request.headers.get('CF-Connecting-IP') || '');
      if (!access.ok) return json({ error: access.msg });
      return json({ ok: true, trial: true, remaining: remainingOf(access) });
    }
    if (/^\d{4,8}$/.test(rawKey)) {
      const access = await resolveAccess(env, rawKey);
      if (!access.ok) return json({ error: access.msg });
      const used = (access.entry.used && access.entry.used[access.today]) || 0;
      return json({ ok: true, code: true, remaining: Math.max(0, access.limit - used) });
    }
    const d = await fetch(`${DS_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${rawKey}` },
      body: JSON.stringify({ model: 'deepseek-v4-flash', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
      signal: AbortSignal.timeout(15000)
    }).then(r => r.json());
    if (d.error) return json({ error: typeof d.error === 'string' ? d.error : (d.error.message || JSON.stringify(d.error)) });
    if (d.choices && d.choices[0]) return json({ ok: true, model: d.model || 'unknown' });
    return json(d);
  }

  if (method === 'GET' && path === '/api/balance') {
    const key = request.headers.get('x-api-key') || '';
    const d = await fetch(`${DS_BASE}/user/balance`, {
      headers: { 'Authorization': `Bearer ${key}` },
      signal: AbortSignal.timeout(10000)
    }).then(r => r.json());
    return json(d);
  }

  if (method === 'GET' && path === '/api/voice-health') {
    return json({ ok: true, stt: true, model: 'whisper-large-v3-turbo', device: 'cloud' });
  }

  // ── 云语音识别：实时版（turbo，快）/ 完整版（large-v3，准）──
  if (method === 'POST' && path === '/api/voice') return voiceSTT(request, env, '@cf/openai/whisper-large-v3-turbo');
  if (method === 'POST' && path === '/api/voice-hq') return voiceSTT(request, env, '@cf/openai/whisper-large-v3');

  async function voiceSTT(request, env, model) {
    if (!env.AI) return json({ error: '语音识别未启用（缺少 AI 绑定）' }, 500);
    // 登录用户的课堂体验用尽 → 拦（套餐用户/接入码/匿名不受限）
    const acct = await resolveAccount(env, request);
    if (acct) {
      const u = acct.user;
      if (!(u.plan_days > 0 && u.plan_start) && (u.classroom_used || 0) >= CLASSROOM_TRIAL_SENTENCES) {
        return json({ error: '课堂体验已用完（75 句 ≈ 15 分钟），购买套餐后可继续使用', classroomTrial: true }, 403);
      }
    }
    const buf = await request.arrayBuffer();
    if (!buf || buf.byteLength === 0) return json({ error: '音频为空' }, 400);
    if (buf.byteLength > 8000000) return json({ error: '音频过大（单段限 8MB）' }, 413);
    try {
      // Whisper 输入用 base64 字符串（数组/ArrayBuffer 在序列化层会被转成字符串导致校验失败）
      const u = new Uint8Array(buf);
      let bin = '';
      for (let i = 0; i < u.length; i++) bin += String.fromCharCode(u[i]);
      const res = await env.AI.run(model, { audio: btoa(bin) });
      return json({ text: (res.text || '').trim(), language: res.language || '' });
    } catch (e) {
      return json({ error: '识别失败：' + (e.message || e) }, 500);
    }
  }

  // ── 邮箱账号：注册 / 登录 / 登出 / 我的信息 ──
  if (method === 'POST' && path === '/api/auth/register') {
    const body = await readJson(request);
    const email = String((body && body.email) || '').trim().toLowerCase();
    const pass = String((body && body.password) || '');
    const did = String((body && body.deviceId) || '').trim();
    const ip = request.headers.get('CF-Connecting-IP') || '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return json({ error: '邮箱格式不正确' }, 400);
    if (pass.length < 6) return json({ error: '密码至少 6 位' }, 400);
    await ensureDB(env);
    // 防刷闸门：设备封禁 → 每设备账号数 → 每 IP 每日注册数
    const dev = await recordDevice(env, did, ip);
    if (dev && dev.blocked) return json({ error: '此设备已被限制注册，请联系管理员' }, 403);
    if (dev && dev.emails.length >= MAX_ACC_PER_DEVICE) return json({ error: `此设备注册的账号已达上限（${MAX_ACC_PER_DEVICE} 个），请直接登录` }, 403);
    const regKey = ip ? 'reg:' + today() + ':' + ip : '';
    if (regKey) {
      let n = 0; try { n = parseInt(await env.KV.get(regKey)) || 0; } catch (e) {}
      if (n >= MAX_REG_PER_IP_DAY) return json({ error: '此网络今日注册人数已达上限，请明天再试或直接登录' }, 429);
    }
    const ex = await env.DB.prepare('SELECT email FROM users WHERE email=?').bind(email).first();
    if (ex) return json({ error: '该邮箱已注册，请直接登录' }, 409);
    const salt = randomHex(16);
    const passHash = await hashPass(pass, salt);
    // 继承该设备已有的试用起始日，防止换邮箱刷试用期
    let trialStart = new Date().toISOString().slice(0, 10);
    try { const tr = await loadTrials(env); if (tr[did] && tr[did].created) trialStart = tr[did].created; } catch (e) {}
    await env.DB.prepare('INSERT INTO users (email, pass, salt, created, trial_start, trial_daily) VALUES (?1,?2,?3,?4,?5,25)')
      .bind(email, passHash, salt, today(), trialStart).run();
    // 注册成功才计数/挂邮箱，失败的尝试不占额度
    if (regKey) { try { const n = parseInt(await env.KV.get(regKey)) || 0; await env.KV.put(regKey, String(n + 1), { expirationTtl: 172800 }); } catch (e) {} }
    await recordDevice(env, did, ip, { regEmail: email });
    const token = randomHex(32);
    await env.DB.prepare('INSERT INTO sessions (token, email, created) VALUES (?1,?2,?3)').bind(token, email, today()).run();
    return json({ ok: true, token, email });
  }

  if (method === 'POST' && path === '/api/auth/login') {
    const body = await readJson(request);
    const email = String((body && body.email) || '').trim().toLowerCase();
    const pass = String((body && body.password) || '');
    const did = String((body && body.deviceId) || '').trim();
    const ip = request.headers.get('CF-Connecting-IP') || '';
    await ensureDB(env);
    // 防爆破：10 分钟内同一邮箱错 5 次 → 锁定
    let fl = {}; try { fl = await env.KV.get('fl:' + email, { type: 'json' }) || { n: 0 }; } catch (e) {}
    if ((fl.n || 0) >= 5) return json({ error: '错误次数过多，请 10 分钟后再试' }, 423);
    const u = await env.DB.prepare('SELECT * FROM users WHERE email=?').bind(email).first();
    if (!u) { await env.KV.put('fl:' + email, JSON.stringify({ n: (fl.n || 0) + 1 }), { expirationTtl: 600 }); return json({ error: '邮箱或密码不正确' }, 401); }
    const h = await hashPass(pass, u.salt);
    if (h !== u.pass) { await env.KV.put('fl:' + email, JSON.stringify({ n: (fl.n || 0) + 1 }), { expirationTtl: 600 }); return json({ error: '邮箱或密码不正确' }, 401); }
    try { await env.KV.delete('fl:' + email); } catch (e) {}
    const token = randomHex(32);
    await env.DB.prepare('INSERT INTO sessions (token, email, created) VALUES (?1,?2,?3)').bind(token, email, today()).run();
    // 记录"该设备登录过该邮箱"（只记录不限制，供管理员发现一机多号）
    await recordDevice(env, did, ip, { loginEmail: email });
    return json({ ok: true, token, email });
  }

  if (method === 'POST' && path === '/api/auth/logout') {
    const auth = request.headers.get('Authorization') || '';
    if (auth.startsWith('Bearer ') && /^[a-f0-9]{64}$/.test(auth.slice(7).trim())) {
      await ensureDB(env);
      await env.DB.prepare('DELETE FROM sessions WHERE token=?').bind(auth.slice(7).trim()).run();
    }
    return json({ ok: true });
  }

  if (method === 'GET' && path === '/api/auth/me') {
    const acct = await resolveAccount(env, request);
    if (!acct) return json({ error: '未登录' }, 401);
    const config = await loadConfig(env);
    const a = accountAccess(acct.user, config);
    const cu = acct.user.classroom_used || 0;
    return json({
      email: acct.email,
      plan: acct.user.plan_days > 0 ? { days: acct.user.plan_days, daily: acct.user.plan_daily, start: acct.user.plan_start } : null,
      trial: acct.user.trial_start ? { start: acct.user.trial_start } : null,
      remaining: a.ok ? remainingOf(a) : 0,
      ok: a.ok, msg: a.ok ? '' : a.msg,
      classroom: { used: cu, left: Math.max(0, CLASSROOM_TRIAL_SENTENCES - cu), limit: CLASSROOM_TRIAL_SENTENCES }
    });
  }

  // ── 收藏云同步（登录用户）──
  if (method === 'GET' && path === '/api/user/favs') {
    const acct = await resolveAccount(env, request);
    if (!acct) return json({ error: '未登录' }, 401);
    let favs = '[]';
    try { favs = await env.DB.prepare('SELECT favs FROM users WHERE email=?').bind(acct.email).first(); } catch (e) {}
    return json({ favs: JSON.parse((favs && favs.favs) || '[]') });
  }
  if (method === 'POST' && path === '/api/user/favs') {
    const acct = await resolveAccount(env, request);
    if (!acct) return json({ error: '未登录' }, 401);
    const body = await readJson(request);
    if (!body || !Array.isArray(body.favs)) return json({ error: '格式错误' }, 400);
    const s = JSON.stringify(body.favs.slice(0, 3000));
    if (s.length > 900000) return json({ error: '收藏过多' }, 413);
    await env.DB.prepare('UPDATE users SET favs=?1 WHERE email=?2').bind(s, acct.email).run();
    return json({ ok: true, count: body.favs.length });
  }

  // ── 意见反馈：存 KV，配了 pushplusToken 则微信推送管理员 ──
  if (method === 'POST' && path === '/api/feedback') {
    const body = await readJson(request);
    const text = String((body && body.text) || '').trim().slice(0, 2000);
    if (!text) return json({ error: '反馈内容为空' }, 400);
    const contact = String((body && body.contact) || '').trim().slice(0, 100);
    let fb = {};
    try { fb = await env.KV.get('feedback', { type: 'json' }) || {}; } catch { fb = {}; }
    const id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
    fb[id] = { text, contact, time: new Date().toISOString(), status: 'new' };
    await env.KV.put('feedback', JSON.stringify(fb));
    const config = await loadConfig(env);
    if (config.pushplusToken) {
      ctx.waitUntil(fetch('https://www.pushplus.plus/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: config.pushplusToken, title: '俄语App · 新反馈', content: text + (contact ? '\n\n联系方式: ' + contact : '') })
      }).catch(() => {}));
    }
    return json({ ok: true });
  }

  if (method === 'GET' && path === '/api/diagnose') {    const result = { server: 'ok', time: Date.now(), checks: [] };
    try {
      const r = await fetch(`${DS_BASE}/v1/models`, { signal: AbortSignal.timeout(8000) });
      result.checks.push({ name: 'DeepSeek API', ok: true, detail: '可达 (HTTP ' + r.status + ')' });
    } catch (e) {
      result.checks.push({ name: 'DeepSeek API', ok: false, detail: e.message });
    }
    try {
      const r = await fetch('https://api.mymemory.translated.net/get?q=test&langpair=en|zh-CN', { signal: AbortSignal.timeout(8000) });
      const d = await r.json();
      result.checks.push({ name: 'MyMemory 翻译', ok: d.responseStatus === 200, detail: d.responseStatus === 200 ? '正常' : '异常: ' + (d.responseDetails || r.status) });
    } catch (e) {
      result.checks.push({ name: 'MyMemory 翻译', ok: false, detail: e.message });
    }
    return json(result);
  }

  if (method === 'POST' && path === '/api/translate') {
    const body = await readJson(request);
    if (body === null) return json({ error: '请求内容过大，已拒绝' }, 413);
    if (body === undefined) return json({ error: '请求体格式错误' }, 400);
    const access = await authorize(env, request, body);
    if (!access.ok) return json({ error: access.msg }, access.status);
    await countUse(env, access);
    const { src, tgt, text } = body;
    const NAMES = { ru: '俄语', en: '英语', 'zh-CN': '中文' };
    const srcName = NAMES[src] || src, tgtName = NAMES[tgt] || tgt;
    const d = await callDeepSeek(access.key, [
      { role: 'system', content: `你是专业的${srcName}→${tgtName}翻译助手，擅长日常口语和常用表达。

翻译要求：
1. 优先选择最常用、最地道的译法，避免生僻词和过于书面化的表达
2. 翻译单个单词时，给出该词最核心、最常用的义项
3. 翻译句子时用自然的口语表达，符合目标语言习惯
4. 严格忠实于原文，不增不减，不添加解释
5. 只返回译文本身，不要任何额外内容或格式` },
      { role: 'user', content: text }
    ], 2000, 15000);
    const translated = d.data.choices?.[0]?.message?.content?.trim() || '';
    return json({ text: translated, det: d.model === 'deepseek-v4-flash' ? 'DeepSeek V4 Flash' : 'DeepSeek Chat', model: d.model, remaining: remainingOf(access) });
  }

  if (method === 'POST' && path === '/api/dictionary') {
    const body = await readJson(request);
    if (body === null) return json({ error: '请求内容过大，已拒绝' }, 413);
    if (body === undefined) return json({ error: '请求体格式错误' }, 400);
    const access = await authorize(env, request, body);
    if (!access.ok) return json({ error: access.msg }, access.status);
    await countUse(env, access);
    const isEnDict = body.lang === 'en';
    const { parsed, raw, model, snippet } = await requestJsonAnalysis(access.key, [
      { role: 'system', content: isEnDict ? `你是英汉词典专家。给定英语单词或短语，只返回纯JSON（不要markdown代码块），字段结构：
{"word":"查询的词","stress":"音标 /.../ ",
"pos":"词性（中文：名词/动词/形容词/副词/短语）",
"meanings":[{"index":1,"chinese":"中文释义","explanation":"一句话补充：常用搭配/语域/用法","example":{"ru":"地道英文例句","cn":"例句中文翻译"}}]}
规则：meanings 给 2-3 个常用义项；例句自然地道；example 里的 ru 字段固定放英文例句（系统显示用）。` : `你是专业的俄语词典编纂专家。请为给定的俄语单词提供高质量的词典释义。

请按以下JSON格式返回（不要包含markdown代码块标记，只返回纯JSON）：

{
  "word": "原词",
  "stress": "带重音标注的单词（用 ' 符号，如 молоко'）",
  "pos": "词性（名词/动词/形容词/副词/前置词/连接词/代词/数词/感叹词/语气词）",
  "gender": "名词的性：阳/阴/中，非名词填null",
  "animacy": "动物名词/非动物名词，非名词填null",
  "meanings": [
    {"index": 1, "chinese": "中文释义", "explanation": "用法说明和语境", "example": {"ru": "俄语例句", "cn": "中文翻译"}, "register": "语体（通用/口语/书面/俗语/旧词/专业）"}
  ],
  "declension": "名词变格表概要（如适用，描述性文字）",
  "conjugation": "动词变位/时态概要（如适用，描述性文字）",
  "aspect_pair": "动词的体对：{imperfective: 未完成体, perfective: 完成体}，非动词填null",
  "collocations": ["常用搭配和短语"],
  "derivatives": ["派生词和同根词"],
  "synonyms": ["近义词及辨析"],
  "usage_note": "特别用法提示（如支配关系：动词+第几格）"
}

如果单词有多种词性或特殊情况（如多词性词），请在pos字段中说明，并在meanings中按词性分组。

词典质量对标俄罗斯科学院出版的《Большой толковый словарь русского языка》。释义准确、例句地道、标注完整。` },
      { role: 'user', content: body.word }
    ], 3000, 60000);
    if (parsed) {
      parsed._model = model === 'deepseek-v4-flash' ? 'DeepSeek V4 Flash' : 'DeepSeek Chat';
      parsed.remaining = remainingOf(access);
      return json(parsed);
    }
    return json({ raw: raw, snippet: snippet, error: 'JSON解析失败，返回原始内容' });
  }

  if (method === 'POST' && path === '/api/word-analysis') {
    const body = await readJson(request);
    if (body === null) return json({ error: '请求内容过大，已拒绝' }, 413);
    if (body === undefined) return json({ error: '请求体格式错误' }, 400);
    const word = String(body.word || '');
    const cacheKey = 'c:wa:' + await sha256(word);
    const cached = await env.KV.get(cacheKey, { type: 'json' });
    if (cached) {
      const access = await authorize(env, request, body); // 命中也先验码，但不计次数
      if (!access.ok) return json({ error: access.msg }, access.status);
      return json(Object.assign({}, cached, { remaining: remainingOf(access) }));
    }
    const access = await authorize(env, request, body);
    if (!access.ok) return json({ error: access.msg }, access.status);
    await countUse(env, access);
    const { parsed, raw, model, snippet } = await requestJsonAnalysis(access.key, [
      { role: 'system', content: `你是俄语语法分析专家。给定俄语单词，只返回纯JSON（不要markdown代码块）：

{"word":"原词","is_verb":true或false,"meanings":[{"index":1,"chinese":"中文释义","usage":"用法/语境"}],"aspect":{"imperfective":{"infinitive":"未完成体不定式","past":{"masc":"阳","fem":"阴","neut":"中","plur":"复"},"present":{"я":"","ты":"","он":"","мы":"","вы":"","они":""},"future":{"я":"","ты":"","он":"","мы":"","вы":"","они":""},"imperative":{"sg":"","pl":""},"participles":{"active_present":"","active_past":"","passive_present":"","passive_past":""},"gerunds":{"present":"","past":""}},"perfective":{"infinitive":"完成体不定式","past":{"masc":"","fem":"","neut":"","plur":""},"present":null,"future":{"я":"","ты":"","он":"","мы":"","вы":"","они":""},"imperative":{"sg":"","pl":""},"participles":{"active_past":"","passive_past":""},"gerunds":{"past":""}}},"declension":{"nominative":{"sg":"","pl":""},"genitive":{"sg":"","pl":""},"dative":{"sg":"","pl":""},"accusative":{"sg":"","pl":""},"instrumental":{"sg":"","pl":""},"prepositional":{"sg":"","pl":""}},"usage_note":"用法提示"}

规则：动词→aspect两体全填+declension填null；名词/形容词→declension六格+aspect填null；完成体无现在时；俄语填写，重音用'符号；meanings至少1个义项。` },
      { role: 'user', content: word }
    ], 2500, 60000);
    if (parsed) {
      parsed._model = model === 'deepseek-v4-flash' ? 'DeepSeek V4 Flash' : 'DeepSeek Chat';
      ctx.waitUntil(env.KV.put(cacheKey, JSON.stringify(parsed), { expirationTtl: 2592000 })); // 30天
      return json(parsed);
    }
    return json({ raw: raw, snippet: snippet, error: 'JSON解析失败' });
  }

  if (method === 'POST' && path === '/api/sentence-analysis') {
    const body = await readJson(request);
    if (body === null) return json({ error: '请求内容过大，已拒绝' }, 413);
    if (body === undefined) return json({ error: '请求体格式错误' }, 400);
    const text = String(body.text || '');
    if (!text.trim()) return json({ error: '文本为空' });
    const sLang = body.lang === 'en' ? 'en' : 'ru';
    const cacheKey = 'c:sa:' + await sha256(sLang + text);
    const cached = await env.KV.get(cacheKey, { type: 'json' });
    if (cached) {
      const access = await authorize(env, request, body); // 命中也先验码，但不计次数
      if (!access.ok) return json({ error: access.msg }, access.status);
      return json(Object.assign({}, cached, { remaining: remainingOf(access) }));
    }
    const access = await authorize(env, request, body);
    if (!access.ok) return json({ error: access.msg }, access.status);
    await countUse(env, access);
    const { parsed, raw, model, snippet } = await requestJsonAnalysis(access.key, [
      { role: 'system', content: sLang === 'en' ? `You are an English grammar teacher for Chinese learners. The user gives an English sentence. Return pure JSON only (no markdown):
{"structure":"用中文一两句说明句子成分与主句框架",
"keyPoints":[{"word":"句中出现的形式","base":"原形/词典形","why":"为什么用这个形式（时态/语态/冠词/介词/搭配），用中文一句话讲透"}],
"grammar":["本句核心语法点，每条一句话（中文）"],
"literal":"若英语语序与中文差异大，给逐词直译；否则空串",
"patterns":["换主题保留同款结构的仿造句1","仿造句2"]}
规则：keyPoints 只挑 3-6 个最关键的词；讲解一律用简体中文；不要逐词罗列虚词。` : `你是面向中文学习者的俄语语法讲解专家。用户给一个俄语句子，只返回纯JSON（不要markdown代码块）：
{"structure":"用主语/谓语/补语/状语标注句子成分，一两句话",
"keyPoints":[{"word":"句中出现的形式","base":"原形","why":"为什么用这个形式（格/体/时态/支配关系），一句话讲透"}],
"grammar":["本句核心语法点，每条一句话"],
"literal":"若俄语语序与中文差异大，给逐字直译；否则空串",
"patterns":["换主题但保留同款结构的仿造例句1","仿造例句2"]}
规则：keyPoints只挑3-6个最关键的词；简体中文讲解，语法术语准确；不要逐词罗列虚词。` },
      { role: 'user', content: text }
    ], 3000, 120000);
    if (parsed) {
      parsed._model = model === 'deepseek-v4-flash' ? 'DeepSeek V4 Flash' : 'DeepSeek Chat';
      ctx.waitUntil(env.KV.put(cacheKey, JSON.stringify(parsed), { expirationTtl: 604800 })); // 7天
      return json(parsed);
    }
    return json({ raw: raw, snippet: snippet, error: 'JSON解析失败' });
  }

  if (method === 'POST' && path === '/api/ai-quiz') {
    const body = await readJson(request);
    if (body === null) return json({ error: '请求内容过大，已拒绝' }, 413);
    if (body === undefined) return json({ error: '请求体格式错误' }, 400);
    const access = await authorize(env, request, body);
    if (!access.ok) return json({ error: access.msg }, access.status);
    await countUse(env, access);
    const lang = body.lang === 'en' ? 'en' : 'ru';
    const level = String(body.level || 'A2').slice(0, 4);
    const count = Math.min(10, Math.max(5, parseInt(body.count) || 10));
    const topic = String(body.topic || '').slice(0, 120) || '综合复习';
    const langName = lang === 'en' ? '英语' : '俄语';
    const { parsed, raw, model, snippet } = await requestJsonAnalysis(access.key, [
      { role: 'system', content: `你是面向中文学习者的${langName}出题专家。根据级别与主题出四选一练习题，只返回纯JSON（不要markdown代码块）：
{"questions":[{"tag":"语法或词汇或情景交际","q":"题干（${langName}）","opts":["选项A","选项B","选项C","选项D"],"ans":0,"explain":"一句话解析（中文）"}]}
规则：恰好 ${count} 道题；ans 是正确选项下标（0-3），各题分布随机；每题四个选项只有一个正确；难度贴合 ${level} 级；题目围绕给定主题；解析用中文。` },
      { role: 'user', content: `级别：${level}\n主题/难点：${topic}\n出题数量：${count}` }
    ], 3000, 120000);
    let qs = (parsed && Array.isArray(parsed.questions)) ? parsed.questions : [];
    qs = qs.filter(q => q && q.q && Array.isArray(q.opts) && q.opts.length === 4 && Number.isInteger(q.ans) && q.ans >= 0 && q.ans < 4)
      .map(q => ({ tag: ['语法', '词汇', '情景交际'].includes(q.tag) ? q.tag : '语法', q: String(q.q), opts: q.opts.map(String), ans: q.ans, explain: String(q.explain || '') }));
    if (qs.length) {
      return json({ questions: qs, _model: model === 'deepseek-v4-flash' ? 'DeepSeek V4 Flash' : 'DeepSeek Chat', remaining: remainingOf(access) });
    }
    return json({ raw: raw, snippet: snippet, error: 'AI 出题解析失败，请重试' });
  }

  if (method === 'POST' && path === '/api/class-translate') {
    const body = await readJson(request);
    if (body === null) return json({ error: '请求内容过大，已拒绝' }, 413);
    if (body === undefined) return json({ error: '请求体格式错误' }, 400);
    const text = String(body.text || '');
    const terms = String(body.terms || '').slice(0, 800);
    if (!text.trim()) return json({ error: '文本为空' });
    // 登录用户的课堂走专属逻辑（体验句数/套餐额度）；匿名照旧走接入码/设备试用
    const acct = await resolveAccount(env, request);
    let access, classroomLeft = null;
    if (acct) {
      const did = String(body.deviceId || request.headers.get('x-device-id') || '').trim();
      const ip = request.headers.get('CF-Connecting-IP') || '';
      if (did) await recordDevice(env, did, ip);
      const u = acct.user;
      const config = await loadConfig(env);
      const mk = masterKey(config);
      if (!mk) return json({ error: '服务端还没配置 API Key' }, 500);
      if (u.plan_days > 0 && u.plan_start) {
        const a = accountAccess(u, config);
        if (!a.ok) return json({ error: a.msg }, a.status);
        access = a;
      } else {
        const used = u.classroom_used || 0;
        if (used >= CLASSROOM_TRIAL_SENTENCES) {
          return json({ error: '课堂体验已用完（75 句 ≈ 15 分钟），购买套餐后可继续使用', classroomTrial: true }, 403);
        }
        access = { ok: true, key: mk, acct: true, email: acct.email, today: today(), limit: CLASSROOM_TRIAL_SENTENCES, entry: { used: {} }, classroomTrial: true };
        classroomLeft = CLASSROOM_TRIAL_SENTENCES - used;
      }
    } else {
      access = await authorize(env, request, body);
    }
    if (!access.ok) return json({ error: access.msg }, access.status);
    if (!access.classroomTrial) await countUse(env, access);
    const { parsed, raw, model } = await requestJsonAnalysis(access.key, [
      { role: 'system', content: `你是同声传译专家，处理俄语大学课堂口语。

任务：把老师说的话规整并翻译成中文。

两步处理（都在一个回答里完成）：
1. 规整：去掉口语填充词（ну, вот, так сказать, как бы, значит），修正不完整句和重复，保留专业术语
2. 翻译：把规整后的俄语翻译成简洁的中文，术语准确（语言学/文学术语按学界通用译法），适合实时阅读

严格按以下JSON格式返回（不要markdown代码块，只返回纯JSON）：
{"original":"规整后的俄语原文","translation":"中文翻译","note":"术语注释（如有难译术语，无则空字符串）"}

如果听不清或文本不完整，original保留原样，translation翻译能听懂的部分，note注明"音频不完整"。` },
      { role: 'user', content: text + (terms ? '\n\n[课程术语表，这些词的中文翻译必须采用：' + terms + ']' : '') }
    ], 3000, 30000);
    if (parsed && (parsed.original || parsed.translation)) {
      parsed._model = model === 'deepseek-v4-flash' ? 'DeepSeek V4 Flash' : 'DeepSeek Chat';
      if (access.classroomTrial) {
        // 课堂体验按句计，不占每日额度
        await env.DB.prepare('UPDATE users SET classroom_used=classroom_used+1 WHERE email=?').bind(acct.email).run();
        parsed.classroomLeft = Math.max(0, classroomLeft - 1);
      } else {
        parsed.remaining = remainingOf(access);
      }
      return json(parsed);
    }
    return json({ original: text.trim(), translation: raw, note: '规整失败，直译' });
  }

  return json({ error: 'Not found' }, 404);
}
