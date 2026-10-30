import { Interaction, PermissionsBitField, VoiceChannel } from 'discord.js';
import { meetingStore } from '../state/meetingStore';

export async function handleInteractionCreate(interaction: Interaction) {
    if (interaction.isCommand()) {
        const commandName = interaction.commandName;
        // Basic command routing (you'd typically use a command registry)
        if (commandName === 'meet') {
            const meetCommand = require('../commands/meet');
            await meetCommand.execute(interaction);
        }
    } else if (interaction.isButton()) {
        const customId = interaction.customId;

        if (customId.startsWith('join_meet_')) {
            const hostId = customId.split('_')[2];
            const meeting = meetingStore.getMeetingByHostId(hostId);

            if (!meeting) {
                return interaction.reply({ content: 'Esta reunião não está mais ativa.', ephemeral: true });
            }

            if (meeting.privacy === 'open') {
                return interaction.reply({ content: 'Esta reunião é aberta, você pode entrar diretamente no canal de voz!', ephemeral: true });
            }

            // If locked, send a request to the host
            const hostMember = await interaction.guild?.members.fetch(hostId).catch(() => null);
            if (!hostMember) {
                return interaction.reply({ content: 'Não foi possível encontrar o anfitrião.', ephemeral: true });
            }

            try {
                await hostMember.send({
                    content: `O usuário **${interaction.user.username}** pediu para entrar na sua reunião.`,
                    components: [{
                        type: 1,
                        components: [
                            {
                                type: 2,
                                style: 3, // SUCCESS
                                label: 'Aprovar',
                                customId: `approve_join_${interaction.user.id}_${meeting.voiceChannelId}`
                            },
                            {
                                type: 2,
                                style: 4, // DANGER
                                label: 'Recusar',
                                customId: `deny_join_${interaction.user.id}`
                            }
                        ]
                    }]
                });
                await interaction.reply({ content: 'Pedido enviado ao anfitrião! Aguarde aprovação.', ephemeral: true });
            } catch (err) {
                 await interaction.reply({ content: 'O anfitrião tem DMs desativadas. Não foi possível enviar o pedido.', ephemeral: true });
            }
        } else if (customId.startsWith('approve_join_')) {
             const [_, __, targetUserId, channelId] = customId.split('_');
             
             try {
                const channel = await interaction.guild?.channels.fetch(channelId) as VoiceChannel;
                if (!channel) {
                     return interaction.reply({ content: 'O canal da reunião não existe mais.', ephemeral: true });
                }

                await channel.permissionOverwrites.create(targetUserId, {
                    Connect: true,
                    Stream: true
                });

                await interaction.reply({ content: `Permissão concedida para <@${targetUserId}>!`, ephemeral: true });
                
                const targetUser = await interaction.client.users.fetch(targetUserId).catch(() => null);
                if(targetUser) {
                    await targetUser.send(`Sua entrada na reunião foi **aprovada**! Você já pode entrar no canal ${channel.name}.`).catch(()=>null);
                }
             } catch(err) {
                 console.error(err);
                 await interaction.reply({ content: 'Erro ao aprovar permissão.', ephemeral: true });
             }

        } else if (customId.startsWith('deny_join_')) {
            const targetUserId = customId.split('_')[2];
            await interaction.reply({ content: 'Pedido recusado.', ephemeral: true });
            
            const targetUser = await interaction.client.users.fetch(targetUserId).catch(() => null);
            if(targetUser) {
                await targetUser.send(`Sua entrada na reunião foi **recusada** pelo anfitrião.`).catch(()=>null);
            }
        }
    }
}
