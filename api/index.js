const {
  InteractionResponseType,
  InteractionType,
  verifyKey,
} = require("discord-interactions");
const getRawBody = require("raw-body");
const fetch = require("node-fetch"); // Ensure node-fetch is installed

// Helper function to log debug messages
function logDebug(message) {
  console.log(`[DEBUG] ${message}`);
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
    if (message.data.name.toLowerCase() === "check") {
      logDebug("Handling /check command");

      try {
        // Fetch financial data
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
        const prices = sp500Data.chart.result[0].indicators.adjclose[0].adjclose; // Historical adjusted close prices
        const returns = prices.slice(1).map((p, i) => (p / prices[i] - 1)); // Daily returns
        const dailyVolatility = Math.sqrt(
          returns.reduce((sum, r) => sum + r ** 2, 0) / returns.length
        ); // Standard deviation
        const annualizedVolatility = (dailyVolatility * Math.sqrt(252) * 100).toFixed(2); // Annualized volatility as percentage

        // Send the formatted embed with real data
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
                  {
                    name: "S&P 500 Volatility (21 days, annualized)",
                    value: `${annualizedVolatility}%`,
                    inline: false,
                  },
                ],
                footer: {
                  text: "MFEA Recommendation: Analyze further",
                },
              },
            ],
          },
        });
        logDebug("/check command successfully executed");
      } catch (error) {
        console.error("[ERROR] Failed to fetch financial data:", error);
        response.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: "Failed to fetch financial data. Please try again later." },
        });
      }
    } else {
      console.error("[ERROR] Unknown command");
      return response.status(400).send({ error: "Unknown Command" });
    }
  } else {
    console.error("[ERROR] Unknown request type");
    return response.status(400).send({ error: "Unknown Type" });
  }
};
