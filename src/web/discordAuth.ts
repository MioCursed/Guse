import { createHmac, timingSafeEqual } from 'crypto';

export interface DiscordSession {
    userId: string;
    guildId: string;
    expiresAt: number;
}

export function createSessionToken(session: DiscordSession, secret: string) {
    const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
    const signature = createHmac('sha256', secret).update(payload).digest('base64url');
    return `${payload}.${signature}`;
}

export function readSessionToken(token: string | undefined, secret: string): DiscordSession | undefined {
    if (!token) {
        return undefined;
    }

    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra) {
        return undefined;
    }

    const expectedSignature = createHmac('sha256', secret).update(payload).digest();
    let providedSignature: Buffer;
    try {
        providedSignature = Buffer.from(signature, 'base64url');
    } catch {
        return undefined;
    }

    if (
        providedSignature.length !== expectedSignature.length ||
        !timingSafeEqual(providedSignature, expectedSignature)
    ) {
        return undefined;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
        return undefined;
    }

    if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !('userId' in parsed) ||
        typeof parsed.userId !== 'string' ||
        !('guildId' in parsed) ||
        typeof parsed.guildId !== 'string' ||
        !('expiresAt' in parsed) ||
        typeof parsed.expiresAt !== 'number' ||
        parsed.expiresAt <= Date.now()
    ) {
        return undefined;
    }

    return {
        userId: parsed.userId,
        guildId: parsed.guildId,
        expiresAt: parsed.expiresAt
    };
}

export function readCookie(cookieHeader: string | undefined, name: string) {
    if (!cookieHeader) {
        return undefined;
    }

    const prefix = `${name}=`;
    const cookie = cookieHeader.split(';').map(value => value.trim()).find(value => value.startsWith(prefix));
    return cookie?.slice(prefix.length);
}
