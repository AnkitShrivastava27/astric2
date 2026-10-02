'use strict';
// services/appTiers.js
//
// SINGLE source of truth for App Studio plans on the server. The Flutter
// enum AppTier (app_project_model.dart) mirrors these numbers for display;
// the server never trusts the client for any of them — it only accepts the
// tier NAME and looks everything else up here.
//
//   trial    — 1 small app, 2-3 screens, no revisions
//   standard — 5-6 screens, 3 revisions
//   pro      — 7-8 screens, more revisions, Firebase + REST-backend wiring
//
// tokenBudget doubles as the credit cost of one build of that tier, and as
// the amount of credit one purchased pack adds (a pack buys exactly one build).
const TIERS = {
  trial:    { tokenBudget: 2000,  priceField: 'app_trial_price',    fallbackPriceINR: 19,  minScreens: 2, maxScreens: 3, revisions: 0, backend: false },
  standard: { tokenBudget: 6000,  priceField: 'app_standard_price', fallbackPriceINR: 39,  minScreens: 5, maxScreens: 6, revisions: 3, backend: false },
  pro:      { tokenBudget: 12000, priceField: 'app_pro_price',      fallbackPriceINR: 109, minScreens: 7, maxScreens: 8, revisions: 6, backend: true  },
};

function tierByBudget(budget) {
  const n = Number(budget);
  return Object.keys(TIERS).find((k) => TIERS[k].tokenBudget === n) || null;
}

module.exports = { TIERS, tierByBudget };
