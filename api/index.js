const {
    InteractionResponseType,
    InteractionType,
    verifyKey,
} = require("discord-interactions");
const getRawBody = require("raw-body");
const fetch = require("node-fetch");

module.exports = async (request, response) => {
    // Validate request method
    if (request.method !== "POST") {
        return response.status(405).send({ error: "Method Not Allowed" });
    }

    // Verify Discord request signature
    const signature = request.headers["x-signature-ed25519"];
    const timestamp = request.headers["x-signature-timestamp"];
    const rawBody = await getRawBody(request);

    if (!verifyKey(rawBody, signature, timestamp, process.env.PUBLIC_KEY)) {
        return response.status(401).send({ error: "Invalid Request Signature" });
    }

    const message = JSON.parse(rawBody);

    // Handle PING requests
    if (message.type === InteractionType.PING) {
        return response.send({ type: InteractionResponseType.PONG });
    }

    // Handle the /check command
    if (message.type === InteractionType.APPLICATION_COMMAND && message.data.name.toLowerCase() === "check") {
        try {
            // Fetch S&P 500 and 3-Month Treasury Rate
            const [sp500Response, treasuryResponse] = await Promise.all([
                fetch("https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1d&range=21d"),
                fetch("https://query1.finance.yahoo.com/v8/finance/chart/%5EIRX"),
            ]);

            const sp500Data = await sp500Response.json();
            const treasuryData = await treasuryResponse.json();

            const sp500Price = sp500Data.chart.result[0].meta.regularMarketPrice;
            const treasuryRate = treasuryData.chart.result[0].meta.regularMarketPrice;

            // Calculate 21-day annualized volatility
            const prices = sp500Data.chart.result[0].indicators.adjclose[0].adjclose;
            const returns = prices.slice(1).map((p, i) => (p / prices[i] - 1));
            const dailyVolatility = Math.sqrt(
                returns.reduce((sum, r) => sum + r ** 2, 0) / returns.length
            );
            const annualizedVolatility = (dailyVolatility * Math.sqrt(252) * 100).toFixed(2);

            // Send response back to Discord
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
                                { name: "S&P 500 Volatility (21 days, annualized)", value: `${annualizedVolatility}%`, inline: false },
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
    }

    // Unknown type or command
    return response.status(400).send({ error: "Unknown Type or Command" });
};
