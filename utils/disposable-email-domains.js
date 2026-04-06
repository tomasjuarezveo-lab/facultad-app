const BLOCKED_EMAIL_DOMAINS = new Set([
  '10minutemail.com',
  '10minutemail.net',
  '20minutemail.com',
  'anonbox.net',
  'bccto.me',
  'chacuo.net',
  'dispostable.com',
  'dispostable.net',
  'fakeinbox.com',
  'getairmail.com',
  'getnada.com',
  'guerrillamail.biz',
  'guerrillamail.com',
  'guerrillamail.de',
  'guerrillamail.net',
  'guerrillamail.org',
  'guerrillamailblock.com',
  'harakirimail.com',
  'hidemail.de',
  'inboxbear.com',
  'jetable.com',
  'jetable.fr.nf',
  'mail-temporaire.fr',
  'maildrop.cc',
  'mailinator.com',
  'mailnesia.com',
  'mailnull.com',
  'mailsac.com',
  'mintemail.com',
  'mytemp.email',
  'nada.email',
  'nospam.ze.tc',
  'nowmymail.com',
  'pokemail.net',
  'sharklasers.com',
  'spam4.me',
  'spambog.com',
  'spambog.de',
  'spambog.ru',
  'spambox.us',
  'temp-mail.org',
  'tempail.com',
  'tempinbox.com',
  'tempmail.com',
  'tempmail.net',
  'tempmail.org',
  'temporary-mail.net',
  'throwawaymail.com',
  'trash-mail.com',
  'trashmail.at',
  'trashmail.com',
  'trashmail.de',
  'trashmail.fr',
  'trashmail.me',
  'trashmail.net',
  'wegwerfmail.de',
  'wegwerfmail.net',
  'wegwerfmail.org',
  'yopmail.com',
  'yopmail.fr',
  'yopmail.net',
  'cool.fr.nf',
  'courriel.fr.nf',
  'jetable.fr.nf',
  'moncourrier.fr.nf',
  'monemail.fr.nf',
  'monmail.fr.nf',
  'nomail.xl.cx',
  'mega.zik.dj',
  'speed.1s.fr',
  'courrieltemporaire.com',
  'emailondeck.com',
  'moakt.com',
  'tmomail.net'
]);

function getEmailDomain(email = '') {
  const value = String(email || '').trim().toLowerCase();
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return '';
  return value.slice(at + 1);
}

function isDisposableEmail(email = '') {
  const domain = getEmailDomain(email);
  if (!domain) return false;

  if (BLOCKED_EMAIL_DOMAINS.has(domain)) {
    return true;
  }

  const parts = domain.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    const parentDomain = parts.slice(i).join('.');
    if (BLOCKED_EMAIL_DOMAINS.has(parentDomain)) {
      return true;
    }
  }

  return false;
}

module.exports = {
  BLOCKED_EMAIL_DOMAINS,
  getEmailDomain,
  isDisposableEmail
};