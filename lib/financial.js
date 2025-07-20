// Shared financial logic
const axios = require('axios');

function logDebug(msg) {
  console.debug('[DEBUG]', msg);
}

function calculateAllocationLogic(isSpyAboveSma, isVolBelow14, isVolBelow24, isTreasuryFalling) {
  if (isSpyAboveSma) {
    if (isVolBelow14) {
      return { category: 'Risk On', allocation: '100% UPRO…' };
    }
    if (isVolBelow24) {
      return { category: 'Risk Mid', allocation: '100% SSO…' };
    }
    return isTreasuryFalling
      ? { category: 'Risk Alt', allocation: '25% UPRO + 75% ZROZ' }
      : { category: 'Risk Off', allocation: '100% SPY' };
  }
  return isTreasuryFalling
    ? { category: 'Risk Alt', allocation: '25% UPRO + 75% ZROZ' }
    : { category: 'Risk Off', allocation: '100% SPY' };
}

function determineRiskCategory(data) {
  const spy = parseFloat(data.spy);
  const sma = parseFloat(data.sma220);
  const vol = parseFloat(data.volatility);
  const tfalling = data.isTreasuryFalling;
  return calculateAllocationLogic(spy > sma, vol < 14, vol < 24, tfalling);
}

function determineRecommendationWithBands(data) {
  const spy = parseFloat(data.spy);
  const sma = parseFloat(data.sma220);
  const vol = parseFloat(data.volatility);
  const change = parseFloat(data.treasuryRateChange);

  const isSpyAbove = spy > sma;
  const isVol14 = vol < 14;
  const isVol24 = vol < 24;

  const smaBandPct = 0.02;
  const volBand = 1.0;
  const treasuryThresh = -0.001;

  const lowerSMA = sma * (1 - smaBandPct);
  const upperSMA = sma * (1 + smaBandPct);
  const lower14 = 14 - volBand;
  const upper14 = 14 + volBand;
  const lower24 = 24 - volBand;
  const upper24 = 24 + volBand;

  const effSpy = spy > upperSMA ? true : spy < lowerSMA ? false : isSpyAbove;
  const effVol14 = vol < lower14 ? true : vol > upper14 ? false : isVol14;
  const effVol24 = vol < lower24 ? true : vol > upper24 ? false : isVol24;
  const effTreas = change < treasuryThresh;

  logDebug(`Bands: SPY ${lowerSMA.toFixed(2)}–${upperSMA.toFixed(2)}, Vol14 ${lower14}-${upper14}, Vol24 ${lower24}-${upper24}, Treas <${treasuryThresh}`);

  const rec = calculateAllocationLogic(effSpy, effVol14, effVol24, effTreas);
  return {
    recommendedCategory: rec.category,
    recommendedAllocation: rec.allocation,
    bandInfo: {
      smaBandPct,
      volBand,
      treasuryThresh,
      effSpy,
      effVol14,
      effVol24,
      effTreas,
    },
  };
}

async function fetchCheckFinancialData() {
  const [spyResp, trxResp, volResp] = await Promise.all([
    axios.get('https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=220d'),
    axios.get('https://query1.finance.yahoo.com/v8/finance/chart/%5EIRX?interval=1d&range=50d'),
    axios.get('https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=40d'),
  ]);

  const sres = spyResp.data.chart.result[0];
  const priceArr = sres.indicators.adjclose[0].adjclose;
  const tsArr = sres.timestamp;
  const valid = tsArr
    .map((t, i) => (typeof priceArr[i] === 'number' ? { date: new Date(t * 1000).toLocaleDateString('en-US'), price: priceArr[i] } : null))
    .filter((x) => x)
    .slice(-220);

  const prices = valid.map((v) => v.price);
  const sma220 = prices.reduce((a, b) => a + b, 0) / prices.length;

  const trx = trxResp.data.chart.result[0];
  const rArr = trx.indicators.quote[0].close;
  const idx = rArr.length - 1;
  const oneMo = idx - 21;
  const currT = rArr[idx];
  const prevT = rArr[oneMo < 0 ? 0 : oneMo];
  const delta = currT - prevT;
  const isF = delta < -0.0001;

  const vres = volResp.data.chart.result[0].indicators.adjclose[0].adjclose.filter((x) => typeof x === 'number');
  const ret = vres
    .slice(-22)
    .map((p, i, a) => (i ? p / a[i - 1] - 1 : null))
    .filter((x) => x != null);
  const mean = ret.reduce((s, r) => s + r, 0) / ret.length;
  const variance = ret.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / ret.length;
  const annVol = Math.sqrt(variance) * Math.sqrt(252) * 100;

  return {
    spy: prices[prices.length - 1].toFixed(2),
    sma220: sma220.toFixed(2),
    spyStatus: prices[prices.length - 1] > sma220 ? 'Over' : 'Under',
    volatility: annVol.toFixed(2),
    treasuryRate: currT.toFixed(3),
    treasuryRateChange: delta.toFixed(4),
    isTreasuryFalling: isF,
    priceHistory: valid,
    smaHistory: valid.map((v) => ({ date: v.date, sma: parseFloat(sma220.toFixed(2)) })),
  };
}

module.exports = {
  fetchCheckFinancialData,
  determineRiskCategory,
  determineRecommendationWithBands,
  calculateAllocationLogic,
};
