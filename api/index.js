"use strict";

const {
    InteractionResponseType,
    InteractionType,
    verifyKey,
} = require("discord-interactions");
const getRawBody = require("raw-body");
const axios = require("axios");

// --- Environment Variable Checks (Optional but Recommended) ---
if (!process.env.PUBLIC_KEY) {
    console.error("FATAL ERROR: PUBLIC_KEY environment variable is not set.");
    process.exit(1); // Exit if essential config is missing
}
if (!process.env.APP_ID) {
    console.error("FATAL ERROR: APP_ID environment variable is not set.");
    process.exit(1);
}

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

function logDebug(message) {
    // Basic console logging; consider a more robust logger for production
    console.log(`[DEBUG] ${new Date().toISOString()} - ${message}`);
}

function determineRiskCategory(data) {
    // Expects data.spy, data.sma220, data.volatility as numbers
    // Expects data.isTreasuryFalling as boolean
    logDebug(`Determining risk category: SPY=${data.spy?.toFixed(2)}, SMA220=${data.sma220?.toFixed(2)}, Volatility=${data.volatility?.toFixed(2)}%, TreasuryFalling=${data.isTreasuryFalling}`);

    // Add checks for valid number inputs
    if (typeof data.spy !== 'number' || typeof data.sma220 !== 'number' || typeof data.volatility !== 'number' || typeof data.isTreasuryFalling !== 'boolean') {
        console.error("[ERROR] Invalid data types passed to determineRiskCategory:", data);
        return { category: "Error", allocation: "Calculation error due to invalid input data." };
    }

    if (data.spy > data.sma220) {
        if (data.volatility < 14) {
            return { category: "Risk On", allocation: "100% UPRO (3× S&P 500) or 3×(100% SPY)" };
        } else if (data.volatility < 24) {
            return { category: "Risk Mid", allocation: "100% SSO (2× S&P 500) or 2×(100% SPY)" };
        } else { // Volatility >= 24
            if (data.isTreasuryFalling) {
                return { category: "Risk Alt", allocation: "25% UPRO + 75% ZROZ (long duration zero coupon) or 1.5×(50% SPY + 50% ZROZ)" };
            } else {
                return { category: "Risk Off", allocation: "100% SPY or 1×(100% SPY)" };
            }
        }
    } else { // SPY <= SMA220
        if (data.isTreasuryFalling) {
            return { category: "Risk Alt", allocation: "25% UPRO + 75% ZROZ (long duration zero coupon) or 1.5×(50% SPY + 50% ZROZ)" };
        } else {
            return { category: "Risk Off", allocation: "100% SPY or 1×(100% SPY)" };
        }
    }
}

