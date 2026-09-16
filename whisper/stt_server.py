import os, sys, glob, tempfile, json, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# 目录常量
BASE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.join(BASE, 'venv', 'Lib', 'site-packages')
MODEL_DIR = os.path.join(BASE, 'models', 'faster-whisper-large-v3-turbo-ct2')
PORT = 9000
LANG = 'ru'  # 课堂场景默认俄语，可用 ?lang= 覆盖

# 先注册 NVIDIA CUDA 运行库 DLL 目录（cuBLAS/cuDNN/NVRTC/cudart），再 import ctranslate2
_dll_dirs = [d for d in (glob.glob(os.path.join(SITE, 'nvidia', '*', 'bin')) + glob.glob(os.path.join(SITE, 'nvidia', '*', 'lib'))) if os.path.isdir(d)]
for d in _dll_dirs:
    os.add_dll_directory(d)
# ctranslate2 用原生 LoadLibrary 加载 cublas，只认 PATH 不认 add_dll_directory → 双保险
os.environ['PATH'] = os.pathsep.join(_dll_dirs) + os.pathsep + os.environ.get('PATH', '')

from faster_whisper import WhisperModel

print('[stt] 加载模型 %s (cuda/float16)...' % MODEL_DIR, flush=True)
_t0 = time.time()
model = WhisperModel(MODEL_DIR, device='cuda', compute_type='float16')
print('[stt] 模型加载完成，耗时 %.1f 秒' % (time.time() - _t0), flush=True)


# ── GigaAM v3（俄语专用，M3）：懒加载，engine=gigaam 时才初始化 ──
_gigaam_model = None
def _get_gigaam():
    global _gigaam_model
    if _gigaam_model is None:
        os.environ.setdefault('HF_ENDPOINT', 'https://hf-mirror.com')
        import onnx_asr
        _t1 = time.time()
        _gigaam_model = onnx_asr.load_model('gigaam-v3-ctc')
        print('[stt] GigaAM v3 加载完成，耗时 %.1f 秒' % (time.time() - _t1), flush=True)
    return _gigaam_model


def transcribe_gigaam(path):
    """GigaAM CTC：仅俄语，无时间戳/置信度（接口返回 None 让前端按旧逻辑兜底）"""
    r = _get_gigaam().recognize(path)
    text = r if isinstance(r, str) else (r.get('text') if isinstance(r, dict) else str(r))
    return {'text': (text or '').strip(), 'language': 'ru', 'confidence': None, 'engine': 'gigaam'}


def transcribe(data, lang=LANG, prompt=None, beam=5):
    fd, path = tempfile.mkstemp(suffix='.webm')
    with os.fdopen(fd, 'wb') as f:
        f.write(data)
    try:
        # initial_prompt 用来把课程术语表和前文喂给识别器，让它把专名和术语认对
        kw = {'language': lang, 'beam_size': beam, 'vad_filter': True}
        if prompt:
            kw['initial_prompt'] = prompt
        segments, info = model.transcribe(path, **kw)
        segs = list(segments)
        text = ''.join(s.text for s in segs).strip()
        probs = [s.avg_logprob for s in segs if getattr(s, 'avg_logprob', None) is not None]
        confidence = round(sum(probs) / len(probs), 4) if probs else None
        return {'text': text, 'language': info.language, 'confidence': confidence}
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith('/health'):
            self._send(200, {'status': 'ok', 'model': 'large-v3-turbo', 'device': 'cuda', 'lang': LANG, 'gigaam': _gigaam_model is not None})
        else:
            self._send(404, {'error': 'not found'})

    def do_POST(self):
        if self.path.startswith('/transcribe'):
            from urllib.parse import urlparse, parse_qs
            _q = parse_qs(urlparse(self.path).query)
            lang = _q.get('lang', [LANG])[0]
            # 精修模式会带 prompt（课程术语表 + 前文）；beam 可选，默认沿用 5
            prompt = (_q.get('prompt', [''])[0] or '').strip()[:1000] or None
            try:
                beam = max(1, min(10, int(_q.get('beam', ['5'])[0])))
            except (TypeError, ValueError):
                beam = 5
            length = int(self.headers.get('Content-Length', 0))
            data = self.rfile.read(length)
            if not data:
                self._send(400, {'error': 'empty audio'})
                return
            t0 = time.time()
            try:
                engine = (_q.get('engine', ['whisper'])[0] or 'whisper').lower()
                if engine == 'gigaam':
                    fd2, path2 = tempfile.mkstemp(suffix='.wav')
                    with os.fdopen(fd2, 'wb') as f2:
                        f2.write(data)
                    try:
                        r = transcribe_gigaam(path2)
                    finally:
                        try:
                            os.remove(path2)
                        except OSError:
                            pass
                else:
                    r = transcribe(data, lang, prompt, beam)
                r['elapsed'] = round(time.time() - t0, 2)
                self._send(200, r)
            except Exception as e:
                self._send(500, {'error': str(e)})
        else:
            self._send(404, {'error': 'not found'})

    def log_message(self, fmt, *args):
        sys.stderr.write('[stt] %s - %s\n' % (self.address_string(), fmt % args))


if __name__ == '__main__':
    srv = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    print('[stt] 服务已启动 http://127.0.0.1:%d' % PORT, flush=True)
    srv.serve_forever()
