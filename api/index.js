// index.js - Using fixed 21 TRADING DAY lookback for Treasury change
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

// Helper function to fetch financial data for /check command (USING 21 TRADING DAY LOOKBACK)
async function fetchCheckFinancialData() {
    try {
        logDebug("Fetching data for /check command...");
        const [spySMAResponse, treasuryResponse, spyVolResponse] = await Promise.all([
            axios.get("https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=220d"),
            axios.get("https://query1.finance.yahoo.com/v8/finance/chart/%5EIRX?interval=1d&range=50d"), // Keep 50d range to ensure enough history
            axios.get("https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=40d"),
        ]);

        // --- SPY Price and SMA (Unchanged) ---
        const spyData = spySMAResponse.data;
        const spyPrice = spyData.chart.result[0].meta.regularMarketPrice;
        const spyAdjClosePrices = spyData.chart.result[0].indicators.adjclose[0].adjclose;
        if (!spyAdjClosePrices || spyAdjClosePrices.length < 220) {
            throw new Error("Not enough data to calculate 220-day SMA.");
        }
        const sum220 = spyAdjClosePrices.slice(-220).reduce((acc, price) => acc + (price || 0), 0);
        const sma220 = (sum220 / 220);
        const spyStatus = spyPrice > sma220 ? "Over" : "Under";
        logDebug(`SPY Price: ${spyPrice}, SMA220: ${sma220.toFixed(2)}, Status: ${spyStatus}`);


        // --- Treasury Data Processing (USING 21 TRADING DAY LOOKBACK) ---
        const treasuryData = treasuryResponse.data.chart.result[0];
         if (!treasuryData || !treasuryData.indicators?.quote?.[0]?.close || !treasuryData.timestamp) {
             throw new Error("Invalid or incomplete Treasury (^IRX) data structure from Yahoo Finance.");
         }
        const treasuryRatesRaw = treasuryData.indicators.quote[0].close;
        const treasuryTimestampsRaw = treasuryData.timestamp;

        const validTreasuryData = treasuryTimestampsRaw
            .map((ts, i) => ({ timestamp: ts, rate: treasuryRatesRaw[i] }))
            .filter(item => item.timestamp != null && typeof item.rate === 'number')
            .sort((a, b) => a.timestamp - b.timestamp); // Ensure chronological order is essential here

        // We need at least 22 data points to look back 21 trading days from the latest
        if (validTreasuryData.length < 22) {
            throw new Error(`Not enough valid Treasury data points for 21 trading day lookback (need 22, got ${validTreasuryData.length}).`);
        }

        // Get the latest rate and timestamp (index length - 1)
        const lastIndex = validTreasuryData.length - 1;
        const latestTreasuryEntry = validTreasuryData[lastIndex];
        const currentTreasuryRateValue = latestTreasuryEntry.rate;
        logDebug(`Current Rate: ${currentTreasuryRateValue} @ Index ${lastIndex} (${new Date(latestTreasuryEntry.timestamp * 1000).toISOString()})`);

        // --- Calculate the index for 21 trading days ago ---
        const targetIndex = lastIndex - 21;
        // The check `validTreasuryData.length < 22` above ensures targetIndex is >= 0
        const oneMonthAgoEntry = validTreasuryData[targetIndex];
        // --- End of 21 Trading Day Lookback ---

        logDebug(`Using Rate from 21 Trading Days Ago: ${oneMonthAgoEntry.rate} @ Index ${targetIndex} (${new Date(oneMonthAgoEntry.timestamp * 1000).toISOString()})`);
        const oneMonthAgoTreasuryRateValue = oneMonthAgoEntry.rate;

        // Calculate change (as numbers first)
        const treasuryRateChangeValue = currentTreasuryRateValue - oneMonthAgoTreasuryRateValue;
        logDebug(`Treasury Rate Change (value): ${currentTreasuryRateValue} - ${oneMonthAgoTreasuryRateValue} = ${treasuryRateChangeValue}`);
        const isTreasuryFalling = treasuryRateChangeValue < -0.0001; // Use tolerance
        logDebug(`Is Treasury Rate Falling: ${isTreasuryFalling}`);


        // --- Volatility Calculation (Unchanged) ---
        const spyVolData = spyVolResponse.data;
        const spyVolAdjClose = spyVolData.chart.result[0].indicators.adjclose[0].adjclose;
        if (!spyVolAdjClose || spyVolAdjClose.length < 21) {
            throw new Error("Not enough data to calculate 21-day volatility.");
        }
        const spyVolDailyReturns = spyVolAdjClose.slice(1).map((price, idx) => {
            const prevPrice = spyVolAdjClose[idx];
            return prevPrice === 0 ? 0 : (price / prevPrice - 1);
        });
        const recentReturns = spyVolDailyReturns.slice(-21);
        if (recentReturns.length < 21) {
            throw new Error(`Not enough final data points for 21-day volatility calculation (got ${recentReturns.length}).`);
        }
        const meanReturn = recentReturns.reduce((acc, r) => acc + r, 0) / recentReturns.length;
        const variance = recentReturns.reduce((acc, r) => acc + Math.pow(r - meanReturn, 2), 0) / recentReturns.length;
        const dailyVolatility = Math.sqrt(variance);
        const annualizedVolatility = (dailyVolatility * Math.sqrt(252) * 100);
        logDebug(`Calculated Annualized Volatility (21 trading days, original method): ${annualizedVolatility.toFixed(2)}%`);

        // --- Return results formatted as strings (Unchanged) ---
        return {
            spy: parseFloat(spyPrice).toFixed(2),
            sma220: sma220.toFixed(2),
            spyStatus: spyStatus,
            volatility: annualizedVolatility.toFixed(2),
            treasuryRate: currentTreasuryRateValue.toFixed(3),
            isTreasuryFalling: isTreasuryFalling,
            treasuryRateChange: treasuryRateChangeValue.toFixed(3), // Format final change to string
        };
    } catch (error) {
        console.error("Error fetching financial data:", error);
        // Add more specific error logging if available
        if (error.response) {
            console.error("Axios Error Data:", error.response.data);
            console.error("Axios Error Status:", error.response.status);
        }
        // Re-throw generic message as per original code
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

            return {
                date: dateLabel,
                price: prices[index],
            };
        });

        // Original 10y aggregation logic
        let aggregatedData = historicalData;
        if (selectedRange === '10y') {
             const validHistoricalData = historicalData.filter(entry => typeof entry.price === 'number');
             if (validHistoricalData.length > 0) {
                 const monthlyMap = {};
                 validHistoricalData.forEach(entry => {
                     const dateStr = entry.date;
                     let dateObj;
                     if (dateStr.includes(',')) {
                         dateObj = new Date(dateStr);
                     } else if (dateStr.includes(' ')) {
                         dateObj = new Date(dateStr.replace(' ', ' 1, '));
                     }

                      if (dateObj && !isNaN(dateObj)) {
                          const monthKey = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, '0')}`;
                          if (!monthlyMap[monthKey]) {
                               const monthLabel = dateObj.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
                              monthlyMap[monthKey] = { sum: 0, count: 0, label: monthLabel };
                          }
                          monthlyMap[monthKey].sum += entry.price;
                          monthlyMap[monthKey].count += 1;
                     } else {
                        logDebug(`Could not parse date for aggregation: ${entry.date}`);
                     }
                 });
                 aggregatedData = Object.keys(monthlyMap).sort().map(monthKey => {
                     const avgPrice = monthlyMap[monthKey].sum / monthlyMap[monthKey].count;
                     return {
                         date: monthlyMap[monthKey].label,
                         price: parseFloat(avgPrice).toFixed(2),
                     };
                 });
             } else {
                 aggregatedData = [];
             }
        }

        // Original return structure
        return {
            ticker: ticker.toUpperCase(),
            currentPrice: `$${currentPrice}`,
            historicalData: aggregatedData,
            selectedRange: selectedRange,
        };
    } catch (error) {
        console.error("Error fetching financial data:", error);
        throw new Error(
            error.response?.data?.chart?.error?.description
                ? error.response.data.chart.error.description
                : "Failed to fetch financial data."
        );
    }
}

// Main handler (Using original display logic for /check trend)
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

    // Ensure PUBLIC_KEY environment variable is set
    if (!process.env.PUBLIC_KEY) {
        console.error("[ERROR] PUBLIC_KEY environment variable is not set.");
        return res.status(500).json({ error: "Internal server configuration error."});
    }

    const isValidRequest = verifyKey(
        rawBody,
        signature,
        timestamp,
        process.env.PUBLIC_KEY
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
                    const financialData = await fetchCheckFinancialData(); // Uses 21 TRADING DAY lookback
                    const { category, allocation } = determineRiskCategory(financialData);

                    // --- Using ORIGINAL Treasury Rate Trend Display Logic ---
                    let treasuryRateTrendValue = "";
                    const treasuryRateTimeframe = "last month"; // Still use this text label
                    const changeNum = parseFloat(financialData.treasuryRateChange);

                    if (changeNum > 0.0001) { // Use tolerance
                        treasuryRateTrendValue = `⬆️ Increasing by ${Math.abs(changeNum).toFixed(3)}% since ${treasuryRateTimeframe}`;
                    } else if (changeNum < -0.0001) { // Use tolerance
                        treasuryRateTrendValue = `⬇️ ${Math.abs(changeNum).toFixed(3)}% since ${treasuryRateTimeframe}`;
                    } else {
                        treasuryRateTrendValue = "↔️ No change since last month";
                    }
                    // --- End of Original Display Logic ---

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
                                        { name: "Treasury Rate Trend", value: treasuryRateTrendValue, inline: true }, // Original field name/value format
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
                        // Include error message from fetch function if possible
                        data: { content: `⚠️ Unable to retrieve financial data: ${error.message || 'Please try again later.'}` }
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
                    const timeframe = timeframeOption ? timeframeOption.value : '1d';
                    if (!ticker) {
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
                            labels: tickerData.historicalData.map(entry => entry.date),
                            datasets: [{
                                label: `${tickerData.ticker} Price`,
                                data: tickerData.historicalData.map(entry => entry.price),
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
                                        label: function(context) {
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
                            { name: "Current Price", value: tickerData.currentPrice, inline: true },
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
