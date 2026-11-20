/** Synthetic WhatsApp-like messages. No real conversations, people or phone numbers. */
import type { RawMessage } from "../../src/normalize.ts";

export const NOW = new Date(2026, 10, 20, 18, 0); // 20 Nov 2026 18:00 local

const at = (d: number, h: number, m = 0) => {
  const dt = new Date(2026, 10, d, h, m);
  const off = -dt.getTimezoneOffset();
  const p = (n: number) => String(Math.abs(n)).padStart(2, "0");
  return `2026-11-${p(d)}T${p(h)}:${p(m)}:00${off >= 0 ? "+" : "-"}${p(Math.trunc(off / 60))}:${p(off % 60)}`;
};

export const SYNTHETIC_MESSAGES: RawMessage[] = [
  { key: "k1", sender: "Мама Ани", timestamp: at(12, 9, 15), text: "Доброе утро всем! ☀️" },
  { key: "k2", sender: "Ganenet Tamar", timestamp: at(14, 10, 0), text: "Reminder: trip to the zoo on Sunday 23.11, bring a hat" },
  { key: "k3", sender: "אמא של נועה", timestamp: at(19, 20, 30), text: "מחר יום פיג'מה בגן! 🧸 לשלוח עם פיג'מה" },
  { key: "k4", sender: "Ваад", timestamp: at(20, 8, 5), text: "Сдаём по 50 ₪ на подарок воспитательнице до пятницы, перевод в Bit" },
  { key: "k5", sender: "+972 50-000-0001", timestamp: at(20, 9, 0), text: "Мой номер 050-000-0002, пишите если что" },
  { key: "k6", sender: "Ganenet Tamar", timestamp: at(20, 12, 0), text: "Update: the zoo trip moved to Monday 24.11 because of rain" },
  { key: "k7", sender: "Ваад", timestamp: null, text: "Сообщение без времени" },
];
