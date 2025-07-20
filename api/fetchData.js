// api/fetchData.js
const axios = require("axios");
const {
  fetchCheckFinancialData,
  determineRiskCategory,
  determineRecommendationWithBands,
} = require("../lib/financial");


async function fetchTickerFinancialData(ticker, range){
  // identical to your original fetchTickerFinancialData
  const opts = {
    '1d':  { range:'1d',  interval:'1m' },
    '1mo': { range:'1mo', interval:'5m' },
    '1y':  { range:'1y',  interval:'1d' },
    '3y':  { range:'3y',  interval:'1wk'},
    '10y': { range:'10y', interval:'1mo'}
  };
  const sel = opts[range]||opts['1d'];
  const resp = await axios.get(
    `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=${sel.interval}&range=${sel.range}`
  );
  const r = resp.data.chart.result[0];
  const price = r.meta.regularMarketPrice.toFixed(2);
  const ts    = r.timestamp;
  const prices = (r.indicators.adjclose?.[0].adjclose || r.indicators.quote[0].close);
  const hist = ts.map((t,i)=>({
    date: new Date(t*1000).toLocaleDateString('en-US', range==='1d'||range==='1mo'
      ? { month:'short',day:'numeric',hour:'2-digit',minute:'2-digit' }
      : { month:'short',day:'numeric',year:'numeric' }
    ),
    price: prices[i]
  }));
  return {
    ticker: ticker.toUpperCase(),
    currentPrice: `$${price}`,
    historicalData: hist
  };
}

// ——— Main handler ———

module.exports = async (req, res) => {
  try {
    if (req.query.type === 'check') {
      const d = await fetchCheckFinancialData();
      const mfea = determineRiskCategory(d);
      const rec  = determineRecommendationWithBands(d);

      // Treasury trend arrow text
      let trend = "↔️ No change";
      if (parseFloat(d.treasuryRateChange) >  0.0001) trend = `⬆️ +${Math.abs(d.treasuryRateChange)}%`;
      if (parseFloat(d.treasuryRateChange) < -0.0001) trend = `⬇️ ${Math.abs(d.treasuryRateChange)}%`;

      // Band influences description
      const inf = [];
      if (rec.bandInfo.effSpy)   inf.push("SPY above SMA band");
      if (rec.bandInfo.effVol14) inf.push("Vol <14% band");
      if (rec.bandInfo.effVol24) inf.push("Vol <24% band");
      if (rec.bandInfo.effTreas) inf.push("Treasury drop >0.1%");
      const desc = inf.length
        ? `Factors: ${inf.join(', ')}.`
        : "All factors clear of bands.";

      return res.json({
        ...d,
        treasuryTrend: trend,
        mfeaCategory: mfea.category,
        mfeaAllocation: mfea.allocation,
        recommendedCategory: rec.recommendedCategory,
        recommendedAllocation: rec.recommendedAllocation,
        bandInfluenceDescription: desc
      });
    }

    // Ticker
    if (req.query.ticker && req.query.range) {
      const out = await fetchTickerFinancialData(
        encodeURIComponent(req.query.ticker),
        req.query.range
      );
      return res.json(out);
    }

    res.status(400).json({ error: "Invalid parameters" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message||"Server error" });
  }
};

// Named exports for reuse in cron and tests
module.exports.fetchCheckFinancialData = fetchCheckFinancialData;
module.exports.determineRiskCategory = determineRiskCategory;
module.exports.determineRecommendationWithBands = determineRecommendationWithBands;
