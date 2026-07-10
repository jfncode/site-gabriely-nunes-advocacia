// ---------------------------------------------------------------------------
// Coletor de notícias jurídicas para o site gabrielynunes.adv.br
//
// Lê os feeds RSS das fontes abaixo, junta tudo, ordena por data, remove
// duplicatas e grava em ../assets/news.json. É tolerante a falhas: se um feed
// cair, usa os outros; se TODOS caírem, mantém o news.json anterior intacto
// (nunca deixa a seção do site vazia).
//
// Uso:  cd tools && npm ci && node fetch-news.mjs
// ---------------------------------------------------------------------------

import { XMLParser } from 'fast-xml-parser';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'assets', 'news.json');

// Fontes com RSS confirmado. Para adicionar outra fonte, basta incluir aqui
// { name, url } — desde que o site exponha um feed RSS/Atom público.
const FEEDS = [
  { name: 'ConJur',      url: 'https://www.conjur.com.br/rss.xml' },
  { name: 'Direito News', url: 'https://www.direitonews.com.br/feeds/posts/default?alt=rss' },
];

const MAX_ITEMS = 9;          // quantas notícias aparecem no site
const TIMEOUT_MS = 20000;     // tempo máx. por feed
const UA = 'Mozilla/5.0 (compatible; GabrielyNewsBot/1.0; +https://gabrielynunes.adv.br)';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  processEntities: false, // não expandir entidades DTD (evita limite p/ feeds grandes); limpamos no clean()
});

// -- helpers ----------------------------------------------------------------

// Remove tags HTML e decodifica entidades básicas -> texto limpo de uma linha.
function clean(raw) {
  if (raw == null) return '';
  let s = String(raw);
  // se veio como objeto (CDATA/#text), tenta extrair o texto
  if (typeof raw === 'object') s = raw['#text'] ?? raw.__cdata ?? '';
  s = String(s)
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/\s+/g, ' ')
    .trim();
  return s;
}

// O <link> do RSS pode ser string, ou (Atom) um array de objetos com @_href.
function pickLink(link) {
  if (!link) return '';
  if (typeof link === 'string') return link.trim();
  if (Array.isArray(link)) {
    const alt = link.find((l) => l['@_rel'] === 'alternate') || link[0];
    return (alt?.['@_href'] || alt?.['#text'] || '').trim();
  }
  return (link['@_href'] || link['#text'] || '').trim();
}

async function fetchFeed(feed) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(feed.url, {
      headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const doc = parser.parse(xml);
    const items = doc?.rss?.channel?.item ?? doc?.feed?.entry ?? [];
    const list = Array.isArray(items) ? items : [items];

    return list
      .map((it) => {
        const title = clean(it.title);
        const link = pickLink(it.link);
        const dateRaw = it.pubDate || it.published || it.updated || '';
        const d = dateRaw ? new Date(dateRaw) : null;
        return {
          title,
          link,
          source: feed.name,
          date: d && !isNaN(d) ? d.toISOString() : null,
        };
      })
      .filter((x) => x.title && /^https?:\/\//.test(x.link));
  } catch (err) {
    console.warn(`⚠️  ${feed.name}: ${err.message} — pulando esta fonte.`);
    return [];
  } finally {
    clearTimeout(t);
  }
}

// -- main -------------------------------------------------------------------

const results = await Promise.all(FEEDS.map(fetchFeed));
let items = results.flat();

// dedupe por link
const seen = new Set();
items = items.filter((it) => (seen.has(it.link) ? false : seen.add(it.link)));

// ordena por data (mais recentes primeiro); itens sem data vão para o fim
items.sort((a, b) => (b.date ? Date.parse(b.date) : 0) - (a.date ? Date.parse(a.date) : 0));
items = items.slice(0, MAX_ITEMS);

if (items.length === 0) {
  console.error('❌ Nenhum item coletado (todos os feeds falharam). Mantendo news.json anterior.');
  if (existsSync(OUT)) {
    console.log(`ℹ️  news.json preservado: ${OUT}`);
    process.exit(0);
  }
  // primeira execução e tudo falhou: grava estrutura vazia para não quebrar o site
  writeFileSync(OUT, JSON.stringify({ updated: new Date().toISOString(), items: [] }, null, 2));
  process.exit(0);
}

const payload = { updated: new Date().toISOString(), items };
writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n');
console.log(`✅ ${items.length} notícias gravadas em ${OUT}`);
for (const it of items) console.log(`   • [${it.source}] ${it.title}`);
