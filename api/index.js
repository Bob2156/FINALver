const {
    InteractionResponseType,
    InteractionType,
    verifyKey,
} = require("discord-interactions");
const getRawBody = require("raw-body");
const fetch = require("node-fetch");

const HI_COMMAND = { name: "hi", description: "Say hello!" };
const CHECK_COMMAND = { name: "check", description: "Display MFEA analysis status." };

// Helper function to log debug messages
function logDebug(message) {
    console.log(`[DEBUG] ${message}`);
}

// Financial Data Fetcher
async function fetchFinancialData() {
    try {
        const [sp500Response, treasuryResponse] = await Promise.all([
            fetch("https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1d&range=21d"),
            fetch("https://query1.finance.yahoo.com/v8/finance/chart/%5EIRX"),
        ]);

        const sp500Data = await sp500Response.json();
        const treasuryData = await treasuryResponse.json();

        // Extract S&P 500 price
        const sp500Price = sp500Data.chart.result[0].meta.regularMarketPrice;

        // Extract 3-Month Treasury Rate
        const treasuryRate = treasuryData.chart.result[0].meta.regularMarketPrice;

        // Calculate volatility
        const prices = sp500Data.chart.result[0].indicators.adjclose[0].adjclose.filter(price => typeof price === 'number' && !isNaN(price));
        const returns = prices.slice(1).map((p, i) => (p / prices[i] - 1));
        const dailyVolatility = Math.sqrt(returns.reduce((sum, r) => sum + r ** 2, 0) / returns.length);
        const annualizedVolatility = (dailyVolatility * Math.sqrt(252) * 100).toFixed(2);

        return {
            sp500Price,
            treasuryRate,
            sp500Volatility: `${annualizedVolatility}%`,
        };
    } catch (error) {
        console.error("Error fetching financial data:", error);
        throw new Error("Failed to fetch financial data");
    }
}

// Main handler
module.exports = async (request, response) => {
    logDebug("Received a new request");

    if (request.method !== "POST") {
        logDebug("Invalid method, returning 405");
        return response.status(405).send({ error: "Method Not Allowed" });
    }

    const signature = request.headers["x-signature-ed25519"];
    const timestamp = request.headers["x-signature-timestamp"];
    const rawBody = await getRawBody(request);

    const isValidRequest = verifyKey(
        rawBody,
        signature,
        timestamp,
        process.env.PUBLIC_KEY
    );

    if (!isValidRequest) {
        console.error("[ERROR] Invalid request signature");
        return response.status(401).send({ error: "Bad request signature" });
    }

    const message = JSON.parse(rawBody);
    logDebug(`Message type: ${message.type}`);

    if (message.type === InteractionType.PING) {
        logDebug("Handling PING");
        return response.send({ type: InteractionResponseType.PONG });
    }

    if (message.type === InteractionType.APPLICATION_COMMAND) {
        switch (message.data.name.toLowerCase()) {
            case HI_COMMAND.name.toLowerCase():
                logDebug("Handling /hi command");
                response.send({
                    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                    data: { content: "Hello!" },
                });
                logDebug("/hi command successfully executed");
                break;

            case CHECK_COMMAND.name.toLowerCase():
                logDebug("Handling /check command");

                try {
                    const { sp500Price, treasuryRate, sp500Volatility } = await fetchFinancialData();

                    response.send({
                        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                        data: {
                            embeds: [
                                {
                                    title: "MFEA Analysis Status",
                                    color: 3447003, // Blue banner
                                    fields: [
                                        { name: "S&P 500 Price", value: `$${sp500Price}`, inline: true },
                                        { name: "3-Month Treasury Rate", value: `${treasuryRate}%`, inline: true },
                                        { name: "Volatility", value: sp500Volatility, inline: true },
                                    ],
                                    footer: {
                                        text: "MFEA Recommendation: Still working on it",
                                    },
                                },
                            ],
                        },
                    });
                    logDebug("/check command successfully executed");
                } catch (error) {
                    response.status(500).send({
                        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                        data: { content: "Failed to fetch financial data. Please try again later." },
                    });
                }
                break;

            default:
                console.error("[ERROR] Unknown command");
                return response.status(400).send({ error: "Unknown Command" });
        }
    } else {
        console.error("[ERROR] Unknown request type");
        return response.status(400).send({ error: "Unknown Type" });
    }
};
