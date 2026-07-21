// nw-sim v6 - Monte Carlo net-worth / FIRE simulator (static, no build)
// Models: income+tax (MD Howard County, single filer, 2026 estimates), portfolio MC
// (2/3 SPY + 1/3 VXUS correlated), private-equity grant with cliff/monthly vesting,
// lognormal valuation, failure risk, and a liquidity-event merge. FIRE is computed on
// the LIQUID portfolio only; unrealized equity is a dashed overlay. Real dollars.

"use strict";

// ===== defaults (editable in the controls panel) =====
const D = {
  startAge: 25, endAge: 55, startingNW: 490000,
  base: 225000, varTarget: 75000, attainment: 100,      // %
  k401: 23500, rothIRA: 7000, useRoth: true,
  homeSpendWk: 600, moveOutAge: 30, moveOutSpendWk: 1292,
  fireSpend: 100000, swr: 3.5,
  partnerAnnual: 40500,
  // equity
  grant: 700000, eqMu: 15, eqSigma: 50, eqFailPct: 4, liqYear: 5, haircut: 25, eqTax: 35,
  countEquityAfterLiq: true,
  // market
  spyMeanHist: 0.07, spyMeanCons: 0.045, spyStd: 0.17, vxusMean: 0.045, vxusStd: 0.18,
  corr: 0.7, spyW: 2 / 3, vxusW: 1 / 3,
  sims: 20000,
  studientContrib: 85800,
};

// ===== tax module (2026 single-filer ESTIMATES; documented in assumptions box) =====
const FED_BRACKETS = [ // [top of bracket, rate]
  [12400, 0.10], [50400, 0.12], [105700, 0.22], [201775, 0.24],
  [256225, 0.32], [640600, 0.35], [Infinity, 0.37],
];
const STD_DEDUCTION = 15000;
const SS_CAP = 176100;
const MD_RATE = 0.0575, HOCO_RATE = 0.032;

function fedTax(taxable) {
  let tax = 0, prev = 0;
  for (const [top, rate] of FED_BRACKETS) {
    if (taxable <= prev) break;
    tax += (Math.min(taxable, top) - prev) * rate;
    prev = top;
  }
  return tax;
}

// annual invested cash given gross comp + weekly spend
function incomeModel(gross, spendWk, cfg) {
  const k401 = cfg.k401;
  const taxable = Math.max(0, gross - k401 - STD_DEDUCTION);
  const fed = fedTax(taxable);
  const state = taxable * (MD_RATE + HOCO_RATE);
  const ss = Math.min(gross, SS_CAP) * 0.062;
  const medicare = gross * 0.0145 + Math.max(0, gross - 200000) * 0.009;
  const net = gross - k401 - fed - state - ss - medicare;
  const spend = spendWk * 52;
  const invested = k401 + Math.max(0, net - spend); // 401k + brokerage/backdoor-roth
  return { gross, k401, fed, state, ss, medicare, net, spend, invested };
}

