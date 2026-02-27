# -*- coding: utf-8 -*-
import io, os, re, time
P='src/routes/jobRoutes.ts'
TS=time.strftime('%Y%m%d_%H%M%S')
if not os.path.isfile(P):
    raise SystemExit('[ERRO] nao achei '+P)

s=io.open(P,'r',encoding='utf-8',errors='replace').read()
if '__JOBS_COMPLETE_V3__' in s:
    print('[OK] ja aplicado'); raise SystemExit(0)

bak=P+'.bak_jobs_complete_v3_'+TS
io.open(bak,'w',encoding='utf-8',errors='replace').write(s)

pat=re.compile(r'// worker pode mandar status=success;.*?const finalStatus = okFlag \? "completed" : "error";\n', re.DOTALL)
repl="""// worker pode mandar status=success/done.
 // IMPORTANTE: para jobs CAN, status pode ser apenas um "envelope".
 // Regra: completed/complete só é OK se NÃO houver ok=false explícito.
 const isCompletedWord = (rawStatus === "completed" || rawStatus === "complete");
 const okFlag =
   rawStatus === "ok" ||
   rawStatus === "success" ||
   rawStatus === "done" ||
   ((req.body as any)?.ok === true) ||
   ((result as any)?.ok === true) ||
   (isCompletedWord && ((req.body as any)?.ok !== false) && ((result as any)?.ok !== false) && (String((result as any)?.status||"").toLowerCase() !== "error"));

 const finalStatus = okFlag ? "completed" : "error";
 /*__JOBS_COMPLETE_V3__*/\n"""

s2,n1=pat.subn(repl,s,count=1)
if n1==0:
    raise SystemExit('[ERRO] nao achei bloco okFlag para substituir')

pat2=re.compile(r'\n\s*// dispara encadeamento para Monitor \(SB\) após HTML5\n\s*if \(finalStatus === "completed"\) \{\n\s*_enqueueSchemeBuilderAfterHtml5\(job, result\);\n\s*_handleCanSnapshotComplete\(job, result, id\);\n\s*\}\n')
repl2="""
  // CAN snapshot: sempre atualizar instalação (READY/ERROR), mesmo se job falhar
  try { if ((job as any)?.type === "monitor_can_snapshot") _handleCanSnapshotComplete(job, result, id); } catch {}

  // dispara encadeamento para Monitor (SB) após HTML5 somente em sucesso
  if (finalStatus === "completed") {
    _enqueueSchemeBuilderAfterHtml5(job, result);
  }
"""
s3,n2=pat2.subn(repl2,s2,count=1)
if n2==0:
    raise SystemExit('[ERRO] nao achei bloco dispatch para substituir')

io.open(P,'w',encoding='utf-8',errors='replace').write(s3)
print('[OK] patch aplicado:',P)
print('[OK] backup:',bak)
