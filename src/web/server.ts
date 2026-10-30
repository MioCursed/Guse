import express from 'express';
import { Server as SocketIOServer } from 'socket.io';
import { createServer } from 'http';
import path from 'path';
import crypto from 'crypto';
import cors from 'cors';
import QRCode from 'qrcode';
import { EmbedBuilder } from 'discord.js';
import { env } from '../config/env';
import { client } from '../bot/client';
import { screenSessionStore } from '../bot/state/screenSessionStore';
import { createSessionToken, readCookie, readSessionToken } from './discordAuth';

export const app = express();
export const httpServer = createServer(app);
const screenBaseUrl = (env.SCREEN_DOMAIN || env.PUBLIC_URL).replace(/\/+$/, '');
const callbackUrl = new URL('/auth/discord/callback', screenBaseUrl).toString();
const cookieSecure = new URL(screenBaseUrl).protocol === 'https:';
const sessionCookieName = 'guse_session';
const stateCookieName = 'guse_oauth_state';
const oauthStates = new Map<string, { roomId: string; expiresAt: number }>();
const discordAccessTickets = new Map<string, {
    roomId: string;
    userId: string;
    guildId: string;
    expiresAt: number;
}>();
const discordAccessTicketLifetimeMs = 5 * 60 * 1000;
const inviteCooldowns = new Map<string, number>();
type DiscordProfile = { userId: string; displayName: string; avatarUrl?: string };
const discordProfiles = new Map<string, Promise<DiscordProfile>>();
const stunUrls = env.STUN_URLS.split(',').map(url => url.trim()).filter(Boolean);
const turnUrls = env.TURN_URLS.split(',').map(url => url.trim()).filter(Boolean);

async function sendWebhookInvite(webhookUrl: string, embed: EmbedBuilder) {
    const url = new URL(webhookUrl);
    url.searchParams.set('wait', 'true');
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            embeds: [embed.toJSON()],
            allowed_mentions: { parse: [] }
        }),
        signal: AbortSignal.timeout(10_000)
    });
    if (response.ok) {
        return;
    }

    let apiCode: number | undefined;
    try {
        const body: unknown = await response.json();
        if (typeof body === 'object' && body !== null && 'code' in body && typeof body.code === 'number') {
            apiCode = body.code;
        }
    } catch {
        // Keep the response safe if Discord returns an empty or non-JSON error.
    }
    console.error(`Discord webhook rejected invite (HTTP ${response.status}${apiCode ? `, code ${apiCode}` : ''}).`);
    if (response.status === 401 || response.status === 404) {
        throw new Error('O webhook não existe mais ou a URL expirou. Crie um webhook novo no canal e atualize DISCORD_INVITE_WEBHOOK_URL.');
    }
    if (response.status === 429) {
        throw new Error('O Discord limitou o envio. Aguarde alguns segundos e tente de novo.');
    }
    throw new Error(`O Discord recusou o convite (HTTP ${response.status}). Confira se o webhook ainda está ativo.`);
}

function getDiscordProfile(userId: string): Promise<DiscordProfile> {
    const cached = discordProfiles.get(userId);
    if (cached) {
        return cached;
    }

    const profileRequest = (async (): Promise<DiscordProfile> => {
        if (!client.isReady()) {
            return { userId, displayName: `Discord · ${userId}` };
        }
        try {
            const user = await client.users.fetch(userId);
            return {
                userId,
                displayName: user.globalName || user.username,
                avatarUrl: user.displayAvatarURL({ size: 64 })
            };
        } catch (error) {
            console.warn(`Could not load Discord profile ${userId}:`, error);
            return { userId, displayName: `Discord · ${userId}` };
        }
    })();
    discordProfiles.set(userId, profileRequest);
    profileRequest.then(profile => {
        if (profile.displayName === `Discord · ${userId}`) {
            discordProfiles.delete(userId);
        }
    });
    return profileRequest;
}

async function getSocketIdentity(socketId: string) {
    const socket = io.sockets.sockets.get(socketId);
    const userId = socket?.data.discordUserId;
    if (typeof userId !== 'string') {
        return { socketId, userId: '', displayName: 'Participante' };
    }
    return { socketId, ...await getDiscordProfile(userId) };
}
function getDiscordAuthConfig() {
    if (!env.DISCORD_CLIENT_SECRET) {
        return undefined;
    }

    return {
        clientSecret: env.DISCORD_CLIENT_SECRET,
        sessionSecret: env.SESSION_SECRET
    };
}

