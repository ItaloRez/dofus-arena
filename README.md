# Arena 1.29

Jogo PvP tático por turnos no navegador, com as regras e os dados do Dofus 1.29. Sem Flash, sem login no mundo, sem mapa ou NPC: você entra no site, monta a build e cai direto na luta.

## Como rodar

**Com Docker** (na pasta deste README):

```bash
docker compose up -d --build
```

**Ou com Node 20+:**

```bash
cd server
npm install
npm start
```

Abra **http://localhost:8090**, crie uma conta e clique em **+ Nova** para montar uma build (o botão **Sugerir build** monta uma pronta).

## O que tem

- **Builds nível 200**: as 12 classes, 995 pontos de características com o custo real de cada classe, pergaminhos (até 101), 199 pontos de feitiços (níveis 1 a 6), 16 espaços de equipamento (inclui 6 Dofus e mascote) com itens no máximo, bônus de panóplia, até 3 poções. Até 30 builds salvas por conta.
- **Partidas**: fila 1v1 e 3v3 com matchmaking por Elo (a janela de rating aumenta com o tempo de espera), ranking e histórico. Opção de completar com IA se ninguém aparecer em 20 s (partida sem ranking). Treino contra IA a qualquer momento.
- **Combate** com as fórmulas da 1.29: PA/PM, alcance, linha de visão, feitiços em linha, críticos (fórmula da agilidade), falhas críticas, resistências fixas e % (limite de 50%), esquiva de PA/PM pela sabedoria, fuga de placagem pela agilidade, dano de empurrão, atenuação em área, roubo de vida, venenos, armaduras, reenvio de dano e de feitiço, invisibilidade, glifos, armadilhas, invocações (com IA) e o duplo, estados, castigos do Sacrier. Turnos de 30 s, posicionamento de 30 s. Quem sai da luta por mais de 90 s perde.
- **Armadilhas e invisibilidade como na 1.29**: a armadilha mostra na célula central o objeto que o servidor 1.29 manda com `GDC<célula>;Haaaaaaaaz3005` (objeto 25 da camada 2, animado; o glifo manda objeto 0, nada), só para quem vê a armadilha. O Sram invisível anda normalmente (semitransparente) para a própria equipe; os inimigos não recebem caminho nem célula, e o veem só por um instante quando ele lança um feitiço. Objetos animados: `CLIENT=... node tools/swf/export.cjs objanim 25`.

- **Feitiços**: os 20 de cada classe, o feitiço especial de cada classe (Brokle, Félintion, Mise en garde, Laisse Spirituelle, Poisse, Raulebaque, Mot Lotof, Retraite anticipée, Flèche de dispersion, Arbre de vie, Douleur partagée, Ivresse), a Invocação de Dopple e os feitiços comuns (Torta de Alho, Bumerangue Pérfido, Martelo da Lua, Liberação, Fulminante, invocações...), que qualquer classe escolhe na aba Feitiços (`tools/add_spells.py`).
- **Barra de feitiços**: 2 páginas de 20 (setas ao lado da grade ou roda do mouse). Os 20 feitiços da classe começam na página 1; o especial, o Dopple e os comuns na página 2. Arraste para trocar de lugar, inclusive entre páginas (passe o feitiço sobre a seta); o layout fica salvo na build (`spellSlots`). Os atalhos valem para a página visível. Atalhos 1–0 e Q–P, arma na tecla à esquerda do 1; clique direito num espaço para trocar a tecla (salvo no navegador).
- **Efeitos**: clique num lutador para abrir a janela com todos os efeitos ativos (arrastável).
- **Mapas de PvP**: as arenas do Goultarminador (subárea 536), só as simétricas (`src/game/symmetry.js` confere células, linha de visão e posições iniciais). O treino com espantalho continua nos mapas antigos (`pool: training`). Os mapas vêm de `tools/goultar.py` (dados cifrados do dump StarLoco) e `MAPS=... POOL=pvp node tools/swf/export.cjs maps`.
- **HUD** no layout do cliente, com a arte de `modules/core.swf` (`tools/swf/export-ui.cjs`).

