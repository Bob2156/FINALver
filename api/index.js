const {
    InteractionResponseType,
    InteractionType,
    verifyKey,
} = require("discord-interactions");
const getRawBody = require("raw-body");
const axios = require("axios");

const HI_COMMAND = { name: "hi", description: "Say hello!" };
const CHECK_COMMAND = { name: "check", description: "Display MFEA analysis status." };

// Helper function to fetch the 3-month Treasury Bill rate
async function fetchTreasuryRate() {
    console.log("[DEBUG] Attempting to fetch 3-month Treasury Bill rate...");
    const url = "https://www.cnbc.com/quotes/US3M";
    try {
        const response = await axios.get(url);
        if (response.status === 200) {
            const match = response.data.match(/lastPrice[^>]+>([\d.]+)%/);
            if (match) {
                const rate = parseFloat(match[1]);
                console.log(`[DEBUG] Fetched Treasury Rate: ${rate}%`);
                return rate;
            } else {
                throw new Error("Failed to parse Treasury rate from response.");
            }
        } else {
            throw new Error(`HTTP Error: ${response.status}`);
        }
    } catch (error) {
        console.error("[ERROR] Failed to fetch Treasury rate:", error.message);
        return null;
    }
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

                // Send the formatted embed
                return response.send({
                    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                    data: {
                        embeds: [
                            {
                                title: "MFEA Analysis Status",
                                color: 3447003, // Blue banner
                                fields: [
                                    { name: "SMA", value: "Working", inline: true },
                                    { name: "Volatility", value: "Working", inline: true },
                                    { name: "3-month Treasury Bill", value: "Working", inline: true },
                                ],
                                footer: {
                                    text: "MFEA Analysis",
                                },
                            },
                        ],
                    },
                });

            default:
                console.error("[ERROR] Unknown command");
                return response.status(400).send({ error: "Unknown Command" });
        }
    } else {
        console.error("[ERROR] Unknown request type");
        return response.status(400).send({ error: "Unknown Type" });
    }
};
