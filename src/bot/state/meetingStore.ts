export interface ActiveMeeting {
    hostId: string;
    voiceChannelId?: string;
    roomId?: string;
    mode: 'native' | 'web' | 'hybrid';
    privacy: 'open' | 'locked';
}

class MeetingStore {
    private meetings = new Map<string, ActiveMeeting>(); // key is hostId

    startMeeting(hostId: string, meeting: ActiveMeeting) {
        this.meetings.set(hostId, meeting);
    }

    getMeetingByHostId(hostId: string) {
        return this.meetings.get(hostId);
    }

    getMeetingByVoiceChannelId(channelId: string) {
        for (const [hostId, meeting] of this.meetings.entries()) {
            if (meeting.voiceChannelId === channelId) {
                return { hostId, meeting };
            }
        }
        return null;
    }

    endMeeting(hostId: string) {
        const meeting = this.meetings.get(hostId);
        if (meeting) {
            this.meetings.delete(hostId);
        }
        return meeting;
    }
}

export const meetingStore = new MeetingStore();
