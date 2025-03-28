// index.js
"use strict";

const {
    InteractionResponseType,
    InteractionType,
    verifyKey,
} = require("discord-interactions");
const getRawBody = require("raw-body");
const axios = require("axios");

// --- Define Commands ---
const HI_COMMAND = { name: "hi", description: "Say hello!" };
const CHECK_COMMAND = { name: "check", description: "Display MFEA analysis status." };
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

// --- Helper Functions ---

// Helper function to log debug messages
function logDebug(message) {
    console.log(`[DEBUG] ${message}`);
}

// Helper function to determine risk category and allocation
function determineRiskCategory(data) {
    // Data values (spy, sma220, volatility) are expected to be numbers here
    logDebug(`Determining risk category with SPY: ${data.spy}, SMA220: ${data.sma220}, Volatility: ${data.volatility}%, Treasury Rate: ${data.treasuryRate}%, Is Treasury Falling: ${data.isTreasuryFalling}`);

    if (data.spy > data.sma220) {
        if (data.volatility < 14) {
            return {
                category: "Risk On",
                allocation: "100% UPRO (3× leveraged S&P 500) or 3×(100% SPY)",
            };
        } else if (data.volatility < 24) {
            return {
                category: "Risk Mid",
                allocation: "100% SSO (2× S&P 500) or 2×(100% SPY)",
            };
        } else {
            // Volatility >= 24
            if (data.isTreasuryFalling) {
                return {
                    category: "Risk Alt",
                    allocation: "25% UPRO + 75% ZROZ (long‑duration zero‑coupon bonds) or 1.5×(50% SPY + 50% ZROZ)",
                };
            } else {
                return {
                    category: "Risk Off",
                    allocation: "100% SPY or 1×(100% SPY)",
                };
            }
        }
    } else {
        // When SPY ≤ 220-day SMA, do not consider volatility, directly check Treasury rate
        if (data.isTreasuryFalling) {
            return {
                category: "Risk Alt",
                allocation: "25% UPRO + 75% ZROZ (long‑duration zero‑coupon bonds) or 1.5×(50% SPY + 50% ZROZ)",
            };
        } else {
            return {
                category: "Risk Off",
                allocation: "100% SPY or 1×(100% SPY)",
            };
        }
    }
}

