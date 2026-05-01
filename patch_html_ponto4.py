#!/usr/bin/env python3
"""
PATCH SB_DISCONNECTED_FRONTEND_V1 — PONTO 4 apenas
Aplica o bloco da barra + label no app_installations_v1.html
Uso: python3 patch_html_ponto4.py
"""

import shutil, sys
from pathlib import Path

TARGET = Path.home() / "monitor-backend-dev/public/app_installations_v1.html"

if not TARGET.exists():
    print(f"[ERRO] Arquivo não encontrado: {TARGET}")
    sys.exit(1)

backup = TARGET.with_suffix(".html.bak_ponto4")
shutil.copy2(TARGET, backup)
print(f"[ok] Backup em: {backup}")

html = TARGET.read_text(encoding="utf-8")

if 'sbDisconnectAlert' in html:
    print("[skip] PONTO 4 já aplicado")
    sys.exit(0)

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
    '\n'
    '    // --- label de status textual do SB ---\n'
    '    const sbLabel = $("sbStatusLabel");\n'
    '    if (isSbQueued) {\n'
    '      sbLabel.textContent = "· aguardando SB...";\n'
    '      sbLabel.style.color = "";\n'
    '    } else if (isSbRunning) {\n'
    '      const sbStatus = inst?.job?.progressStage ?? inst?.job?.progressDetail ?? inst?.job?.sbStatus ?? null;\n'
    '      sbLabel.textContent = sbStatus ? ("· " + sbStatus) : "· enviando...";\n'
    '      sbLabel.style.color = "";\n'
    '    } else if (isSbDone) {\n'
    '      sbLabel.textContent = "· concluído ✓";\n'
    '      sbLabel.style.color = "var(--good, #22c55e)";\n'
    '    } else {\n'
    '      sbLabel.textContent = "";\n'
    '      sbLabel.style.color = "";\n'
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
    '\n'
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
    '      // PATCH SB_DISCONNECTED_FRONTEND_V1: alerta + habilitar Validar CAN\n'
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

if OLD4 in html:
    html = html.replace(OLD4, NEW4, 1)
    TARGET.write_text(html, encoding="utf-8")
    # Copiar para dist/public também
    dist = Path.home() / "monitor-backend-dev/dist/public/app_installations_v1.html"
    if dist.exists():
        shutil.copy2(TARGET, dist)
        print("[ok] Copiado para dist/public também")
    print("[ok] PONTO 4 aplicado com sucesso!")
else:
    print("[ERRO] Âncora não encontrada — cole a saída abaixo para diagnóstico:")
    # Mostrar o trecho real para comparar
    lines = html.splitlines()
    for i, l in enumerate(lines, 1):
        if 'isSbDone' in l and 'sbPct' in lines[i] if i < len(lines) else False:
            print(f"  linha {i}: {l}")

# Verificação final
final = TARGET.read_text(encoding="utf-8")
ok = 'sbDisconnectAlert' in final
print(f"\n{'✅ Verificado — sbDisconnectAlert presente no arquivo' if ok else '✗ FALHOU — sbDisconnectAlert não encontrado'}")
