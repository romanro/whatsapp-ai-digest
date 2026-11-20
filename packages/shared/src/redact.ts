/**
 * Basic PII redaction applied before message text leaves the browser (and again on the server).
 * This is a best-effort filter: names, addresses and free-form details can still contain personal data.
 */

export interface RedactionCounts {
  phones: number;
  emails: number;
  cards: number;
  ibans: number;
  urlQueries: number;
}

export const emptyCounts = (): RedactionCounts => ({ phones: 0, emails: 0, cards: 0, ibans: 0, urlQueries: 0 });

export const REDACTION_TOKENS = {
  phone: "[телефон скрыт]",
  email: "[email скрыт]",
  card: "[номер карты скрыт]",
  iban: "[IBAN скрыт]",
} as const;

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const IBAN_RE = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/g;
/** 13–19 digits with optional space/dash separators (Luhn-checked). */
const CARD_RE = /(?<![\d+])\d(?:[ -]?\d){12,18}(?!\d)/g;
/** Phone-like: optional +/00, then ≥9 digits allowing common separators. Dates (≤8 digits) and amounts are not matched. */
const PHONE_RE = /(?<![\w])(?:\+|00)?\d(?:[\s\-().]{0,2}\d){8,14}(?![\w])/g;

function luhn(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

export function redactText(input: string, counts: RedactionCounts = emptyCounts()): { text: string; counts: RedactionCounts } {
  let text = input.replace(URL_RE, (url) => {
    const cut = url.search(/[?#]/);
    if (cut === -1) return url;
    counts.urlQueries++;
    return url.slice(0, cut);
  });
  text = text.replace(EMAIL_RE, () => {
    counts.emails++;
    return REDACTION_TOKENS.email;
  });
  text = text.replace(IBAN_RE, () => {
    counts.ibans++;
    return REDACTION_TOKENS.iban;
  });
  text = text.replace(CARD_RE, (m) => {
    const digits = m.replace(/\D/g, "");
    if (digits.length >= 13 && luhn(digits)) {
      counts.cards++;
      return REDACTION_TOKENS.card;
    }
    return m;
  });
  text = text.replace(PHONE_RE, () => {
    counts.phones++;
    return REDACTION_TOKENS.phone;
  });
  return { text, counts };
}

/** True if a sender label is a raw phone number (unsaved contact) rather than a name. */
export function looksLikePhone(sender: string): boolean {
  const digits = sender.replace(/\D/g, "");
  return digits.length >= 7 && /^[\d\s+\-().~]+$/.test(sender.trim());
}

/**
 * Replaces phone-number senders with stable pseudonyms ("Участник 1", "Участник 2", …)
 * and redacts phone numbers that appear inside a sender label.
 */
export class SenderPseudonymizer {
  private readonly map = new Map<string, string>();

  pseudonymize(sender: string | null): string | null {
    if (sender === null) return null;
    if (!looksLikePhone(sender)) return redactText(sender).text;
    const key = sender.replace(/\D/g, "");
    let alias = this.map.get(key);
    if (!alias) {
      alias = `Участник ${this.map.size + 1}`;
      this.map.set(key, alias);
    }
    return alias;
  }

  get pseudonymizedCount(): number {
    return this.map.size;
  }
}
