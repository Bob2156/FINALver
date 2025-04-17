"use strict";

const { 
  InteractionResponseType,
  InteractionType,
  verifyKey,
} = require("discord-interactions");
const getRawBody = require("raw-body");
const axios = require("axios");

//========================//
//     Command Config     //
//========================//

// /hi
const HI_COMMAND = {
  name: "hi",
  description: "Say hello!",
};

// /check
const CHECK_COMMAND = {
  name: "check",
  description: "Display MFEA analysis status (Strict & Recommended).",
};

// /ticker
const TICKER_COMMAND = {
  name: "ticker",
  description: "Fetch and display financial data for a specific ticker and timeframe.",
  options: [
    {
      name: "symbol",
      type: 3, // STRING
      description: "The stock ticker symbol (e.g., AAPL, GOOGL)",
      required: true,
    },
    {
      name: "timeframe",
      type: 3, // STRING
      description: "The timeframe (1d, 1mo, 1y, 3y, 10y)",
      required: true,
      choices: [
        { name: "1 Day", value: "1d" },
        { name: "1 Month", value: "1mo" },
        { name: "1 Year", value: "1y" },
        { name: "3 Years", value: "3y" },
        { name: "10 Years", value: "10y" },
      ],
    },
  ],
};

//========================//
//    Utility Logging     //
//========================//
function logDebug(message) {
  console.log(`[DEBUG] ${message}`);
}

//============================================================//
// 1. Strict MFEA Calculation (unchanged from original logic) //
//============================================================//
function determineRiskCategory(data) {
  // data => { spy, sma220, volatility, isTreasuryFalling, ... }
  const spyValue = parseFloat(data.spy);
  const sma220Value = parseFloat(data.sma220);
  const volatilityValue = parseFloat(data.volatility);

  logDebug(
    `determineRiskCategory => SPY=${spyValue}, SMA220=${sma220Value}, Vol=${volatilityValue}, isTreasuryFalling=${data.isTreasuryFalling}`
  );

  if (spyValue > sma220Value) {
    if (volatilityValue < 14) {
      return {
        category: "Risk On",
        allocation: "100% UPRO (3× leveraged S&P 500) or 3×(100% SPY)",
      };
    } else if (volatilityValue < 24) {
      return {
        category: "Risk Mid",
        allocation: "100% SSO (2× S&P 500) or 2×(100% SPY)",
      };
    } else {
      if (data.isTreasuryFalling) {
        return {
          category: "Risk Alt",
          allocation:
            "25% UPRO + 75% ZROZ (long-duration zero-coupon bonds) or 1.5×(50% SPY + 50% ZROZ)",
        };
      } else {
        return {
          category: "Risk Off",
          allocation: "100% SPY or 1×(100% SPY)",
        };
      }
    }
  } else {
    // SPY <= SMA
    if (data.isTreasuryFalling) {
      return {
        category: "Risk Alt",
        allocation:
          "25% UPRO + 75% ZROZ (long-duration zero-coupon bonds) or 1.5×(50% SPY + 50% ZROZ)",
      };
    } else {
      return {
        category: "Risk Off",
        allocation: "100% SPY or 1×(100% SPY)",
      };
    }
  }
}

