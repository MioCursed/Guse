export interface ScreenSession {
    roomId: string;
    ownerId: string;
    guildId: string;
    captureProtectionEnabled?: boolean;
}

class ScreenSessionStore {
    private readonly sessionsByRoom = new Map<string, ScreenSession>();
    private readonly roomByOwner = new Map<string, string>();

    getByRoomId(roomId: string) {
        return this.sessionsByRoom.get(roomId);
    }

    getByOwner(ownerId: string) {
        const roomId = this.roomByOwner.get(ownerId);
        return roomId ? this.sessionsByRoom.get(roomId) : undefined;
    }

    start(session: ScreenSession) {
        this.sessionsByRoom.set(session.roomId, {
            ...session,
            captureProtectionEnabled: session.captureProtectionEnabled ?? true
        });
        this.roomByOwner.set(session.ownerId, session.roomId);
    }

    setCaptureProtection(roomId: string, ownerId: string, enabled: boolean) {
        const session = this.sessionsByRoom.get(roomId);
        if (!session || session.ownerId !== ownerId) {
            return false;
        }

        session.captureProtectionEnabled = enabled;
        return true;
    }

    endByOwner(ownerId: string) {
        const session = this.getByOwner(ownerId);
        if (session) {
            this.sessionsByRoom.delete(session.roomId);
            this.roomByOwner.delete(ownerId);
        }
        return session;
    }
}

export const screenSessionStore = new ScreenSessionStore();
