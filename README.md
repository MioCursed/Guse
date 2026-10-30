# Guse Screen

Uma sala web para compartilhar telas com pessoas autenticadas pelo Discord. O navegador sempre pede que a pessoa escolha e autorize a fonte de captura.

## Rodar localmente

Requisitos: Node.js 20+ e uma aplicação/bot Discord configurado.

```sh
npm ci
cp .env.example .env
# Preencha DISCORD_TOKEN, CLIENT_ID e SESSION_SECRET em .env.
npm run deploy:commands
npm start
```

`SESSION_SECRET` deve ter pelo menos 32 caracteres aleatórios; gere um com `openssl rand -hex 32`. `DISCORD_CLIENT_SECRET` é opcional para o acesso por slash command e obrigatório apenas para login OAuth em links de convite. `DISCORD_INVITE_CHANNEL_ID` define o canal de texto no qual o bot publica convites quando não há webhook configurado; o valor padrão é `1484265142320365638`. Alternativamente, defina `DISCORD_INVITE_WEBHOOK_URL` no `.env` para enviar os embeds ao canal vinculado àquele webhook. Webhooks são executados pela API oficial e não dependem das permissões do bot. Trate essa URL como uma senha e revogue-a se for exposta. Cadastre no Discord Developer Portal a URL OAuth exata impressa como `Discord OAuth callback URL` se habilitar esse fluxo.

No Codespaces, configure `PUBLIC_URL` como o endereço HTTPS público da porta 3000 e marque a porta como **Public**. `SCREEN_DOMAIN`, quando definido, substitui `PUBLIC_URL` na criação dos links.

## Como funciona

- **Autorização:** `/screen start` cria a sala e fornece ao criador um link de acesso privado, além do convite. `/screen join room_id` valida a pessoa pela interação autenticada no Discord e emite um ticket de uso único, válido por cinco minutos. O ticket abre a sala sem OAuth. Mantenha-o privado: até ser resgatado, ele funciona como um link bearer associado à identidade do usuário. `/screen end` encerra a sala. Convites comuns usam OAuth Discord e exigem participação no servidor.
- **Participantes e convites:** cada conexão é associada à conta Discord verificada; a sala mostra nome e avatar. Enquanto o criador estiver transmitindo, **Convidar** executa um POST à API oficial `POST /webhooks/{webhook.id}/{webhook.token}?wait=true` para publicar um embed no canal do webhook configurado, sem depender do bot ou de permissões de canal do bot. Sem webhook, usa o bot e o canal configurado. Só o criador pode usar esse botão, com limite de um envio a cada 30 segundos. O envio não marca pessoas no canal.
- **Sinalização:** Socket.IO valida a sessão assinada, o servidor Discord da sala, o alvo dos eventos e os formatos/tamanhos dos sinais. O criador controla a configuração de proteção contra captura da sala.
- **Mídia:** cada participante conecta diretamente aos transmissores por WebRTC; o servidor não retransmite vídeo. Isso reduz o custo de mídia no servidor, mas a malha P2P cresce em tráfego e CPU conforme o número de espectadores e transmissores. A aplicação não é um SFU e não promete escala para salas grandes.
- **ICE:** `STUN_URLS` define os servidores STUN separados por vírgula. Para redes que bloqueiam conexões diretas, configure `TURN_URLS` e `TURN_SHARED_SECRET` para um servidor TURN com autenticação REST coturn compatível. O segredo permanece no servidor; a sala recebe credenciais HMAC temporárias de uma hora. Sem TURN, algumas combinações de NAT/firewall não conseguirão estabelecer mídia.
- **Dados:** salas, tickets, sinalização e configuração de proteção são mantidos em memória. Reiniciar o processo encerra as salas e invalida tickets. Cookies de sessão assinados duram até 12 horas; sair da sala fecha a conexão local, mas não revoga cookies em outros dispositivos.
- **Bot Discord:** a API oficial de bots oferece comandos e integrações, não uma API de “Go Live” para transmitir a tela de uma pessoa. O Guse não usa self-bots, tokens de usuário ou automação não oficial do cliente Discord.

