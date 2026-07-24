// nw-sim v8 - Monte Carlo net-worth / FIRE simulator (static, no build)
// v7 added: comp growth + promotion, equity refresh grants, children, home purchase,
// a full DRAWDOWN phase to age 90 (sequence-of-returns risk, survival metrics),
// return-model toggle (normal / Student-t fat tails / historical block bootstrap),
// dividend tax drag, withdrawal-tax gross-up, and URL-param state.
// v8 (2026-07-23): 2026 constants (401k $24.5K, std ded $16.1K, SS cap $184.5K); HSA
// (employer $1,237 + own, FICA-exempt); Social Security offset in drawdown; pre-65
// healthcare in retirement spend AND the FIRE target; kid costs charged during
// retirement; job-loss stress (6-month gap); honest defaults (attainment 75%, promo
// off); home-equity overlay (never in the FIRE trigger); equity shocks correlated
// with market returns.
// FIRE is computed on the LIQUID portfolio only; unrealized equity + home equity are overlays.
// All real (inflation-adjusted) dollars. Planning estimates, not advice.

"use strict";

// ===== defaults =====
const D = {
  startAge: 25, endAge: 90, chartAge: 60,
  startingNW: 290000,
  base: 225000, varTarget: 75000, attainment: 75, // 75 default: bonus is discretionary with zero attainment history; 100 is the upside case, not the base case
  k401: 24500, // 2026 employee limit (Turing portal)
  hsaAnnual: 4400, hsaEmployer: 1237, // 2026 self-only cap incl. Turing's $1,237; set hsaAnnual 0 while on the parents' plan (HSA-ineligible)
  compGrowth: 2,          // real %/yr on OTE
  promoYear: 0, promoJump: 60000, // 0 promoYear = off (default): no promotion is promised; slide up to model one
  jobLossPct: 3, // %/yr chance of a 6-month income gap (at-will AI-sector startup); 0 restores the old no-risk income path
  homeSpendWk: 600, moveOutAge: 30, moveOutSpendWk: 1292,
  fireSpend: 100000, swr: 3.5, retireAge: 38, wdTax: 8, // retireAge 0 = retire at FIRE; default 38 per plan (cushion years past the number)
  retHealthAnnual: 12000, // pre-Medicare (under-65) health cost in retirement: ACA premium + OOP; added to spend AND the FIRE target
  ssAnnual: 25000, ssAge: 67, // Social Security offset from ssAge; ~PIA for 15 max-taxable years, haircut ~25% for trust-fund risk; 0 = exclude
  partnerAnnual: 40500,
  // equity - HONEST defaults: no refresh program promised in the letter, liquidity never (0) so
  // every headline FIRE number is truly cash-comp-only; slide liqYear/refreshAnnual up to model upside
  grant: 700000, refreshAnnual: 0, eqMu: 15, eqSigma: 50, eqFailPct: 4,
  eqMktCorr: 0.5, // private-company valuation shocks correlate with market cycles; 0 restores independent draws
  liqYear: 0, haircut: 25, eqTax: 45, // 45: double-trigger RSUs settle as ORDINARY income in one lump at liquidity (confirmed by the offer letter); ~47% marginal fed+MD on top of salary, not cap-gains
  // life events
  kids: 0, kidAge: 32, college: 1,
  homeAge: 0, homePrice: 600000, homeDownPct: 10, homePostSpendWk: 1600,
  homeAppr: 1, // real home appreciation %/yr for the home-equity overlay (never in the FIRE trigger)
  // market
  returnModel: "normal", // normal | t | bootstrap
  divDrag: 0.4,
  usMu: 7, // expected US real return %/yr; intl sleeve tracks 2.5pts below; bootstrap shifts history by (usMu - 7)
  spyStd: 0.17, vxusStd: 0.18,
  corr: 0.7, spyW: 2 / 3, vxusW: 1 / 3,
  sims: 20000,
  studientContrib: 85800,
};

// ===== approximate historical annual REAL total returns (%), US large-cap & intl (EAFE-like), 1970-2024 =====
// Used only by the block-bootstrap mode (5-yr contiguous blocks, preserving correlation + mean reversion).
const HIST = [
  [-1.4,-11.7],[10.8,25.4],[15.6,31.2],[-21.6,-19.9],[-34.5,-30.3],[28.3,25.6],[18.1,-1.4],[-13.1,11.2],[-2.3,23.7],[4.9,-6.8],
  [17.7,8.6],[-13.3,-9.8],[17.4,-3.7],[18.4,20.0],[2.2,3.5],[27.3,52.6],[17.4,68.1],[1.6,20.3],[12.0,23.7],[26.2,5.8],
  [-9.1,-28.2],[26.3,8.9],[4.6,-14.6],[7.3,29.4],[-1.3,5.1],[34.6,8.6],[19.5,2.7],[31.3,0.1],[26.9,18.5],[18.3,24.3],
  [-12.1,-16.9],[-13.4,-22.6],[-23.8,-17.5],[26.4,36.6],[7.5,16.9],[1.5,10.0],[13.1,23.2],[1.4,7.0],[-37.0,-43.4],[23.5,28.9],
  [13.4,6.2],[-1.0,-14.8],[13.9,15.5],[30.6,21.0],[12.7,-5.6],[0.7,-0.4],[9.8,-1.0],[19.4,22.9],[-6.2,-15.6],[28.9,19.7],
  [17.0,6.4],[21.0,4.3],[-24.0,-20.0],[22.0,14.3],[21.6,1.2],
];

// ===== tax module (2026 single-filer ESTIMATES) =====
const FED_BRACKETS = [
  [12400, 0.10], [50400, 0.12], [105700, 0.22], [201775, 0.24],
  [256225, 0.32], [640600, 0.35], [Infinity, 0.37],
];
const STD_DEDUCTION = 16100, SS_CAP = 184500, MD_RATE = 0.0575, HOCO_RATE = 0.032; // 2026 values

function fedTax(t) {
  let tax = 0, prev = 0;
  for (const [top, rate] of FED_BRACKETS) {
    if (t <= prev) break;
    tax += (Math.min(t, top) - prev) * rate; prev = top;
  }
  return tax;
}
function incomeModel(gross, spendWk, cfg) {
  const k401 = cfg.k401;
  const hsaTotal = cfg.hsaAnnual || 0;
  const hsaOwn = Math.max(0, hsaTotal - (hsaTotal > 0 ? cfg.hsaEmployer : 0)); // employer's $1,237 counts toward the cap but costs nothing
  const taxable = Math.max(0, gross - k401 - hsaOwn - STD_DEDUCTION);
  const fed = fedTax(taxable), state = taxable * (MD_RATE + HOCO_RATE);
  const ficaBase = gross - hsaOwn; // payroll HSA contributions skip FICA (Section 125)
  const ss = Math.min(ficaBase, SS_CAP) * 0.062;
  const medicare = ficaBase * 0.0145 + Math.max(0, ficaBase - 200000) * 0.009;
  const net = gross - k401 - hsaOwn - fed - state - ss - medicare;
  const spend = spendWk * 52;
  return { gross, net, spend, invested: k401 + hsaTotal + Math.max(0, net - spend) };
}

