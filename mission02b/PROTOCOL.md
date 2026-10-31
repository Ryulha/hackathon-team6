# Mission 02B evaluation protocol — frozen before new model scores

STATUS: PROPOSED — NOT TEAM APPROVED

Frozen: 2026-10-31 Asia/Seoul. Source: supplied local synthetic hackathon CSVs;
these are executed-data experiments, never evidence of real-store performance.
No source, fitted model or row-level result leaves this workspace.

## Cohort and model budget
- Fold A: target dates 2026-01-29..05-31 train; origins >=06-01 and targets 06-01..06-30 validation.
- Fold B: target dates 2026-01-29..06-30 train; origins >=07-01 and targets 07-01..07-31 validation.
- Daily Asia/Seoul start-of-day origins; direct horizons 0..6, origin day included.
  Warmup 28 days after 01-01. All history strictly date < origin.
  Train filtered by TARGET date, including partial right-boundary horizons.
  Evaluate identical keys (origin,target,horizon,store,menu); active zeroes retained,
  unavailable menu targets excluded. No model-specific row deletion.
- No August/September scores/features/labels used in development or selection.
  Development sales are truncated before August 1. July score is development evidence.
- A0 is the existing RMSE architecture and EXACT original feature list at fixed
  400 trees (original configured maximum), depth=6, learning_rate=.05,
  l2_leaf_reg=5, seed=42, threads=4, no early stopping for ANY candidate.
  Existing deployed 122 trees were selected on July and are not imported into
  Fold A selection. Hence A0 is a budget-controlled re-fit, not the original
  July-tuned validation score. Final holdout additionally compares frozen
  deployed 122-tree model on identical targets, and A0 at 400 trees.
- A1 MAE, A2 Poisson differ ONLY in loss. Explicit Exponent prediction for Poisson;
  do not exponentiate CatBoost's default output twice. Official reference:
  https://catboost.ai/docs/en/concepts/python-reference_catboostregressor_predict
- B1 features only; B2/B3 base features + half-life 28/56 days;
  B4/B5 new features + half-life 28/56 days. All RMSE, 400 trees.
  Weight = 2**(-(latest training target - target date).days / half_life).
- New features: EWMA half-lives 7/28 over trailing 56 calendar days (active
  observations only); mean7/mean28 ratio; historical menu/store shares 7/28 and
  share change; latest same-weekday vs preceding 3 occurrences; active-day zero
  rates14/28. Existing store_trend already implements recent store demand change;
  retain it rather than duplicate it. Prior category-smoothed shares are also
  provided to hierarchy. Full feature schema saved with every model.
- C: separate 400-tree RMSE store total model and 400-tree RMSE menu share model;
  share features include calendar/store/menu/category and historical smoothed shares.
  Category/store prior shrinks sparse pairs with 7 pseudo-days; weekday share
  uses 3 pseudo-observations. Predicted nonnegative share scores are normalized
  over currently active menus. Their sum equals predicted store total.

## Metrics
- Menu WAPE=sum|p-y|/sum|y|, MAE=mean|p-y|, Bias=sum(p-y)/sum|y|;
  under/over quantities=sum max(y-p,0)/max(p-y,0). Overall is prediction-case
  weighted across origin/horizon, NOT unique calendar days. Save store, menu,
  store-menu, horizon, month, size-band tables. Size bands fixed using each
  fold's pre-validation history: low mean<5, medium 5..20, high>=20, cold missing.
- Ingredient daily = horizon0, BOM applied exactly once per sold menu/set.
  use_unit retained; never sum different ingredient quantities. Macro WAPE is
  equal-weight mean of defined STORE x INGREDIENT WAPEs, matching Mission02A.
  Also report each ingredient pooled over stores, retaining ingredient/unit.
- 1/2/3/7-day covers use predictions from ONE frozen origin. Primary comparison
  uses common origins with all 7 horizons present, same cohort for every cover.
  Inactive ingredient days remain zero in cover but are excluded if entire
  cover has no active BOM menu. Daily active zero days remain scored.
- Forecast net usage=p*(1-r_hat), r_hat from accepted qty/cancel_qty in prior56d.
  Evaluate consumed_qty (observed net BOM), no_stockout_proxy=net+lost*(1-r_hat),
  rate_adjusted_demand=demand*(1-r_hat), and raw latent demand BOM.
  Signed proxy error = demand error*(1-r_hat) + cancel_qty-qty*r_hat.
  Signed consumed error adds lost*(1-r_hat). Absolute component errors do not add.
- Lettuce I009, toast bread I020, coleslaw I017 are POSTHOC EXPLORATORY items
  selected by prior full-period EDA. They are safety diagnostics, not newly
  discovered confirmatory subgroups. No ordering optimization/cost savings.

## Precommitted selection and conditional experiments
- Primary rank: equal-weight average of Fold A/B menu WAPE.
- Recommend candidate only if it beats A0 in BOTH folds, and mean absolute
  improvement >=0.005 (0.50 percentage point). This is a practical threshold,
  not statistical significance. Otherwise keep existing model.
- Mandatory guardrails in each fold: ingredient daily macro and EACH cover
  macro (no_stockout_proxy) <= A0+0.01; absolute overall menu Bias <= A0+0.02;
  absolute Bias for EACH named exploratory ingredient <= A0+0.03.
  Report MAE underprediction and all ingredient/store bias even if no change.
- First finish A-C. Conditional D1 hurdle if low-demand band A0 WAPE exceeds
  high-band WAPE by 25% in both folds, and no A-C candidate improves low-band
  WAPE by >=2% relative in BOTH folds. One fixed CatBoost occurrence classifier
  plus positive-only Poisson model (400 trees each, base features), expected
  demand = P(nonzero)*E(demand|positive). No search or further count variants.
- Conditional D2 residual correction if best A-C by mean WAPE has same-sign
  overall Bias with |Bias|>=2% in BOTH folds. Fixed trailing28d residual mean
  for pair x horizon, shrunk toward global horizon mean with 20 pseudo-cases,
  clipped correction to +/-30% of max(prediction,1), nonnegative output.
  Only PREQUENTIAL base-model residuals whose target < origin are available.
  Reset residual bank at each evaluation interval. No fitted/in-sample residuals,
  no future residuals, no all-Test correction. Append once; no iterative tuning.
- Rank all permitted models once; apply gates. Selection JSON locked before
  holdout. If none pass, selected=A0 and retain existing production default.
- Then fixed re-fit through 07-31 and one August/September historical holdout
  evaluation of selected candidate, A0 and frozen existing122. No tuning after.
  This period was examined in earlier missions: NOT a new independent test.
  If development passes but holdout reverses, report reversal and keep default;
  never use holdout to choose a different candidate.

## Preservation and validation
All new files in mission02b/. Existing 174 substantive files SHA-256 snapshotted
in audit/before.json. No .git present; cannot claim clean Git or commit identity.
Tests and original real-data pipeline run with outputs redirected under mission02b.
The Mission02A preservation test writes its own JSON; intercept only that output
path in the test harness so original tests can execute without overwriting it.
New tests cover future mutation, training cutoff, Poisson scale, persistence,
hierarchy conservation, availability/zeroes, units, scenarios and metrics.
Experimental API returns original ForecastResult; default forecast API unchanged.
