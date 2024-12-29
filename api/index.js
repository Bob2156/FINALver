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
        // Fetch S&P 500 (price and historical data for 220 days), Treasury Rate (30 days), and VIX concurrently
        const [sp500Response, treasuryResponse, vixResponse] = await Promise.all([
            axios.get("https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1d&range=220d"),
            axios.get("https://query1.finance.yahoo.com/v8/finance/chart/%5EIRX?interval=1d&range=30d"), // Fetch 30 days for Treasury rate
            axios.get("https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=1d"), // Latest VIX value
        ]);

        const sp500Data = sp500Response.data;
        const treasuryData = treasuryResponse.data;
        const vixData = vixResponse.data;

        // Extract S&P 500 price
        const sp500Price = sp500Data.chart.result[0].meta.regularMarketPrice;

        // Extract 220-day SMA
        const sp500Prices = sp500Data.chart.result[0].indicators.adjclose[0].adjclose;
        if (sp500Prices.length < 220) {
            throw new Error("Not enough data to calculate 220-day SMA.");
        }
        const sma220 = (sp500Prices.slice(-220).reduce((acc, price) => acc + price, 0) / 220).toFixed(2);

        // Extract 3-Month Treasury Rate
        const treasuryRates = treasuryData.chart.result[0].indicators.adjclose[0].adjclose;
        const currentTreasuryRate = treasuryRates[treasuryRates.length - 1];
        const oneMonthAgoTreasuryRate = treasuryRates.length >= 30 ? treasuryRates[treasuryRates.length - 30] : treasuryRates[0]; // Handle cases with less than 30 data points

        // Determine if Treasury rate is falling
        const isTreasuryFalling = currentTreasuryRate < oneMonthAgoTreasuryRate;

        // Extract Volatility (VIX)
        const vixValues = vixData.chart.result[0].indicators.quote[0].close;
        const currentVix = vixValues[vixValues.length - 1];
        if (currentVix === null || currentVix === undefined) {
            throw new Error("VIX data is unavailable.");
        }

        // Calculate volatility (using VIX as a proxy)
        const volatility = parseFloat(currentVix).toFixed(2); // VIX is typically expressed as a percentage

        return {
            sp500: parseFloat(sp500Price).toFixed(2),
            sma220: parseFloat(sma220).toFixed(2),
            volatility: parseFloat(volatility).toFixed(2),
            treasuryRate: parseFloat(currentTreasuryRate).toFixed(2),
            isTreasuryFalling: isTreasuryFalling,
        };
    } catch (error) {
        console.error("Error fetching financial data:", error);
        throw new Error("Failed to fetch financial data");
    }
}

// Helper function to determine risk category and allocation
function determineRiskCategory(data) {
    const { sp500, sma220, volatility, treasuryRate, isTreasuryFalling } = data;

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
        if (volatility < 24) {
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
                                        { name: "Volatility (VIX)", value: `${financialData.volatility}%`, inline: true },
                                        { name: "3-Month Treasury Rate", value: `${financialData.treasuryRate}%`, inline: true },
                                        { name: "Status", value: financialData.isTreasuryFalling ? "3-Month Treasury Rate is Falling" : "3-Month Treasury Rate is Not Falling", inline: true },
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