// ===== RNG =====
function randn() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ===== simulation =====
// scenario: {key,label,color, returns:'hist'|'cons', partner:bool, studient:bool, equity:bool}
function runSim(sc, cfg) {
  const years = cfg.endAge - cfg.startAge;
  const spyMean = sc.returns === "cons" ? cfg.spyMeanCons : cfg.spyMeanHist;
  const fireTarget = cfg.fireSpend / (cfg.swr / 100);
  const att = cfg.attainment / 100;
  const grossTuring = cfg.base + cfg.varTarget * att;

  // contribution + spend schedule per sim-year (age = startAge + y during year y)
  const contribs = [], spends = [];
  for (let y = 0; y < years; y++) {
    const age = cfg.startAge + y;
    if (sc.studient) {
      contribs.push(cfg.studientContrib);
      spends.push(0);
    } else {
      const wk = age < cfg.moveOutAge ? cfg.homeSpendWk : cfg.moveOutSpendWk;
      const inc = incomeModel(grossTuring, wk, cfg);
      let c = inc.invested;
      if (sc.partner && age >= 30) c += cfg.partnerAnnual;
      contribs.push(c);
      spends.push(inc.spend);
    }
  }

  const eqMu = cfg.eqMu / 100, eqSig = cfg.eqSigma / 100, pFail = cfg.eqFailPct / 100;
  const haircut = cfg.haircut / 100, eqTaxR = cfg.eqTax / 100;
  const liqIdx = cfg.liqYear; // years after start; 0 disables (never)

  const paths = [], totalPaths = [], fireAges = [];
  for (let sim = 0; sim < cfg.sims; sim++) {
    let nw = cfg.startingNW, fireAge = null;
    let eqMult = 1, eqDead = !sc.equity, eqMerged = false;
    const path = [nw], tpath = [nw];

    for (let y = 0; y < years; y++) {
      const z1 = randn(), z2 = randn();
      const spyR = spyMean + cfg.spyStd * z1;
      const vxusR = cfg.vxusMean + cfg.vxusStd * (cfg.corr * z1 + Math.sqrt(1 - cfg.corr * cfg.corr) * z2);
      const r = cfg.spyW * spyR + cfg.vxusW * vxusR;
      nw = nw * (1 + r) + contribs[y] * (1 + r / 2);

      // equity: value evolves; vest by service year-end (cliff at end of year 1)
      let eqUnreal = 0;
      if (!eqDead && !eqMerged) {
        eqMult *= Math.exp(eqMu - 0.5 * eqSig * eqSig + eqSig * randn());
        if (Math.random() < pFail) { eqDead = true; }
        else {
          const svcYear = y + 1;
          const vested = svcYear >= 4 ? 1 : svcYear >= 1 ? svcYear * 0.25 : 0;
          const val = vested * cfg.grant * eqMult;
          if (liqIdx > 0 && svcYear === liqIdx) {
            nw += val * (1 - haircut) * (1 - eqTaxR);
            eqMerged = true;
          } else {
            eqUnreal = val;
          }
        }
      }

      nw = Math.max(0, nw);
      path.push(nw);
      tpath.push(nw + eqUnreal);
      if (fireAge === null && nw >= fireTarget) fireAge = cfg.startAge + y + 1;
    }
    paths.push(path); totalPaths.push(tpath); fireAges.push(fireAge);
  }

  // percentiles
  const pcts = [0.1, 0.25, 0.33, 0.5, 0.66, 0.75, 0.9];
  const percentilePaths = {}, totalMedianPath = [];
  for (const p of pcts) percentilePaths[p] = [];
  for (let y = 0; y <= years; y++) {
    const vals = paths.map(pt => pt[y]).sort((a, b) => a - b);
    for (const p of pcts) percentilePaths[p].push(vals[Math.min(Math.floor(p * vals.length), vals.length - 1)]);
    const tv = totalPaths.map(pt => pt[y]).sort((a, b) => a - b);
    totalMedianPath.push(tv[Math.floor(0.5 * tv.length)]);
  }
  const age47Idx = 47 - cfg.startAge;
  const nwAt47 = paths.map(p => p[age47Idx]).sort((a, b) => a - b);
  const pctAt47 = p => nwAt47[Math.min(Math.floor(p * nwAt47.length), nwAt47.length - 1)];
  const reached = fireAges.filter(a => a !== null).sort((a, b) => a - b);
  const fireAgeP = p => reached.length ? reached[Math.min(Math.floor(p * reached.length), reached.length - 1)] : null;
  const cumulativeFireByAge = [];
  for (let age = cfg.startAge; age <= cfg.endAge; age++) {
    cumulativeFireByAge.push({ age, rate: fireAges.filter(a => a !== null && a <= age).length / cfg.sims });
  }
  return {
    sc, contribs, spends, years, startAge: cfg.startAge, fireTarget,
    percentilePaths, totalMedianPath,
    percentilesAt47: { p10: pctAt47(0.1), p25: pctAt47(0.25), p33: pctAt47(0.33), p50: pctAt47(0.5), p66: pctAt47(0.66), p75: pctAt47(0.75), p90: pctAt47(0.9) },
    successRate: fireAges.filter(a => a !== null && a <= 47).length / cfg.sims,
    fireAgePercentiles: { p10: fireAgeP(0.1), p25: fireAgeP(0.25), p33: fireAgeP(0.33), p50: fireAgeP(0.5), p66: fireAgeP(0.66), p75: fireAgeP(0.75), p90: fireAgeP(0.9) },
    cumulativeFireByAge,
  };
}

