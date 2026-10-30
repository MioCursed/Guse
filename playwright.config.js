const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
    testDir: './tests/e2e',
    fullyParallel: true,
    reporter: 'list',
    timeout: 30_000,
    expect: { timeout: 8_000 },
    use: {
        baseURL: 'http://127.0.0.1:4173',
        trace: 'retain-on-failure'
    },
    projects: [
        { name: 'chromium', testMatch: '**/room.spec.js', use: { ...devices['Desktop Chrome'] } },
        { name: 'firefox', testMatch: '**/room.spec.js', use: { ...devices['Desktop Firefox'] } },
        { name: 'webkit', testMatch: '**/room.spec.js', use: { ...devices['Desktop Safari'] } },
        { name: 'chromium-mobile', testMatch: '**/room.spec.js', use: { ...devices['Pixel 7'] } },
        { name: 'webkit-mobile', testMatch: '**/room.spec.js', use: { ...devices['iPhone 13'] } },
        { name: 'lighthouse', testMatch: '**/lighthouse.spec.js', use: { browserName: 'chromium' } }
    ],
    webServer: {
        command: 'node tests/fixture-server.js',
        url: 'http://127.0.0.1:4173/',
        reuseExistingServer: !process.env.CI,
        timeout: 30_000
    }
});
