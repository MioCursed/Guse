process.env.DISCORD_TOKEN = 'test-discord-token';
process.env.CLIENT_ID = '123456789012345678';
process.env.DISCORD_CLIENT_SECRET = '';
process.env.SESSION_SECRET = 'test-session-secret-with-more-than-thirty-two-characters';
process.env.PORT = '4173';
process.env.PUBLIC_URL = 'http://127.0.0.1:4173';
process.env.SCREEN_DOMAIN = '';
process.env.STUN_URLS = 'stun:stun.l.google.com:19302';
process.env.TURN_URLS = '';
process.env.TURN_SHARED_SECRET = '';
process.env.DISCORD_INVITE_WEBHOOK_URL = '';

const { httpServer } = require('../dist/web/server');
const { screenSessionStore } = require('../dist/bot/state/screenSessionStore');

screenSessionStore.start({
    roomId: '11111111-1111-4111-8111-111111111111',
    ownerId: '123456789012345678',
    guildId: '987654321098765432'
});

httpServer.listen(Number(process.env.PORT), '127.0.0.1', () => {
    console.log(`Playwright fixture listening on ${process.env.PORT}`);
});

function closeFixture() {
    httpServer.close(() => process.exit(0));
}

process.once('SIGINT', closeFixture);
process.once('SIGTERM', closeFixture);
