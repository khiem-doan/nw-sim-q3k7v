# nw-sim

Static Monte Carlo net-worth simulator. Open `index.html` or the Pages deployment.

v7 (2026-07-21): drawdown phase to age 90 (sequence-of-returns risk, survive-to-90 metric + survival chart), return-model toggle (normal / Student-t df5 / historical 5-yr block bootstrap 1970-2024), comp growth + promotion step, equity refresh grants (20-25% norm), children + college, home purchase, dividend tax drag, withdrawal gross-up, URL-param state. FIRE remains liquid-portfolio-only; unrealized equity is an overlay.
v6 (2026-07-20): income+tax model (MD/Howard Co), private-equity module (cliff/monthly vest, lognormal valuation, failure, liquidity merge), 4 scenarios, interactive controls.

## v7.1 (2026-07-21)
- Controls guide: collapsible "What each control means" section under the control panel, plain-English explanation for all 29 controls grouped by panel.
- (v7 carry: starting NW default corrected to $290K; live site shows this only after push.)

## v8.1 (2026-07-23)
- Guardrails toggle (`guardrails` default ON, `grCutPct` default 15%): while the portfolio sits below 85% of its retirement-day value, retirement spending is cut by the guardrail percentage. Models real retiree behavior; OFF restores the fixed-real-withdrawal robot (most pessimistic).
- Fan charts: right-edge colored labels on every percentile line (10th/25th/MEDIAN/75th/90th) + a "+EQ/HOME" tag on the dashed overlay; right padding widened to fit.
- `chartAge` is now a slider (50-90, default 80, was fixed 60): fan charts draw the drawdown decades; the sim always ran to 90.
- Control labels bumped 10px -> 12px for readability.

## v8.0 (2026-07-23)
- 2026 constants corrected: 401k $24,500 (was 23,500), standard deduction $16,100 (was 15,000), SS wage base $184,500 (was 176,100).
- HSA module: `hsaAnnual` default $4,400 (2026 self-only cap) incl. Turing's $1,237 employer contribution; own portion deducted from income tax AND FICA (payroll/Sec-125 treatment); whole amount lands in invested. Set 0 while on a parents' non-HDHP plan (HSA-ineligible until aged off, Jan 2027).
- Honest income defaults: attainment 100 -> 75 (bonus is discretionary, no attainment history yet), promoYear 3 -> 0 (no promotion promised). Both stay sliders for upside modeling.
- Job-loss stress: `jobLossPct` default 3%/yr; a hit costs half the year's contribution AND pulls half a year of spend from the portfolio (6-month gap). 0 restores the old deterministic income path.
- Pre-65 retirement healthcare: `retHealthAnnual` default $12K/yr added to every retired year before 65 AND to the FIRE target, which becomes (fireSpend + retHealth)/SWR (default target $2.86M -> $3.2M).
- Social Security: `ssAnnual` default $25K from `ssAge` 67, subtracted from retirement withdrawals (rough PIA for ~15 max-taxable years, ~25% trust-fund haircut). 0 = old behavior.
- Kid costs now charged during retirement-phase withdrawals too (previously vanished at retirement; a path retiring at 38 with young kids paid $0 for them).
- Home equity overlay: value at `homeAppr` (default 1% real) minus remaining mortgage (30-yr straight-line paydown) added to the dashed total-NW line only; NEVER counts toward the FIRE trigger or ruin.
- Equity-market correlation: `eqMktCorr` default 0.5 correlates valuation shocks with the year's market draw (private outcomes track cycles); 0 restores independence.
- Sanity regression: fixed-input targets (300000/225000 gross, $600/wk) move 168933/125345 -> ~172037/~127869 from the 2026 constants + HSA.

## v7.2 (2026-07-21)
- HONEST equity defaults: liquidity yr 0 (never pays; headline numbers are now truly cash-comp-only) and refresh $0/yr (no refresh program in the offer letter). Both remain sliders for upside modeling.
- Retirement semantics fixed: "Earliest retire age" retires at the LATER of hitting the FIRE number and the chosen age; no path retires under-funded. Default 38.
- US real return mu slider (3-11%, default 7%): intl tracks 2.5pts below; bootstrap shifts history by the delta from 7%.
- Conservative scenario unified: both sleeves -2.5pts (was US-only in normal mode, both in bootstrap).
