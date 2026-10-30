import { REST, Routes } from 'discord.js';
import { env } from '../config/env';
import { data as meetCommandData } from './commands/meet';

const commands = [
    meetCommandData.toJSON(),
];

const rest = new REST({ version: '10' }).setToken(env.DISCORD_TOKEN);

(async () => {
    try {
        console.log(`Started refreshing ${commands.length} application (/) commands.`);

        const data: any = await rest.put(
            Routes.applicationCommands(env.CLIENT_ID),
            { body: commands },
        );

        console.log(`Successfully reloaded ${data.length} application (/) commands.`);
    } catch (error) {
        console.error(error);
    }
})();
