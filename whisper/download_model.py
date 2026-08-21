import os, sys
os.environ['HF_ENDPOINT'] = 'https://hf-mirror.com'
os.environ['HF_HUB_DISABLE_XET'] = '1'
from huggingface_hub import snapshot_download

repo = 'deepdml/faster-whisper-large-v3-turbo-ct2'
dest = r'C:/Users/Administrator/russian-app/whisper/models'
print('开始下载', repo, file=sys.stderr, flush=True)
path = snapshot_download(repo_id=repo, local_dir=dest + '/faster-whisper-large-v3-turbo-ct2')
print('DONE ' + path)
