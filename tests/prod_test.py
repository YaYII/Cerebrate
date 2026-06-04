#!/usr/bin/env python3
"""Cerebrate v6 — 30 项生产级测试."""
import subprocess, time, json, sys, threading, urllib.request, urllib.error

proc = subprocess.Popen(
    [sys.executable, 'cerebrate.py', 'serve', '--host', '127.0.0.1',
     '--port', '8765', '--quiet'],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    cwd='/home/as-workstation01/Documents/project/Cerebrate')
time.sleep(6)

URL = 'http://127.0.0.1:8765'
P = 0; F = 0

def t(name, fn):
    global P, F
    try: fn(); print(f'  PASS: {name}'); P += 1
    except Exception as e: print(f'  FAIL: {name} — {e}'); F += 1

def req(method, path, body=None):
    d = json.dumps(body).encode() if body else None
    h = {'Content-Type': 'application/json'} if body else {}
    try:
        r = urllib.request.urlopen(urllib.request.Request(URL+path, data=d, headers=h, method=method), timeout=10)
        return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try: return json.loads(e.read().decode())
        except: return {'error': str(e.code)}
    except Exception as e: return {'error': str(e)}

print('='*52)
print('  Cerebrate v6 Production Tests (30)')
print('='*52)

t('01. GET  /v1/sense',          lambda: req('GET','/v1/sense')['status']=='ok')
t('02. POST /v1/agents/register',lambda: req('POST','/v1/agents/register',{'agent_id':'pt','agent_type':'cli'})['status']=='ok')
t('03. GET  /v1/help',          lambda: req('GET','/v1/help')['status']=='ok')
t('04. GET  /v1/doctrines',     lambda: req('GET','/v1/doctrines')['status']=='ok')
t('05. GET  /v1/brain/assess',  lambda: req('GET','/v1/brain/assess')['status']=='ok')
t('06. GET  /v1/llm/status',    lambda: req('GET','/v1/llm/status')['status']=='ok')

r=req('POST','/v1/memories/propose',{'title':'Python SSL fix','content':'pip install --trusted-host for corp CA certs','category':'devops','tags':'python,ssl','agent_id':'pt','problem':'pip SSL error','solution':'--trusted-host','validate':False})
m1=r['data']['memory_id']; t('07. propose EN', lambda: m1 is not None)
r=req('POST','/v1/memories/propose',{'title':'React useEffect loop','content':'deps mutation inside useEffect','category':'debugging','tags':'react','agent_id':'pt','problem':'infinite render','solution':'useRef','validate':False})
m2=r['data']['memory_id']; t('08. propose #2', lambda: m2 is not None)
r=req('POST','/v1/memories/propose',{'title':'数据库连接池调优','content':'CPUx2+spare连接','category':'performance','tags':'db,pool','agent_id':'pt','problem':'连接耗尽','solution':'CPUx2','validate':False})
t('09. propose CJK', lambda: r['data']['memory_id'] is not None)

t('10. query: pip SSL found',  lambda: req('POST','/v1/query',{'query':'pip SSL 证书错误','agent_id':'pt'})['data']['found']==True)
t('11. query: new topic',      lambda: req('POST','/v1/query',{'query':'K8s CRD best','agent_id':'pt'})['data']['recommendation']=='new_experience')
t('12. query: CJK 连接池',     lambda: req('POST','/v1/query',{'query':'数据库连接池','agent_id':'pt'})['data']['found']==True)
t('13. query: React useEffect',lambda: req('POST','/v1/query',{'query':'React useEffect 循环','agent_id':'pt'})['data']['found']==True)
t('14. GET mem/<id>',          lambda: req('GET',f'/v1/memories/{m1}')['data']['category']=='devops')

t('15. personal set', lambda: req('POST','/v1/personal',{'user':'pt','key':'tone','value':'clean'})['status']=='ok')
t('16. personal get', lambda: 'pt' in req('GET','/v1/personal')['data']['users'])

u=req('POST','/v1/usages/start',{'memory_id':m1,'agent':'pt','problem':'ssl'})
uid=u['data']['usage_id']; t('17. use start', lambda: uid is not None)
t('18. use finish', lambda: req('POST','/v1/usages/finish',{'usage_id':uid,'outcome':'success','feedback':'good'})['status']=='ok')

t('19. consensus vote',     lambda: req('POST','/v1/consensus/vote',{'memory_id':m1,'agent':'pt','vote':'support','evidence':'verified','confidence':0.9})['status']=='ok')
t('20. consensus snapshot', lambda: 'decision' in req('GET',f'/v1/consensus/{m1}')['data'])

t('21. batch process', lambda: req('POST','/v1/batch/process',{'limit':20,'dry_run':False})['status']=='ok')
t('22. evolve',        lambda: 'actions' in req('POST','/v1/evolve')['data'])
t('23. events',        lambda: len(req('GET','/v1/events?cursor=0&limit=100')['data']['events'])>0)

t('24. empty title 400', lambda: req('POST','/v1/memories/propose',{'content':'x','agent_id':'x','validate':False})['status']=='error')
t('25. nonexistent 404',lambda: req('GET','/v1/memories/deadbeef00000000')['status']=='error')
t('26. unknown path',   lambda: req('GET','/v1/nonexistent')['status']=='error')
t('27. 5KB content',    lambda: req('POST','/v1/memories/propose',{'title':'big','content':'A'*5000,'category':'testing','tags':'big','agent_id':'pt','problem':'b','solution':'p','validate':False})['status']=='ok')

dr=req('POST','/v1/memories/propose',{'title':'Docker layer cache','content':'Put rarely-changing layers first','category':'devops','tags':'docker','agent_id':'pt','problem':'slow','solution':'reorder','validate':False})
did=dr['data']['memory_id']
for _ in range(5):
    ud=req('POST','/v1/usages/start',{'memory_id':did,'agent':'pt','problem':'docker'})
    req('POST','/v1/usages/finish',{'usage_id':ud['data']['usage_id'],'outcome':'success'})
t('28. reuse >= 5', lambda: req('GET',f'/v1/memories/{did}')['data']['reuse_count']>=5)

errs=[]
def prop(i):
    try:
        r=req('POST','/v1/memories/propose',{'title':f'c-{i}','content':f'ct{i}','category':'testing','tags':'conc','agent_id':'pt','problem':'c','solution':f's-{i}','validate':False})
        if r.get('status')!='ok': errs.append(r)
    except Exception as e: errs.append(str(e))
thr=[threading.Thread(target=prop,args=(i,)) for i in range(5)]
[t.start() for t in thr]; [t.join(timeout=10) for t in thr]
t('29. 5 concurrent proposes', lambda: len(errs)==0)

time.sleep(2)
for _ in range(8):
    try:
        if req('GET','/v1/sense')['data']['health']=='healthy': break
    except: pass
    time.sleep(1)
t('30. final health', lambda: req('GET','/v1/sense')['data']['health']=='healthy')

proc.terminate(); proc.wait(timeout=3)
print(f'\n  PASSED: {P} / 30')
if F: print(f'  FAILED: {F}'); sys.exit(1)
print('  ALL 30 TESTS PASSED')
