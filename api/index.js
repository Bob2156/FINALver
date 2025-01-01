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

// Function to fetch financial data for /check command
async function fetchCheckFinancialData() {
    try {
        const response = await axios.get('https://your-vercel-site.vercel.app/api/fetchData?type=check');
        return response.data;
    } catch (error) {
        console.error("[ERROR] Failed to fetch check financial data:", error);
        throw error;
    }
}

// Function to fetch financial data for /ticker command
async function fetchTickerFinancialData(ticker, range) {
    try {
        const response = await axios.get(`https://your-vercel-site.vercel.app/api/fetchData?ticker=${ticker}&range=${range}`);
        return response.data;
    } catch (error) {
        console.error("[ERROR] Failed to fetch ticker financial data:", error);
        throw error;
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
                    const treasuryRateTimeframe = "last month"; // Assuming 30 days

                    if (financialData.treasuryRateChange > 0) {
                        treasuryRateTrendValue = `⬆️ ${financialData.treasuryRateChange}% since ${treasuryRateTimeframe}`;
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

                    // Generate Chart Image URL using QuickChart.io with controlled size
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
                                pointRadius: 0, // Remove points for a cleaner line
                                fill: true,
                            }]
                        },
                        options: {
                            responsive: false, // Disable responsiveness to control chart size
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
                                        // Chart.js handles dynamic scaling
                                    },
                                    grid: {
                                        color: 'rgba(0,0,0,0.1)',
                                        borderDash: [5, 5], // Dashed grid lines for better readability
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

                    // Construct QuickChart.io URL with specified size parameters
                    const chartUrl = `https://quickchart.io/chart?c=${chartConfigEncoded}&width=800&height=600&format=png`;

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