// ===== RNG =====
function randn() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function randT5() { // variance-normalized Student-t df=5
  let chi = 0;
  for (let i = 0; i < 5; i++) { const z = randn(); chi += z * z; }
  return (randn() / Math.sqrt(chi / 5)) / Math.sqrt(5 / 3);
}

// ===== per-scenario schedules (deterministic parts) =====
function buildSchedules(sc, cfg) {
  const years = cfg.endAge - cfg.startAge;
  const att = cfg.attainment / 100, g = cfg.compGrowth / 100;
  const contribs = [], outflows = [], spendInfo = [], kidCosts = [], homeEq = [];
  for (let y = 0; y < years; y++) {
    const age = cfg.startAge + y;
    let extra = 0;
    // kid costs (added to spend); college as one-time outflow
    let kidCost = 0;
    for (let k = 0; k < cfg.kids; k++) {
      const born = cfg.kidAge + 2 * k, cy = age - born;
      if (cy >= 0 && cy <= 5) kidCost += 34000;
      else if (cy >= 6 && cy <= 17) kidCost += 18000;
      if (cy === 18 && cfg.college) extra += 120000;
    }
    // home purchase
    if (cfg.homeAge > 0 && age === cfg.homeAge) extra += cfg.homePrice * (cfg.homeDownPct + 3) / 100;
    const owned = cfg.homeAge > 0 && age >= cfg.homeAge;
    const baseWk = owned ? cfg.homePostSpendWk : (age < cfg.moveOutAge ? cfg.homeSpendWk : cfg.moveOutSpendWk);
    const spendWk = baseWk + kidCost / 52;

    if (sc.studient) {
      contribs.push(cfg.studientContrib);
    } else {
      const ote = (cfg.base + cfg.varTarget * att + (cfg.promoYear > 0 && y >= cfg.promoYear ? cfg.promoJump : 0)) * Math.pow(1 + g, y);
      const inc = incomeModel(ote, spendWk, cfg);
      let c = inc.invested;
      if (sc.partner && age >= 30) c += cfg.partnerAnnual;
      contribs.push(c);
    }
    outflows.push(extra);
    spendInfo.push(Math.round(spendWk * 52));
    kidCosts.push(kidCost); // kept separately so retirement-phase withdrawals can charge kid years too
    // home-equity overlay: value grows at homeAppr real; 30-yr straight-line principal paydown approximation
    if (owned) {
      const own = age - cfg.homeAge;
      const loan = cfg.homePrice * (1 - cfg.homeDownPct / 100);
      const val = cfg.homePrice * Math.pow(1 + cfg.homeAppr / 100, own);
      homeEq.push(val - loan * Math.max(0, 1 - own / 30));
    } else homeEq.push(0);
  }
  return { contribs, outflows, spendInfo, kidCosts, homeEq, years };
}

