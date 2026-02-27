# -*- coding: utf-8 -*-
import io, os, re, time
P = 'dist/worker/canSnapshotWorker.js'
TS = time.strftime('%Y%m%d_%H%M%S')

if not os.path.isfile(P):
    raise SystemExit('[ERRO] nao achei ' + P)

s = io.open(P, 'r', encoding='utf-8', errors='replace').read()
if '__COMPLETE_META_V2__' in s:
    print('[OK] ja aplicado'); raise SystemExit(0)

bak = P + '.bak_complete_meta_v2_' + TS
io.open(bak, 'w', encoding='utf-8', errors='replace').write(s)

# reason: incluir result.message
s2, _ = re.subn(
    r'reason:\s*\(result\s*&&\s*\(result\.reason\s*\|\|\s*result\.error\)\)\s*\|\|\s*null\s*,',
    'reason: (result && (result.reason || result.error || result.message || result.status)) || null,',
    s,
    count=1
)

# incluir meta.summary no payloadResult (small result)
marker = 'snapshots: snap ? [snap] : [],\n  };'
if marker in s2:
    s2 = s2.replace(
        marker,
        'snapshots: snap ? [snap] : [],\n'
        '    meta: (meta && typeof meta === "object") ? { summary: (meta.summary !== undefined ? meta.summary : null), errors: Array.isArray((meta.summary||{}).errors) ? (meta.summary||{}).errors : null } : null,\n'
        '  };\n'
        '  /*__COMPLETE_META_V2__*/',
        1
    )

# meta do /complete deve carregar summary+erro
pat_meta = re.compile(r'meta:\s*\{\s*kind:\s*"can_snapshot_summary_v1"\s*,\s*counts:\s*\(snap\s*&&\s*snap\.counts\)\s*\?\s*snap\.counts\s*:\s*null\s*\}\s*,')
def repl_meta(_m):
    return (
        'meta: {\n'
        '      kind: "can_snapshot_summary_v2",\n'
        '      ok: (payloadResult && payloadResult.ok === false) ? false : true,\n'
        '      counts: (snap && snap.counts) ? snap.counts : null,\n'
        '      summary: (payloadResult && payloadResult.meta && payloadResult.meta.summary !== undefined) ? payloadResult.meta.summary\n'
        '              : ((result && result.meta && result.meta.summary !== undefined) ? result.meta.summary : null),\n'
        '      errors: (payloadResult && payloadResult.meta && Array.isArray(payloadResult.meta.errors)) ? payloadResult.meta.errors\n'
        '             : ((result && result.meta && result.meta.summary && Array.isArray(result.meta.summary.errors)) ? result.meta.summary.errors : null),\n'
        '      message: (payloadResult && payloadResult.reason) ? String(payloadResult.reason)\n'
        '               : (result && (result.message || result.error || result.reason)) ? String(result.message || result.error || result.reason) : null\n'
        '    },\n'
        '    /*__COMPLETE_META_V2__*/\n'
    )
s3, _ = pat_meta.subn(repl_meta, s2, count=1)

# status do complete: ok/error (backend patch trata corretamente)
s4, _ = re.subn(r'status:\s*"completed"\s*,', 'status: (payloadResult && payloadResult.ok === false) ? "error" : "ok",', s3, count=1)

io.open(P, 'w', encoding='utf-8', errors='replace').write(s4)
print('[OK] patch aplicado:', P)
print('[OK] backup:', bak)
