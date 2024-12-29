const {
    InteractionResponseType,
    InteractionType,
    verifyKey,
} = require("discord-interactions");
const getRawBody = require("raw-body");
const fetch = require("node-fetch"); // Ensure node-fetch is installed

// Main handler
module.exports = async (request, response) => {
    if (request.method !== "POST") {
        return response.status(405).send({ error: "Method Not Allowed" });
    }

    const signature = request.headers["x-signature-ed25519"];
    const timestamp = request.headers["x-signature-timestamp"];
    const rawBody = await getRawBody(request);

    if (
        !verifyKey(
            rawBody,
            signature,
            timestamp,
            process.env.PUBLIC_KEY
        )
    ) {
        return response.status(401).send({ error: "Invalid Request Signature" });
    }

    const message = JSON.parse(rawBody);

    if (message.type === InteractionType.PING) {
        return response.send({ type: InteractionResponseType.PONG });
    }

    if (message.type === InteractionType.APPLICATION_COMMAND) {
        if (message.data.name.toLowerCase() === "check") {
            try {
                // Fetch financial data
                const [sp500Response, treasuryResponse] = await Promise.all([
                    fetch("https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1d&range=21d"),
                    fetch("https://query1.finance.yahoo.com/v8/finance/chart/%5EIRX"),
                ]);

                const sp500Data = await sp500Response.json();
                const treasuryData = await treasuryResponse.json();

                const sp500Price = sp500Data.chart.result[0].meta.regularMarketPrice;
                const treasuryRate = treasuryData.chart.result[0].meta.regularMarketPrice;

                const prices = sp500Data.chart.result[0].indicators.adjclose[0].adjclose;
                const returns = prices.slice(1).map((p, i) => (p / prices[i] - 1));
                const dailyVolatility = Math.sqrt(
                    returns.reduce((sum, r) => sum + r ** 2, 0) / returns.length
                );
                const annualizedVolatility = (dailyVolatility * Math.sqrt(252) * 100).toFixed(2);

                // Respond with the financial data
                return response.send({
                    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                    data: {
                        embeds: [
                            {
                                title: "MFEA Analysis Status",
                                color: 3447003,
                                fields: [
                                    { name: "S&P 500 Price", value: `$${sp500Price}`, inline: true },
                                    { name: "3-Month Treasury Rate", value: `${treasuryRate}%`, inline: true },
                                    {
                                        name: "S&P 500 Volatility (21 days, annualized)",
                                        value: `${annualizedVolatility}%`,
                                        inline: false,
                                    },
                                ],
                            },
                        ],
                    },
                });
            } catch {
                return response.send({
                    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                    data: { content: "Failed to fetch financial data. Please try again later." },
                });
            }
        } else {
            return response.status(400).send({ error: "Unknown Command" });
        }
    }

    return response.status(400).send({ error: "Unknown Type" });
};
