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

async function fetchSmaAndVolatility() {
    try {
        const ticker = "^GSPC"; // S&P 500 Index

        const oneYearAgo = new Date();
        oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

        const data = await yahooFinance.chart(ticker, {
            period1: oneYearAgo, // Pass the Date object
            interval: "1d", // Daily intervals
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
    } catch (error) {
        throw new Error(`Error fetching SMA and volatility: ${error.message}`);
    }
}

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

module.exports = async (request, response) => {
    if (request.method !== "POST") {
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
        return response.status(401).send({ error: "Bad request signature" });
    }

    const message = JSON.parse(rawBody);

    if (message.type === InteractionType.PING) {
        return response.send({ type: InteractionResponseType.PONG });
    }

    if (message.type === InteractionType.APPLICATION_COMMAND) {
        switch (message.data.name.toLowerCase()) {
            case HI_COMMAND.name.toLowerCase():
                return response.send({
                    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                    data: { content: "Hello!" },
                });

            case CHECK_COMMAND.name.toLowerCase():
                response.status(200).send({
                    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
                });

                const DISCORD_WEBHOOK_URL = `https://discord.com/api/v10/webhooks/${process.env.APPLICATION_ID}/${message.token}`;
                try {
                    const { lastClose, sma220, volatility } =
                        await fetchSmaAndVolatility();
                    const treasuryRate = await fetchTreasuryRate();

                    let recommendation = "No recommendation available.";
                    if (lastClose > sma220) {
                        if (volatility < 14) {
                            recommendation = "Risk ON - 100% UPRO or 3x (100% SPY)";
                        } else if (volatility < 24) {
                            recommendation = "Risk MID - 100% SSO or 2x (100% SPY)";
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

                    await axios.post(DISCORD_WEBHOOK_URL, {
                        content: `Last Close: ${lastClose}\nSMA 220: ${sma220}\nVolatility: ${volatility}%\nTreasury Rate: ${treasuryRate}%\nRecommendation: ${recommendation}`,
                    });
                } catch (error) {
                    await axios.post(DISCORD_WEBHOOK_URL, {
                        content: `Error during analysis: ${error.message}`,
                    });
                }
                break;

            default:
                return response.status(400).send({ error: "Unknown Command" });
        }
    } else {
        return response.status(400).send({ error: "Unknown Type" });
    }
};
