# -*- coding: utf-8 -*-
import io, os, re, time

TS = time.strftime("%Y%m%d_%H%M%S")

targets = [
  "src/routes/jobRoutes.ts",
  "dist/routes/jobRoutes.js",
  "dist/routes/jobRoutes.ts",
  "dist/routes/jobRoutes.mjs",
]

def read(p):
  with io.open(p, "r", encoding="utf-8", errors="replace") as f:
    return f.read()

def write(p, s):
  with io.open(p, "w", encoding="utf-8", errors="replace") as f:
    f.write(s)

def patch_one(path):
  if not os.path.isfile(path):
    return (False, "missing")
  s = read(path)
  if "__READYFIX_V2__" in s:
    return (False, "already")

  # 1) inserir __hasData depois do __summary (se existir)
  ins_pat = re.compile(r'(const\s+__summary\s*=\s*\([^;]*;\s*)', re.DOTALL)
  m = ins_pat.search(s)
  if not m:
    # fallback: não tem __summary; tenta inserir antes do patchInstallation(installationId, { ...
    ins_pat2 = re.compile(r'(\bpatchInstallation\s*\(\s*installationId\s*,\s*\{\s*)', re.DOTALL)
    m2 = ins_pat2.search(s)
    if not m2:
      return (False, "no-anchor")
    insert_at = m2.start(1)
    add = (
      'const __hasData = !!(__snap && ('
      '(__snap.counts && (((__snap.counts.params_total||0)+(__snap.counts.module_total||0)+(__snap.counts.paramsTotal||0)+(__snap.counts.moduleTotal||0))>0)) || '
      '((Array.isArray(__snap.parameters)&&__snap.parameters.length) || (Array.isArray(__snap.module_state)&&__snap.module_state.length) || (Array.isArray(__snap.moduleState)&&__snap.moduleState.length))'
      ')); /*__READYFIX_V2__*/\n'
    )
    s = s[:insert_at] + add + s[insert_at:]
  else:
    add = (
      '\n    const __hasData = !!(__snap && (\n'
      '      (__snap.counts && (((__snap.counts.params_total||0)+(__snap.counts.module_total||0)+(__snap.counts.paramsTotal||0)+(__snap.counts.moduleTotal||0))>0)) ||\n'
      '      ((Array.isArray(__snap.parameters)&&__snap.parameters.length) || (Array.isArray(__snap.module_state)&&__snap.module_state.length) || (Array.isArray(__snap.moduleState)&&__snap.moduleState.length))\n'
      '    )); /*__READYFIX_V2__*/\n'
    )
    s = s[:m.end(1)] + add + s[m.end(1):]

  # 2) trocar o trecho que seta READY sempre
  s2, n = re.subn(
    r'can_snapshot:\s*\(__snap\s*\|\|\s*null\)\s*,\s*status:\s*["\']CAN_SNAPSHOT_READY["\']',
    r'can_snapshot: (__hasData ? __snap : null), status: (__hasData ? "CAN_SNAPSHOT_READY" : "CAN_SNAPSHOT_ERROR")',
    s,
    count=1
  )
  if n == 0:
    return (False, "no-replace")

  bak = path + ".bak_readyfix_v2_" + TS
  write(bak, read(path))
  write(path, s2)
  return (True, bak)

changed = []
for t in targets:
  ok, info = patch_one(t)
  if ok:
    changed.append((t, info))

print("[READYFIX_V2] changed:", len(changed))
for p,b in changed:
  print(" -", p)
  print("   backup:", b)

if not changed:
  print("[READYFIX_V2] nothing changed. (o READY pode estar em outro arquivo de rota no dist; procure por 'status: \"CAN_SNAPSHOT_READY\"' em dist/routes)")
