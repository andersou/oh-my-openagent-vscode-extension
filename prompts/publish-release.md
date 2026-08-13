# Prompt reutilizável: publicar nova versão da extensão

Use este fluxo sempre que eu pedir para publicar uma nova versão (commit, push, bump, VSIX e release).

## Fluxo

1. **Estado do repo** — confira `git status` na branch `dev`, sincronizado com `origin/dev`. Não publique com working tree sujo de mudanças não relacionadas.
2. **Suíte completa** — rode `npm test`; só prossiga com 100% dos testes passando.
3. **Commits das mudanças** — siga o conventional commits do histórico (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore(release):`), em inglês. Implementação e seu teste vão no mesmo commit.
4. **Changelog** — adicione a entrada `## [X.Y.Z-beta.N] - AAAA-MM-DD` no topo do `CHANGELOG.md` (Keep a Changelog), com seções `Bug Fixes` / `Features` / `Tests` conforme o caso. Commit: `docs: add changelog for X.Y.Z-beta.N`.
5. **Bump de versão** — em `dev`, incremente apenas o sufixo beta em `package.json` (ex.: `1.0.0-beta.1` → `1.0.0-beta.2`). Não altere `package-lock.json` (convenção do repo: o commit de bump toca só `package.json`). Commit: `chore(release): bump version to X.Y.Z-beta.N`.
6. **Push** — `git push origin dev`.
7. **Tag** — `git tag vX.Y.Z-beta.N && git push origin vX.Y.Z-beta.N` (sempre com o prefixo `v`).
8. **VSIX** — `npm run package`, que gera `oh-my-openagent-vscode-X.Y.Z-beta.N.vsix` na raiz. Arquivos `.vsix` estão no `.gitignore` e nunca são commitados.
9. **Release no GitHub** — `gh release create vX.Y.Z-beta.N oh-my-openagent-vscode-X.Y.Z-beta.N.vsix --prerelease --title "vX.Y.Z-beta.N" --notes-file <notas.md>`. As notas seguem o formato da release anterior: resumo, `BREAKING CHANGES` (se houver), features/fixes, verificação (número de testes/arquivos) e instrução de instalação do VSIX (`code --install-extension <arquivo.vsix>`).

## Regras

- Em `dev` sempre incrementa o beta (`-beta.N` → `-beta.N+1`). Versão estável só sai da branch principal.
- Release de beta é sempre `--prerelease`.
- Se `npm test` falhar em qualquer etapa, pare e corrija antes de publicar — nunca publique com teste quebrado.

## Fluxo para versão estável (main)

1. **Merge** — na `main` (sincronizada com `origin/main`, working tree limpo), rode `git merge dev`. Se houver conflito em `CHANGELOG.md`, mantenha as entradas novas acima e as antigas abaixo, preservando os links de compare no fim do arquivo; em `package.json`, a versão da `dev` vence.
2. **Suíte completa** — rode `npm test` na main mergeada; só prossiga com 100% passando.
3. **Changelog** — adicione `## [X.Y.0] - AAAA-MM-DD` no topo do `CHANGELOG.md`, consolidando o conteúdo das betas promovidas (breaking changes, migration, features, fixes), e inclua o link de compare `[X.Y.0]: ...compare/vANTERIOR...vX.Y.0` no fim do arquivo. Commit: `docs: add changelog for X.Y.0`.
4. **Bump** — remova o sufixo beta em `package.json` (ex.: `1.0.0-beta.2` → `1.0.0`). Commit: `chore(release): bump version to X.Y.0`.
5. **Push e tag** — `git push origin main`, `git tag vX.Y.0 && git push origin vX.Y.0`.
6. **VSIX** — `npm run package` → `oh-my-openagent-vscode-X.Y.0.vsix`.
7. **Release estável** — `gh release create vX.Y.0 oh-my-openagent-vscode-X.Y.0.vsix --title "vX.Y.0" --notes-file <notas.md>` — **sem** `--prerelease` (a release vira `Latest` automaticamente).
8. **Convergência** — volte para a `dev` e faça `git merge main` (normalmente fast-forward), depois `git push origin dev`, para as duas branches apontarem para o mesmo commit. O próximo ciclo de beta começa da versão estável (ex.: `1.0.1-beta.1` ou `1.1.0-beta.1`).