## Pastas

| Pasta | O que é |
|---|---|
| `server/src/game/` | Regras: mapa e linha de visão (`map.js`, `maps.js`), características e itens (`stats.js`), combate (`fight.js`), IA (`ai.js`), builds automáticas (`builds.js`) |
| `server/src/server.js` | Site, API, filas, Elo e WebSocket |
| `server/public/` | Cliente (HTML, CSS e JS sem build) |
| `server/data/game.json` | Feitiços, itens, panóplias e invocações da 1.29 |
| `tools/extract.py` | Gera o `game.json` a partir dos dumps públicos do Codebreak e do StarLoco |
| `tools/swf/` | Leitor de SWF e exportação dos gráficos do cliente |
| `tools/audio.py` | Exporta os sons e as músicas de luta do cliente para `server/public/assets/audio/` |
| `server/data/maps.json` | Os 12 mapas de luta (células, linha de visão, posições) |

## Testes

Com o servidor rodando: `cd server && npm test` (lutas IA x IA de todas as classes e uma partida completa por WebSocket).

## Gráficos

Tudo que aparece na luta vem do cliente Dofus 1.29 (Spiritia): mapas reais (fundo, chão, objetos e posições iniciais), sprites animados das 12 classes (homem e mulher) e das invocações, efeitos de feitiço, ícones de feitiços e itens, nomes em português. Nada roda em Flash: os SWF foram convertidos uma vez em imagens com `tools/swf/` (leitor de SWF próprio que desenha num canvas do Chromium) e ficam em `server/public/assets/`.

Para gerar de novo (precisa do cliente e dos dumps):

```bash
python3 tools/lang.py <cliente>/lang/swf/items_pt_*.swf tools/out/items_pt_1386.json   # idem spells, itemsets, maps
python3 tools/enrich.py server/data/game.json tools/out/items_pt_1386.json tools/out/spells_pt_1380.json tools/out/itemsets_pt_1369.json
python3 tools/maps.py dump 10648 10301 ...        # células e posições dos mapas escolhidos
CLIENT=<pasta com clips/> node tools/swf/export.cjs all   # sprites, ícones, efeitos, mapas (precisa do Playwright)
python3 tools/portraits.py
```

**Direitos autorais:** esses gráficos são da Ankama. Num projeto privado tudo bem; se for publicar o jogo, troque por arte própria.

## Efeitos de feitiço

Os efeitos rodam como no cliente 1.29: `server/public/js/fxplayer.js` porta o `VisualEffectHandler.onLoadInit` (de `modules/core.swf`: tipos 10–51, ângulo, arco dos tipos 30/31, rastro dos 40/41, `cellFrom`/`cellTo` dos 50/51) e executa o ActionScript (AS1) de cada SWF de feitiço. `tools/swf/fxanim.cjs` exporta, por sprite, os clipes com script (timeline + bytecode) e pré-renderiza o resto em atlas (`assets/fx/anim/`). Para ler os scripts de um SWF: `node tools/swf/as.cjs <arquivo.swf>`.

```bash
CLIENT=<pasta do cliente>/ node tools/swf/fxanim.cjs        # todos os feitiços usados (ou passe ids de sprite)
```

## Som

Os sons também vêm do cliente 1.29: `tools/audio.py <pasta do cliente> server/public/assets` tira os MP3 de `audio/effects.swf` e `audio/musics.swf` e lê nos SWF dos sprites e feitiços em que quadro cada animação chama `SOMA.playSound`. Na luta tocam o som de cada ataque, golpe recebido, morte e efeito de feitiço, o aviso de início de luta e de turno, e a música de luta da subárea do mapa. O botão 🔊 (no topo e na barra da luta) abre as opções de som: música e efeitos com liga/desliga e volume próprios, salvos no navegador.
