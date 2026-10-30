import { CommandInteraction, SlashCommandBuilder, ChannelType, PermissionsBitField, VoiceChannel } from 'discord.js';
import { meetingStore, ActiveMeeting } from '../state/meetingStore';
import { env } from '../../config/env';
import crypto from 'crypto';

export const data = new SlashCommandBuilder()
    .setName('meet')
    .setDescription('Gerencia reuniões estilo Google Meet')
    .addSubcommand(subcommand =>
        subcommand
            .setName('start')
            .setDescription('Inicia uma nova reunião')
            .addStringOption(option =>
                option.setName('mode')
                    .setDescription('Modo da reunião')
                    .setRequired(true)
                    .addChoices(
                        { name: 'Native (Discord Voice)', value: 'native' },
                        { name: 'Web (Browser WebRTC)', value: 'web' },
                        { name: 'Hybrid (Ambos)', value: 'hybrid' }
                    )
            )
            .addStringOption(option =>
                option.setName('privacy')
                    .setDescription('Privacidade da sala')
                    .setRequired(true)
                    .addChoices(
                        { name: 'Open (Qualquer um entra)', value: 'open' },
                        { name: 'Locked (Requer aprovação)', value: 'locked' }
                    )
            )
    )
    .addSubcommand(subcommand =>
        subcommand
            .setName('end')
            .setDescription('Encerra a reunião atual')
    );

export async function execute(interaction: CommandInteraction) {
    if (!interaction.isChatInputCommand()) return;
    
    // Defer the reply to give us time to process
    await interaction.deferReply();

    const subcommand = interaction.options.getSubcommand();
    const guild = interaction.guild;
    const member = await guild?.members.fetch(interaction.user.id).catch(() => null);

    if (!guild || !member) {
        return interaction.editReply('Este comando só pode ser usado em um servidor.');
    }

    if (subcommand === 'start') {
        const mode = interaction.options.getString('mode', true) as 'native' | 'web' | 'hybrid';
        const privacy = interaction.options.getString('privacy', true) as 'open' | 'locked';

        // Check if host already has an active meeting
        if (meetingStore.getMeetingByHostId(interaction.user.id)) {
            return interaction.editReply('Você já tem uma reunião ativa! Use `/meet end` para encerrá-la antes de criar outra.');
        }

        const meetingInfo: ActiveMeeting = {
            hostId: interaction.user.id,
            mode,
            privacy
        };

        let responseMessage = `Reunião iniciada por ${interaction.user.username}!\n`;
        const components: any[] = [];

        try {
            // Handle Native/Hybrid mode (Discord Voice Channel)
            if (mode === 'native' || mode === 'hybrid') {
                const overwrites: any[] = [
                    {
                        id: guild.roles.everyone.id,
                        deny: privacy === 'locked' ? [PermissionsBitField.Flags.Connect] : [],
                        allow: privacy === 'open' ? [PermissionsBitField.Flags.Connect] : []
                    },
                    {
                        id: interaction.user.id,
                        allow: [PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak, PermissionsBitField.Flags.Stream, PermissionsBitField.Flags.ViewChannel]
                    },
                    {
                        id: interaction.client.user.id,
                        allow: [PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.ManageRoles, PermissionsBitField.Flags.ViewChannel]
                    }
                ];

                const voiceChannel = await guild.channels.create({
                    name: `🟢 Meet - ${interaction.user.username}`,
                    type: ChannelType.GuildVoice,
                    permissionOverwrites: overwrites,
                    reason: 'Comando /meet start'
                });

                meetingInfo.voiceChannelId = voiceChannel.id;
                responseMessage += `**Canal de Voz:** <#${voiceChannel.id}>\n`;

                if (privacy === 'locked') {
                    components.push({
                        type: 1, // ActionRow
                        components: [{
                            type: 2, // Button
                            style: 1, // Primary
                            label: 'Pedir para Participar',
                            customId: `join_meet_${interaction.user.id}`
                        }]
                    });
                }
            }

            // Handle Web/Hybrid mode (WebRTC)
            if (mode === 'web' || mode === 'hybrid') {
                const roomId = crypto.randomUUID();
                meetingInfo.roomId = roomId;
                const url = `${env.PUBLIC_URL}/room/${roomId}`;
                responseMessage += `**Link WebRTC:** [Entrar pelo Navegador](${url})\n`;
                
                if(components.length === 0) {
                     components.push({ type: 1, components: [] });
                }
                
                components[0].components.push({
                    type: 2, // Button
                    style: 5, // Link
                    label: 'Abrir no Navegador',
                    url: url
                });
            }

            meetingStore.startMeeting(interaction.user.id, meetingInfo);

            await interaction.editReply({
                content: responseMessage,
                components: components.length > 0 ? components : undefined
            });

        } catch (error) {
            console.error('Error creating meeting:', error);
            await interaction.editReply('Ocorreu um erro ao tentar criar a reunião. Verifique as permissões do bot.');
        }

    } else if (subcommand === 'end') {
        const meetingInfo = meetingStore.endMeeting(interaction.user.id);
        
        if (!meetingInfo) {
             return interaction.editReply('Você não tem nenhuma reunião ativa para encerrar.');
        }

        try {
            if (meetingInfo.voiceChannelId) {
                const channel = await guild.channels.fetch(meetingInfo.voiceChannelId).catch(() => null);
                if (channel) {
                    await channel.delete('Host encerrou a reunião pelo comando /meet end');
                }
            }
            // Note: WebRTC room invalidation is handled by not serving the route, or emitting a close event via socket.
            // For simplicity here, deleting from store prevents new joins via bot logic.

            await interaction.editReply('Sua reunião foi encerrada e o canal (se existia) foi deletado.');
        } catch (error) {
             console.error('Error ending meeting:', error);
             await interaction.editReply('Ocorreu um erro ao tentar encerrar a reunião (talvez o canal já tenha sido deletado).');
        }
    }
}
