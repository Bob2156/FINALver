const {
    InteractionResponseType,
    InteractionType,
    verifyKey,
} = require("discord-interactions");
const getRawBody = require("raw-body");
const yahooFinance = require("yahoo-finance2").default;
const axios = require("axios");

const HI_COMMAND = { name: "hi", description: "Say hello!" };
const CHECK_COMMAND = { name: "check", description: "Run MFEA analysis." };

// Helper function to fetch with timeout
async function fetchWithTimeout(fetchFn, timeoutMessage, timeout = 2000) {
    try {
        return await Promise.race([
            fetchFn(),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error(timeoutMessage)), timeout)
            ),
        ]);
    } catch (error) {
        console.error("[ERROR]", error.message);
        return "Not available";
    }
}

// Fetch SMA and volatility
async function fetchSmaAndVolatility() {
    const ticker = "^GSPC";
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    const period1 = Math.floor(oneYearAgo.getTime() / 1000);
    const period2 = Math.floor(Date.now() / 1000);

    const data = await yahooFinance.chart(ticker, {
        period1,
        period2,
        interval: "1d",
    });

    if (!data || !data.chart || !data.chart.result[0]) {
        throw new Error("Failed to fetch data or no results from Yahoo Finance.");
    }

    const prices = data.chart.result[0].indicators.quote[0].close;

    if (!prices || prices.length < 220) {
        throw new Error("Insufficient data to calculate SMA or volatility.");
    }

    const sma220 = (
        prices.slice(-220).reduce((sum, price) => sum + price, 0) / 220
    ).toFixed(2);

    const lastClose = prices[prices.length - 1].toFixed(2);

    const recentPrices = prices.slice(-30);
    const dailyReturns = recentPrices
        .map((price, index) =>
            index === 0
                ? 0
                : (price - recentPrices[index - 1]) / recentPrices[index - 1]
        )
        .slice(1);

    const volatility = (
        Math.sqrt(
            dailyReturns.reduce((sum, ret) => sum + ret ** 2, 0) /
                dailyReturns.length
        ) *
        Math.sqrt(252) *
        100
    ).toFixed(2);

    return { lastClose, sma220, volatility };
}

// Fetch treasury rate
async function fetchTreasuryRate() {
    const url = "https://www.cnbc.com/quotes/US3M";
    const response = await axios.get(url);

    if (response.status === 200) {
        const match = response.data.match(/lastPrice[^>]+>([\d.]+)%/);
        if (match) {
            return parseFloat(match[1]);
        }
    }

    throw new Error("Failed to fetch treasury rate.");
}

// Main handler
module.exports = async (request, response) => {
    console.log("[DEBUG] Received a new request");
    if (request.method !== "POST") {
        console.log("[DEBUG] Invalid method, returning 405");
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
    console.log("[DEBUG] Message type:", message.type);

    if (message.type === InteractionType.PING) {
        console.log("[DEBUG] Handling PING");
        return response.send({ type: InteractionResponseType.PONG });
    }

    if (message.type === InteractionType.APPLICATION_COMMAND) {
        switch (message.data.name.toLowerCase()) {
            case HI_COMMAND.name.toLowerCase():
                console.log("[DEBUG] Handling /hi command");
                return response.send({
                    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                    data: { content: "Hello!" },
                });

            case CHECK_COMMAND.name.toLowerCase():
                console.log("[DEBUG] Handling /check command");

                // Send a deferred response
                response.status(200).send({
                    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
                });

                const DISCORD_WEBHOOK_URL = `https://discord.com/api/v10/webhooks/${process.env.APPLICATION_ID}/${message.token}`;

                try {
                    console.log("[DEBUG] Starting MFEA analysis...");

                    // Fetch SMA and volatility with timeout
                    const smaVolatility = await fetchWithTimeout(
                        fetchSmaAndVolatility,
                        "SMA and volatility fetch timed out."
                    );

                    // Fetch treasury rate with timeout
                    const treasuryRate = await fetchWithTimeout(
                        fetchTreasuryRate,
                        "Treasury rate fetch timed out."
                    );

                    // Construct the response message
                    const result = `
**MFEA Analysis Results:**
- **Last Close:** ${smaVolatility.lastClose || "Not available"}
- **SMA 220:** ${smaVolatility.sma220 || "Not available"}
- **Volatility:** ${smaVolatility.volatility ? `${smaVolatility.volatility}%` : "Not available"}
- **Treasury Rate:** ${treasuryRate ? `${treasuryRate}%` : "Not available"}
                    `;

                    console.log("[DEBUG] Sending final response to Discord");
                    await axios.post(DISCORD_WEBHOOK_URL, { content: result });
                } catch (error) {
                    console.error("[ERROR] MFEA analysis failed:", error.message);
                    try {
                        await axios.post(DISCORD_WEBHOOK_URL, {
                            content: `Error during analysis: ${error.message}`,
                        });
                    } catch (webhookError) {
                        console.error("[ERROR] Failed to send error response to Discord:", webhookError.message);
                    }
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