### ICE/TURN

Exemplo de ambiente:

```dotenv
STUN_URLS=stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302
TURN_URLS=turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp
TURN_SHARED_SECRET=segredo-compartilhado-configurado-no-coturn
```

O serviço TURN deve estar configurado com o mesmo segredo de autenticação REST. Use TLS e firewall no TURN em produção; monitore largura de banda e configure cotas/limites no próprio serviço. Não coloque credenciais permanentes de TURN no JavaScript nem em `STUN_URLS`.

## PC, celular e consoles

As instruções de uso estão somente no botão **?** dentro da sala. A interface foi reorganizada para celular com uma área de vídeo ampla, lista compacta de participantes, controles acessíveis e opções de transmissão recolhidas. O tema usa superfícies escuras, azul e agrupamento de ações familiares do Discord, com espaçamento em grade de 8 px, foco visível e áreas de toque de pelo menos 44 px. A marca e os ícones continuam próprios do Guse, sem carregar arquivos proprietários ou sugerir que este webapp seja um produto oficial do Discord.

- **PC/Mac/Linux:** toque em **Compartilhar**, escolha uma tela ou janela e confirme. O navegador pode limitar a qualidade.
- **Celular/tablet:** o site permite assistir. Para compartilhar a tela inteira, use o app Discord numa chamada de voz e confirme no aparelho. Essa chamada é separada: o bot não importa o vídeo para a sala Guse. Este repositório não inclui app nativo Android/iOS.
- **Xbox One / Series X|S:** é possível transmitir nativamente para uma chamada Discord após vincular as contas Xbox e Discord. Esse vídeo fica na chamada Discord, não nesta sala web. Para a sala Guse, use uma placa HDMI num PC.
- **PS4 / PS5:** use PS Remote Play em um computador e compartilhe a janela; alternativamente, use uma placa HDMI. Remote Play no celular pode ser compartilhado pelo Discord, mas não é ingestão para Guse. Proteções HDCP podem impedir a captura e não devem ser contornadas.
- **Nintendo Switch:** use uma placa HDMI conectada ao computador.
- **Placa de captura:** escolha **Placa HDMI / câmera**, permita o acesso de vídeo, detecte e selecione o dispositivo. O fluxo atual captura vídeo com `getUserMedia()`; não combina automaticamente o áudio HDMI.

## Controles da sala

A sala oferece compartilhar/parar e pausar, controlar o som, escolher uma qualidade simples (Padrão, Alta ou Mais fluida), selecionar tela ou câmera/placa, copiar convite, QR, tela cheia, janela flutuante, lista de pessoas reconhecidas pelo Discord, estado de conexão, tema claro/escuro e sair. As instruções ficam dentro do botão **?**. O convite do Discord aparece para o criador enquanto ele transmite.

Atalhos (quando o foco não está em um controle ou campo): **S** iniciar, **X** parar, **Espaço** pausar/retomar, **M** áudio, **F** tela cheia, **P** janela flutuante, **T** tema, **H** ajuda e **I** copiar convite. Navegadores e sistemas podem reservar atalhos.

A janela flutuante tenta, em ordem: **Document Picture-in-Picture** para a sala; PiP nativo do vídeo; mini player móvel arrastável dentro da página; janela redimensionável em desktop. O mini player móvel mantém a transmissão na tela atual; não é uma janela separada do sistema. Document PiP não está disponível em Android/iOS; PiP de vídeo depende do navegador e de haver vídeo ativo. A disponibilidade é detectada em tempo de execução. Janelas extras podem ser bloqueadas.

## Segurança e limites de captura

