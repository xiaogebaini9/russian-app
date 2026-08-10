// 本地服务器 — 托管网页 + DeepSeek 翻译代理
// 用法: node proxy.js
// 浏览器打开: http://localhost:8765

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8765;
const DEEPSEEK = 'https://api.deepseek.com';
const ROOT = __dirname; // russian-app 目录

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

        const dsResp = await fetch(`${DEEPSEEK}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${key}`
          },
          body: JSON.stringify({
            model: 'deepseek-chat',
            max_tokens: 2000,
            temperature: 0.1,
            messages: [
              { role: 'system', content: `你是专业的${srcName}→${tgtName}翻译助手。严格忠实于原文，不增不减，不添加解释。只返回译文。` },
              { role: 'user', content: text }
            ]
          }),
          signal: AbortSignal.timeout(15000)
        });

        const d = await dsResp.json();
        if (d.error) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: d.error.message || 'API错误' }));
          return;
        }
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
    res.writeHead(200, { 'Content-Type': contentType });
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
