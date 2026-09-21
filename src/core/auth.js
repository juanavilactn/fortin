import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';

import { detectChromePath } from './chrome.js';
import { generateTOTP } from './totp.js';

const MAX_PASSWORD_RETRIES = 3;
const PUSH_TIMEOUT_MS = 120000;
const AUTH_REDIRECT_TIMEOUT_MS = 90000;
/** Ceiling for the whole TOTP acquisition, round retries included. */
const TOTP_ACQUISITION_TIMEOUT_MS = 90000;
const TOTP_ROUNDS = 5;
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Codigo que marca una autenticacion cancelada por quien la pidio. */
export const CANCELLED_CODE = 'CANCELLED';

function cancelledError() {
  const error = new Error('Authentication cancelled');
  error.code = CANCELLED_CODE;
  return error;
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw cancelledError();
}

/**
 * Microsoft's own error banner on the verification page. It shows up as a
 * transient "we are having trouble verifying your account" and is worth
 * reporting, because it explains why the page offers no code entry.
 */
async function serverErrorMessage(page) {
  const selectors = ['#idSpan_SAOTCS_Error_OTC', '#idDiv_SAOTCS_ErrorMsg_OTC', '#idDiv_SAOTCAS_ErrorMsg'];
  for (const selector of selectors) {
    try {
      const element = await page.$(selector);
      if (!element) continue;
      const text = await page.evaluate((node) => node.textContent, element);
      if (text && text.trim()) return text.trim();
    } catch {
      // No banner on this page.
    }
  }
  return null;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Igual que wait, pero se resuelve en el acto cuando la señal se cancela.
function sleep(ms, signal) {
  if (!signal) return wait(ms);
  if (signal.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Resuelve con el valor de promise, o rechaza con el error de cancelacion en
 * cuanto la señal se cancela. La promesa original sigue corriendo, con sus
 * manejadores enganchados, para que ningun rechazo escape sin capturar.
 */
function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) {
    Promise.resolve(promise).catch(() => {});
    return Promise.reject(cancelledError());
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => reject(cancelledError());
    signal.addEventListener('abort', onAbort, { once: true });

    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Waits until one of the selectors is visible. Returns the selector that showed
 * up, or null after the timeout. Microsoft renders the MFA step late often
 * enough that a fixed pause is not reliable.
 */
async function waitForAnySelector(page, selectors, timeoutMs, signal = null) {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    throwIfCancelled(signal);

    for (const selector of selectors) {
      try {
        const element = await page.$(selector);
        if (!element) continue;

        const visible = await element.evaluate((node) => {
          if (!node.isConnected) return false;
          const rect = node.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return false;
          const style = window.getComputedStyle(node);
          return style.visibility !== 'hidden' && style.display !== 'none';
        });
        if (visible) return selector;
      } catch {
        // Selector missing or element not inspectable.
      }
    }

    if (Date.now() >= deadline) return null;
    await sleep(500, signal);
  }
}

// Escribe caracter a caracter con pausas, como una persona.
async function typeSlowly(page, selector, text, signal = null) {
  await abortable(page.waitForSelector(selector, { visible: true, timeout: 15000 }), signal);
  await page.click(selector);
  await wait(100);
  for (const char of text) {
    await page.type(selector, char);
    await wait(30 + Math.random() * 50);
  }
}

// puppeteer-core solo se carga al autenticar: src/cli.js debe poder ejecutar
// help/status/setup sin la dependencia instalada.
async function loadPuppeteer() {
  const puppeteerModule = await import('puppeteer-core');
  return puppeteerModule.default ?? puppeteerModule;
}

// page.cookies() esta obsoleto en puppeteer-core 25 a favor de Browser.cookies().
async function readBrowserCookies(browser, page) {
  try {
    if (typeof browser.cookies === 'function') return await browser.cookies();
  } catch {
    // Se intenta con la API de la pagina.
  }
  try {
    if (typeof page.cookies === 'function') return await page.cookies();
  } catch {
    // Sin cookies accesibles.
  }
  return [];
}

// El SVPNCOOKIE se pide al FortiGate con el auth_id devuelto por el proveedor
// SAML. El certificado del FortiGate es autofirmado, de ahi rejectUnauthorized.
function fetchCookieWithAuthId({ server, port, authId, log, logError }) {
  const authUrl = `https://${server}:${port}/remote/saml/auth_id?id=${encodeURIComponent(authId)}`;

  return new Promise((resolve) => {
    let cookieFound = null;

    const request = https.get(authUrl, {
      rejectUnauthorized: false,
      headers: {
        'User-Agent': 'FortiSSLVPN (Android; SV1 [SV{v=02.01; f=05;}])',
      },
    }, (response) => {
      const setCookie = response.headers['set-cookie'];
      if (setCookie) {
        const cookieString = Array.isArray(setCookie) ? setCookie.join('; ') : setCookie;
        const match = cookieString.match(/SVPNCOOKIE=([^;]+)/);
        if (match && match[1]) {
          log('[OK] SVPNCOOKIE fetched successfully');
          cookieFound = match[1];
          resolve(match[1]);
        }
      }

      // Los errores del cuerpo no son fatales: la cookie ya salio de las cabeceras.
      response.on('error', (error) => {
        if (cookieFound) log(`   [Warning] Response body error (non-fatal): ${error.message}`);
      });
      response.on('data', () => {});
      response.on('end', () => {
        if (!cookieFound) resolve(null);
      });
    });

    request.on('error', (error) => {
      if (!cookieFound) logError(`   [Error] Request failed: ${error.message}`);
      resolve(cookieFound);
    });
    request.end();
  });
}

/**
 * Autenticacion SAML contra FortiGate (Microsoft OAuth) y captura del
 * SVPNCOOKIE.
 *
 * Salida: {cookie, authId}. Lanza un Error cuando no se puede completar; nunca
 * llama a process.exit().
 *
 * askPassword({attempt, max, reason}) solo se usa cuando no hay contraseña
 * configurada (reason 'missing') o cuando Microsoft la rechaza (reason
 * 'incorrect'). La app la resuelve con un dialogo; el CLI con un prompt oculto.
 */
export async function authenticate({
  config,
  logger,
  screenshotsDir,
  debugScreenshots = false,
  onProgress = () => {},
  askPassword,
  chromePath,
  signal = null,
}) {
  const log = (...args) => {
    if (logger) logger.log(...args);
    else process.stdout.write(`${args.join(' ')}\n`);
  };
  const logError = (...args) => {
    if (logger) logger.error(...args);
    else process.stderr.write(`${args.join(' ')}\n`);
  };
  const progress = (step, message, kind = 'info') => {
    try {
      onProgress({ step, message, kind });
    } catch {
      // Un fallo de la UI nunca debe abortar la autenticacion.
    }
  };

  // --- Capturas de depuracion -------------------------------------------
  let screenshotsActive = Boolean(debugScreenshots) && Boolean(screenshotsDir);
  let screenshotCount = 0;

  if (debugScreenshots) {
    try {
      fs.mkdirSync(screenshotsDir, { recursive: true });
      for (const file of fs.readdirSync(screenshotsDir)) {
        if (file.endsWith('.png')) fs.unlinkSync(path.join(screenshotsDir, file));
      }
      log(`   Screenshots will be saved to: ${screenshotsDir}`);
    } catch (error) {
      log(`   [Screenshot] Could not prepare ${screenshotsDir}: ${error.message}`);
      screenshotsActive = false;
    }
  }

  const takeScreenshot = async (page, label) => {
    if (!screenshotsActive || !page) return;
    try {
      screenshotCount++;
      const filename = `${String(screenshotCount).padStart(2, '0')}-${label.replace(/[^a-zA-Z0-9]/g, '_')}.png`;
      await page.screenshot({ path: path.join(screenshotsDir, filename), fullPage: true });
      log(`   [Screenshot] ${filename}`);

      log(`   [Page] URL: ${page.url()}`);
      const title = await page.title().catch(() => 'N/A');
      log(`   [Page] Title: ${title}`);
    } catch (error) {
      log(`   [Screenshot] Failed: ${error.message}`);
    }
  };

  const dumpPageContent = async (page, label) => {
    if (!screenshotsActive || !page) return;
    try {
      const filename = `${String(screenshotCount).padStart(2, '0')}-${label.replace(/[^a-zA-Z0-9]/g, '_')}.html`;
      fs.writeFileSync(path.join(screenshotsDir, filename), await page.content());
      log(`   [HTML Dump] ${filename}`);
    } catch (error) {
      log(`   [HTML Dump] Failed: ${error.message}`);
    }
  };

  // --- Precondiciones ----------------------------------------------------
  log('\n=== Fortin Auto-Connect ===\n');
  log(`Server:   ${config.vpnServer}:${config.vpnPort}`);
  log(`Username: ${config.username}`);
  log(`Auth:     ${config.authMethod === 'push' ? 'Push notification' : 'TOTP code'}`);
  log(`Headless: ${config.headless}`);
  log('');

  if (!config.vpnServer) {
    logError('Error: VPN server is required');
    logError('Set in config.json or use -s flag');
    progress('server', 'The VPN server is missing', 'warning');
    throw new Error('VPN server is required');
  }

  if (config.authMethod === 'totp' && !config.totpSecret) {
    logError('Error: TOTP secret is required for TOTP authentication');
    logError('Set totpSecret in config.json, use -t flag, or use --push for push notification auth');
    progress('totp-secret', 'The TOTP secret is missing', 'warning');
    throw new Error('TOTP secret is required for TOTP authentication');
  }

  if (!config.password) {
    log('Password not configured, please enter it now:');
    if (typeof askPassword !== 'function') {
      logError('Error: Password is required');
      progress('password', 'The Microsoft password is missing', 'warning');
      throw new Error('Password is required');
    }
    progress('password', 'Enter the Microsoft password', 'info');
    const answer = await abortable(askPassword({ attempt: 1, max: MAX_PASSWORD_RETRIES, reason: 'missing' }), signal);
    config.password = answer === null || answer === undefined ? '' : String(answer);
    if (!config.password) {
      logError('Error: Password is required');
      throw new Error('Password is required');
    }
  }

  const samlUrl = `https://${config.vpnServer}:${config.vpnPort}/remote/saml/start?redirect=1${config.vpnRealm ? `&realm=${config.vpnRealm}` : ''}`;

  log('Starting browser...');
  progress('chrome', 'Looking for Google Chrome', 'info');

  const chromeExecutable = detectChromePath({ configured: chromePath || config.chromePath || '' });
  if (!chromeExecutable) {
    logError('Error: Google Chrome not found');
    logError('Install Chrome or set CHROME_PATH environment variable');
    progress('chrome', 'Google Chrome was not found', 'warning');
    throw new Error('Google Chrome not found');
  }
  log(`Chrome: ${chromeExecutable}`);

  throwIfCancelled(signal);

  const puppeteer = await loadPuppeteer();
  const browser = await puppeteer.launch({
    headless: config.headless ? true : false,
    executablePath: chromeExecutable,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--ignore-certificate-errors',
      '--ignore-certificate-errors-spki-list',
      '--disable-blink-features=AutomationControlled',
    ],
    ignoreHTTPSErrors: true,
  });

  const page = await browser.newPage();
  await page.setUserAgent(BROWSER_USER_AGENT);
  await page.setViewport({ width: 1280, height: 800 });

  let svpnCookie = null;
  let authId = null;

  // Captura de la cookie desde las cabeceras de las respuestas.
  page.on('response', (response) => {
    try {
      const setCookie = response.headers()['set-cookie'] || '';
      if (setCookie.includes('SVPNCOOKIE=')) {
        const match = setCookie.match(/SVPNCOOKIE=([^;]+)/);
        if (match && match[1] && match[1].length > 10) {
          svpnCookie = match[1];
          log('\n[OK] SVPNCOOKIE captured from response headers');
          progress('cookie', 'SVPNCOOKIE captured', 'success');
        }
      }
    } catch {
      // La respuesta no expone cabeceras utiles.
    }
  });

  // Captura del auth_id desde la URL de retorno al localhost.
  page.on('request', (request) => {
    try {
      const url = request.url();
      if (url.includes('127.0.0.1') && url.includes('id=')) {
        const match = url.match(/[?&]id=([^&]+)/);
        if (match && match[1]) {
          authId = match[1];
          log(`\n[OK] Captured auth_id: ${authId}`);
          progress('auth-id', 'auth_id captured', 'success');
        }
      }
    } catch {
      // Peticion no inspeccionable.
    }
  });

  try {
    throwIfCancelled(signal);

    log(`Opening: ${samlUrl}`);
    progress('login', 'Opening the Microsoft sign-in page', 'info');
    await abortable(page.goto(samlUrl, { waitUntil: 'networkidle2', timeout: 30000 }), signal);
    await sleep(2000, signal);

    let currentUrl = page.url();
    log(`Current URL: ${currentUrl}`);

    // --- Flujo de Microsoft ---------------------------------------------
    if (
      currentUrl.includes('login.microsoftonline.com') ||
      currentUrl.includes('login.microsoft.com') ||
      currentUrl.includes('login.live.com')
    ) {
      log('\n--- Microsoft OAuth Login ---\n');

      // Paso 1: usuario
      try {
        log('Step 1: Entering username...');
        const emailSelectors = [
          'input[type="email"]',
          'input[name="loginfmt"]',
          'input#i0116',
          'input[id="i0116"]',
        ];

        for (const selector of emailSelectors) {
          try {
            await abortable(page.waitForSelector(selector, { visible: true, timeout: 3000 }), signal);
            await typeSlowly(page, selector, config.username, signal);
            break;
          } catch {
            // Selector no presente en esta variante de la pagina.
          }
        }

        await sleep(500, signal);
        const nextButtons = ['input[type="submit"]', 'button[type="submit"]', '#idSIButton9'];
        for (const button of nextButtons) {
          try {
            await page.click(button);
            break;
          } catch {
            // Boton no presente.
          }
        }

        await sleep(3000, signal);
        log('   Username submitted');
      } catch {
        log('   Username field not found or already filled');
      }

      throwIfCancelled(signal);

      // Paso 2: contraseña, con reintentos
      let passwordAttempt = 0;
      let passwordAccepted = false;

      // Reintento de contraseña: la pide otra vez a quien la suministro.
      const askForPassword = async () => {
        if (typeof askPassword !== 'function') {
          logError('Error: Password is required');
          throw new Error('Password is required');
        }
        const answer = await abortable(askPassword({
          attempt: passwordAttempt,
          max: MAX_PASSWORD_RETRIES,
          reason: 'incorrect',
        }), signal);
        const value = answer === null || answer === undefined ? '' : String(answer);
        if (!value) {
          logError('Error: Password is required');
          throw new Error('Password is required');
        }
        return value;
      };

      while (!passwordAccepted && passwordAttempt < MAX_PASSWORD_RETRIES) {
        passwordAttempt++;
        try {
          log(`Step 2: Entering password (attempt ${passwordAttempt}/${MAX_PASSWORD_RETRIES})...`);
          await sleep(1000, signal);

          const passwordSelectors = [
            'input[type="password"]',
            'input[name="passwd"]',
            'input#i0118',
            'input[id="i0118"]',
          ];

          let passwordField = null;
          for (const selector of passwordSelectors) {
            try {
              passwordField = await abortable(page.waitForSelector(selector, { visible: true, timeout: 5000 }), signal);
              if (passwordField) {
                // Limpia el campo antes de reescribirlo en un reintento.
                await page.evaluate((fieldSelector) => {
                  const element = document.querySelector(fieldSelector);
                  if (element) element.value = '';
                }, selector);
                await typeSlowly(page, selector, config.password, signal);
                break;
              }
            } catch {
              // Selector no presente.
            }
          }

          if (!passwordField) {
            log('   Password field not found - may have already passed this step');
            passwordAccepted = true;
            break;
          }

          await sleep(500, signal);
          const signInButtons = ['input[type="submit"]', 'button[type="submit"]', '#idSIButton9'];
          for (const button of signInButtons) {
            try {
              await page.click(button);
              break;
            } catch {
              // Boton no presente.
            }
          }

          log('   Password submitted, checking for errors...');
          await sleep(3000, signal);

          const passwordErrorSelectors = [
            '#passwordError',
            '#usernameError',
            '.alert-error',
            '#error',
            '[data-bind*="passwordError"]',
          ];

          let errorFound = false;
          for (const selector of passwordErrorSelectors) {
            try {
              const errorElement = await page.$(selector);
              if (!errorElement) continue;

              const errorText = await page.evaluate((element) => element.textContent, errorElement);
              const text = (errorText || '').trim();
              if (text && (text.includes('contraseña') || text.includes('password') || text.includes('incorrect'))) {
                errorFound = true;
                log('');
                log('   ┌─────────────────────────────────────────────────┐');
                log('   │  ERROR: Incorrect password                      │');
                log('   └─────────────────────────────────────────────────┘');
                log('');
                progress('password', 'Microsoft rejected the password', 'warning');
                await takeScreenshot(page, `password-error-attempt-${passwordAttempt}`);

                if (passwordAttempt < MAX_PASSWORD_RETRIES) {
                  log('   Please enter your password again:');
                  config.password = await askForPassword();
                }
                break;
              }
            } catch {
              // El selector no es un elemento de error util.
            }
          }

          if (!errorFound) {
            const stillOnPasswordPage = await page.$('input[type="password"]:not([style*="display: none"])');
            const liveUrl = page.url();

            if (!stillOnPasswordPage || liveUrl.includes('oauth2') || liveUrl.includes('kmsi')) {
              passwordAccepted = true;
              log('   Password accepted!');
            } else {
              // Sigue en la pagina de contraseña sin error visible: puede estar cargando.
              await sleep(2000, signal);
              const stillThere = await page.$('input[type="password"]:not([style*="display: none"])');
              if (!stillThere) {
                passwordAccepted = true;
                log('   Password accepted!');
              } else {
                log('   Password may be incorrect (still on password page)');
                progress('password', 'The password page did not advance', 'warning');
                await takeScreenshot(page, `password-stuck-attempt-${passwordAttempt}`);
                if (passwordAttempt < MAX_PASSWORD_RETRIES) {
                  log('   Please enter your password again:');
                  config.password = await askForPassword();
                }
              }
            }
          }
        } catch (error) {
          log(`   Password step error: ${error.message}`);
          // A prompt the user cancelled ends the attempt here: swallowing it
          // would ask for the password again.
          if (error?.code === CANCELLED_CODE) throw error;
        }

        throwIfCancelled(signal);
      }

      if (!passwordAccepted) {
        await takeScreenshot(page, 'password-failed-final');
        throw new Error(`Password authentication failed after ${MAX_PASSWORD_RETRIES} attempts`);
      }

      // Paso 3: MFA (push o TOTP)
      try {
        throwIfCancelled(signal);

        log(`Step 3: Handling MFA (method: ${config.authMethod})...`);

        // Microsoft renders the MFA step late often enough that a fixed pause
        // is not reliable. Wait for a known marker with a bounded budget.
        const mfaMarkers = [
          '#signInAnotherWay',
          'input[name="otc"]',
          '#idTxtBx_SAOTCC_OTC',
          '#idSubmit_SAOTCC_Continue',
          '#idDiv_SAOTCAS_ErrorMsg',
          'input[type="password"]',
          '#idDiv_SAOTCS_Proofs',
          '#idDiv_SAOTCS_Title',
          '#idDiv_SAOTCS_Error_OTC',
        ];
        const mfaMarker = await waitForAnySelector(page, mfaMarkers, 20000, signal);
        if (!mfaMarker) {
          log('   The MFA page did not show a known marker, continuing anyway');
        }

        await takeScreenshot(page, 'mfa-page-loaded');
        await dumpPageContent(page, 'mfa-page-loaded');

        if (config.authMethod === 'push') {
          progress('mfa', 'Waiting for approval on the phone', 'info');
          log('   Waiting for push notification...');

          const sendPushSelectors = [
            '#idSubmit_SAOTCC_Continue',
            'input[value="Send notification"]',
            'input[value="Enviar notificación"]',
            'button[type="submit"]',
            '#idSubmit_SendPush',
            'input[id="idSubmit_SAOTCC_Continue"]',
          ];

          // Numero que muestra Microsoft para emparejar con la app del movil.
          const codeSelectors = [
            '#idRichContext_DisplaySign',
            '.display-sign-container',
            '[data-testid="displaySign"]',
            '.display-sign',
            '#displaySign',
            'div.display-sign',
            'span.display-sign',
          ];

          // Wait for the push step to render before deciding how it behaves:
          // either the send button exists or the notification went out already.
          const pushMarker = await waitForAnySelector(page, [...sendPushSelectors, ...codeSelectors], 20000, signal);
          if (!pushMarker) {
            log('   The push step did not show a known marker, continuing anyway');
          }

          let clickedSendPush = false;
          for (const selector of sendPushSelectors) {
            try {
              const button = await page.$(selector);
              if (!button) continue;

              const buttonText = await page.evaluate((element) => element.value || element.textContent, button);
              if (buttonText && (buttonText.includes('notif') || buttonText.includes('push') || buttonText.includes('Send'))) {
                log(`   Found send button: "${buttonText.trim()}"`);
                log('   Clicking to send push notification...');
                await button.click();
                clickedSendPush = true;
                await sleep(2000, signal);
                await takeScreenshot(page, 'after-send-push-click');
                break;
              }
            } catch {
              // Boton no presente o no pulsable.
            }
          }

          if (!clickedSendPush) {
            log('   No "Send notification" button found - push may be sent automatically');
            await takeScreenshot(page, 'no-send-button-found');
            await dumpPageContent(page, 'no-send-button-found');
          }

          let displayedCode = null;
          for (let attempt = 0; attempt < 5 && !displayedCode; attempt++) {
            for (const selector of codeSelectors) {
              try {
                const codeElement = await page.$(selector);
                if (!codeElement) continue;

                const text = await page.evaluate((element) => element.textContent, codeElement);
                if (text && text.trim()) {
                  displayedCode = text.trim();
                  break;
                }
              } catch {
                // Selector no presente.
              }
            }
            if (!displayedCode) await sleep(1000, signal);
          }

          if (displayedCode) {
            log('');
            log('   ┌─────────────────────────────────────┐');
            log('   │  Enter this code in Authenticator:  │');
            log('   │                                     │');
            log(`   │               ${displayedCode.padStart(2, ' ')}                    │`);
            log('   │                                     │');
            log('   └─────────────────────────────────────┘');
            log('');
            progress('push-code', `Approve number ${displayedCode} on the phone`, 'push-code');
          } else {
            log('   Approve the request in Microsoft Authenticator');
            log('   (Check your phone for the notification)');
          }

          const startTime = Date.now();
          let approved = false;

          while ((Date.now() - startTime) < PUSH_TIMEOUT_MS) {
            await sleep(2000, signal);
            // sleep vuelve resuelto al cancelar, asi que el sondeo se corta aqui.
            throwIfCancelled(signal);
            currentUrl = page.url();

            if (
              !currentUrl.includes('login.microsoftonline.com') ||
              currentUrl.includes('kmsi') ||
              currentUrl.includes('oauth2/authorize')
            ) {
              approved = true;
              log('   Push notification approved!');
              break;
            }

            try {
              const errorElement = await page.$('#idDiv_SAOTCAS_ErrorMsg');
              if (errorElement) {
                const errorText = await page.evaluate((element) => element.textContent, errorElement);
                if (errorText && errorText.trim()) {
                  log(`   Error: ${errorText.trim()}`);
                  progress('push', errorText.trim(), 'warning');
                  await takeScreenshot(page, 'push-error');
                  await dumpPageContent(page, 'push-error');
                  break;
                }
              }
            } catch {
              // Sin mensaje de error de MFA.
            }
          }

          if (!approved) {
            await takeScreenshot(page, 'push-timeout');
            await dumpPageContent(page, 'push-timeout');
            throw new Error('Push notification not approved within timeout (2 minutes)');
          }
        } else {
          // TOTP: primero hay que pedir el cambio a codigo de verificacion.
          const cantUseAppSelectors = [
            '#signInAnotherWay',
            'a[id="signInAnotherWay"]',
            'a:has-text("No puedo usar")',
            'a:has-text("I can\'t use")',
            'a:has-text("another way")',
            'a:has-text("otra forma")',
          ];

          const useCodeSelectors = [
            'div[data-value="PhoneAppOTP"]',
            'div[data-value="OneWaySMS"]',
            '[data-testid="PhoneAppOTP"]',
            '#idDiv_SAOTCS_Proofs div[data-value="PhoneAppOTP"]',
          ];

          const totpSelectors = [
            'input[name="otc"]',
            'input#idTxtBx_SAOTCC_OTC',
            'input[id="idTxtBx_SAOTCC_OTC"]',
            'input[aria-label*="code"]',
            'input[aria-label*="Code"]',
            'input[aria-label*="código"]',
            'input[placeholder*="code"]',
            'input[placeholder*="Code"]',
            'input[placeholder*="código"]',
            'input[name="totp"]',
            'input[autocomplete="one-time-code"]',
          ];

          let totpEntered = false;
          const totpDeadline = Date.now() + TOTP_ACQUISITION_TIMEOUT_MS;

          // The page may render only part of the flow on the first pass, so
          // repeat the whole acquisition. A fresh code is generated each round.
          for (let round = 1; round <= TOTP_ROUNDS && !totpEntered; round++) {
            throwIfCancelled(signal);

            if (Date.now() >= totpDeadline) {
              log('   The MFA step ran out of time');
              break;
            }
            if (round > 1) {
              log(`   Round ${round} of ${TOTP_ROUNDS}: retrying the TOTP flow...`);
              await sleep(3000, signal);
            }

            let clickedAnotherWay = false;
            for (const selector of cantUseAppSelectors) {
              try {
                const link = await abortable(page.waitForSelector(selector, { visible: true, timeout: 3000 }), signal);
                if (link) {
                  log('   Found "I can\'t use Authenticator" link, clicking...');
                  await link.click();
                  clickedAnotherWay = true;
                  await sleep(2000, signal);
                  break;
                }
              } catch {
                // Selector no presente.
              }
            }

            // The proof list is shown straight away on some tenants, with no
            // "another way" link in between, so always look for the code option
            // instead of only looking for it after that link.
            for (const selector of useCodeSelectors) {
              try {
                const option = await abortable(page.waitForSelector(selector, { visible: true, timeout: clickedAnotherWay ? 3000 : 1500 }), signal);
                if (option) {
                  log('   Selecting "Use verification code" option...');
                  await option.click();
                  await sleep(2000, signal);
                  break;
                }
              } catch {
                // Selector no presente.
              }
            }

            const serverError = await serverErrorMessage(page);
            if (serverError) log(`   Microsoft reported: ${serverError}`);

            for (const selector of totpSelectors) {
              if (Date.now() >= totpDeadline) break;
              try {
                await abortable(page.waitForSelector(selector, { visible: true, timeout: 5000 }), signal);

                const totpCode = generateTOTP(config.totpSecret);
                // El codigo no se escribe en el log: caduca en 30 s pero es una
                // credencial en vigor.
                log('   Generated TOTP: ******');

                await page.click(selector, { clickCount: 3 });
                await typeSlowly(page, selector, totpCode, signal);
                totpEntered = true;

                await sleep(500, signal);
                const verifyButtons = [
                  'input[type="submit"]',
                  'button[type="submit"]',
                  '#idSubmit_SAOTCC_Continue',
                  'input[id="idSubmit_SAOTCC_Continue"]',
                  'button#idSubmit_SAOTCC_Continue',
                  'input[value="Verify"]',
                  'input[value="Comprobar"]',
                  'button:has-text("Verify")',
                  'button:has-text("Comprobar")',
                ];

                for (const button of verifyButtons) {
                  try {
                    const element = await page.$(button);
                    if (element) {
                      await element.click();
                      log('   TOTP submitted');
                      break;
                    }
                  } catch {
                    // Boton no presente.
                  }
                }

                break;
              } catch {
                // Selector no presente.
              }
            }
          }

          if (!totpEntered) {
            log('   WARNING: Could not find TOTP input field');
            log(`   Current URL: ${page.url()}`);
            progress('mfa', 'The TOTP code field was not found', 'warning');
          }
        }

        await sleep(3000, signal);

        throwIfCancelled(signal);
      } catch (error) {
        log(`   MFA error: ${error.message}`);
        throw error;
      }

      // Paso 4: "Stay signed in?"
      try {
        log('Step 4: Handling "Stay signed in" prompt...');
        await sleep(2000, signal);

        const noButtons = ['#idBtn_Back', 'button#idBtn_Back', 'input[value="No"]'];
        for (const button of noButtons) {
          try {
            const element = await page.$(button);
            if (element) {
              await element.click();
              log('   Clicked "No"');
              break;
            }
          } catch {
            // Boton no presente.
          }
        }

        await sleep(3000, signal);
      } catch {
        // El paso es opcional.
      }

      throwIfCancelled(signal);
    }

    // --- Espera de la vuelta a FortiGate --------------------------------
    log('\nWaiting for authentication to complete...');
    progress('wait', 'Waiting for authentication to finish', 'info');

    const startTime = Date.now();
    while (!svpnCookie && !authId && (Date.now() - startTime) < AUTH_REDIRECT_TIMEOUT_MS) {
      throwIfCancelled(signal);
      await sleep(1000, signal);

      currentUrl = page.url();

      if (currentUrl.includes('id=') && (currentUrl.includes('127.0.0.1') || currentUrl.includes('localhost'))) {
        const match = currentUrl.match(/[?&]id=([^&]+)/);
        if (match && match[1]) {
          authId = match[1];
          log(`[OK] Captured auth_id from URL: ${authId}`);
          break;
        }
      }

      const cookies = await readBrowserCookies(browser, page);
      const cookie = cookies.find((entry) => entry.name === 'SVPNCOOKIE');
      if (cookie && cookie.value && cookie.value.length > 10) {
        svpnCookie = cookie.value;
        log('[OK] SVPNCOOKIE captured from browser cookies');
        break;
      }

      if (currentUrl.includes(config.vpnServer) && !currentUrl.includes('saml/start')) {
        try {
          const pageCookie = await page.evaluate(() => {
            return document.cookie
              .split(';')
              .find((entry) => entry.trim().startsWith('SVPNCOOKIE='))
              ?.split('=')[1];
          });
          if (pageCookie && pageCookie.length > 10) {
            svpnCookie = pageCookie;
            log('[OK] SVPNCOOKIE captured from document.cookie');
            break;
          }
        } catch {
          // document.cookie no accesible.
        }
      }
    }

    if (authId && !svpnCookie) {
      log('\nFetching SVPNCOOKIE using auth_id...');
      svpnCookie = await abortable(fetchCookieWithAuthId({
        server: config.vpnServer,
        port: config.vpnPort,
        authId,
        log,
        logError,
      }), signal);
      throwIfCancelled(signal);
    }
  } catch (error) {
    // A cancellation is not a failure: the user ended the attempt, so it is
    // logged as a plain event and never as an error.
    if (signal?.aborted || error?.code === CANCELLED_CODE) {
      log('\nAuthentication cancelled');
      // The abort hides the underlying failure (a page error, a closed target);
      // a cancelled prompt already carries the cancellation.
      throw signal?.aborted ? cancelledError() : error;
    }

    logError('Error during authentication:', error.message);
    if (!config.headless) {
      // Igual que el CLI: con el navegador visible se deja abierto para poder
      // inspeccionar el fallo. La app sigue viva para el usuario; el CLI
      // termina y deja Chrome abierto.
      log('\nBrowser left open for debugging.');
    }
    throw error;
  } finally {
    if (svpnCookie || config.headless || signal?.aborted) {
      await browser.close();
    }
  }

  throwIfCancelled(signal);

  if (!svpnCookie) {
    logError('\n[ERROR] Failed to get SVPNCOOKIE');
    logError('Try with --no-headless to see the browser');
    progress('cookie', 'The SVPNCOOKIE was not obtained', 'warning');
    throw new Error('Failed to get SVPNCOOKIE');
  }

  return { cookie: svpnCookie, authId };
}
