process.env.DISCORD_TOKEN = 'test-discord-token';
process.env.CLIENT_ID = '123456789012345678';
process.env.DISCORD_CLIENT_SECRET = '';
process.env.SESSION_SECRET = 'test-session-secret-with-more-than-thirty-two-characters';
process.env.PORT = '4174';
process.env.PUBLIC_URL = 'http://127.0.0.1:4174';
process.env.SCREEN_DOMAIN = '';
process.env.STUN_URLS = 'stun:stun.test.local:3478';
process.env.TURN_URLS = 'turn:turn.test.local:3478?transport=udp';
process.env.TURN_SHARED_SECRET = 'test-turn-shared-secret';
const testWebhookToken = 't'.repeat(68);
process.env.DISCORD_INVITE_WEBHOOK_URL = `https://discord.com/api/webhooks/123456789012345678/${testWebhookToken}`;

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { after, before, mock, test } = require('node:test');
const { io: createSocketClient } = require('socket.io-client');
const { app, httpServer, io } = require('../dist/web/server');
const { createSessionToken } = require('../dist/web/discordAuth');
const { screenSessionStore } = require('../dist/bot/state/screenSessionStore');
const { env } = require('../dist/config/env');

const roomId = '11111111-1111-4111-8111-111111111111';
const ownerId = '123456789012345678';
const viewerId = '234567890123456789';
const guildId = '987654321098765432';
let baseUrl;

function sessionCookie(userId, memberGuildId = guildId) {
    const token = createSessionToken({
        userId,
        guildId: memberGuildId,
        expiresAt: Date.now() + 60_000
    }, process.env.SESSION_SECRET);
    return `guse_session=${token}`;
}

function waitForEvent(socket, eventName, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.off(eventName, onEvent);
            reject(new Error(`Timed out waiting for ${eventName}`));
        }, timeoutMs);
        const onEvent = (...args) => {
            clearTimeout(timer);
            resolve(args);
        };
        socket.once(eventName, onEvent);
    });
}

function mockWebhookRequest(t, handler) {
    const originalFetch = global.fetch;
    mock.method(global, 'fetch', async (input, init) => {
        const requestUrl = input instanceof URL
            ? input
            : new URL(typeof input === 'string' ? input : input.url);
        if (requestUrl.hostname === 'discord.com' && requestUrl.pathname.startsWith('/api/webhooks/')) {
            return handler(requestUrl, init);
        }
        return originalFetch(input, init);
    });
    t.after(() => mock.restoreAll());
}

async function connectSocket(userId, memberGuildId = guildId) {
    const socket = createSocketClient(baseUrl, {
        transports: ['websocket'],
        reconnection: false,
        extraHeaders: { Cookie: sessionCookie(userId, memberGuildId) }
    });
    await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('connect_error', reject);
    });
    return socket;
}