//==================================================//
// 2. Reusable Decision Tree for MFEA & Bands Logic //
//==================================================//
function calculateAllocationLogic(isSpyAboveSma, isVolBelow14, isVolBelow24, isTreasuryFalling) {
  // same as original
  if (isSpyAboveSma) {
    if (isVolBelow14) {
      return {
        category: "Risk On",
        allocation: "100% UPRO (3× leveraged S&P 500) or 3×(100% SPY)",
      };
    } else if (isVolBelow24) {
      return {
        category: "Risk Mid",
        allocation: "100% SSO (2× S&P 500) or 2×(100% SPY)",
      };
    } else {
      if (isTreasuryFalling) {
        return {
          category: "Risk Alt",
          allocation:
            "25% UPRO + 75% ZROZ (long-duration zero-coupon bonds) or 1.5×(50% SPY + 50% ZROZ)",
        };
      } else {
        return {
          category: "Risk Off",
          allocation: "100% SPY or 1×(100% SPY)",
        };
      }
    }
  } else {
    // SPY <= SMA
    if (isTreasuryFalling) {
      return {
        category: "Risk Alt",
        allocation:
          "25% UPRO + 75% ZROZ (long-duration zero-coupon bonds) or 1.5×(50% SPY + 50% ZROZ)",
      };
    } else {
      return {
        category: "Risk Off",
        allocation: "100% SPY or 1×(100% SPY)",
      };
    }
  }
}

//=================================================================//
// 3. Banded Recommendation (unchanged from earlier explanation)   //
//=================================================================//
function determineRecommendationWithBands(data) {
  // data => { spy, sma220, volatility, treasuryRateChange, ... }
  const spy = parseFloat(data.spy);
  const sma220 = parseFloat(data.sma220);
  const volatility = parseFloat(data.volatility);
  const treasuryChange = parseFloat(data.treasuryRateChange);

  // Strict states
  const isSpyAboveSmaMFEA = spy > sma220;
  const isVolBelow14MFEA = volatility < 14;
  const isVolBelow24MFEA = volatility < 24;

  // Banded thresholds
  const smaBandPercent = 0.02; // ±2%
  const volBandAbsolute = 1.0; // ±1%
  const treasuryRecThreshold = -0.001; // -0.1%

  const smaLowerBand = sma220 * (1 - smaBandPercent);
  const smaUpperBand = sma220 * (1 + smaBandPercent);
  const vol14LowerBand = 14 - volBandAbsolute;
  const vol14UpperBand = 14 + volBandAbsolute;
  const vol24LowerBand = 24 - volBandAbsolute;
  const vol24UpperBand = 24 + volBandAbsolute;

  // Determine “effective” states
  let isSpyEffectivelyAboveSmaRec =
    spy > smaUpperBand ? true : spy < smaLowerBand ? false : isSpyAboveSmaMFEA;
  let isVolEffectivelyBelow14Rec =
    volatility < vol14LowerBand
      ? true
      : volatility > vol14UpperBand
      ? false
      : isVolBelow14MFEA;
  let isVolEffectivelyBelow24Rec =
    volatility < vol24LowerBand
      ? true
      : volatility > vol24UpperBand
      ? false
      : isVolBelow24MFEA;

  const isTreasuryFallingRec = treasuryChange < treasuryRecThreshold;

  // Final recommended logic
  const recommendedResult = calculateAllocationLogic(
    isSpyEffectivelyAboveSmaRec,
    isVolEffectivelyBelow14Rec,
    isVolEffectivelyBelow24Rec,
    isTreasuryFallingRec
  );

  // Return plus “bandInfo” if needed
  return {
    recommendedCategory: recommendedResult.category,
    recommendedAllocation: recommendedResult.allocation,
    bandInfo: {
      isSpyInSmaBand: spy >= smaLowerBand && spy <= smaUpperBand,
      isVolIn14Band:
        volatility >= vol14LowerBand && volatility <= vol14UpperBand,
      isVolIn24Band:
        volatility >= vol24LowerBand && volatility <= vol24UpperBand,
      trsChange: treasuryChange,
      trsRecThreshold: treasuryRecThreshold,
    },
  };
}

