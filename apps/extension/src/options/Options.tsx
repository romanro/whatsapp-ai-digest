import { useEffect, useState } from "react";
import { DEFAULT_BACKEND_URL, LIMITS, PERIODS, PERIOD_LABELS_RU, type DateOrder, type Period } from "@wad/shared";
import { DEFAULT_SETTINGS, isLocalBackendUrl, loadSettings, saveSettings, type Settings } from "../lib/settings.ts";
import { clearLastResult } from "../lib/chrome.ts";
import { chromeLocal, clearAllSaved } from "../lib/cache.ts";

export function Options() {
  const [s, setS] = useState<Settings>(DEFAULT_SETTINGS);
  const [saved, setSaved] = useState<string | null>(null);
  const [urlError, setUrlError] = useState<string | null>(null);

  useEffect(() => {
    void loadSettings().then(setS);
  }, []);

  async function onSave() {
    const url = s.backendUrl.trim().replace(/\/*$/, "/");
    if (!isLocalBackendUrl(url)) {
      setUrlError("Разрешён только локальный адрес вида http://127.0.0.1:3741");
      return;
    }
    setUrlError(null);
    await saveSettings({ ...s, backendUrl: url.replace(/\/$/, "") });
    setSaved("Сохранено");
    setTimeout(() => setSaved(null), 1500);
  }

  return (
    <div className="options">
      <h1>Настройки — AI-дайджест чата</h1>

      <section className="card">
        <label className="field">
          <span>Адрес локального сервера</span>
          <input value={s.backendUrl} onChange={(e) => setS({ ...s, backendUrl: e.target.value })} placeholder={DEFAULT_BACKEND_URL} />
          {urlError && <span className="field-error">{urlError}</span>}
        </label>

        <label className="field">
          <span>Период по умолчанию</span>
          <select value={s.defaultPeriod} onChange={(e) => setS({ ...s, defaultPeriod: e.target.value as Period })}>
            {PERIODS.map((p) => (
              <option key={p} value={p}>
                {PERIOD_LABELS_RU[p]}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Формат даты в WhatsApp (если его нельзя определить автоматически)</span>
          <select value={s.dateOrderFallback} onChange={(e) => setS({ ...s, dateOrderFallback: e.target.value as DateOrder })}>
            <option value="DMY">День/Месяц/Год (20/11/2026) — Израиль, Россия</option>
            <option value="MDY">Месяц/День/Год (11/20/2026) — США</option>
            <option value="YMD">Год-Месяц-День (2026-11-20)</option>
          </select>
        </label>

        <label className="field checkbox-field">
          <span>
            <input
              type="checkbox"
              checked={s.includeImagesDefault}
              onChange={(e) => setS({ ...s, includeImagesDefault: e.target.checked })}
            />{" "}
            Включать «Анализировать фото» по умолчанию
          </span>
        </label>

        <label className="field">
          <span>Максимум фото за одну сводку (1–{LIMITS.maxImages})</span>
          <input
            type="number"
            min={1}
            max={LIMITS.maxImages}
            value={s.maxImages}
            onChange={(e) => setS({ ...s, maxImages: Math.min(LIMITS.maxImages, Math.max(1, Number(e.target.value) || 1)) })}
          />
        </label>

        <div className="row">
          <button className="primary" onClick={() => void onSave()}>
            Сохранить
          </button>
          <button
            className="secondary"
            onClick={() =>
              void Promise.all([clearLastResult(), clearAllSaved(chromeLocal)]).then(() => setSaved("Сохранённые данные удалены"))
            }
          >
            Удалить сохранённые данные
          </button>
          {saved && <span className="saved">{saved}</span>}
        </div>
      </section>

      <section className="card prose">
        <h2>Конфиденциальность</h2>
        <ul>
          <li>
            Текст выбранных сообщений <b>покидает ваш компьютер</b>: он передаётся через локальный сервер в Groq (облачный
            AI-сервис) для анализа. Ознакомьтесь с политикой Groq: groq.com/privacy-policy.
          </li>
          <li>
            Ничего не отправляется без вашего подтверждения: перед каждой отправкой показывается, что именно уйдёт, и нужно нажать
            «Отправить в Groq». Отмеченные согласия запоминаются для каждой группы.
          </li>
          <li>
            Перед отправкой автоматически скрываются номера телефонов, email, номера банковских карт и IBAN, а участники без
            имени (номер телефона) заменяются на «Участник N». Это базовая защита: имена, адреса, сведения о детях и другие
            детали в тексте сообщений могут остаться.
          </li>
          <li>
            По умолчанию обрабатывается только текст. Если включить «Анализировать фото», выбранные вами фото, которые WhatsApp уже
            показал в чате, отправляются в Groq <b>как есть</b> — лица, имена и другие данные на них не скрываются. Перед отправкой
            вы видите все фото и можете снять отметку с любого. Видео, голосовые и файлы не обрабатываются; расширение ничего не
            скачивает само.
          </li>
          <li>
            Сервер ничего не сохраняет и не пишет сообщения в журналы. Расширение хранит в профиле Chrome последнюю сводку каждой
            группы (с цитируемыми сообщениями и фото) и распознанный текст фото — чтобы показать сводку сразу и не отправлять
            одно и то же повторно. Кнопка «Удалить сохранённые данные» выше стирает всё это.
          </li>
          <li>Нет аналитики, телеметрии и сторонних трекеров. API-ключ Groq хранится только на локальном сервере (файл .env).</li>
        </ul>
        <h2>Ограничения WhatsApp</h2>
        <ul>
          <li>
            Автоматическое чтение WhatsApp Web может противоречить условиям использования WhatsApp. Используйте на свой риск и только
            для групп, где у вас есть право обрабатывать сообщения.
          </li>
          <li>
            Расширение работает только в режиме чтения: не отправляет, не удаляет и не изменяет сообщения, не читает cookies и
            данные сессии, не собирает контакты и не открывает личные чаты.
          </li>
          <li>
            Читаются только сообщения, уже загруженные на экране открытой группы. Чтобы охватить весь период, прокрутите чат
            вверх до начала периода, затем вниз до конца, и только потом формируйте сводку.
          </li>
        </ul>
      </section>
    </div>
  );
}