- **Web:** a proteção opcional por sala desfoca os vídeos quando a aba perde foco e tenta bloquear menu de contexto/atalhos comuns. Não há marca d'água com ID na tela. Essas camadas são de **dissuasão**, não bloqueio: uma pessoa ainda pode usar captura do sistema, gravador privilegiado, câmera externa, outro dispositivo ou alterações no navegador. Nem a página nem o bot podem impedir isso de forma absoluta.
- **Android nativo:** um app próprio pode aplicar `WindowManager.LayoutParams.FLAG_SECURE` para impedir screenshots e exibição em certos destinos não seguros controlados pelo sistema. O Guse não inclui app Android; essa proteção não se aplica ao navegador nem ao app Discord.
- **iOS nativo:** `UIScreen.isCaptured` e notificações do UIKit permitem detectar gravação/espelhamento; a notificação de screenshot ocorre depois da captura. Um app pode ocultar conteúdo ao detectar, mas isso não impede toda captura. O Guse não inclui app iOS/ReplayKit.
- **DRM:** EME expõe uma API para reprodução de conteúdo criptografado; DRM requer vídeo, licença e sistema de chaves compatíveis. Não protege genericamente o vídeo WebRTC desta sala e não foi implementado.
- **WebRTC:** mídia P2P usa criptografia de transporte definida pelo WebRTC, mas isso não impede um espectador autorizado de gravar o conteúdo que recebe. A autenticação controla o acesso à sala; ela não impede a captura pelo espectador autorizado.

## Matriz de compatibilidade e testes

Esta tabela separa automação do que depende de hardware/contas reais. A emulação mobile verifica layout e a página, não equivale a teste de captura em celular físico.

| Plataforma / ambiente | Assistir à sala | Captura do site | Verificação |
|---|---|---|---|
| Chromium desktop no runner Playwright/Linux (Chrome for Testing 156) | Testado | API/UI detectadas; fluxo de dispositivo de vídeo com stream simulado; seletor nativo de tela não automatizado | E2E e axe passaram |
| Firefox desktop no runner Playwright/Linux (157) | Testado | API/UI detectadas; fluxo de dispositivo de vídeo com stream simulado; seletor nativo não automatizado | E2E e axe passaram |
| WebKit desktop no runner Playwright/Linux (27.2) | Testado | API/UI detectadas; fluxo de dispositivo de vídeo com stream simulado; seletor nativo não automatizado | E2E e axe passaram |
| Perfil Pixel 7 emulado pelo Chromium | Layout em 320–430 px, controles e mini player flutuante testados | Captura real do Android e PiP nativo não testados | E2E e axe passaram |
| Perfil iPhone 13 emulado pelo WebKit | Layout em 320–430 px, controles e mini player flutuante testados | Não é iPhone/iOS real; ReplayKit e PiP nativo não testados | E2E e axe passaram |
| Android físico / iOS físico | Não testado | Use o app Discord; captura da tela inteira no Discord não foi automatizada | Checklist manual abaixo |
| Xbox, PlayStation, Switch e placas HDMI | Não testado | Exige console, conta, adaptador e hardware real | Checklist manual abaixo |
| STUN/TURN em rede real | Geração de credencial TURN testada | Coturn, NAT/firewall e qualidade de mídia não testados | Teste de integração local cobre API/signaling |

Verificações automatizadas disponíveis:

```sh
npm test          # build + APIs de sessão/QR/ICE e integração de sinalização/permissões
npm run test:e2e   # Chromium, Firefox, WebKit, perfis mobile e Lighthouse
npm run test:lighthouse # auditoria Lighthouse isolada
```

O E2E também desliga e restaura a rede para verificar reconexão do Socket.IO; isso não simula perda percentual de pacotes nem reconexão ICE de uma transmissão de mídia. O fluxo de captura de dispositivo é exercitado com um `MediaStream` simulado; o seletor nativo de tela, câmera/placa reais e mídia P2P entre espectadores não foram automatizados. axe-core não encontrou violações WCAG 2.2 AA nos cinco perfis executados. Lighthouse no Chromium reportou **acessibilidade 100/100** e **performance 98/100** na validação mais recente; os valores variam com hardware, rede e build e não certificam conformidade WCAG. Desempenho sob carga, mídia P2P real, TURN/coturn e leitores de tela não foram executados nesta validação.

Checklist manual pendente:

1. PC real: capturar tela, janela, aba, áudio do sistema; testar presets, pausa, áudio, webcam/placa e permissões negadas.
2. Android/iOS reais: assistir, testar o mini player e PiP nativo do sistema; transmitir tela inteira pelo Discord; confirmar que a transmissão Discord não aparece na sala Guse e ocultar notificações pessoais.
3. Xbox One/Series: vincular contas e testar **Parties & chats > Stream your game** numa chamada Discord; confirmar separadamente o caminho por placa HDMI até Guse.
4. PS4/PS5: testar PS Remote Play em janela e uma placa HDMI autorizada; anotar bloqueios HDCP sem tentar contorná-los.
5. Switch: testar placa HDMI, seleção de dispositivo e áudio compatível.
6. Rede: testar TURN real em NAT restritivo, perda/latência e queda durante vídeo; confirmar retomada/limites da malha.
7. Segurança: testar blur/atalhos em cada sistema; confirmar em todos os casos que a interface comunica que captura externa continua possível.

## Referências consultadas

Fontes técnicas e de plataforma consultadas em 30/10/2026:

- Captura: [MDN Screen Capture API](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Capture_API), [W3C Screen Capture](https://www.w3.org/TR/screen-capture/) (Working Draft, não recomendação final), [Can I Use — getDisplayMedia](https://caniuse.com/mdn-api_mediadevices_getdisplaymedia).
- WebRTC: [webrtc.org — peer connections](https://webrtc.org/getting-started/peer-connections), [web.dev — WebRTC basics](https://web.dev/articles/webrtc-basics).
- Discord: [guia oficial de transmissão desktop/mobile](https://discord.com/blog/how-to-stream-to-discord-from-desktop-or-mobile), [Discord Developer Platform](https://docs.discord.com/developers/intro), [Webhook Resource — Execute Webhook](https://docs.discord.com/developers/resources/webhook#execute-webhook). A execução oficial é um `POST` autenticado pela URL secreta do webhook e permite enviar `embeds`; `wait=true` solicita confirmação da mensagem. A página do Help Center para Go Live retornou HTTP 403 na consulta; não foi usada como fonte única.
- Consoles: [Xbox Support — transmitir jogo ao Discord](https://support.xbox.com/en-US/help/friends-social-activity/share-socialize/stream-game-with-discord), [PlayStation — PS Remote Play](https://www.playstation.com/en-us/remote-play/). A URL de suporte PS4/PS5 inicialmente sugerida retornou 404; o portal oficial do produto permaneceu acessível.
- Picture-in-Picture: [Chrome for Developers — Document PiP](https://developer.chrome.com/docs/web-platform/document-picture-in-picture), [MDN Document PiP](https://developer.mozilla.org/en-US/docs/Web/API/Document_Picture-in-Picture_API), [MDN video PiP](https://developer.mozilla.org/en-US/docs/Web/API/Picture-in-Picture_API).
- Compatibilidade de APIs: [MDN Browser Compatibility Data — Document PiP](https://github.com/mdn/browser-compat-data/blob/main/api/DocumentPictureInPicture.json), [MDN `enumerateDevices()`](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/enumerateDevices), [MDN `getUserMedia()`](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia).
- Captura nativa/DRM: [Android `FLAG_SECURE`](https://developer.android.com/reference/android/view/WindowManager.LayoutParams#FLAG_SECURE), [Apple `UIScreen.isCaptured`](https://developer.apple.com/documentation/uikit/uiscreen/iscaptured), [Apple screenshot notification](https://developer.apple.com/documentation/uikit/uiapplication/userdidtakescreenshotnotification), [W3C Encrypted Media Extensions](https://www.w3.org/TR/encrypted-media-2/), [Apple FairPlay Streaming](https://developer.apple.com/streaming/fps/). Os links de artigos de DRM Gumlet/VdoCipher fornecidos na solicitação retornaram 404 na consulta.
- Design/acessibilidade: [Material Design 3](https://m3.material.io/), [Apple Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/), [WCAG 2.2](https://www.w3.org/TR/WCAG22/), [Nielsen Norman Group — heurísticas](https://www.nngroup.com/articles/ten-usability-heuristics/).