// ===== simulation =====
function runSim(sc, cfg) {
  const { contribs, outflows, spendInfo, kidCosts, homeEq, years } = buildSchedules(sc, cfg);
  const usMu = (cfg.usMu !== undefined ? cfg.usMu : 7) / 100;
  const consAdj = sc.returns === "cons" ? 0.025 : 0; // conservative scenario: both sleeves 2.5pts below
  const spyMean = usMu - consAdj;
  const vxusMean = usMu - 0.025 - consAdj;
  const bootShift = usMu - 0.07 - consAdj;
  // FIRE target funds retirement spend PLUS pre-65 healthcare (the expensive early years set the bar)
  const fireTarget = (cfg.fireSpend + cfg.retHealthAnnual) / (cfg.swr / 100);
  const drag = cfg.divDrag / 100;
  const wdGross = 1 + cfg.wdTax / 100;
  const pLoss = (cfg.jobLossPct || 0) / 100;
  const eqMu = cfg.eqMu / 100, eqSig = cfg.eqSigma / 100, pFail = cfg.eqFailPct / 100;
  const haircut = cfg.haircut / 100, eqTaxR = cfg.eqTax / 100, liqIdx = cfg.liqYear;
  const eqC = Math.max(0, Math.min(0.95, cfg.eqMktCorr || 0));
  // portfolio mean/std used to standardize the year's market shock for the equity correlation
  const portMean = cfg.spyW * spyMean + cfg.vxusW * vxusMean;
  const portStd = Math.sqrt(
    cfg.spyW * cfg.spyW * cfg.spyStd * cfg.spyStd + cfg.vxusW * cfg.vxusW * cfg.vxusStd * cfg.vxusStd
    + 2 * cfg.spyW * cfg.vxusW * cfg.corr * cfg.spyStd * cfg.vxusStd);
  const nH = HIST.length, block = 5;

  const paths = [], totalPaths = [], fireAges = [], retireYears = [], ruinAges = [];
  for (let sim = 0; sim < cfg.sims; sim++) {
    let nw = cfg.startingNW, fireAge = null, retired = false, retiredYear = null, ruined = false, ruinAge = null;
    let eqMult = 1, eqDead = !sc.equity, eqMerged = false;
    // bootstrap sequence for this sim
    let seq = null;
    if (cfg.returnModel === "bootstrap") {
      seq = [];
      while (seq.length < years) {
        const s = Math.floor(Math.random() * nH);
        for (let b = 0; b < block && seq.length < years; b++) seq.push(HIST[(s + b) % nH]);
      }
    }
    const path = [nw], tpath = [nw];

    for (let y = 0; y < years; y++) {
      const age = cfg.startAge + y;
      // return
      let r;
      if (cfg.returnModel === "bootstrap") {
        const [us, intl] = seq[y];
        r = cfg.spyW * (us / 100 + bootShift) + cfg.vxusW * (intl / 100 + bootShift);
      } else {
        const z1 = cfg.returnModel === "t" ? randT5() : randn();
        const z2 = cfg.returnModel === "t" ? randT5() : randn();
        const spyR = spyMean + cfg.spyStd * z1;
        const vxusR = vxusMean + cfg.vxusStd * (cfg.corr * z1 + Math.sqrt(1 - cfg.corr * cfg.corr) * z2);
        r = cfg.spyW * spyR + cfg.vxusW * vxusR;
      }
      r -= drag;

      // retirement trigger check (start of year)
      if (!retired) {
        // retire at the LATER of hitting the FIRE number and the earliest-retire age (never retire under-funded)
        const trigger = (fireAge !== null) && (cfg.retireAge === 0 || age >= cfg.retireAge);
        if (trigger) { retired = true; retiredYear = y; }
      }

      if (!ruined) {
        if (!retired) {
          let c = contribs[y];
          // job-loss stress: a 6-month income gap loses half the year's contribution
          // AND pulls half a year of spending out of the portfolio
          if (pLoss > 0 && !sc.studient && Math.random() < pLoss) c = 0.5 * c - 0.5 * spendInfo[y];
          nw = nw * (1 + r) + c * (1 + r / 2);
        } else {
          // withdrawal: spend + pre-65 healthcare + any kid costs, grossed up for tax, less Social Security
          const need = (cfg.fireSpend + (age < 65 ? cfg.retHealthAnnual : 0) + kidCosts[y]) * wdGross;
          const wd = Math.max(0, need - (age >= cfg.ssAge ? cfg.ssAnnual : 0));
          nw = nw * (1 + r) - wd;
        }
        nw -= outflows[y];
        if (nw <= 0) {
          if (retired) { ruined = true; ruinAge = age + 1; }
          nw = Math.max(0, nw);
        }
      }

      // equity (stops accruing refreshes after retirement; valuation continues until merge/death)
      let eqUnreal = 0;
      if (!eqDead && !eqMerged) {
        // valuation shock correlated with this year's market draw (private outcomes track cycles)
        const zMkt = (r + drag - portMean) / portStd;
        const zEq = eqC * zMkt + Math.sqrt(1 - eqC * eqC) * randn();
        eqMult *= Math.exp(eqMu - 0.5 * eqSig * eqSig + eqSig * zEq);
        if (Math.random() < pFail) eqDead = true;
        else {
          const svc = Math.min(y + 1, retiredYear !== null ? retiredYear + 1 : y + 1);
          // initial grant: cliff yr1 then 25%/yr to 4
          let vestedVal = Math.min(svc >= 4 ? 1 : svc * 0.25, 1) * cfg.grant;
          // refreshes: granted at service years 2..(retire or liq), each vests /4 monthly no cliff
          const lastGrantYr = Math.min(retiredYear !== null ? retiredYear : years, liqIdx > 0 ? liqIdx : years);
          for (let gY = 2; gY <= lastGrantYr; gY++) {
            if (cfg.refreshAnnual <= 0) break;
            const frac = Math.min(1, Math.max(0, (y + 1 - gY) / 4));
            vestedVal += frac * cfg.refreshAnnual;
          }
          const val = vestedVal * eqMult;
          if (liqIdx > 0 && y + 1 === liqIdx) { nw += val * (1 - haircut) * (1 - eqTaxR); eqMerged = true; }
          else eqUnreal = val;
        }
      }

      path.push(nw); tpath.push(nw + eqUnreal + homeEq[y]);
      if (fireAge === null && nw >= fireTarget) fireAge = age + 1;
    }
    paths.push(path); totalPaths.push(tpath); fireAges.push(fireAge);
    retireYears.push(retiredYear); ruinAges.push(ruinAge);
  }

  // stats
  const pcts = [0.1, 0.25, 0.33, 0.5, 0.66, 0.75, 0.9];
  const chartYears = cfg.chartAge - cfg.startAge;
  const percentilePaths = {}, totalMedianPath = [];
  for (const p of pcts) percentilePaths[p] = [];
  for (let y = 0; y <= chartYears; y++) {
    const vals = paths.map(pt => pt[y]).sort((a, b) => a - b);
    for (const p of pcts) percentilePaths[p].push(vals[Math.min(Math.floor(p * vals.length), vals.length - 1)]);
    const tv = totalPaths.map(pt => pt[y]).sort((a, b) => a - b);
    totalMedianPath.push(tv[Math.floor(0.5 * tv.length)]);
  }
  const a47 = 47 - cfg.startAge;
  const nw47 = paths.map(p => p[a47]).sort((a, b) => a - b);
  const p47 = p => nw47[Math.min(Math.floor(p * nw47.length), nw47.length - 1)];
  const reached = fireAges.filter(a => a !== null).sort((a, b) => a - b);
  const fap = p => reached.length ? reached[Math.min(Math.floor(p * reached.length), reached.length - 1)] : null;
  const cumulativeFireByAge = [];
  for (let age = cfg.startAge; age <= cfg.chartAge; age++) {
    cumulativeFireByAge.push({ age, rate: fireAges.filter(a => a !== null && a <= age).length / cfg.sims });
  }
  // drawdown survival: among sims that retired, % solvent at each age
  const retiredCount = retireYears.filter(v => v !== null).length;
  const survivalByAge = [];
  for (let age = cfg.startAge; age <= cfg.endAge; age += 1) {
    let solvent = 0;
    for (let s = 0; s < cfg.sims; s++) {
      if (retireYears[s] === null) continue;
      if (ruinAges[s] === null || ruinAges[s] > age) solvent++;
    }
    survivalByAge.push({ age, rate: retiredCount ? solvent / retiredCount : 1 });
  }
  const survive90 = retiredCount ? retireYears.reduce((acc, v, s) => acc + (v !== null && ruinAges[s] === null ? 1 : 0), 0) / retiredCount : null;
  return {
    sc, years: chartYears, startAge: cfg.startAge, fireTarget,
    contribs, spendInfo,
    percentilePaths, totalMedianPath,
    percentilesAt47: { p10: p47(0.1), p25: p47(0.25), p33: p47(0.33), p50: p47(0.5), p66: p47(0.66), p75: p47(0.75), p90: p47(0.9) },
    successRate: fireAges.filter(a => a !== null && a <= 47).length / cfg.sims,
    fireAgePercentiles: { p10: fap(0.1), p25: fap(0.25), p33: fap(0.33), p50: fap(0.5), p66: fap(0.66), p75: fap(0.75), p90: fap(0.9) },
    cumulativeFireByAge, survivalByAge, survive90, retiredPct: retiredCount / cfg.sims,
  };
}

