const { BrevoClient } = require('@getbrevo/brevo');

const BREVO_API_KEY = String(process.env.BREVO_API_KEY || '').trim();
const FROM_EMAIL = String(process.env.BREVO_SENDER_EMAIL || 'no-reply@cleverwave.com.ar').trim();
const FROM_NAME = String(process.env.BREVO_SENDER_NAME || 'CleverWave').trim();

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildVerificationEmailHtml({ name, code }) {
  const safeName = escapeHtml(name || 'Hola');
  const safeCode = escapeHtml(code || '');

  return `
  <!doctype html>
  <html lang="es">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>Verificá tu cuenta</title>
    </head>
    <body style="margin:0;padding:0;background:#F2F2F7;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','SF Pro Display','Helvetica Neue',Arial,sans-serif;">
      <div style="width:100%;background:#F2F2F7;padding:32px 16px;">
        <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;box-shadow:0 10px 30px rgba(15,23,42,.08);padding:32px 24px;">
          <div style="font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#8E8E93;margin-bottom:10px;">
            CleverWave
          </div>

          <h1 style="margin:0 0 10px;font-size:28px;line-height:1.15;color:#111827;font-weight:800;">
            Verificá tu email
          </h1>

          <p style="margin:0 0 14px;font-size:16px;line-height:1.6;color:#374151;">
            Hola <strong>${safeName}</strong>, gracias por crear tu cuenta.
          </p>

          <p style="margin:0 0 18px;font-size:16px;line-height:1.6;color:#374151;">
            Ingresá este código de 6 dígitos en CleverWave para activar tu cuenta:
          </p>

          <div style="margin:0 0 22px;padding:18px 20px;border-radius:12px;background:#F8FAFC;border:1px solid #E5E7EB;text-align:center;">
            <div style="font-size:34px;line-height:1;font-weight:800;letter-spacing:.22em;color:#007AFF;">
              ${safeCode}
            </div>
          </div>

          <p style="margin:0 0 8px;font-size:14px;line-height:1.6;color:#6B7280;">
            Si no creaste esta cuenta, podés ignorar este email.
          </p>

          <p style="margin:0;font-size:14px;line-height:1.6;color:#6B7280;">
            Revisá también Spam o Promociones si no lo encontrás en tu bandeja principal.
          </p>
        </div>
      </div>
    </body>
  </html>
  `;
}

function buildVerificationEmailText({ name, code }) {
  return [
    `Hola ${name || 'Hola'},`,
    '',
    'Gracias por crear tu cuenta en CleverWave.',
    `Tu código de verificación es: ${code}`,
    '',
    'Ingresalo en la pantalla de verificación para activar tu cuenta.'
  ].join('\n');
}

function buildPasswordResetCodeEmailHtml({ name, code }) {
  const safeName = escapeHtml(name || 'Hola');
  const safeCode = escapeHtml(code || '');

  return `
  <!doctype html>
  <html lang="es">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>Recuperá tu cuenta</title>
    </head>
    <body style="margin:0;padding:0;background:#F2F2F7;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','SF Pro Display','Helvetica Neue',Arial,sans-serif;">
      <div style="width:100%;background:#F2F2F7;padding:32px 16px;">
        <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;box-shadow:0 10px 30px rgba(15,23,42,.08);padding:32px 24px;">
          <div style="font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#8E8E93;margin-bottom:10px;">
            CleverWave
          </div>

          <h1 style="margin:0 0 10px;font-size:28px;line-height:1.15;color:#111827;font-weight:800;">
            Código para recuperar tu cuenta
          </h1>

          <p style="margin:0 0 14px;font-size:16px;line-height:1.6;color:#374151;">
            Hola <strong>${safeName}</strong>.
          </p>

          <p style="margin:0 0 18px;font-size:16px;line-height:1.6;color:#374151;">
            Ingresá este código de 6 dígitos en CleverWave para cambiar tu email, tu contraseña o ambos:
          </p>

          <div style="margin:0 0 22px;padding:18px 20px;border-radius:12px;background:#F8FAFC;border:1px solid #E5E7EB;text-align:center;">
            <div style="font-size:34px;line-height:1;font-weight:800;letter-spacing:.22em;color:#007AFF;">
              ${safeCode}
            </div>
          </div>

          <p style="margin:0 0 8px;font-size:14px;line-height:1.6;color:#6B7280;">
            Si no pediste este cambio, ignorá este email.
          </p>

          <p style="margin:0;font-size:14px;line-height:1.6;color:#6B7280;">
            Revisá también Spam o Promociones si no lo encontrás en tu bandeja principal.
          </p>
        </div>
      </div>
    </body>
  </html>
  `;
}

function buildPasswordResetCodeEmailText({ name, code }) {
  return [
    `Hola ${name || 'Hola'},`,
    '',
    'Recibimos una solicitud para recuperar tu cuenta de CleverWave.',
    `Tu código de verificación es: ${code}`,
    '',
    'Ingresalo en la pantalla de recuperación para cambiar tu email, tu contraseña o ambos.'
  ].join('\n');
}

function getBrevoClient() {
  if (!BREVO_API_KEY) {
    throw new Error('Falta BREVO_API_KEY en el entorno.');
  }

  return new BrevoClient({
    apiKey: BREVO_API_KEY
  });
}

async function sendWelcomeVerificationEmail({ toEmail, toName, code }) {
  const brevo = getBrevoClient();

  return brevo.transactionalEmails.sendTransacEmail({
    sender: {
      email: FROM_EMAIL,
      name: FROM_NAME
    },
    to: [
      {
        email: String(toEmail || '').trim(),
        name: String(toName || '').trim() || 'Usuario'
      }
    ],
    subject: 'Tu código de verificación de CleverWave',
    htmlContent: buildVerificationEmailHtml({
      name: toName || 'Hola',
      code
    }),
    textContent: buildVerificationEmailText({
      name: toName || 'Hola',
      code
    })
  });
}

async function sendPasswordResetCodeEmail({ toEmail, toName, code }) {
  const brevo = getBrevoClient();

  return brevo.transactionalEmails.sendTransacEmail({
    sender: {
      email: FROM_EMAIL,
      name: FROM_NAME
    },
    to: [
      {
        email: String(toEmail || '').trim(),
        name: String(toName || '').trim() || 'Usuario'
      }
    ],
    subject: 'Tu código para recuperar tu cuenta de CleverWave',
    htmlContent: buildPasswordResetCodeEmailHtml({
      name: toName || 'Hola',
      code
    }),
    textContent: buildPasswordResetCodeEmailText({
      name: toName || 'Hola',
      code
    })
  });
}

module.exports = {
  sendWelcomeVerificationEmail,
  sendPasswordResetCodeEmail
};