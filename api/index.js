"use strict";

/**
 * index.js — Single-file Discord Slash Command handler with MFEA and Ticker charting
 *
 * Key changes:
 * - `/ticker` command includes a "3 Years" option in the slash command choice,
 *   and fetches data from Yahoo Finance with the range "3y" & a 1-week interval.
 * - The returned chart uses QuickChart.io, embedded in a Discord message.
 */

const {
  InteractionResponseType,
  InteractionType,
  verifyKey,
} = require("discord-interactions");
const getRawBody = require("raw-body");
const axios = require("axios");

//-----------------------------//
//      COMMAND DEFINITIONS    //
//-----------------------------//

// 1) /hi
const HI_COMMAND = {
  name: "hi",
  description: "Say hello!",
};

// 2) /check
const CHECK_COMMAND = {
  name: "check",
  description: "Display MFEA analysis status (Strict & Recommended).",
};

// 3) /ticker
const TICKER_COMMAND = {
  name: "ticker",
  description: "Fetch and display financial data for a specific ticker and timeframe.",
  options: [
    {
      name: "symbol",
      type: 3, // STRING
      description: "Stock ticker symbol (e.g., AAPL, GOOGL, NVDA)",
      required: true,
    },
    {
      name: "timeframe",
      type: 3, // STRING
      description: "The timeframe for the chart (1d, 1mo, 1y, 3y, 10y)",
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

//-----------------------------//
//     HELPER: LOGGING         //
//-----------------------------//
function logDebug(message) {
  console.log(`[DEBUG] ${message}`);
}

//-----------------------------//
//  HELPER: MFEA (Strict)      //
//-----------------------------//
// Original strict logic
function determineRiskCategory(data) {
  const spyValue = parseFloat(data.spy);
  const sma220Value = parseFloat(data.sma220);
  const volatilityValue = parseFloat(data.volatility);

  logDebug(
    `Strict MFEA: SPY=${data.spy}, SMA220=${data.sma220}, Vol=${data.volatility}%, isTreasuryFalling=${data.isTreasuryFalling}`
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
    // SPY ≤ SMA
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

//-----------------------------//
//  HELPER: ALLOCATION LOGIC   //
//-----------------------------//
// Shared by both strict & recommended approaches
function calculateAllocationLogic(
  isSpyAboveSma,
  isVolBelow14,
  isVolBelow24,
  isTreasuryFalling
) {
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
    // SPY ≤ SMA
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

//-----------------------------//
//  HELPER: RECOMMENDATIONS    //
//-----------------------------//
function determineRecommendationWithBands(data) {
  const spy = parseFloat(data.spy);
  const sma220 = parseFloat(data.sma220);
  const volatility = parseFloat(data.volatility);
  const treasuryChange = parseFloat(data.treasuryRateChange);

  // Strict states for fallback
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

  // Effective states
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

  logDebug(
    `Rec w/Bands => SPY=${spy}, SMA220=${sma220}, vol=${volatility}, trChange=${treasuryChange}`
  );

  const recommendedResult = calculateAllocationLogic(
    isSpyEffectivelyAboveSmaRec,
    isVolEffectivelyBelow14Rec,
    isVolEffectivelyBelow24Rec,
    isTreasuryFallingRec
  );

  const bandInfo = {
    spyValue: spy.toFixed(2),
    smaValue: sma220.toFixed(2),
    isSpyInSmaBand: spy >= smaLowerBand && spy <= smaUpperBand,
    volValue: volatility.toFixed(2),
    isVolIn14Band: volatility >= vol14LowerBand && volatility <= vol14UpperBand,
    isVolIn24Band: volatility >= vol24LowerBand && volatility <= vol24UpperBand,
    trsChange: treasuryChange.toFixed(4),
    trsRecThreshold: treasuryRecThreshold,
    isTreasuryInBand:
      treasuryChange >= treasuryRecThreshold && treasuryChange < -0.0001,
  };

  return {
    recommendedCategory: recommendedResult.category,
    recommendedAllocation: recommendedResult.allocation,
    bandInfo,
  };
}

//---------------------------------------//
//   FETCH /check (MFEA) Financial Data  //
//---------------------------------------//
async function fetchCheckFinancialData() {
  try {
    logDebug("Fetching /check data...");
    const [spySMAResponse, treasuryResponse, spyVolResponse] = await Promise.all([
      axios.get("https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=220d"),
      axios.get("https://query1.finance.yahoo.com/v8/finance/chart/%5EIRX?interval=1d&range=50d"),
      axios.get("https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=40d"),
    ]);

    //--- SPY & 220-day SMA
    const spyData = spySMAResponse.data;
    if (
      !spyData.chart?.result?.[0]?.meta?.regularMarketPrice ||
      !spyData.chart?.result?.[0]?.indicators?.adjclose?.[0]?.adjclose
    ) {
      throw new Error("Invalid SPY data for SMA.");
    }
    const spyPrice = spyData.chart.result[0].meta.regularMarketPrice;
    const spyAdjClose = spyData.chart.result[0].indicators.adjclose[0].adjclose;
    if (!spyAdjClose || spyAdjClose.length < 220) {
      throw new Error("Not enough data for 220-day SMA.");
    }
    const validSpyPrices = spyAdjClose
      .slice(-220)
      .filter((p) => typeof p === "number" && p !== null && p > 0);
    const sum220 = validSpyPrices.reduce((acc, val) => acc + val, 0);
    const sma220 = sum220 / validSpyPrices.length;
    const spyStatus = spyPrice > sma220 ? "Over" : "Under";

    //--- Treasury data
    const treasuryData = treasuryResponse.data.chart.result[0];
    const treasuryRatesRaw = treasuryData.indicators.quote[0].close;
    const treasuryTimestampsRaw = treasuryData.timestamp;
    const validTreasuryData = treasuryTimestampsRaw
      .map((ts, i) => ({ timestamp: ts, rate: treasuryRatesRaw[i] }))
      .filter((x) => x.timestamp && typeof x.rate === "number")
      .sort((a, b) => a.timestamp - b.timestamp);

    if (validTreasuryData.length < 22) {
      throw new Error("Not enough Treasury data points (need 22).");
    }
    const lastIndex = validTreasuryData.length - 1;
    const currentTR = validTreasuryData[lastIndex].rate;
    const monthAgoTR = validTreasuryData[lastIndex - 21].rate;
    const treasuryRateChangeValue = currentTR - monthAgoTR;
    const isTreasuryFallingStrict = treasuryRateChangeValue < -0.0001;

    //--- Vol (21 daily returns)
    const spyVolData = spyVolResponse.data;
    const spyVolAdjClose =
      spyVolData.chart.result[0].indicators.adjclose[0].adjclose;
    const validVol = spyVolAdjClose.filter(
      (p) => typeof p === "number" && p !== null && p > 0
    );
    if (validVol.length < 22) {
      throw new Error("Not enough data for volatility (need 22 prices).");
    }

    const relevantVolPrices = validVol.slice(-22);
    const returns = relevantVolPrices.slice(1).map((price, idx) => {
      const prev = relevantVolPrices[idx];
      return prev === 0 ? 0 : price / prev - 1;
    });
    const mean = returns.reduce((acc, r) => acc + r, 0) / returns.length;
    const variance = returns.reduce((acc, r) => acc + (r - mean) ** 2, 0) / returns.length;
    const dailyVol = Math.sqrt(variance);
    const annualVol = dailyVol * Math.sqrt(252) * 100;

    return {
      spy: spyPrice.toFixed(2),
      sma220: sma220.toFixed(2),
      spyStatus,
      volatility: annualVol.toFixed(2),
      treasuryRate: currentTR.toFixed(3),
      isTreasuryFalling: isTreasuryFallingStrict,
      treasuryRateChange: treasuryRateChangeValue.toFixed(4),
    };
  } catch (err) {
    console.error(err);
    throw new Error("Failed to fetch financial data");
  }
}

//---------------------------------------//
//  FETCH /ticker Financial Data         //
//---------------------------------------//
async function fetchTickerFinancialData(ticker, range) {
  try {
    // Allowed ranges for Yahoo
    const rangeOptions = {
      "1d": { range: "1d", interval: "1m" },
      "1mo": { range: "1mo", interval: "5m" },
      "1y": { range: "1y", interval: "1d" },
      "3y": { range: "3y", interval: "1wk" },
      "10y": { range: "10y", interval: "1mo" },
    };

    const selectedRange = rangeOptions[range] ? range : "1d";
    const { range: yahooRange, interval } = rangeOptions[selectedRange];

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      ticker
    )}?interval=${interval}&range=${yahooRange}`;

    const resp = await axios.get(url);
    const data = resp.data;
    if (
      !data.chart.result ||
      data.chart.result.length === 0 ||
      data.chart.result[0].meta?.regularMarketPrice === undefined
    ) {
      // If there's an error message from Yahoo
      if (data.chart?.error?.description) {
        throw new Error(`Yahoo Finance error: ${data.chart.error.description}`);
      }
      throw new Error("Invalid ticker symbol or data unavailable.");
    }

    const currentPrice = parseFloat(
      data.chart.result[0].meta.regularMarketPrice
    ).toFixed(2);
    const timestamps = data.chart.result[0].timestamp;

    let prices = [];
    if (data.chart.result[0].indicators?.adjclose?.[0]?.adjclose) {
      prices = data.chart.result[0].indicators.adjclose[0].adjclose;
    } else if (data.chart.result[0].indicators?.quote?.[0]?.close) {
      prices = data.chart.result[0].indicators.quote[0].close;
    } else {
      throw new Error("Price data is unavailable.");
    }

    if (!timestamps || !prices || timestamps.length !== prices.length) {
      throw new Error("Incomplete historical data.");
    }

    const validEntries = timestamps
      .map((ts, i) => ({ timestamp: ts, price: prices[i] }))
      .filter((e) => e.timestamp && typeof e.price === "number");

    // Format data for chart
    const historicalData = validEntries.map((entry) => {
      const dateObj = new Date(entry.timestamp * 1000);
      const opts = { timeZone: "America/New_York" };
      let dateLabel = "";

      if (selectedRange === "1d") {
        opts.hour = "2-digit";
        opts.minute = "2-digit";
        opts.hour12 = true;
        dateLabel = dateObj.toLocaleString("en-US", opts);
      } else if (selectedRange === "1mo") {
        opts.month = "short";
        opts.day = "numeric";
        opts.hour = "2-digit";
        opts.minute = "2-digit";
        opts.hour12 = true;
        dateLabel = dateObj.toLocaleString("en-US", opts);
      } else {
        opts.month = "short";
        opts.day = "numeric";
        opts.year = "numeric";
        dateLabel = dateObj.toLocaleDateString("en-US", opts);
      }

      return { date: dateLabel, price: entry.price };
    });

    // For 10y, aggregate monthly
    let finalData = historicalData;
    if (selectedRange === "10y" && validEntries.length > 0) {
      logDebug("Aggregating 10y data monthly...");
      const monthlyMap = {};
      validEntries.forEach((entry) => {
        const dObj = new Date(entry.timestamp * 1000);
        const key = `${dObj.getFullYear()}-${String(dObj.getMonth() + 1).padStart(2, "0")}`;
        if (!monthlyMap[key]) {
          const label = dObj.toLocaleDateString("en-US", {
            month: "short",
            year: "numeric",
            timeZone: "America/New_York",
          });
          monthlyMap[key] = { sum: 0, count: 0, label };
        }
        monthlyMap[key].sum += entry.price;
        monthlyMap[key].count += 1;
      });

      finalData = Object.keys(monthlyMap)
        .sort()
        .map((k) => {
          const avg = monthlyMap[k].sum / monthlyMap[k].count;
          return { date: monthlyMap[k].label, price: avg.toFixed(2) };
        });
    }

    return {
      ticker: ticker.toUpperCase(),
      currentPrice: `$${currentPrice}`,
      historicalData: finalData.map((d) => ({ ...d, price: String(d.price) })),
      selectedRange: selectedRange.toUpperCase(),
    };
  } catch (err) {
    console.error("Error fetching /ticker:", err);
    throw new Error(err.response?.data?.chart?.error?.description || "Failed to fetch data.");
  }
}

//-----------------------------//
//       MAIN HANDLER          //
//-----------------------------//
module.exports = async (req, res) => {
  logDebug("Incoming request.");

  // Must be POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  // Signature checking
  const signature = req.headers["x-signature-ed25519"];
  const timestamp = req.headers["x-signature-timestamp"];
  if (!signature || !timestamp) {
    return res.status(401).json({ error: "Missing signature headers" });
  }

  let rawBody;
  try {
    rawBody = await getRawBody(req, { encoding: "utf-8" });
  } catch (e) {
    console.error("Failed to get raw body:", e);
    return res.status(400).json({ error: "Invalid request body" });
  }

  let message;
  try {
    message = JSON.parse(rawBody);
  } catch (e) {
    console.error("Failed to parse JSON:", e);
    return res.status(400).json({ error: "Invalid JSON" });
  }

  if (!process.env.PUBLIC_KEY) {
    console.error("PUBLIC_KEY not set in env");
    return res.status(500).json({ error: "Server configuration error" });
  }

  const isValidRequest = verifyKey(rawBody, signature, timestamp, process.env.PUBLIC_KEY);
  if (!isValidRequest) {
    console.error("Invalid request signature");
    return res.status(401).json({ error: "Bad request signature" });
  }

  // Handle Discord Interaction
  if (message.type === InteractionType.PING) {
    logDebug("PING -> PONG");
    return res.status(200).json({ type: InteractionResponseType.PONG });
  }

  if (message.type === InteractionType.APPLICATION_COMMAND) {
    const commandName = message.data.name.toLowerCase();
    logDebug(`Command: ${commandName}`);

    switch (commandName) {
      //----------------------------------
      // /hi
      //----------------------------------
      case HI_COMMAND.name:
        return res.status(200).json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: "hii <3" },
        });

      //----------------------------------
      // /check
      //----------------------------------
      case CHECK_COMMAND.name:
        try {
          logDebug("Handling /check");
          const financialData = await fetchCheckFinancialData();

          // Strict result
          const { category: mfeaCategory, allocation: mfeaAllocation } =
            determineRiskCategory(financialData);

          // Recommendation
          const {
            recommendedCategory,
            recommendedAllocation,
            bandInfo,
          } = determineRecommendationWithBands(financialData);

          // Format treasury trend
          let treasuryRateTrendValue = "";
          const changeNum = parseFloat(financialData.treasuryRateChange);
          if (changeNum > 0.0001) {
            treasuryRateTrendValue = `⬆️ Increasing by ${Math.abs(changeNum).toFixed(3)}% since last 21 trading days`;
          } else if (changeNum < -0.0001) {
            treasuryRateTrendValue = `⬇️ ${Math.abs(changeNum).toFixed(3)}% since last 21 trading days`;
          } else {
            treasuryRateTrendValue = `↔️ No change since last 21 trading days`;
          }

          // Band influences
          const recommendationDiffers = mfeaAllocation !== recommendedAllocation;
          let influences = [];
          if (bandInfo.isSpyInSmaBand) influences.push("SPY within ±2% SMA");
          if (bandInfo.isVolIn14Band) influences.push("Vol within 13-15%");
          else if (bandInfo.isVolIn24Band) influences.push("Vol within 23-25%");
          if (bandInfo.isTreasuryInBand) {
            influences.push("Treasury in partial band zone");
          }

          let bandInfluenceDescription = "";
          if (!recommendationDiffers) {
            if (influences.length > 0) {
              bandInfluenceDescription = `Factors within bands: ${influences.join("; ")}. Recommendation aligns.`;
            } else {
              bandInfluenceDescription = "All factors outside bands. Recommendation aligns.";
            }
          } else {
            bandInfluenceDescription = `Recommendation differs. Influences: ${influences.join("; ")}.`;
          }
          bandInfluenceDescription += "\n*Bands: ±2% SMA, ±1% Vol, <-0.1% Treas*";

          return res.status(200).json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              embeds: [
                {
                  title: "MFEA Analysis Status & Recommendation",
                  color: 3447003,
                  fields: [
                    { name: "SPY Price", value: `$${financialData.spy}`, inline: true },
                    { name: "220-day SMA", value: `$${financialData.sma220}`, inline: true },
                    {
                      name: "SPY Status",
                      value: `${financialData.spyStatus} the 220-day SMA`,
                      inline: true,
                    },
                    {
                      name: "Volatility (Ann.)",
                      value: `${financialData.volatility}%`,
                      inline: true,
                    },
                    {
                      name: "3-Mo Treasury Rate",
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
                      name: "⚙️ Band Influence",
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
            },
          });
        } catch (error) {
          console.error(error);
          return res.status(500).json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: `⚠️ Unable to retrieve financial data: ${error.message || "Unknown error"}`,
            },
          });
        }

      //----------------------------------
      // /ticker
      //----------------------------------
      case TICKER_COMMAND.name:
        try {
          logDebug("Handling /ticker");
          const options = message.data.options;
          const symbolOpt = options.find((o) => o.name === "symbol");
          const timeframeOpt = options.find((o) => o.name === "timeframe");

          if (!symbolOpt) {
            return res.status(400).json({
              type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
              data: { content: "❌ No ticker symbol provided." },
            });
          }

          const ticker = symbolOpt.value;
          const timeframe = timeframeOpt ? timeframeOpt.value : "1d";

          const tickerData = await fetchTickerFinancialData(ticker, timeframe);

          // Build QuickChart config
          const chartConfig = {
            type: "line",
            data: {
              labels: tickerData.historicalData.map((e) => e.date),
              datasets: [
                {
                  label: `${tickerData.ticker} Price`,
                  data: tickerData.historicalData.map((e) => e.price),
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
                  title: {
                    display: true,
                    text: "Date",
                    color: "#333",
                    font: { size: 14 },
                  },
                  ticks: { maxTicksLimit: 10, color: "#333" },
                  grid: { display: false },
                },
                y: {
                  title: {
                    display: true,
                    text: "Price ($)",
                    color: "#333",
                    font: { size: 14 },
                  },
                  ticks: { color: "#333" },
                  grid: { color: "rgba(0,0,0,0.1)", borderDash: [5, 5] },
                },
              },
              plugins: {
                legend: {
                  display: true,
                  labels: { color: "#333", font: { size: 12 } },
                },
                tooltip: {
                  enabled: true,
                  mode: "index",
                  intersect: false,
                  callbacks: {
                    label: function (context) {
                      const val = parseFloat(context.parsed.y);
                      return isNaN(val) ? "N/A" : `$${val.toFixed(2)}`;
                    },
                  },
                },
              },
            },
          };
          const encodedConfig = encodeURIComponent(JSON.stringify(chartConfig));
          const chartUrl = `https://quickchart.io/chart?c=${encodedConfig}&w=600&h=400&bkg=%23ffffff`;

          const embed = {
            title: `${tickerData.ticker} Financial Data`,
            color: 3447003,
            fields: [
              { name: "Current Price", value: tickerData.currentPrice, inline: true },
              { name: "Timeframe", value: timeframe.toUpperCase(), inline: true },
              { name: "Selected Range", value: tickerData.selectedRange, inline: true },
              { name: "Data Source", value: "Yahoo Finance", inline: true },
            ],
            image: { url: chartUrl },
            footer: { text: "Data fetched from Yahoo Finance" },
            timestamp: new Date().toISOString(),
          };

          return res.status(200).json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { embeds: [embed] },
          });
        } catch (error) {
          console.error(error);
          return res.status(500).json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content:
                "⚠️ Unable to retrieve financial data at this time. Check the ticker and try again.",
            },
          });
        }

      //----------------------------------
      // Unknown command
      //----------------------------------
      default:
        console.error("Unknown command");
        return res.status(400).json({ error: "Unknown Command" });
    }
  } else {
    // Not a command or not recognized
    console.error("Unknown Interaction Type");
    return res.status(400).json({ error: "Unknown Type" });
  }
};
