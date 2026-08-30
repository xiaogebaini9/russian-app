// 本地服务器 — 托管网页 + DeepSeek 翻译代理
// 用法: node proxy.js
// 浏览器打开: http://localhost:8765

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 8765;
// 默认官方地址，可用环境变量覆盖（指向 opencode 等中转）；结尾带 /v1 的也兼容，统一去掉后代码里再拼
const DEEPSEEK = (process.env.DS_BASE_URL || 'https://api.deepseek.com').replace(/\/v1\/?$/, '');
const ROOT = __dirname; // russian-app 目录

// ⚡ 单词分析内存缓存（同词二次查询秒回）
const analysisCache = new Map();

// ⚡ 句子解析内存缓存（同句二次秒回，不计额度）
const sentenceCache = new Map();

// 请求体上限 1MB，防止超大请求滥用
const MAX_BODY = 1000000;

// 统一日志：控制台输出带时间戳，方便排查问题
function log(...args) {
  const t = new Date().toLocaleString('zh-CN', { hour12: false });
  console.log(`[${t}]`, ...args);
}

// 读取请求体，超过上限返回 null（用于拦截超大请求）
function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    let size = 0;
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        done(null);
        return;
      }
      body += chunk;
    });
    req.on('end', () => done(body));
    req.on('error', () => done(null));
  });
}

// ═══════════════════════════════════════════════════════════════
//  接入码系统：真 key 藏在服务端（keys.json），用户只持 7 位数字码
//  codes.json: { dailyLimit: 100, codes: { "4826159": { name, used: { 日期: 次数 } } } }
//  管理命令：node gen-codes.js（生成/key/list/del）
// ═══════════════════════════════════════════════════════════════
const CODES_FILE = path.join(__dirname, 'codes.json');
const KEYS_FILE = path.join(__dirname, 'keys.json');

function loadCodes() {
  try { return JSON.parse(fs.readFileSync(CODES_FILE, 'utf8')); }
  catch { return { dailyLimit: 100, codes: {} }; }
}
function saveCodes(db) {
  try { fs.writeFileSync(CODES_FILE, JSON.stringify(db, null, 2)); } catch (e) { log('codes.json 写入失败:', e.message); }
}
function loadMasterKey() {
  try { return (JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')).key || '').trim(); }
  catch { return ''; }
}

// raw = 用户在设置里填的内容：完整 sk- key 直通（兼容旧用法）；4~8 位数字码查名单
function resolveAccess(raw) {
  const k = String(raw || '').trim();
  if (/^sk-/.test(k)) return { ok: true, key: k };
  if (!/^\d{4,8}$/.test(k)) return { ok: false, status: 403, msg: '请先在设置中填写接入码（管理员发放的数字）或 API Key' };
  const db = loadCodes();
  const entry = db.codes && db.codes[k];
  if (!entry) return { ok: false, status: 403, msg: '接入码无效，请联系管理员' };
  const today = new Date().toISOString().slice(0, 10);
  const used = (entry.used && entry.used[today]) || 0;
  const limit = db.dailyLimit || 100;
  if (used >= limit) return { ok: false, status: 429, msg: `今日额度已用完（每码每天 ${limit} 次），明天再来` };
  const master = loadMasterKey();
  if (!master) return { ok: false, status: 500, msg: '服务端还没配置 API Key，请管理员运行 node gen-codes.js key sk-xxx' };
  return { ok: true, key: master, code: k, entry, today, limit };
}

// 请求通过验证即计一次额度（按尝试计，防重试刷量）；sk- 直通不计
function countUse(info) {
  if (!info || !info.code) return;
  const db = loadCodes();
  const entry = db.codes && db.codes[info.code];
  if (!entry) return;
  entry.used = entry.used || {};
  entry.used[info.today] = (entry.used[info.today] || 0) + 1;
  saveCodes(db);
}

// 各接口通用的拒绝响应（JSON，前端 friendlyErr 会原样显示）
function deny(res, access) {
  res.writeHead(access.status || 403, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: access.msg }));
}

