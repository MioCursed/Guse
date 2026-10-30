import { REST, Routes } from 'discord.js';
import { env } from '../config/env';
import { data as screenCommandData } from './commands/screen';

const commands = [
    screenCommandData.toJSON(),
];

const rest = new REST({ version: '10' }).setToken(env.DISCORD_TOKEN);

async function deployCommands() {
    try {
        console.log(`Started refreshing ${commands.length} application (/) commands.`);

        await rest.put(
            Routes.applicationCommands(env.CLIENT_ID),
            { body: commands },
        );

        console.log(`Successfully reloaded ${commands.length} application (/) commands.`);
    } catch (error) {
        console.error('Failed to deploy application commands:', error);
        process.exitCode = 1;
    }
}

void deployCommands();
