# План: публикация Enot в Community plugins

Официально сейчас: [Submit your plugin](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin) → [community.obsidian.md](https://community.obsidian.md) (developer dashboard). Старый путь — PR в `obsidianmd/obsidian-releases` — тоже ещё встречается, но dashboard основной.

Видео для сабмита **не обязательно**. Нужны: публичный GitHub-репо плагина, релиз с артефактами, честные disclosures, прохождение авто-review.

---

## 0) Что публикуем

Только папка **`obsidian-plugin/`** как отдельный публичный репозиторий (например `yourname/enot`).

**Не класть:** весь монорепо `enot/` с бэкендом, `app/`, `deploy/` с секретами, Contabo/Vast, промпты, `.env`, `data.json`, `node_modules/`.

### A) Файлы в GitHub-репозитории (их читает review)

Положить в **корень** public repo:

| Файл / папка | Обязательно? | Зачем |
|--------------|--------------|--------|
| `manifest.json` | да | id, name, version, description, author, minAppVersion, isDesktopOnly |
| `styles.css` | да (у нас есть) | UI |
| `README.md` | да | install из маркета, capture, paid/network disclosure |
| `LICENSE` | да | MIT |
| `PRIVACY.md` | сильно желательно | сеть, аудио, ключ |
| `versions.json` | да | version → minAppVersion |
| `package.json` | да (для сборки) | npm scripts / deps |
| `package-lock.json` | желательно | воспроизводимый build |
| `tsconfig.json` | да | TypeScript |
| `esbuild.config.mjs` | да | сборка |
| `src/main.ts` | да | исходники (review смотрит код) |
| `src/graph.ts` | да | исходники |
| `src/tables.ts` | да | исходники |
| `src/icon.ts` | да | иконка енота |
| `CONTRIBUTING.md` | нет | удобство |
| `PUBLISH.md` | **нет** | внутренний чеклист — лучше не пушить |
| `.gitignore` | **желательно** | не секрет: наоборот, **запрещает** коммитить `data.json` / `node_modules`. Без него легко случайно слить ключ пользователя |

### Что из этого «можно стащить», а что нет

| Уйдёт в public repo | Риск |
|---------------------|------|
| UI плагина, PARA-папки, как пишутся md | конкурент скопирует UX — это нормально для community plugin |
| `https://enot.upl.one` + список `/v1/…` в PRIVACY | и так нужен плагину; без ключа upload не работает; abuse закрываем rate limit |
| PNG-иконка енота в `icon.ts` | логотип, не механика |
| Промпты, Whisper, diarize, Contabo/Vast, OpenRouter/Whop secrets | **не в этом репо** — остаются в приватном бэкенде |

**Не путать:** GitHub Release `main.js` = то же, что ставит маркет. Исходники `src/` review читает специально — обфускация запрещена.


### B) Вложения GitHub Release (то, что качает Obsidian из маркета)

Тег релиза = `manifest.version` (например `0.1.22` или `1.0.0`):

| Файл | Обязательно? |
|------|--------------|
| `main.js` | да |
| `manifest.json` | да |
| `styles.css` | да (раз есть) |

Пользователь с маркета **не** копирует папки вручную: Obsidian сам качает эти три файла в `.obsidian/plugins/enot/`.

`id` в manifest: `enot` — ок. `name`: `Enot` — ок.

---

## 1) Перед сабмитом — продукт / код

- [ ] `PRIVACY.md` и `README.md` совпадают с реальностью (mic + upload + Shortcut) — сделано.
- [ ] В README явно: **куда ходит сеть** (`enot.upl.one` / свой API URL), что **есть платный облачный сервис** после trial, что ключ в `data.json`.
- [ ] Нет секретов в репо; `data.json` в `.gitignore`.
- [ ] `npm run build` → тот же `main.js`, что в GitHub Release (без обфускации / eval).
- [ ] UI sentence case; без слова Obsidian в name.
- [ ] Прогнать вручную: Register → mic/upload → заметка в vault → checkout кнопки не ломаются.
- [ ] (Опционально) `fundingUrl` в `manifest.json` на Whop / сайт — не обязателен, но удобен.

Mic использует `getUserMedia` — на mobile Obsidian может быть ограничен; `isDesktopOnly: false` оставляем, если phone-only Shortcut покрывает телефон. Если mic на mobile массово падает — либо notice «desktop only for mic», либо позже `isDesktopOnly: true` (хуже для каталога).

---

## 2) GitHub репозиторий

1. Создать **public** repo только с клиентом.
2. Запушить исходники (`src/`, build config, README, LICENSE, PRIVACY, manifest…).
3. Подключить GitHub Actions из sample-plugin / вашего `CONTRIBUTING.md` (сборка + draft release).

---

## 3) Первый релиз (обязательно)

1. Версия в `manifest.json` / `package.json` / `versions.json` — semver `x.y.z` (для маркета лучше старт `1.0.0`, не `0.1.22`, но `0.1.22` тоже валиден).
2. GitHub Release с **тегом = version** (часто без `v`: `1.0.0`, не `v1.0.0` — как требуют их валидаторы; проверь актуальный текст в dashboard).
3. В attachments релиза:
   - `main.js`
   - `manifest.json`
   - `styles.css`

Без этого релиза сабмит не пройдёт.

---

## 4) Подача в каталог

1. Зайти на [community.obsidian.md](https://community.obsidian.md) → Developer dashboard.
2. Connect GitHub → выбрать репо плагина.
3. Пройти чеклист в UI (policies, disclosures).
4. Submit → авто-review (обычно минуты; при fail — правки и новый релиз).

Альтернатива (legacy): PR в [obsidianmd/obsidian-releases](https://github.com/obsidianmd/obsidian-releases) — добавить в конец `community-plugins.json` только 5 полей: `id`, `name`, `description`, `author`, `repo`.

После approve: в приложении появляется в течение ~24ч.

---

## 5) Тексты (нужны) / медиа (по желанию)

### Обязательный текст

**Короткое description** (manifest, ~лимит каталога, без emoji/маркетингового крика):

> Voice and meeting notes into your vault via Enot cloud. Trial, then paid processing.

**README (EN)** — ревьюеры читают его:

1. Что делает плагин (1 абзац).
2. **Network disclosure** — один host API, список зачем.
3. **Paid / account** — trial 7 дней, Whop, ключ локально.
4. Как пользоваться (ribbon / Shortcut).
5. Privacy → ссылка на `PRIVACY.md`.

Русский `Dlya_polzovatelya.md` можно оставить у себя на сайте; в community-репо достаточно EN.

### Не обязательно для сабмита

| Медиа | Зачем |
|-------|--------|
| Скриншот настроек / ribbon с енотом | Карточка на сайте / Discord / Whop — **не** поле формы сабмита |
| Короткое демо-видео (30–60 с) | Маркетинг: mic → заметка; в каталог не требуется |
| Лого `enot-logo-whop.png` | Whop / сайт / GitHub social preview |
| Demo vault | «Try it» для поддержки, не для review |

Формат скринов: обычный PNG/JPG окна Obsidian. Видео: MP4/YouTube/Loom — только для людей, не для бота review.

---

## 6) Security / policies — чтобы пройти «на максимум»

- Один понятный API URL; пользователь может сменить base в settings.
- Не читать чужие папки вне vault без нужды.
- Не прятать network calls.
- Не класть API keys в релиз.
- Paid cloud — нормально, если честно в README + directory FAQ.
- Авто-скан каждой новой версии: сломал правила → могут снять с поиска.

---

## 7) После публикации

- [ ] Обновить `Dlya_polzovatelya.md` / Whop: «ставь из Community plugins».
- [ ] Тег релизов при каждом бампе; attachments всегда три файла.
- [ ] Следить за dashboard, если версия fail review.

---

## Порядок на этой неделе (практично)

1. Отдельный public GitHub repo = только plugin.  
2. README + PRIVACY финально на EN.  
3. Релиз `1.0.0` (или текущий `0.1.22`) с `main.js` / `manifest.json` / `styles.css`.  
4. Submit через community.obsidian.md.  
5. Параллельно: 1 скрин + 1 минута Loom для Whop/соцсетей — не блокирует маркет.

Официальные ссылки:

- https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin  
- https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines  
- https://docs.obsidian.md/community-directory/faq  
- https://community.obsidian.md  
