// =========================================================================
// NETLIFY FUNCTION: funcionarios-ativos
// =========================================================================
// Consulta a API da Bizneo HR (GET {domínio}/api/v1/users) e devolve só
// os funcionários ATIVOS, com ID e nome completo.
//
// Regras confirmadas pelo script Python da própria conta: lista em
// data.users, paginação com page/page_size, ativo = algum work_contract com
// end_at nulo, nome = first_name + last_name.
//
// O token da Bizneo fica apenas aqui (variável de ambiente), nunca no
// navegador. A autenticação da Bizneo é feita pelo parâmetro de URL
// `token` e o header `Accept: application/json` é obrigatório (conforme a
// documentação oficial: https://connect.bizneo.com/hcm/v1/).
//
// Variáveis de ambiente (Netlify > Site settings > Environment variables):
//   BIZNEO_DOMAIN     https://aloiaaerospace.bizneohr.com   (sem barra final)
//   BIZNEO_TOKEN      token de API gerado no painel da Bizneo
//   ACCESS_PASSWORD   senha que protege esta página/function
//   BIZNEO_DEPARTMENT_FIELD  (opcional) caminho do campo de departamento, se a
//                     detecção automática não achar. Ex.: department.name
//
// Modo diagnóstico: chamar com ?debug=1 devolve a estrutura (nomes e tipos
// dos campos) do primeiro registro e o valor dos campos que parecem
// departamento. Não devolve nome, e-mail nem outros dados pessoais.
// =========================================================================

const crypto = require('crypto');

const TAMANHO_PAGINA = 50;
const MAX_PAGINAS = 200; // trava de segurança contra loop infinito

function resposta(status, corpo) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    body: JSON.stringify(corpo),
  };
}

// Comparação de senha em tempo constante (evita ataque por tempo de resposta).
function senhaConfere(informada, esperada) {
  const a = crypto.createHash('sha256').update(String(informada || '')).digest();
  const b = crypto.createHash('sha256').update(String(esperada || '')).digest();
  return crypto.timingSafeEqual(a, b);
}

// A resposta de listagem pode vir como array puro ou embrulhada em
// { users: [...] } / { data: [...] } / { items: [...] }.
function extrairLista(json) {
  if (Array.isArray(json)) return json;
  if (json && typeof json === 'object') {
    for (const chave of ['users', 'data', 'items', 'results']) {
      if (Array.isArray(json[chave])) return json[chave];
    }
  }
  return [];
}