//=====================================================//
// 4. Data Fetch for /check: SPY, Treasury, Vol, etc.  //
//=====================================================//
async function fetchCheckFinancialData() {
  // 3 parallel calls
  const [spyResp, treasuryResp, volResp] = await Promise.all([
    axios.get("https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=220d"),
    axios.get("https://query1.finance.yahoo.com/v8/finance/chart/%5EIRX?interval=1d&range=50d"),
    axios.get("https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=40d"),
  ]);

  // --- SPY Price & 220-day SMA
  const spyData = spyResp.data.chart.result[0];
  const spyPrice = spyData.meta.regularMarketPrice;
  const adjClose = spyData.indicators.adjclose[0].adjclose;
  if (!adjClose || adjClose.length < 220) {
    throw new Error("Not enough data for 220-day SMA");
  }
  const last220 = adjClose.slice(-220).filter((p) => typeof p === "number" && p > 0);
  const sma220 = last220.reduce((acc, val) => acc + val, 0) / last220.length;
  const spyStatus = spyPrice > sma220 ? "Over" : "Under";

  // --- Treasury
  const tData = treasuryResp.data.chart.result[0];
  const tRates = tData.indicators.quote[0].close;
  const tTimes = tData.timestamp;
  const validT = tTimes
    .map((ts, i) => ({ ts, rate: tRates[i] }))
    .filter((x) => x.ts && typeof x.rate === "number")
    .sort((a, b) => a.ts - b.ts);
  if (validT.length < 22) throw new Error("Not enough Treasury points");
  const lastIndex = validT.length - 1;
  const currentTR = validT[lastIndex].rate;
  const monthAgoTR = validT[lastIndex - 21].rate;
  const treasuryRateChange = currentTR - monthAgoTR;
  const isTreasuryFalling = treasuryRateChange < -0.0001;

  // --- Vol (21 daily returns)
  const volData = volResp.data.chart.result[0];
  const volPrices = volData.indicators.adjclose[0].adjclose.filter(
    (p) => typeof p === "number"
  );
  if (volPrices.length < 22) throw new Error("Not enough data for volatility");
  const last22 = volPrices.slice(-22);
  const dailyReturns = last22.slice(1).map((price, idx) => {
    const prev = last22[idx];
    return prev === 0 ? 0 : price / prev - 1;
  });
  const meanRet = dailyReturns.reduce((acc, r) => acc + r, 0) / dailyReturns.length;
  const variance =
    dailyReturns.reduce((acc, r) => acc + (r - meanRet) ** 2, 0) / dailyReturns.length;
  const dailyVol = Math.sqrt(variance);
  const annualVol = dailyVol * Math.sqrt(252) * 100;

  return {
    spy: spyPrice.toFixed(2),
    sma220: sma220.toFixed(2),
    spyStatus,
    volatility: annualVol.toFixed(2),
    treasuryRate: currentTR.toFixed(3),
    treasuryRateChange: treasuryRateChange.toFixed(4),
    isTreasuryFalling,
  };
}

