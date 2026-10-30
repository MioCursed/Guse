const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const crypto = require('node:crypto');

const roomId = '11111111-1111-4111-8111-111111111111';
const guildId = '987654321098765432';
const userId = '123456789012345678';
const sessionSecret = 'test-session-secret-with-more-than-thirty-two-characters';

function createSessionToken() {
    const payload = Buffer.from(JSON.stringify({
        userId,
        guildId,
        expiresAt: Date.now() + 60 * 60 * 1000
    })).toString('base64url');
    const signature = crypto.createHmac('sha256', sessionSecret).update(payload).digest('base64url');
    return `${payload}.${signature}`;
}

test.beforeEach(async ({ context }) => {
    await context.addCookies([{
        name: 'guse_session',
        value: createSessionToken(),
        url: 'http://127.0.0.1:4173',
        httpOnly: true,
        sameSite: 'Lax'
    }]);
});

test('authenticated room, help, quality controls and local QR are available', async ({ page }) => {
    await page.goto(`/room/${roomId}`);
    await expect(page.getByRole('heading', { name: 'Uma sala para assistir junto' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Qualidade da transmissão' })).toHaveValue('1080p30');
    await expect(page.getByRole('combobox', { name: 'Tipo de fonte para compartilhar' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pop-up' })).toBeVisible();
    await expect(page.locator('#room-qr-image')).toHaveJSProperty('complete', true);
    await page.getByRole('button', { name: 'Abrir guia de dispositivos' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('link', { name: 'PS4 / PS5' })).toBeVisible();
    await page.getByRole('button', { name: 'Fechar guia' }).click();
});

test('theme toggle respects explicit user choice', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(`/room/${roomId}`);
    await page.getByRole('button', { name: 'Alternar tema claro e escuro' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.evaluate(() => localStorage.getItem('guse-theme'))).resolves.toBe('light');
});

test('initial theme follows the operating system when no choice is saved', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(`/room/${roomId}`);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('room page has no axe WCAG 2.2 AA violations', async ({ page }) => {
    await page.goto(`/room/${roomId}`);
    await expect(page.getByRole('heading', { name: 'Uma sala para assistir junto' })).toBeVisible();
    const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
    expect(results.violations).toEqual([]);
});

test('room remains within a narrow viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/room/${roomId}`);
    const sizes = await page.evaluate(() => ({
        document: document.documentElement.scrollWidth,
        viewport: window.innerWidth
    }));
    expect(sizes.document).toBeLessThanOrEqual(sizes.viewport);
    await expect(page.getByRole('button', { name: 'Transmitir minha tela' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Abrir guia de dispositivos' })).toBeVisible();
});

test('leave button returns to the public home page', async ({ page }) => {
    await page.goto(`/room/${roomId}`);
    await page.getByRole('button', { name: 'Sair da sala' }).click();
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('heading', { name: 'Sua tela, na conversa.' })).toBeVisible();
});

test('capture-device controls start, pause, resume and stop a mock video stream', async ({ page }) => {
    await page.addInitScript(() => {
        const mediaDevices = navigator.mediaDevices;
        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: new Proxy(mediaDevices, {
                get(target, property) {
                    if (property === 'getUserMedia') {
                        return async () => {
                            const canvas = document.createElement('canvas');
                            canvas.width = 640;
                            canvas.height = 360;
                            return canvas.captureStream(30);
                        };
                    }
                    if (property === 'enumerateDevices') {
                        return async () => [{
                            kind: 'videoinput',
                            deviceId: 'mock-hdmi',
                            label: 'Mock HDMI capture',
                            groupId: 'mock-group',
                            toJSON: () => ({})
                        }];
                    }
                    const value = Reflect.get(target, property, target);
                    return typeof value === 'function' ? value.bind(target) : value;
                }
            })
        });
    });
    await page.goto(`/room/${roomId}`);
    const canMockCapture = await page.evaluate(() =>
        Boolean(navigator.mediaDevices?.getUserMedia && navigator.mediaDevices?.enumerateDevices)
        && typeof document.createElement('canvas').captureStream === 'function'
    );
    test.skip(!canMockCapture, 'Mock video capture is unavailable in this browser engine.');

    await page.locator('#source-select').selectOption('capture');
    await page.getByRole('button', { name: 'Detectar dispositivos' }).click();
    await expect(page.locator('#capture-device-select')).toHaveValue('mock-hdmi');
    await page.getByRole('button', { name: 'Transmitir minha tela' }).click();
    await expect(page.locator('#stop-share-btn')).toBeVisible();
    await expect(page.locator('#pause-share-btn')).toBeEnabled();
    await page.locator('#pause-share-btn').click();
    await expect(page.locator('#pause-share-btn')).toHaveText('Retomar');
    await page.locator('#pause-share-btn').click();
    await expect(page.locator('#stop-share-btn')).toBeEnabled();
    await page.locator('#stop-share-btn').click();
    await expect(page.getByRole('button', { name: 'Transmitir minha tela' })).toBeVisible();
});

test('socket reconnects after the browser returns online', async ({ page, context }) => {
    await page.goto(`/room/${roomId}`);
    await expect(page.locator('#connection-indicator')).toContainText('Conectado');
    await context.setOffline(true);
    await expect(page.locator('#connection-indicator')).toContainText('Reconectando', { timeout: 10_000 });
    await context.setOffline(false);
    await expect(page.locator('#connection-indicator')).toContainText('Conectado', { timeout: 15_000 });
});
