# -*- coding: utf-8 -*-
import io, os, time
TS=time.strftime('%Y%m%d_%H%M%S')
paths=['public/app_can_probe_v1.html','app/app_can_probe_v1.html']

needle='const statusReady = String(inst.status || "") === "CAN_SNAPSHOT_READY";'
insert='''const statusErr = String(inst.status || "") === "CAN_SNAPSHOT_ERROR";
        if (statusErr) {
          const lastJob = (Array.isArray(inst.jobs) && inst.jobs.length) ? inst.jobs[inst.jobs.length - 1] : null;
          const meta = lastJob && lastJob.meta ? lastJob.meta : null;
          const errs = (meta && Array.isArray(meta.errors) && meta.errors.length) ? meta.errors
                    : (meta && meta.summary && Array.isArray(meta.summary.errors) && meta.summary.errors.length) ? meta.summary.errors
                    : (inst.can && inst.can.summary && Array.isArray(inst.can.summary.errors) && inst.can.summary.errors.length) ? inst.can.summary.errors
                    : null;
          const msg = (meta && (meta.message || meta.error || meta.reason)) ? (meta.message || meta.error || meta.reason)
                    : (errs && errs[0]) ? errs[0]
                    : 'Snapshot falhou';
          setStatus(`CAN falhou ❌ (${String(msg).slice(0,120)}) — use Request snapshot novamente`);
          return r;
        }
        /*__PROBE_STOP_ON_ERROR__*/\n'''

for p in paths:
    if not os.path.isfile(p):
        print('[probe] missing', p); continue
    s=io.open(p,'r',encoding='utf-8',errors='replace').read()
    if '__PROBE_STOP_ON_ERROR__' in s:
        print('[probe] already', p); continue
    if needle not in s:
        print('[probe] needle not found', p); continue
    bak=p+'.bak_stop_on_error_'+TS
    io.open(bak,'w',encoding='utf-8',errors='replace').write(s)
    s2=s.replace(needle, needle+'\n        '+insert,1)
    io.open(p,'w',encoding='utf-8',errors='replace').write(s2)
    print('[probe] patched', p, 'backup', bak)
