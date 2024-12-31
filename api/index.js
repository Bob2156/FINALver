// api/index.js

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
        // Fetch SPY (price and historical data for 220 days) and Treasury Rate (30 days) concurrently
        const [spyResponse, treasuryResponse] = await Promise.all([
            axios.get("https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=220d"),
            axios.get("https://query1.finance.yahoo.com/v8/finance/chart/%5EIRX?interval=1d&range=30d"), // Fetch 30 days for Treasury rate
        ]);

        const spyData = spyResponse.data;
        const treasuryData = treasuryResponse.data;

        // Extract SPY price
        const spyPrice = spyData.chart.result[0].meta.regularMarketPrice;
        logDebug(`SPY Price: ${spyPrice}`);

        // Extract 220-day SMA from Adjusted Close
        const spyAdjClosePrices = spyData.chart.result[0].indicators.adjclose[0].adjclose;
        if (!spyAdjClosePrices || spyAdjClosePrices.length < 220) {
            throw new Error("Not enough data to calculate 220-day SMA.");
        }
        const sum220 = spyAdjClosePrices.slice(-220).reduce((acc, price) => acc + price, 0);
        const sma220 = (sum220 / 220).toFixed(2);
        logDebug(`220-day SMA: ${sma220}`);

        // Determine if SPY is over or under the 220-day SMA
        const spyStatus = spyPrice > sma220 ? "Over" : "Under";
        logDebug(`SPY Status: ${spyStatus} the 220-day SMA`);

        // Extract 3-Month Treasury Rate
        const treasuryRates = treasuryData.chart.result[0].indicators.quote[0].close;
        if (!treasuryRates || treasuryRates.length === 0) {
            throw new Error("Treasury rate data is unavailable.");
        }
        const currentTreasuryRate = parseFloat(treasuryRates[treasuryRates.length - 1]).toFixed(2);
        const oneMonthAgoTreasuryRate = treasuryRates.length >= 30
            ? parseFloat(treasuryRates[treasuryRates.length - 30]).toFixed(2)
            : parseFloat(treasuryRates[0]).toFixed(2); // Handle cases with less than 30 data points
        logDebug(`Current 3-Month Treasury Rate: ${currentTreasuryRate}%`);
        logDebug(`3-Month Treasury Rate 30 Days Ago: ${oneMonthAgoTreasuryRate}%`);

        // Determine Treasury Rate Change
        const treasuryRateChange = (currentTreasuryRate - oneMonthAgoTreasuryRate).toFixed(2);
        logDebug(`Treasury Rate Change: ${treasuryRateChange}%`);

        // Determine if Treasury rate is falling
        const isTreasuryFalling = treasuryRateChange < 0;
        logDebug(`Is Treasury Rate Falling: ${isTreasuryFalling}`);

        // Calculate Volatility from SPY Historical Data (21-Day Volatility)
        const dailyReturns = spyAdjClosePrices.slice(1).map((price, index) => {
            const previousPrice = spyAdjClosePrices[index];
            return (price / previousPrice - 1);
        });

        const recentReturns = dailyReturns.slice(-21); // Last 21 daily returns
        if (recentReturns.length < 21) {
            throw new Error("Not enough data to calculate 21-day volatility.");
        }

        const meanReturn = recentReturns.reduce((acc, r) => acc + r, 0) / recentReturns.length;
        const variance = recentReturns.reduce((acc, r) => acc + Math.pow(r - meanReturn, 2), 0) / recentReturns.length;
        const dailyVolatility = Math.sqrt(variance);
        const annualizedVolatility = (dailyVolatility * Math.sqrt(252) * 100).toFixed(2); // Annualized volatility as percentage
        logDebug(`Calculated Annualized Volatility: ${annualizedVolatility}%`);

        return {
            spy: parseFloat(spyPrice).toFixed(2),
            sma220: parseFloat(sma220).toFixed(2),
            spyStatus: spyStatus, // Added SPY Status
            volatility: parseFloat(annualizedVolatility).toFixed(2),
            treasuryRate: parseFloat(currentTreasuryRate).toFixed(2),
            isTreasuryFalling: isTreasuryFalling,
            treasuryRateChange: parseFloat(treasuryRateChange).toFixed(2), // Added Treasury Rate Change
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
        const tickerResponse = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${yahooRange}`);
    
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
                const month = entry.date.slice(0, 7); // 'Sep 2020'
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
        throw new Error(error.response && error.response.data && error.response.data.chart && error.response.data.chart.error
            ? error.response.data.chart.error.description
            : "Failed to fetch financial data.");
    }
}

// Main handler
module.exports = async (req, res) => {
    logDebug("Received a new request");

    if (req.method !== "POST") {
        logDebug("Invalid method, returning 405");
        res.status(405).json({ error: "Method Not Allowed" });
        return; // Terminate after responding
    }

    const signature = req.headers["x-signature-ed25519"];
    const timestamp = req.headers["x-signature-timestamp"];

    if (!signature || !timestamp) {
        console.error("[ERROR] Missing signature or timestamp headers");
        res.status(401).json({ error: "Bad request signature" });
        return; // Terminate after responding
    }

    let rawBody;
    try {
        rawBody = await getRawBody(req, {
            encoding: "utf-8",
        });
    } catch (error) {
        console.error("[ERROR] Failed to get raw body:", error);
        res.status(400).json({ error: "Invalid request body" });
        return; // Terminate after responding
    }

    let message;
    try {
        message = JSON.parse(rawBody);
    } catch (error) {
        console.error("[ERROR] Failed to parse JSON:", error);
        res.status(400).json({ error: "Invalid JSON format" });
        return; // Terminate after responding
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
        return; // Terminate after responding
    }

    logDebug(`Message type: ${message.type}`);

    if (message.type === InteractionType.PING) {
        logDebug("Handling PING");
        res.status(200).json({ type: InteractionResponseType.PONG });
        logDebug("PONG sent");
        return; // Terminate after responding
    }

    if (message.type === InteractionType.APPLICATION_COMMAND) {
        const commandName = message.data.name.toLowerCase();
        switch (commandName) {
            case HI_COMMAND.name.toLowerCase():
                logDebug("Handling /hi command");
                res.status(200).json({
                    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                    data: { content: "Hello! 👋 How can I assist you today?" },
                });
                logDebug("/hi command successfully executed");
                return; // Terminate after responding

            case CHECK_COMMAND.name.toLowerCase():
                logDebug("Handling /check command");

                try {
                    // Fetch financial data
                    const financialData = await fetchCheckFinancialData();

                    // Determine risk category and allocation
                    const { category, allocation } = determineRiskCategory(financialData);

                    // Determine Treasury Rate Trend with Timeframe
                    let treasuryRateTrendValue = "";
                    const treasuryRateTimeframe = "last month"; // Since we fetched 30 days ago

                    if (financialData.treasuryRateChange > 0) {
                        treasuryRateTrendValue = "⬆️ since " + treasuryRateTimeframe;
                    } else if (financialData.treasuryRateChange < 0) {
                        treasuryRateTrendValue = "⬇️ since " + treasuryRateTimeframe;
                    } else {
                        treasuryRateTrendValue = "↔️ No change";
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
                                        { name: "Treasury Rate Trend", value: treasuryRateTrendValue, inline: true }, // Updated Treasury Rate Trend
                                        { 
                                            name: "📈 **Risk Category**", 
                                            value: category, 
                                            inline: false 
                                        },
                                        { 
                                            name: "💡 **Allocation Recommendation**", 
                                            value: `**${allocation}**`, // **Fixed Allocation Recommendation**
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
                    return; // Terminate after responding
                } catch (error) {
                    console.error("[ERROR] Failed to fetch financial data for /check command", error);
                    res.status(500).json({
                        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                        data: { content: "⚠️ Unable to retrieve financial data at this time. Please try again later." }
                    });
                    return; // Terminate after responding
                }

            case TICKER_COMMAND.name.toLowerCase():
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
                    return; // Terminate after responding
                }

                try {
                    logDebug(`Fetching data for Ticker: ${ticker}, Timeframe: ${timeframe}`);

                    // Note: The /ticker command remains in test mode with preset values
                    // If you wish to restore full functionality later, replace the following preset response with dynamic data fetching logic

                    // Preset data for /ticker command (Test Mode)
                    const presetTickerEmbed = {
                        title: `${ticker} Financial Data`,
                        color: 3447003, // Blue color
                        fields: [
                            { name: "Current Price", value: `$350.75`, inline: true },
                            { name: "Timeframe", value: timeframe.toUpperCase(), inline: true },
                        ],
                        image: {
                            url: PRESET_IMAGE_URL, // Use the specified preset image URL
                        },
                        footer: {
                            text: "Data fetched from Yahoo Finance",
                        },
                    };

                    // Send the embed as a response
                    res.status(200).json({
                        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                        data: {
                            embeds: [presetTickerEmbed],
                        },
                    });
                    logDebug("/ticker command successfully executed with preset data and specified image");
                    return; // Terminate after responding
                } catch (error) {
                    console.error("[ERROR] Failed to fetch financial data for /ticker command", error);
                    res.status(500).json({
                        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                        data: { content: "⚠️ Unable to retrieve financial data at this time. Please ensure the ticker symbol is correct and try again later." }
                    });
                    return; // Terminate after responding
                }

            default:
                console.error("[ERROR] Unknown command");
                res.status(400).json({ error: "Unknown Command" });
                return; // Terminate after responding
        }
    } else {
        console.error("[ERROR] Unknown request type");
        res.status(400).json({ error: "Unknown Type" });
        return; // Terminate after responding
    }
};
