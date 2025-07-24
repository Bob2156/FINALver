"use strict";

const {
  InteractionResponseType,
  InteractionType,
  verifyKey,
} = require("discord-interactions");
const getRawBody = require("raw-body");
const axios = require("axios");
const { checkAllocation, SUBSCRIBE_ALLOC_ID } = require("../allocationCron");
const {
  fetchCheckFinancialData,
  determineRiskCategory,
  determineRecommendationWithBands,
} = require("../lib/financial");
const { toggleSubscriber } = require("../storage");

// Define your commands (Unchanged from original)
const HI_COMMAND = { name: "hi", description: "Say hello!" };
// Updated description for clarity
const CHECK_COMMAND = {
  name: "check",
  description: "Display MFEA analysis status (Strict & Recommended).",
};
const TICKER_COMMAND = {
  name: "ticker",
  description: "Fetch and display financial data for a specific ticker and timeframe.",
  options: [
    {
      name: "symbol",
      type: 3, // STRING type
      description: "The stock ticker symbol (e.g., AAPL, GOOGL)",
      required: true,
    },
    {
      name: "timeframe",
      type: 3, // STRING type
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
const TEST_COMMAND = {
  name: "test",
  description: "Run allocation change check.",
};

// Preset image URL for /ticker command (Test Mode) - Unchanged
const PRESET_IMAGE_URL =
  "https://th.bing.com/th/id/R.aeccf9d26746b036234619be80502098?rik=JZrA%2f9rIOJ3Fxg&riu=http%3a%2f%2fwww.clipartbest.com%2fcliparts%2fbiy%2fE8E%2fbiyE8Er5T.jpeg&ehk=FOPbyrcgKCZzZorMhY69pKoHELUk3FiBPDkgwkqNvis%3d&risl=&pid=ImgRaw&r=0";

// Helper function to log debug messages (Unchanged from original)
function logDebug(message) {
  console.log(`[DEBUG] ${message}`);
}


// Helper function to fetch financial data for /ticker command (Unchanged)
async function fetchTickerFinancialData(ticker, range) {
  try {
    const rangeOptions = {
      "1d": { range: "1d", interval: "1m" },
      "1mo": { range: "1mo", interval: "5m" },
      "1y": { range: "1y", interval: "1d" },
      "3y": { range: "3y", interval: "1wk" },
      "10y": { range: "10y", interval: "1mo" },
    };

    const selectedRange = rangeOptions[range] ? range : "1d";
    const { range: yahooRange, interval } = rangeOptions[selectedRange];

    const tickerResponse = await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
        ticker
      )}?interval=${interval}&range=${yahooRange}`
    );
    const tickerData = tickerResponse.data;

    // Validation
    if (
      !tickerData.chart.result ||
      tickerData.chart.result.length === 0 ||
      tickerData.chart.result[0].meta?.regularMarketPrice === undefined
    ) {
      if (tickerData.chart?.error?.description) {
        throw new Error(
          `Yahoo Finance error: ${tickerData.chart.error.description}`
        );
      }
      throw new Error("Invalid ticker symbol or data unavailable.");
    }

    const currentPrice = parseFloat(
      tickerData.chart.result[0].meta.regularMarketPrice
    ).toFixed(2);
    const timestamps = tickerData.chart.result[0].timestamp;
    let prices = [];

    if (tickerData.chart.result[0].indicators?.adjclose?.[0]?.adjclose) {
      prices = tickerData.chart.result[0].indicators.adjclose[0].adjclose;
    } else if (tickerData.chart.result[0].indicators?.quote?.[0]?.close) {
      prices = tickerData.chart.result[0].indicators.quote[0].close;
    } else {
      throw new Error("Price data is unavailable.");
    }

    if (!timestamps || !prices || timestamps.length !== prices.length) {
      throw new Error("Incomplete historical data.");
    }

    const validHistoricalEntries = timestamps
      .map((timestamp, index) => ({ timestamp, price: prices[index] }))
      .filter(
        (entry) =>
          entry.timestamp != null &&
          typeof entry.price === "number" &&
          entry.price !== null
      );

    const historicalData = validHistoricalEntries.map((entry) => {
      const dateObj = new Date(entry.timestamp * 1000);
      let dateLabel = "";
      const options = { timeZone: "America/New_York" };

      if (selectedRange === "1d") {
        options.hour = "2-digit";
        options.minute = "2-digit";
        options.hour12 = true;
        dateLabel = dateObj.toLocaleString("en-US", options);
      } else if (selectedRange === "1mo") {
        options.month = "short";
        options.day = "numeric";
        options.hour = "2-digit";
        options.minute = "2-digit";
        options.hour12 = true;
        dateLabel = dateObj.toLocaleString("en-US", options);
      } else {
        options.month = "short";
        options.day = "numeric";
        options.year = "numeric";
        dateLabel = dateObj.toLocaleDateString("en-US", options);
      }
      return { date: dateLabel, price: entry.price };
    });

    let aggregatedData = historicalData;
    if (selectedRange === "10y" && validHistoricalEntries.length > 0) {
      logDebug(`Aggregating 10y data for ${ticker}...`);
      const monthlyMap = {};
      validHistoricalEntries.forEach((entry) => {
        const dateObj = new Date(entry.timestamp * 1000);
        if (dateObj && !isNaN(dateObj.getTime())) {
          const monthKey = `${dateObj.getFullYear()}-${String(
            dateObj.getMonth() + 1
          ).padStart(2, "0")}`;
          if (!monthlyMap[monthKey]) {
            const monthLabel = dateObj.toLocaleDateString("en-US", {
              month: "short",
              year: "numeric",
              timeZone: "America/New_York",
            });
            monthlyMap[monthKey] = { sum: 0, count: 0, label: monthLabel };
          }
          monthlyMap[monthKey].sum += entry.price;
          monthlyMap[monthKey].count += 1;
        }
      });
      aggregatedData = Object.keys(monthlyMap)
        .sort()
        .map((monthKey) => {
          const avgPrice =
            monthlyMap[monthKey].sum / monthlyMap[monthKey].count;
          return {
            date: monthlyMap[monthKey].label,
            price: parseFloat(avgPrice).toFixed(2),
          };
        });
      logDebug(`Aggregated into ${aggregatedData.length} points.`);
    }

    return {
      ticker: ticker.toUpperCase(),
      currentPrice: `$${currentPrice}`,
      historicalData: aggregatedData.map((d) => ({
        ...d,
        price: String(d.price),
      })),
      selectedRange: selectedRange.toUpperCase(),
    };
  } catch (error) {
    console.error("Error fetching financial data for /ticker:", error);
    throw new Error(
      error.response?.data?.chart?.error?.description
        ? error.response.data.chart.error.description
        : "Failed to fetch financial data."
    );
  }
}

// Main handler (Integrates new logic into original structure)
module.exports = async (req, res) => {
  logDebug("Received a new request");

  // --- Request Validation (Signature, Timestamp, Method, Body Parsing) ---
  if (req.method !== "POST") {
    logDebug("Invalid method");
    return res.status(405).json({ error: "Method Not Allowed" });
  }
  const signature = req.headers["x-signature-ed25519"];
  const timestamp = req.headers["x-signature-timestamp"];
  if (!signature || !timestamp) {
    console.error("Missing headers");
    return res.status(401).json({ error: "Bad request signature" });
  }
  let rawBody;
  try {
    rawBody = await getRawBody(req, { encoding: "utf-8" });
  } catch (error) {
    console.error("Raw body error:", error);
    return res.status(400).json({ error: "Invalid request body" });
  }
  let message;
  try {
    message = JSON.parse(rawBody);
  } catch (error) {
    console.error("JSON parse error:", error);
    return res.status(400).json({ error: "Invalid JSON format" });
  }
  if (!process.env.PUBLIC_KEY) {
    console.error("PUBLIC_KEY missing");
    return res
      .status(500)
      .json({ error: "Internal server configuration error." });
  }
  const isValidRequest = verifyKey(
    rawBody,
    signature,
    timestamp,
    process.env.PUBLIC_KEY
  );
  if (!isValidRequest) {
    console.error("Invalid signature");
    return res.status(401).json({ error: "Bad request signature" });
  }
  logDebug("Signature verified");
  // --- End Validation ---

  logDebug(`Message type: ${message.type}`);

  // --- PING Handler ---
  if (message.type === InteractionType.PING) {
    try {
      logDebug("Handling PING");
      return res.status(200).json({ type: InteractionResponseType.PONG });
    } catch (error) {
      console.error("PING Error:", error);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  }

  // --- APPLICATION_COMMAND Handler ---
  if (message.type === InteractionType.APPLICATION_COMMAND) {
    const commandName = message.data.name.toLowerCase();
    const { application_id, token } = message;

    switch (commandName) {
      // /hi - immediate
      case HI_COMMAND.name.toLowerCase():
        try {
          logDebug("Handling /hi command");
          return res.status(200).json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: "hii <3" },
          });
        } catch (error) {
          console.error("[ERROR] /hi:", error);
          try {
            return res.status(500).json({
              type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
              data: { content: "⚠️ Error processing /hi." },
            });
          } catch (e) {
            console.error("Failed to send /hi error", e);
            return res.status(500).send("Error");
          }
        }

      // /check - immediate (unchanged from original)
      case CHECK_COMMAND.name.toLowerCase():
        try {
          logDebug("Handling /check command");
          const financialData = await fetchCheckFinancialData();

          // 1. Strict MFEA
          const { category: mfeaCategory, allocation: mfeaAllocation } =
            determineRiskCategory(financialData);

          // 2. Recommended
          const { recommendedCategory, recommendedAllocation, bandInfo } =
            determineRecommendationWithBands(financialData);

          // Treasury Rate Trend
          let treasuryRateTrendValue = "";
          const treasuryRateTimeframe = "last 21 trading days";
          const changeNum = parseFloat(financialData.treasuryRateChange);

          if (changeNum > 0.0001) {
            treasuryRateTrendValue = `⬆️ Increasing by ${Math.abs(
              changeNum
            ).toFixed(3)}% since ${treasuryRateTimeframe}`;
          } else if (changeNum < -0.0001) {
            treasuryRateTrendValue = `⬇️ ${Math.abs(changeNum).toFixed(
              3
            )}% since ${treasuryRateTimeframe}`;
          } else {
            treasuryRateTrendValue = `↔️ No change since ${treasuryRateTimeframe}`;
          }

          // Band Influence Description
          let bandInfluenceDescription = "";
          const influences = [];
          let recommendationDiffers =
            mfeaAllocation !== recommendedAllocation;

          if (bandInfo.isSpyInSmaBand) influences.push(`SPY within ±2% SMA`);
          if (bandInfo.isVolIn14Band) influences.push(`Vol within 13-15%`);
          else if (bandInfo.isVolIn24Band) influences.push(`Vol within 23-25%`);

          if (bandInfo.isTreasuryInBand) {
            influences.push(`Treasury change between Rec(-0.1%)/MFEA thresholds`);
          } else if (
            recommendationDiffers &&
            !bandInfo.isSpyInSmaBand &&
            !bandInfo.isVolIn14Band &&
            !bandInfo.isVolIn24Band &&
            bandInfo.trsChange < bandInfo.trsRecThreshold
          ) {
            influences.push(`Treasury change crossed Rec. threshold (<-0.1%)`);
          }

          if (!recommendationDiffers) {
            bandInfluenceDescription =
              influences.length > 0
                ? `Factors within bands: ${influences.join(
                    "; "
                  )}. Recommendation aligns.`
                : `All factors clear of bands. Recommendation aligns.`;
          } else {
            bandInfluenceDescription = `Recommendation differs. Influences: ${influences.join(
              "; "
            )}.`;
          }
          bandInfluenceDescription += `\n*Bands: ±2% SMA, ±1% Vol, <-0.1% Treas*`;

          // Construct and Send Embed
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
              components: [
                {
                  type: 1,
                  components: [
                    {
                      type: 2,
                      style: 1,
                      label: 'Notify Me',
                      custom_id: SUBSCRIBE_ALLOC_ID,
                    },
                  ],
                },
              ],
            },
          });
        } catch (error) {
          console.error("[ERROR] Failed processing /check command:", error);
          try {
            return res.status(500).json({
              type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
              data: {
                content: `⚠️ Unable to retrieve financial data: ${
                  error.message || "Please try again later."
                }`,
              },
            });
          } catch (responseError) {
            console.error("Failed to send /check error response:", responseError);
            return res.status(500).send("Internal Server Error");
          }
        }

      // /test - run allocation change check
      case TEST_COMMAND.name.toLowerCase():
        try {
          const result = await checkAllocation(true, 'Test Command');
          const msg = result.previous === result.current
            ? `No change in allocation: ${result.current}`
            : `Allocation changed to: ${result.current}`;
          return res.status(200).json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: msg },
          });
        } catch (err) {
          console.error("/test error", err);
          return res.status(500).json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: "⚠️ Test failed." },
          });
        }

      // /ticker - DEFER so it works on Vercel (async + patch)
      case TICKER_COMMAND.name.toLowerCase():
        try {
          logDebug("Handling /ticker command (deferral)");

          // 1) Defer immediately
          res.status(200).json({
            type: 5, // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
            data: {
              content: "Hang on, fetching data…",
            },
          });

          // 2) Async fetch & respond
          (async () => {
            try {
              // Extract user options
              const options = message.data.options || [];
              const tickerOption = options.find(
                (option) => option.name === "symbol"
              );
              const timeframeOption = options.find(
                (option) => option.name === "timeframe"
              );
              const ticker = tickerOption
                ? tickerOption.value.toUpperCase()
                : null;
              const timeframe = timeframeOption
                ? timeframeOption.value
                : "1d";
              if (!ticker) {
                throw new Error("Ticker symbol is required.");
              }

              // Do the actual fetch
              const tickerData = await fetchTickerFinancialData(
                ticker,
                timeframe
              );

              //  Build QuickChart config
              const chartConfig = {
                type: "line",
                data: {
                  labels: tickerData.historicalData.map((entry) => entry.date),
                  datasets: [
                    {
                      label: `${tickerData.ticker} Price`,
                      data: tickerData.historicalData.map((entry) => entry.price),
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
                          const value = parseFloat(context.parsed?.y);
                          return !isNaN(value) ? `$${value.toFixed(2)}` : "N/A";
                        },
                      },
                    },
                  },
                },
              };
              const chartConfigEncoded = encodeURIComponent(
                JSON.stringify(chartConfig)
              );
              const chartUrl = `https://quickchart.io/chart?c=${chartConfigEncoded}&w=600&h=400&bkg=%23ffffff`;

              // Build final embed
              const embed = {
                title: `${tickerData.ticker} Financial Data`,
                color: 3447003, // Blue
                fields: [
                  {
                    name: "Current Price",
                    value: tickerData.currentPrice,
                    inline: true,
                  },
                  {
                    name: "Timeframe",
                    value: timeframe.toUpperCase(),
                    inline: true,
                  },
                  {
                    name: "Selected Range",
                    value: tickerData.selectedRange.toUpperCase(),
                    inline: true,
                  },
                  { name: "Data Source", value: "Yahoo Finance", inline: true },
                ],
                image: { url: chartUrl },
                footer: { text: "Data fetched from Yahoo Finance" },
                timestamp: new Date().toISOString(),
              };

              // 3) PATCH original response to show final
              if (!process.env.BOT_TOKEN) {
                console.error(
                  "BOT_TOKEN not set: cannot edit deferred message."
                );
                return;
              }

              await axios.patch(
                `https://discord.com/api/v10/webhooks/${application_id}/${token}/messages/@original`,
                { embeds: [embed] },
                {
                  headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bot ${process.env.BOT_TOKEN}`,
                  },
                }
              );
            } catch (err) {
              console.error("[ERROR] Ticker fetch or patch failed:", err);
              // Attempt to patch error message
              if (process.env.BOT_TOKEN) {
                await axios.patch(
                  `https://discord.com/api/v10/webhooks/${application_id}/${token}/messages/@original`,
                  {
                    content:
                      "⚠️ Unable to retrieve financial data. Check the ticker and try again.",
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

          // We already deferred, so just return
          return;
        } catch (error) {
          console.error("[ERROR] /ticker deferral setup:", error);
          // If something happened before deferral, do immediate error
          return res.status(500).json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content:
                "⚠️ Unexpected error while deferring /ticker. Check logs.",
            },
          });
        }

      default:
        // (Original logic)
        try {
          console.error("[ERROR] Unknown command");
          return res.status(400).json({ error: "Unknown Command" });
        } catch (error) {
          console.error("Unknown command handler error:", error);
          return res.status(500).json({ error: "Internal Server Error" });
        }
    }
    } else if (message.type === InteractionType.MESSAGE_COMPONENT) {
      try {
        if (message.data.custom_id === SUBSCRIBE_ALLOC_ID) {
          const uid = message.member?.user?.id || message.user?.id;
          const added = await toggleSubscriber(uid);
          const text = added
            ? 'You will be notified on allocation changes.'
            : 'You will no longer receive allocation pings.';
          return res.status(200).json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: text, flags: 64 },
          });
        }
        return res.status(400).json({ error: 'Unknown component' });
      } catch (err) {
        console.error('component error', err);
        return res.status(500).json({ error: 'Component handling failed' });
      }
    } else {
      try {
        console.error("[ERROR] Unknown request type");
        return res.status(400).json({ error: "Unknown Type" });
      } catch (error) {
        console.error("Unknown type handler error:", error);
        return res.status(500).json({ error: "Internal Server Error" });
      }
    }
};