// ⚡ DeepSeek 调用（模型回退：第一个模型失败时自动试下一个）
async function callDeepSeek(key, messages, maxTokens, timeoutMs, models, useJsonMode) {
  const list = models || ['deepseek-v4-flash', 'deepseek-chat'];
  let lastErr = null;
  for (const model of list) {
    try {
      const body = { model, max_tokens: maxTokens, temperature: 0.1, messages };
      // JSON 模式：强制模型只输出合法 JSON（DeepSeek 支持 OpenAI 兼容的 response_format）
      if (useJsonMode) body.response_format = { type: 'json_object' };
      const resp = await fetch(`${DEEPSEEK}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
      const d = await resp.json();
      if (d.error) {
        // 兼容各家上游：error 可能是字符串，也可能是 {message, type} 对象
        const msg = typeof d.error === 'string' ? d.error : (d.error.message || JSON.stringify(d.error));
        // 认证错误：key 本身无效，再试其他模型也没用 → 直接抛出
        if (/auth|invalid api key|authentication/i.test(msg)) throw new Error(msg);
        // 其他错误（如模型不存在、限流）→ 记录后尝试下一个模型
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

// ⚡ 从模型输出中提取 JSON（多级容错）
function extractJson(raw) {
  if (!raw) return null;
  // 1. 去掉 markdown 代码块包裹
  let s = raw.replace(/```(?:json)?\s*\n?([\s\S]*?)\n?```/g, '$1').trim();
  // 2. 直接解析
  try { return JSON.parse(s); } catch (e) {}
  // 3. 截取第一个 { 到最后一个 }，清洗后解析
  const b = s.indexOf('{'), e2 = s.lastIndexOf('}');
  if (b >= 0 && e2 > b) {
    let seg = s.slice(b, e2 + 1);
    // 去注释（// 行注释、/* */ 块注释）
    seg = seg.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n"]*/g, '');
    // 去尾逗号（JSON 不允许 ,} 和 ,]）
    seg = seg.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
    try { return JSON.parse(seg); } catch (e) {}
  }
  // 4. 截取第一个 [ 到最后一个 ] 再解析（数组型）
  const ab = s.indexOf('['), ae = s.lastIndexOf(']');
  if (ab >= 0 && ae > ab) {
    let seg = s.slice(ab, ae + 1);
    seg = seg.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n"]*/g, '');
    seg = seg.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
    try { return JSON.parse(seg); } catch (e) {}
  }
  return null;
}

// ⚡ 请求 JSON 分析并解析（失败时真正换模型重试）
async function requestJsonAnalysis(key, messages, maxTokens, timeoutMs) {
  // 第一次：v4-flash + 强制JSON模式（快）
  let r = await callDeepSeek(key, messages, maxTokens, timeoutMs, ['deepseek-v4-flash'], true);
  let raw = r.data.choices?.[0]?.message?.content?.trim() || '';
  let parsed = extractJson(raw);
  if (parsed) return { parsed, raw, model: r.model };
  // 第二次：真正换模型 → deepseek-chat + 强制JSON模式（稳）
  r = await callDeepSeek(key, messages, maxTokens, timeoutMs, ['deepseek-chat'], true);
  raw = r.data.choices?.[0]?.message?.content?.trim() || '';
  parsed = extractJson(raw);
  if (parsed) return { parsed, raw, model: r.model };
  // 失败：带上模型返回的内容片段，方便诊断
  const snippet = raw.length > 200 ? raw.slice(0, 200) + '…' : raw;
  return { parsed: null, raw, model: r.model, snippet };
}

const MIME = {
  '.html':'text/html;charset=utf-8',
  '.js':'application/javascript',
  '.json':'application/json',
  '.css':'text/css',
  '.png':'image/png',
  '.jpg':'image/jpeg',
  '.svg':'image/svg+xml',
  '.ico':'image/x-icon',
  '.webmanifest':'application/manifest+json'
};

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url.startsWith('/api/')) log(req.method, url, 'from', req.socket.remoteAddress || '-');

  // ── CORS: 允许页面从任意来源(file://、局域网 IP、开发端口)调用 API ──
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key'
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }
  const _writeHead = res.writeHead.bind(res);
  res.writeHead = (code, headers) => _writeHead(code, Object.assign({}, headers, corsHeaders));

  // ── 余额查询（仅 DeepSeek 官方地址支持，中转一般没有此接口）──
  if (req.method === 'GET' && url === '/api/balance') {
    if (DEEPSEEK !== 'https://api.deepseek.com') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ note: '当前 API 地址不支持余额查询，请改用「🔍 测试」验证连通性' }));
      return;
    }
    const key = req.headers['x-api-key'] || '';
    fetch(`${DEEPSEEK}/user/balance`, {
      headers: { 'Authorization': `Bearer ${key}` },
      signal: AbortSignal.timeout(10000)
    }).then(r => r.json()).then(d => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(d));
    }).catch(e => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    });
    return;
  }

  // ── 前端配置（告诉页面 API 地址是不是官方，决定测试按钮测什么）──
  if (req.method === 'GET' && url === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ isOfficial: DEEPSEEK === 'https://api.deepseek.com' }));
    return;
  }

  // ── Key 测试（接入码走本地验证不耗额度；完整 key 透传上游）──
  if (req.method === 'GET' && url === '/api/testkey') {
    const rawKey = String(req.headers['x-api-key'] || '').trim();
    if (/^\d{4,8}$/.test(rawKey)) {
      const access = resolveAccess(rawKey);
      if (!access.ok) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: access.msg }));
        return;
      }
      const used = (access.entry.used && access.entry.used[access.today]) || 0;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, code: true, remaining: Math.max(0, access.limit - used) }));
      return;
    }
    const key = rawKey;
    fetch(`${DEEPSEEK}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ model: 'deepseek-v4-flash', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
      signal: AbortSignal.timeout(15000)
    }).then(r => r.json()).then(d => {
      const rawError = d.error;
      if (rawError) {
        // 转成 {error: 字符串}，前端友好显示
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: typeof rawError === 'string' ? rawError : (rawError.message || JSON.stringify(rawError)) }));
        return;
      }
      if (d.choices && d.choices[0]) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, model: d.model || 'unknown' }));
        return;
      }
      // 上游返回了意料之外的格式，原样透传供排查
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(d));
    }).catch(e => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    });
    return;
  }

  // ── 翻译代理 ──
  if (req.method === 'POST' && url === '/api/translate') {
    readBody(req).then(async (body) => {
      if (body === null) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '请求内容过大，已拒绝' }));
        return;
      }
      try {
        const parsed = JSON.parse(body);
        const access = resolveAccess(parsed.key);
        if (!access.ok) return deny(res, access);
        countUse(access);
        const key = access.key;
        const { src, tgt, text } = parsed;
        const NAMES={ru:'俄语',en:'英语','zh-CN':'中文'};
        const srcName=NAMES[src]||src;
        const tgtName=NAMES[tgt]||tgt;

        const d = await callDeepSeek(key, [
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
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: translated, det: d.model === 'deepseek-v4-flash' ? 'DeepSeek V4 Flash' : 'DeepSeek Chat', model: d.model }));
      } catch (e) {
        log('ERROR', url, e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── 字典查询 ──
  if (req.method === 'POST' && url === '/api/dictionary') {
    readBody(req).then(async (body) => {
      if (body === null) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '请求内容过大，已拒绝' }));
        return;
      }
      try {
        const reqBody = JSON.parse(body);
        const access = resolveAccess(reqBody.key);
        if (!access.ok) return deny(res, access);
        countUse(access);
        const key = access.key;
        const { word } = reqBody;
        const { parsed, raw, model, snippet } = await requestJsonAnalysis(key, [
          { role: 'system', content: `你是专业的俄语词典编纂专家。请为给定的俄语单词提供高质量的词典释义。

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
          { role: 'user', content: word }
        ], 3000, 60000);
        if (parsed) {
          parsed._model = model === 'deepseek-v4-flash' ? 'DeepSeek V4 Flash' : 'DeepSeek Chat';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(parsed));
        } else {
          // 如果JSON解析失败，返回原始文本 + 内容片段便于诊断
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ raw: raw, snippet: snippet, error: 'JSON解析失败，返回原始内容' }));
        }
      } catch (e) {
        log('ERROR', url, e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── 单词详细分析（体的变位 + 时态变位 + 一词多译）──
  if (req.method === 'POST' && url === '/api/word-analysis') {
    readBody(req).then(async (body) => {
      if (body === null) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '请求内容过大，已拒绝' }));
        return;
      }
      try {
        const reqBody = JSON.parse(body);
        const { word } = reqBody;
        // ⚡ 内存缓存：同一单词第二次查询秒回（缓存命中不计额度）
        const cached = analysisCache.get(word);
        if (cached) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(cached));
          return;
        }
        const access = resolveAccess(reqBody.key);
        if (!access.ok) return deny(res, access);
        countUse(access);
        const key = access.key;
        const { parsed, raw, model, snippet } = await requestJsonAnalysis(key, [
          { role: 'system', content: `你是俄语语法分析专家。给定俄语单词，只返回纯JSON（不要markdown代码块）：

{"word":"原词","is_verb":true或false,"meanings":[{"index":1,"chinese":"中文释义","usage":"用法/语境"}],"aspect":{"imperfective":{"infinitive":"未完成体不定式","past":{"masc":"阳","fem":"阴","neut":"中","plur":"复"},"present":{"я":"","ты":"","он":"","мы":"","вы":"","они":""},"future":{"я":"","ты":"","он":"","мы":"","вы":"","они":""},"imperative":{"sg":"","pl":""},"participles":{"active_present":"","active_past":"","passive_present":"","passive_past":""},"gerunds":{"present":"","past":""}},"perfective":{"infinitive":"完成体不定式","past":{"masc":"","fem":"","neut":"","plur":""},"present":null,"future":{"я":"","ты":"","он":"","мы":"","вы":"","они":""},"imperative":{"sg":"","pl":""},"participles":{"active_past":"","passive_past":""},"gerunds":{"past":""}}},"declension":{"nominative":{"sg":"","pl":""},"genitive":{"sg":"","pl":""},"dative":{"sg":"","pl":""},"accusative":{"sg":"","pl":""},"instrumental":{"sg":"","pl":""},"prepositional":{"sg":"","pl":""}},"usage_note":"用法提示"}

规则：动词→aspect两体全填+declension填null；名词/形容词→declension六格+aspect填null；完成体无现在时；俄语填写，重音用'符号；meanings至少1个义项。` },
          { role: 'user', content: word }
        ], 2500, 60000);
        if (parsed) {
          parsed._model = model === 'deepseek-v4-flash' ? 'DeepSeek V4 Flash' : 'DeepSeek Chat';
          analysisCache.set(word, parsed);
          if (analysisCache.size > 500) { // 防无限膨胀，删最旧的1/3
            const del = Array.from(analysisCache.keys()).slice(0, 150);
            del.forEach(k => analysisCache.delete(k));
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(parsed));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ raw: raw, snippet: snippet, error: 'JSON解析失败' }));
        }
      } catch (e) {
        log('ERROR', url, e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── 课堂翻译（口语规整 + 学术翻译，一次调用）──
  // ── 句子解析（结构/关键点/语法点/直译/仿造句；思维链模型，token预算3000）──
  if (req.method === 'POST' && url === '/api/sentence-analysis') {
    readBody(req).then(async (body) => {
      if (body === null) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '请求内容过大，已拒绝' }));
        return;
      }
      try {
        const reqBody = JSON.parse(body);
        const { text } = reqBody;
        if (!text || !text.trim()) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '文本为空' }));
          return;
        }
        const cached = sentenceCache.get(text);
        if (cached) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(cached));
          return;
        }
        const access = resolveAccess(reqBody.key);
        if (!access.ok) return deny(res, access);
        countUse(access);
        const key = access.key;
        const { parsed, raw, model, snippet } = await requestJsonAnalysis(key, [
          { role: 'system', content: `你是面向中文学习者的俄语语法讲解专家。用户给一个俄语句子，只返回纯JSON（不要markdown代码块）：
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
          sentenceCache.set(text, parsed);
          if (sentenceCache.size > 300) { // 防无限膨胀，删最旧的1/3
            const del = Array.from(sentenceCache.keys()).slice(0, 100);
            del.forEach(k => sentenceCache.delete(k));
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(parsed));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ raw: raw, snippet: snippet, error: 'JSON解析失败' }));
        }
      } catch (e) {
        log('ERROR', url, e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && url === '/api/class-translate') {
    readBody(req).then(async (body) => {
      if (body === null) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '请求内容过大，已拒绝' }));
        return;
      }
      try {
        const reqBody = JSON.parse(body);
        const { text } = reqBody;
        if (!text || !text.trim()) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '文本为空' }));
          return;
        }
        const access = resolveAccess(reqBody.key);
        if (!access.ok) return deny(res, access);
        countUse(access);
        const key = access.key;
        const d = await callDeepSeek(key, [
          { role: 'system', content: `你是同声传译专家，处理俄语大学课堂口语。

任务：把老师说的话规整并翻译成中文。

两步处理（都在一个回答里完成）：
1. 规整：去掉口语填充词（ну, вот, так сказать, как бы, значит），修正不完整句和重复，保留专业术语
2. 翻译：把规整后的俄语翻译成简洁的中文，术语准确（语言学/文学术语按学界通用译法），适合实时阅读

严格按以下JSON格式返回（不要markdown代码块，只返回纯JSON）：
{"original":"规整后的俄语原文","translation":"中文翻译","note":"术语注释（如有难译术语，无则空字符串）"}

如果听不清或文本不完整，original保留原样，translation翻译能听懂的部分，note注明"音频不完整"。` },
          { role: 'user', content: text }
        ], 2000, 30000);
        const raw = d.data.choices?.[0]?.message?.content?.trim() || '';
        const parsed = extractJson(raw);
        if (parsed && (parsed.original || parsed.translation)) {
          parsed._model = d.model === 'deepseek-v4-flash' ? 'DeepSeek V4 Flash' : 'DeepSeek Chat';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(parsed));
        } else {
          // 兜底：解析失败时原文翻译分开返回
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ original: text.trim(), translation: raw, note: '规整失败，直译' }));
        }
      } catch (e) {
        log('ERROR', url, e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── 语音识别引擎健康探测（前端据此显示识别引擎状态）──
  if (req.method === 'GET' && url === '/api/voice-health') {
    fetch('http://127.0.0.1:9000/health', { signal: AbortSignal.timeout(3000) })
      .then(r => r.json().catch(() => ({})))
      .then(d => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, stt: d.status === 'ok', model: d.model || '', device: d.device || '' }));
      })
      .catch(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, stt: false }));
      });
    return;
  }

  // ── 语音识别（本地 Whisper，音频→文字）──
  if (req.method === 'POST' && url === '/api/voice') {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { tooLarge = true; req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', async () => {
      if (tooLarge) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '音频过大，已拒绝' }));
        return;
      }
      const audio = Buffer.concat(chunks);
      try {
        const r = await fetch('http://127.0.0.1:9000/transcribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: audio,
          signal: AbortSignal.timeout(120000)
        });
        const d = await r.json();
        if (d.error) throw new Error(d.error);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: d.text || '', language: d.language || '', confidence: d.confidence }));
      } catch (e) {
        log('ERROR', url, e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── 系统自检 ──
  if (req.method === 'GET' && url === '/api/diagnose') {
    (async () => {
      const result = { server: 'ok', time: Date.now(), checks: [] };
      // 1. DeepSeek API 可达性
      try {
        const r = await fetch(`${DEEPSEEK}/v1/models`, { signal: AbortSignal.timeout(8000) });
        result.checks.push({ name: 'DeepSeek API', ok: true, detail: '可达 (HTTP ' + r.status + ')' });
      } catch (e) {
        result.checks.push({ name: 'DeepSeek API', ok: false, detail: e.message });
      }
      // 2. MyMemory
      try {
        const r = await fetch('https://api.mymemory.translated.net/get?q=test&langpair=en|zh-CN', { signal: AbortSignal.timeout(8000) });
        const d = await r.json();
        result.checks.push({ name: 'MyMemory 翻译', ok: d.responseStatus === 200, detail: d.responseStatus === 200 ? '正常' : '异常: ' + (d.responseDetails || r.status) });
      } catch (e) {
        result.checks.push({ name: 'MyMemory 翻译', ok: false, detail: e.message });
      }
      // 3. LibreTranslate
      try {
        const r = await fetch('https://translate.terraprint.co/translate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q: 'test', source: 'en', target: 'zh', format: 'text' }), signal: AbortSignal.timeout(8000) });
        result.checks.push({ name: 'LibreTranslate', ok: r.ok, detail: 'HTTP ' + r.status + (r.ok ? '' : '（可能挂了）') });
      } catch (e) {
        result.checks.push({ name: 'LibreTranslate', ok: false, detail: e.message });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    })();
    return;
  }

  // ── 静态文件 ──
  let filePath = url === '/' ? '/index.html' : url;
  // 安全：防止目录遍历
  filePath = path.normalize(filePath).replace(/^(\.\.(\/|\\|$))+/, '');
  const fullPath = path.join(ROOT, filePath);

  const ext = path.extname(fullPath);
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    // ⚠️ 开发阶段禁用缓存，确保手机拿到最新代码
    const headers = { 'Content-Type': contentType };
    if (ext === '.html' || ext === '.js' || ext === '.json') {
      headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
      headers['Pragma'] = 'no-cache';
      headers['Expires'] = '0';
    }
    res.writeHead(200, headers);
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const os=require('os');
  const ifaces=os.networkInterfaces();
  console.log(`俄语学习服务器已启动`);
  console.log(`本机: http://localhost:${PORT}`);
  for(const name of Object.keys(ifaces)){
    for(const iface of ifaces[name]){
      if(iface.family==='IPv4'&&!iface.internal){
        console.log(`手机: http://${iface.address}:${PORT}`);
      }
    }
  }
  console.log('按 Ctrl+C 停止');
});
