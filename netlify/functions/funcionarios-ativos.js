const crypto = require('crypto');

const TAMANHO_PAGINA = 50;
const MAX_PAGINAS = 200;

function resposta(status, corpo) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    body: JSON.stringify(corpo),
  };
}

function senhaConfere(informada, esperada) {
  const a = crypto.createHash('sha256').update(String(informada || '')).digest();
  const b = crypto.createHash('sha256').update(String(esperada || '')).digest();
  return crypto.timingSafeEqual(a, b);
}

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
  const padrao = [textoOuVazio(u.first_name), textoOuVazio(u.last_name)].filter(Boolean).join(' ');
  if (padrao) return padrao;
  const direto = textoOuVazio(u.full_name || u.fullname || u.complete_name);
  if (direto) return direto;
  return [
    textoOuVazio(u.first_name || u.name),
    textoOuVazio(u.last_name || u.surname || u.lastname),
  ].filter(Boolean).join(' ');
}

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
  try { corpo = JSON.parse(event.body || '{}'); } catch (_) {}

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
    const vistos = new Map();
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
      if (novos === 0) break;
    }

    if (debug) {
      return resposta(200, {
        diagnostico: true,
        totalLidos: vistos.size,
        chavesDoPrimeiroRegistro: primeiroBruto ? Object.keys(primeiroBruto) : [],
        primeiroRegistro: primeiroBruto,
      });
    }

    const funcionarios = [];
    for (const [id, u] of vistos) {
      if (!estaAtivo(u)) continue;
      funcionarios.push({ id, nome: nomeCompleto(u) });
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
