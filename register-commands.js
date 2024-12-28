const { REST, Routes } = require('discord.js');
require('dotenv').config();

const commands = [
    {
        name: 'hi',
        description: 'Say hello!',
    },
    {
        name: 'check',
        description: 'Fetch market data and provide recommendations.',
    },
];

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

(async () => {
    try {
        console.log('Started refreshing application (/) commands.');

        await rest.put(
            Routes.applicationCommands(process.env.APPLICATION_ID),
            { body: commands },
        );

        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error(error);
    }
})();
