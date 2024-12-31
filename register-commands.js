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
    {
        name: 'ticker',
        description: 'Fetch and display financial data for a specific ticker and timeframe.',
        options: [
            {
                name: 'symbol',
                type: 3, // STRING type
                description: 'The stock ticker symbol (e.g., AAPL, GOOGL)',
                required: true,
            },
            {
                name: 'timeframe',
                type: 3, // STRING type
                description: 'The timeframe for the chart (1d, 1mo, 1y, 3y, 10y)',
                required: true,
                choices: [
                    { name: '1 Day', value: '1d' },
                    { name: '1 Month', value: '1mo' },
                    { name: '1 Year', value: '1y' },
                    { name: '3 Years', value: '3y' },
                    { name: '10 Years', value: '10y' },
                ],
            },
        ],
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
