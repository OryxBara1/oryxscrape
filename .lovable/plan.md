# Corrigir a conexão: remover Lovable Cloud e conectar o Supabase existente

## Objetivo
Desfazer a ativação do Lovable Cloud (criada por engano) e conectar este app ao projeto Supabase existente `nlthswnojvkqpooztans` (organização OryxBara).

## Contexto
- O Lovable Cloud foi ativado neste projeto, criando um novo backend gerenciado.
- O usuário queria conectar o projeto Supabase existente, não criar um novo.
- Nenhum código, schema ou dado foi criado ainda — então remover o Cloud agora não causa perda de dados.

## Passos

### 1. Desconectar o Lovable Cloud (ação do usuário, é administrador do workspace)
1. Abrir **Mais → Cloud → Advanced (Avançado)**.
2. Clicar em **Disconnect**.
3. **Atenção:** isso é irreversível e apaga todos os dados do Cloud — mas como nada foi construído ainda, não há nada a perder.

### 2. Conectar o Supabase existente (ação do usuário)
1. Abrir **Mais → Conectores → Supabase**.
2. Clicar em **Usar Supabase / Connect existing project**.
3. Selecionar a organização **OryxBara** e o projeto `nlthswnojvkqpooztans`.
4. Se o projeto não aparecer na lista: desconectar a organização em "Manage Connected Organizations" e reconectar (isso atualiza as permissões).

### 3. Confirmar a conexão (eu)
1. Verificar se as variáveis de ambiente do Supabase estão disponíveis no projeto.
2. Confirmar com um teste de leitura que o backend responde.

### 4. Seguir com o PLAN de arquitetura
Depois da conexão confirmada, o usuário envia a arquitetura/PLAN completo e eu preparo o plano de implementação.

## Nota técnica
A conexão de um projeto Supabase existente não pode ser feita por mim via chat — depende de autorização OAuth no navegador do usuário. Eu consigo apenas ativar novos projetos Lovable Cloud, que foi o que aconteceu por engano.