export function createDiscordAccessLink(roomId: string, userId: string, guildId: string) {
    const room = screenSessionStore.getByRoomId(roomId);
    if (!room || room.guildId !== guildId) {
        return undefined;
    }

    for (const [ticket, value] of discordAccessTickets) {
        if (value.expiresAt <= Date.now()) {
            discordAccessTickets.delete(ticket);
        }
    }

    const ticket = crypto.randomBytes(32).toString('base64url');
    discordAccessTickets.set(ticket, {
        roomId,
        userId,
        guildId,
        expiresAt: Date.now() + discordAccessTicketLifetimeMs
    });
    return `${screenBaseUrl}/auth/discord/verify?ticket=${encodeURIComponent(ticket)}`;
}

const allowedOrigins = [
    new URL(env.PUBLIC_URL).origin,
    ...(env.SCREEN_DOMAIN ? [new URL(env.SCREEN_DOMAIN).origin] : [])
];

function isAllowedInviteRequest(req: express.Request): boolean {
    const requestOrigin = req.get('origin');
    if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
        return true;
    }

    if (req.get('x-requested-with') !== 'fetch' || req.get('sec-fetch-site') !== 'same-origin') {
        return false;
    }

    const referer = req.get('referer');
    if (referer) {
        try {
            return allowedOrigins.includes(new URL(referer).origin);
        } catch {
            return false;
        }
    }

    return allowedOrigins.some(origin => new URL(origin).host === req.get('host'));
}

export const io = new SocketIOServer(httpServer, {
    maxHttpBufferSize: 1e6,
    cors: {
        origin: allowedOrigins,
        methods: ["GET", "POST"]
    }
});

app.use(cors({ origin: allowedOrigins }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'home.html'));
});

app.get('/api/rooms/:roomId/ice', (req, res) => {
    const room = screenSessionStore.getByRoomId(req.params.roomId);
    const session = readSessionToken(readCookie(req.headers.cookie, sessionCookieName), env.SESSION_SECRET);
    if (!room || !session || session.guildId !== room.guildId) {
        res.sendStatus(403);
        return;
    }

    const iceServers: RTCIceServer[] = stunUrls.length > 0
        ? [{ urls: stunUrls }]
        : [];
    if (turnUrls.length > 0 && env.TURN_SHARED_SECRET) {
        const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60;
        const username = `${expiresAt}:${session.userId}`;
        const credential = crypto
            .createHmac('sha1', env.TURN_SHARED_SECRET!)
            .update(username)
            .digest('base64');
        iceServers.push({
            urls: turnUrls,
            username,
            credential
        });
    }

    res.setHeader('Cache-Control', 'no-store');
    res.json({ iceServers });
});

app.get('/api/rooms/:roomId/session', async (req, res) => {
    const room = screenSessionStore.getByRoomId(req.params.roomId);
    const session = readSessionToken(readCookie(req.headers.cookie, sessionCookieName), env.SESSION_SECRET);
    if (!room || !session || session.guildId !== room.guildId) {
        res.sendStatus(403);
        return;
    }

    res.setHeader('Cache-Control', 'no-store');
    res.json({
        viewerId: session.userId,
        profile: await getDiscordProfile(session.userId),
        isOwner: room.ownerId === session.userId,
        captureProtectionEnabled: room.captureProtectionEnabled ?? true
    });
});

