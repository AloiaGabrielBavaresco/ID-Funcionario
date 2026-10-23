# Funcionários ativos — Bizneo HR

Página web que consulta a API da Bizneo HR e gera o relatório de
**funcionários ativos com ID e nome completo**, com filtro, download em CSV e
em Excel (.xlsx).

HTML/JavaScript puro + uma **Netlify Function**. O token da Bizneo fica só no
servidor (variável de ambiente), nunca no navegador.

```
bizneo-funcionarios/
  index.html                              Página (senha, botão, tabela, exportação)
  netlify/functions/funcionarios-ativos.js  Consulta a Bizneo e filtra os ativos
  netlify.toml  package.json  .env.example  .gitignore
```

## 1) Gerar o token na Bizneo

No painel da Bizneo, em configurações de API/integrações, crie um token de
API. A Bizneo informa que o acesso à API pode depender do plano contratado
(add-on); se a opção não aparecer, fale com o suporte da Bizneo.

O endereço da sua conta (`BIZNEO_DOMAIN`) é a URL que você usa para entrar
na Bizneo, por exemplo `https://aloiaaerospace.bizneohr.com`.

## 2) Publicar no Netlify

1. Suba esta pasta para um repositório (ou use arrastar-e-soltar no Netlify).
2. **Build command:** em branco · **Publish directory:** `.`
3. Em **Site settings > Environment variables**, crie:
   - `BIZNEO_DOMAIN` — ex.: `https://aloiaaerospace.bizneohr.com`
   - `BIZNEO_TOKEN` — o token do passo 1
   - `ACCESS_PASSWORD` — uma senha forte (protege a página; quem não tem a
     senha não consegue disparar a consulta)
4. Faça um novo deploy para a function enxergar as variáveis.

## 3) Usar

Abra o site, digite a senha e clique em **Gerar relatório**.

## Teste local (opcional)

```
npm i -g netlify-cli
cp .env.example .env     # preencha os valores
netlify dev
```

## Se a lista vier vazia, errada ou com nomes em branco

A function já segue o formato da sua conta (`users`, `page_size`,
`work_contracts[].end_at`, `first_name`/`last_name`). Se algo vier diferente, a
function tem um **modo diagnóstico** que mostra como o primeiro registro
realmente vem da sua conta. Rode no terminal (troque a URL e a senha):

```
curl -X POST "https://SEU-SITE.netlify.app/.netlify/functions/funcionarios-ativos?debug=1" \
  -H "Content-Type: application/json" -d '{"senha":"SUA_SENHA"}'
```

A resposta traz `chavesDoPrimeiroRegistro` e `primeiroRegistro`. Com isso,
ajuste em `funcionarios-ativos.js` as funções `nomeCompleto()` (campos do
nome) e `estaAtivo()` (campo que indica ativo/inativo).

> Atenção: o diagnóstico exibe dados reais de um funcionário. Use só para
> conferir os nomes dos campos e não compartilhe a saída.

## Segurança

- O token da Bizneo nunca vai para o navegador nem é gravado em log.
- A senha de acesso é comparada em tempo constante no servidor.
- Os dados exibidos são pessoais (nome e ID de funcionários): compartilhe a
  senha apenas com quem precisa.

## Alternativa em Python (sem Netlify)

`extrair_ativos.py` faz a mesma extração no seu computador e salva um Excel:

```
pip install requests openpyxl
set BIZNEO_TOKEN=seu-token        (Windows CMD)  |  export BIZNEO_TOKEN=seu-token  (Mac/Linux)
python extrair_ativos.py
```

Se a variável não estiver definida, o script pede o token no terminal.
