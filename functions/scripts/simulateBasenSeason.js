// Symulacja finansów sezonu basenowego (Monte Carlo). Bez dostępu do Firestore.
// node functions/scripts/simulateBasenSeason.js [jednorazowo=35] [karnetZaWejscie=28] [udzialKarnetu=0.6] [terminy=42]
// Analiza: DOCS/Sessions & TO DOs/28.10_basen_finanse_analiza.md
const [P1 = 35, PK = 28, SHARE = 0.6, TERMS = 42] = process.argv.slice(2).map(Number);
const COST = 350; // koszt terminu (2 godziny)
const CAP = 10; // osób na godzinę
const SUBSIDY = 2000; // maks. dopłata klubu w sezonie
const MAX_LOSS = 105; // maks. strata jednego uruchomionego terminu = 3 wejścia jednorazowe (decyzja 28.10.2026)
const RUNS = 4000;

function poisson(mean) {
  const limit = Math.exp(-mean);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= Math.random();
  } while (p > limit);
  return k - 1;
}

// Przychód terminu: wejścia × średnia wartość wejścia. Instruktorzy (darmowe wejście,
// nagroda +1 h) pominięci — decyzja 28.10.2026, rozliczenie instruktorów osobno.
function termRevenue(entries) {
  return entries * (SHARE * PK + (1 - SHARE) * P1);
}

function simulate(mean, policy) {
  let sum = 0;
  let ran = 0;
  let overBudget = 0;
  for (let r = 0; r < RUNS; r++) {
    let balance = 0;
    for (let t = 0; t < TERMS; t++) {
      const entries = Math.min(CAP, poisson(mean)) + Math.min(CAP, poisson(mean));
      const result = termRevenue(entries) - COST;
      const go = policy === "zawsze" || result >= 0 ||
        (policy === "budzet" && -result <= MAX_LOSS && balance + result >= -SUBSIDY);
      if (go) {
        balance += result;
        ran++;
      }
    }
    sum += balance;
    if (balance < -SUBSIDY) overBudget++;
  }
  return `${Math.round(sum / RUNS)} zł / ${(ran / RUNS).toFixed(0)} terminów / strata >${SUBSIDY} zł w ${Math.round(100 * overBudget / RUNS)}%`;
}

console.log(`Jednorazowo ${P1} zł, karnet ${PK} zł/wejście, ${SHARE * 100}% z karnetu, ${TERMS} terminów`);
for (const mean of [5, 6, 7, 8]) {
  console.log(`\nśrednio ${mean} os./h`);
  console.log(`  zawsze:            ${simulate(mean, "zawsze")}`);
  console.log(`  tylko na zero:     ${simulate(mean, "zero")}`);
  console.log(`  strata ≤${MAX_LOSS} zł w budżecie: ${simulate(mean, "budzet")}`);
}
const avg = SHARE * PK + (1 - SHARE) * P1;
console.log(`\nPróg 🟢: ${Math.ceil(COST / avg)} wejść, 🟡 od ${Math.ceil((COST - MAX_LOSS) / avg)} wejść`);
