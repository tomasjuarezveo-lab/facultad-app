const { Resend } = require('resend');

const RESEND_API_KEY = String(process.env.RESEND_API_KEY || '').trim();
const RESEND_FROM_EMAIL = String(process.env.RESEND_FROM_EMAIL || 'hola@cleverwave.com.ar').trim();
const RESEND_FROM_NAME = String(process.env.RESEND_FROM_NAME || 'CleverWave').trim();
const APP_BASE_URL = String(process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`).trim().replace(/\/+$/, '');
const START_STUDY_URL = `${APP_BASE_URL}/app/materias`;
const LOGO_URL = 'https://www.dropbox.com/scl/fi/biw1gltms2icv30a1w25d/CW-logo.png?rlkey=vk846pz49nke0u8706gb0q11j&st=dht0fk9g&dl=1';

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getResendClient() {
  if (!RESEND_API_KEY) {
    throw new Error('Falta RESEND_API_KEY en el entorno.');
  }

  return new Resend(RESEND_API_KEY);
}

function buildWelcomeEmailHtml({ name }) {
  const safeName = escapeHtml(name || '');
  const greetingName = safeName || 'estudiante';

  return `
  <!doctype html>
  <html lang="es">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>¡Te damos la bienvenida a CleverWave! 🌊</title>
    </head>
    <body style="margin:0;padding:0;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','SF Pro Display','Helvetica Neue',Arial,sans-serif;color:#111827;">
      <div style="width:100%;background:#ffffff;padding:32px 16px;">
        <div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #E5E7EB;border-radius:24px;box-shadow:0 10px 30px rgba(15,23,42,.06);overflow:hidden;">
          <div style="padding:40px 28px 24px;text-align:center;border-bottom:1px solid #F1F5F9;">
            <img src="${LOGO_URL}" alt="CleverWave" style="width:72px;height:72px;object-fit:contain;display:block;margin:0 auto 16px;" />
            <div style="font-size:13px;line-height:1.4;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#8E8E93;">CleverWave</div>
          </div>

          <div style="padding:32px 28px 16px;">
            <h1 style="margin:0 0 14px;font-size:30px;line-height:1.15;font-weight:800;color:#111827;">
              ¡Te damos la bienvenida a CleverWave! 🌊
            </h1>

            <p style="margin:0 0 14px;font-size:17px;line-height:1.65;color:#374151;">
              Hola <strong>${greetingName}</strong>, gracias por sumarte a la plataforma independiente de estudio para Económicas.
            </p>

            <p style="margin:0 0 24px;font-size:16px;line-height:1.7;color:#4B5563;">
              Ya podés empezar a organizar tu cursada, acceder a tus materias y estudiar de forma más simple desde CleverWave.
            </p>

            <div style="margin:0 0 28px;">
              <a href="${START_STUDY_URL}" style="display:inline-block;background:#007AFF;color:#ffffff;text-decoration:none;font-size:16px;font-weight:700;line-height:1;padding:16px 22px;border-radius:12px;">
                Empezar a estudiar
              </a>
            </div>
          </div>

          <div style="padding:0 28px 32px;">
            <div style="height:1px;background:#F1F5F9;margin:0 0 18px;"></div>
            <p style="margin:0 0 8px;font-size:13px;line-height:1.7;color:#6B7280;">
              Al usar CleverWave aceptás los Términos y Condiciones y la Política de Privacidad vigentes en la plataforma.
            </p>
            <p style="margin:0;font-size:13px;line-height:1.7;color:#6B7280;">
              CleverWave es un proyecto autónomo e independiente, ajeno a instituciones universitarias.
            </p>
          </div>
        </div>
      </div>
    </body>
  </html>
  `;
}

function buildWelcomeEmailText({ name }) {
  const cleanName = String(name || '').trim() || 'estudiante';

  return [
    `Hola ${cleanName},`,
    '',
    'Gracias por sumarte a CleverWave, la plataforma independiente de estudio para Económicas.',
    '',
    `Empezar a estudiar: ${START_STUDY_URL}`,
    '',
    'Al usar CleverWave aceptás los Términos y Condiciones y la Política de Privacidad vigentes en la plataforma.',
    'CleverWave es un proyecto autónomo e independiente, ajeno a instituciones universitarias.'
  ].join('\n');
}

async function sendWelcomeEmail(email, name) {
  const resend = getResendClient();

  const { data, error } = await resend.emails.send({
    from: `${RESEND_FROM_NAME} <${RESEND_FROM_EMAIL}>`,
    to: [String(email || '').trim()],
    subject: '¡Te damos la bienvenida a CleverWave! 🌊',
    html: buildWelcomeEmailHtml({ name }),
    text: buildWelcomeEmailText({ name })
  });

  if (error) {
    throw new Error(error.message || 'No se pudo enviar el email de bienvenida.');
  }

  return data;
}

module.exports = {
  sendWelcomeEmail
};