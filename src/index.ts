import { client } from './bot/client';
import { startWebServer } from './web/server';
import { env } from './config/env';
import { handleInteractionCreate } from './bot/events/interactionCreate';

client.on('interactionCreate', handleInteractionCreate);

// Start everything
async function bootstrap() {
    try {
        startWebServer();
        await client.login(env.DISCORD_TOKEN);
        console.log('✅ Application successfully started.');
    } catch (error) {
        console.error('Failed to start application:', error);
        process.exit(1);
    }
}

bootstrap();
