# 本体（サーバー）に問い合わせて stub.json を作る（開発用。利用者のパソコンでは使わない）。
# 使い方: python3 -I make-stub.py <本体> <書き出す stub.json>
import json, subprocess, sys, os, tempfile
bin, outp = sys.argv[1], sys.argv[2]
X = tempfile.mkdtemp(prefix='nd-stub-')
os.makedirs(X + '/vault'); open(X + '/vault/a.md', 'w').write('# a\n')
UI = {'extensions': {'io.modelcontextprotocol/ui': {'mimeTypes': ['text/html;profile=mcp-app']}}}
def session(caps):
    env = {'HOME': X, 'PATH': '/usr/bin:/bin', 'NOTE_ROOT': X + '/vault', 'NOTE_BACKUP_DIR': X + '/backup'}
    p = subprocess.Popen([bin], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, text=True, bufsize=1)
    n = [0]
    def call(m, params):
        n[0] += 1
        p.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': n[0], 'method': m, 'params': params}) + '\n'); p.stdin.flush()
        while True:
            r = json.loads(p.stdout.readline())
            if r.get('id') == n[0]: return r
    init = call('initialize', {'protocolVersion': '2025-06-18', 'capabilities': caps, 'clientInfo': {'name': 'make-stub', 'version': '0'}})
    p.stdin.write(json.dumps({'jsonrpc': '2.0', 'method': 'notifications/initialized'}) + '\n'); p.stdin.flush()
    return p, call, init
p, call, init = session(UI)
stub = {}
stub['supported_protocol_versions'] = None
stub['initialize'] = init['result']
stub['tools_list_ui'] = call('tools/list', {})['result']
stub['resources_list'] = call('resources/list', {})['result']
stub['resource_templates_list'] = call('resources/templates/list', {})['result']
uri = stub['resources_list']['resources'][0]['uri']
c = call('resources/read', {'uri': uri})['result']['contents'][0]
stub['panel_resource'] = {k: v for k, v in c.items() if k != 'text'}
p.stdin.close(); p.wait(5)
p, call, _ = session({})
stub['tools_list_no_ui'] = call('tools/list', {})['result']
p.stdin.close(); p.wait(5)
# 本体が答える protocolVersion の一覧（古いものから順に試して、同じ版を返したものだけ）
vs = []
for v in ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']:
    env = {'HOME': X, 'PATH': '/usr/bin:/bin', 'NOTE_ROOT': X + '/vault', 'NOTE_BACKUP_DIR': X + '/backup'}
    q = subprocess.run([bin], input=json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': v, 'capabilities': {}, 'clientInfo': {'name': 'x', 'version': '0'}}}) + '\n', capture_output=True, text=True, env=env, timeout=20)
    r = json.loads(q.stdout.splitlines()[0])
    if r['result']['protocolVersion'] == v: vs.append(v)
stub['supported_protocol_versions'] = vs
json.dump(stub, open(outp, 'w'), ensure_ascii=False, indent=1)
print('wrote', outp, 'versions', vs)
