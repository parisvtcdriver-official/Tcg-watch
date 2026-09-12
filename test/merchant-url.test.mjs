// Regression : Philibert, l'Espace Culturel Leclerc et UltraJeux etaient
// muets malgre une URL de recherche par ailleurs correcte, parce qu'elle
// avait ete tapee sans "https://" ("www.philibertnet.com/..."). fetch() dans
// le Worker ne sait pas resoudre une URL sans protocole : ca echoue en
// silence a chaque tentative, et le produit cherche apparait "non trouve"
// meme quand il est bien en stock.
//   node test/merchant-url.test.mjs

import { normalizeSearchUrl } from '../src/router.js';

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        obtenu ${JSON.stringify(got)}\n        attendu ${JSON.stringify(want)}`}`);
}

console.log('--- normalizeSearchUrl ---');

// le bug reel : protocole manquant, mais URL de recherche par ailleurs valide
check(
  'ajoute https:// quand le protocole manque',
  normalizeSearchUrl('www.philibertnet.com/fr/recherche?search_query={q}'),
  { url: 'https://www.philibertnet.com/fr/recherche?search_query={q}' },
);
check(
  'ajoute https:// (parametre en fin de chemin)',
  normalizeSearchUrl('www.e.leclerc/fp/{q}'),
  { url: 'https://www.e.leclerc/fp/{q}' },
);
check(
  'ne touche pas a une URL deja correcte',
  normalizeSearchUrl('https://www.koalagames.shop/search?q={q}'),
  { url: 'https://www.koalagames.shop/search?q={q}' },
);
check(
  'accepte http:// explicite',
  normalizeSearchUrl('http://boutique.fr/search?q={q}'),
  { url: 'http://boutique.fr/search?q={q}' },
);

// les rejets existants doivent survivre au refactor
check('vide -> erreur', normalizeSearchUrl(''), { error: "l'URL de recherche est obligatoire" });
check(
  '{q} absent -> erreur',
  normalizeSearchUrl('https://boutique.fr/search?q=one+piece'),
  { error: "l'URL doit contenir {q} a l'endroit de la recherche" },
);
check(
  '{q} colle dans un chemin de rayon -> erreur',
  normalizeSearchUrl('https://boutique.fr/rayon{q}'),
  { error: "cette URL n'est pas une recherche : {q} doit suivre un paramètre, comme ?s={q} ou ?q={q}" },
);

console.log(`\n${pass} ok, ${fail} echoue(s)`);
if (fail) process.exit(1);
