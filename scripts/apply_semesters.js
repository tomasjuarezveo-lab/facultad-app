'use strict';

/**
 * @module welcomeEmail
 * @description Plantilla del email de bienvenida de CleverWave.
 *              Incluye imagen de la app, jerarquía visual premium y
 *              secciones de valor para el usuario recién registrado.
 */

// ─── Utilidades ───────────────────────────────────────────────────────────────

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── URL de imagen de la app ──────────────────────────────────────────────────

const APP_IMAGE_URL =
  'https://www.dropbox.com/scl/fi/c99rsjmvveqcmz4k87zjh/clear-way.png' +
  '?rlkey=pm6e7lcz5m9fozzl1mq74h61d&st=z15teun3&raw=1';

// ─── Plantilla HTML ───────────────────────────────────────────────────────────

/**
 * Construye el HTML completo del email de bienvenida.
 * @param {{ name: string }} params
 * @returns {string}
 */
function buildWelcomeEmailHtml({ name }) {
  const safeName = escapeHtml(name || 'Usuario');
  const year     = new Date().getFullYear();

  return `
<!doctype html>
<html lang="es" xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="light" />
    <meta name="supported-color-schemes" content="light" />
    <title>Bienvenido a CleverWave</title>
    <!--[if mso]>
    <noscript><xml><o:OfficeDocumentSettings>
      <o:PixelsPerInch>96</o:PixelsPerInch>
    </o:OfficeDocumentSettings></xml></noscript>
    <![endif]-->
  </head>

  <body style="
    margin: 0; padding: 0;
    background-color: #ECEEF2;
    -webkit-text-size-adjust: 100%;
    -ms-text-size-adjust: 100%;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
  ">

    <!-- Preheader invisible -->
    <div style="display:none;font-size:1px;color:#ECEEF2;line-height:1px;
                max-height:0;max-width:0;opacity:0;overflow:hidden;">
      Tu cuenta de CleverWave está lista. Empezá ahora mismo.
    </div>

    <!-- ══════════════════════════════════════════
         OUTER TABLE
    ══════════════════════════════════════════ -->
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"
           style="background-color:#ECEEF2;">
      <tr>
        <td align="center" style="padding: 48px 16px;">

          <!-- ── CARD ── -->
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"
                 style="max-width:600px;">
            <tr>
              <td style="
                background-color:#FFFFFF;
                border-radius:20px;
                box-shadow: 0 2px 8px rgba(0,0,0,0.06), 0 20px 60px rgba(0,0,0,0.10);
                overflow:hidden;
              ">

                <!-- ══════════════════════════════
                     HERO HEADER — degradado + logotipo
                ══════════════════════════════ -->
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td style="
                      background: linear-gradient(145deg, #050D1A 0%, #0F2D6E 45%, #1A56DB 80%, #2563EB 100%);
                      padding: 44px 40px 52px 40px;
                      text-align: center;
                      border-radius: 20px 20px 0 0;
                    ">

                      <!-- Logotipo wordmark -->
                      <div style="margin-bottom: 28px;">
                        <span style="
                          font-size: 13px;
                          font-weight: 700;
                          letter-spacing: 0.22em;
                          text-transform: uppercase;
                          color: rgba(255,255,255,0.55);
                          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
                        ">— CleverWave —</span>
                      </div>

                      <!-- Titular principal -->
                      <h1 style="
                        margin: 0 0 14px 0;
                        font-size: 38px;
                        font-weight: 900;
                        line-height: 1.1;
                        letter-spacing: -0.03em;
                        color: #FFFFFF;
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
                      ">Bienvenido,<br />${safeName}.</h1>

                      <!-- Subtitular -->
                      <p style="
                        margin: 0;
                        font-size: 17px;
                        line-height: 1.6;
                        color: rgba(255,255,255,0.72);
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
                      ">Tu cuenta está activa y lista para usar.</p>

                    </td>
                  </tr>
                </table>
                <!-- /HERO HEADER -->

                <!-- ══════════════════════════════
                     IMAGEN DE LA APP
                ══════════════════════════════ -->
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td align="center" style="
                      background: linear-gradient(180deg, #1A56DB 0%, #F8FAFC 60%);
                      padding: 0 40px 0 40px;
                    ">
                      <img
                        src="${APP_IMAGE_URL}"
                        alt="CleverWave App"
                        width="320"
                        style="
                          display: block;
                          width: 100%;
                          max-width: 320px;
                          height: auto;
                          margin: 0 auto;
                          border: none;
                          outline: none;
                          text-decoration: none;
                          /* sombra suave para dar profundidad */
                          filter: drop-shadow(0 24px 48px rgba(15,23,42,0.22));
                        "
                      />
                    </td>
                  </tr>
                </table>
                <!-- /IMAGEN DE LA APP -->

                <!-- ══════════════════════════════
                     CUERPO — Mensaje de bienvenida
                ══════════════════════════════ -->
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td style="padding: 40px 40px 12px 40px;">

                      <h2 style="
                        margin: 0 0 14px 0;
                        font-size: 22px;
                        font-weight: 800;
                        color: #0F172A;
                        letter-spacing: -0.02em;
                        line-height: 1.25;
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
                      ">Todo lo que necesitás,<br />en un solo lugar.</h2>

                      <p style="
                        margin: 0;
                        font-size: 16px;
                        line-height: 1.7;
                        color: #374151;
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
                      ">
                        Hola <strong style="color:#0F172A;">${safeName}</strong>,
                        es un placer tenerte con nosotros. CleverWave fue diseñado para
                        simplificar tu día a día, darte claridad sobre tus finanzas y
                        ayudarte a tomar mejores decisiones con información real y precisa.
                      </p>

                    </td>
                  </tr>
                </table>

                <!-- ══════════════════════════════
                     FEATURE CARDS — 3 columnas
                ══════════════════════════════ -->
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td style="padding: 28px 40px 8px 40px;">

                      <!--[if mso]>
                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                        <tr>
                          <td width="33%" valign="top" style="padding-right:8px;">
                      <![endif]-->

                      <!-- Feature 1 -->
                      <div style="
                        display: inline-block;
                        vertical-align: top;
                        width: 30%;
                        min-width: 140px;
                        background: #F8FAFC;
                        border: 1px solid #E2E8F0;
                        border-radius: 14px;
                        padding: 20px 16px;
                        margin: 0 1% 12px 1%;
                        box-sizing: border-box;
                      ">
                        <div style="font-size: 26px; margin-bottom: 10px;">📊</div>
                        <div style="
                          font-size: 14px;
                          font-weight: 700;
                          color: #0F172A;
                          margin-bottom: 6px;
                          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
                        ">Análisis en tiempo real</div>
                        <div style="
                          font-size: 13px;
                          line-height: 1.55;
                          color: #6B7280;
                          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
                        ">Visualizá tus datos actualizados al instante.</div>
                      </div>

                      <!--[if mso]></td><td width="33%" valign="top" style="padding:0 4px;"><![endif]-->

                      <!-- Feature 2 -->
                      <div style="
                        display: inline-block;
                        vertical-align: top;
                        width: 30%;
                        min-width: 140px;
                        background: #F0F7FF;
                        border: 1px solid #BFDBFE;
                        border-radius: 14px;
                        padding: 20px 16px;
                        margin: 0 1% 12px 1%;
                        box-sizing: border-box;
                      ">
                        <div style="font-size: 26px; margin-bottom: 10px;">🔒</div>
                        <div style="
                          font-size: 14px;
                          font-weight: 700;
                          color: #0F172A;
                          margin-bottom: 6px;
                          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
                        ">Seguridad avanzada</div>
                        <div style="
                          font-size: 13px;
                          line-height: 1.55;
                          color: #6B7280;
                          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
                        ">Tu información siempre protegida y encriptada.</div>
                      </div>

                      <!--[if mso]></td><td width="33%" valign="top" style="padding-left:8px;"><![endif]-->

                      <!-- Feature 3 -->
                      <div style="
                        display: inline-block;
                        vertical-align: top;
                        width: 30%;
                        min-width: 140px;
                        background: #F0FDF4;
                        border: 1px solid #BBF7D0;
                        border-radius: 14px;
                        padding: 20px 16px;
                        margin: 0 1% 12px 1%;
                        box-sizing: border-box;
                      ">
                        <div style="font-size: 26px; margin-bottom: 10px;">⚡</div>
                        <div style="
                          font-size: 14px;
                          font-weight: 700;
                          color: #0F172A;
                          margin-bottom: 6px;
                          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
                        ">Rápido y preciso</div>
                        <div style="
                          font-size: 13px;
                          line-height: 1.55;
                          color: #6B7280;
                          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
                        ">Operaciones ágiles sin fricción en cada paso.</div>
                      </div>

                      <!--[if mso]></td></tr></table><![endif]-->

                    </td>
                  </tr>
                </table>
                <!-- /FEATURE CARDS -->

                <!-- ══════════════════════════════
                     CTA BUTTON
                ══════════════════════════════ -->
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td align="center" style="padding: 28px 40px 36px 40px;">

                      <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                        <tr>
                          <td align="center" style="
                            background: linear-gradient(135deg, #1D4ED8 0%, #2563EB 100%);
                            border-radius: 12px;
                            box-shadow: 0 4px 20px rgba(37,99,235,0.40);
                          ">
                            <a href="https://cleverwave.com.ar"
                               target="_blank"
                               style="
                                 display: inline-block;
                                 padding: 16px 44px;
                                 font-size: 16px;
                                 font-weight: 700;
                                 color: #FFFFFF;
                                 text-decoration: none;
                                 letter-spacing: 0.01em;
                                 font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
                               ">
                              Abrir CleverWave →
                            </a>
                          </td>
                        </tr>
                      </table>

                    </td>
                  </tr>
                </table>
                <!-- /CTA BUTTON -->

                <!-- ══════════════════════════════
                     SEPARADOR + MENSAJE DE SOPORTE
                ══════════════════════════════ -->
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td style="padding: 0 40px 36px 40px;">

                      <div style="
                        height: 1px;
                        background: #F1F5F9;
                        margin-bottom: 24px;
                      "></div>

                      <p style="
                        margin: 0;
                        font-size: 14px;
                        line-height: 1.65;
                        color: #6B7280;
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
                      ">
                        ¿Tenés alguna pregunta? Nuestro equipo está disponible para ayudarte.
                        Respondé este email o escribinos a
                        <a href="mailto:soporte@cleverwave.com.ar"
                           style="color:#1D4ED8; text-decoration:none; font-weight:600;">
                          soporte@cleverwave.com.ar
                        </a>.
                      </p>

                    </td>
                  </tr>
                </table>

              </td>
            </tr>
          </table>
          <!-- /CARD -->

          <!-- ── FOOTER ── -->
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"
                 style="max-width:600px; margin-top:24px;">
            <tr>
              <td align="center" style="
                padding: 0 16px;
                font-size: 12px;
                line-height: 1.7;
                color: #9CA3AF;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
              ">
                © ${year} CleverWave · Todos los derechos reservados.<br />
                Este es un mensaje automático, por favor no respondas este email.
              </td>
            </tr>
          </table>
          <!-- /FOOTER -->

        </td>
      </tr>
    </table>
    <!-- /OUTER TABLE -->

  </body>
</html>
  `.trim();
}