app.post('/api/rooms/:roomId/invite', async (req, res) => {
    if (!isAllowedInviteRequest(req)) {
        let refererOrigin: string | undefined;
        try {
            refererOrigin = req.get('referer') ? new URL(req.get('referer')!).origin : undefined;
        } catch {
            refererOrigin = 'invalid';
        }
        console.warn('Rejected invite request origin', {
            origin: req.get('origin') ?? 'missing',
            fetchSite: req.get('sec-fetch-site') ?? 'missing',
            host: req.get('host') ?? 'missing',
            refererOrigin: refererOrigin ?? 'missing'
        });
        res.status(403).json({ error: 'Não foi possível confirmar que este pedido veio da sala aberta. Atualize a página e tente novamente.' });
        return;
    }

    const room = screenSessionStore.getByRoomId(req.params.roomId);
    const session = readSessionToken(readCookie(req.headers.cookie, sessionCookieName), env.SESSION_SECRET);
    if (!room || !session || session.guildId !== room.guildId) {
        res.status(403).json({ error: 'Sua sessão ou sala expirou. Volte ao Discord e abra a sala pelo convite mais recente.' });
        return;
    }
    if (session.userId !== room.ownerId) {
        res.status(403).json({ error: 'Somente quem criou a sala pode enviar o convite.' });
        return;
    }
    if (!env.DISCORD_INVITE_WEBHOOK_URL && !client.isReady()) {
        res.status(503).json({ error: 'O bot do Discord está offline no momento.' });
        return;
    }

    const cooldownKey = session.userId;
    const nextAllowedAt = inviteCooldowns.get(cooldownKey) ?? 0;
    if (nextAllowedAt > Date.now()) {
        res.status(429).json({ error: 'Aguarde um pouco antes de enviar outro convite.' });
        return;
    }

    try {
        const profile = await getDiscordProfile(session.userId);
        const inviteUrl = `${screenBaseUrl}/s/${encodeURIComponent(room.roomId)}`;
        const embed = new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle('Convite para assistir junto')
            .setDescription(`[Entrar na sala](${inviteUrl})`)
            .addFields({ name: 'Enviado por', value: profile.displayName, inline: true })
            .setFooter({ text: 'Guse Screen · Entre com sua conta Discord' })
            .setTimestamp();

        if (env.DISCORD_INVITE_WEBHOOK_URL) {
            await sendWebhookInvite(env.DISCORD_INVITE_WEBHOOK_URL, embed);
        } else {
            const channel = await client.channels.fetch(env.DISCORD_INVITE_CHANNEL_ID);
            if (!channel || !channel.isTextBased() || !('guildId' in channel)) {
                res.status(503).json({ error: 'O canal de convites não está disponível.' });
                return;
            }
            if (channel.guildId !== room.guildId) {
                res.status(403).json({ error: 'O canal de convites não pertence a este servidor.' });
                return;
            }
            await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
        }

        inviteCooldowns.set(cooldownKey, Date.now() + 30_000);
        res.json({ sent: true });
    } catch (error) {
        console.error('Não foi possível enviar convite ao Discord:', error instanceof Error ? error.name : 'unknown error');
        res.status(502).json({
            error: error instanceof Error
                ? error.message
                : 'Não foi possível enviar o convite. Confira o webhook e tente novamente.'
        });
    }
});

app.get('/api/rooms/:roomId/qr', async (req, res, next) => {
    const room = screenSessionStore.getByRoomId(req.params.roomId);
    if (!room) {
        res.sendStatus(404);
        return;
    }

    try {
        const svg = await QRCode.toString(`${screenBaseUrl}/s/${encodeURIComponent(room.roomId)}`, {
            type: 'svg',
            errorCorrectionLevel: 'M',
            margin: 2,
            width: 240,
            color: { dark: '#111318', light: '#ffffff' }
        });
        res.setHeader('Cache-Control', 'no-store');
        res.type('image/svg+xml').send(svg);
    } catch (error) {
        next(error);
    }
});

app.get('/auth/discord/verify', (req, res) => {
    const ticket = typeof req.query.ticket === 'string' ? req.query.ticket : '';
    const access = discordAccessTickets.get(ticket);
    if (!access || access.expiresAt <= Date.now()) {
        discordAccessTickets.delete(ticket);
        res.status(410).send('Este link expirou ou já foi usado. Gere um novo pelo comando /screen no Discord.');
        return;
    }
    discordAccessTickets.delete(ticket);

    const room = screenSessionStore.getByRoomId(access.roomId);
    if (!room || room.guildId !== access.guildId) {
        res.status(404).send('Esta sessão não existe mais ou já foi encerrada.');
        return;
    }

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const expiresAt = Date.now() + 12 * 60 * 60 * 1000;
    res.cookie(sessionCookieName, createSessionToken({
        userId: access.userId,
        guildId: access.guildId,
        expiresAt
    }, env.SESSION_SECRET), {
        httpOnly: true,
        secure: cookieSecure,
        sameSite: 'lax',
        path: '/',
        maxAge: expiresAt - Date.now()
    });
    res.redirect(302, `/room/${encodeURIComponent(access.roomId)}`);
});

