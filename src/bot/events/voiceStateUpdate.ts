import { VoiceState } from 'discord.js';
import { meetingStore } from '../state/meetingStore';

export async function handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState) {
    // If a user left a voice channel
    if (oldState.channelId && !newState.channelId || oldState.channelId !== newState.channelId) {
        const channel = oldState.channel;
        if (!channel) return;

        // Check if the channel is a meeting channel we track
        const meetingInfo = meetingStore.getMeetingByVoiceChannelId(channel.id);
        if (meetingInfo) {
            // Check if channel is empty (or only bots left)
            const humanMembers = channel.members.filter(m => !m.user.bot);
            if (humanMembers.size === 0) {
                console.log(`Channel ${channel.name} is empty. Starting 60s cleanup timer.`);
                
                // Set a timeout to delete the channel if it remains empty
                setTimeout(async () => {
                    try {
                        const currentChannel = await channel.guild.channels.fetch(channel.id).catch(() => null);
                        if (currentChannel && currentChannel.isVoiceBased()) {
                            const currentHumanMembers = currentChannel.members.filter(m => !m.user.bot);
                            if (currentHumanMembers.size === 0) {
                                console.log(`Deleting empty meeting channel: ${currentChannel.name}`);
                                await currentChannel.delete('Meeting ended (auto-cleanup due to inactivity)');
                                meetingStore.endMeeting(meetingInfo.hostId);
                            } else {
                                console.log(`Channel ${currentChannel.name} is no longer empty. Cleanup aborted.`);
                            }
                        }
                    } catch (error) {
                        console.error('Error auto-cleaning voice channel:', error);
                    }
                }, 60000); // 60 seconds grace period
            }
        }
    }
}
