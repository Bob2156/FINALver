// index.js - Modified original code with ONLY Treasury change fix
"use strict";

const {
    InteractionResponseType,
    InteractionType,
    verifyKey,
} = require("discord-interactions");
const getRawBody = require("raw-body");
const axios = require("axios");

// Define your commands (Unchanged from original)
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

// Preset image URL for /ticker command (Test Mode) - Unchanged
const PRESET_IMAGE_URL = "https://th.bing.com/th/id/R.aeccf9d26746b036234619be80502098?rik=JZrA%2f9rIOJ3Fxg&riu=http%3a%2f%2fwww.clipartbest.com%2fcliparts%2fbiy%2fE8E%2fbiyE8Er5T.jpeg&ehk=FOPbyrcgKCZzZorMhY69pKoHELUk3FiBPDkgwkqNvis%3d&risl=&pid=ImgRaw&r=0";

// Helper function to log debug messages (Unchanged from original)
function logDebug(message) {
    console.log(`[DEBUG] ${message}`);
}

// Helper function to determine risk category and allocation (Unchanged from original)
function determineRiskCategory(data) {
    // Convert string values to numbers before comparison (As per original code)
    const spyValue = parseFloat(data.spy);
    const sma220Value = parseFloat(data.sma220);
    const volatilityValue = parseFloat(data.volatility);

    logDebug(`Determining risk category with SPY: ${data.spy}, SMA220: ${data.sma220}, Volatility: ${data.volatility}%, Treasury Rate: ${data.treasuryRate}%, Is Treasury Falling: ${data.isTreasuryFalling}`);

    if (spyValue > sma220Value) {
        if (volatilityValue < 14) {
            return {
                category: "Risk On",
                allocation: "100% UPRO (3× leveraged S&P 500) or 3×(100% SPY)",
            };
        } else if (volatilityValue < 24) {
            return {
                category: "Risk Mid",
                allocation: "100% SSO (2× S&P 500) or 2×(100% SPY)",
            };
        } else {
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

// Helper function to fetch financial data for /check command (Treasury logic fixed)
async function fetchCheckFinancialData() {
    try {
        logDebug("Fetching data for /check command...");
        // We fetch data for:
        // 1) 220 days for SMA (Original fetch)
        // 2) 50 days for 3‑month Treasury (Increased slightly to help find ~30 day point)
        // 3) 40 days for volatility (Original fetch)
        const [spySMAResponse, treasuryResponse, spyVolResponse] = await Promise.all([
            axios.get("https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=220d"),
            // Increased range slightly for treasury to improve odds of finding ~30 day point
            axios.get("https://query1.finance.yahoo.com/v8/finance/chart/%5EIRX?interval=1d&range=50d"),
            axios.get("https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=40d"), // Original separate volatility fetch
        ]);

        // --- SPY Price and SMA (Unchanged from original) ---
        const spyData = spySMAResponse.data;
        const spyPrice = spyData.chart.result[0].meta.regularMarketPrice;
        logDebug(`SPY Price: ${spyPrice}`);

        const spyAdjClosePrices = spyData.chart.result[0].indicators.adjclose[0].adjclose;
        if (!spyAdjClosePrices || spyAdjClosePrices.length < 220) {
            throw new Error("Not enough data to calculate 220-day SMA.");
        }
        const sum220 = spyAdjClosePrices.slice(-220).reduce((acc, price) => acc + (price || 0), 0); // Handle potential nulls in sum
        const sma220 = (sum220 / 220); // Keep as number for now
        logDebug(`220-day SMA: ${sma220.toFixed(2)}`);
        const spyStatus = spyPrice > sma220 ? "Over" : "Under";
        logDebug(`SPY Status: ${spyStatus} the 220-day SMA`);

        // --- Treasury Data Processing (FIXED LOGIC HERE) ---
        const treasuryData = treasuryResponse.data.chart.result[0];
         if (!treasuryData || !treasuryData.indicators?.quote?.[0]?.close || !treasuryData.timestamp) {
             throw new Error("Invalid or incomplete Treasury (^IRX) data structure from Yahoo Finance.");
         }
        const treasuryRatesRaw = treasuryData.indicators.quote[0].close;
        const treasuryTimestampsRaw = treasuryData.timestamp;

        // Combine timestamps and rates, filter nulls/invalids, and sort
        const validTreasuryData = treasuryTimestampsRaw
            .map((ts, i) => ({ timestamp: ts, rate: treasuryRatesRaw[i] }))
            .filter(item => item.timestamp != null && typeof item.rate === 'number')
            .sort((a, b) => a.timestamp - b.timestamp); // Ensure chronological order

        if (validTreasuryData.length === 0) {
            throw new Error("Treasury rate data is unavailable after filtering.");
        }

        // Get the latest rate and timestamp
        const latestTreasuryEntry = validTreasuryData[validTreasuryData.length - 1];
        const currentTreasuryRateValue = latestTreasuryEntry.rate; // Number
        const lastTimestamp = latestTreasuryEntry.timestamp; // Seconds
        logDebug(`Current 3-Month Treasury Rate (value): ${currentTreasuryRateValue} from ${new Date(lastTimestamp * 1000).toLocaleDateString()}`);

        // Find the rate from ~30 days ago using timestamps
        const thirtyDaysInMillis = 30 * 24 * 60 * 60 * 1000;
        const targetTimestampRough = (lastTimestamp * 1000) - thirtyDaysInMillis; // Target timestamp in milliseconds

        let oneMonthAgoEntry = null;
        // Iterate backwards to find the *closest* trading day *on or before* the target time
        for (let i = validTreasuryData.length - 2; i >= 0; i--) {
             const entryTimestampMillis = validTreasuryData[i].timestamp * 1000;
            if (entryTimestampMillis <= targetTimestampRough) {
                oneMonthAgoEntry = validTreasuryData[i];
                break;
            }
        }
        // Fallback: Use oldest if no suitable point found
        if (!oneMonthAgoEntry && validTreasuryData.length > 0) {
            oneMonthAgoEntry = validTreasuryData[0];
            logDebug("Could not find Treasury rate ~30 days ago, using oldest available point.");
        } else if (!oneMonthAgoEntry) {
             throw new Error("Cannot determine Treasury rate from one month ago (no valid historical data found).")
        }

        const oneMonthAgoTreasuryRateValue = oneMonthAgoEntry.rate; // Number
        logDebug(`Using Treasury Rate (value) from ${new Date(oneMonthAgoEntry.timestamp * 1000).toLocaleDateString()} (~30 days prior): ${oneMonthAgoTreasuryRateValue}`);

        // Calculate change (as numbers first)
        const treasuryRateChangeValue = currentTreasuryRateValue - oneMonthAgoTreasuryRateValue;
        logDebug(`Treasury Rate Change (value): ${treasuryRateChangeValue}`);
        // Determine fall status (use small tolerance for float comparison)
        const isTreasuryFalling = treasuryRateChangeValue < -0.0001;
        logDebug(`Is Treasury Rate Falling: ${isTreasuryFalling}`);

        // --- Volatility Calculation (Unchanged from original) ---
        const spyVolData = spyVolResponse.data;
        const spyVolAdjClose = spyVolData.chart.result[0].indicators.adjclose[0].adjclose;
         // Original code checked for < 21, implies need 21 prices for 20 returns? Let's stick to original check.
         // Note: Standard volatility usually uses N+1 prices for N returns. Original might be slightly off.
        if (!spyVolAdjClose || spyVolAdjClose.length < 21) {
            throw new Error("Not enough data to calculate 21-day volatility.");
        }
        // Original calculation logic:
        const spyVolDailyReturns = spyVolAdjClose.slice(1).map((price, idx) => {
            const prevPrice = spyVolAdjClose[idx];
            return prevPrice === 0 ? 0 : (price / prevPrice - 1); // Handle potential 0 price
        });
        const recentReturns = spyVolDailyReturns.slice(-21); // Original used last 21 returns from 40 day fetch
        if (recentReturns.length < 21) {
             // This condition might be hit if there were nulls filtered previously or less than 21 returns calculated
            throw new Error(`Not enough final data points for 21-day volatility calculation (got ${recentReturns.length}).`);
        }
        const meanReturn = recentReturns.reduce((acc, r) => acc + r, 0) / recentReturns.length;
        const variance = recentReturns.reduce((acc, r) => acc + Math.pow(r - meanReturn, 2), 0) / recentReturns.length;
        const dailyVolatility = Math.sqrt(variance);
        const annualizedVolatility = (dailyVolatility * Math.sqrt(252) * 100); // Number
        logDebug(`Calculated Annualized Volatility (21 trading days, original method): ${annualizedVolatility.toFixed(2)}%`);

        // --- Return results formatted as strings, matching original function's output contract ---
        return {
            spy: parseFloat(spyPrice).toFixed(2), // String, 2 decimals
            sma220: sma220.toFixed(2),           // String, 2 decimals
            spyStatus: spyStatus,                 // String ("Over" or "Under")
            volatility: annualizedVolatility.toFixed(2), // String, 2 decimals
            treasuryRate: currentTreasuryRateValue.toFixed(3), // String, 3 decimals
            isTreasuryFalling: isTreasuryFalling,           // Boolean
            treasuryRateChange: treasuryRateChangeValue.toFixed(3), // String, 3 decimals
        };
    } catch (error) {
        console.error("Error fetching financial data:", error);
        // Maintain original error throwing
        throw new Error("Failed to fetch financial data");
    }
}


// Helper function to fetch financial data for /ticker command (Unchanged from original)
async function fetchTickerFinancialData(ticker, range) {
    try {
        const rangeOptions = {
            '1d': { range: '1d', interval: '1m' },
            '1mo': { range: '1mo', interval: '5m' },
            '1y': { range: '1y', interval: '1d' },
            '3y': { range: '3y', interval: '1wk' },
            '10y': { range: '10y', interval: '1mo' },
        };

        const selectedRange = rangeOptions[range] ? range : '1d';
        const { range: yahooRange, interval } = rangeOptions[selectedRange];

        const tickerResponse = await axios.get(
            `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${yahooRange}`
        );
        const tickerData = tickerResponse.data;

        if (
            !tickerData.chart.result ||
            tickerData.chart.result.length === 0 ||
            !tickerData.chart.result[0].meta.regularMarketPrice
        ) {
            throw new Error("Invalid ticker symbol or data unavailable.");
        }

        const currentPrice = parseFloat(tickerData.chart.result[0].meta.regularMarketPrice).toFixed(2);
        const timestamps = tickerData.chart.result[0].timestamp;
        let prices = [];

        if (
            tickerData.chart.result[0].indicators.adjclose &&
            tickerData.chart.result[0].indicators.adjclose[0].adjclose
        ) {
            prices = tickerData.chart.result[0].indicators.adjclose[0].adjclose;
        } else if (
            tickerData.chart.result[0].indicators.quote &&
            tickerData.chart.result[0].indicators.quote[0].close
        ) {
            prices = tickerData.chart.result[0].indicators.quote[0].close;
        } else {
            throw new Error("Price data is unavailable.");
        }

        if (!timestamps || !prices || timestamps.length !== prices.length) {
            throw new Error("Incomplete historical data.");
        }

        const historicalData = timestamps.map((timestamp, index) => {
            const dateObj = new Date(timestamp * 1000);
            let dateLabel = '';

            if (selectedRange === '1d' || selectedRange === '1mo') {
                dateLabel = dateObj.toLocaleString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                });
            } else {
                dateLabel = dateObj.toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                });
            }

             // Original returned price potentially null or non-number if source was bad
            return {
                date: dateLabel,
                price: prices[index],
            };
        });

        // Original 10y aggregation logic
        let aggregatedData = historicalData;
        if (selectedRange === '10y') {
             // Filter out entries where price might not be a number before aggregation
             const validHistoricalData = historicalData.filter(entry => typeof entry.price === 'number');

             if (validHistoricalData.length > 0) {
                 const monthlyMap = {};
                 validHistoricalData.forEach(entry => {
                     // Extract YYYY-MM for grouping
                     const dateObj = new Date(entry.date); // Attempt to parse label back to date (might be fragile)
                      if (!isNaN(dateObj)) { // Check if date parsing worked
                          const monthKey = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, '0')}`;
                          if (!monthlyMap[monthKey]) {
                              monthlyMap[monthKey] = { sum: 0, count: 0, label: entry.date.slice(0, 7) }; // Use original label format slice
                          }
                          monthlyMap[monthKey].sum += entry.price;
                          monthlyMap[monthKey].count += 1;
                     }
                 });

                 aggregatedData = Object.keys(monthlyMap).sort().map(monthKey => { // Sort keys chronologically
                     const avgPrice = monthlyMap[monthKey].sum / monthlyMap[monthKey].count;
                     return {
                         date: monthlyMap[monthKey].label, // Use the derived label (e.g., 'Sep 2020')
                         price: parseFloat(avgPrice).toFixed(2), // Format as string like original
                     };
                 });
             } else {
                 aggregatedData = []; // No valid data to aggregate
             }
        }

        // Original return structure
        return {
            ticker: ticker.toUpperCase(),
            currentPrice: `$${currentPrice}`, // String with $
            historicalData: aggregatedData, // Aggregated potentially
            selectedRange: selectedRange, // Original used lowercase value
        };
    } catch (error) {
        console.error("Error fetching financial data:", error);
         // Original error re-throwing logic
        throw new Error(
            error.response?.data?.chart?.error?.description // Use optional chaining
                ? error.response.data.chart.error.description
                : "Failed to fetch financial data."
        );
    }
}

// Main handler (Unchanged from original)
module.exports = async (req, res) => {
    logDebug("Received a new request");

    if (req.method !== "POST") {
        logDebug("Invalid method, returning 405");
        res.status(405).json({ error: "Method Not Allowed" });
        return;
    }

    const signature = req.headers["x-signature-ed25519"];
    const timestamp = req.headers["x-signature-timestamp"];

    if (!signature || !timestamp) {
        console.error("[ERROR] Missing signature or timestamp headers");
        res.status(401).json({ error: "Bad request signature" });
        return;
    }

    let rawBody;
    try {
        rawBody = await getRawBody(req, { encoding: "utf-8" });
    } catch (error) {
        console.error("[ERROR] Failed to get raw body:", error);
        res.status(400).json({ error: "Invalid request body" });
        return;
    }

    let message;
    try {
        message = JSON.parse(rawBody);
    } catch (error) {
        console.error("[ERROR] Failed to parse JSON:", error);
        res.status(400).json({ error: "Invalid JSON format" });
        return;
    }

    const isValidRequest = verifyKey(
        rawBody,
        signature,
        timestamp,
        process.env.PUBLIC_KEY // Ensure PUBLIC_KEY env var is set
    );

    if (!isValidRequest) {
        console.error("[ERROR] Invalid request signature");
        res.status(401).json({ error: "Bad request signature" });
        return;
    }

    logDebug(`Message type: ${message.type}`);

    if (message.type === InteractionType.PING) {
        try {
            logDebug("Handling PING");
            res.status(200).json({ type: InteractionResponseType.PONG });
            logDebug("PONG sent");
            return;
        } catch (error) {
            console.error("[ERROR] Failed to handle PING:", error);
            res.status(500).json({ error: "Internal Server Error" });
            return;
        }
    }

    if (message.type === InteractionType.APPLICATION_COMMAND) {
        const commandName = message.data.name.toLowerCase();
        switch (commandName) {
            case HI_COMMAND.name.toLowerCase():
                try {
                    logDebug("Handling /hi command");
                    res.status(200).json({
                        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                        data: { content: "hii <3" },
                    });
                    logDebug("/hi command successfully executed");
                    return;
                } catch (error) {
                    console.error("[ERROR] Failed to execute /hi command:", error);
                    res.status(500).json({
                        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                        data: { content: "⚠️ An error occurred while processing your request." }
                    });
                    return;
                }

            case CHECK_COMMAND.name.toLowerCase():
                try {
                    logDebug("Handling /check command");
                    // Fetch financial data (uses the function with the fixed Treasury logic)
                    const financialData = await fetchCheckFinancialData();
                    // Determine risk category and allocation
                    const { category, allocation } = determineRiskCategory(financialData);
                    // Determine Treasury Rate Trend with Value and Timeframe
                    let treasuryRateTrendValue = "";
                    const treasuryRateTimeframe = "last month"; // Original timeframe description
                    // Use the string change value returned by fetchCheckFinancialData
                    const changeNum = parseFloat(financialData.treasuryRateChange); // Convert back to number for comparison
                    if (changeNum > 0) {
                        // Use the absolute value of the string for display
                        treasuryRateTrendValue = `⬆️ Increasing by ${financialData.treasuryRateChange}% since ${treasuryRateTimeframe}`;
                    } else if (changeNum < 0) {
                        // Use Math.abs on the number for display, keep original string sign logic
                         treasuryRateTrendValue = `⬇️ ${Math.abs(changeNum).toFixed(3)}% since ${treasuryRateTimeframe}`;
                    } else {
                        treasuryRateTrendValue = "↔️ No change since last month";
                    }
                    // Send the formatted embed with actual data and recommendation (original structure)
                    res.status(200).json({
                        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                        data: {
                            embeds: [
                                {
                                    title: "MFEA Analysis Status",
                                    color: 3447003,
                                    fields: [
                                        { name: "SPY Price", value: `$${financialData.spy}`, inline: true },
                                        { name: "220-day SMA", value: `$${financialData.sma220}`, inline: true },
                                        { name: "SPY Status", value: `${financialData.spyStatus} the 220-day SMA`, inline: true },
                                        { name: "Volatility", value: `${financialData.volatility}%`, inline: true },
                                        { name: "3-Month Treasury Rate", value: `${financialData.treasuryRate}%`, inline: true },
                                        { name: "Treasury Rate Trend", value: treasuryRateTrendValue, inline: true },
                                        { name: "📈 **Risk Category**", value: category, inline: false },
                                        { name: "💡 **Allocation Recommendation**", value: `**${allocation}**`, inline: false },
                                    ],
                                    footer: {
                                        text: "MFEA Recommendation based on current market conditions",
                                    },
                                },
                            ],
                        },
                    });
                    logDebug("/check command successfully executed with fetched data");
                    return;
                } catch (error) {
                    console.error("[ERROR] Failed to fetch financial data for /check command:", error);
                    res.status(500).json({
                        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                        data: { content: "⚠️ Unable to retrieve financial data at this time. Please try again later." }
                    });
                    return;
                }

            case TICKER_COMMAND.name.toLowerCase():
                try {
                    logDebug("Handling /ticker command");
                    const options = message.data.options;
                    const tickerOption = options.find(option => option.name === "symbol");
                    const timeframeOption = options.find(option => option.name === "timeframe");
                    const ticker = tickerOption ? tickerOption.value.toUpperCase() : null;
                    const timeframe = timeframeOption ? timeframeOption.value : '1d'; // Original default
                    if (!ticker) {
                        // Original error handling for missing ticker
                        res.status(400).json({
                            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                            data: { content: "❌ Ticker symbol is required." },
                        });
                        return;
                    }

                    const tickerData = await fetchTickerFinancialData(ticker, timeframe);

                    // Generate Chart Image URL using QuickChart.io (Original chart config)
                    const chartConfig = {
                        type: 'line',
                        data: {
                            // Map potentially non-numeric prices if aggregation didn't fix them
                            labels: tickerData.historicalData.map(entry => entry.date),
                            datasets: [{
                                label: `${tickerData.ticker} Price`,
                                data: tickerData.historicalData.map(entry => entry.price), // Pass data as is
                                borderColor: '#0070f3',
                                backgroundColor: 'rgba(0, 112, 243, 0.1)',
                                borderWidth: 2,
                                pointRadius: 0,
                                fill: true,
                            }]
                        },
                        options: { // Original options
                            scales: {
                                x: {
                                    title: { display: true, text: 'Date', color: '#333', font: { size: 14 } },
                                    ticks: { maxTicksLimit: 10, color: '#333', maxRotation: 0, minRotation: 0 },
                                    grid: { display: false }
                                },
                                y: {
                                    title: { display: true, text: 'Price ($)', color: '#333', font: { size: 14 } },
                                    ticks: { color: '#333' },
                                    grid: { color: 'rgba(0,0,0,0.1)', borderDash: [5, 5] }
                                }
                            },
                            plugins: {
                                legend: { display: true, labels: { color: '#333', font: { size: 12 } } },
                                tooltip: {
                                    enabled: true, mode: 'index', intersect: false,
                                    callbacks: {
                                        // Original tooltip formatting
                                        label: function(context) {
                                             // Attempt to format, default if not number
                                             const value = parseFloat(context.parsed?.y);
                                             return !isNaN(value) ? `$${value.toFixed(2)}` : 'N/A';
                                        }
                                    }
                                }
                            }
                        }
                    };
                    const chartConfigEncoded = encodeURIComponent(JSON.stringify(chartConfig));
                    const chartUrl = `https://quickchart.io/chart?c=${chartConfigEncoded}`;

                    // Original embed structure
                    const embed = {
                        title: `${tickerData.ticker} Financial Data`,
                        color: 3447003,
                        fields: [
                            { name: "Current Price", value: tickerData.currentPrice, inline: true }, // Uses string with $
                            // Original had timeframe and selected range duplicated? Kept as is.
                            { name: "Timeframe", value: timeframe.toUpperCase(), inline: true },
                            { name: "Selected Range", value: tickerData.selectedRange.toUpperCase(), inline: true },
                            { name: "Data Source", value: "Yahoo Finance", inline: true },
                        ],
                        image: { url: chartUrl },
                        footer: { text: "Data fetched from Yahoo Finance" },
                    };
                    res.status(200).json({
                        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                        data: { embeds: [embed] },
                    });
                    logDebug("/ticker command successfully executed with dynamic data and chart");
                    return;
                } catch (error) {
                    console.error("[ERROR] Failed to fetch financial data for /ticker command:", error);
                    // Original error message
                    res.status(500).json({
                        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                        data: { content: "⚠️ Unable to retrieve financial data at this time. Please ensure the ticker symbol is correct and try again later." }
                    });
                    return;
                }

            default:
                try {
                    console.error("[ERROR] Unknown command");
                    res.status(400).json({ error: "Unknown Command" });
                    return;
                } catch (error) {
                    console.error("[ERROR] Failed to handle unknown command:", error);
                    res.status(500).json({ error: "Internal Server Error" });
                    return;
                }
        }
    } else {
        try {
            console.error("[ERROR] Unknown request type");
            res.status(400).json({ error: "Unknown Type" });
            return;
        } catch (error) {
            console.error("[ERROR] Failed to handle unknown request type:", error);
            res.status(500).json({ error: "Internal Server Error" });
            return;
        }
    }
};