app.get('/auth/discord', (req, res) => {
    const authConfig = getDiscordAuthConfig();
    if (!authConfig) {
        res.status(503).send('O login Discord ainda não foi configurado pelo responsável pelo bot.');
        return;
    }

    const roomId = typeof req.query.roomId === 'string' ? req.query.roomId : '';
    const session = screenSessionStore.getByRoomId(roomId);
    if (!session) {
        res.sendStatus(404);
        return;
    }

    const discordSession = readSessionToken(
        readCookie(req.headers.cookie, sessionCookieName),
        authConfig.sessionSecret
    );
    if (discordSession?.guildId === session.guildId) {
        res.redirect(302, `/room/${encodeURIComponent(roomId)}`);
        return;
    }

    const state = crypto.randomBytes(32).toString('hex');
    for (const [storedState, value] of oauthStates) {
        if (value.expiresAt <= Date.now()) {
            oauthStates.delete(storedState);
        }
    }
    oauthStates.set(state, { roomId, expiresAt: Date.now() + 10 * 60 * 1000 });
    res.cookie(stateCookieName, state, {
        httpOnly: true,
        secure: cookieSecure,
        sameSite: 'lax',
        path: '/auth/discord/callback',
        maxAge: 10 * 60 * 1000
    });

    const authorizeUrl = new URL('https://discord.com/oauth2/authorize');
    authorizeUrl.search = new URLSearchParams({
        client_id: env.CLIENT_ID,
        redirect_uri: callbackUrl,
        response_type: 'code',
        scope: 'identify guilds.members.read',
        state
    }).toString();
    res.redirect(302, authorizeUrl.toString());
});

app.get('/auth/discord/callback', async (req, res) => {
    const authConfig = getDiscordAuthConfig();
    if (!authConfig) {
        res.status(503).send('O login Discord ainda não foi configurado pelo responsável pelo bot.');
        return;
    }

    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const stateCookie = readCookie(req.headers.cookie, stateCookieName);
    const storedState = oauthStates.get(state);
    res.clearCookie(stateCookieName, {
        httpOnly: true,
        secure: cookieSecure,
        sameSite: 'lax',
        path: '/auth/discord/callback'
    });

    if (!state || state !== stateCookie || !storedState || storedState.expiresAt <= Date.now()) {
        oauthStates.delete(state);
        res.status(400).send('Não foi possível validar o login. Abra o link da sessão novamente.');
        return;
    }
    oauthStates.delete(state);

    const room = screenSessionStore.getByRoomId(storedState.roomId);
    if (!room) {
        res.status(404).send('Esta sessão não existe mais ou já foi encerrada.');
        return;
    }
    if (typeof req.query.error === 'string') {
        res.status(403).send('O login com Discord foi cancelado. Você pode fechar esta página.');
        return;
    }

    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!code) {
        res.status(400).send('O Discord não retornou um código de login válido.');
        return;
    }

    const tokenResponse = await fetch('https://discord.com/api/v10/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: env.CLIENT_ID,
            client_secret: authConfig.clientSecret,
            grant_type: 'authorization_code',
            code,
            redirect_uri: callbackUrl
        })
    });
    if (!tokenResponse.ok) {
        throw new Error(`Discord OAuth token exchange failed with status ${tokenResponse.status}`);
    }

    const tokenData: unknown = await tokenResponse.json();
    if (
        typeof tokenData !== 'object' ||
        tokenData === null ||
        !('access_token' in tokenData) ||
        typeof tokenData.access_token !== 'string'
    ) {
        throw new Error('Discord OAuth token response did not contain an access token');
    }

    const userResponse = await fetch('https://discord.com/api/v10/users/@me', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    if (!userResponse.ok) {
        throw new Error(`Discord user lookup failed with status ${userResponse.status}`);
    }

    const userData: unknown = await userResponse.json();
    if (
        typeof userData !== 'object' ||
        userData === null ||
        !('id' in userData) ||
        typeof userData.id !== 'string'
    ) {
        throw new Error('Discord user response did not contain a valid user ID');
    }

    const memberResponse = await fetch(
        `https://discord.com/api/v10/users/@me/guilds/${encodeURIComponent(room.guildId)}/member`,
        { headers: { Authorization: `Bearer ${tokenData.access_token}` } }
    );
    if (memberResponse.status === 403 || memberResponse.status === 404) {
        res.status(403).send('Para entrar nesta sala, entre primeiro no servidor Discord onde ela foi criada.');
        return;
    }
    if (!memberResponse.ok) {
        throw new Error(`Discord guild membership check failed with status ${memberResponse.status}`);
    }

    const expiresAt = Date.now() + 12 * 60 * 60 * 1000;
    const sessionToken = createSessionToken(
        { userId: userData.id, guildId: room.guildId, expiresAt },
        authConfig.sessionSecret
    );
    res.cookie(sessionCookieName, sessionToken, {
        httpOnly: true,
        secure: cookieSecure,
        sameSite: 'lax',
        path: '/',
        maxAge: expiresAt - Date.now()
    });
    res.redirect(302, `/room/${encodeURIComponent(storedState.roomId)}`);
});

