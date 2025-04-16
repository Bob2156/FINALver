/**
 * Serverless function:  /api/mfea
 * ------------------------------------------------------------
 * Returns strict‑MFEA result, band‑recommendation result,
 * 220‑day SMA and price history (aligned & numeric) for charting.
 */
const axios = require("axios");

// ---------- helper : core allocation tree ----------
function alloc(isSpyAbove, isVolBelow14, isVolBelow24, isTreasFalling) {
  if (isSpyAbove) {
    if (isVolBelow14) return { cat: "Risk On",  alloc: "100% UPRO (3× SPY)" };
    if (isVolBelow24) return { cat: "Risk Mid", alloc: "100% SSO  (2× SPY)" };
    return isTreasFalling
      ? { cat: "Risk Alt", alloc: "25% UPRO + 75% ZROZ" }
      : { cat: "Risk Off", alloc: "100% SPY" };
  }
  return isTreasFalling
    ? { cat: "Risk Alt", alloc: "25% UPRO + 75% ZROZ" }
    : { cat: "Risk Off", alloc: "100% SPY" };
}

// ---------- strict MFEA ----------
function strictMFEA(d) {
  return alloc(
    +d.spy > +d.sma220,
    +d.volatility < 14,
    +d.volatility < 24,
    d.isTreasuryFalling
  );
}

// ---------- banded recommendation ----------
function bandRecommendation(d) {
  const spy = +d.spy, sma = +d.sma220, vol = +d.volatility, dT = +d.treasuryRateChange;

  // band thresholds
  const smaBand = 0.02;   // ±2 %
  const volBand = 1.0;    // ±1 %
  const dTband  = -0.001; // < ‑0.10 %

  // strict booleans
  const bSpy  = spy > sma;
  const b14   = vol < 14;
  const b24   = vol < 24;

  // effective (band‑aware) booleans
  const eSpy  = spy > sma*(1+smaBand) ? true  : spy < sma*(1-smaBand) ? false : bSpy;
  const e14   = vol < 14-volBand      ? true  : vol > 14+volBand      ? false : b14;
  const e24   = vol < 24-volBand      ? true  : vol > 24+volBand      ? false : b24;
  const eTres = dT < dTband;

  return {
    ...alloc(eSpy, e14, e24, eTres),
    bandInfo: { spyInBand: !eSpy && bSpy !== eSpy,
                volIn14Band: !e14 && b14 !== e14,
                volIn24Band: !e24 && b24 !== e24,
                tresInBand: !eTres && (dT >= dTband && dT < -0.0001)
    }
  };
}

// ---------- Yahoo fetch ----------
async function fetchData() {
  const [spyR, tresR] = await Promise.all([
    axios.get("https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=220d"),
    axios.get("https://query1.finance.yahoo.com/v8/finance/chart/%5EIRX?interval=1d&range=50d")
  ]);

  // --- SPY price + SMA
  const spyObj = spyR.data.chart.result[0];
  const rawPrices = spyObj.indicators.adjclose[0].adjclose;
  const rawTs     = spyObj.timestamp;

  // keep valid numeric prices only
  const valid = rawTs
    .map((t,i) => (typeof rawPrices[i] === "number" && !Number.isNaN(rawPrices[i]))
        ? { date: new Date(t*1000).toLocaleDateString("en-US"),
            price: +rawPrices[i].toFixed(2) }
        : null)
    .filter(Boolean);

  const last220 = valid.slice(-220);                 // <=220 points
  const sma220  = last220.reduce((s,x)=>s+x.price,0) / last220.length;

  // --- 3‑mo T‑bill rate change (21 trading days ~ 1 month)
  const tresArr = tresR.data.chart.result[0].indicators.quote[0].close;
  const dT      = tresArr[tresArr.length-1] - tresArr[tresArr.length-22];   // raw numeric
  const tresTrend = dT < -0.0001 ? `⬇️ ${Math.abs(dT).toFixed(3)}%`
                   : dT >  0.0001 ? `⬆️ +${dT.toFixed(3)}%`
                   : "↔️ No change";

  // --- 21‑day vol
  const returns = last220.slice(-22).map((x,i,a)=> i ? x.price/a[i-1].price - 1 : null).filter(Boolean);
  const mean    = returns.reduce((s,x)=>s+x,0) / returns.length;
  const variance= returns.reduce((s,x)=>s+Math.pow(x-mean,2),0)/returns.length;
  const annVol  = Math.sqrt(variance)*Math.sqrt(252)*100;

  return {
    spy: last220[last220.length-1].price.toFixed(2),
    sma220: sma220.toFixed(2),
    spyStatus: last220[last220.length-1].price > sma220 ? "Over" : "Under",
    volatility: annVol.toFixed(2),
    treasuryRate: tresArr[tresArr.length-1].toFixed(3),
    treasuryRateChange: dT.toFixed(4),
    isTreasuryFalling: dT < -0.0001,

    priceHistory: last220,
    smaHistory:   last220.map(x => ({ date: x.date, sma: +sma220.toFixed(2) })),
    treasuryTrend: tresTrend
  };
}

// ---------- handler ----------
module.exports = async (req, res) => {
  try {
    const d = await fetchData();
    const strict = strictMFEA(d);
    const rec    = bandRecommendation(d);

    res.json({
      ...d,
      mfeaCategory:        strict.cat,
      mfeaAllocation:      strict.alloc,
      recommendedCategory: rec.cat,
      recommendedAllocation: rec.alloc,
      bandInfluenceDescription: rec.bandInfo
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Server error" });
  }
};
