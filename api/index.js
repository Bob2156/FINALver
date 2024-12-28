const {
    InteractionResponseType,
    InteractionType,
    verifyKey,
} = require("discord-interactions");
const getRawBody = require("raw-body");
const yfinance = require("yfinance");
const axios = require("axios");

const HI_COMMAND = {
    name: "hi",
    description: "Say hello!",
};

const CHECK_COMMAND = {
    name: "check",
    description: "Run the Market Financial Evaluation Assistant (MFEA) analysis.",
};

// Helper function to fetch SMA and volatility
async function fetchSmaAndVolatility() {
    try {
        const ticker = new yfinance.Ticker("^GSPC"); // S&P 500 Index
        const data = await ticker.history({ period: "1y" });

        if (!data || data.length < 220) {
            throw new Error("Insufficient data to calculate SMA or volatility.");
        }

        const sma220 = Math.round(data["Close"].rolling(220).mean().iloc(-1) * 100) / 100;
        const lastClose = Math.round(data["Close"].iloc(-1) * 100) / 100;

        // Calculate 30-day volatility
        const recentData = data.slice(-30);
        if (!recentData || recentData.length < 30) {
            throw new Error("Insufficient data for volatility calculation.");
        }
        const dailyReturns = recentData["Close"].pct_change().dropna();
        const volatility =
            Math.round(dailyReturns.std() * Math.sqrt(252) * 100 * 100) / 100;

        return { lastClose, sma220, volatility };
    } catch (error) {
        throw new Error(`Error fetching SMA and volatility: ${error.message}`);
    }
}

// Helper function to fetch treasury rate
async function fetchTreasuryRate() {
    try {
        const url = "https://www.cnbc.com/quotes/US3M";
        const response = await axios.get(url);

        if (response.status === 200) {
            const match = response.data.match(/lastPrice[^>]+>([\d.]+)%/);
            if (match) {
                return parseFloat(match[1]);
            }
        }
        throw new Error("Failed to fetch treasury rate.");
    } catch (error) {
        throw new Error(`Error fetching treasury rate: ${error.message}`);
    }
}

// Main handler
module.exports = async (request, response) => {
    if (request.method === "POST") {
        // Verify the request
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
            console.error("Invalid Request");
            return response.status(401).send({ error: "Bad request signature" });
        }

        // Handle the request
        const message = JSON.parse(rawBody);

        if (message.type === InteractionType.PING) {
            console.log("Handling Ping request");
            response.send({
                type: InteractionResponseType.PONG,
            });
        } else if (message.type === InteractionType.APPLICATION_COMMAND) {
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
                    response.status(200).send({
                        type: 4,
                        data: {
                            content: "Running MFEA analysis. Please wait...",
                        },
                    });
                    console.log("Check request");

                    // Run MFEA logic asynchronously
                    try {
                        const { lastClose, sma220, volatility } =
                            await fetchSmaAndVolatility();
                        const treasuryRate = await fetchTreasuryRate();

                        // Generate recommendation
                        let recommendation = "No recommendation available.";
                        if (lastClose > sma220) {
                            if (volatility < 14) {
                                recommendation =
                                    "Risk ON - 100% UPRO or 3x (100% SPY)";
                            } else if (volatility < 24) {
                                recommendation =
                                    "Risk MID - 100% SSO or 2x (100% SPY)";
                            } else {
                                recommendation =
                                    treasuryRate < 4
                                        ? "Risk ALT - 25% UPRO + 75% ZROZ or 1.5x (50% SPY + 50% ZROZ)"
                                        : "Risk OFF - 100% SPY or 1x (100% SPY)";
                            }
                        } else {
                            recommendation =
                                treasuryRate < 4
                                    ? "Risk ALT - 25% UPRO + 75% ZROZ or 1.5x (50% SPY + 50% ZROZ)"
                                    : "Risk OFF - 100% SPY or 1x (100% SPY)";
                        }

                        console.log("MFEA analysis completed:", recommendation);

                        response.status(200).send({
                            type: 4,
                            data: {
                                content: `Last Close: ${lastClose}\nSMA 220: ${sma220}\nVolatility: ${volatility}%\nTreasury Rate: ${treasuryRate}%\nRecommendation: ${recommendation}`,
                            },
                        });
                    } catch (error) {
                        console.error(error.message);
                        response.status(200).send({
                            type: 4,
                            data: {
                                content: `Error during MFEA analysis: ${error.message}`,
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
