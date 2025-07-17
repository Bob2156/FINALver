// api/fetchData.js
const axios = require("axios");

// ——— Helper logic from your Discord bot ———

function logDebug(msg){ console.debug("[DEBUG]", msg); }

function calculateAllocationLogic(isSpyAboveSma, isVolBelow14, isVolBelow24, isTreasuryFalling){
  if(isSpyAboveSma){
    if(isVolBelow14) return { category:"Risk On",  allocation:"100% UPRO…" };
    if(isVolBelow24) return { category:"Risk Mid", allocation:"100% SSO…" };
    return isTreasuryFalling
      ? { category:"Risk Alt", allocation:"25% UPRO + 75% ZROZ" }
      : { category:"Risk Off", allocation:"100% SPY" };
  } else {
    return isTreasuryFalling
      ? { category:"Risk Alt", allocation:"25% UPRO + 75% ZROZ" }
      : { category:"Risk Off", allocation:"100% SPY" };
  }
}

function determineRiskCategory(data){
  const spy = parseFloat(data.spy),
        sma = parseFloat(data.sma220),
        vol = parseFloat(data.volatility),
        tfalling = data.isTreasuryFalling;
  return calculateAllocationLogic(
    spy > sma, vol < 14, vol < 24, tfalling
  );
}

function determineRecommendationWithBands(data){
  const spy = parseFloat(data.spy),
        sma = parseFloat(data.sma220),
        vol = parseFloat(data.volatility),
        change = parseFloat(data.treasuryRateChange);

  // MFEA raw booleans
  const isSpyAbove = spy > sma,
        isVol14    = vol < 14,
        isVol24    = vol < 24;

  // band thresholds
  const smaBandPct   = 0.02,
        volBand      = 1.0,
        treasuryThresh = -0.001;

  const lowerSMA = sma*(1-smaBandPct),
        upperSMA = sma*(1+smaBandPct),
        lower14  = 14-volBand,
        upper14  = 14+volBand,
        lower24  = 24-volBand,
        upper24  = 24+volBand;

  const effSpy   = (spy>upperSMA) ? true : (spy<lowerSMA) ? false : isSpyAbove;
  const effVol14 = (vol<lower14) ? true : (vol>upper14) ? false : isVol14;
  const effVol24 = (vol<lower24) ? true : (vol>upper24) ? false : isVol24;
  const effTreas = change < treasuryThresh;

  logDebug(`Bands: SPY ${lowerSMA.toFixed(2)}–${upperSMA.toFixed(2)}, Vol14 ${lower14}-${upper14}, Vol24 ${lower24}-${upper24}, Treas <${treasuryThresh}`);

  const rec = calculateAllocationLogic(effSpy, effVol14, effVol24, effTreas);
  return {
    recommendedCategory: rec.category,
    recommendedAllocation: rec.allocation,
    bandInfo: { smaBandPct, volBand, treasuryThresh, effSpy, effVol14, effVol24, effTreas }
  };
}

// ——— Data‑fetchers ———

async function fetchCheckFinancialData(){
  // identical to your Discord bot version but also collect the last 220 days of price + constant‑SMA series
  const [spyResp, trxResp, volResp] = await Promise.all([
    axios.get("https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=220d"),
    axios.get("https://query1.finance.yahoo.com/v8/finance/chart/%5EIRX?interval=1d&range=50d"),
    axios.get("https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=40d")
  ]);

  // — SPY + SMA
  const sres = spyResp.data.chart.result[0];
  const priceArr = sres.indicators.adjclose[0].adjclose;
  const tsArr    = sres.timestamp;
  const valid = tsArr
    .map((t,i)=> typeof priceArr[i]==="number" ? { date:new Date(t*1000).toLocaleDateString("en-US"), price:priceArr[i] } : null)
    .filter(x=>x).slice(-220);

  const prices = valid.map(v=>v.price);
  const sma220 = prices.reduce((a,b)=>a+b,0)/prices.length;

  // — Treasury change
  const trx   = trxResp.data.chart.result[0];
  const rArr  = trx.indicators.quote[0].close;
  const idx   = rArr.length-1, oneMo = idx-21;
  const currT = rArr[idx], prevT = rArr[oneMo<0?0:oneMo];
  const delta = currT - prevT, isF = delta < -0.0001;

  // — Volatility (21‑day returns)
  const vres = volResp.data.chart.result[0].indicators.adjclose[0].adjclose.filter(x=>typeof x==="number");
  const ret = vres.slice(-22).map((p,i,a)=> i? p/a[i-1]-1 : null).filter(x=>x!=null);
  const mean = ret.reduce((s,r)=>s+r,0)/ret.length;
  const variance = ret.reduce((s,r)=>s+Math.pow(r-mean,2),0)/ret.length;
  const annVol   = Math.sqrt(variance)*Math.sqrt(252)*100;

  return {
    spy:             prices[prices.length-1].toFixed(2),
    sma220:          sma220.toFixed(2),
    spyStatus:       prices[prices.length-1] > sma220 ? "Over" : "Under",
    volatility:      annVol.toFixed(2),
    treasuryRate:    currT.toFixed(3),
    treasuryRateChange: delta.toFixed(4),
    isTreasuryFalling: isF,
    priceHistory:    valid,
    smaHistory:      valid.map(v=>({ date: v.date, sma: parseFloat(sma220.toFixed(2)) }))
  };
}

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
