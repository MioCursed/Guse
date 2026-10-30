const { test, expect, chromium } = require('@playwright/test');
const crypto = require('node:crypto');

const roomId = '11111111-1111-4111-8111-111111111111';
const sessionSecret = 'test-session-secret-with-more-than-thirty-two-characters';

function createSessionToken() {
    const payload = Buffer.from(JSON.stringify({
        userId: '123456789012345678',
        guildId: '987654321098765432',
        expiresAt: Date.now() + 60 * 60 * 1000
    })).toString('base64url');
    const signature = crypto.createHmac('sha256', sessionSecret).update(payload).digest('base64url');
    return `${payload}.${signature}`;
}

test('Lighthouse accessibility score is at least 95 and records performance', async ({ baseURL }) => {
    test.setTimeout(120_000);
    const lighthouse = (await import('lighthouse')).default;
    const { launch } = await import('chrome-launcher');
    const chrome = await launch({
        chromePath: chromium.executablePath(),
        chromeFlags: ['--headless', '--no-sandbox', '--disable-dev-shm-usage']
    });
    let result;
    try {
        result = await lighthouse(`${baseURL}/room/${roomId}`, {
            port: chrome.port,
            extraHeaders: { Cookie: `guse_session=${createSessionToken()}` },
            logLevel: 'error',
            output: 'json',
            onlyCategories: ['accessibility', 'performance']
        });
    } finally {
        await chrome.kill();
    }

    const accessibilityScore = result.lhr.categories.accessibility.score * 100;
    const performanceScore = result.lhr.categories.performance.score * 100;
    console.log(`Lighthouse scores — accessibility: ${accessibilityScore}, performance: ${performanceScore}`);
    expect(accessibilityScore).toBeGreaterThanOrEqual(95);
    expect(Number.isFinite(performanceScore)).toBe(true);
});
