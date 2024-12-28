const { REST, Routes } = require('discord.js');
require('dotenv').config();

// Define the commands
const commands = [
    {
        name: 'hi',
        description: 'Say hello!',
    },
    {
        name: 'check',
        description: 'Run the Market Financial Evaluation Assistant (MFEA) analysis.',
    },
];

// Create a REST instance and set the token
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

// Register the commands
(async () => {
    try {
        console.log('Started refreshing application (/) commands.');

        // Use applicationCommands for global commands
        await rest.put(
            Routes.applicationCommands(process.env.APPLICATION_ID),
            { body: commands }
        );

        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error(error);
    }
})();
