// =========================================================================
// NETLIFY FUNCTION: funcionarios-ativos
// =========================================================================
// Fluxo em dois passos na API da Bizneo (token fica só aqui, no servidor):
//
//   acao "lista"     -> GET /api/v1/users (paginado) e filtra os ATIVOS
//                       (algum work_contract com end_at nulo). Devolve id + nome.
//   acao "detalhes"  -> GET /api/v1/users/{id} para um LOTE de ids e devolve
//                       nome completo (DadosPessoais_NomeCompleto) e
//                       departamento (taxons["ALOIA - Departments"][0].name).
//
// O detalhe é por pessoa, então a página chama "detalhes" em lotes pequenos
// (com barra de progresso) para não estourar o tempo limite do Netlify.
//
// Variáveis de ambiente (Netlify > Site configuration > Environment variables):
//   BIZNEO_DOMAIN           https://aloiaaerospace.bizneohr.com  (sem barra final)
//   BIZNEO_TOKEN            token de API da Bizneo
//   ACCESS_PASSWORD         senha que protege a página/function
//   BIZNEO_DEPARTMENT_TAXON (opcional) nome do grupo de taxons do departamento.
//                           Padrão: "ALOIA - Departments"
//
// Diagnóstico: acao "debug" mostra os NOMES dos campos do detalhe de um
// funcionário ativo (sem valores pessoais), para conferir o mapeamento.
// =========================================================================

const crypto = require('crypto');

const TAMANHO_PAGINA = 50;
const MAX_PAGINAS = 200;   // trava de segurança contra loop infinito
const LOTE_MAXIMO = 25;    // máximo de ids por chamada "detalhes"
const CONCORRENCIA = 5;    // chamadas simultâneas à Bizneo dentro de um lote

function resposta(status, corpo) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    body: JSON.stringify(corpo),
  };
}

// Comparação de senha em tempo constante.
function senhaConfere(informada, esperada) {
  const a = crypto.createHash('sha256').update(String(informada || '')).digest();
  const b = crypto.createHash('sha256').update(String(esperada || '')).digest();
  return crypto.timingSafeEqual(a, b);
}