async function fetchCheckFinancialData() {
    logDebug("Initiating fetchCheckFinancialData...");
    const SPY_URL = "https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=220d";
    // Fetch slightly more treasury data to increase chance of finding a point ~30 days ago
    const IRX_URL = "https://query1.finance.yahoo.com/v8/finance/chart/%5EIRX?interval=1d&range=50d";

    try {
        const [spyResponse, treasuryResponse] = await Promise.all([
            axios.get(SPY_URL, { timeout: 10000 }), // Add timeout
            axios.get(IRX_URL, { timeout: 10000 })  // Add timeout
        ]);

        // --- SPY Data Processing ---
        const spyResult = spyResponse.data?.chart?.result?.[0];
        if (!spyResult?.meta?.regularMarketPrice || !spyResult?.indicators?.adjclose?.[0]?.adjclose) {
            throw new Error("Invalid or incomplete SPY data structure from Yahoo Finance.");
        }
        const spyPrice = parseFloat(spyResult.meta.regularMarketPrice);
        const spyAdjClosePrices = spyResult.indicators.adjclose[0].adjclose.filter(p => typeof p === 'number'); // Ensure numbers, filter nulls

        // Calculate 220-day SMA
        if (spyAdjClosePrices.length < 220) {
            throw new Error(`Insufficient SPY data for 220-day SMA (need 220, got ${spyAdjClosePrices.length}).`);
        }
        const sum220 = spyAdjClosePrices.slice(-220).reduce((acc, price) => acc + price, 0);
        const sma220 = sum220 / 220;
        const spyStatus = spyPrice > sma220 ? "Over" : "Under";
        logDebug(`SPY Price: ${spyPrice.toFixed(2)}, SMA220: ${sma220.toFixed(2)}, Status: ${spyStatus}`);

        // Calculate 21-day Volatility (using the same SPY data)
        if (spyAdjClosePrices.length < 22) { // Need 22 data points for 21 returns
            throw new Error(`Insufficient SPY data for 21-day volatility (need 22, got ${spyAdjClosePrices.length}).`);
        }
        const relevantPricesForVol = spyAdjClosePrices.slice(-22);
        const spyDailyReturns = [];
        for (let i = 1; i < relevantPricesForVol.length; i++) {
            if (relevantPricesForVol[i-1] !== 0) { // Avoid division by zero
                spyDailyReturns.push(relevantPricesForVol[i] / relevantPricesForVol[i - 1] - 1);
            } else {
                spyDailyReturns.push(0); // Or handle as appropriate
            }
        }
        if (spyDailyReturns.length !== 21) {
            logDebug(`Warning: Calculated ${spyDailyReturns.length} daily returns instead of 21.`);
             // Proceed if slightly off, but maybe add stricter check later
             if(spyDailyReturns.length === 0) throw new Error("Could not calculate any daily returns for volatility.");
        }
        const meanReturn = spyDailyReturns.reduce((acc, r) => acc + r, 0) / spyDailyReturns.length;
        const variance = spyDailyReturns.reduce((acc, r) => acc + Math.pow(r - meanReturn, 2), 0) / spyDailyReturns.length;
        const dailyVolatility = Math.sqrt(variance);
        const annualizedVolatility = dailyVolatility * Math.sqrt(252) * 100; // Uses 252 trading days
        logDebug(`Calculated Annualized Volatility (21 trading days): ${annualizedVolatility.toFixed(2)}%`);

        // --- Treasury (^IRX) Data Processing ---
        const treasuryResult = treasuryResponse.data?.chart?.result?.[0];
        if (!treasuryResult?.indicators?.quote?.[0]?.close || !treasuryResult?.timestamp) {
            throw new Error("Invalid or incomplete Treasury (^IRX) data structure from Yahoo Finance.");
        }
        const treasuryRates = treasuryResult.indicators.quote[0].close;
        const treasuryTimestamps = treasuryResult.timestamp;

        const validTreasuryData = treasuryTimestamps
            .map((ts, i) => ({ timestamp: ts, rate: treasuryRates[i] }))
            .filter(item => item.timestamp != null && typeof item.rate === 'number') // Ensure timestamp exists and rate is a number
            .sort((a, b) => a.timestamp - b.timestamp); // Ensure data is sorted chronologically

        if (validTreasuryData.length === 0) {
            throw new Error("No valid Treasury rate data points found after filtering.");
        }

        const latestTreasuryEntry = validTreasuryData[validTreasuryData.length - 1];
        const currentTreasuryRate = latestTreasuryEntry.rate;
        const lastTimestamp = latestTreasuryEntry.timestamp; // Seconds
        logDebug(`Latest Treasury Rate: ${currentTreasuryRate.toFixed(3)}% on ${new Date(lastTimestamp * 1000).toLocaleDateString()}`);

        // Find rate ~30 days ago
        const thirtyDaysInMillis = 30 * 24 * 60 * 60 * 1000;
        const targetTimestampRough = (lastTimestamp * 1000) - thirtyDaysInMillis; // Target timestamp in milliseconds

        let oneMonthAgoEntry = null;
        // Iterate backwards to find the *closest* trading day *on or before* the target time
        for (let i = validTreasuryData.length - 2; i >= 0; i--) { // Start from second-to-last
             const entryTimestampMillis = validTreasuryData[i].timestamp * 1000;
            if (entryTimestampMillis <= targetTimestampRough) {
                // Found the first suitable entry going back
                oneMonthAgoEntry = validTreasuryData[i];
                break; // Stop searching
            }
        }

        // If no suitable entry found (all data is too recent), use the oldest available
        if (!oneMonthAgoEntry && validTreasuryData.length > 0) {
             oneMonthAgoEntry = validTreasuryData[0];
             logDebug("Could not find Treasury rate ~30 days ago, using oldest available point.");
        } else if (!oneMonthAgoEntry) {
             throw new Error("Cannot determine Treasury rate from one month ago (no valid historical data found).")
        }

        const oneMonthAgoTreasuryRate = oneMonthAgoEntry.rate;
        logDebug(`Using Treasury Rate from ${new Date(oneMonthAgoEntry.timestamp * 1000).toLocaleDateString()} (~30 days prior): ${oneMonthAgoTreasuryRate.toFixed(3)}%`);

        const treasuryRateChange = currentTreasuryRate - oneMonthAgoTreasuryRate;
        // Use a small tolerance for floating point comparisons
        const isTreasuryFalling = treasuryRateChange < -0.0001;
        logDebug(`Treasury Rate Change: ${treasuryRateChange.toFixed(3)}%, Is Falling: ${isTreasuryFalling}`);

        // Return numbers for calculation purposes
        return {
            spy: spyPrice,
            sma220: sma220,
            spyStatus: spyStatus, // String ("Over" or "Under")
            volatility: annualizedVolatility,
            treasuryRate: currentTreasuryRate,
            isTreasuryFalling: isTreasuryFalling, // Boolean
            treasuryRateChange: treasuryRateChange,
        };

    } catch (error) {
        console.error("[ERROR] fetchCheckFinancialData failed:", error.response?.data || error.message);
        // Improve error context
        const errorMessage = error.response?.data?.chart?.error?.description || error.message || "An unknown error occurred";
        throw new Error(`Failed to fetch or process MFEA data: ${errorMessage}`);
    }
}