// ===== formatting =====
const fmt = v => v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}K` : `$${v.toFixed(0)}`;
const fmtX = v => `$${Math.round(v).toLocaleString("en-US")}`;
const pctFmt = v => `${(v * 100).toFixed(1)}%`;

// ===== charts (SVG string builders) =====
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
  const pd = data => data.map((v, i) => `${i ? "L" : "M"}${xs(i).toFixed(1)},${ys(v).toFixed(1)}`).join(" ");
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
    ${res.sc.equity ? `<path d="${pd(totalMedianPath)}" fill="none" stroke="#22d3ee" stroke-width="2" stroke-dasharray="6 4" opacity="0.9"/>
    <text x="${W - P.r - 4}" y="${ys(totalMedianPath[totalMedianPath.length - 1]) - 6}" text-anchor="end" fill="#22d3ee" font-size="9">median incl. unrealized equity</text>` : ""}
    ${yT.map(v => `<text x="${P.l - 8}" y="${ys(v) + 4}" text-anchor="end" fill="#5a6a8a" font-size="10">${fmt(v)}</text>`).join("")}
    ${xT.map(y => `<text x="${xs(y)}" y="${H - P.b + 20}" text-anchor="middle" fill="#5a6a8a" font-size="10">Age ${startAge + y}</text>`).join("")}
    <text x="${P.l + 8}" y="${P.t + 16}" fill="#5a6a8a" font-size="9">Bands: 10th-90th | Lines: 10,25,Median,75,90 | Dashed cyan: +unrealized equity (median)</text>
  </svg></div>`;
}

function cumChart(results) {
  const W = 760, H = 380, P = { t: 30, r: 30, b: 50, l: 70 };
  const pw = W - P.l - P.r, ph = H - P.t - P.b;
  const ages = results[0].cumulativeFireByAge.map(d => d.age);
  const a0 = ages[0], a1 = ages[ages.length - 1];
  const xs = a => P.l + ((a - a0) / (a1 - a0)) * pw, ys = r => P.t + ph - r * ph;
  const pd = d => d.map((p, i) => `${i ? "L" : "M"}${xs(p.age).toFixed(1)},${ys(p.rate).toFixed(1)}`).join(" ");
  const yT = [0, 0.25, 0.5, 0.75, 1];
  const xT = []; for (let a = a0; a <= a1; a += 5) xT.push(a);
  return `<div class="chartwrap"><h3 style="color:#e2e8f0">Cumulative probability of FIRE by age (liquid portfolio only)</h3>
  <svg class="chart" viewBox="0 0 ${W} ${H}">
    ${yT.map(v => `<line x1="${P.l}" x2="${W - P.r}" y1="${ys(v)}" y2="${ys(v)}" stroke="#1a2035"/>`).join("")}
    <line x1="${xs(47)}" x2="${xs(47)}" y1="${P.t}" y2="${P.t + ph}" stroke="#ff4d6a" stroke-width="1.5" stroke-dasharray="6 3" opacity="0.7"/>
    <text x="${xs(47) + 4}" y="${P.t + 14}" fill="#ff4d6a" font-size="9">Target: 47</text>
    ${results.map(r => `<path d="${pd(r.cumulativeFireByAge)}" fill="none" stroke="${r.sc.color}" stroke-width="2.5"/>`).join("")}
    ${results.map((r, i) => `<line x1="${P.l + 12}" x2="${P.l + 32}" y1="${P.t + 16 + i * 18}" y2="${P.t + 16 + i * 18}" stroke="${r.sc.color}" stroke-width="2.5"/><text x="${P.l + 38}" y="${P.t + 20 + i * 18}" fill="${r.sc.color}" font-size="10">${r.sc.label}</text>`).join("")}
    ${yT.map(v => `<text x="${P.l - 8}" y="${ys(v) + 4}" text-anchor="end" fill="#5a6a8a" font-size="10">${(v * 100).toFixed(0)}%</text>`).join("")}
    ${xT.map(a => `<text x="${xs(a)}" y="${H - P.b + 20}" text-anchor="middle" fill="#5a6a8a" font-size="10">Age ${a}</text>`).join("")}
  </svg></div>`;
}

