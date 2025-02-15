// api/index.js

"use strict";

const {
    InteractionResponseType,
    InteractionType,
    verifyKey,
} = require("discord-interactions");
const getRawBody = require("raw-body");
const axios = require("axios");

// Define your commands
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

// Preset image URL for /ticker command (Test Mode)
const PRESET_IMAGE_URL = "https://th.bing.com/th/id/R.aeccf9d26746b036234619be80502098?rik=JZrA%2f9rIOJ3Fxg&riu=http%3a%2f%2fwww.clipartbest.com%2fcliparts%2fbiy%2fE8E%2fbiyE8Er5T.jpeg&ehk=FOPbyrcgKCZzZorMhY69pKoHELUk3FiBPDkgwkqNvis%3d&risl=&pid=ImgRaw&r=0";

// Helper function to log debug messages
function logDebug(message) {
    console.log(`[DEBUG] ${message}`);
}

// Helper function to determine risk category and allocation
function determineRiskCategory(data) {
    const { spy, sma220, volatility, treasuryRate, isTreasuryFalling } = data;

    logDebug(`Determining risk category with SPY: ${spy}, SMA220: ${sma220}, Volatility: ${volatility}%, Treasury Rate: ${treasuryRate}%, Is Treasury Falling: ${isTreasuryFalling}`);

    if (spy > sma220) {
        if (volatility < 14) {
            return {
                category: "Risk On",
                allocation: "100% UPRO (3× leveraged S&P 500) or 3×(100% SPY)",
            };
        } else if (volatility < 24) {
            return {
                category: "Risk Mid",
                allocation: "100% SSO (2× S&P 500) or 2×(100% SPY)",
            };
        } else {
            if (isTreasuryFalling) {
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
        if (isTreasuryFalling) {
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
        // We fetch data for:
        // 1) 220 days for SMA
        // 2) 30 days for 3‑month Treasury
        // 3) 40 days for volatility (ensures we get at least 21 trading days)
        const [spySMAResponse, treasuryResponse, spyVolResponse] = await Promise.all([
            axios.get("https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=220d"),
            axios.get("https://query1.finance.yahoo.com/v8/finance/chart/%5EIRX?interval=1d&range=30d"),
            axios.get("https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=40d"),
        ]);

        //
        // --- (A) 220-Day SMA & Current SPY Price ---
        //
        const spyData = spySMAResponse.data;
        // Current SPY price
        const spyPrice = spyData.chart.result[0].meta.regularMarketPrice;
        logDebug(`SPY Price: ${spyPrice}`);

        // Adjusted Close array for 220d
        const spyAdjClosePrices = spyData.chart.result[0].indicators.adjclose[0].adjclose;
        if (!spyAdjClosePrices || spyAdjClosePrices.length < 220) {
            throw new Error("Not enough data to calculate 220-day SMA.");
        }
        const sum220 = spyAdjClosePrices.slice(-220).reduce((acc, price) => acc + price, 0);
        const sma220 = (sum220 / 220).toFixed(2);
        logDebug(`220-day SMA: ${sma220}`);

        // Over/Under the SMA
        const spyStatus = spyPrice > sma220 ? "Over" : "Under";
        logDebug(`SPY Status: ${spyStatus} the 220-day SMA`);

        //
        // --- (B) 3‑Month Treasury Rate (30 Days) ---
        //
        const treasuryData = treasuryResponse.data;
        const treasuryRates = treasuryData.chart.result[0].indicators.quote[0].close;
        if (!treasuryRates || treasuryRates.length === 0) {
            throw new Error("Treasury rate data is unavailable.");
        }
        const currentTreasuryRate = parseFloat(treasuryRates[treasuryRates.length - 1]).toFixed(2);
        const oneMonthAgoTreasuryRate = treasuryRates.length >= 30
            ? parseFloat(treasuryRates[treasuryRates.length - 30]).toFixed(2)
            : parseFloat(treasuryRates[0]).toFixed(2);
        logDebug(`Current 3-Month Treasury Rate: ${currentTreasuryRate}%`);
        logDebug(`3-Month Treasury Rate 30 Days Ago: ${oneMonthAgoTreasuryRate}%`);

        const treasuryRateChange = (currentTreasuryRate - oneMonthAgoTreasuryRate).toFixed(2);
        logDebug(`Treasury Rate Change: ${treasuryRateChange}%`);
        const isTreasuryFalling = treasuryRateChange < 0;
        logDebug(`Is Treasury Rate Falling: ${isTreasuryFalling}`);

        //
        // --- (C) 21 Trading-Day Volatility from separate 40-day fetch ---
        //
        const spyVolData = spyVolResponse.data;
        const spyVolAdjClose = spyVolData.chart.result[0].indicators.adjclose[0].adjclose;

        if (!spyVolAdjClose || spyVolAdjClose.length < 21) {
            throw new Error("Not enough data to calculate 21-day volatility.");
        }

        // Compute daily returns over 40 days
        const spyVolDailyReturns = spyVolAdjClose
            .slice(1)
            .map((price, idx) => price / spyVolAdjClose[idx] - 1);

        // Slice the last 21 *actual* trading days
        const recentReturns = spyVolDailyReturns.slice(-21);
        if (recentReturns.length < 21) {
            throw new Error("Not enough final data for 21-day volatility calculation.");
        }

        // Annualize the volatility
        const meanReturn = recentReturns.reduce((acc, r) => acc + r, 0) / recentReturns.length;
        const variance = recentReturns.reduce((acc, r) => acc + Math.pow(r - meanReturn, 2), 0) / recentReturns.length;
        const dailyVolatility = Math.sqrt(variance);
        const annualizedVolatility = (dailyVolatility * Math.sqrt(252) * 100).toFixed(2);
        logDebug(`Calculated Annualized Volatility (21 trading days): ${annualizedVolatility}%`);

        return {
            spy: parseFloat(spyPrice).toFixed(2),
            sma220: parseFloat(sma220).toFixed(2),
            spyStatus: spyStatus,
            volatility: parseFloat(annualizedVolatility).toFixed(2),
            treasuryRate: parseFloat(currentTreasuryRate).toFixed(2),
            isTreasuryFalling: isTreasuryFalling,
            treasuryRateChange: parseFloat(treasuryRateChange).toFixed(2), 
        };
    } catch (error) {
        console.error("Error fetching financial data:", error);
        throw new Error("Failed to fetch financial data");
    }
}

// Helper function to fetch financial data for /ticker command
async function fetchTickerFinancialData(ticker, range) {
    try {
        // Define valid ranges and corresponding intervals
        const rangeOptions = {
            '1d': { range: '1d', interval: '1m' },
            '1mo': { range: '1mo', interval: '5m' },
            '1y': { range: '1y', interval: '1d' },
            '3y': { range: '3y', interval: '1wk' },
            '10y': { range: '10y', interval: '1mo' },
        };
    
        // Set default range if not provided or invalid
        const selectedRange = rangeOptions[range] ? range : '1d';
        const { range: yahooRange, interval } = rangeOptions[selectedRange];
    
        // Fetch the financial data for the specified ticker and range
        const tickerResponse = await axios.get(
            `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${yahooRange}`
        );
        const tickerData = tickerResponse.data;
    
        // Check if the response contains valid data
        if (
            !tickerData.chart.result ||
            tickerData.chart.result.length === 0 ||
            !tickerData.chart.result[0].meta.regularMarketPrice
        ) {
            throw new Error("Invalid ticker symbol or data unavailable.");
        }
    
        // Extract current price
        const currentPrice = parseFloat(tickerData.chart.result[0].meta.regularMarketPrice).toFixed(2);
    
        // Extract historical prices and timestamps
        const timestamps = tickerData.chart.result[0].timestamp;
        let prices = [];
    
        // Determine if adjclose is available
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
    
        // Handle missing data
        if (!timestamps || !prices || timestamps.length !== prices.length) {
            throw new Error("Incomplete historical data.");
        }
    
        // Prepare historical data for Chart.js
        const historicalData = timestamps.map((timestamp, index) => {
            const dateObj = new Date(timestamp * 1000);
            let dateLabel = '';
    
            if (selectedRange === '1d' || selectedRange === '1mo') {
                // Include time for intraday data
                dateLabel = dateObj.toLocaleString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                });
            } else {
                // Only date for daily and longer intervals
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
    
        // Optional: Aggregate data for longer ranges to reduce data points
        let aggregatedData = historicalData;
        if (selectedRange === '10y') {
            // Aggregate monthly averages for 10-year data
            const monthlyMap = {};
            historicalData.forEach(entry => {
                // Example: "Sep 2024"
                // We'll just take the first 3 chars for month (or more robust date approach).
                // This is an oversimplification, but it works for demonstration.
                const month = entry.date.slice(0, 7); 
                if (!monthlyMap[month]) {
                    monthlyMap[month] = [];
                }
                monthlyMap[month].push(entry.price);
            });
    
            aggregatedData = Object.keys(monthlyMap).map(month => {
                const avgPrice = monthlyMap[month].reduce((sum, p) => sum + p, 0) / monthlyMap[month].length;
                return {
                    date: month,
                    price: parseFloat(avgPrice).toFixed(2),
                };
            });
        }
    
        return {
            ticker: ticker.toUpperCase(),
            currentPrice: `$${currentPrice}`,
            historicalData: aggregatedData,
            selectedRange: selectedRange,
        };
    } catch (error) {
        console.error("Error fetching financial data:", error);
        throw new Error(
            error.response && error.response.data && error.response.data.chart && error.response.data.chart.error
                ? error.response.data.chart.error.description
                : "Failed to fetch financial data."
        );
    }
}

// Main handler
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
        rawBody = await getRawBody(req, {
            encoding: "utf-8",
        });
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

                    // Fetch financial data
                    const financialData = await fetchCheckFinancialData();

                    // Determine risk category and allocation
                    const { category, allocation } = determineRiskCategory(financialData);

                    // Determine Treasury Rate Trend with Value and Timeframe
                    let treasuryRateTrendValue = "";
                    const treasuryRateTimeframe = "last month"; // We fetched data from 30 days ago

                    if (financialData.treasuryRateChange > 0) {
                        treasuryRateTrendValue = `⬆️ Increasing by ${financialData.treasuryRateChange}% since ${treasuryRateTimeframe}`;
                    } else if (financialData.treasuryRateChange < 0) {
                        treasuryRateTrendValue = `⬇️ ${Math.abs(financialData.treasuryRateChange)}% since ${treasuryRateTimeframe}`;
                    } else {
                        treasuryRateTrendValue = "↔️ No change since last month";
                    }

                    // Send the formatted embed with actual data and recommendation
                    res.status(200).json({
                        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                        data: {
                            embeds: [
                                {
                                    title: "MFEA Analysis Status",
                                    color: 3447003, // Blue banner
                                    fields: [
                                        { name: "SPY Price", value: `$${financialData.spy}`, inline: true },
                                        { name: "220-day SMA", value: `$${financialData.sma220}`, inline: true },
                                        { name: "SPY Status", value: `${financialData.spyStatus} the 220-day SMA`, inline: true },
                                        { name: "Volatility", value: `${financialData.volatility}%`, inline: true },
                                        { name: "3-Month Treasury Rate", value: `${financialData.treasuryRate}%`, inline: true },
                                        { name: "Treasury Rate Trend", value: treasuryRateTrendValue, inline: true },
                                        { 
                                            name: "📈 **Risk Category**", 
                                            value: category, 
                                            inline: false 
                                        },
                                        { 
                                            name: "💡 **Allocation Recommendation**", 
                                            value: `**${allocation}**`,
                                            inline: false 
                                        },
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

                    // Extract options
                    const options = message.data.options;
                    const tickerOption = options.find(option => option.name === "symbol");
                    const timeframeOption = options.find(option => option.name === "timeframe");

                    const ticker = tickerOption ? tickerOption.value.toUpperCase() : null;
                    const timeframe = timeframeOption ? timeframeOption.value : '1d'; // Default to '1d' if not provided

                    if (!ticker) {
                        res.status(400).json({
                            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                            data: { content: "❌ Ticker symbol is required." },
                        });
                        return;
                    }

                    // Fetch financial data for the specified ticker and timeframe
                    const tickerData = await fetchTickerFinancialData(ticker, timeframe);

                    // Generate Chart Image URL using QuickChart.io
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
                        options: {
                            scales: {
                                x: {
                                    title: {
                                        display: true,
                                        text: 'Date',
                                        color: '#333',
                                        font: {
                                            size: 14,
                                        }
                                    },
                                    ticks: {
                                        maxTicksLimit: 10,
                                        color: '#333',
                                        maxRotation: 0,
                                        minRotation: 0,
                                    },
                                    grid: {
                                        display: false,
                                    }
                                },
                                y: {
                                    title: {
                                        display: true,
                                        text: 'Price ($)',
                                        color: '#333',
                                        font: {
                                            size: 14,
                                        }
                                    },
                                    ticks: {
                                        color: '#333',
                                    },
                                    grid: {
                                        color: 'rgba(0,0,0,0.1)',
                                        borderDash: [5, 5],
                                    }
                                }
                            },
                            plugins: {
                                legend: {
                                    display: true,
                                    labels: {
                                        color: '#333',
                                        font: {
                                            size: 12,
                                        }
                                    }
                                },
                                tooltip: {
                                    enabled: true,
                                    mode: 'index',
                                    intersect: false,
                                    callbacks: {
                                        label: function(context) {
                                            return  `$${parseFloat(context.parsed.y).toFixed(2)}`;
                                        }
                                    }
                                }
                            }
                        }
                    };

                    // Encode chart configuration as JSON
                    const chartConfigEncoded = encodeURIComponent(JSON.stringify(chartConfig));

                    // Construct QuickChart.io URL
                    const chartUrl = `https://quickchart.io/chart?c=${chartConfigEncoded}`;

                    // Create Discord embed
                    const embed = {
                        title: `${tickerData.ticker} Financial Data`,
                        color: 3447003, // Blue color
                        fields: [
                            { name: "Current Price", value: tickerData.currentPrice, inline: true },
                            { name: "Timeframe", value: timeframe.toUpperCase(), inline: true },
                            { name: "Selected Range", value: timeframe.toUpperCase(), inline: true },
                            { name: "Data Source", value: "Yahoo Finance", inline: true },
                        ],
                        image: {
                            url: chartUrl,
                        },
                        footer: {
                            text: "Data fetched from Yahoo Finance",
                        },
                    };

                    // Send the embed as a response
                    res.status(200).json({
                        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                        data: {
                            embeds: [embed],
                        },
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