// Helper function to fetch financial data for /check command
async function fetchCheckFinancialData() {
    try {
        logDebug("Fetching data for /check command...");
        // Fetch SPY (for price, SMA, and volatility) and Treasury Rate concurrently
        const [spySMAResponse, treasuryResponse] = await Promise.all([
            // Fetch enough data for 220-day SMA and 21-day volatility (need 22 data points for 21 returns)
            axios.get("https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=220d"),
            // Fetch enough data to find rate ~30 days ago (40 calendar days should suffice)
            axios.get("https://query1.finance.yahoo.com/v8/finance/chart/%5EIRX?interval=1d&range=40d"),
        ]);

        // --- SPY Data Processing ---
        const spyData = spySMAResponse.data.chart.result[0];
        if (!spyData || !spyData.meta || !spyData.indicators || !spyData.indicators.adjclose || !spyData.indicators.adjclose[0].adjclose) {
             throw new Error("Incomplete SPY data received.");
        }
        const spyPrice = spyData.meta.regularMarketPrice;
        logDebug(`Raw SPY Price: ${spyPrice}`);

        const spyAdjClosePrices = spyData.indicators.adjclose[0].adjclose.filter(price => price !== null); // Filter nulls if any

        // Calculate 220-day SMA
        if (spyAdjClosePrices.length < 220) {
            throw new Error(`Not enough data for 220-day SMA. Found ${spyAdjClosePrices.length} points.`);
        }
        const sum220 = spyAdjClosePrices.slice(-220).reduce((acc, price) => acc + price, 0);
        const sma220 = sum220 / 220;
        logDebug(`Calculated 220-day SMA: ${sma220.toFixed(2)}`);

        const spyStatus = spyPrice > sma220 ? "Over" : "Under";
        logDebug(`SPY Status: ${spyStatus} the 220-day SMA`);

        // Calculate Volatility (using the same SPY data)
        if (spyAdjClosePrices.length < 22) { // Need 22 prices for 21 returns
            throw new Error(`Not enough data for 21-day volatility. Found ${spyAdjClosePrices.length} points.`);
        }
        const relevantPricesForVol = spyAdjClosePrices.slice(-22); // Last 22 prices
        const spyDailyReturns = relevantPricesForVol.slice(1).map((price, idx) => {
            const prevPrice = relevantPricesForVol[idx];
            return prevPrice === 0 ? 0 : (price / prevPrice - 1); // Avoid division by zero
        });

        if (spyDailyReturns.length !== 21) {
             throw new Error(`Incorrect number of daily returns calculated: ${spyDailyReturns.length}`);
        }
        const meanReturn = spyDailyReturns.reduce((acc, r) => acc + r, 0) / spyDailyReturns.length;
        const variance = spyDailyReturns.reduce((acc, r) => acc + Math.pow(r - meanReturn, 2), 0) / spyDailyReturns.length;
        const dailyVolatility = Math.sqrt(variance);
        const annualizedVolatility = dailyVolatility * Math.sqrt(252) * 100; // Standard deviation * sqrt(trading days) * 100
        logDebug(`Calculated Annualized Volatility (21 trading days): ${annualizedVolatility.toFixed(2)}%`);


        // --- Treasury Data Processing ---
        const treasuryData = treasuryResponse.data.chart.result[0];
         if (!treasuryData || !treasuryData.indicators || !treasuryData.indicators.quote || !treasuryData.indicators.quote[0].close || !treasuryData.timestamp) {
             throw new Error("Incomplete Treasury data received.");
         }
        const treasuryRates = treasuryData.indicators.quote[0].close;
        const treasuryTimestamps = treasuryData.timestamp;

        // Filter out nulls and ensure timestamps match rates
        const validTreasuryData = treasuryTimestamps.map((ts, i) => ({
            timestamp: ts,
            rate: treasuryRates[i]
        })).filter(item => item.rate !== null && item.timestamp !== null);

        if (validTreasuryData.length === 0) {
            throw new Error("Treasury rate data is unavailable after filtering.");
        }

        // Get the most recent valid rate and timestamp
        const latestTreasuryEntry = validTreasuryData[validTreasuryData.length - 1];
        const currentTreasuryRate = latestTreasuryEntry.rate;
        const lastTimestamp = latestTreasuryEntry.timestamp;
        logDebug(`Current 3-Month Treasury Rate: ${currentTreasuryRate.toFixed(3)}% from ${new Date(lastTimestamp * 1000).toLocaleDateString()}`);

        // Find the rate from ~30 days ago using timestamps
        const targetTimestamp = lastTimestamp - (30 * 24 * 60 * 60); // Target timestamp 30 days ago (in seconds)
        let oneMonthAgoEntry = validTreasuryData[0]; // Default to oldest if no data point is old enough

        // Find the latest entry whose timestamp is less than or equal to the target
        for (let i = validTreasuryData.length - 1; i >= 0; i--) {
            if (validTreasuryData[i].timestamp <= targetTimestamp) {
                oneMonthAgoEntry = validTreasuryData[i];
                break;
            }
        }
        const oneMonthAgoTreasuryRate = oneMonthAgoEntry.rate;
        logDebug(`Using Treasury Rate from ~30 days ago (${new Date(oneMonthAgoEntry.timestamp * 1000).toLocaleDateString()}): ${oneMonthAgoTreasuryRate.toFixed(3)}%`);

        // Calculate change and trend
        const treasuryRateChange = currentTreasuryRate - oneMonthAgoTreasuryRate;
        logDebug(`Treasury Rate Change: ${treasuryRateChange.toFixed(3)}%`);
        const isTreasuryFalling = treasuryRateChange < 0;
        logDebug(`Is Treasury Rate Falling: ${isTreasuryFalling}`);

        // Return data as numbers where appropriate for calculations
        return {
            spy: parseFloat(spyPrice),
            sma220: sma220,
            spyStatus: spyStatus,
            volatility: annualizedVolatility,
            treasuryRate: currentTreasuryRate,
            isTreasuryFalling: isTreasuryFalling,
            treasuryRateChange: treasuryRateChange,
        };
    } catch (error) {
        console.error("[ERROR] Error fetching check financial data:", error.message);
        // Log the underlying error if it's from Axios
        if (error.response) {
            console.error("Axios Error Data:", error.response.data);
            console.error("Axios Error Status:", error.response.status);
        }
         // Rethrow with a more specific message if possible
         if (error.message.includes("Yahoo")) {
              throw new Error("Failed to fetch financial data from Yahoo Finance.");
         } else {
             throw new Error(`Failed to process financial data: ${error.message}`);
         }
    }
}