async function fetchTickerFinancialData(ticker, range) {
    logDebug(`Initiating fetchTickerFinancialData for ${ticker}, range ${range}...`);
    const rangeOptions = {
        '1d': { range: '1d', interval: '5m' },   // Intraday: 5m interval
        '1mo': { range: '1mo', interval: '90m' }, // Monthly: 90m or 1d interval
        '1y': { range: '1y', interval: '1d' },   // Yearly: Daily interval
        '3y': { range: '3y', interval: '1wk' },  // Multi-year: Weekly interval
        '10y': { range: '10y', interval: '1mo' }, // Decade: Monthly interval
    };

    const selectedRange = rangeOptions[range] ? range : '1d';
    const { range: yahooRange, interval } = rangeOptions[selectedRange];
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${yahooRange}`;
    logDebug(`Fetching URL: ${url}`);

    try {
        const response = await axios.get(url, { timeout: 10000 }); // Add timeout

        const result = response.data?.chart?.result?.[0];
        if (!result?.meta?.regularMarketPrice || !result?.timestamp || !result?.indicators) {
             // Check for specific Yahoo error message first
             if (response.data?.chart?.error?.description) {
                 throw new Error(`Yahoo Finance Error: ${response.data.chart.error.description}`);
             }
            throw new Error("Invalid or incomplete data structure received from Yahoo Finance.");
        }

        const currentPrice = parseFloat(result.meta.regularMarketPrice);
        const timestamps = result.timestamp;
        let prices = [];

        // Prefer adjclose, fallback to close
        if (result.indicators.adjclose?.[0]?.adjclose?.length > 0) {
            prices = result.indicators.adjclose[0].adjclose;
        } else if (result.indicators.quote?.[0]?.close?.length > 0) {
            prices = result.indicators.quote[0].close;
        } else {
            throw new Error("Could not find valid price data (adjclose or close) in the response.");
        }

        // Pair timestamps with prices and filter out any null/invalid entries
        const validDataPoints = timestamps
            .map((ts, i) => ({ timestamp: ts, price: prices[i] }))
            .filter(dp => dp.timestamp != null && typeof dp.price === 'number')
            .sort((a, b) => a.timestamp - b.timestamp); // Ensure chronological order

        if (validDataPoints.length === 0) {
            throw new Error("No valid historical data points found after filtering.");
        }

        // Prepare data for charting with appropriate date labels
        const historicalData = validDataPoints.map(dp => {
            const dateObj = new Date(dp.timestamp * 1000);
            let dateLabel = '';

            // Adjust formatting based on interval/range for clarity on the chart
            if (interval.includes('m')) { // Intraday (e.g., '5m', '90m')
                dateLabel = dateObj.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
            } else if (interval === '1d' || interval === '1wk') { // Daily or Weekly
                dateLabel = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            } else { // Monthly ('1mo') interval (for 10y range)
                 dateLabel = dateObj.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
            }

            return {
                date: dateLabel, // String label for chart
                price: dp.price   // Keep price as number
            };
        });

        return {
            ticker: ticker.toUpperCase(),
            currentPrice: currentPrice, // Number
            historicalData: historicalData, // Array of { date: string, price: number }
            selectedRange: selectedRange.toUpperCase(), // String (e.g., "1D", "1Y")
        };

    } catch (error) {
        console.error(`[ERROR] fetchTickerFinancialData for ${ticker} failed:`, error.response?.data || error.message);
        const errorMessage = error.response?.data?.chart?.error?.description || error.message || "An unknown error occurred";
        throw new Error(`Failed to fetch data for ${ticker.toUpperCase()}: ${errorMessage}`);
    }
}


// --- Main Handler (Vercel Serverless Function) ---
module.exports = async (req, res) => {
    logDebug(`Request received: ${req.method} ${req.url}`);

    if (req.method !== "POST") {
        logDebug("Method not allowed.");
        res.setHeader("Allow", "POST");
        return res.status(405).json({ error: "Method Not Allowed" });
    }

    const signature = req.headers["x-signature-ed25519"] || '';
    const timestamp = req.headers["x-signature-timestamp"] || '';
    let rawBody;

    try {
        // Buffer needed for verifyKey, getRawBody handles this
        rawBody = await getRawBody(req, { encoding: "utf-8" });
    } catch (err) {
        logDebug("Failed to get raw body.");
        return res.status(400).json({ error: "Invalid request body" });
    }

    const isValidRequest = verifyKey(rawBody, signature, timestamp, process.env.PUBLIC_KEY);
    if (!isValidRequest) {
        console.error("[ERROR] Invalid request signature.");
        return res.status(401).json({ error: "Bad request signature" });
    }
    logDebug("Request signature verified.");

    let message;
    try {
         message = JSON.parse(rawBody);
    } catch (e) {
         logDebug("Failed to parse request body JSON.");
         return res.status(400).json({ error: "Invalid JSON" });
    }


    logDebug(`Interaction Type: ${message.type}`);

    // --- Interaction Handling ---

    // Type 1: PING
    if (message.type === InteractionType.PING) {
        logDebug("Handling PING");
        return res.status(200).json({ type: InteractionResponseType.PONG });
    }

    // Type 2: APPLICATION_COMMAND
    if (message.type === InteractionType.APPLICATION_COMMAND) {
        const commandName = message.data.name.toLowerCase();
        const interactionToken = message.token;
        const applicationId = process.env.APP_ID;

        // Function to send follow-up messages
        const sendFollowUp = async (data) => {
             const url = `https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}/messages/@original`;
             logDebug(`Sending PATCH to ${url}`);
             try {
                  await axios.patch(url, data);
                  logDebug("Follow-up message sent successfully.");
             } catch (error) {
                  console.error(`[ERROR] Failed to send follow-up message: ${error.response?.status} ${error.response?.statusText}`, error.response?.data || error.message);
             }
        };

        // Defer reply immediately for commands that fetch data
        if (commandName === CHECK_COMMAND.name.toLowerCase() || commandName === TICKER_COMMAND.name.toLowerCase()) {
            logDebug(`Deferring reply for /${commandName}`);
            res.status(200).json({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });
        }

        switch (commandName) {
            case HI_COMMAND.name.toLowerCase():
                logDebug("Handling /hi command");
                // Send immediate response for simple commands
                return res.status(200).json({
                    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                    data: { content: "hii <3 :)" }, // Slightly changed response
                });

            case CHECK_COMMAND.name.toLowerCase():
                logDebug("Handling /check command (deferred)");
                try {
                    const financialData = await fetchCheckFinancialData();
                    const { category, allocation } = determineRiskCategory(financialData);

                    // Format Treasury Trend using the numeric change value
                    let treasuryRateTrendValue = "";
                    const change = financialData.treasuryRateChange;
                    const changePercentAbs = Math.abs(change).toFixed(3);
                    const timeframeDesc = "~30d ago"; // Clarify timeframe approximate nature

                    if (change > 0.0001) {
                        treasuryRateTrendValue = `⬆️ Increasing by ${changePercentAbs}% (vs ${timeframeDesc})`;
                    } else if (change < -0.0001) {
                        treasuryRateTrendValue = `⬇️ Decreasing by ${changePercentAbs}% (vs ${timeframeDesc})`;
                    } else {
                        treasuryRateTrendValue = `↔️ Stable (vs ${timeframeDesc})`;
                    }

                    const embed = {
                        title: "MFEA Analysis Status",
                        color: 0x3498DB, // Example color
                        fields: [
                            { name: "SPY Price", value: `$${financialData.spy.toFixed(2)}`, inline: true },
                            { name: "220d SMA", value: `$${financialData.sma220.toFixed(2)}`, inline: true },
                            { name: "SPY vs SMA", value: financialData.spyStatus, inline: true },
                            { name: "Volatility (21d)", value: `${financialData.volatility.toFixed(2)}%`, inline: true },
                            { name: "3M Treasury Rate", value: `${financialData.treasuryRate.toFixed(3)}%`, inline: true },
                            { name: "Treasury Trend", value: treasuryRateTrendValue, inline: true },
                            { name: "📈 Risk Category", value: category, inline: false },
                            { name: "💡 Allocation", value: `**${allocation}**`, inline: false },
                        ],
                         footer: { text: "Data sourced from Yahoo Finance. Analysis is informational." },
                         timestamp: new Date().toISOString(),
                    };

                    await sendFollowUp({ embeds: [embed] });

                } catch (error) {
                    console.error("[ERROR] Failed /check execution:", error);
                     await sendFollowUp({ content: `⚠️ Error running /check: ${error.message}` });
                }
                return; // End execution here for deferred commands

            case TICKER_COMMAND.name.toLowerCase():
                 logDebug("Handling /ticker command (deferred)");
                 try {
                     const options = message.data.options || [];
                     const tickerOption = options.find(opt => opt.name === "symbol");
                     const timeframeOption = options.find(opt => opt.name === "timeframe");

                     // Should be guaranteed by Discord, but good to check
                     if (!tickerOption || !timeframeOption) {
                         throw new Error("Missing required options (symbol or timeframe).");
                     }
                     const ticker = tickerOption.value.toUpperCase();
                     const timeframe = timeframeOption.value;

                     const tickerData = await fetchTickerFinancialData(ticker, timeframe);

                     // Generate Chart URL using QuickChart.io
                     const chartConfig = {
                         type: 'line',
                         data: {
                             labels: tickerData.historicalData.map(entry => entry.date),
                             datasets: [{
                                 label: `${tickerData.ticker} Price`,
                                 // Ensure price is formatted to 2 decimal places for display on chart if needed
                                 data: tickerData.historicalData.map(entry => entry.price),
                                 borderColor: 'rgb(54, 162, 235)', // Blue
                                 backgroundColor: 'rgba(54, 162, 235, 0.2)',
                                 borderWidth: 1.5,
                                 pointRadius: 0,
                                 fill: true,
                                 tension: 0.1
                             }]
                         },
                         options: {
                             scales: {
                                 x: {
                                     title: { display: true, text: 'Time / Date', color: '#ccc' },
                                     ticks: { color: '#ccc', maxRotation: 0, autoSkip: true, maxTicksLimit: 10 },
                                     grid: { color: 'rgba(255, 255, 255, 0.1)' }
                                 },
                                 y: {
                                     title: { display: true, text: 'Price (USD)', color: '#ccc' },
                                     ticks: { color: '#ccc', callback: value => `$${Number(value).toFixed(2)}` },
                                     grid: { color: 'rgba(255, 255, 255, 0.1)' }
                                 }
                             },
                             plugins: {
                                 legend: { labels: { color: '#ccc' } },
                                 tooltip: {
                                     mode: 'index',
                                     intersect: false,
                                     callbacks: {
                                         label: context => `${context.dataset.label}: $${Number(context.parsed.y).toFixed(2)}`
                                     }
                                 }
                             }
                         }
                     };
                     const chartConfigEncoded = encodeURIComponent(JSON.stringify(chartConfig));
                      // Dark background, adjusted size
                     const chartUrl = `https://quickchart.io/chart?w=600&h=350&v=4&c=${chartConfigEncoded}&backgroundColor=rgb(47,49,54)`;

                     const tickerEmbed = {
                         title: `${tickerData.ticker} Chart (${tickerData.selectedRange})`,
                         color: 0x3498DB, // Blue
                         fields: [
                             { name: "Current Price", value: `$${tickerData.currentPrice.toFixed(2)}`, inline: true },
                             { name: "Timeframe", value: tickerData.selectedRange, inline: true },
                         ],
                         image: { url: chartUrl },
                          footer: { text: "Data via Yahoo Finance | Chart via QuickChart.io" },
                          timestamp: new Date().toISOString(),
                     };

                     await sendFollowUp({ embeds: [tickerEmbed] });

                 } catch (error) {
                     console.error("[ERROR] Failed /ticker execution:", error);
                      // Give user feedback based on the error type
                      const userErrorMessage = error.message.includes("Yahoo Finance Error:") || error.message.includes("Failed to fetch data for")
                           ? error.message
                           : "An error occurred while processing the ticker request.";
                      await sendFollowUp({ content: `⚠️ ${userErrorMessage}` });
                 }
                 return; // End execution here for deferred commands

            default:
                logDebug(`Unknown command received: ${commandName}`);
                 // Send immediate response for unknown command
                 return res.status(400).json({
                      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                      data: { content: "😕 Sorry, I don't recognize that command." }
                 });
        }
    }

    // Fallback for unknown interaction types
    logDebug(`Unknown Interaction Type received: ${message.type}`);
    return res.status(400).json({ error: "Unknown Interaction Type" });
};