// ─── Texto plano ──────────────────────────────────────────────────────────────

/**
 * Construye la versión en texto plano del email de bienvenida.
 * @param {{ name: string }} params
 * @returns {string}
 */
function buildWelcomeEmailText({ name }) {
  const year = new Date().getFullYear();
  return [
    `Bienvenido a CleverWave, ${name || 'Usuario'}`,
    '',
    'Tu cuenta está activa y lista para usar.',
    '',
    'CleverWave fue diseñado para simplificar tu día a día, darte claridad',
    'sobre tus finanzas y ayudarte a tomar mejores decisiones.',
    '',
    '▸ Análisis en tiempo real   — Visualizá tus datos actualizados al instante.',
    '▸ Seguridad avanzada        — Tu información siempre protegida y encriptada.',
    '▸ Rápido y preciso          — Operaciones ágiles sin fricción en cada paso.',
    '',
    'Empezá ahora: https://cleverwave.com.ar',
    '',
    '¿Tenés alguna pregunta? Escribinos a soporte@cleverwave.com.ar',
    '',
    `© ${year} CleverWave. Todos los derechos reservados.`
  ].join('\n');
}

// ─── Exportaciones ────────────────────────────────────────────────────────────

module.exports = {
  buildWelcomeEmailHtml,
  buildWelcomeEmailText,
  APP_IMAGE_URL
};