// ===== formatting =====
const fmt = v => v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}K` : `$${Math.round(v)}`;
const fmtX = v => `$${Math.round(v).toLocaleString("en-US")}`;
const pctFmt = v => `${(v * 100).toFixed(1)}%`;

// ===== charts =====
function fanChart(res, title, color) {
  const { percentilePaths, totalMedianPath, years, startAge, fireTarget } = res;
  const pcts = [0.1, 0.25, 0.5, 0.75, 0.9];
  const op = { 0.1: 0.2, 0.25: 0.35, 0.5: 1, 0.75: 0.35, 0.9: 0.2 };
  const wd = { 0.1: 1, 0.25: 1.5, 0.5: 3, 0.75: 1.5, 0.9: 1 };
  const W = 760, H = 370, P = { t: 30, r: 30, b: 50, l: 82 };
  const pw = W - P.l - P.r, ph = H - P.t - P.b;
  let maxV = fireTarget * 1.1;
  for (const p of pcts) for (const v of percentilePaths[p]) if (v > maxV) maxV = v;
  for (const v of totalMedianPath) if (v > maxV) maxV = v;
  const xs = i => P.l + (i / years) * pw, ys = v => P.t + ph - (v / maxV) * ph;
  const pd = d => d.map((v, i) => `${i ? "L" : "M"}${xs(i).toFixed(1)},${ys(v).toFixed(1)}`).join(" ");
  const band = (tp, bp) => {
    const t = percentilePaths[tp], b = percentilePaths[bp];
    let d = t.map((v, i) => `${i ? "L" : "M"}${xs(i).toFixed(1)},${ys(v).toFixed(1)}`).join(" ");
    for (let i = b.length - 1; i >= 0; i--) d += ` L${xs(i).toFixed(1)},${ys(b[i]).toFixed(1)}`;
    return d + " Z";
  };
  const yT = []; const step = maxV > 10e6 ? 2e6 : maxV > 5e6 ? 1e6 : 500000;
  for (let v = 0; v <= maxV; v += step) yT.push(v);
  const xT = []; for (let y = 0; y <= years; y += 5) xT.push(y);
  const fy = ys(fireTarget), a47 = 47 - startAge;
  return `<div class="chartwrap"><h3 style="color:${color}">${title}</h3>
  <svg class="chart" viewBox="0 0 ${W} ${H}">
    ${yT.map(v => `<line x1="${P.l}" x2="${W - P.r}" y1="${ys(v)}" y2="${ys(v)}" stroke="#1a2035"/>`).join("")}
    <line x1="${P.l}" x2="${W - P.r}" y1="${fy}" y2="${fy}" stroke="#ff4d6a" stroke-width="2" stroke-dasharray="8 4"/>
    <text x="${W - P.r - 4}" y="${fy - 6}" text-anchor="end" fill="#ff4d6a" font-size="10">FIRE ${fmt(fireTarget)}</text>
    <line x1="${xs(a47)}" x2="${xs(a47)}" y1="${P.t}" y2="${P.t + ph}" stroke="#5a6a8a" stroke-dasharray="4 4" opacity="0.5"/>
    <text x="${xs(a47)}" y="${P.t - 5}" text-anchor="middle" fill="#5a6a8a" font-size="8">47</text>
    <path d="${band(0.9, 0.1)}" fill="${color}" opacity="0.07"/>
    <path d="${band(0.75, 0.25)}" fill="${color}" opacity="0.15"/>
    ${pcts.map(p => `<path d="${pd(percentilePaths[p])}" fill="none" stroke="${color}" stroke-width="${wd[p]}" opacity="${op[p]}"/>`).join("")}
    ${res.sc.equity ? `<path d="${pd(totalMedianPath)}" fill="none" stroke="#22d3ee" stroke-width="2" stroke-dasharray="6 4" opacity="0.9"/>` : ""}
    ${yT.map(v => `<text x="${P.l - 8}" y="${ys(v) + 4}" text-anchor="end" fill="#5a6a8a" font-size="10">${fmt(v)}</text>`).join("")}
    ${xT.map(y => `<text x="${xs(y)}" y="${H - P.b + 20}" text-anchor="middle" fill="#5a6a8a" font-size="10">Age ${startAge + y}</text>`).join("")}
    <text x="${P.l + 8}" y="${P.t + 16}" fill="#5a6a8a" font-size="9">Bands 10-90 | Dashed cyan: +unrealized equity +home equity (median) | drawdown after retire</text>
  </svg></div>`;
}

function lineChartByAge(results, series, title, yLabel, refAge) {
  const W = 760, H = 360, P = { t: 30, r: 30, b: 50, l: 70 };
  const pw = W - P.l - P.r, ph = H - P.t - P.b;
  const data0 = series(results[0]);
  const a0 = data0[0].age, a1 = data0[data0.length - 1].age;
  const xs = a => P.l + ((a - a0) / (a1 - a0)) * pw, ys = r => P.t + ph - r * ph;
  const pd = d => d.map((p, i) => `${i ? "L" : "M"}${xs(p.age).toFixed(1)},${ys(p.rate).toFixed(1)}`).join(" ");
  const yT = [0, 0.25, 0.5, 0.75, 1];
  const xT = []; for (let a = a0; a <= a1; a += 5) xT.push(a);
  return `<div class="chartwrap"><h3 style="color:#e2e8f0">${title}</h3>
  <svg class="chart" viewBox="0 0 ${W} ${H}">
    ${yT.map(v => `<line x1="${P.l}" x2="${W - P.r}" y1="${ys(v)}" y2="${ys(v)}" stroke="#1a2035"/>`).join("")}
    ${refAge ? `<line x1="${xs(refAge)}" x2="${xs(refAge)}" y1="${P.t}" y2="${P.t + ph}" stroke="#ff4d6a" stroke-width="1.5" stroke-dasharray="6 3" opacity="0.7"/><text x="${xs(refAge) + 4}" y="${P.t + 14}" fill="#ff4d6a" font-size="9">${refAge}</text>` : ""}
    ${results.map(r => `<path d="${pd(series(r))}" fill="none" stroke="${r.sc.color}" stroke-width="2.5"/>`).join("")}
    ${results.map((r, i) => `<line x1="${P.l + 12}" x2="${P.l + 32}" y1="${P.t + 16 + i * 18}" y2="${P.t + 16 + i * 18}" stroke="${r.sc.color}" stroke-width="2.5"/><text x="${P.l + 38}" y="${P.t + 20 + i * 18}" fill="${r.sc.color}" font-size="10">${r.sc.label}</text>`).join("")}
    ${yT.map(v => `<text x="${P.l - 8}" y="${ys(v) + 4}" text-anchor="end" fill="#5a6a8a" font-size="10">${(v * 100).toFixed(0)}%</text>`).join("")}
    ${xT.map(a => `<text x="${xs(a)}" y="${H - P.b + 20}" text-anchor="middle" fill="#5a6a8a" font-size="10">${a}</text>`).join("")}
    <text x="${P.l + 8}" y="${H - 8}" fill="#5a6a8a" font-size="9">${yLabel}</text>
  </svg></div>`;
}

function nw47Table(results) {
  const keys = ["p10", "p25", "p33", "p50", "p66", "p75", "p90"];
  const labels = ["10th", "25th", "33rd", "50th (Median)", "66th", "75th", "90th"];
  return `<div style="overflow-x:auto;margin-bottom:30px">
  <h3 style="color:#8899bb;text-transform:uppercase;letter-spacing:0.08em;font-size:13px;margin-bottom:12px">Liquid net worth at 47 + retirement survival</h3>
  <table><thead><tr><th style="text-align:left">Metric</th>${results.map(r => `<th class="tr-num">${r.sc.label}</th>`).join("")}</tr></thead><tbody>
  ${keys.map((k, i) => `<tr><td style="color:#8899bb">${labels[i]}</td>${results.map(r => {
    const v = r.percentilesAt47[k];
    return `<td class="tr-num" style="color:${v >= r.fireTarget ? "#34d399" : "#e2e8f0"};font-weight:${k === "p50" ? 700 : 400}">${fmt(v)}</td>`;
  }).join("")}</tr>`).join("")}
  <tr style="border-top:2px solid #1e2a45"><td style="color:#ff4d6a;font-weight:700">FIRE by 47</td>
  ${results.map(r => `<td class="tr-num" style="font-weight:700;color:${r.successRate >= 0.5 ? "#34d399" : "#fbbf24"}">${pctFmt(r.successRate)}</td>`).join("")}</tr>
  <tr><td style="color:#22d3ee;font-weight:700">Survive to 90 (of retired)</td>
  ${results.map(r => `<td class="tr-num" style="font-weight:700;color:${r.survive90 === null ? "#5a6a8a" : r.survive90 >= 0.9 ? "#34d399" : r.survive90 >= 0.75 ? "#fbbf24" : "#ff4d6a"}">${r.survive90 === null ? "-" : pctFmt(r.survive90)}</td>`).join("")}</tr>
  </tbody></table></div>`;
}

function ageTable(results) {
  const keys = ["p10", "p25", "p33", "p50", "p66", "p75", "p90"];
  const labels = ["10th (Best)", "25th", "33rd", "50th (Median)", "66th", "75th", "90th (Worst)"];
  return `<div style="overflow-x:auto;margin-bottom:30px">
  <h3 style="color:#8899bb;text-transform:uppercase;letter-spacing:0.08em;font-size:13px;margin-bottom:12px">Age you would reach FIRE</h3>
  <table><thead><tr><th style="text-align:left">Percentile</th>${results.map(r => `<th class="tr-num">${r.sc.label}</th>`).join("")}</tr></thead><tbody>
  ${keys.map((k, i) => `<tr><td style="color:#8899bb">${labels[i]}</td>${results.map(r => {
    const a = r.fireAgePercentiles[k];
    return `<td class="tr-num" style="color:${a === null ? "#ff4d6a" : a <= 47 ? "#34d399" : "#e2e8f0"};font-weight:${k === "p50" ? 700 : 400}">${a === null ? "-" : "Age " + a}</td>`;
  }).join("")}</tr>`).join("")}
  </tbody></table></div>`;
}

