const {
    InteractionResponseType,
    InteractionType,
    verifyKey,
} = require("discord-interactions");
const getRawBody = require("raw-body");
const yfinance = require("yfinance");
const fetch = require("node-fetch");

const HI_COMMAND = {
    name: "hi",
    description: "Say hello!",
};

const CHECK_COMMAND = {
    name: "check",
    description: "Fetch market data and provide recommendations.",
};

// Helper function to fetch SMA and volatility
async function fetchSMAAndVolatility() {
    const ticker = new yfinance.Ticker("^GSPC"); // S&P 500 Index
    const data = await ticker.history({ period: "1y" });

    if (!data || data.Close.length < 220) {
        throw new Error("Insufficient data to calculate SMA or volatility.");
    }

    const sma220 = data.Close.slice(-220).reduce((a, b) => a + b) / 220;
    const lastClose = data.Close[data.Close.length - 1];

    const recentData = data.Close.slice(-30);
    if (recentData.length < 30) {
        throw new Error("Insufficient data for volatility calculation.");
    }
    const dailyReturns = recentData.map((value, index, arr) =>
        index > 0 ? (value - arr[index - 1]) / arr[index - 1] : 0
    ).slice(1);
    const volatility =
        Math.sqrt(dailyReturns.reduce((a, b) => a + b ** 2, 0) / dailyReturns.length) *
        Math.sqrt(252) *
        100;

    return { lastClose, sma220: Math.round(sma220), volatility: Math.round(volatility * 100) / 100 };
}

// Helper function to fetch Treasury rate
async function fetchTreasuryRate() {
    const response = await fetch("https://www.cnbc.com/quotes/US3M");
    const text = await response.text();

    const match = text.match(/<span class="QuoteStrip-lastPrice">([\d.]+)%<\/span>/);
    if (!match) {
        throw new Error("Failed to fetch Treasury rate.");
    }

    return parseFloat(match[1]);
}

module.exports = async (request, response) => {
    // Only respond to POST requests
    if (request.method === "POST") {
        // Verify the request
        const signature = request.headers["x-signature-ed25519"];
        const timestamp = request.headers["x-signature-timestamp"];
        const rawBody = await getRawBody(request);

        const isValidRequest = verifyKey(
            rawBody,
            signature,
            timestamp,
            process.env.PUBLIC_KEY,
        );

        if (!isValidRequest) {
            console.error("Invalid Request");
            return response.status(401).send({ error: "Bad request signature" });
        }

        // Handle the request
        const message = JSON.parse(rawBody);

        // Handle PINGs from Discord
        if (message.type === InteractionType.PING) {
            console.log("Handling Ping request");
            response.send({
                type: InteractionResponseType.PONG,
            });
        } else if (message.type === InteractionType.APPLICATION_COMMAND) {
            // Handle our Slash Commands
            switch (message.data.name.toLowerCase()) {
                case HI_COMMAND.name.toLowerCase():
                    response.status(200).send({
                        type: 4,
                        data: {
                            content: "Hello!",
                        },
                    });
                    console.log("Hi request");
                    break;
                case CHECK_COMMAND.name.toLowerCase():
                    try {
                        // Fetch market data
                        const { lastClose, sma220, volatility } = await fetchSMAAndVolatility();
                        const treasuryRate = await fetchTreasuryRate();

                        // Determine recommendation
                        let recommendation;
                        if (lastClose > sma220) {
                            if (volatility < 14) {
                                recommendation = "Risk ON - 100% UPRO or 3x (100% SPY)";
                            } else if (volatility < 24) {
                                recommendation = "Risk MID - 100% SSO or 2x (100% SPY)";
                            } else {
                                recommendation = treasuryRate < 4
                                    ? "Risk ALT - 25% UPRO + 75% ZROZ or 1.5x (50% SPY + 50% ZROZ)"
                                    : "Risk OFF - 100% SPY or 1x (100% SPY)";
                            }
                        } else {
                            recommendation = treasuryRate < 4
                                ? "Risk ALT - 25% UPRO + 75% ZROZ or 1.5x (50% SPY + 50% ZROZ)"
                                : "Risk OFF - 100% SPY or 1x (100% SPY)";
                        }

                        // Send response
                        response.status(200).send({
                            type: 4,
                            data: {
                                content: `Market Data:\n\nSPX Last Close: ${lastClose}\nSMA 220: ${sma220}\nVolatility (Annualized): ${volatility}%\n3M Treasury Rate: ${treasuryRate}%\n\nRecommendation: ${recommendation}`,
                            },
                        });
                        console.log("Check request completed successfully.");
                    } catch (error) {
                        console.error("Error fetching market data:", error.message);
                        response.status(200).send({
                            type: 4,
                            data: {
                                content: `Error fetching market data: ${error.message}`,
                            },
                        });
                    }
                    break;
                default:
                    console.error("Unknown Command");
                    response.status(400).send({ error: "Unknown Command" });
                    break;
            }
        } else {
            console.error("Unknown Type");
            response.status(400).send({ error: "Unknown Type" });
        }
    } else {
        response.status(405).send({ error: "Method Not Allowed" });
    }
};
