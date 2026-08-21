// 本地服务器 — 托管网页 + DeepSeek 翻译代理
// 用法: node proxy.js
// 浏览器打开: http://localhost:8765

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8765;
const DEEPSEEK = 'https://api.deepseek.com';
const ROOT = __dirname; // russian-app 目录

// ⚡ 单词分析内存缓存（同词二次查询秒回）
const analysisCache = new Map();

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
        const msg = d.error.message || 'API错误';
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

  // ── 余额查询 ──
  if (req.method === 'GET' && url === '/api/balance') {
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

  // ── 翻译代理 ──
  if (req.method === 'POST' && url === '/api/translate') {
    readBody(req).then(async (body) => {
      if (body === null) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '请求内容过大，已拒绝' }));
        return;
      }
      try {
        const { key, src, tgt, text } = JSON.parse(body);
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
        const { key, word } = JSON.parse(body);
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
        const { key, word } = JSON.parse(body);
        // ⚡ 内存缓存：同一单词第二次查询秒回
        const cached = analysisCache.get(word);
        if (cached) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(cached));
          return;
        }
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
  if (req.method === 'POST' && url === '/api/class-translate') {
    readBody(req).then(async (body) => {
      if (body === null) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '请求内容过大，已拒绝' }));
        return;
      }
      try {
        const { key, text } = JSON.parse(body);
        if (!text || !text.trim()) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '文本为空' }));
          return;
        }
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