function nw47Table(results) {
  const keys = ["p10", "p25", "p33", "p50", "p66", "p75", "p90"];
  const labels = ["10th", "25th", "33rd", "50th (Median)", "66th", "75th", "90th"];
  return `<div style="overflow-x:auto;margin-bottom:30px">
  <h3 style="color:#8899bb;text-transform:uppercase;letter-spacing:0.08em;font-size:13px;margin-bottom:12px">Liquid net worth at age 47</h3>
  <table><thead><tr><th style="text-align:left">Percentile</th>${results.map(r => `<th class="tr-num">${r.sc.label}</th>`).join("")}</tr></thead><tbody>
  ${keys.map((k, i) => `<tr><td style="color:#8899bb">${labels[i]}</td>${results.map(r => {
    const v = r.percentilesAt47[k];
    return `<td class="tr-num" style="color:${v >= r.fireTarget ? "#34d399" : "#e2e8f0"};font-weight:${k === "p50" ? 700 : 400}">${fmt(v)}</td>`;
  }).join("")}</tr>`).join("")}
  <tr style="border-top:2px solid #1e2a45"><td style="color:#ff4d6a;font-weight:700">FIRE by 47</td>
  ${results.map(r => `<td class="tr-num" style="font-weight:700;font-size:13px;color:${r.successRate >= 0.5 ? "#34d399" : r.successRate >= 0.33 ? "#fbbf24" : "#ff4d6a"}">${pctFmt(r.successRate)}</td>`).join("")}
  </tr></tbody></table></div>`;
}

function ageTable(results) {
  const keys = ["p10", "p25", "p33", "p50", "p66", "p75", "p90"];
  const labels = ["10th (Best)", "25th", "33rd", "50th (Median)", "66th", "75th", "90th (Worst)"];
  return `<div style="overflow-x:auto;margin-bottom:30px">
  <h3 style="color:#8899bb;text-transform:uppercase;letter-spacing:0.08em;font-size:13px;margin-bottom:12px">Age you would reach FIRE - percentile table</h3>
  <table><thead><tr><th style="text-align:left">Percentile</th>${results.map(r => `<th class="tr-num">${r.sc.label}</th>`).join("")}</tr></thead><tbody>
  ${keys.map((k, i) => `<tr><td style="color:#8899bb">${labels[i]}</td>${results.map(r => {
    const a = r.fireAgePercentiles[k];
    return `<td class="tr-num" style="color:${a === null ? "#ff4d6a" : a <= 47 ? "#34d399" : "#e2e8f0"};font-weight:${k === "p50" ? 700 : 400}">${a === null ? "-" : "Age " + a}</td>`;
  }).join("")}</tr>`).join("")}
  </tbody></table>
  <p style="font-size:10px;color:#5a6a8a;margin-top:8px">Among sims that reached FIRE (liquid only) - green = by 47</p></div>`;
}

