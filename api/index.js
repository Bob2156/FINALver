const {
    InteractionResponseType,
    InteractionType,
    verifyKey,
} = require("discord-interactions");
const getRawBody = require("raw-body");
const axios = require("axios");

const HI_COMMAND = { name: "hi", description: "Say hello!" };
const CHECK_COMMAND = { name: "check", description: "Run MFEA analysis." };

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
                    console.log("[DEBUG] Sending fixed values...");

                    const result = `
**MFEA Analysis Results:**
- **Item 1:** 100
- **Item 2:** 200
- **Item 3:** 300
                    `;

                    console.log("[DEBUG] Sending final response to Discord");
                    await axios.post(DISCORD_WEBHOOK_URL, { content: result });
                } catch (error) {
                    console.error("[ERROR] Failed to send response to Discord:", error.message);
                    await axios.post(DISCORD_WEBHOOK_URL, {
                        content: `**MFEA Analysis Results:**
- **Item 1:** Not available
- **Item 2:** Not available
- **Item 3:** Not available`,
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
