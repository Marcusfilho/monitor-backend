Feche o marco desta sessão de forma autônoma, sem fazer perguntas. Siga exatamente os passos abaixo:

## 1. Entenda o que foi feito nesta sessão

Leia os diffs e logs para identificar o que mudou:
- `git diff HEAD~5..HEAD --stat` para ver os commits desta sessão
- `git log --oneline -10` para ver as mensagens de commit

## 2. Atualize o CLAUDE.md

Leia o CLAUDE.md atual e faça as seguintes atualizações **sem perguntar**:

**a) Mova itens resolvidos:** qualquer item em `### 🔴 Próxima sessão` que tenha sido resolvido nesta sessão (com base nos commits e diffs) deve ser movido para o início da lista em `### ✅ Feito recentemente`.

**b) Adicione itens novos ao ✅:** se há código novo commitado nesta sessão que ainda não está documentado no ✅, adicione uma linha descrevendo o que foi feito. Use o estilo das linhas existentes: `- Descrição curta: detalhe técnico do que mudou e por quê.`

**c) Atualize o 🔴 Próxima sessão:** se há pendências novas identificadas nos commits ou no contexto da conversa, adicione-as. Remova somente os itens que foram resolvidos.

**d) Atualize o 🟡 Backlog:** se há melhorias mencionadas na conversa mas não implementadas, adicione-as.

**e) Corrija duplicatas:** verifique e remova qualquer entrada duplicada na seção ✅.

## 3. Commit do CLAUDE.md

```
git add CLAUDE.md
git commit -m "docs: fecha marco - [resumo de 5-10 palavras do que foi feito]

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

## 4. Push

```
git push origin master
```

## 5. Confirme

Informe ao usuário em 2-3 linhas: o que foi movido para ✅, quais pendências ficaram no 🔴, e que o push foi feito.

---

**Regras:**
- NÃO faça perguntas. Tome decisões com base no contexto disponível.
- NÃO peça confirmação antes de commitar ou fazer push.
- Se não houver nada novo para documentar, apenas faça o push do que já está commitado.
- O commit do CLAUDE.md deve ser separado dos commits de código.
