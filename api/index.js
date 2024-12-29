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

// Helper function to log debug messages
function logDebug(message) {
    console.log(`[DEBUG] ${message}`);
}

// Helper function to fetch financial data
async function fetchFinancialData() {
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

        // Determine if Treasury rate is falling
        const isTreasuryFalling = currentTreasuryRate < oneMonthAgoTreasuryRate;
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
        };
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
        logDebug("Handling PING");
        res.status(200).json({ type: InteractionResponseType.PONG });
        return;
    }

    if (message.type === InteractionType.APPLICATION_COMMAND) {
        const commandName = message.data.name.toLowerCase();
        switch (commandName) {
            case HI_COMMAND.name.toLowerCase():
                logDebug("Handling /hi command");
                res.status(200).json({
                    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                    data: { content: "Hello!" },
                });
                logDebug("/hi command successfully executed");
                break;

            case CHECK_COMMAND.name.toLowerCase():
                logDebug("Handling /check command");

                try {
                    // Fetch financial data
                    const financialData = await fetchFinancialData();

                    // Determine risk category and allocation
                    const { category, allocation } = determineRiskCategory(financialData);

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
                                        { name: "SPY Status", value: `${financialData.spyStatus} the 220-day SMA`, inline: true }, // Added SPY Status
                                        { name: "Volatility", value: `${financialData.volatility}%`, inline: true },
                                        { name: "3-Month Treasury Rate", value: `${financialData.treasuryRate}%`, inline: true },
                                        { name: "Treasury Rate Trend", value: financialData.isTreasuryFalling ? "Falling" : "Not Falling", inline: true },
                                        { name: "Risk Category", value: category, inline: false },
                                        { name: "Allocation Recommendation", value: allocation, inline: false },
                                    ],
                                    footer: {
                                        text: "MFEA Recommendation based on current market conditions",
                                    },
                                },
                            ],
                        },
                    });
                    logDebug("/check command successfully executed with fetched data");
                } catch (error) {
                    console.error("[ERROR] Failed to fetch financial data for /check command", error);
                    res.status(500).json({
                        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                        data: { content: "⚠️ Unable to retrieve financial data at this time. Please try again later." }
                    });
                }

                break;

            default:
                console.error("[ERROR] Unknown command");
                res.status(400).json({ error: "Unknown Command" });
        }
    } else {
        console.error("[ERROR] Unknown request type");
        res.status(400).json({ error: "Unknown Type" });
    }
};