function textoOuVazio(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

function esperar(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// GET na Bizneo. Nunca inclui a URL (que carrega o token) em mensagens de erro.
// Faz uma nova tentativa se a Bizneo responder 429 (limite de requisições).
async function pedir(origem, caminho, token, params = {}) {
  const url = new URL(caminho, origem);
  url.searchParams.set('token', token);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  for (let tentativa = 0; ; tentativa++) {
    const resp = await fetch(url, { headers: { Accept: 'application/json' } });
    if (resp.status === 429 && tentativa === 0) {
      await esperar(1000);
      continue;
    }
    if (!resp.ok) {
      const erro = new Error(`A Bizneo respondeu HTTP ${resp.status}.`);
      erro.status = resp.status;
      throw erro;
    }
    return resp.json();
  }
}

function estaAtivo(u) {
  return Array.isArray(u.work_contracts) && u.work_contracts.some((c) => c && (c.end_at === null || c.end_at === undefined));
}

function nomeDaLista(u) {
  return [textoOuVazio(u.first_name), textoOuVazio(u.last_name)].filter(Boolean).join(' ');
}

function normalizar(texto) {
  return String(texto).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Acha o grupo de taxons do departamento: nome exato; depois igual ignorando
// acento/traço/caixa; depois qualquer grupo cujo nome contenha "depart".
function acharGrupoDepartamento(user, taxon) {
  const taxons = user && user.taxons;
  if (!taxons || typeof taxons !== 'object' || Array.isArray(taxons)) return null;
  if (taxons[taxon] !== undefined) return { chave: taxon, valor: taxons[taxon] };
  const chaves = Object.keys(taxons);
  const alvo = normalizar(taxon);
  const igual = chaves.find((k) => normalizar(k) === alvo);
  if (igual) return { chave: igual, valor: taxons[igual] };
  const parecido = chaves.find((k) => /depart/i.test(k));
  return parecido ? { chave: parecido, valor: taxons[parecido] } : null;
}

function textoDoItem(item) {
  if (item === null || item === undefined) return '';
  if (typeof item === 'string' || typeof item === 'number') return textoOuVazio(item);
  if (typeof item === 'object') return textoOuVazio(item.name || item.title || item.label);
  return '';
}

function departamentoDe(user, taxon) {
  const grupo = acharGrupoDepartamento(user, taxon);
  if (grupo) {
    const item = Array.isArray(grupo.valor) ? grupo.valor[0] : grupo.valor;
    const texto = textoDoItem(item);
    if (texto) return texto;
  }
  // Reserva: campo solto no usuário cujo nome contenha "depart".
  for (const [chave, valor] of Object.entries(user || {})) {
    if (/depart/i.test(chave) && chave !== 'taxons') {
      const texto = textoDoItem(Array.isArray(valor) ? valor[0] : valor);
      if (texto) return texto;
    }
  }
  return '';
}

// Passo 1: lista paginada -> só os ativos (id + nome da lista, usado como reserva).
async function listarAtivos(origem, token) {
  const vistos = new Set();
  const ativos = [];

  for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
    const json = await pedir(origem, '/api/v1/users', token, { page: pagina, page_size: TAMANHO_PAGINA });
    const lista = Array.isArray(json) ? json : (json && Array.isArray(json.users) ? json.users : []);
    if (!lista.length) break;

    let novos = 0;
    for (const u of lista) {
      const id = textoOuVazio(u.id);
      if (!id || vistos.has(id)) continue;
      vistos.add(id);
      novos++;
      if (estaAtivo(u)) ativos.push({ id, nome: nomeDaLista(u) });
    }
    if (novos === 0) break; // fim da lista (ou API que ignora a página)
  }
  return { totalLidos: vistos.size, ativos };
}

// Passo 2: detalhe de uma pessoa.
async function buscarDetalhe(origem, token, id, taxon) {
  const json = await pedir(origem, `/api/v1/users/${id}`, token);
  const user = (json && json.user) || json || {};
  return {
    id,
    nome: textoOuVazio(user.DadosPessoais_NomeCompleto),
    departamento: departamentoDe(user, taxon),
  };
}

// Executa fn sobre os itens com no máximo "limite" chamadas simultâneas.
async function comLimite(itens, limite, fn) {
  const resultados = new Array(itens.length);
  let proximo = 0;
  const trabalhadores = Array.from({ length: Math.min(limite, itens.length) }, async () => {
    while (proximo < itens.length) {
      const i = proximo++;
      resultados[i] = await fn(itens[i]);
    }
  });
  await Promise.all(trabalhadores);
  return resultados;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return resposta(405, { erro: 'Método não permitido.' });

  const { BIZNEO_DOMAIN, BIZNEO_TOKEN, ACCESS_PASSWORD } = process.env;
  if (!BIZNEO_DOMAIN || !BIZNEO_TOKEN || !ACCESS_PASSWORD) {
    return resposta(500, { erro: 'Servidor sem configuração: defina BIZNEO_DOMAIN, BIZNEO_TOKEN e ACCESS_PASSWORD.' });
  }

  let corpo = {};
  try { corpo = JSON.parse(event.body || '{}'); } catch (_) { /* tratado abaixo */ }

  if (!senhaConfere(corpo.senha, ACCESS_PASSWORD)) {
    return resposta(401, { erro: 'Senha incorreta.' });
  }

  let origem;
  try {
    const dominio = new URL(BIZNEO_DOMAIN);
    if (dominio.protocol !== 'https:') throw new Error('http');
    origem = dominio.origin;
  } catch (_) {
    return resposta(500, { erro: 'BIZNEO_DOMAIN inválido (use https://suaempresa.bizneohr.com).' });
  }

  const taxon = process.env.BIZNEO_DEPARTMENT_TAXON || 'ALOIA - Departments';

  try {
    // ---------------------------- passo 1 ----------------------------
    if (corpo.acao === 'lista') {
      const { totalLidos, ativos } = await listarAtivos(origem, BIZNEO_TOKEN);
      return resposta(200, { geradoEm: new Date().toISOString(), totalLidos, totalAtivos: ativos.length, ativos });
    }

    // ---------------------------- passo 2 ----------------------------
    if (corpo.acao === 'detalhes') {
      const ids = Array.isArray(corpo.ids) ? corpo.ids.map(String) : [];
      if (!ids.length || ids.length > LOTE_MAXIMO) {
        return resposta(400, { erro: `Envie de 1 a ${LOTE_MAXIMO} ids por chamada.` });
      }
      // Só dígitos: impede montar caminhos arbitrários na URL da Bizneo.
      if (!ids.every((id) => /^\d{1,20}$/.test(id))) {
        return resposta(400, { erro: 'Lista de ids inválida.' });
      }

      const detalhes = await comLimite(ids, CONCORRENCIA, async (id) => {
        try {
          return await buscarDetalhe(origem, BIZNEO_TOKEN, id, taxon);
        } catch (erro) {
          console.error(`Falha no detalhe do usuário ${id}: ${erro.message}`);
          return { id, falhou: true };
        }
      });
      return resposta(200, { detalhes });
    }

    // --------------------------- diagnóstico --------------------------
    if (corpo.acao === 'debug') {
      const { ativos } = await listarAtivos(origem, BIZNEO_TOKEN);
      if (!ativos.length) return resposta(200, { diagnostico: true, aviso: 'Nenhum ativo encontrado na lista.' });
      const json = await pedir(origem, `/api/v1/users/${ativos[0].id}`, BIZNEO_TOKEN);
      const user = (json && json.user) || json || {};
      const taxons = user.taxons;
      const grupos = taxons && typeof taxons === 'object' && !Array.isArray(taxons) ? Object.keys(taxons) : [];
      const grupo = acharGrupoDepartamento(user, taxon);
      const forma = (v) => (Array.isArray(v) ? `lista com ${v.length} item(ns)` : v === null ? 'vazio (null)' : typeof v);
      return resposta(200, {
        diagnostico: true,
        camposDoUsuario: Object.keys(user),
        camposSoltosComDepart: Object.keys(user).filter((k) => /depart/i.test(k) && k !== 'taxons'),
        formatoDeTaxons: Array.isArray(taxons) ? 'lista (esperado: objeto)' : forma(taxons),
        gruposDeTaxons: grupos,
        grupoProcurado: taxon,
        grupoEscolhido: grupo ? grupo.chave : null,
        formatoDoGrupoEscolhido: grupo ? forma(grupo.valor) : null,
        camposDoPrimeiroItem: grupo && Array.isArray(grupo.valor) && grupo.valor[0] && typeof grupo.valor[0] === 'object' ? Object.keys(grupo.valor[0]) : null,
        departamentoDetectado: !!departamentoDe(user, taxon),
      });
    }

    if (!corpo.acao) {
      return resposta(400, { erro: 'Página desatualizada: substitua o index.html do repositório pela versão nova e atualize a página (Ctrl+F5).' });
    }
    return resposta(400, { erro: 'Ação inválida.' });
  } catch (erro) {
    console.error('Falha ao consultar a Bizneo:', erro.message);
    const recusado = erro.status === 401 || erro.status === 403;
    return resposta(recusado ? 502 : 500, { erro: `${erro.message}${recusado ? ' Verifique o BIZNEO_TOKEN.' : ''}` });
  }
};
