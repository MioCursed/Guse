import { Interaction } from 'discord.js';
import { execute as executeScreenCommand } from '../commands/screen';

export async function handleInteractionCreate(interaction: Interaction) {
    if (interaction.isChatInputCommand() && interaction.commandName === 'screen') {
        await executeScreenCommand(interaction);
    }
}
