// Petit script de verification : affiche les boutiques Pokestock et VCollect
// si elles existent, pour comprendre pourquoi leur ajout a ete ignore.
import { getDb } from '../src/db.js';

async function main() {
  const db = getDb(process.env);
  const res = await db
    .prepare("SELECT id, name, domain, search_url, enabled FROM merchants WHERE domain IN ('pokestock.fr','vcollect.fr') OR name IN ('Pokestock','VCollect')")
    .all();
  console.log(JSON.stringify(res.results, null, 2));
  console.log(`${res.results.length} ligne(s) trouvee(s).`);
}

main().catch((err) => {
  console.error('erreur :', err.message || err);
  process.exit(1);
});