let EXP = { scenario: 0, pct: 0.5 };
function explorer(results) {
  const pctOpts = [[0.1, "10th"], [0.25, "25th"], [0.5, "Median"], [0.75, "75th"], [0.9, "90th"]];
  const res = results[EXP.scenario];
  const path = res.percentilePaths[EXP.pct];
  const color = res.sc.color;
  let rows = "";
  for (let y = 0; y <= res.years; y++) {
    const age = res.startAge + y, nw = path[y];
    const contrib = y > 0 ? res.contribs[y - 1] : 0;
    const prev = y > 0 ? path[y - 1] : null;
    const growth = prev !== null ? nw - prev - contrib : null;
    const hit = nw >= res.fireTarget;
    rows += `<tr style="background:${hit ? "#34d39908" : "transparent"}">
      <td style="color:${age === 47 ? "#ff4d6a" : "#8899bb"}">${age}</td>
      <td class="tr-num" style="color:${hit ? "#34d399" : "#e2e8f0"}">${fmtX(nw)}</td>
      <td class="tr-num" style="color:#5a6a8a">${y === 0 ? "-" : fmtX(contrib)}</td>
      <td class="tr-num" style="color:#5a6a8a">${y === 0 ? "-" : fmtX(res.spendInfo[y - 1])}</td>
      <td class="tr-num" style="color:${growth === null ? "#5a6a8a" : growth >= 0 ? "#34d399" : "#ff4d6a"}">${growth === null ? "-" : (growth >= 0 ? "+" : "") + fmtX(growth)}</td>
      <td style="text-align:center">${hit ? '<span style="color:#34d399;font-weight:700">Y</span>' : '<span style="color:#2a3555">.</span>'}</td></tr>`;
  }
  return `<div>
  <div style="margin-bottom:12px">${results.map((r, i) => `<button class="tab${EXP.scenario === i ? " active" : ""}" style="${EXP.scenario === i ? `border-color:${r.sc.color};color:${r.sc.color};background:${r.sc.color}22` : ""}" onclick="setExplorer(${i},null)">${r.sc.label}</button>`).join(" ")}</div>
  <div style="margin-bottom:16px">${pctOpts.map(([p, l]) => `<button class="tab${EXP.pct === p ? " active" : ""}" style="${EXP.pct === p ? `border-color:${color};color:${color};background:${color}22` : ""}" onclick="setExplorer(null,${p})">${l}</button>`).join(" ")}</div>
  <div class="scrolltable"><table>
  <thead><tr><th style="text-align:left">Age</th><th class="tr-num">Liquid NW</th><th class="tr-num">Planned contrib</th><th class="tr-num">Planned spend</th><th class="tr-num">Market growth</th><th style="text-align:center">FIRE?</th></tr></thead>
  <tbody>${rows}</tbody></table></div>
  <p style="font-size:10px;color:#5a6a8a;margin-top:6px">Contribution/spend columns are the PLANNED schedule; retirement-phase flows vary per sim (each path retires at a different year), so growth conflates flows after retirement.</p></div>`;
}

// ===== app =====
let CFG = { ...D };
let RESULTS = null;

function scenarioDefs() {
  return [
    { key: "hist", label: "Turing (historical)", color: "#34d399", returns: "hist", partner: false, studient: false, equity: true },
    { key: "cons", label: "Turing (conservative)", color: "#fbbf24", returns: "cons", partner: false, studient: false, equity: true },
    { key: "partner", label: "Turing + partner @30", color: "#818cf8", returns: "hist", partner: true, studient: false, equity: true },
    { key: "studient", label: "Studient baseline", color: "#f472b6", returns: "hist", partner: false, studient: true, equity: false },
  ];
}

