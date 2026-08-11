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

// ⚡ DeepSeek 调用（模型回退：deepseek-v4-flash 失败时自动退回 deepseek-chat）
async function callDeepSeek(key, messages, maxTokens, timeoutMs) {
  const models = ['deepseek-v4-flash', 'deepseek-chat'];
  let lastErr = null;
  for (const model of models) {
    try {
      const resp = await fetch(`${DEEPSEEK}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`
        },
        body: JSON.stringify({ model, max_tokens: maxTokens, temperature: 0.1, messages }),
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
      return d;
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
  // 3. 截取第一个 { 到最后一个 } 再解析
  const b = s.indexOf('{'), e2 = s.lastIndexOf('}');
  if (b >= 0 && e2 > b) {
    try { return JSON.parse(s.slice(b, e2 + 1)); } catch (e) {}
  }
  // 4. 截取第一个 [ 到最后一个 ] 再解析（数组型）
  const ab = s.indexOf('['), ae = s.lastIndexOf(']');
  if (ab >= 0 && ae > ab) {
    try { return JSON.parse(s.slice(ab, ae + 1)); } catch (e) {}
  }
  return null;
}

// ⚡ 请求 JSON 分析并解析（失败自动用稳定模型重试一次）
async function requestJsonAnalysis(key, messages, maxTokens, timeoutMs) {
  // 第一次：flash 优先（快）
  let d = await callDeepSeek(key, messages, maxTokens, timeoutMs);
  let raw = d.choices?.[0]?.message?.content?.trim() || '';
  let parsed = extractJson(raw);
  if (parsed) return { parsed, raw };
  // 第二次：只用稳定模型 deepseek-chat 重试一次
  d = await callDeepSeek(key, messages, maxTokens, timeoutMs);
  raw = d.choices?.[0]?.message?.content?.trim() || '';
  parsed = extractJson(raw);
  if (parsed) return { parsed, raw };
  return { parsed: null, raw };
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
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { key, src, tgt, text } = JSON.parse(body);
        const NAMES={ru:'俄语',en:'英语','zh-CN':'中文'};
        const srcName=NAMES[src]||src;
        const tgtName=NAMES[tgt]||tgt;

        const d = await callDeepSeek(key, [
          { role: 'system', content: `你是专业的${srcName}→${tgtName}翻译助手。严格忠实于原文，不增不减，不添加解释。只返回译文。` },
          { role: 'user', content: text }
        ], 2000, 15000);
        const translated = d.choices?.[0]?.message?.content?.trim() || '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: translated, det: 'DeepSeek' }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── 字典查询 ──
  if (req.method === 'POST' && url === '/api/dictionary') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { key, word } = JSON.parse(body);
        const { parsed, raw } = await requestJsonAnalysis(key, [
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
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(parsed));
        } else {
          // 如果JSON解析失败，返回原始文本
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ raw: raw, error: 'JSON解析失败，返回原始内容' }));
        }
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── 单词详细分析（体的变位 + 时态变位 + 一词多译）──
  if (req.method === 'POST' && url === '/api/word-analysis') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { key, word } = JSON.parse(body);
        // ⚡ 内存缓存：同一单词第二次查询秒回
        const cached = analysisCache.get(word);
        if (cached) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(cached));
          return;
        }
        const { parsed, raw } = await requestJsonAnalysis(key, [
          { role: 'system', content: `你是俄语语法分析专家。给定俄语单词，只返回纯JSON（不要markdown代码块）：

{"word":"原词","is_verb":true或false,"meanings":[{"index":1,"chinese":"中文释义","usage":"用法/语境"}],"aspect":{"imperfective":{"infinitive":"未完成体不定式","past":{"masc":"阳","fem":"阴","neut":"中","plur":"复"},"present":{"я":"","ты":"","он":"","мы":"","вы":"","они":""},"future":{"я":"","ты":"","он":"","мы":"","вы":"","они":""},"imperative":{"sg":"","pl":""},"participles":{"active_present":"","active_past":"","passive_present":"","passive_past":""},"gerunds":{"present":"","past":""}},"perfective":{"infinitive":"完成体不定式","past":{"masc":"","fem":"","neut":"","plur":""},"present":null,"future":{"я":"","ты":"","он":"","мы":"","вы":"","они":""},"imperative":{"sg":"","pl":""},"participles":{"active_past":"","passive_past":""},"gerunds":{"past":""}}},"declension":{"nominative":{"sg":"","pl":""},"genitive":{"sg":"","pl":""},"dative":{"sg":"","pl":""},"accusative":{"sg":"","pl":""},"instrumental":{"sg":"","pl":""},"prepositional":{"sg":"","pl":""}},"usage_note":"用法提示"}

规则：动词→aspect两体全填+declension填null；名词/形容词→declension六格+aspect填null；完成体无现在时；俄语填写，重音用'符号；meanings至少1个义项。` },
          { role: 'user', content: word }
        ], 1500, 60000);
        if (parsed) {
          analysisCache.set(word, parsed);
          if (analysisCache.size > 500) { // 防无限膨胀，删最旧的1/3
            const del = Array.from(analysisCache.keys()).slice(0, 150);
            del.forEach(k => analysisCache.delete(k));
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(parsed));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ raw: raw, error: 'JSON解析失败' }));
        }
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
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