app.get('/s/:roomId', (req, res) => {
    if (!screenSessionStore.getByRoomId(req.params.roomId)) {
        res.sendStatus(404);
        return;
    }
    res.redirect(302, `/auth/discord?roomId=${encodeURIComponent(req.params.roomId)}`);
});

app.get('/room/:roomId', (req, res) => {
    const room = screenSessionStore.getByRoomId(req.params.roomId);
    if (!room) {
        res.sendStatus(404);
        return;
    }
    const discordSession = readSessionToken(
        readCookie(req.headers.cookie, sessionCookieName),
        env.SESSION_SECRET
    );
    if (!discordSession || discordSession.guildId !== room.guildId) {
        res.redirect(302, `/auth/discord?roomId=${encodeURIComponent(req.params.roomId)}`);
        return;
    }
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error('Web request failed:', error);
    if (res.headersSent) {
        next(error);
        return;
    }
    res.status(502).send('Não foi possível validar o login com Discord. Tente novamente.');
});

const activeSharers = new Map<string, Set<string>>();

export function endScreenRoom(roomId: string) {
    activeSharers.delete(roomId);
    for (const key of inviteCooldowns.keys()) {
        if (key.startsWith(`${roomId}:`)) {
            inviteCooldowns.delete(key);
        }
    }
    io.to(roomId).emit('screen-session-ended');
    io.in(roomId).socketsLeave(roomId);
}

io.use((socket, next) => {
    const discordSession = readSessionToken(
        readCookie(socket.handshake.headers.cookie, sessionCookieName),
        env.SESSION_SECRET
    );
    if (!discordSession) {
        next(new Error('authentication_required'));
        return;
    }

    socket.data.discordUserId = discordSession.userId;
    socket.data.guildId = discordSession.guildId;
    next();
});