const SLIDER_IDS = ["attainment", "compGrowth", "promoYear", "promoJump", "jobLossPct", "hsaAnnual", "homeSpendWk", "moveOutAge", "moveOutSpendWk", "fireSpend", "swr", "retireAge", "wdTax", "retHealthAnnual", "ssAnnual", "ssAge", "startingNW", "grant", "refreshAnnual", "eqMu", "eqSigma", "eqFailPct", "eqMktCorr", "liqYear", "haircut", "eqTax", "kids", "kidAge", "college", "homeAge", "homePrice", "homeDownPct", "homePostSpendWk", "homeAppr", "divDrag", "usMu"];

function ctlHtml() {
  const c = CFG;
  const s = (id, lab, min, max, step, unit = "") => `<div class="ctl"><label>${lab}<span class="val" id="v_${id}">${c[id]}${unit}</span></label>
  <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${c[id]}" oninput="document.getElementById('v_${id}').textContent=this.value+'${unit}'"></div>`;
  const grp = (title, inner) => `<div style="grid-column:1/-1;color:#22d3ee;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;border-top:1px solid #1a2035;padding-top:10px;margin-top:4px">${title}</div>${inner}`;
  return `<div class="controls"><h3>Controls (re-run after changing)</h3><div class="ctl-grid">
  ${grp("Income", s("attainment", "Variable attainment", 0, 150, 5, "%") + s("compGrowth", "Real comp growth /yr", 0, 8, 0.5, "%") + s("promoYear", "Promo year (0=off)", 0, 10, 1) + s("promoJump", "Promo OTE jump", 0, 150000, 10000) + s("jobLossPct", "Job-loss chance /yr", 0, 10, 0.5, "%") + s("hsaAnnual", "HSA total /yr (0=none)", 0, 8750, 50))}
  ${grp("Spending + life events", s("homeSpendWk", "Spend at home /wk", 300, 1500, 25) + s("moveOutAge", "Move-out age", 26, 40, 1) + s("moveOutSpendWk", "Rent spend /wk", 600, 3000, 25) + s("kids", "Children", 0, 3, 1) + s("kidAge", "First child at age", 27, 42, 1) + s("college", "College fund (0/1)", 0, 1, 1) + s("homeAge", "Buy home at age (0=never)", 0, 45, 1) + s("homePrice", "Home price", 300000, 1200000, 25000) + s("homeDownPct", "Down payment", 5, 30, 1, "%") + s("homePostSpendWk", "Post-purchase spend /wk", 800, 3500, 50) + s("homeAppr", "Home appreciation (real)", 0, 3, 0.25, "%"))}
  ${grp("Equity", s("grant", "Initial grant", 0, 1200000, 50000) + s("refreshAnnual", "Refresh grant /yr (from yr 2)", 0, 350000, 25000) + s("eqMu", "Valuation growth mu", -20, 40, 5, "%") + s("eqSigma", "Valuation sigma", 20, 90, 5, "%") + s("eqFailPct", "Company failure /yr", 0, 15, 1, "%") + s("eqMktCorr", "Equity-market correlation", 0, 0.9, 0.1) + s("liqYear", "Liquidity yr (0=never)", 0, 15, 1) + s("haircut", "Liquidity haircut", 0, 60, 5, "%") + s("eqTax", "Equity tax", 20, 50, 5, "%"))}
  ${grp("Market + retirement", `<div class="ctl"><label>Return model</label><select id="returnModel">
    <option value="normal"${c.returnModel === "normal" ? " selected" : ""}>Normal (iid)</option>
    <option value="t"${c.returnModel === "t" ? " selected" : ""}>Fat tails (Student-t df5)</option>
    <option value="bootstrap"${c.returnModel === "bootstrap" ? " selected" : ""}>Historical block bootstrap</option>
  </select></div>` + s("usMu", "US real return mu", 3, 11, 0.5, "%") + s("divDrag", "Dividend tax drag /yr", 0, 0.6, 0.05, "%") + s("startingNW", "Starting NW", 200000, 800000, 10000) + s("fireSpend", "FIRE spend $/yr", 50000, 150000, 5000) + s("swr", "SWR", 3, 4.5, 0.25, "%") + s("retireAge", "Earliest retire age (0=at FIRE)", 0, 55, 1) + s("wdTax", "Withdrawal tax gross-up", 0, 25, 1, "%") + s("retHealthAnnual", "Pre-65 health cost /yr", 0, 25000, 1000) + s("ssAnnual", "Social Security /yr (0=none)", 0, 40000, 1000) + s("ssAge", "Social Security age", 62, 70, 1))}
  </div><div class="btnrow"><button class="run" onclick="rerun()">Re-run 20,000 sims</button>
  <button class="tab" onclick="resetDefaults()">Reset defaults</button>
  <span id="incomepeek" style="font-size:10px;color:#5a6a8a"></span></div></div>`;
}

