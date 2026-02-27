# -*- coding: utf-8 -*-
import io, os, re, time

TS = time.strftime("%Y%m%d_%H%M%S")
targets = ["app/app_can_probe_v1.html", "public/app_can_probe_v1.html"]

def rd(p):
  with io.open(p, "r", encoding="utf-8", errors="replace") as f:
    return f.read()

def wr(p, s):
  with io.open(p, "w", encoding="utf-8", errors="replace") as f:
    f.write(s)

for p in targets:
  if not os.path.isfile(p):
    print("[probe] missing:", p)
    continue
  s = rd(p)
  if "__PROBE_READY_BY_DATA__" in s:
    print("[probe] already:", p)
    continue

  # injeta readyByData logo após statusReady
  s2, n1 = re.subn(
    r'(const\s+statusReady\s*=\s*String\(inst\.status\s*\|\|\s*""\)\s*===\s*"CAN_SNAPSHOT_READY";\s*)',
    r'\1\n        const readyByData = (hasCounts || hasModule || hasList);\n        if (statusReady && !readyByData) {\n          setStatus(`Snapshot vazio ⚠️ (READY mas sem dados). Clique "Request snapshot" novamente.`);\n        }\n        /*__PROBE_READY_BY_DATA__*/\n',
    s,
    count=1
  )

  # torna qualquer "statusReady" em sucesso somente se readyByData
  # (padrão comum: if (statusReady || hasCounts || hasModule || hasList) ...)
  s3, n2 = re.subn(
    r'\(\s*statusReady\s*\|\|',
    r'((statusReady && readyByData) ||',
    s2,
    count=1
  )

  if n1 == 0 and n2 == 0:
    print("[probe] no-change:", p, "(não achei o bloco esperado; procure manualmente por statusReady)")
    continue

  bak = p + ".bak_probe_ready_by_data_" + TS
  wr(bak, rd(p))
  wr(p, s3)
  print("[probe] patched:", p, "backup:", bak)
