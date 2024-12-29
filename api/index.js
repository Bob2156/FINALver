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
        // Fetch S&P 500 (price and historical data) and Treasury Rate concurrently
        const [sp500Response, treasuryResponse] = await Promise.all([
            axios.get("https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1d&range=21d"),
            axios.get("https://query1.finance.yahoo.com/v8/finance/chart/%5EIRX"),
        ]);

        const sp500Data = sp500Response.data;
        const treasuryData = treasuryResponse.data;

        // Extract S&P 500 price
        const sp500Price = sp500Data.chart.result[0].meta.regularMarketPrice;

        // Extract 3-Month Treasury Rate
        const treasuryRate = treasuryData.chart.result[0].meta.regularMarketPrice;

        // Calculate volatility
        const prices = sp500Data.chart.result[0].indicators.adjclose[0].adjclose; // Historical adjusted close prices
        const returns = prices.slice(1).map((p, i) => (p / prices[i] - 1)); // Daily returns
        const dailyVolatility = Math.sqrt(
            returns.reduce((sum, r) => sum + r ** 2, 0) / returns.length
        ); // Standard deviation
        const annualizedVolatility = (dailyVolatility * Math.sqrt(252) * 100).toFixed(2); // Annualized volatility as percentage

        return {
            sp500: sp500Price,
            treasuryRate: treasuryRate,
            sp500Volatility: `${annualizedVolatility}%`,
        };
    } catch (error) {
        console.error("Error fetching financial data:", error);
        throw new Error("Failed to fetch financial data");
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

    const rawBody = await getRawBody(req, {
        encoding: "utf-8",
    });

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

    const message = JSON.parse(rawBody);
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

                    // Send the formatted embed with actual data
                    res.status(200).json({
                        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                        data: {
                            embeds: [
                                {
                                    title: "MFEA Analysis Status",
                                    color: 3447003, // Blue banner
                                    fields: [
                                        { name: "S&P 500", value: `$${financialData.sp500}`, inline: true },
                                        { name: "Volatility", value: financialData.sp500Volatility, inline: true },
                                        { name: "3-Month Treasury Bill", value: `${financialData.treasuryRate}%`, inline: true },
                                    ],
                                    footer: {
                                        text: "MFEA Recommendation: Still working on it",
                                    },
                                },
                            ],
                        },
                    });
                    logDebug("/check command successfully executed with fetched data");
                } catch (error) {
                    console.error("[ERROR] Failed to fetch financial data for /check command", error);
                    res.status(500).json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: "Failed to fetch financial data." } });
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