function controlsGuide() {
  const g = (t) => `<div class="gt">${t}</div>`;
  const e = (name, txt) => `<div class="ge"><b>${name}</b> - ${txt}</div>`;
  return `<details class="box guide"><summary>What each control means (click to expand)</summary>
  <div class="gnote">Everything runs in real (today's) dollars, so returns and growth rates are already net of inflation. Settings encode into the URL after a re-run, so a bookmarked link reopens with your exact configuration.</div>
  ${g("Income")}
  ${e("Variable attainment", "how much of the $75K variable target you actually earn each year. DEFAULT 75%: the bonus is fully discretionary (offer letter language) and there is no attainment history yet, so 100% is the upside case, not the base case.")}
  ${e("Real comp growth /yr", "annual raise above inflation. 2% means pay beats inflation by 2% every year, compounding.")}
  ${e("Promo year (0=off)", "years from now until a promotion. DEFAULT 0 (off): no promotion is promised, so the headline numbers assume none. Slide up to model one.")}
  ${e("Promo OTE jump", "the one-time pay bump (base + bonus target) that promotion adds in that year, on top of normal growth.")}
  ${e("Job-loss chance /yr", "each working year has this chance of a 6-month income gap: half the year's contribution is lost AND half a year of spending is drawn from the portfolio. Deterministic never-unemployed income was the model's biggest hidden optimism; 0 restores it.")}
  ${e("HSA total /yr (0=none)", "total yearly HSA money: Turing's $1,237 employer contribution plus your payroll contributions, up to the $4,400 self-only 2026 cap. Contributions skip income tax AND FICA and stay invested. Set 0 while still covered by a parents' (non-HDHP) plan, which makes you HSA-ineligible.")}
  ${g("Spending + life events")}
  ${e("Spend at home /wk", "weekly spending while living with family. Canon: $350/wk actual through the Studient era; $600/wk is the PLANNED number from the Turing start (Aug 2026), which is what the default models. Set 350 to see the if-spending-never-rises case.")}
  ${e("Move-out age", "the age spending switches from the at-home number to the rent number.")}
  ${e("Rent spend /wk", "weekly all-in spending once living independently (rent, food, everything).")}
  ${e("Children", "how many kids. Each costs $34K/yr for ages 0-5 (the childcare years) and $18K/yr for ages 6-17, per USDA-based estimates.")}
  ${e("First child at age", "your age when the first child arrives; siblings follow every 2 years.")}
  ${e("College fund (0/1)", "1 sets aside a $120K lump per child when that child turns 18 (in-state 4-year estimate).")}
  ${e("Buy home at age (0=never)", "0 keeps you renting forever. An age triggers a purchase that year.")}
  ${e("Home price", "purchase price. The down payment plus ~3% closing costs leave your portfolio in the purchase year.")}
  ${e("Down payment", "percent of the price paid up front (first-time median is ~9-10%).")}
  ${e("Post-purchase spend /wk", "weekly spending after buying (mortgage, taxes, upkeep, life). Replaces the rent number.")}
  ${e("Home appreciation (real)", "yearly real growth of the home's value. Home equity (value minus remaining mortgage, 30-yr straight-line paydown) shows up in the dashed total-NW overlay, but NEVER counts toward the FIRE trigger: you can't eat a house.")}
  ${g("Equity")}
  ${e("Initial grant", "the $700K RSU grant at the Series E-1 price. It counts $0 toward FIRE unless a liquidity event happens; until then it is only the dashed overlay line.")}
  ${e("Refresh grant /yr (from yr 2)", "new RSU grants layered ON TOP of the initial grant each year, the way public tech companies do it (each new grant starts its own 4-year vest, so grants overlap rather than waiting for the first to finish). Default 0: the offer letter promises no refresh program and private companies often skip them. Set $100-175K to model a public-tech-style program (2024-25 norm is 20-25% of the initial grant per year).")}
  ${e("Valuation growth mu", "the average yearly growth of the company's valuation. 15% is a healthy late-stage assumption; 0 or negative stress-tests stagnation.")}
  ${e("Valuation sigma", "how wildly the valuation swings year to year. Private-company outcomes are wide; 50% is realistic.")}
  ${e("Company failure /yr", "the chance each year that the equity goes to zero: the company dies, or the 10-year double-trigger window expires with no IPO or acquisition.")}
  ${e("Equity-market correlation", "how much the company's valuation shocks move with the market's. Private-AI-company outcomes track market cycles, so the equity diversifies your portfolio less than independent draws would imply. 0 restores independence.")}
  ${e("Liquidity yr (0=never)", "years until an IPO or acquisition lets you actually sell. 0 (the default) means it never pays, so every headline number is cash-comp-only and the equity is purely the dashed overlay. Set 5-8 to see what a real exit would add to liquid NW (after the haircut and tax).")}
  ${e("Liquidity haircut", "the percent lost at the event to dilution, liquidation preferences, and price discounts versus the paper value.")}
  ${e("Equity tax", "tax on the payout. Default 45% because double-trigger RSUs settle as ordinary income in one lump on top of salary, not capital gains.")}
  ${g("Market + retirement")}
  ${e("Return model", "Normal draws returns from a textbook bell curve. Fat tails (Student-t) keeps the same average but makes crashes more likely, matching real markets. Historical block bootstrap replays actual 5-year stretches of 1970-2024 history, keeping crashes and their recoveries together; it is the most realistic of the three.")}
  ${e("US real return mu", "the average yearly US market return above inflation. 1970-2024 averaged about 7% real; 5% is a common forward-looking planning number given today's valuations; 3% is deep pessimism; 10% assumes the 2010s repeat. The intl sleeve always tracks 2.5 points below, and in bootstrap mode every historical year is shifted by the difference from 7%.")}
  ${e("Dividend tax drag /yr", "the small yearly tax bill on dividends in a taxable account, modeled as a constant drag on returns. 0.4% is typical for an index portfolio.")}
  ${e("Starting NW", "what is invested today. Current reality: $290K.")}
  ${e("FIRE spend $/yr", "what retired life costs per year in today's dollars, EXCLUDING health insurance (that has its own control below) and kid costs (charged automatically in retirement years with kids under 18).")}
  ${e("SWR", "safe withdrawal rate. The FIRE target is (spend + pre-65 health cost) divided by SWR: $100K + $12K at 3.5% needs $3.2M. Lower SWR = a bigger target that arrives later but survives longer; research puts the fail-safe for a 50-60 year retirement near 3.25%.")}
  ${e("Earliest retire age (0=at FIRE)", "retirement happens at the LATER of hitting the FIRE number and this age, so no path ever retires under-funded. 0 quits the moment the target is hit, the riskiest version for a 50+ year retirement. Default 38: even if the number arrives at 33, keep working to 38 for cushion, which is what the survival-to-90 metric rewards.")}
  ${e("Withdrawal tax gross-up", "the extra percent withdrawn each retired year to cover taxes on selling shares. Early retirees living off long-term gains mostly pay little; 8% is a conservative default.")}
  ${e("Pre-65 health cost /yr", "yearly pre-Medicare health cost in retirement (ACA premium + out-of-pocket). Retiring at 38 means ~27 years of it. Added to every retired year before 65 AND to the FIRE target, so no path retires unable to afford insurance.")}
  ${e("Social Security /yr (0=none)", "yearly benefit from the SS age onward, subtracted from the withdrawal. Default $25K: a rough PIA for ~15 years of max-taxable earnings, haircut about 25% for trust-fund risk. Set 0 to exclude SS entirely (the old, more conservative behavior).")}
  ${e("Social Security age", "the age the benefit starts. 67 is full retirement age; 70 pays more per year (raise the $ if you model that), 62 less.")}
  </details>`;
}

function readControls() {
  for (const id of SLIDER_IDS) {
    const el = document.getElementById(id);
    if (el) CFG[id] = parseFloat(el.value);
  }
  const rm = document.getElementById("returnModel");
  if (rm) CFG.returnModel = rm.value;
}

function syncURL() {
  const q = new URLSearchParams();
  for (const k of Object.keys(D)) if (CFG[k] !== D[k]) q.set(k, CFG[k]);
  history.replaceState(null, "", q.toString() ? "?" + q.toString() : location.pathname);
}
function loadURL() {
  const q = new URLSearchParams(location.search);
  for (const [k, v] of q.entries()) {
    if (k in D) CFG[k] = k === "returnModel" ? v : parseFloat(v);
  }
}

