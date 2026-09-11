# Passo 14 (nova tentativa) — instalar os 8 componentes do 21st.dev

## Atenção antes de começar

A chave enviada na mensagem foi `SUA_CHAVE_AQUI` — esse é o texto de exemplo, não uma chave real.
Nenhuma instalação vai funcionar com ele. Preciso da chave verdadeira do 21st.dev, e ela deve ser
guardada no cofre de segredos do projeto (nunca colada dentro do código ou de um endereço visível).

Se preferir não usar chave, o 21st.dev também permite login pela linha de comando; nesse caso eu
sigo por ali. Basta dizer qual caminho prefere.

## O que será feito

1. **Guardar a credencial com segurança**
   Abro o formulário seguro para você digitar a chave, que fica salva como `API_KEY_21ST`.
   O valor não passa pelo chat nem fica no repositório.

2. **Configurar o acesso ao catálogo e instalar os 8 componentes**
   Registro o catálogo autenticado do 21st.dev na configuração de componentes e rodo a instalação
   dos oito itens pedidos, um a um:
   dashboard-sidebar, glowing-card, glare-cards, animated-status-badge, hud-status-1,
   v-table-3, glow-button, v-skeleton-8.
   Se algum falhar, eu paro e digo exatamente qual e por quê — nenhum substituto padrão é colocado
   no lugar em silêncio.

3. **Trocar a barra lateral provisória pela definitiva**
   A navegação atual (feita à mão como solução temporária) é substituída pelo componente real
   `dashboard-sidebar`, mantendo os mesmos cinco itens de menu, o botão de sair e o visual escuro
   com brilho.

4. **Aplicar os outros 7 componentes nas telas**

   | Componente | Onde entra |
   | --- | --- |
   | glowing-card | os 4 indicadores do Painel |
   | glare-cards | o bloco do último registro de auditoria e destaques do Painel |
   | animated-status-badge | situações: coletas, ativo/pausado das fontes, resultado da auditoria |
   | hud-status-1 | faixa de estado no topo do Painel e da tela de Coletas |
   | v-table-3 | as tabelas de Fontes, Coletas, Itens e Auditoria |
   | glow-button | todos os botões: nova fonte, excluir, promover item, sair |
   | v-skeleton-8 | estado de carregamento de cada tabela e indicador |

5. **Limpeza e verificação**
   Removo os elementos provisórios que deixarem de ser usados, confiro que as cinco telas
   continuam carregando com os dados reais, que a tela de acesso segue protegendo tudo, e
   que a compilação fica limpa.

## Detalhes técnicos

- Segredo `API_KEY_21ST` no cofre do projeto; a instalação lê a variável de ambiente em tempo de
  execução do CLI. A chave não é escrita em `components.json`, em `.npmrc` versionado, nem em URLs
  gravadas no repositório.
- `components.json` ganha uma entrada em `registries` apontando para o 21st.dev com cabeçalho de
  autenticação por variável de ambiente, em vez de `?api_key=` embutido em cada URL.
- Componentes chegam em `src/components/ui/`; os arquivos temporários `src/components/app-shell.tsx`
  e `src/components/data-ui.tsx` são refatorados para embrulhar os componentes reais, preservando as
  chamadas às funções de servidor já prontas (Fase 3) sem alterar consultas nem regras de acesso.
- Nenhuma mudança de banco, RLS ou API nesta etapa.

## O que fica pendente

Se a chave não der acesso a algum dos oito itens, aquele item permanece marcado como bloqueado no
roadmap e a peça provisória correspondente continua no lugar, claramente sinalizada.
