import os, glob, time

# 注册 NVIDIA CUDA 运行库 DLL 目录（cuBLAS/cuDNN/NVRTC/cudart），再 import ctranslate2
_BASE = os.path.dirname(os.path.abspath(__file__))
_SITE = os.path.join(_BASE, 'venv', 'Lib', 'site-packages')
_dirs = [d for d in (glob.glob(os.path.join(_SITE, 'nvidia', '*', 'bin')) + glob.glob(os.path.join(_SITE, 'nvidia', '*', 'lib'))) if os.path.isdir(d)]
for d in _dirs:
    os.add_dll_directory(d)
# ctranslate2 用原生 LoadLibrary，只认 PATH，不认 add_dll_directory → 双保险
os.environ['PATH'] = os.pathsep.join(_dirs) + os.pathsep + os.environ.get('PATH', '')

from faster_whisper import WhisperModel

model_path = r'C:/Users/Administrator/russian-app/whisper/models/faster-whisper-large-v3-turbo-ct2'
audio_path = r'C:/Users/Administrator/russian-app/whisper/test_en.wav'

t0 = time.time()
print('加载模型...')
model = WhisperModel(model_path, device='cuda', compute_type='float16')
print('模型加载耗时 %.1f 秒' % (time.time() - t0))

t1 = time.time()
segments, info = model.transcribe(audio_path, language='en', beam_size=5)
text = ''.join(s.text for s in segments)
print('识别耗时 %.1f 秒' % (time.time() - t1))
print('检测语言:', info.language, '概率: %.2f' % info.language_probability)
print('识别结果:', text)
