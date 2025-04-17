"use strict";

const {
  InteractionType,
  InteractionResponseType,
  verifyKey,
} = require("discord-interactions");
const axios = require("axios");
const getRawBody = require("raw-body");

//-----------------------------//
//      Constants & Commands   //
//-----------------------------//

// /hi
const HI_COMMAND = { name: "hi", description: "Say hello!" };

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
      description: "Stock ticker symbol (e.g., AAPL, GOOGL, NVDA)",
      required: true,
    },
    {
      name: "timeframe",
      type: 3, // STRING
      description: "Timeframe (1d, 1mo, 1y, 3y, 10y)",
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

function logDebug(msg) {
  console.log(`[DEBUG] ${msg}`);
}

//-----------------------------//
//   1) MFEA “Strict” Logic    //
//-----------------------------//
function determineRiskCategory(data) {
  const spyValue = parseFloat(data.spy);
  const smaValue = parseFloat(data.sma220);
  const volValue = parseFloat(data.volatility);

  if (spyValue > smaValue) {
    if (volValue < 14) {
      return {
        category: "Risk On",
        allocation: "100% UPRO (3× S&P 500) or 3×(100% SPY)",
      };
    } else if (volValue < 24) {
      return {
        category: "Risk Mid",
        allocation: "100% SSO (2× S&P 500) or 2×(100% SPY)",
      };
    } else {
      if (data.isTreasuryFalling) {
        return {
          category: "Risk Alt",
          allocation:
            "25% UPRO + 75% ZROZ or 1.5×(50% SPY + 50% ZROZ)",
        };
      } else {
        return {
          category: "Risk Off",
          allocation: "100% SPY",
        };
      }
    }
  } else {
    // spyValue <= smaValue
    if (data.isTreasuryFalling) {
      return {
        category: "Risk Alt",
        allocation:
          "25% UPRO + 75% ZROZ or 1.5×(50% SPY + 50% ZROZ)",
      };
    } else {
      return {
        category: "Risk Off",
        allocation: "100% SPY",
      };
    }
  }
}

//-----------------------------//
//   2) Shared Decision Tree   //
//-----------------------------//
function calculateAllocationLogic(isAbove, isVolBelow14, isVolBelow24, isTreasuryFalling) {
  if (isAbove) {
    if (isVolBelow14) {
      return { category: "Risk On", allocation: "100% UPRO (3×) or 3× SPY" };
    } else if (isVolBelow24) {
      return { category: "Risk Mid", allocation: "100% SSO (2×) or 2× SPY" };
    } else {
      return isTreasuryFalling
        ? {
            category: "Risk Alt",
            allocation: "25% UPRO + 75% ZROZ or 1.5×(50% SPY + 50% ZROZ)",
          }
        : { category: "Risk Off", allocation: "100% SPY" };
    }
  } else {
    // not above
    return isTreasuryFalling
      ? {
          category: "Risk Alt",
          allocation: "25% UPRO + 75% ZROZ or 1.5×(50% SPY + 50% ZROZ)",
        }
      : { category: "Risk Off", allocation: "100% SPY" };
  }
}

//-----------------------------//
// 3) Recommendation w/ Bands //
//-----------------------------//
function determineRecommendationWithBands(data) {
  const spyVal = parseFloat(data.spy);
  const smaVal = parseFloat(data.sma220);
  const volVal = parseFloat(data.volatility);
  const treasChg = parseFloat(data.treasuryRateChange);

  const isSpyAboveSmaStrict = spyVal > smaVal;
  const isVolBelow14Strict = volVal < 14;
  const isVolBelow24Strict = volVal < 24;

  // bands
  const smaBandPct = 0.02;
  const volBandAbs = 1;
  const treasThreshold = -0.001;

  const smaLower = smaVal * (1 - smaBandPct);
  const smaUpper = smaVal * (1 + smaBandPct);
  const vol14Lower = 14 - volBandAbs;
  const vol14Upper = 14 + volBandAbs;
  const vol24Lower = 24 - volBandAbs;
  const vol24Upper = 24 + volBandAbs;

  const isSpyAboveSmaRec =
    spyVal > smaUpper ? true : spyVal < smaLower ? false : isSpyAboveSmaStrict;
  const isVolBelow14Rec =
    volVal < vol14Lower ? true : volVal > vol14Upper ? false : isVolBelow14Strict;
  const isVolBelow24Rec =
    volVal < vol24Lower ? true : volVal > vol24Upper ? false : isVolBelow24Strict;

  const isTreasuryFallingRec = treasChg < treasThreshold;

  const recommended = calculateAllocationLogic(
    isSpyAboveSmaRec,
    isVolBelow14Rec,
    isVolBelow24Rec,
    isTreasuryFallingRec
  );

  return {
    recommendedCategory: recommended.category,
    recommendedAllocation: recommended.allocation,
    bandInfo: {
      spyVal,
      smaVal,
      volVal,
      treasChg,
    },
  };
}

//-----------------------------//
//  4) Data Fetch: /check      //
//-----------------------------//
async function fetchCheckFinancialData() {
  // We do the 3 axios calls:
  const [spySMAResp, treasuryResp, spyVolResp] = await Promise.all([
    axios.get("https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=220d"),
    axios.get("https://query1.finance.yahoo.com/v8/finance/chart/%5EIRX?interval=1d&range=50d"),
    axios.get("https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=40d"),
  ]);

  // SPY + 220d SMA
  const spyData = spySMAResp.data.chart.result[0];
  const spyPrice = spyData.meta.regularMarketPrice;
  const spyAdj = spyData.indicators.adjclose[0].adjclose;
  const validSpy = spyAdj.slice(-220).filter((x) => typeof x === "number" && x > 0);
  const sma220 = validSpy.reduce((acc, n) => acc + n, 0) / validSpy.length;
  const spyStatus = spyPrice > sma220 ? "Over" : "Under";

  // Treasury
  const tData = treasuryResp.data.chart.result[0];
  const tRates = tData.indicators.quote[0].close;
  const tTimes = tData.timestamp;
  const validTs = tTimes
    .map((ts, i) => ({ ts, rate: tRates[i] }))
    .filter((r) => r.ts && typeof r.rate === "number")
    .sort((a, b) => a.ts - b.ts);
  const lastIndex = validTs.length - 1;
  const currentTR = validTs[lastIndex].rate;
  const monthAgoTR = validTs[lastIndex - 21].rate; // 21 trading days
  const treasuryRateChange = currentTR - monthAgoTR;
  const isTreasuryFalling = treasuryRateChange < -0.0001;

  // SPY vol
  const volData = spyVolResp.data.chart.result[0];
  const volPrices = volData.indicators.adjclose[0].adjclose.filter((p) => typeof p === "number");
  const recent22 = volPrices.slice(-22);
  const returns = recent22.slice(1).map((price, i) => {
    const prev = recent22[i];
    return prev !== 0 ? price / prev - 1 : 0;
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
    treasuryRateChange: treasuryRateChange.toFixed(4),
    isTreasuryFalling,
  };
}

//-----------------------------//
//  5) Data Fetch: /ticker     //
//-----------------------------//
async function fetchTickerFinancialData(symbol, timeframe) {
  const rangeOptions = {
    "1d": { range: "1d", interval: "1m" },
    "1mo": { range: "1mo", interval: "5m" },
    "1y": { range: "1y", interval: "1d" },
    "3y": { range: "3y", interval: "1wk" },
    "10y": { range: "10y", interval: "1mo" },
  };
  const chosen = rangeOptions[timeframe] || rangeOptions["1d"];
  const { range, interval } = chosen;

  const resp = await axios.get(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      symbol
    )}?interval=${interval}&range=${range}`
  );
  const d = resp.data;
  if (!d.chart.result || !d.chart.result[0].meta?.regularMarketPrice) {
    if (d.chart.error?.description) throw new Error(d.chart.error.description);
    throw new Error("Invalid ticker or data unavailable.");
  }

  const meta = d.chart.result[0].meta;
  const price = parseFloat(meta.regularMarketPrice).toFixed(2);

  const timestamps = d.chart.result[0].timestamp;
  let rawPrices = [];
  if (d.chart.result[0].indicators?.adjclose?.[0]?.adjclose) {
    rawPrices = d.chart.result[0].indicators.adjclose[0].adjclose;
  } else if (d.chart.result[0].indicators?.quote?.[0]?.close) {
    rawPrices = d.chart.result[0].indicators.quote[0].close;
  } else {
    throw new Error("No prices found.");
  }

  const valid = timestamps
    .map((ts, i) => ({ ts, price: rawPrices[i] }))
    .filter((x) => x.ts && typeof x.price === "number");
  // Format into date
  const finalRange = timeframe.toUpperCase();

  let historicalData = valid.map((entry) => {
    const dateObj = new Date(entry.ts * 1000);
    // For simpler code, just pick a date format
    if (timeframe === "1d") {
      return {
        date: dateObj.toLocaleTimeString("en-US", {
          timeZone: "America/New_York",
          hour12: true,
          hour: "2-digit",
          minute: "2-digit",
        }),
        price: entry.price.toFixed(2),
      };
    } else if (timeframe === "1mo") {
      return {
        date: dateObj.toLocaleString("en-US", {
          timeZone: "America/New_York",
          month: "short",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: true,
        }),
        price: entry.price.toFixed(2),
      };
    } else {
      return {
        date: dateObj.toLocaleDateString("en-US", {
          timeZone: "America/New_York",
          month: "short",
          day: "2-digit",
          year: "numeric",
        }),
        price: entry.price.toFixed(2),
      };
    }
  });

  // For 10y, aggregate monthly
  if (timeframe === "10y") {
    // do monthly aggregation
    const monthlyMap = {};
    valid.forEach((x) => {
      const dt = new Date(x.ts * 1000);
      const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;
      if (!monthlyMap[key]) {
        monthlyMap[key] = { sum: 0, count: 0, label: dt.toLocaleDateString("en-US", {
          month: "short",
          year: "numeric",
        }) };
      }
      monthlyMap[key].sum += x.price;
      monthlyMap[key].count++;
    });
    historicalData = Object.keys(monthlyMap)
      .sort()
      .map((k) => {
        const avgPrice = monthlyMap[k].sum / monthlyMap[k].count;
        return { date: monthlyMap[k].label, price: avgPrice.toFixed(2) };
      });
  }

  return {
    ticker: symbol.toUpperCase(),
    currentPrice: `$${price}`,
    historicalData,
    selectedRange: finalRange,
  };
}

//-----------------------------//
//        DISCORD HANDLER      //
//-----------------------------//
module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  // Validate signature
  const signature = req.headers["x-signature-ed25519"];
  const timestamp = req.headers["x-signature-timestamp"];
  if (!signature || !timestamp) {
    return res.status(401).json({ error: "Missing signature headers" });
  }

  let rawBody;
  try {
    rawBody = await getRawBody(req, { encoding: "utf-8" });
  } catch (err) {
    return res.status(400).json({ error: "Invalid request body" });
  }

  let message;
  try {
    message = JSON.parse(rawBody);
  } catch (err) {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  if (!process.env.PUBLIC_KEY) {
    console.error("PUBLIC_KEY not set");
    return res.status(500).json({ error: "Server config error" });
  }

  const valid = verifyKey(rawBody, signature, timestamp, process.env.PUBLIC_KEY);
  if (!valid) {
    console.error("Bad request signature");
    return res.status(401).json({ error: "Bad request signature" });
  }

  // Discord interaction
  if (message.type === InteractionType.PING) {
    // Immediately respond
    return res.status(200).json({ type: InteractionResponseType.PONG });
  }

  // Handle slash commands
  if (message.type === InteractionType.APPLICATION_COMMAND) {
    const commandName = message.data.name.toLowerCase();
    const { application_id, token } = message; // for follow-up

    switch (commandName) {
      //------------------------------------
      //  /hi — quick response, no deferral
      //------------------------------------
      case HI_COMMAND.name: {
        return res.status(200).json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: "hii <3",
          },
        });
      }

      //------------------------------------
      //  /check or /ticker → DEFER first
      //------------------------------------
      case CHECK_COMMAND.name:
      case TICKER_COMMAND.name: {
        // 1) Immediately defer so we don't time out
        //    type 5 => DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
        res.status(200).json({
          type: 5, // InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
          data: {
            // You can set a preliminary "Working on it..." text if you want:
            content: "Fetching data…",
            // flags: 64, // if you wanted ephemeral
          },
        });

        // 2) Perform async logic AFTER sending the immediate response
        ;(async () => {
          try {
            let finalContent;
            if (commandName === CHECK_COMMAND.name) {
              // fetch MFEA data
              const financialData = await fetchCheckFinancialData();

              // strict
              const { category: mfeaCat, allocation: mfeaAlloc } =
                determineRiskCategory(financialData);

              // recommended
              const {
                recommendedCategory,
                recommendedAllocation,
              } = determineRecommendationWithBands(financialData);

              // Some display strings
              const changeNum = parseFloat(financialData.treasuryRateChange);
              let trsTrend = "↔️ No significant change";
              if (changeNum > 0.0001) {
                trsTrend = `⬆️ +${Math.abs(changeNum).toFixed(3)}%`;
              } else if (changeNum < -0.0001) {
                trsTrend = `⬇️ -${Math.abs(changeNum).toFixed(3)}%`;
              }

              finalContent = {
                embeds: [
                  {
                    title: "MFEA Analysis & Recommendation",
                    color: 3447003,
                    fields: [
                      { name: "SPY Price", value: `$${financialData.spy}`, inline: true },
                      { name: "220-day SMA", value: `$${financialData.sma220}`, inline: true },
                      { name: "SPY Status", value: financialData.spyStatus, inline: true },
                      {
                        name: "Volatility",
                        value: `${financialData.volatility}%`,
                        inline: true,
                      },
                      {
                        name: "Treasury Rate",
                        value: `${financialData.treasuryRate}%`,
                        inline: true,
                      },
                      { name: "Treasury Trend", value: trsTrend, inline: true },
                      {
                        name: "Strict MFEA",
                        value: `Category: ${mfeaCat}\nAllocation: **${mfeaAlloc}**`,
                        inline: false,
                      },
                      {
                        name: "Recommended",
                        value: `Category: ${recommendedCategory}\nAllocation: **${recommendedAllocation}**`,
                        inline: false,
                      },
                    ],
                    timestamp: new Date().toISOString(),
                    footer: {
                      text: "Strict vs. banded recommendation",
                    },
                  },
                ],
              };
            } else {
              // /ticker
              const symbol = message.data.options.find((o) => o.name === "symbol")?.value;
              const timeframe = message.data.options.find((o) => o.name === "timeframe")?.value;
              const tickerData = await fetchTickerFinancialData(symbol, timeframe);

              // Create QuickChart
              const chartConfig = {
                type: "line",
                data: {
                  labels: tickerData.historicalData.map((x) => x.date),
                  datasets: [
                    {
                      label: `${tickerData.ticker} Price`,
                      data: tickerData.historicalData.map((x) => x.price),
                      borderColor: "#0070f3",
                      backgroundColor: "rgba(0, 112, 243, 0.1)",
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

              finalContent = {
                embeds: [
                  {
                    title: `${tickerData.ticker} Financial Data`,
                    color: 3447003,
                    fields: [
                      { name: "Current Price", value: tickerData.currentPrice, inline: true },
                      { name: "Timeframe", value: timeframe.toUpperCase(), inline: true },
                      {
                        name: "Selected Range",
                        value: tickerData.selectedRange,
                        inline: true,
                      },
                      { name: "Data Source", value: "Yahoo Finance", inline: true },
                    ],
                    image: { url: chartUrl },
                    footer: { text: "Data from Yahoo Finance" },
                    timestamp: new Date().toISOString(),
                  },
                ],
              };
            }

            // 3) Now PATCH the original deferred response
            //    (requires BOT_TOKEN in environment)
            await axios.patch(
              `https://discord.com/api/v10/webhooks/${application_id}/${token}/messages/@original`,
              finalContent,
              {
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bot ${process.env.BOT_TOKEN}`,
                },
              }
            );
          } catch (err) {
            console.error("Error after deferral:", err);
            // Attempt to edit the original with an error message
            await axios.patch(
              `https://discord.com/api/v10/webhooks/${application_id}/${token}/messages/@original`,
              {
                content:
                  "⚠️ Failed to fetch data. Please try again later or check the logs.",
              },
              {
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bot ${process.env.BOT_TOKEN}`,
                },
              }
            );
          }
        })();

        // We already responded with DEFERRED, so just end
        return;
      }

      //------------------------------------
      // Unknown
      //------------------------------------
      default:
        return res.status(400).json({ error: "Unknown command" });
    }
  } else {
    // Not a command
    return res.status(400).json({ error: "Unknown interaction type" });
  }
};