io.on('connection', (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    socket.on('join-room', async (roomId) => {
        const room = typeof roomId === 'string' ? screenSessionStore.getByRoomId(roomId) : undefined;
        if (!room || socket.data.roomId === roomId) {
            socket.emit('room-not-found');
            return;
        }
        if (socket.data.guildId !== room.guildId) {
            socket.emit('authorization-required');
            socket.disconnect(true);
            return;
        }

        const previousRoomId = socket.data.roomId as string | undefined;
        if (previousRoomId) {
            stopSharing(previousRoomId, socket.id);
            socket.leave(previousRoomId);
            socket.to(previousRoomId).emit('user-disconnected', socket.id);
        }

        const existingUsers = Array.from(io.sockets.adapter.rooms.get(roomId) ?? [])
            .filter(userId => userId !== socket.id);
        socket.join(roomId);
        socket.data.roomId = roomId;
        const participants = await Promise.all(existingUsers.map(getSocketIdentity));
        socket.emit('room-users', {
            users: existingUsers,
            participants,
            sharingUserIds: Array.from(activeSharers.get(roomId) ?? []),
            isOwner: room.ownerId === socket.data.discordUserId,
            captureProtectionEnabled: room.captureProtectionEnabled ?? true
        });
        socket.to(roomId).emit('user-connected', await getSocketIdentity(socket.id));

        console.log(`Socket ${socket.id} joined room ${roomId}`);
    });

    socket.on('request-room-users', async () => {
        const roomId = socket.data.roomId as string | undefined;
        const room = roomId ? screenSessionStore.getByRoomId(roomId) : undefined;
        if (!roomId || !room) {
            return;
        }

        const users = Array.from(io.sockets.adapter.rooms.get(roomId) ?? [])
            .filter(userId => userId !== socket.id);
        const participants = await Promise.all(users.map(getSocketIdentity));
        socket.emit('room-users', {
            users,
            participants,
            sharingUserIds: Array.from(activeSharers.get(roomId) ?? []),
            isOwner: room.ownerId === socket.data.discordUserId,
            captureProtectionEnabled: room.captureProtectionEnabled ?? true
        });
    });

    const relayToPeer = (event: string, value: unknown) => {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            return;
        }
        const data = value as Record<string, unknown>;
        const roomId = socket.data.roomId as string | undefined;
        const validConnectionId = event === 'request-screen'
            ? data.connectionId === undefined
            : typeof data.connectionId === 'string' && data.connectionId.length <= 80;
        const validSignalPayload = event === 'request-screen'
            || (event === 'ice-candidate'
                ? typeof data.candidate === 'object' && data.candidate !== null
                : typeof data[event] === 'object' && data[event] !== null
                    && typeof (data[event] as Record<string, unknown>).sdp === 'string'
                    && ((data[event] as Record<string, unknown>).sdp as string).length <= 100_000);
        if (
            typeof data.target !== 'string' ||
            data.target.length > 80 ||
            !validConnectionId ||
            !validSignalPayload ||
            !roomId ||
            !screenSessionStore.getByRoomId(roomId)
        ) {
            return;
        }

        const room = io.sockets.adapter.rooms.get(roomId);
        if (room?.has(data.target)) {
            io.to(data.target).emit(event, { ...data, from: socket.id });
        }
    };

    socket.on('offer', (data) => relayToPeer('offer', data));
    socket.on('answer', (data) => relayToPeer('answer', data));
    socket.on('ice-candidate', (data) => relayToPeer('ice-candidate', data));
    socket.on('request-screen', (target) => relayToPeer('request-screen', { target }));

    socket.on('start-screen', (callback?: (result: { ok: boolean; message?: string }) => void) => {
        const respond = (result: { ok: boolean; message?: string }) => {
            if (typeof callback === 'function') {
                callback(result);
            }
        };
        const roomId = socket.data.roomId as string | undefined;
        if (!roomId || !screenSessionStore.getByRoomId(roomId)) {
            respond({ ok: false, message: 'Esta sessão não está mais ativa.' });
            return;
        }

        const roomSharers = activeSharers.get(roomId) ?? new Set<string>();
        roomSharers.add(socket.id);
        activeSharers.set(roomId, roomSharers);
        socket.to(roomId).emit('screen-started', socket.id);
        respond({ ok: true });
    });

    socket.on('stop-screen', () => {
        const roomId = socket.data.roomId as string | undefined;
        if (roomId) {
            stopSharing(roomId, socket.id);
        }
    });

    socket.on('set-capture-protection', (enabled: unknown) => {
        const roomId = socket.data.roomId as string | undefined;
        const room = roomId ? screenSessionStore.getByRoomId(roomId) : undefined;
        if (
            typeof enabled !== 'boolean' ||
            !room ||
            room.ownerId !== socket.data.discordUserId ||
            !screenSessionStore.setCaptureProtection(room.roomId, socket.data.discordUserId, enabled)
        ) {
            socket.emit('capture-protection-error', 'Somente o criador da sala pode alterar essa proteção.');
            return;
        }

        io.to(room.roomId).emit('capture-protection-changed', enabled);
    });

    socket.on('screen-paused', (paused: unknown) => {
        const roomId = socket.data.roomId as string | undefined;
        if (
            typeof paused === 'boolean' &&
            roomId &&
            activeSharers.get(roomId)?.has(socket.id)
        ) {
            socket.to(roomId).emit(paused ? 'screen-paused' : 'screen-resumed', socket.id);
        }
    });

    socket.on('latency-probe', (sentAt: unknown) => {
        if (typeof sentAt === 'number' && Number.isFinite(sentAt)) {
            socket.emit('latency-result', sentAt);
        }
    });

    socket.on('disconnect', () => {
        const roomId = socket.data.roomId as string | undefined;
        if (!roomId) {
            return;
        }

        stopSharing(roomId, socket.id);
        socket.to(roomId).emit('user-disconnected', socket.id);
    });
});

function stopSharing(roomId: string, socketId: string) {
    const roomSharers = activeSharers.get(roomId);
    if (roomSharers?.delete(socketId)) {
        if (roomSharers.size === 0) {
            activeSharers.delete(roomId);
        }
        io.to(roomId).emit('screen-stopped', socketId);
    }
}

export function startWebServer() {
    const port = parseInt(env.PORT, 10);
    httpServer.listen(port, () => {
        console.log(`🚀 Web server listening on port ${port}`);
        console.log(`🌍 Public URL: ${screenBaseUrl}`);
        console.log(`🔐 Discord OAuth callback URL: ${callbackUrl}`);
    });
}