before(async () => {
    screenSessionStore.start({ roomId, ownerId, guildId });
    await new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

after(async () => {
    await new Promise(resolve => io.close(resolve));
});

test('room endpoints issue protected ICE credentials, QR and session metadata', async () => {
    const unauthorized = await fetch(`${baseUrl}/api/rooms/${roomId}/ice`);
    assert.equal(unauthorized.status, 403);

    const cookie = sessionCookie(ownerId);
    const iceResponse = await fetch(`${baseUrl}/api/rooms/${roomId}/ice`, {
        headers: { Cookie: cookie }
    });
    assert.equal(iceResponse.status, 200);
    assert.equal(iceResponse.headers.get('cache-control'), 'no-store');
    const { iceServers } = await iceResponse.json();
    assert.deepEqual(iceServers[0], { urls: ['stun:stun.test.local:3478'] });
    assert.deepEqual(iceServers[1].urls, ['turn:turn.test.local:3478?transport=udp']);
    assert.match(iceServers[1].username, new RegExp(`:${ownerId}$`));
    assert.notEqual(iceServers[1].credential, process.env.TURN_SHARED_SECRET);
    const expectedCredential = crypto
        .createHmac('sha1', process.env.TURN_SHARED_SECRET)
        .update(iceServers[1].username)
        .digest('base64');
    assert.equal(iceServers[1].credential, expectedCredential);

    const sessionResponse = await fetch(`${baseUrl}/api/rooms/${roomId}/session`, {
        headers: { Cookie: cookie }
    });
    assert.equal(sessionResponse.status, 200);
    const roomSession = await sessionResponse.json();
    assert.equal(roomSession.viewerId, ownerId);
    assert.deepEqual(roomSession.profile, {
        userId: ownerId,
        displayName: `Discord · ${ownerId}`
    });
    assert.equal(roomSession.isOwner, true);
    assert.equal(roomSession.captureProtectionEnabled, true);

    const qrResponse = await fetch(`${baseUrl}/api/rooms/${roomId}/qr`);
    assert.equal(qrResponse.status, 200);
    assert.match(qrResponse.headers.get('content-type'), /image\/svg\+xml/);
    assert.match(await qrResponse.text(), /<svg/);

    const roomResponse = await fetch(`${baseUrl}/room/${roomId}`, {
        headers: { Cookie: cookie }
    });
    assert.equal(roomResponse.status, 200);
    assert.match(await roomResponse.text(), /Guse Screen/);

    const oauthRoute = await fetch(`${baseUrl}/auth/discord?roomId=${roomId}`, {
        redirect: 'manual'
    });
    assert.equal(oauthRoute.status, 503);

    const homeResponse = await fetch(baseUrl);
    assert.equal(homeResponse.status, 200);
    assert.match(await homeResponse.text(), /Inicie pelo Discord/);
});

test('Discord invite sending requires the room owner and a same-origin request', async t => {
    const originDenied = await fetch(`${baseUrl}/api/rooms/${roomId}/invite`, {
        method: 'POST',
        headers: { Cookie: sessionCookie(ownerId) }
    });
    assert.equal(originDenied.status, 403);
    assert.match((await originDenied.json()).error, /confirmar que este pedido veio da sala/);

    const viewerDenied = await fetch(`${baseUrl}/api/rooms/${roomId}/invite`, {
        method: 'POST',
        headers: {
            Cookie: sessionCookie(viewerId),
            Origin: process.env.PUBLIC_URL
        }
    });
    assert.equal(viewerDenied.status, 403);
    assert.match((await viewerDenied.json()).error, /Somente quem criou/);

    const configuredWebhook = env.DISCORD_INVITE_WEBHOOK_URL;
    env.DISCORD_INVITE_WEBHOOK_URL = undefined;
    t.after(() => {
        env.DISCORD_INVITE_WEBHOOK_URL = configuredWebhook;
    });
    const botUnavailable = await fetch(`${baseUrl}/api/rooms/${roomId}/invite`, {
        method: 'POST',
        headers: {
            Cookie: sessionCookie(ownerId),
            Origin: process.env.PUBLIC_URL
        }
    });
    assert.equal(botUnavailable.status, 503);
    assert.match((await botUnavailable.json()).error, /bot do Discord está offline/);
});

test('Discord invite accepts same-origin requests when the browser omits Origin', async t => {
    const configuredWebhook = env.DISCORD_INVITE_WEBHOOK_URL;
    env.DISCORD_INVITE_WEBHOOK_URL = undefined;
    t.after(() => {
        env.DISCORD_INVITE_WEBHOOK_URL = configuredWebhook;
    });

    const response = await fetch(`${baseUrl}/api/rooms/${roomId}/invite`, {
        method: 'POST',
        headers: {
            Cookie: sessionCookie(ownerId),
            'X-Requested-With': 'fetch',
            'Sec-Fetch-Site': 'same-origin',
            Referer: `${process.env.PUBLIC_URL}/room/${roomId}`
        }
    });
    const body = await response.json();
    assert.equal(response.status, 503, JSON.stringify(body));
    assert.match(body.error, /bot do Discord está offline/);
});

test('Discord invite accepts its trusted page origin when the proxy rewrites Origin', async t => {
    const configuredWebhook = env.DISCORD_INVITE_WEBHOOK_URL;
    env.DISCORD_INVITE_WEBHOOK_URL = undefined;
    t.after(() => {
        env.DISCORD_INVITE_WEBHOOK_URL = configuredWebhook;
    });

    const response = await fetch(`${baseUrl}/api/rooms/${roomId}/invite`, {
        method: 'POST',
        headers: {
            Cookie: sessionCookie(ownerId),
            Origin: 'https://proxy-internal.invalid',
            'X-Requested-With': 'fetch',
            'Sec-Fetch-Site': 'same-origin',
            Referer: `${process.env.PUBLIC_URL}/room/${roomId}`
        }
    });
    const body = await response.json();
    assert.equal(response.status, 503, JSON.stringify(body));
    assert.match(body.error, /bot do Discord está offline/);
});

test('Discord invite executes the configured webhook directly without bot permissions', async t => {
    let sentPayload;
    mockWebhookRequest(t, async (url, init) => {
        assert.equal(url.pathname, '/api/webhooks/123456789012345678/' + testWebhookToken);
        assert.equal(url.searchParams.get('wait'), 'true');
        assert.equal(init.method, 'POST');
        sentPayload = JSON.parse(init.body);
        return new Response(JSON.stringify({ id: '345678901234567890' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    });

    const response = await fetch(`${baseUrl}/api/rooms/${roomId}/invite`, {
        method: 'POST',
        headers: {
            Cookie: sessionCookie(ownerId),
            Origin: process.env.PUBLIC_URL
        }
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { sent: true });
    assert.deepEqual(sentPayload.allowed_mentions, { parse: [] });
    assert.match(sentPayload.embeds[0].description, new RegExp(`/s/${roomId}`));
});

test('Discord invite explains when its configured webhook was revoked', async t => {
    const realDateNow = Date.now;
    mock.method(Date, 'now', () => realDateNow() + 31_000);
    mockWebhookRequest(t, async () => new Response(JSON.stringify({
        message: 'Unknown Webhook',
        code: 10015
    }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
    }));

    const response = await fetch(`${baseUrl}/api/rooms/${roomId}/invite`, {
        method: 'POST',
        headers: {
            Cookie: sessionCookie(ownerId),
            Origin: process.env.PUBLIC_URL
        }
    });
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /webhook não existe mais ou a URL expirou/);
});

test('one-time access tickets are consumed and expire from reuse', async () => {
    const { createDiscordAccessLink } = require('../dist/web/server');
    const accessLink = createDiscordAccessLink(roomId, viewerId, guildId);
    assert.ok(accessLink);
    const ticket = new URL(accessLink).searchParams.get('ticket');
    const first = await fetch(`${baseUrl}/auth/discord/verify?ticket=${encodeURIComponent(ticket)}`, {
        redirect: 'manual'
    });
    assert.equal(first.status, 302);
    assert.equal(first.headers.get('location'), `/room/${roomId}`);
    assert.match(first.headers.get('set-cookie'), /HttpOnly/);
    assert.match(first.headers.get('set-cookie'), /SameSite=Lax/);
    assert.equal(first.headers.get('cache-control'), 'no-store');

    const replay = await fetch(`${baseUrl}/auth/discord/verify?ticket=${encodeURIComponent(ticket)}`);
    assert.equal(replay.status, 410);
});

test('room signaling enforces guild membership and owner-only protection controls', async () => {
    const owner = await connectSocket(ownerId);
    const viewer = await connectSocket(viewerId);
    const secondSharer = await connectSocket('456789012345678901');
    const outsiders = await connectSocket('345678901234567890', '876543210987654321');

    const ownerJoined = waitForEvent(owner, 'room-users');
    owner.emit('join-room', roomId);
    const [ownerRoom] = await ownerJoined;
    assert.equal(ownerRoom.isOwner, true);

    const viewerJoined = waitForEvent(viewer, 'room-users');
    const ownerSawViewer = waitForEvent(owner, 'user-connected');
    viewer.emit('join-room', roomId);
    const [viewerRoom] = await viewerJoined;
    assert.equal(viewerRoom.isOwner, false);
    assert.deepEqual(viewerRoom.users, [owner.id]);
    assert.deepEqual(await ownerSawViewer, [{
        socketId: viewer.id,
        userId: viewerId,
        displayName: `Discord · ${viewerId}`
    }]);

    const secondSharerJoined = waitForEvent(secondSharer, 'room-users');
    const ownerSawSecondSharer = waitForEvent(owner, 'user-connected');
    const viewerSawSecondSharer = waitForEvent(viewer, 'user-connected');
    secondSharer.emit('join-room', roomId);
    const [secondSharerRoom] = await secondSharerJoined;
    assert.deepEqual(secondSharerRoom.users, [owner.id, viewer.id]);
    await Promise.all([ownerSawSecondSharer, viewerSawSecondSharer]);

    const rejected = waitForEvent(outsiders, 'authorization-required');
    outsiders.emit('join-room', roomId);
    await rejected;

    const protectionDenied = waitForEvent(viewer, 'capture-protection-error');
    viewer.emit('set-capture-protection', false);
    assert.match((await protectionDenied)[0], /criador/);
    assert.equal(screenSessionStore.getByRoomId(roomId).captureProtectionEnabled, true);

    const protectionChanged = waitForEvent(viewer, 'capture-protection-changed');
    owner.emit('set-capture-protection', false);
    assert.deepEqual(await protectionChanged, [false]);
    assert.equal(screenSessionStore.getByRoomId(roomId).captureProtectionEnabled, false);

    const screenStarted = waitForEvent(viewer, 'screen-started');
    const started = await new Promise(resolve => {
        owner.timeout(1000).emit('start-screen', (error, response) => {
            resolve(error ? { ok: false } : response);
        });
    });
    assert.deepEqual(started, { ok: true });
    assert.deepEqual(await screenStarted, [owner.id]);

    const secondScreenStarted = waitForEvent(viewer, 'screen-started');
    const ownerSawSecondScreen = waitForEvent(owner, 'screen-started');
    const secondStarted = await new Promise(resolve => {
        secondSharer.timeout(1000).emit('start-screen', (error, response) => {
            resolve(error ? { ok: false } : response);
        });
    });
    assert.deepEqual(secondStarted, { ok: true });
    assert.deepEqual(await Promise.all([secondScreenStarted, ownerSawSecondScreen]), [
        [secondSharer.id],
        [secondSharer.id]
    ]);

    const ownerStopped = waitForEvent(secondSharer, 'screen-stopped');
    owner.emit('stop-screen');
    assert.deepEqual(await ownerStopped, [owner.id]);
    const updatedSharers = waitForEvent(secondSharer, 'room-users');
    secondSharer.emit('request-room-users');
    const [roomWithOneSharer] = await updatedSharers;
    assert.deepEqual(roomWithOneSharer.sharingUserIds, [secondSharer.id]);

    const secondStopped = waitForEvent(viewer, 'screen-stopped');
    secondSharer.emit('stop-screen');
    assert.deepEqual(await secondStopped, [secondSharer.id]);

    const relayedOffer = waitForEvent(viewer, 'offer');
    owner.emit('offer', {
        target: viewer.id,
        connectionId: 'peer-connection-1',
        offer: { type: 'offer', sdp: 'v=0\r\n' }
    });
    const [offer] = await relayedOffer;
    assert.equal(offer.from, owner.id);
    assert.equal(offer.connectionId, 'peer-connection-1');

    owner.disconnect();
    viewer.disconnect();
    secondSharer.disconnect();
    outsiders.disconnect();
});
