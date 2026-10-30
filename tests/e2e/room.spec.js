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

test('home page presents the Guse brand and remains responsive', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /Sua tela\.\s*Seu momento\./ })).toBeVisible();
    await expect(page.getByRole('img', { name: /Ilustração de uma tela compartilhada/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /Como funciona/ })).toHaveAttribute('href', '#como-funciona');
    await expect(page.getByRole('heading', { name: 'Do convite à transmissão' })).toBeVisible();
    for (const width of [320, 360, 390, 768, 1024, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        const sizes = await page.evaluate(() => ({
            document: document.documentElement.scrollWidth,
            viewport: window.innerWidth
        }));
        expect(sizes.document, `home page overflows horizontally at ${width}px`).toBeLessThanOrEqual(sizes.viewport);
    }
});

test('home page has no axe WCAG 2.2 AA violations', async ({ page }) => {
    await page.goto('/');
    const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
    expect(results.violations).toEqual([]);
});

test.beforeEach(async ({ context }) => {
    await context.addCookies([{
        name: 'guse_session',
        value: createSessionToken(),
        url: 'http://127.0.0.1:4173',
        httpOnly: true,
        sameSite: 'Lax'
    }]);
});

test('verified room, help, sharing options and QR are available', async ({ page }) => {
    await page.goto(`/room/${roomId}`);
    await expect(page.getByRole('heading', { name: 'Assistindo juntos' })).toBeVisible();
    await page.locator('#capture-settings > summary').click();
    await expect(page.locator('#quality-select')).toHaveValue('1080p30');
    await expect(page.getByRole('button', { name: 'Flutuar' })).toBeVisible();
    await expect(page.locator('#room-qr-image')).toHaveJSProperty('complete', true);
    await expect(page.locator('#viewer-list')).toContainText('Discord · 123456789012345678');
    await page.getByRole('button', { name: 'Ajuda' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByText('Xbox', { exact: true })).toBeVisible();
    await expect(page.getByText('PlayStation 4 ou 5')).toBeVisible();
    await page.getByRole('button', { name: 'Fechar ajuda' }).click();
});

test('room explains when this browser cannot share its screen', async ({ page }) => {
    await page.addInitScript(() => {
        const mediaDevices = navigator.mediaDevices;
        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: new Proxy(mediaDevices, {
                get(target, property) {
                    if (property === 'getDisplayMedia') {
                        return undefined;
                    }
                    const value = Reflect.get(target, property, target);
                    return typeof value === 'function' ? value.bind(target) : value;
                }
            })
        });
    });
    await page.goto(`/room/${roomId}`);
    await expect(page.locator('#status-message')).toContainText('não compartilhar a tela nesta sala');
    await expect(page.locator('#share-btn')).toBeDisabled();
    await page.getByRole('button', { name: 'Ajuda' }).click();
    await expect(page.locator('#help-dialog')).toContainText('Um app nativo Guse seria necessário');
    await expect(page.locator('#help-dialog')).toContainText('não aparece nesta sala');
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
    await expect(page.getByRole('heading', { name: 'Assistindo juntos' })).toBeVisible();
    const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
    expect(results.violations).toEqual([]);
});

test('room controls fit a phone screen without horizontal scrolling', async ({ page }) => {
    await page.goto(`/room/${roomId}`);
    for (const width of [320, 360, 390, 430]) {
        await page.setViewportSize({ width, height: 740 });
        const sizes = await page.evaluate(() => ({
            document: document.documentElement.scrollWidth,
            viewport: window.innerWidth,
            footerTop: document.querySelector('.controls').getBoundingClientRect().top,
            viewerBottom: document.querySelector('.viewer-panel').getBoundingClientRect().bottom
        }));
        expect(sizes.document, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(sizes.viewport);
        expect(sizes.viewerBottom, `participants panel overlaps controls at ${width}px`).toBeLessThan(sizes.footerTop);
    }
    await page.setViewportSize({ width: 320, height: 740 });
    await expect(page.locator('#share-btn')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Ajuda' })).toBeVisible();
});

test('phone-sized floating player can be opened and closed in-page', async ({ page }) => {
    await page.addInitScript(() => {
        Object.defineProperty(window, 'documentPictureInPicture', {
            configurable: true,
            value: undefined
        });
        Object.defineProperty(HTMLVideoElement.prototype, 'requestPictureInPicture', {
            configurable: true,
            value: undefined
        });
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/room/${roomId}`);
    await page.getByRole('button', { name: 'Flutuar' }).click();
    await expect(page.locator('#mobile-pip')).toBeVisible();
    await expect(page.locator('#mobile-pip')).toContainText('Aguardando alguém compartilhar');
    await expect(page.locator('.capture-watermark, .pip-watermark')).toHaveCount(0);
    await page.getByRole('button', { name: 'Fechar janela flutuante' }).click();
    await expect(page.locator('#mobile-pip')).toBeHidden();
});

test('leave button returns to the public home page', async ({ page }) => {
    await page.goto(`/room/${roomId}`);
    await page.getByRole('button', { name: 'Sair da sala' }).click();
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('heading', { name: /Sua tela\.\s*Seu momento\./ })).toBeVisible();
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

    await page.locator('#capture-settings > summary').click();
    await expect(page.locator('#capture-settings')).toHaveAttribute('open', '');
    if (page.context().browser()?.browserType().name() === 'webkit') {
        await page.locator('#source-select').evaluate(select => {
            select.value = 'capture';
            select.dispatchEvent(new Event('change', { bubbles: true }));
        });
    } else {
        await page.locator('#source-select').selectOption('capture');
    }
    await page.getByRole('button', { name: 'Procurar dispositivos' }).click();
    await expect(page.locator('#capture-device-select')).toHaveValue('mock-hdmi');
    await page.locator('#share-btn').click();
    await expect(page.locator('#stop-share-btn')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Enviar convite no Discord' })).toBeVisible();
    await page.getByRole('button', { name: 'Enviar convite no Discord' }).click();
    await expect(page.locator('#status-message')).toContainText('bot do Discord está offline');
    await expect(page.locator('.capture-watermark, .pip-watermark')).toHaveCount(0);
    await expect(page.locator('#pause-share-btn')).toBeEnabled();
    await page.locator('#pause-share-btn').click();
    await expect(page.locator('#pause-share-btn')).toHaveText('Retomar');
    await page.locator('#pause-share-btn').click();
    await expect(page.locator('#stop-share-btn')).toBeEnabled();
    await page.locator('#stop-share-btn').click();
    await expect(page.locator('#share-btn')).toBeVisible();
});

test('socket reconnects after the browser returns online', async ({ page, context }) => {
    await page.goto(`/room/${roomId}`);
    await expect(page.locator('#connection-indicator')).toContainText('Conectado');
    await context.setOffline(true);
    await expect(page.locator('#connection-indicator')).toContainText('Reconectando', { timeout: 10_000 });
    await context.setOffline(false);
    await expect(page.locator('#connection-indicator')).toContainText('Conectado', { timeout: 15_000 });
});
