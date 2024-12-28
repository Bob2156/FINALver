const {
    InteractionResponseType,
    InteractionType,
    verifyKey,
} = require("discord-interactions");
const getRawBody = require("raw-body");

const HI_COMMAND = {
    name: "hi",
    description: "Say hello!",
};

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
