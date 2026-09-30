/** UI locale for plugin chrome (not Whisper speech language). */

export type BaseLanguage = "en" | "ru";

export const BASE_LANGUAGES: { code: BaseLanguage; label: string }[] = [
	{ code: "en", label: "English" },
	{ code: "ru", label: "Русский" },
];

export function normalizeBaseLanguage(raw: string | undefined | null): BaseLanguage {
	const lang = String(raw || "")
		.trim()
		.toLowerCase();
	return lang === "ru" ? "ru" : "en";
}

type Dict = Record<string, string>;

const EN: Dict = {
	"onboarding.title": "Welcome to Enot",
	"onboarding.lead":
		"Choose your language for the plugin interface. Folder names stay in English so sync stays stable.",
	"onboarding.language": "Language",
	"onboarding.continue": "Continue",
	"settings.account": "Account",
	"settings.intro":
		"Tap the raccoon to record or upload. This plugin pulls finished notes into PARA folders and optional People / Topics / Projects stubs.",
	"settings.access": "Access",
	"settings.refresh": "Refresh status",
	"settings.refresh_fail": "Could not refresh access",
	"settings.plans": "Plans",
	"settings.plans_desc":
		"Compare Lite / Plus / Pro: hours and what each pack is for, then checkout on Whop.",
	"settings.upgrade": "Upgrade",
	"settings.whop": "Whop billing",
	"settings.whop_desc": "Cancel or manage the active membership in Whop.",
	"settings.manage": "Manage subscription",
	"settings.register": "Register",
	"settings.register_desc": "Connect this vault to Enot to get your API key.",
	"settings.base_language": "Interface language",
	"settings.base_language_desc": "Plugin UI language. Vault folders stay English.",
	"settings.speech": "Speech language",
	"settings.speech_desc":
		"Pinned language for Whisper and note labels (auto = detect per recording). Saved to your account.",
	"settings.write_folders": "Write folders",
	"settings.name_hints": "Name hints",
	"settings.brand_hints": "Brand hints",
	"settings.clarify": "Clarify queue",
	"settings.voices": "Unknown voices",
	"settings.shortcut": "Capture shortcut",
	"settings.timezone": "Timezone",
	"settings.install_id": "Install ID",
	"settings.api_key": "API key",
	"settings.danger": "Danger zone",
	"settings.danger_desc":
		"Delete your Enot cloud account and server-side data. Optional: also remove notes this plugin created in the vault.",
	"settings.delete_account": "Delete account & server data",
	"tos.title": "Terms & Privacy",
	"tos.lead":
		"By registering you create an Enot cloud account. Processing uses Contabo (EU hosting), optional GPU workers, OpenRouter, and Whop for paid plans.",
	"tos.agree": "I agree to the Terms of Service and Privacy Policy",
	"tos.terms": "Terms of Service",
	"tos.privacy": "Privacy Policy",
	"tos.continue": "Agree & Register",
	"tos.cancel": "Cancel",
	"delete.title": "Delete Enot account",
	"delete.lead":
		"This permanently deletes your cloud account, API key, jobs, and server-side vault mirror for this key. Whop memberships are not cancelled automatically. Manage billing in Whop.",
	"delete.vault": "Also delete vault notes created by Enot",
	"delete.vault_list": "Will remove matching notes under:",
	"delete.confirm": "Delete forever",
	"delete.confirm2_title": "Confirm deletion",
	"delete.confirm2_lead": "Type DELETE to confirm. This cannot be undone.",
	"delete.done": "Enot: account deleted",
	"delete.fail": "Enot: delete failed",
	"notice.key_received": "Enot: key received",
	"notice.register_fail": "Enot: registration failed",
	"notice.vault_ready": "Enot: vault folders ready",
	"notice.onboarded": "Enot: language saved. Finishing setup…",
	"access.trial": "Trial: {days} day(s) left{hours}.",
	"access.expired": "Trial ended. Voice notes pause until you subscribe.",
	"access.paid": "Plan: {plan}{hours}.",
	"access.hours_trial": " · {used} / {ceiling} h audio",
	"access.hours_paid": " · {used} / {ceiling} h this month",
};

