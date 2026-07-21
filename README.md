# nw-sim

Static Monte Carlo net-worth simulator. Open `index.html` or the Pages deployment.

v7 (2026-07-21): drawdown phase to age 90 (sequence-of-returns risk, survive-to-90 metric + survival chart), return-model toggle (normal / Student-t df5 / historical 5-yr block bootstrap 1970-2024), comp growth + promotion step, equity refresh grants (20-25% norm), children + college, home purchase, dividend tax drag, withdrawal gross-up, URL-param state. FIRE remains liquid-portfolio-only; unrealized equity is an overlay.
v6 (2026-07-20): income+tax model (MD/Howard Co), private-equity module (cliff/monthly vest, lognormal valuation, failure, liquidity merge), 4 scenarios, interactive controls.

## v7.1 (2026-07-21)
- Controls guide: collapsible "What each control means" section under the control panel, plain-English explanation for all 29 controls grouped by panel.
- (v7 carry: starting NW default corrected to $290K; live site shows this only after push.)

## v7.2 (2026-07-21)
- HONEST equity defaults: liquidity yr 0 (never pays; headline numbers are now truly cash-comp-only) and refresh $0/yr (no refresh program in the offer letter). Both remain sliders for upside modeling.
- Retirement semantics fixed: "Earliest retire age" retires at the LATER of hitting the FIRE number and the chosen age; no path retires under-funded. Default 38.
- US real return mu slider (3-11%, default 7%): intl tracks 2.5pts below; bootstrap shifts history by the delta from 7%.
- Conservative scenario unified: both sleeves -2.5pts (was US-only in normal mode, both in bootstrap).
