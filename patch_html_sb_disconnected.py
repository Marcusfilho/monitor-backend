#!/usr/bin/env python3
"""
PATCH SB_DISCONNECTED_FRONTEND_V1
Aplica os 4 pontos de correção no app_installations_v1.html
Uso: python3 patch_html_sb_disconnected.py
"""

import re, shutil, sys
from pathlib import Path

TARGET = Path.home() / "monitor-backend-dev/public/app_installations_v1.html"

if not TARGET.exists():
    print(f"[ERRO] Arquivo não encontrado: {TARGET}")
    sys.exit(1)

# Backup
backup = TARGET.with_suffix(".html.bak_sb_disconnected")
shutil.copy2(TARGET, backup)
print(f"[ok] Backup em: {backup}")

html = TARGET.read_text(encoding="utf-8")
original = html

# ─────────────────────────────────────────────────────────────
# PONTO 1 — label SB_DISCONNECTED no mapa de status
# ─────────────────────────────────────────────────────────────
OLD1 = '"SB_DONE":          "configurado",'
NEW1 = '"SB_DONE":          "configurado",\n      "SB_DISCONNECTED":  "⚠ comunicação perdida",'

if '"SB_DISCONNECTED"' in html:
    print("[skip] PONTO 1 já aplicado")
elif OLD1 in html:
    html = html.replace(OLD1, NEW1, 1)
    print("[ok] PONTO 1 aplicado — label SB_DISCONNECTED")
else:
    print("[AVISO] PONTO 1 — texto âncora não encontrado, pulando")

# ─────────────────────────────────────────────────────────────
# PONTO 2 — statusToStepIndex reconhece SB_DISCONNECTED
# ─────────────────────────────────────────────────────────────
OLD2 = 'const sbDone = s === "SB_DONE" || s.startsWith("CAN")'
NEW2 = 'const sbDone = s === "SB_DONE" || s === "SB_DISCONNECTED" || s.startsWith("CAN")'

if 's === "SB_DISCONNECTED"' in html:
    print("[skip] PONTO 2 já aplicado")
elif OLD2 in html:
    html = html.replace(OLD2, NEW2, 1)
    print("[ok] PONTO 2 aplicado — statusToStepIndex")
else:
    print("[AVISO] PONTO 2 — texto âncora não encontrado, pulando")

# ─────────────────────────────────────────────────────────────
# PONTO 3 — flag isSbDisconnected
# ─────────────────────────────────────────────────────────────
OLD3 = 'const isSbRunning  = st.includes("SB_RUNNING");'
NEW3 = ('const isSbRunning       = st.includes("SB_RUNNING");\n'
        '    const isSbDisconnected  = st === "SB_DISCONNECTED"; // PATCH SB_DISCONNECTED_FRONTEND_V1')

if 'isSbDisconnected' in html:
    print("[skip] PONTO 3 já aplicado")
elif OLD3 in html:
    html = html.replace(OLD3, NEW3, 1)
    print("[ok] PONTO 3 aplicado — flag isSbDisconnected")
else:
    print("[AVISO] PONTO 3 — texto âncora não encontrado, pulando")

# ─────────────────────────────────────────────────────────────
# PONTO 4 — bloco da barra + label (maior patch)
# ─────────────────────────────────────────────────────────────
OLD4 = (
    '    } else if (isSbDone) {\n'
    '      $("sbPct").textContent       = "100%";\n'
    '      $("sbFill").style.transition = "width 0.6s ease";\n'
    '      $("sbFill").style.width      = "100%";\n'
    '    } else {\n'
    '      // HTML5 ainda em andamento — barra vazia\n'
    '      $("sbPct").textContent       = "—";\n'
    '      $("sbFill").style.transition = "";\n'
    '      $("sbFill").style.width      = "0%";\n'
    '    }\n'
    '    // --- label de status textual do SB ---\n'
    '    const sbLabel = $("sbStatusLabel");\n'
    '    if (isSbQueued) {\n'
    '      sbLabel.textContent = "· aguardando SB...";\n'
    '      [sbLabel.style](http://sbLabel.style).color = "";\n'
    '    } else if (isSbRunning) {\n'
    '      const sbStatus = inst?.job?.progressStage ?? inst?.job?.progressDetail ?? inst?.job?.sbStatus ?? null;\n'
    '      sbLabel.textContent = sbStatus ? ("· " + sbStatus) : "· enviando...";\n'
    '      [sbLabel.style](http://sbLabel.style).color = "";\n'
    '    } else if (isSbDone) {\n'
    '      sbLabel.textContent = "· concluído ✓";\n'
    '      [sbLabel.style](http://sbLabel.style).color = "var(--good, #22c55e)";\n'
    '    } else {\n'
    '      sbLabel.textContent = "";\n'
    '      [sbLabel.style](http://sbLabel.style).color = "";\n'
    '    }'
)

