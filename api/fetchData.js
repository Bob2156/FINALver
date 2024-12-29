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
        // Fetch SPX data for 220 days (to calculate 220-day SMA) and 21 days (for volatility)
        // Fetch 220 days and then extract the last 21 days for volatility calculation
        const sp500Response = await axios.get("https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1d&range=220d");
        const treasuryResponse = await axios.get("https://query1.finance.yahoo.com/v8/finance/chart/%5EIRX?interval=1d&range=60d"); // Fetch 60 days to ensure at least 30 days
        const vixResponse = await axios.get("https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=2d"); // Fetch 2 days to ensure latest value

        const sp500Data = sp500Response.data;
        const treasuryData = treasuryResponse.data;
        const vixData = vixResponse.data;

        // Extract S&P 500 price
        const sp500Price = sp500Data.chart.result[0].meta.regularMarketPrice;
        logDebug(`SPX Price: ${sp500Price}`);

        // Extract 220-day SMA
        const sp500Prices = sp500Data.chart.result[0].indicators.adjclose[0].adjclose;
        if (sp500Prices.length < 220) {
            throw new Error("Not enough data to calculate 220-day SMA.");
        }
        const sum220 = sp500Prices.slice(-220).reduce((acc, price) => acc + price, 0);
        const sma220 = (sum220 / 220).toFixed(2);
        logDebug(`220-day SMA: ${sma220}`);

        // Extract 3-Month Treasury Rate
        // Treasury rates are typically represented under 'close', not 'adjclose'
        const treasuryRates = treasuryData.chart.result[0].indicators.quote[0].close;
        if (!treasuryRates || treasuryRates.length === 0) {
            throw new Error("Treasury rate data is unavailable.");
        }
        const currentTreasuryRate = parseFloat(treasuryRates[treasuryRates.length - 1]).toFixed(3); // More precise
        const oneMonthAgoTreasuryRate = treasuryRates.length >= 30
            ? parseFloat(treasuryRates[treasuryRates.length - 30]).toFixed(3)
            : parseFloat(treasuryRates[0]).toFixed(3); // Handle cases with less than 30 data points
        logDebug(`Current 3-Month Treasury Rate: ${currentTreasuryRate}%`);
        logDebug(`3-Month Treasury Rate 30 Days Ago: ${oneMonthAgoTreasuryRate}%`);

        // Determine if Treasury rate is falling
        const isTreasuryFalling = currentTreasuryRate < oneMonthAgoTreasuryRate;
        logDebug(`Is Treasury Rate Falling: ${isTreasuryFalling}`);

        // Extract Volatility (VIX)
        const vixValues = vixData.chart.result[0].indicators.quote[0].close;
        // Handle cases where VIX might not be available or null
        const validVixValues = vixValues.filter(v => v !== null && v !== undefined);
        const currentVix = validVixValues.length > 0 ? parseFloat(validVixValues[validVixValues.length - 1]).toFixed(2) : null;
        if (currentVix === null) {
            throw new Error("VIX data is unavailable.");
        }
        logDebug(`Current VIX (Volatility): ${currentVix}%`);

        // Calculate 21-day annualized volatility based on SPX returns
        const last21Prices = sp500Prices.slice(-21);
        const returns = last21Prices.slice(1).map((p, i) => (p / last21Prices[i] - 1));
        const meanReturn = returns.reduce((acc, r) => acc + r, 0) / returns.length;
        const squaredDiffs = returns.map(r => (r - meanReturn) ** 2);
        const variance = squaredDiffs.reduce((acc, sd) => acc + sd, 0) / (returns.length - 1);
        const dailyVolatility = Math.sqrt(variance);
        const annualizedVolatility = (dailyVolatility * Math.sqrt(252) * 100).toFixed(2); // Annualized volatility as percentage
        logDebug(`21-Day Annualized Volatility: ${annualizedVolatility}%`);

        return {
            sp500: parseFloat(sp500Price).toFixed(2),
            sma220: parseFloat(sma220).toFixed(2),
            volatility: parseFloat(annualizedVolatility).toFixed(2),
            treasuryRate: parseFloat(currentTreasuryRate).toFixed(3),
            isTreasuryFalling: isTreasuryFalling,
        };
    }

// Helper function to determine risk category and allocation based on clarified logic
function determineRiskCategory(data) {
    const { sp500, sma220, volatility, treasuryRate, isTreasuryFalling } = data;

    logDebug(`Determining risk category with SPX: ${sp500}, SMA220: ${sma220}, Volatility: ${volatility}%, Treasury Rate: ${treasuryRate}%, Is Treasury Falling: ${isTreasuryFalling}`);

    if (sp500 > sma220) {
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
        // If SPX ≤ 220 SMA, directly evaluate Treasury Rate trend
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

    let message;
    try {
        message = JSON.parse(rawBody);
    } catch (error) {
        console.error("[ERROR] Failed to parse JSON:", error);
        res.status(400).json({ error: "Invalid JSON format" });
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
                                        { name: "S&P 500 Price", value: `$${financialData.sp500}`, inline: true },
                                        { name: "220-day SMA", value: `$${financialData.sma220}`, inline: true },
                                        { name: "21-Day Annualized Volatility", value: `${financialData.volatility}%`, inline: true },
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
                        data: { content: "Failed to fetch financial data." }
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