//==================================================//
// 5. Data Fetch for /ticker: Historical Price Data //
//==================================================//
async function fetchTickerFinancialData(symbol, timeframe) {
  const rangeMap = {
    "1d": { range: "1d", interval: "1m" },
    "1mo": { range: "1mo", interval: "5m" },
    "1y": { range: "1y", interval: "1d" },
    "3y": { range: "3y", interval: "1wk" },
    "10y": { range: "10y", interval: "1mo" },
  };
  const chosen = rangeMap[timeframe] || rangeMap["1d"];
  const { range, interval } = chosen;

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?interval=${interval}&range=${range}`;

  const resp = await axios.get(url);
  const d = resp.data;
  if (!d.chart.result || d.chart.result.length === 0) {
    if (d.chart.error?.description) throw new Error(d.chart.error.description);
    throw new Error("Invalid ticker or data not available");
  }

  const meta = d.chart.result[0].meta;
  const priceNow = parseFloat(meta.regularMarketPrice).toFixed(2);

  let timeStamps = d.chart.result[0].timestamp;
  let rawPrices;
  if (d.chart.result[0].indicators?.adjclose?.[0]?.adjclose) {
    rawPrices = d.chart.result[0].indicators.adjclose[0].adjclose;
  } else if (d.chart.result[0].indicators?.quote?.[0]?.close) {
    rawPrices = d.chart.result[0].indicators.quote[0].close;
  } else {
    throw new Error("No valid price data found");
  }

  if (!timeStamps || !rawPrices || timeStamps.length !== rawPrices.length) {
    throw new Error("Incomplete historical data");
  }

  // Build array
  const validEntries = timeStamps
    .map((ts, i) => ({ ts, price: rawPrices[i] }))
    .filter((x) => x.ts && typeof x.price === "number");

  // Convert to date strings
  let historicalData = validEntries.map((entry) => {
    const dt = new Date(entry.ts * 1000);
    if (timeframe === "1d") {
      return {
        date: dt.toLocaleTimeString("en-US", {
          hour12: true,
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "America/New_York",
        }),
        price: entry.price.toFixed(2),
      };
    } else if (timeframe === "1mo") {
      return {
        date: dt.toLocaleString("en-US", {
          month: "short",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: true,
          timeZone: "America/New_York",
        }),
        price: entry.price.toFixed(2),
      };
    } else {
      // 1y, 3y, 10y
      return {
        date: dt.toLocaleDateString("en-US", {
          month: "short",
          day: "2-digit",
          year: "numeric",
          timeZone: "America/New_York",
        }),
        price: entry.price.toFixed(2),
      };
    }
  });

  // For 10y → monthly average
  if (timeframe === "10y") {
    const monthlyMap = {};
    validEntries.forEach((v) => {
      const dt = new Date(v.ts * 1000);
      const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;
      if (!monthlyMap[key]) {
        monthlyMap[key] = {
          sum: 0,
          count: 0,
          label: dt.toLocaleDateString("en-US", {
            month: "short",
            year: "numeric",
            timeZone: "America/New_York",
          }),
        };
      }
      monthlyMap[key].sum += v.price;
      monthlyMap[key].count += 1;
    });
    historicalData = Object.keys(monthlyMap)
      .sort()
      .map((k) => {
        const avg = monthlyMap[k].sum / monthlyMap[k].count;
        return {
          date: monthlyMap[k].label,
          price: avg.toFixed(2),
        };
      });
  }

  return {
    ticker: symbol.toUpperCase(),
    currentPrice: `$${priceNow}`,
    historicalData,
    selectedRange: timeframe.toUpperCase(),
  };
}

//=================================================//
// 6. The Main Handler (with Deferred Responses)   //
//=================================================//
module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const signature = req.headers["x-signature-ed25519"];
  const timestamp = req.headers["x-signature-timestamp"];
  if (!signature || !timestamp) {
    return res.status(401).json({ error: "Missing signature headers" });
  }

  let rawBody;
  try {
    rawBody = await getRawBody(req, { encoding: "utf-8" });
  } catch (error) {
    return res.status(400).json({ error: "Invalid request body" });
  }

  let message;
  try {
    message = JSON.parse(rawBody);
  } catch (error) {
    return res.status(400).json({ error: "Invalid JSON format" });
  }

  if (!process.env.PUBLIC_KEY) {
    console.error("PUBLIC_KEY not set");
    return res.status(500).json({ error: "Server config error" });
  }

  // Validate request
  const isValid = verifyKey(rawBody, signature, timestamp, process.env.PUBLIC_KEY);
  if (!isValid) {
    console.error("Invalid request signature");
    return res.status(401).json({ error: "Bad request signature" });
  }

  // Handle interactions
  if (message.type === InteractionType.PING) {
    // Quick respond with Pong
    return res.status(200).json({ type: InteractionResponseType.PONG });
  }

  if (message.type === InteractionType.APPLICATION_COMMAND) {
    const commandName = message.data.name.toLowerCase();
    const { application_id, token } = message; // needed for follow-up

    switch (commandName) {
      //================
      // /hi - immediate
      //================
      case HI_COMMAND.name: {
        return res.status(200).json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: "hii <3" },
        });
      }

      //==================================
      // /check & /ticker - DEFER & follow
      //==================================
      case CHECK_COMMAND.name:
      case TICKER_COMMAND.name: {
        // Step 1: Defer
        res.status(200).json({
          type: 5, // InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
          data: {
            content: "Fetching data…",
          },
        });

        // Step 2: Async logic after deferral
        (async () => {
          try {
            let finalResponseBody = {};

            if (commandName === CHECK_COMMAND.name) {
              // =========== /check logic ===============
              const financialData = await fetchCheckFinancialData();

              // Strict MFEA
              const { category: mfeaCategory, allocation: mfeaAllocation } =
                determineRiskCategory(financialData);

              // Recommendation
              const {
                recommendedCategory,
                recommendedAllocation,
                bandInfo,
              } = determineRecommendationWithBands(financialData);

              // Format treasury trend text
              const changeNum = parseFloat(financialData.treasuryRateChange);
              let treasuryRateTrendValue = "↔️ No change since last 21 days";
              if (changeNum > 0.0001) {
                treasuryRateTrendValue = `⬆️ Increasing by ${Math.abs(changeNum).toFixed(
                  3
                )}% since last 21 days`;
              } else if (changeNum < -0.0001) {
                treasuryRateTrendValue = `⬇️ Decreasing by ${Math.abs(changeNum).toFixed(
                  3
                )}% since last 21 days`;
              }

              // Band influences
              const mfeaDiffers =
                mfeaAllocation !== recommendedAllocation;
              let influences = [];
              if (bandInfo.isSpyInSmaBand) influences.push("SPY within ±2% SMA");
              if (bandInfo.isVolIn14Band) influences.push("Vol within 13–15%");
              else if (bandInfo.isVolIn24Band) influences.push("Vol within 23–25%");
              // Treasury?
              const isTrInBand =
                bandInfo.trsChange >= bandInfo.trsRecThreshold && bandInfo.trsChange < -0.0001;
              if (isTrInBand) influences.push("Treasury in band range");

              let bandInfluenceDescription = "";
              if (!mfeaDiffers) {
                if (influences.length > 0) {
                  bandInfluenceDescription = `Factors within bands: ${influences.join("; ")}. Recommendation aligns.`;
                } else {
                  bandInfluenceDescription = "All factors outside bands. Recommendation aligns.";
                }
              } else {
                bandInfluenceDescription = `Recommendation differs. Influences: ${influences.join("; ")}.`;
              }
              bandInfluenceDescription += "\n*Bands: ±2% SMA, ±1% Vol, <-0.1% Treas*";

              // Build final embed
              finalResponseBody = {
                embeds: [
                  {
                    title: "MFEA Analysis Status & Recommendation",
                    color: 3447003,
                    fields: [
                      {
                        name: "SPY Price",
                        value: `$${financialData.spy}`,
                        inline: true,
                      },
                      {
                        name: "220-day SMA",
                        value: `$${financialData.sma220}`,
                        inline: true,
                      },
                      {
                        name: "SPY Status",
                        value: `${financialData.spyStatus} the 220-day SMA`,
                        inline: true,
                      },
                      {
                        name: "Volatility",
                        value: `${financialData.volatility}%`,
                        inline: true,
                      },
                      {
                        name: "3-Month Treasury Rate",
                        value: `${financialData.treasuryRate}%`,
                        inline: true,
                      },
                      {
                        name: "Treasury Rate Trend",
                        value: treasuryRateTrendValue,
                        inline: true,
                      },
                      {
                        name: "📊 MFEA Category",
                        value: mfeaCategory,
                        inline: false,
                      },
                      {
                        name: "📈 MFEA Allocation",
                        value: `**${mfeaAllocation}**`,
                        inline: false,
                      },
                      {
                        name: "💡 Recommended Allocation",
                        value: `**${recommendedAllocation}**`,
                        inline: false,
                      },
                      {
                        name: "⚙️ Band Influence Analysis",
                        value: bandInfluenceDescription,
                        inline: false,
                      },
                    ],
                    footer: {
                      text: "MFEA = Strict Model | Recommendation includes rebalancing bands",
                    },
                    timestamp: new Date().toISOString(),
                  },
                ],
              };
            } else {
              // =========== /ticker logic ===============
              const symbolOpt = message.data.options.find((o) => o.name === "symbol");
              const tfOpt = message.data.options.find((o) => o.name === "timeframe");
              const symbol = symbolOpt ? symbolOpt.value : null;
              const timeframe = tfOpt ? tfOpt.value : "1d";

              const tData = await fetchTickerFinancialData(symbol, timeframe);

              // Build QuickChart
              const chartConfig = {
                type: "line",
                data: {
                  labels: tData.historicalData.map((e) => e.date),
                  datasets: [
                    {
                      label: `${tData.ticker} Price`,
                      data: tData.historicalData.map((e) => e.price),
                      borderColor: "#0070f3",
                      backgroundColor: "rgba(0,112,243,0.1)",
                      borderWidth: 2,
                      pointRadius: 0,
                      fill: true,
                    },
                  ],
                },
                options: {
                  scales: {
                    x: {
                      title: { display: true, text: "Date", color: "#333" },
                      ticks: { color: "#333", maxTicksLimit: 10 },
                      grid: { display: false },
                    },
                    y: {
                      title: { display: true, text: "Price ($)", color: "#333" },
                      ticks: { color: "#333" },
                      grid: { color: "rgba(0,0,0,0.1)" },
                    },
                  },
                },
              };
              const chartUrl = `https://quickchart.io/chart?c=${encodeURIComponent(
                JSON.stringify(chartConfig)
              )}&w=600&h=400&bkg=%23ffffff`;

              finalResponseBody = {
                embeds: [
                  {
                    title: `${tData.ticker} Financial Data`,
                    color: 3447003,
                    fields: [
                      { name: "Current Price", value: tData.currentPrice, inline: true },
                      {
                        name: "Timeframe",
                        value: timeframe.toUpperCase(),
                        inline: true,
                      },
                      {
                        name: "Selected Range",
                        value: tData.selectedRange,
                        inline: true,
                      },
                      { name: "Data Source", value: "Yahoo Finance", inline: true },
                    ],
                    image: { url: chartUrl },
                    footer: { text: "Data fetched from Yahoo Finance" },
                    timestamp: new Date().toISOString(),
                  },
                ],
              };
            }

            // Step 3: PATCH the original deferred message
            if (!process.env.BOT_TOKEN) {
              console.error("BOT_TOKEN is missing. Cannot PATCH follow-up.");
              // Optionally just log an error or do something else
              return;
            }

            await axios.patch(
              `https://discord.com/api/v10/webhooks/${application_id}/${token}/messages/@original`,
              finalResponseBody,
              {
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bot ${process.env.BOT_TOKEN}`,
                },
              }
            );
          } catch (err) {
            console.error("Error after deferral:", err);
            // Attempt to update with an error message
            if (process.env.BOT_TOKEN) {
              await axios.patch(
                `https://discord.com/api/v10/webhooks/${application_id}/${token}/messages/@original`,
                {
                  content: "⚠️ Failed to fetch data. Please try again.",
                },
                {
                  headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bot ${process.env.BOT_TOKEN}`,
                  },
                }
              );
            }
          }
        })();

        // We’ve sent a DEFERRED response—stop here
        return;
      }

      //================
      // Unknown Command
      //================
      default:
        return res.status(400).json({ error: "Unknown Command" });
    }
  } else {
    // Not an APPLICATION_COMMAND
    return res.status(400).json({ error: "Unknown Interaction Type" });
  }
};