const RU: Dict = {
	"onboarding.title": "Добро пожаловать в Enot",
	"onboarding.lead":
		"Выбери язык интерфейса плагина. Имена папок в vault остаются на английском, так стабильнее синк.",
	"onboarding.language": "Язык",
	"onboarding.continue": "Продолжить",
	"settings.account": "Аккаунт",
	"settings.intro":
		"Нажми енота, чтобы записать или загрузить файл. Плагин кладёт готовые заметки в PARA-папки и карточки People / Topics / Projects.",
	"settings.access": "Доступ",
	"settings.refresh": "Обновить статус",
	"settings.refresh_fail": "Не удалось обновить доступ",
	"settings.plans": "Тарифы",
	"settings.plans_desc":
		"Сравни Lite / Plus / Pro: часы и для чего каждый пакет, затем оплата на Whop.",
	"settings.upgrade": "Upgrade",
	"settings.whop": "Биллинг Whop",
	"settings.whop_desc": "Отменить или управлять подпиской в Whop.",
	"settings.manage": "Управлять подпиской",
	"settings.register": "Регистрация",
	"settings.register_desc": "Подключи этот vault к Enot и получи API-ключ.",
	"settings.base_language": "Язык интерфейса",
	"settings.base_language_desc": "Язык UI плагина. Папки vault остаются на английском.",
	"settings.speech": "Язык речи",
	"settings.speech_desc":
		"Язык для Whisper и подписей в заметках (auto = определять для каждой записи). Сохраняется в аккаунт.",
	"settings.write_folders": "Папки записи",
	"settings.name_hints": "Подсказки имён",
	"settings.brand_hints": "Подсказки брендов",
	"settings.clarify": "Очередь уточнений",
	"settings.voices": "Неизвестные голоса",
	"settings.shortcut": "Шорткат записи",
	"settings.timezone": "Часовой пояс",
	"settings.install_id": "Install ID",
	"settings.api_key": "API-ключ",
	"settings.danger": "Опасная зона",
	"settings.danger_desc":
		"Удалить облачный аккаунт Enot и данные на сервере. Опционально: заметки, которые этот плагин создал в vault.",
	"settings.delete_account": "Удалить аккаунт и данные на сервере",
	"tos.title": "Условия и конфиденциальность",
	"tos.lead":
		"Регистрация создаёт облачный аккаунт Enot. Обработка идёт через Contabo (хостинг в ЕС), опционально GPU-воркеры, OpenRouter и Whop для оплаты.",
	"tos.agree": "Соглашаюсь с Terms of Service и Privacy Policy",
	"tos.terms": "Terms of Service",
	"tos.privacy": "Privacy Policy",
	"tos.continue": "Согласен и зарегистрировать",
	"tos.cancel": "Отмена",
	"delete.title": "Удалить аккаунт Enot",
	"delete.lead":
		"Безвозвратно удалит облачный аккаунт, API-ключ, джобы и серверное зеркало vault для этого ключа. Подписку Whop нужно отменить отдельно в Whop.",
	"delete.vault": "Также удалить заметки Enot в vault",
	"delete.vault_list": "Будут удалены подходящие заметки в:",
	"delete.confirm": "Удалить навсегда",
	"delete.confirm2_title": "Подтвердите удаление",
	"delete.confirm2_lead": "Введите DELETE для подтверждения. Это нельзя отменить.",
	"delete.done": "Enot: аккаунт удалён",
	"delete.fail": "Enot: не удалось удалить",
	"notice.key_received": "Enot: ключ получен",
	"notice.register_fail": "Enot: регистрация не удалась",
	"notice.vault_ready": "Enot: папки vault готовы",
	"notice.onboarded": "Enot: язык сохранён. Завершаем настройку…",
	"access.trial": "Триал: осталось {days} дн.{hours}.",
	"access.expired": "Триал закончился. Голосовые заметки на паузе до подписки.",
	"access.paid": "План: {plan}{hours}.",
	"access.hours_trial": " · {used} / {ceiling} ч аудио",
	"access.hours_paid": " · {used} / {ceiling} ч в этом месяце",
};

const TABLES: Record<BaseLanguage, Dict> = { en: EN, ru: RU };

export function t(lang: BaseLanguage, key: string, vars?: Record<string, string | number>): string {
	const raw = TABLES[lang]?.[key] ?? EN[key] ?? key;
	if (!vars) {
		return raw;
	}
	return raw.replace(/\{(\w+)\}/g, (_, name: string) =>
		vars[name] != null ? String(vars[name]) : "",
	);
}
