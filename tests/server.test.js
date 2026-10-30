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
const { client } = require('../dist/bot/client');

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

test('Discord invite sending requires the room owner and a same-origin request', async () => {
    const originDenied = await fetch(`${baseUrl}/api/rooms/${roomId}/invite`, {
        method: 'POST',
        headers: { Cookie: sessionCookie(ownerId) }
    });
    assert.equal(originDenied.status, 403);
    assert.match((await originDenied.json()).error, /Recarregue a sala/);

    const viewerDenied = await fetch(`${baseUrl}/api/rooms/${roomId}/invite`, {
        method: 'POST',
        headers: {
            Cookie: sessionCookie(viewerId),
            Origin: process.env.PUBLIC_URL
        }
    });
    assert.equal(viewerDenied.status, 403);
    assert.match((await viewerDenied.json()).error, /Somente quem criou/);

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

test('Discord invite uses the configured same-server webhook', async t => {
    let sentPayload;
    mock.method(client, 'isReady', () => true);
    mock.method(client, 'fetchWebhook', async (id, token) => {
        assert.equal(id, '123456789012345678');
        assert.equal(token, testWebhookToken);
        return {
            guildId,
            send: async payload => {
                sentPayload = payload;
            }
        };
    });
    mock.method(client.users, 'fetch', async () => ({
        globalName: 'Test User',
        username: 'test-user',
        displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/test.png'
    }));
    t.after(() => mock.restoreAll());

    const response = await fetch(`${baseUrl}/api/rooms/${roomId}/invite`, {
        method: 'POST',
        headers: {
            Cookie: sessionCookie(ownerId),
            Origin: process.env.PUBLIC_URL
        }
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { sent: true });
    assert.equal(sentPayload.allowedMentions.parse.length, 0);
    assert.match(sentPayload.embeds[0].data.description, new RegExp(`/s/${roomId}`));
});

test('Discord invite rejects a webhook from another server', async t => {
    const realDateNow = Date.now;
    mock.method(Date, 'now', () => realDateNow() + 31_000);
    mock.method(client, 'isReady', () => true);
    mock.method(client, 'fetchWebhook', async () => ({
        guildId: '876543210987654321',
        send: async () => assert.fail('Must not send to a webhook in another server')
    }));
    mock.method(client.users, 'fetch', async () => ({
        globalName: 'Test User',
        username: 'test-user',
        displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/test.png'
    }));
    t.after(() => mock.restoreAll());

    const response = await fetch(`${baseUrl}/api/rooms/${roomId}/invite`, {
        method: 'POST',
        headers: {
            Cookie: sessionCookie(ownerId),
            Origin: process.env.PUBLIC_URL
        }
    });
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /não pertence a este servidor/);
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
    outsiders.disconnect();
});