NEW4 = (
    '    } else if (isSbDisconnected) {\n'
    '      // PATCH SB_DISCONNECTED_FRONTEND_V1: mostrar progresso real, não 100%\n'
    '      const pct = inst?.sb?.last_progress ?? sb ?? 0;\n'
    '      $("sbPct").textContent       = pct > 0 ? (pct + "%") : "—";\n'
    '      $("sbFill").style.transition = "width 0.6s ease";\n'
    '      $("sbFill").style.width      = (pct > 0 ? pct : 0) + "%";\n'
    '    } else if (isSbDone) {\n'
    '      $("sbPct").textContent       = "100%";\n'
    '      $("sbFill").style.transition = "width 0.6s ease";\n'
    '      $("sbFill").style.width      = "100%";\n'
    '    } else {\n'
    '      // HTML5 ainda em andamento — barra vazia\n'
    '      $("sbPct").textContent       = "—";\n'
    '      $("sbFill").style.transition = "";\n'
    '      $("sbFill").style.width      = "0%";\n'
    '    }\n'
    '    // --- label de status textual do SB ---\n'
    '    const sbLabel = $("sbStatusLabel");\n'
    '    if (isSbQueued) {\n'
    '      sbLabel.textContent = "· aguardando SB...";\n'
    '      sbLabel.style.color = "";\n'
    '    } else if (isSbRunning) {\n'
    '      const sbStatus = inst?.job?.progressStage ?? inst?.job?.progressDetail ?? inst?.job?.sbStatus ?? null;\n'
    '      sbLabel.textContent = sbStatus ? ("· " + sbStatus) : "· enviando...";\n'
    '      sbLabel.style.color = "";\n'
    '    } else if (isSbDisconnected) {\n'
    '      // PATCH SB_DISCONNECTED_FRONTEND_V1: alerta de desconexão + habilitar Validar CAN\n'
    '      sbLabel.textContent = "· ⚠ equipamento desconectou durante o SB";\n'
    '      sbLabel.style.color = "var(--warn, #f59e0b)";\n'
    '      if (!$("sbDisconnectAlert")) {\n'
    '        const alert = document.createElement("div");\n'
    '        alert.id = "sbDisconnectAlert";\n'
    '        alert.style.cssText = "margin-top:12px;padding:10px 14px;background:#1a1200;border:1px solid #f59e0b;border-radius:8px;color:#f59e0b;font-size:13px;line-height:1.5";\n'
    '        alert.innerHTML = "<b>⚠ Equipamento desconectou durante a atualização do SB.</b><br>" +\n'
    '          "O equipamento pode ter resetado e ainda estar atualizando. " +\n'
    '          "Você pode aguardar ou prosseguir clicando em <b>Validar CAN</b>.";\n'
    '        const progressWrap = $("sbFill")?.closest(".progressWrap");\n'
    '        if (progressWrap) progressWrap.insertAdjacentElement("afterend", alert);\n'
    '      }\n'
    '      const id2 = inst?.installation_id || inst?.id || "";\n'
    '      const tok2 = inst?.installation_token || inst?.token || "";\n'
    '      if (id2 && tok2) $("btnApprove").disabled = false;\n'
    '    } else if (isSbDone) {\n'
    '      sbLabel.textContent = "· concluído ✓";\n'
    '      sbLabel.style.color = "var(--good, #22c55e)";\n'
    '      const a = $("sbDisconnectAlert"); if (a) a.remove();\n'
    '    } else {\n'
    '      sbLabel.textContent = "";\n'
    '      sbLabel.style.color = "";\n'
    '    }'
)

if 'sbDisconnectAlert' in html:
    print("[skip] PONTO 4 já aplicado")
elif OLD4 in html:
    html = html.replace(OLD4, NEW4, 1)
    print("[ok] PONTO 4 aplicado — bloco barra + label + alerta")
else:
    # Tentar versão sem os [sbLabel.style](http://...) (markdown artifacts)
    OLD4_CLEAN = OLD4.replace(
        '      [sbLabel.style](http://sbLabel.style).color',
        '      sbLabel.style.color'
    )
    if OLD4_CLEAN in html:
        html = html.replace(OLD4_CLEAN, NEW4, 1)
        print("[ok] PONTO 4 aplicado (variante clean) — bloco barra + label + alerta")
    else:
        print("[AVISO] PONTO 4 — texto âncora não encontrado")
        print("        Verifique manualmente as linhas ~1835-1870 do HTML")

# ─────────────────────────────────────────────────────────────
# Salvar
# ─────────────────────────────────────────────────────────────
if html != original:
    TARGET.write_text(html, encoding="utf-8")
    print(f"\n[ok] Arquivo salvo: {TARGET}")
    # Copiar para dist/public também se existir
    dist = Path.home() / "monitor-backend-dev/dist/public/app_installations_v1.html"
    if dist.exists():
        shutil.copy2(TARGET, dist)
        print(f"[ok] Copiado para dist/public também")
else:
    print("\n[info] Nenhuma alteração feita (todos já aplicados ou âncoras não encontradas)")

# ─────────────────────────────────────────────────────────────
# Verificação final
# ─────────────────────────────────────────────────────────────
print("\n=== Verificação final ===")
final = TARGET.read_text(encoding="utf-8")
checks = [
    ("SB_DISCONNECTED label",    '"SB_DISCONNECTED"' in final),
    ("statusToStepIndex",        's === "SB_DISCONNECTED"' in final),
    ("flag isSbDisconnected",    'isSbDisconnected' in final),
    ("banner sbDisconnectAlert", 'sbDisconnectAlert' in final),
]
all_ok = True
for name, ok in checks:
    status = "✓" if ok else "✗ FALTANDO"
    print(f"  {status}  {name}")
    if not ok:
        all_ok = False

if all_ok:
    print("\n✅ Todos os patches aplicados com sucesso!")
else:
    print("\n⚠ Alguns patches não foram aplicados — verifique os AVISOS acima")
