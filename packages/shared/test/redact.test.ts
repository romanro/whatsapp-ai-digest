import { describe, expect, it } from "vitest";
import { REDACTION_TOKENS, SenderPseudonymizer, looksLikePhone, redactText } from "../src/redact.ts";

const P = REDACTION_TOKENS.phone;

describe("redactText — phones", () => {
  it.each([
    ["Звоните 050-000-0002", `Звоните ${P}`],
    ["call +972 50 000 0003 now", `call ${P} now`],
    ["тел. +7 (900) 000-00-04", `тел. ${P}`],
    ["מספר 0500000005 בבקשה", `מספר ${P} בבקשה`],
  ])("%s", (input, expected) => {
    expect(redactText(input).text).toBe(expected);
  });

  it("redacts phone numbers in WhatsApp @mentions", () => {
    expect(redactText("спасибо @972500000006!").text).toBe(`спасибо @${P}!`);
  });

  it("does not touch dates, times, amounts or short numbers", () => {
    const s = "Встреча 20.11.2026 в 14:30, сдаём 1,500.00 ₪ или 250 руб, комната 12, 2025-2026, ₪ 1 500 000";
    expect(redactText(s).text).toBe(s);
  });
});

describe("redactText — other identifiers", () => {
  it("redacts emails", () => {
    const r = redactText("пишите на parent.test@example.com или test2@example.org");
    expect(r.text).toBe(`пишите на ${REDACTION_TOKENS.email} или ${REDACTION_TOKENS.email}`);
    expect(r.counts.emails).toBe(2);
  });

  it("redacts Luhn-valid card numbers but not random long digit strings as cards", () => {
    const r = redactText("карта 4111 1111 1111 1111 спасибо");
    expect(r.text).toBe(`карта ${REDACTION_TOKENS.card} спасибо`);
    expect(r.counts.cards).toBe(1);
  });

  it("redacts IBANs", () => {
    expect(redactText("IBAN IL620108000000099999999").text).toBe(`IBAN ${REDACTION_TOKENS.iban}`);
  });

  it("strips URL query strings (may carry personal tokens) but keeps the link", () => {
    const r = redactText("форма: https://forms.example.com/abc?token=XYZ&phone=1#x готово");
    expect(r.text).toBe("форма: https://forms.example.com/abc готово");
    expect(r.counts.urlQueries).toBe(1);
  });

  it("accumulates counts across calls", () => {
    const counts = { phones: 0, emails: 0, cards: 0, ibans: 0, urlQueries: 0 };
    redactText("050-000-0002", counts);
    redactText("050-000-0003", counts);
    expect(counts.phones).toBe(2);
  });
});

describe("SenderPseudonymizer", () => {
  it("replaces phone-number senders with stable aliases", () => {
    const p = new SenderPseudonymizer();
    expect(p.pseudonymize("+972 50-000-0001")).toBe("Участник 1");
    expect(p.pseudonymize("+972 50-000-0009")).toBe("Участник 2");
    expect(p.pseudonymize("+972500000001")).toBe("Участник 1");
    expect(p.pseudonymizedCount).toBe(2);
  });

  it("keeps names (Hebrew / Russian) and null", () => {
    const p = new SenderPseudonymizer();
    expect(p.pseudonymize("אמא של נועה")).toBe("אמא של נועה");
    expect(p.pseudonymize("Мама Ани")).toBe("Мама Ани");
    expect(p.pseudonymize(null)).toBeNull();
  });

  it("detects phone-like senders", () => {
    expect(looksLikePhone("+7 900 000-00-01")).toBe(true);
    expect(looksLikePhone("Аня 2")).toBe(false);
  });
});