function textoOuVazio(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

function nomeCompleto(u) {
  // Padrão da conta: first_name + last_name.
  const padrao = [textoOuVazio(u.first_name), textoOuVazio(u.last_name)].filter(Boolean).join(' ');
  if (padrao) return padrao;
  const direto = textoOuVazio(u.full_name || u.fullname || u.complete_name);
  if (direto) return direto;
  const partes = [
    textoOuVazio(u.first_name || u.name),
    textoOuVazio(u.last_name || u.surname || u.lastname),
  ].filter(Boolean);
  return partes.join(' ');
}

// -------------------------------------------------------------------------
// DEPARTAMENTO
// O nome do campo varia entre contas da Bizneo, então procuramos nos
// candidatos mais comuns, primeiro no usuário e depois nos contratos de
// trabalho ativos. O valor pode ser texto, objeto ({name: ...}) ou lista.
// Para forçar um campo específico, defina a variável de ambiente
// BIZNEO_DEPARTMENT_FIELD (ex.: "department.name" ou "work_contracts.0.department").
// -------------------------------------------------------------------------
const CAMPOS_DEPARTAMENTO = ['department', 'department_name', 'departments', 'area', 'team', 'organization_unit'];
const PADRAO_CAMPO_DEPARTAMENTO = /depart|setor|area|team|equipe|group|grupo|unit|organi/i;

function valorComoTextos(v) {
  if (v === null || v === undefined) return [];
  if (typeof v === 'string' || typeof v === 'number') {
    const s = textoOuVazio(v);
    return s ? [s] : [];
  }
  if (Array.isArray(v)) return v.flatMap(valorComoTextos);
  if (typeof v === 'object') {
    for (const k of ['name', 'title', 'label', 'description']) {
      if (v[k]) return valorComoTextos(v[k]);
    }
  }
  return [];
}

function lerCaminho(obj, caminho) {
  return caminho.split('.').reduce((o, k) => (o !== null && o !== undefined && typeof o === 'object' ? o[k] : undefined), obj);
}

function juntarUnicos(lista) {
  return Array.from(new Set(lista)).join(' / ');
}

function departamentoDe(u, campoForcado) {
  if (campoForcado) return juntarUnicos(valorComoTextos(lerCaminho(u, campoForcado)));

  const fontes = [u];
  if (Array.isArray(u.work_contracts)) {
    fontes.push(...u.work_contracts.filter((c) => c && (c.end_at === null || c.end_at === undefined)));
  }
  for (const fonte of fontes) {
    for (const campo of CAMPOS_DEPARTAMENTO) {
      const textos = valorComoTextos(fonte[campo]);
      if (textos.length) return juntarUnicos(textos);
    }
    // Último recurso: qualquer chave que contenha "depart" ou "setor".
    for (const [chave, valor] of Object.entries(fonte)) {
      if (/depart|setor/i.test(chave)) {
        const textos = valorComoTextos(valor);
        if (textos.length) return juntarUnicos(textos);
      }
    }
  }
  return '';
}

// Diagnóstico sem expor dados pessoais: lista os caminhos e tipos dos campos
// e mostra o VALOR só dos campos cujo nome lembra departamento/equipe/área.
function estruturaDe(obj, prefixo = '', saida = { tipos: {}, candidatos: {} }, dentroDeCandidato = false) {
  for (const [chave, valor] of Object.entries(obj || {})) {
    const caminho = prefixo ? `${prefixo}.${chave}` : chave;
    const parecido = dentroDeCandidato || PADRAO_CAMPO_DEPARTAMENTO.test(chave);
    if (Array.isArray(valor)) {
      saida.tipos[caminho] = 'lista';
      if (valor[0] && typeof valor[0] === 'object') estruturaDe(valor[0], `${caminho}.0`, saida, parecido);
    } else if (valor && typeof valor === 'object') {
      saida.tipos[caminho] = 'objeto';
      estruturaDe(valor, caminho, saida, parecido);
    } else {
      saida.tipos[caminho] = valor === null ? 'vazio (null)' : typeof valor;
      // Mostra o valor só de campos que lembram departamento (ou que estão dentro deles).
      if (parecido && valor !== null) saida.candidatos[caminho] = valor;
    }
  }
  return saida;
}

// Regras para decidir se o usuário está ativo, na ordem:
//  0) padrão da conta: ativo = tem algum work_contract sem data de fim (end_at nula)
//  1) campo booleano explícito (active / enabled)
//  2) campo de texto "status"/"state"
//  3) datas de desligamento (terminated_at / termination_date / end_date)
//  4) sem nenhum indício de inatividade -> ativo
function estaAtivo(u) {
  if (Array.isArray(u.work_contracts)) {
    return u.work_contracts.some((c) => c && (c.end_at === null || c.end_at === undefined));
  }
  for (const campo of ['active', 'enabled', 'is_active']) {
    if (typeof u[campo] === 'boolean') return u[campo];
  }
  const status = textoOuVazio(u.status || u.state).toLowerCase();
  if (status) {
    if (['active', 'activo', 'ativo', 'enabled'].includes(status)) return true;
    if (['inactive', 'inactivo', 'inativo', 'disabled', 'terminated', 'deleted', 'archived', 'blocked'].includes(status)) return false;
  }
  for (const campo of ['terminated_at', 'termination_date', 'terminated_on', 'end_date', 'deleted_at']) {
    if (textoOuVazio(u[campo])) {
      const data = new Date(u[campo]);
      // data inválida: trata como desligado por precaução; futura: ainda ativo
      if (isNaN(data.getTime()) || data.getTime() <= Date.now()) return false;
    }
  }
  return true;
}

async function buscarPagina(dominio, token, pagina) {
  const url = new URL('/api/v1/users', dominio);
  url.searchParams.set('token', token);
  url.searchParams.set('page', String(pagina));
  url.searchParams.set('page_size', String(TAMANHO_PAGINA));

  const resp = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!resp.ok) {
    // Nunca inclui a URL (que contém o token) na mensagem de erro.
    const erro = new Error(`A Bizneo respondeu HTTP ${resp.status}.`);
    erro.status = resp.status;
    throw erro;
  }
  return resp.json();
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return resposta(405, { erro: 'Método não permitido.' });

  const { BIZNEO_DOMAIN, BIZNEO_TOKEN, ACCESS_PASSWORD } = process.env;
  if (!BIZNEO_DOMAIN || !BIZNEO_TOKEN || !ACCESS_PASSWORD) {
    return resposta(500, { erro: 'Servidor sem configuração: defina BIZNEO_DOMAIN, BIZNEO_TOKEN e ACCESS_PASSWORD.' });
  }

  let corpo = {};
  try { corpo = JSON.parse(event.body || '{}'); } catch (_) { /* corpo inválido tratado abaixo */ }

  if (!senhaConfere(corpo.senha, ACCESS_PASSWORD)) {
    return resposta(401, { erro: 'Senha incorreta.' });
  }

  let dominio;
  try {
    dominio = new URL(BIZNEO_DOMAIN);
    if (dominio.protocol !== 'https:') throw new Error('http');
  } catch (_) {
    return resposta(500, { erro: 'BIZNEO_DOMAIN inválido (use https://suaempresa.bizneohr.com).' });
  }

  const debug = !!(event.queryStringParameters && event.queryStringParameters.debug);

  try {
    const vistos = new Map(); // id -> registro cru (deduplica e detecta paginação ignorada)
    let primeiroBruto = null;

    for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
      const json = await buscarPagina(dominio.origin, BIZNEO_TOKEN, pagina);
      const lista = extrairLista(json);
      if (pagina === 1 && lista.length) primeiroBruto = lista[0];
      if (!lista.length) break;

      let novos = 0;
      for (const u of lista) {
        const id = textoOuVazio(u.id ?? u.user_id ?? u.employee_id);
        if (!id || vistos.has(id)) continue;
        vistos.set(id, u);
        novos++;
      }
      // Para quando a página não traz ninguém novo (fim da lista ou API que ignora a página).
      // Não para por "página curta": a Bizneo pode limitar o page_size abaixo do pedido.
      if (novos === 0) break;
    }

    if (debug) {
      const { tipos, candidatos } = estruturaDe(primeiroBruto);
      return resposta(200, {
        diagnostico: true,
        totalLidos: vistos.size,
        camposEncontrados: tipos,
        camposQueParecemDepartamento: candidatos,
        departamentoDetectadoNoPrimeiro: primeiroBruto ? departamentoDe(primeiroBruto, process.env.BIZNEO_DEPARTMENT_FIELD) : '',
      });
    }

    const campoForcado = process.env.BIZNEO_DEPARTMENT_FIELD || '';
    const funcionarios = [];
    for (const [id, u] of vistos) {
      if (!estaAtivo(u)) continue;
      funcionarios.push({ id, nome: nomeCompleto(u), departamento: departamentoDe(u, campoForcado) });
    }
    funcionarios.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));

    return resposta(200, {
      geradoEm: new Date().toISOString(),
      totalLidos: vistos.size,
      totalAtivos: funcionarios.length,
      funcionarios,
    });
  } catch (erro) {
    console.error('Falha ao consultar a Bizneo:', erro.message);
    const status = erro.status === 401 || erro.status === 403 ? 502 : 500;
    const dica = erro.status === 401 || erro.status === 403 ? ' Verifique o BIZNEO_TOKEN.' : '';
    return resposta(status, { erro: `${erro.message}${dica}` });
  }
};

// Exportado só para testes locais.
exports._interno = { extrairLista, nomeCompleto, estaAtivo };
