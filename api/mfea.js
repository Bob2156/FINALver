/**
 * Serverless function: /api/mfea
 * Returns strict MFEA results and banded recommendation with history data.
 */
const {
  fetchCheckFinancialData,
  determineRiskCategory,
  determineRecommendationWithBands,
} = require('../lib/financial');

module.exports = async (req, res) => {
  try {
    const d = await fetchCheckFinancialData();
    const strict = determineRiskCategory(d);
    const rec = determineRecommendationWithBands(d);

    const changeNum = parseFloat(d.treasuryRateChange);
    const treasuryTrend =
      changeNum < -0.0001
        ? `\u2B07\uFE0F ${Math.abs(changeNum).toFixed(3)}%`
        : changeNum > 0.0001
        ? `\u2B06\uFE0F +${changeNum.toFixed(3)}%`
        : '\u2194\uFE0F No change';

    res.json({
      ...d,
      treasuryTrend,
      mfeaCategory: strict.category,
      mfeaAllocation: strict.allocation,
      recommendedCategory: rec.recommendedCategory,
      recommendedAllocation: rec.recommendedAllocation,
      bandInfluenceDescription: rec.bandInfo,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
};
