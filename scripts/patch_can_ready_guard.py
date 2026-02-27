# -*- coding: utf-8 -*-
import os, re, time

ROOTS = ["src", "dist"]
EXTS = (".js", ".ts")
EXCLUDE_DIRS = set(["node_modules", ".git"])
BACKUP_TS = time.strftime("%Y%m%d_%H%M%S")

pat = re.compile(r'(?P<obj>[A-Za-z_$][\w$]*)\.status\s*=\s*(?P<q>["\'])CAN_SNAPSHOT_READY(?P=q)\s*;')

def should_skip(path):
    base = os.path.basename(path)
    if base == "worker_secrets.env":
        return True
    return False

def patch_file(path):
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        s = f.read()
    if "CAN_SNAPSHOT_READY" not in s:
        return False, "no-marker"
    if "__CAN_READY_GUARD__" in s:
        return False, "already"
    m = pat.search(s)
    if not m:
        return False, "no-assign"

    # condição robusta: job.ok OU ok
    cond = '(((typeof job!=="undefined") && job && job.ok===true) || ((typeof ok!=="undefined") && ok===true))'
    repl = m.group("obj") + '.status = ' + cond + ' ? "CAN_SNAPSHOT_READY" : "CAN_SNAPSHOT_ERROR"; /*__CAN_READY_GUARD__*/'

    s2, n = pat.subn(repl, s, count=1)
    if n <= 0:
        return False, "no-change"

    bak = path + ".bak_can_ready_guard_" + BACKUP_TS
    with open(bak, "w", encoding="utf-8", errors="replace") as f:
        f.write(s)
    with open(path, "w", encoding="utf-8", errors="replace") as f:
        f.write(s2)
    return True, bak

changed = []
for root in ROOTS:
    if not os.path.isdir(root):
        continue
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
        for fn in filenames:
            if not fn.endswith(EXTS):
                continue
            p = os.path.join(dirpath, fn)
            if should_skip(p):
                continue
            ok, info = patch_file(p)
            if ok:
                changed.append((p, info))

print("[PATCH] files changed:", len(changed))
for p, bak in changed:
    print(" -", p)
    print("   backup:", bak)

if not changed:
    print("[PATCH] nothing changed. (talvez o status seja setado de outro jeito; rode o grep corrigido com -E e me mande a saída)")
