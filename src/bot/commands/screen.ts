import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import crypto from 'crypto';
import { env } from '../../config/env';
import { createDiscordAccessLink, endScreenRoom } from '../../web/server';
import { screenSessionStore } from '../state/screenSessionStore';

const screenBaseUrl = (env.SCREEN_DOMAIN || env.PUBLIC_URL).replace(/\/+$/, '');

export const data = new SlashCommandBuilder()
    .setName('screen')
    .setDescription('Cria uma sessão para compartilhar telas')
    .addSubcommand(subcommand =>
        subcommand
            .setName('start')
            .setDescription('Cria uma sessão e gera um link para compartilhar')
    )
    .addSubcommand(subcommand =>
        subcommand
            .setName('end')
            .setDescription('Encerra sua sessão de compartilhamento')
    )
    .addSubcommand(subcommand =>
        subcommand
            .setName('join')
            .setDescription('Verifica sua identidade no Discord e abre uma sala')
            .addStringOption(option =>
                option
                    .setName('room_id')
                    .setDescription('ID da sala no link de convite')
                    .setRequired(true)
            )
    );

export async function execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.inGuild() || !interaction.guildId) {
        await interaction.reply({ content: 'Use este comando em um servidor.', ephemeral: true });
        return;
    }

    const subcommand = interaction.options.getSubcommand();
    if (subcommand === 'start') {
        const existingSession = screenSessionStore.getByOwner(interaction.user.id);
        if (existingSession) {
            if (existingSession.guildId !== interaction.guildId) {
                await interaction.reply({
                    content: 'Você já tem uma sessão ativa em outro servidor. Encerre-a lá antes de criar outra.',
                    ephemeral: true
                });
                return;
            }
            const accessLink = createDiscordAccessLink(
                existingSession.roomId,
                interaction.user.id,
                interaction.guildId
            );
            if (!accessLink) {
                await interaction.reply({
                    content: 'Não foi possível gerar o acesso. Verifique se a sala ainda está ativa.',
                    ephemeral: true
                });
                return;
            }
            await interaction.reply({
                content: `Sua sessão já está ativa.\n**Abrir para transmitir:** ${accessLink}\n**Link de convite:** ${screenBaseUrl}/s/${existingSession.roomId}`,
                ephemeral: true
            });
            return;
        }

        const session = {
            roomId: crypto.randomUUID(),
            ownerId: interaction.user.id,
            guildId: interaction.guildId
        };
        screenSessionStore.start(session);
        const accessLink = createDiscordAccessLink(session.roomId, interaction.user.id, interaction.guildId);
        if (!accessLink) {
            screenSessionStore.endByOwner(interaction.user.id);
            await interaction.reply({
                content: 'Não foi possível gerar o acesso para a sala. Tente novamente.',
                ephemeral: true
            });
            return;
        }

        await interaction.reply({
            content: `Sua sala está pronta.\n**Abrir para transmitir:** ${accessLink}\n**Link de convite:** ${screenBaseUrl}/s/${session.roomId}`,
            ephemeral: true
        });
        return;
    }

    if (subcommand === 'join') {
        const roomId = interaction.options.getString('room_id', true).trim();
        const session = screenSessionStore.getByRoomId(roomId);
        if (!session) {
            await interaction.reply({
                content: 'Essa sala não está ativa. Confira o ID e tente novamente.',
                ephemeral: true
            });
            return;
        }
        if (session.guildId !== interaction.guildId) {
            await interaction.reply({
                content: 'Essa sala pertence a outro servidor Discord.',
                ephemeral: true
            });
            return;
        }

        const accessLink = createDiscordAccessLink(roomId, interaction.user.id, interaction.guildId);
        if (!accessLink) {
            await interaction.reply({
                content: 'Não foi possível gerar o acesso. Verifique se a sala ainda está ativa.',
                ephemeral: true
            });
            return;
        }

        await interaction.reply({
            content: `Identidade verificada pelo Discord. Abra este link em até 5 minutos para entrar na sala: ${accessLink}`,
            ephemeral: true
        });
        return;
    }

    const activeSession = screenSessionStore.getByOwner(interaction.user.id);
    if (activeSession && activeSession.guildId !== interaction.guildId) {
        await interaction.reply({
            content: 'Encerre sua sessão no servidor onde ela foi criada.',
            ephemeral: true
        });
        return;
    }

    const session = screenSessionStore.endByOwner(interaction.user.id);
    if (!session) {
        await interaction.reply({ content: 'Você não tem uma sessão ativa.', ephemeral: true });
        return;
    }

    endScreenRoom(session.roomId);
    await interaction.reply({ content: 'Sua sessão de transmissão foi encerrada.', ephemeral: true });
}