// year-by-year explorer
let EXP = { scenario: 0, pct: 0.5 };
function explorer(results) {
  const pctOpts = [[0.1, "10th (Unlucky)"], [0.25, "25th"], [0.5, "Median"], [0.75, "75th"], [0.9, "90th (Lucky)"]];
  const res = results[EXP.scenario];
  const path = res.percentilePaths[EXP.pct];
  const color = res.sc.color;
  let rows = "";
  for (let y = 0; y <= res.years; y++) {
    const age = res.startAge + y, nw = path[y];
    const contrib = y > 0 ? res.contribs[y - 1] : 0;
    const prev = y > 0 ? path[y - 1] : null;
    const growth = prev !== null ? nw - prev - contrib : null;
    const gPct = prev ? (nw - contrib) / prev - 1 : null;
    const hit = nw >= res.fireTarget;
    rows += `<tr style="background:${hit ? "#34d39908" : age === 47 ? "#ff4d6a08" : "transparent"}">
      <td style="color:${age === 47 ? "#ff4d6a" : "#8899bb"};font-weight:${age === 47 ? 700 : 400}">${age}${age === 47 ? " *" : ""}</td>
      <td class="tr-num" style="color:${hit ? "#34d399" : "#e2e8f0"};font-weight:${hit || age === 47 ? 700 : 400}">${fmtX(nw)}</td>
      <td class="tr-num" style="color:#5a6a8a">${y === 0 ? "-" : fmtX(contrib)}</td>
      <td class="tr-num" style="color:${growth === null ? "#5a6a8a" : growth >= 0 ? "#34d399" : "#ff4d6a"}">${growth === null ? "-" : (growth >= 0 ? "+" : "") + fmtX(growth)}</td>
      <td class="tr-num" style="color:${gPct === null ? "#5a6a8a" : gPct >= 0 ? "#34d399" : "#ff4d6a"}">${gPct === null ? "-" : (gPct >= 0 ? "+" : "") + (gPct * 100).toFixed(1) + "%"}</td>
      <td style="text-align:center">${hit ? '<span style="color:#34d399;font-weight:700">Y</span>' : '<span style="color:#2a3555">.</span>'}</td></tr>`;
  }
  return `<div>
  <div style="margin-bottom:12px"><div class="eyebrow" style="color:#5a6a8a">Scenario</div>
  ${results.map((r, i) => `<button class="tab${EXP.scenario === i ? " active" : ""}" style="${EXP.scenario === i ? `border-color:${r.sc.color};color:${r.sc.color};background:${r.sc.color}22` : ""}" onclick="setExplorer(${i},null)">${r.sc.label}</button>`).join(" ")}</div>
  <div style="margin-bottom:16px"><div class="eyebrow" style="color:#5a6a8a">Percentile</div>
  ${pctOpts.map(([p, l]) => `<button class="tab${EXP.pct === p ? " active" : ""}" style="${EXP.pct === p ? `border-color:${color};color:${color};background:${color}22` : ""}" onclick="setExplorer(null,${p})">${l}</button>`).join(" ")}</div>
  <div class="scrolltable"><table>
  <thead><tr><th style="text-align:left">Age</th><th class="tr-num">Liquid NW</th><th class="tr-num">Contributed</th><th class="tr-num">Market growth</th><th class="tr-num">Return %</th><th style="text-align:center">FIRE?</th></tr></thead>
  <tbody>${rows}</tbody></table></div></div>`;
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

function ctlHtml() {
  const c = CFG;
  const s = (id, lab, min, max, step, val, unit) => `<div class="ctl"><label>${lab}<span class="val" id="v_${id}">${val}${unit}</span></label>
  <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${val}" oninput="document.getElementById('v_${id}').textContent=this.value+'${unit}'"></div>`;
  return `<div class="controls"><h3>Controls (re-run after changing)</h3><div class="ctl-grid">
  ${s("attainment", "Variable attainment", 0, 150, 5, c.attainment, "%")}
  ${s("homeSpendWk", "Spend at home /wk", 300, 1500, 25, c.homeSpendWk, "")}
  ${s("moveOutAge", "Move-out age", 26, 40, 1, c.moveOutAge, "")}
  ${s("moveOutSpendWk", "Spend after move /wk", 600, 3000, 25, c.moveOutSpendWk, "")}
  ${s("fireSpend", "FIRE spend $/yr", 50000, 150000, 5000, c.fireSpend, "")}
  ${s("swr", "SWR", 3, 4.5, 0.25, c.swr, "%")}
  ${s("startingNW", "Starting NW", 200000, 800000, 10000, c.startingNW, "")}
  ${s("eqMu", "Equity growth mu", -20, 40, 5, c.eqMu, "%")}
  ${s("eqSigma", "Equity sigma", 20, 90, 5, c.eqSigma, "%")}
  ${s("eqFailPct", "Company failure /yr", 0, 15, 1, c.eqFailPct, "%")}
  ${s("liqYear", "Liquidity event (yrs in; 0=never)", 0, 15, 1, c.liqYear, "")}
  ${s("haircut", "Liquidity haircut", 0, 60, 5, c.haircut, "%")}
  ${s("eqTax", "Equity tax at liquidity", 20, 50, 5, c.eqTax, "%")}
  </div><div class="btnrow"><button class="run" onclick="rerun()">Re-run 20,000 sims</button>
  <span id="incomepeek" style="font-size:10px;color:#5a6a8a"></span></div></div>`;
}

function readControls() {
  for (const id of ["attainment", "homeSpendWk", "moveOutAge", "moveOutSpendWk", "fireSpend", "swr", "startingNW", "eqMu", "eqSigma", "eqFailPct", "liqYear", "haircut", "eqTax"]) {
    const el = document.getElementById(id);
    if (el) CFG[id] = parseFloat(el.value);
  }
}

function assumptionsBox() {
  const c = CFG;
  const incHome = incomeModel(c.base + c.varTarget * c.attainment / 100, c.homeSpendWk, c);
  const incBase = incomeModel(c.base, c.homeSpendWk, c);
  return `<div class="box"><div class="bt">Assumptions (all planning estimates, real dollars)</div>
  Income: $${(c.base / 1000)}K base + $${(c.varTarget / 1000)}K variable x ${c.attainment}% attainment | 401k $${(c.k401 / 1000).toFixed(1)}K pre-tax, NO match | backdoor Roth from post-tax cash<br>
  Taxes: 2026 single-filer estimates - federal brackets, MD 5.75% + Howard County 3.2%, FICA w/ SS cap; no raises modeled (conservative)<br>
  Invested/yr at current settings: <b style="color:#22d3ee">${fmt(incHome.invested)}</b> at ${c.attainment}% attainment (at-home spend) | ${fmt(incBase.invested)} at base-only<br>
  Spend: $${c.homeSpendWk}/wk at home to age ${c.moveOutAge}, then $${c.moveOutSpendWk}/wk | FIRE target: $${(c.fireSpend / 1000)}K/yr at ${c.swr}% = <b>${fmt(c.fireSpend / (c.swr / 100))}</b><br>
  Market: 2/3 SPY (mu 7% hist / 4.5% cons, sig 17%) + 1/3 VXUS (4.5%, 18%), rho 0.70 | ${c.sims.toLocaleString()} sims to age ${c.endAge}<br>
  Equity: $${(c.grant / 1000)}K grant, 1-yr cliff then monthly to 4 yrs (assumes staying 4+ yrs) | lognormal mu ${c.eqMu}% sig ${c.eqSigma}% | fail ${c.eqFailPct}%/yr | liquidity yr ${c.liqYear || "never"} with ${c.haircut}% haircut + ${c.eqTax}% tax, double-trigger RSU treatment assumed (instrument TBC in written offer)<br>
  FIRE is computed on the LIQUID portfolio only; unrealized equity is the dashed overlay and merges only at the liquidity event.</div>`;
}

function takeaways(results) {
  return `<div class="box"><div class="bt" style="color:#34d399">Key takeaways</div>
  ${results.map(r => `<span style="color:${r.sc.color}">&#9679;</span> ${r.sc.label}: FIRE by 47 in <b style="color:#e2e8f0">${pctFmt(r.successRate)}</b> of sims | median FIRE age <b style="color:#e2e8f0">${r.fireAgePercentiles.p50 ?? "-"}</b> | median NW@47 <b style="color:#e2e8f0">${fmt(r.percentilesAt47.p50)}</b><br>`).join("")}
  </div>`;
}

function render() {
  const app = document.getElementById("app");
  const header = `<div style="margin-bottom:30px">
    <div class="eyebrow" style="color:#34d399">Monte Carlo net-worth simulator v6 - July 2026</div>
    <h1>Path to FIRE - the new-offer edition</h1>
    <div class="sub">${CFG.sims.toLocaleString()} simulations per scenario | real dollars | liquid-only FIRE with equity overlay</div></div>`;
  let body;
  if (!RESULTS) {
    body = `<div class="running">Running ${CFG.sims.toLocaleString()} sims x 4 scenarios...</div>`;
  } else {
    const rs = RESULTS;
    body = assumptionsBox()
      + rs.map(r => fanChart(r, r.sc.label, r.sc.color)).join("")
      + nw47Table(rs)
      + `<div class="section-break"><div class="eyebrow" style="color:#ff4d6a">FIRE age analysis</div><h2>When do you actually hit FIRE?</h2></div>`
      + cumChart(rs) + ageTable(rs)
      + `<div class="section-break"><div class="eyebrow" style="color:#818cf8">Interactive explorer</div><h2>Year-by-year breakdown</h2></div>`
      + explorer(rs)
      + takeaways(rs)
      + `<div class="footer">Correlated normal returns | not financial advice | past performance is not future results</div>`;
  }
  app.innerHTML = header + ctlHtml() + body;
  const peek = document.getElementById("incomepeek");
  if (peek) {
    const inc = incomeModel(CFG.base + CFG.varTarget * CFG.attainment / 100, CFG.homeSpendWk, CFG);
    peek.textContent = `invested/yr at these settings: ${fmt(inc.invested)} (net ${fmt(inc.net)}, tax ${fmt(inc.fed + inc.state + inc.ss + inc.medicare)})`;
  }
}

function rerun() {
  readControls();
  RESULTS = null;
  render();
  setTimeout(() => {
    RESULTS = scenarioDefs().map(sc => runSim(sc, CFG));
    render();
  }, 60);
}

window.setExplorer = (sIdx, pct) => {
  if (sIdx !== null) EXP.scenario = sIdx;
  if (pct !== null) EXP.pct = pct;
  render();
};
window.rerun = rerun;

// sanity prints (plan targets: ~169K at 100% attainment, ~125K at base-only)
(function sanity() {
  const a = incomeModel(300000, 600, D), b = incomeModel(225000, 600, D);
  console.log("[sanity] invested @100% attainment:", Math.round(a.invested), "| @base-only:", Math.round(b.invested));
})();

rerun();
