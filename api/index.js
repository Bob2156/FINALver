const {
    InteractionResponseType,
    InteractionType,
    verifyKey,
} = require("discord-interactions");
const getRawBody = require("raw-body");
const axios = require("axios");

const HI_COMMAND = { name: "hi", description: "Say hello!" };
const CHECK_COMMAND = { name: "check", description: "Display MFEA analysis status." };

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

                // Send the formatted embed
                response.send({
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
                                    text: "MFEA Recommendation: Still working on it",
                                },
                            },
                        ],
                    },
                });
                logDebug("/check command successfully executed");
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
