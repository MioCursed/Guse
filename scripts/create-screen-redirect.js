require('dotenv').config();

const source = process.argv[2];
if (!source) {
    console.error('Uso: npm run screen:redirect -- <link-da-sala>');
    process.exit(1);
}

let sourceUrl;
try {
    sourceUrl = new URL(source);
} catch {
    console.error('Informe o link completo da sala, incluindo https://.');
    process.exit(1);
}

const match = sourceUrl.pathname.match(/^\/(?:room|s)\/([0-9a-f]{8}-[0-9a-f-]{27})$/i);
if (!match) {
    console.error('O link precisa apontar para uma sala do Guse Screen.');
    process.exit(1);
}

let publicUrl;
try {
    publicUrl = new URL(process.env.SCREEN_DOMAIN || process.env.PUBLIC_URL || sourceUrl.origin);
} catch {
    console.error('PUBLIC_URL precisa ser um endereço válido.');
    process.exit(1);
}

console.log(`${publicUrl.origin}/s/${match[1]}`);