// Helper function to fetch financial data for /ticker command
async function fetchTickerFinancialData(ticker, range) {
    try {
        logDebug(`Fetching data for /ticker ${ticker} with range ${range}`);
        const rangeOptions = {
            '1d': { range: '1d', interval: '1m' },    // More granular for 1d
            '1mo': { range: '1mo', interval: '30m' }, // Adjust interval for 1mo
            '1y': { range: '1y', interval: '1d' },
            '3y': { range: '3y', interval: '1wk' },
            '10y': { range: '10y', interval: '1mo' },
        };

        const selectedRange = rangeOptions[range] ? range : '1d'; // Default to '1d' if invalid
        const { range: yahooRange, interval } = rangeOptions[selectedRange];
        logDebug(`Using Yahoo range: ${yahooRange}, interval: ${interval}`);

        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${yahooRange}`;
        logDebug(`Fetching URL: ${url}`);
        const tickerResponse = await axios.get(url);
        const tickerData = tickerResponse.data;

        if (
            !tickerData.chart ||
            !tickerData.chart.result ||
            tickerData.chart.result.length === 0 ||
            !tickerData.chart.result[0].meta ||
            tickerData.chart.result[0].meta.regularMarketPrice === null || // Check specifically for null price
             !tickerData.chart.result[0].timestamp ||
            !tickerData.chart.result[0].indicators
        ) {
            // Check if there's an error message from Yahoo
            if (tickerData.chart && tickerData.chart.error) {
                logDebug(`Yahoo Finance Error for ${ticker}: ${tickerData.chart.error.description}`);
                 throw new Error(`Yahoo Finance Error: ${tickerData.chart.error.description}`);
            }
            logDebug(`Invalid or incomplete data received for ${ticker}`);
            throw new Error("Invalid ticker symbol or data unavailable from Yahoo Finance.");
        }

        const result = tickerData.chart.result[0];
        const currentPrice = parseFloat(result.meta.regularMarketPrice);
        const timestamps = result.timestamp;
        let prices = [];

        // Prefer adjclose, fallback to close
        if (result.indicators.adjclose && result.indicators.adjclose[0].adjclose) {
            prices = result.indicators.adjclose[0].adjclose;
        } else if (result.indicators.quote && result.indicators.quote[0].close) {
            prices = result.indicators.quote[0].close;
        } else {
            throw new Error("Price data (adjclose/close) is unavailable.");
        }

        // Filter out null values and create pairs
        const validDataPoints = timestamps
            .map((timestamp, index) => ({ timestamp, price: prices[index] }))
            .filter(dp => dp.timestamp !== null && dp.price !== null);


        if (validDataPoints.length === 0) {
            throw new Error("No valid historical data points found.");
        }

        // Prepare historical data for Chart.js with appropriate date formatting
        const historicalData = validDataPoints.map(dp => {
            const dateObj = new Date(dp.timestamp * 1000);
            let dateLabel = '';

            if (selectedRange === '1d') {
                 // Time only for 1d
                 dateLabel = dateObj.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
            } else if (selectedRange === '1mo') {
                 // Month, Day, Time for 1mo
                 dateLabel = dateObj.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
            } else if (selectedRange === '1y' || selectedRange === '3y') {
                 // Month, Day, Year for 1y/3y
                 dateLabel = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            } else { // 10y (monthly)
                // Month, Year for 10y
                dateLabel = dateObj.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
            }

            return {
                date: dateLabel,
                price: parseFloat(dp.price), // Keep price as number for chart
            };
        });

        // Note: No aggregation applied here for simplicity, QuickChart handles reasonable data points.
        // If performance becomes an issue with 10y/1mo data, aggregation could be added back.

        return {
            ticker: ticker.toUpperCase(),
            currentPrice: currentPrice, // Return as number
            historicalData: historicalData,
            selectedRange: selectedRange.toUpperCase(), // e.g., "1D", "1MO"
        };

    } catch (error) {
        console.error(`[ERROR] Failed fetching ticker data for ${ticker}:`, error.message);
         // Log the underlying error if it's from Axios
         if (error.response) {
            console.error("Axios Error Data:", error.response.data);
            console.error("Axios Error Status:", error.response.status);
         }
         // Provide a user-friendly error based on the caught error type
         if (error.message.includes("Yahoo Finance Error:")) {
             throw new Error(error.message); // Pass specific Yahoo error through
         } else if (error.message.includes("Invalid ticker symbol")) {
              throw new Error(`Failed to fetch data for ${ticker.toUpperCase()}. Please check the symbol.`);
         } else {
             throw new Error("Failed to fetch financial data. An unexpected error occurred.");
         }
    }
}


// --- Main Handler ---
module.exports = async (req, res) => {
    logDebug("Received a new request");

    if (req.method !== "POST") {
        logDebug("Invalid method, returning 405");
        res.setHeader("Allow", "POST");
        return res.status(405).json({ error: "Method Not Allowed" });
    }

    const signature = req.headers["x-signature-ed25519"];
    const timestamp = req.headers["x-signature-timestamp"];
    const rawBody = await getRawBody(req, { encoding: "utf-8" }); // Get body early for verification

    if (!signature || !timestamp || !rawBody) {
        console.error("[ERROR] Missing signature, timestamp, or body");
        return res.status(401).json({ error: "Bad request signature" });
    }

    const isValidRequest = verifyKey(
        rawBody,
        signature,
        timestamp,
        process.env.PUBLIC_KEY
    );

    if (!isValidRequest) {
        console.error("[ERROR] Invalid request signature");
        return res.status(401).json({ error: "Bad request signature" });
    }

    logDebug("Request signature verified");
    const message = JSON.parse(rawBody); // Parse body after verification
    logDebug(`Interaction Type: ${message.type}`);

    // --- Interaction Handling ---

    // Type 1: PING
    if (message.type === InteractionType.PING) {
        try {
            logDebug("Handling PING");
            return res.status(200).json({ type: InteractionResponseType.PONG });
        } catch (error) {
            console.error("[ERROR] Failed to handle PING:", error);
            // Attempt to send an error response if possible, otherwise Vercel handles timeout
            try {
                return res.status(500).json({ error: "Internal Server Error handling PING" });
            } catch {
                // If sending response fails, just log
                 console.error("[ERROR] Could not send error response for PING failure.");
            }
        }
    }

    // Type 2: APPLICATION_COMMAND
    if (message.type === InteractionType.APPLICATION_COMMAND) {
        const commandName = message.data.name.toLowerCase();
        logDebug(`Handling command: /${commandName}`);

        switch (commandName) {
            case HI_COMMAND.name.toLowerCase():
                try {
                    return res.status(200).json({
                        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                        data: { content: "hii <3" },
                    });
                } catch (error) {
                     console.error("[ERROR] Failed to execute /hi:", error);
                     return res.status(500).json({
                          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                          data: { content: "⚠️ Oops! Something went wrong with /hi." }
                     });
                }

            case CHECK_COMMAND.name.toLowerCase():
                try {
                    // Defer the reply immediately, as fetching can take time
                     res.status(200).json({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });
                     logDebug("Deferred reply sent for /check. Fetching data...");

                     // Fetch and process data
                     const financialData = await fetchCheckFinancialData();
                     const { category, allocation } = determineRiskCategory(financialData);

                     // Format Treasury Trend
                     let treasuryRateTrendValue = "";
                     const changePercent = Math.abs(financialData.treasuryRateChange).toFixed(3);
                     const timeframeDesc = " (~30d ago)"; // Clarify timeframe
                     if (financialData.treasuryRateChange > 0.0001) { // Add small tolerance for float precision
                         treasuryRateTrendValue = `⬆️ Increasing by ${changePercent}% since${timeframeDesc}`;
                     } else if (financialData.treasuryRateChange < -0.0001) {
                         treasuryRateTrendValue = `⬇️ Decreasing by ${changePercent}% since${timeframeDesc}`;
                     } else {
                         treasuryRateTrendValue = `↔️ No significant change since${timeframeDesc}`;
                     }

                     // Construct the follow-up message content (embed)
                     const embed = {
                         title: "MFEA Analysis Status",
                         color: 3447003, // Blue
                         fields: [
                             { name: "SPY Price", value: `$${financialData.spy.toFixed(2)}`, inline: true },
                             { name: "220-day SMA", value: `$${financialData.sma220.toFixed(2)}`, inline: true },
                             { name: "SPY Status", value: `${financialData.spyStatus} SMA`, inline: true }, // Shortened
                             { name: "Volatility (21d)", value: `${financialData.volatility.toFixed(2)}%`, inline: true },
                             { name: "3M Treasury Rate", value: `${financialData.treasuryRate.toFixed(3)}%`, inline: true },
                             { name: "Treasury Trend", value: treasuryRateTrendValue, inline: true },
                             { name: "📈 **Risk Category**", value: category, inline: false },
                             { name: "💡 **Allocation**", value: `**${allocation}**`, inline: false }, // Shortened title
                         ],
                         footer: { text: "MFEA analysis based on market data" },
                         timestamp: new Date().toISOString(), // Add timestamp
                     };

                     // Send the follow-up message using Axios to the interaction endpoint
                     const followUpUrl = `https://discord.com/api/v10/webhooks/${process.env.APP_ID}/${message.token}/messages/@original`;
                     logDebug("Sending follow-up for /check...");
                     await axios.patch(followUpUrl, { embeds: [embed] });
                     logDebug("/check command successfully executed.");
                     // No return needed here as we already responded with DEFERRED and sent followup

                } catch (error) {
                    console.error("[ERROR] Failed to execute /check command:", error);
                    // Try to send an error follow-up message
                     const followUpUrl = `https://discord.com/api/v10/webhooks/${process.env.APP_ID}/${message.token}/messages/@original`;
                    try {
                        await axios.patch(followUpUrl, { content: `⚠️ Error running /check: ${error.message}` });
                    } catch (followUpError) {
                        console.error("[ERROR] Failed to send error follow-up message:", followUpError);
                    }
                     // No return needed here
                }
                return; // Explicit return after async logic

            case TICKER_COMMAND.name.toLowerCase():
                 try {
                      // Defer reply
                      res.status(200).json({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });
                      logDebug("Deferred reply sent for /ticker. Processing...");

                      const options = message.data.options || [];
                      const tickerOption = options.find(opt => opt.name === "symbol");
                      const timeframeOption = options.find(opt => opt.name === "timeframe");
                      const ticker = tickerOption ? tickerOption.value.toUpperCase() : null;
                      const timeframe = timeframeOption ? timeframeOption.value : '1d'; // Default timeframe

                      if (!ticker) {
                           throw new Error("Ticker symbol is required."); // Should be caught by Discord validation, but good practice
                      }

                      // Fetch data
                      const tickerData = await fetchTickerFinancialData(ticker, timeframe);

                      // Generate Chart URL
                      const chartConfig = {
                           type: 'line',
                           data: {
                                labels: tickerData.historicalData.map(entry => entry.date),
                                datasets: [{
                                     label: `${tickerData.ticker} Price`,
                                     data: tickerData.historicalData.map(entry => entry.price.toFixed(2)), // Format price for chart display
                                     borderColor: 'rgb(54, 162, 235)', // Blue
                                     backgroundColor: 'rgba(54, 162, 235, 0.2)',
                                     borderWidth: 1.5,
                                     pointRadius: 0, // Cleaner look
                                     fill: true,
                                     tension: 0.1 // Slight smoothing
                                }]
                           },
                           options: {
                                scales: {
                                     x: {
                                         title: { display: true, text: 'Time / Date', color: '#ccc' },
                                         ticks: { color: '#ccc', maxRotation: 0, autoSkip: true, maxTicksLimit: 10 }, // Limit ticks
                                         grid: { color: 'rgba(255, 255, 255, 0.1)' }
                                     },
                                     y: {
                                         title: { display: true, text: 'Price ($)', color: '#ccc' },
                                         ticks: { color: '#ccc', callback: value => `$${value}` }, // Add '$' prefix
                                         grid: { color: 'rgba(255, 255, 255, 0.1)' }
                                     }
                                },
                                plugins: {
                                     legend: { labels: { color: '#ccc' } },
                                     tooltip: {
                                          mode: 'index',
                                          intersect: false,
                                          callbacks: {
                                               label: context => `${context.dataset.label}: $${parseFloat(context.parsed.y).toFixed(2)}`
                                          }
                                     }
                                },
                                // Dark theme background
                                // backgroundColor: 'rgb(47, 49, 54)', // Discord dark theme approx
                           }
                      };
                      // Use QuickChart's 'backgroundColor' param for background instead of inside config
                      const chartConfigEncoded = encodeURIComponent(JSON.stringify(chartConfig));
                      const chartUrl = `https://quickchart.io/chart?w=600&h=350&v=4&c=${chartConfigEncoded}&backgroundColor=rgb(47,49,54)`; // Dark BG, larger size

                      // Construct Embed
                      const tickerEmbed = {
                           title: `${tickerData.ticker} Chart (${tickerData.selectedRange})`,
                           color: 3447003, // Blue
                           fields: [
                                { name: "Current Price", value: `$${tickerData.currentPrice.toFixed(2)}`, inline: true },
                                { name: "Timeframe", value: tickerData.selectedRange, inline: true },
                                // { name: "Data Source", value: "Yahoo Finance", inline: true }, // Optional
                           ],
                           image: { url: chartUrl },
                           footer: { text: "Data via Yahoo Finance | Chart via QuickChart.io" },
                            timestamp: new Date().toISOString(),
                      };

                     // Send follow-up
                      const followUpUrl = `https://discord.com/api/v10/webhooks/${process.env.APP_ID}/${message.token}/messages/@original`;
                      logDebug("Sending follow-up for /ticker...");
                      await axios.patch(followUpUrl, { embeds: [tickerEmbed] });
                      logDebug("/ticker command successfully executed.");

                 } catch (error) {
                      console.error(`[ERROR] Failed to execute /ticker command:`, error);
                     // Try to send error follow-up
                      const followUpUrl = `https://discord.com/api/v10/webhooks/${process.env.APP_ID}/${message.token}/messages/@original`;
                      try {
                          // Provide a cleaner error message to the user
                          const userErrorMessage = error.message.startsWith("Failed to fetch data") || error.message.startsWith("Yahoo Finance Error:")
                               ? error.message
                               : "An error occurred while fetching ticker data.";
                          await axios.patch(followUpUrl, { content: `⚠️ ${userErrorMessage}` });
                      } catch (followUpError) {
                           console.error("[ERROR] Failed to send error follow-up for /ticker:", followUpError);
                      }
                 }
                 return; // Explicit return

            default:
                logDebug(`Unknown command received: ${commandName}`);
                // Send an immediate response for unknown commands
                 try {
                    return res.status(400).json({
                         type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                         data: { content: "😕 Sorry, I don't recognize that command." }
                    });
                 } catch (error) {
                      console.error("[ERROR] Failed sending unknown command response:", error);
                      // Fallback if response fails
                      return res.status(500).json({ error: "Error handling unknown command." });
                 }
        }
    } else {
        // Handle unknown interaction types
        logDebug(`Unknown Interaction Type: ${message.type}`);
         try {
            return res.status(400).json({ error: "Unknown Interaction Type" });
         } catch (error) {
             console.error("[ERROR] Failed sending unknown interaction type response:", error);
             return res.status(500).json({ error: "Error handling unknown interaction type." });
         }
    }

     // Fallback for any unhandled cases (should not be reached ideally)
     logDebug("Reached end of handler without sending response for message:", message);
     try {
        return res.status(500).json({ error: "Unhandled request path." });
     } catch (error) {
         console.error("[ERROR] Failed sending final fallback error response:", error);
         // No more responses can be sent
     }
};