function assumptionsBox() {
  const c = CFG;
  const att = c.attainment / 100;
  const inc = incomeModel(c.base + c.varTarget * att, c.homeSpendWk, c);
  return `<div class="box"><div class="bt">Assumptions (planning estimates, real dollars)</div>
  Income: $225K base + $75K x ${c.attainment}% | real growth ${c.compGrowth}%/yr${c.promoYear ? ` | promo +${fmt(c.promoJump)} at yr ${c.promoYear}` : ""} | job-loss ${c.jobLossPct}%/yr (6-mo gap) | 401k $24.5K no match | HSA ${c.hsaAnnual ? fmt(c.hsaAnnual) + " (incl. $1,237 employer, FICA-exempt)" : "off"} | 2026 fed + MD + Howard Co + FICA | invested yr-1: <b style="color:#22d3ee">${fmt(inc.invested)}</b><br>
  Life: ${c.kids ? `${c.kids} kid(s) from age ${c.kidAge} ($34K/yr yrs 0-5, $18K/yr 6-17${c.college ? ", $120K college" : ""})` : "no kids modeled"} | ${c.homeAge ? `home at ${c.homeAge} (${fmt(c.homePrice)}, ${c.homeDownPct}%+3% out, then $${c.homePostSpendWk}/wk)` : "no home purchase"} | move-out ${c.moveOutAge}<br>
  Market: ${c.returnModel === "bootstrap" ? "HISTORICAL 5-yr block bootstrap 1970-2024 (real, correlated, mean-reverting)" : c.returnModel === "t" ? "Student-t df5 fat tails" : "iid normal"} | 2/3 US (mu ${c.usMu}% real) + 1/3 intl (mu ${(c.usMu - 2.5).toFixed(1)}%)${c.returnModel === "bootstrap" && c.usMu !== 7 ? ` | bootstrap shifted ${c.usMu > 7 ? "+" : ""}${(c.usMu - 7).toFixed(1)}pts` : ""} | conservative scenario: both sleeves -2.5pts | dividend drag ${c.divDrag}%/yr<br>
  Equity: ${fmt(c.grant)} + ${fmt(c.refreshAnnual)}/yr refresh from yr 2 (2024-25 norm ~20-25% of initial) | cliff+monthly | mu ${c.eqMu}% sig ${c.eqSigma}% | fail ${c.eqFailPct}%/yr | liquidity yr ${c.liqYear || "never"} (-${c.haircut}% -${c.eqTax}%) | refreshes stop at liquidity/retirement; double-trigger RSU assumed<br>
  Retirement: ${c.retireAge ? "retire at FIRE, no earlier than " + c.retireAge : "retire when FIRE"} | withdraw ($${(c.fireSpend / 1000)}K + $${(c.retHealthAnnual / 1000)}K health pre-65 + kid costs) x (1+${c.wdTax}%) minus SS ${c.ssAnnual ? fmt(c.ssAnnual) + " from " + c.ssAge : "off"} | FIRE target ${fmt((c.fireSpend + c.retHealthAnnual) / (c.swr / 100))} at ${c.swr}% | ERN context: fail-safe ~3.25% for 50-60yr horizons<br>
  FIRE = liquid portfolio only; unrealized equity + home equity are the dashed overlay.</div>`;
}

function takeaways(results) {
  return `<div class="box"><div class="bt" style="color:#34d399">Key takeaways</div>
  ${results.map(r => `<span style="color:${r.sc.color}">&#9679;</span> ${r.sc.label}: FIRE by 47 in <b style="color:#e2e8f0">${pctFmt(r.successRate)}</b> | median FIRE age <b style="color:#e2e8f0">${r.fireAgePercentiles.p50 ?? "-"}</b> | median NW@47 <b style="color:#e2e8f0">${fmt(r.percentilesAt47.p50)}</b> | survive to 90: <b style="color:#e2e8f0">${r.survive90 === null ? "-" : pctFmt(r.survive90)}</b><br>`).join("")}</div>`;
}

function render() {
  const app = document.getElementById("app");
  const header = `<div style="margin-bottom:30px">
    <div class="eyebrow" style="color:#34d399">Monte Carlo net-worth simulator v8 - July 2026</div>
    <h1>Path to FIRE - accumulation + drawdown</h1>
    <div class="sub">${CFG.sims.toLocaleString()} sims to age 90 | real dollars | liquid-only FIRE, sequence-risk drawdown, equity overlay</div></div>`;
  let body;
  if (!RESULTS) body = `<div class="running">Running ${CFG.sims.toLocaleString()} sims x 4 scenarios to age 90...</div>`;
  else {
    const rs = RESULTS;
    body = assumptionsBox()
      + rs.map(r => fanChart(r, r.sc.label, r.sc.color)).join("")
      + nw47Table(rs)
      + `<div class="section-break"><div class="eyebrow" style="color:#ff4d6a">FIRE age analysis</div><h2>When do you hit FIRE?</h2></div>`
      + lineChartByAge(rs, r => r.cumulativeFireByAge, "Cumulative probability of FIRE by age (liquid only)", "", 47)
      + ageTable(rs)
      + `<div class="section-break"><div class="eyebrow" style="color:#22d3ee">Drawdown phase</div><h2>Does the money survive retirement?</h2></div>`
      + lineChartByAge(rs, r => r.survivalByAge, "Portfolio survival through retirement (of sims that retired, % solvent by age)", "Sequence-of-returns risk lives here; try SWR 4% vs 3.25%", 90)
      + `<div class="section-break"><div class="eyebrow" style="color:#818cf8">Interactive explorer</div><h2>Year-by-year breakdown</h2></div>`
      + explorer(rs)
      + takeaways(rs)
      + `<div class="footer">Approximate historical data; correlated returns; not financial advice</div>`;
  }
  app.innerHTML = header + ctlHtml() + controlsGuide() + body;
  const peek = document.getElementById("incomepeek");
  if (peek) {
    const inc = incomeModel(CFG.base + CFG.varTarget * CFG.attainment / 100, CFG.homeSpendWk, CFG);
    peek.textContent = `invested yr-1 at these settings: ${fmt(inc.invested)}`;
  }
}

function rerun() {
  readControls();
  syncURL();
  RESULTS = null;
  render();
  setTimeout(() => { RESULTS = scenarioDefs().map(sc => runSim(sc, CFG)); render(); }, 60);
}
function resetDefaults() { CFG = { ...D }; history.replaceState(null, "", location.pathname); rerun(); }

window.setExplorer = (sIdx, pct) => { if (sIdx !== null) EXP.scenario = sIdx; if (pct !== null) EXP.pct = pct; render(); };
window.rerun = rerun;
window.resetDefaults = resetDefaults;

// sanity prints (v8 regression targets at fixed gross 300000/225000, spend $600/wk, v8 defaults:
// ~172037 / ~127869; v6-v7 were 168933 / 125345 before the 2026 constants + HSA)
(function sanity() {
  const a = incomeModel(300000, 600, D), b = incomeModel(225000, 600, D);
  console.log("[sanity] invested yr1 @300K gross:", Math.round(a.invested), "| @225K gross:", Math.round(b.invested));
})();

loadURL();
rerun();
