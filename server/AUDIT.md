# Auditoria da 1.29

Os dados em `data/game.json` definem feitiços, níveis, efeitos e referências de gráficos. O auditor percorre os 241 feitiços jogáveis, os feitiços de armadilhas/glifos e os feitiços das invocações. Ele compara IDs de efeito com os casos do motor e verifica sprites, transformações, animações solicitadas pelos feitiços, efeitos visuais e ícones. O relatório JSON inclui o SHA-256 de `game.json`, para registrar a versão exata dos dados usada numa comparação.

Na pasta `server`:

```sh
npm run test:rules        # testes determinísticos de regras compartilhadas
npm run audit:report      # inventário legível, exit 0
npm run audit             # gate completo; exit 1 quando houver lacunas
npm run audit:mechanics   # gate só das regras
npm run audit:assets      # gate só dos gráficos
node test/audit.mjs --json > /tmp/dofus-audit.json
```

Os gates de mecânica e assets estão verdes para cobertura de IDs e arquivos. Em execução normal, o motor avisa no console uma vez por ID desconhecido em cada luta; com `STRICT_EFFECTS=1` ele lança erro para facilitar testes. Não trate um efeito desconhecido como implementado apenas para fazê-lo passar: classifique-o a partir dos dados e de uma referência da versão 1.29, implemente a regra e adicione um teste de comportamento. O efeito 666 é a alternativa sem efeito em grupos probabilísticos; o auditor só o aceita quando outra alternativa existe e as probabilidades somam 100%.

Para gerar os gráficos que faltam, é necessário ter os SWFs do cliente 1.29. A pasta indicada por `CLIENT` deve conter `clips/sprites/` e `clips/spells/`:

```sh
CLIENT=/caminho/para/cliente-1.29 npm run export:required
npm run audit:assets
```

O exportador descobre automaticamente transformações como 8005 (Sadida) e 8002 (Xelor), animações `animN` usadas pelas classes e efeitos visuais de feitiços alcançáveis. Ele acrescenta folhas ausentes às existentes. Se o SWF original não tiver a animação pedida, a lacuna continua no relatório; não há substituição silenciosa. O cliente Spiritia Retro instalado neste computador foi encontrado e os assets ausentes foram gerados a partir dele.

A implementação dos efeitos 122, 183, 184 e 776 foi conferida com o catálogo de efeitos do Codebreak 1.29; o dano permanente básico de 10% foi cotejado com a implementação StarLoco. O efeito 130 rouba kamas, ação sem consequência de combate nesta arena PvP. Uma auditoria verde comprova cobertura de IDs e arquivos, não equivalência completa das regras. Para isso, compare cenários determinísticos (mesmas builds, posições, sequência de ações e sorteios) com registros de combate de Dofus 1.29 e mantenha as diferenças como testes de regressão. Priorize interações de duração, PA/PM, invocações, área, linha de visão, crítico, estados, armadilhas e feitiços especiais.

Referências de código: [catálogo de efeitos 1.29 do Codebreak](https://github.com/hussein-aitlahcen/codebreak/blob/master/src/Codebreak.Service.World/Game/Spell/SpellEffect.cs), [fórmula de redução física/mágica](https://github.com/hussein-aitlahcen/codebreak/blob/master/src/Codebreak.Service.World/Game/Fight/AbstractFighter.cs), [dano permanente do StarLoco](https://github.com/StarLoco/StarLoco-Game/blob/master/src/org/starloco/locos/common/Formulas.java). O StarLoco atual tem versão própria; esses pontos ainda precisam de comparação com combates reais do alvo 1.29.
