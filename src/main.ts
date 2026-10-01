import {
	App,
	Menu,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TAbstractFile,
	TFile,
	requestUrl,
} from "obsidian";
import {
	ENOT_PATH_ROOTS,
	INBOX_DIR,
	MEETINGS_DIR,
	PEOPLE_DIR,
	PROJECTS_DIR,
	RESOURCES_DIR,
	DECISIONS_DIR,
	TEMPLATES_DIR,
	TOPICS_DIR,
	AGREEMENTS_DIR,
	backlinkLine,
	isEnotCapture,
	normalizeWriteTargets,
	parseFrontmatter,
	parseYamlList,
	parseYamlScalar,
	remapPathForTargets,
	stubNote,
	type WriteTargets,
} from "./graph";
import { ENOT_RACCOON_ICON_DATA_URL } from "./icon";
import { BASE_LANGUAGES, normalizeBaseLanguage, t, type BaseLanguage } from "./i18n";
import {
	BrandHintsModal,
	ClarifyQueueModal,
	NameHintsModal,
	OnboardingModal,
	VoiceCalibrationModal,
	WriteTargetsModal,
	TosAgreeModal,
	DeleteAccountModal,
	DeleteConfirmModal,
	NAME_HINTS_INTRO,
	BRAND_HINTS_INTRO,
	CLARIFY_INTRO,
	CALIBRATION_INTRO,
	PlansModal,
	QuotaGateModal,
	type PlanCard,
} from "./tables";
import {
	AGREEMENT_TEMPLATE,
	AGREEMENTS_README,
	SEED_FOLDERS,
	WELCOME_BODY_EN,
	WELCOME_PATH,
	timelineBody,
} from "./vault-seed";

const LEGACY_AUTH_FILE = "System/enot.json";
const DEFAULT_API = "https://enot.upl.one";
const POLL_MS = 15000;
const UNSAFE_FILE = /[\\/:*?"<>|#[\]]+/g;

/** Whisper ISO codes pinned in settings (plus auto). Keep in sync with server allow-list. */
const SPEECH_LANGUAGES: { code: string; label: string }[] = [
	{ code: "auto", label: "Auto" },
	{ code: "en", label: "English" },
	{ code: "ru", label: "Russian" },
	{ code: "uk", label: "Ukrainian" },
	{ code: "es", label: "Spanish" },
	{ code: "fr", label: "French" },
	{ code: "de", label: "German" },
	{ code: "it", label: "Italian" },
	{ code: "pt", label: "Portuguese" },
	{ code: "pl", label: "Polish" },
	{ code: "nl", label: "Dutch" },
	{ code: "tr", label: "Turkish" },
	{ code: "ar", label: "Arabic" },
	{ code: "zh", label: "Chinese" },
	{ code: "ja", label: "Japanese" },
	{ code: "ko", label: "Korean" },
	{ code: "hi", label: "Hindi" },
	{ code: "vi", label: "Vietnamese" },
	{ code: "th", label: "Thai" },
	{ code: "id", label: "Indonesian" },
	{ code: "sv", label: "Swedish" },
	{ code: "cs", label: "Czech" },
];
const SPEECH_LANG_CODES = new Set(SPEECH_LANGUAGES.map((l) => l.code));

function normalizeSpeechLanguage(raw: string | undefined | null): string {
	const lang = String(raw || "")
		.trim()
		.toLowerCase();
	return SPEECH_LANG_CODES.has(lang) ? lang : "auto";
}

interface EnotSettings {
	apiBase: string;
	installId: string;
	apiKey: string;
	userId: string;
	endpoint: string;
	speechLanguage: string;
	/** Plugin UI locale (folders stay English). */
	baseLanguage: BaseLanguage;
	/** User finished language onboarding modal. */
	onboarded: boolean;
	/** Welcome letter already written to vault. */
	welcomeWritten: boolean;
	/** PARA + Agreements folders seeded. */
	vaultSeeded: boolean;
	timezone: string;
	writeTargets: WriteTargets;
}

interface Entitlement {
	access?: string;
	days_left?: number;
	checkout_url?: string;
	checkout_urls?: Record<string, string>;
	plans?: PlanCard[];
	plan?: string | null;
	plan_label?: string | null;
	hours_soft?: number | null;
	hours_hard?: number | null;
	hours_limit?: number | null;
	hours_used?: number;
	hours_seconds_used?: number;
	hours_pct_soft?: number | null;
	hours_pct?: number | null;
	hours_level?: "ok" | "warn" | "soft" | "hard" | null;
	manage_url?: string;
	subscription_notice?: string | null;
	duplicate_subscription_warning?: boolean;
	prev_cancel_at?: string | null;
	speech_language?: string;
	timezone?: string;
	write_targets?: WriteTargets;
}

/** Fallback if /v1/me has no plans yet (old server). */
const DEFAULT_PLAN_CARDS: PlanCard[] = [
	{
		key: "lite",
		label: "Lite",
		price_usd: 9,
		soft_hours: 8,
		hard_hours: 12,
		blurb: "Occasional short voice memos. Light capture, not full meeting days.",
		recommended: false,
	},
	{
		key: "plus",
		label: "Plus",
		price_usd: 29,
		soft_hours: 45,
		hard_hours: 65,
		blurb: "Regular meetings and voice notes. Best default for most people.",
		recommended: true,
	},
	{
		key: "pro",
		label: "Pro",
		price_usd: 79,
		soft_hours: 160,
		hard_hours: 180,
		blurb: "Heavy month of calls: roughly a full work-month of audio.",
		recommended: false,
	},
];

interface ActiveJob {
	job_id: string;
	status: string;
	original_name?: string;
	progress_pct: number;
	queue_position: number;
	queue_total: number;
	created_at?: string;
}

const DEFAULT_SETTINGS: EnotSettings = {
	apiBase: DEFAULT_API,
	installId: "",
	apiKey: "",
	userId: "",
	endpoint: "",
	speechLanguage: "auto",
	baseLanguage: "en",
	onboarded: false,
	welcomeWritten: false,
	vaultSeeded: false,
	timezone: "",
	writeTargets: normalizeWriteTargets(null),
};

function newInstallId(): string {
	if (typeof crypto !== "undefined" && crypto.randomUUID) {
		return crypto.randomUUID();
	}
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
		const r = (Math.random() * 16) | 0;
		const v = ch === "x" ? r : (r & 0x3) | 0x8;
		return v.toString(16);
	});
}

function errMessage(err: unknown): string {
	if (err instanceof Error) {
		return err.message;
	}
	return String(err);
}

function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string" && value.trim() !== "") {
		const n = Number(value);
		return Number.isFinite(n) ? n : null;
	}
	return null;
}

/** Human length for quota copy (~12 min, ~1.5 h). */
function formatAudioAllowance(seconds: number): string {
	const s = Math.max(0, seconds);
	if (s < 60) {
		return `${Math.max(1, Math.round(s))} sec`;
	}
	const mins = s / 60;
	if (mins < 90) {
		return `~${Math.round(mins)} min`;
	}
	return `~${(mins / 60).toFixed(1)} h`;
}

function probeMediaDurationSeconds(file: File): Promise<number | null> {
	return new Promise((resolve) => {
		const url = URL.createObjectURL(file);
		const videoLike = (file.type || "").startsWith("video/") || /\.(mp4|mov|mkv|webm)$/i.test(file.name);
		const el = document.createElement(videoLike ? "video" : "audio");
		let settled = false;
		const finish = (sec: number | null) => {
			if (settled) {
				return;
			}
			settled = true;
			window.clearTimeout(timer);
			URL.revokeObjectURL(url);
			el.removeAttribute("src");
			try {
				el.load();
			} catch {
				/* ignore */
			}
			resolve(sec);
		};
		const timer = window.setTimeout(() => finish(null), 8000);
		el.preload = "metadata";
		el.onloadedmetadata = () => {
			const d = el.duration;
			finish(Number.isFinite(d) && d > 0 ? d : null);
		};
		el.onerror = () => finish(null);
		el.src = url;
	});
}

export function noteVaultPath(filename: string): string {
	let name = filename.replace(/^\/+/, "").replace(/\[\[/g, "").replace(/\]\]/g, "");
	const hasRoot = ENOT_PATH_ROOTS.some((root) => name.toLowerCase().startsWith(root.toLowerCase()));
	if (!hasRoot) {
		// Legacy bare day/Title.md → Meetings/day/Title.md
		name = `${MEETINGS_DIR}/${name}`;
	}
	const parts = name.split("/").filter(Boolean);
	const baseRaw = parts.pop() || "Voice note.md";
	let base = baseRaw.replace(UNSAFE_FILE, "").replace(/\s+/g, " ").trim();
	if (!base.toLowerCase().endsWith(".md")) {
		base = `${base || "Voice note"}.md`;
	}
	const dirs = parts.map((p) => p.replace(UNSAFE_FILE, "").trim()).filter(Boolean);
	return [...dirs, base].join("/");
}

export function draftVaultPath(jobId: string): string {
	const safe = jobId.replace(UNSAFE_FILE, "_");
	return `${MEETINGS_DIR}/_enot_processing_${safe}.md`;
}

function uiLang(settings: { baseLanguage?: string; speechLanguage: string }): "ru" | "en" {
	if (settings.baseLanguage) {
		return normalizeBaseLanguage(settings.baseLanguage);
	}
	const lang = (settings.speechLanguage || "auto").toLowerCase();
	if (lang === "ru" || lang === "uk") {
		return "ru";
	}
	return "en";
}

/** Draft title: queue position or processing %. */
export function progressNoteTitle(job: ActiveJob, lang: "ru" | "en" = "en"): string {
	const draftTitle = lang === "ru" ? "Новая заметка" : "New note";
	const waiting =
		job.status === "queued" && job.queue_total > 1 && job.queue_position > 1;
	if (waiting) {
		return lang === "ru"
			? `(очередь ${job.queue_position}) ${draftTitle}`
			: `(queue ${job.queue_position}) ${draftTitle}`;
	}
	const pct = Math.max(0, Math.min(99, Math.floor(Number(job.progress_pct) || 0)));
	return lang === "ru"
		? `(Обработка ${pct}%) ${draftTitle}`
		: `(Processing ${pct}%) ${draftTitle}`;
}

export function draftNoteContent(job: ActiveJob, lang: "ru" | "en" = "en"): string {
	const title = progressNoteTitle(job, lang);
	const body =
		lang === "ru"
			? "Enot обрабатывает запись. Не редактируй эту заметку вручную - она обновится сама.\n"
			: "Enot is processing the recording. Do not edit this note - it will update automatically.\n";
	return (
		`---\nenot_job_id: ${job.job_id}\nenot_draft: true\n---\n\n` +
		`# ${title}\n\n` +
		body
	);
}

export function mergeCalibrationBlocks(existing: string, append: string): string {
	if (!append.trim()) {
		return existing;
	}
	let text = existing || "";
	const blockRe = /###[^\n]*Неизвестный голос\s*\(`([^`]+)`\)[\s\S]*?(?=\n### |\s*$)/g;
	let match: RegExpExecArray | null;
	while ((match = blockRe.exec(append)) !== null) {
		const speakerId = match[1];
		const block = match[0].trimEnd();
		if (speakerId && text.includes(`\`${speakerId}\``)) {
			continue;
		}
		if (text && !text.endsWith("\n")) {
			text += "\n";
		}
		text += `\n${block}\n`;
	}
	return text;
}

const CAL_NAME_RE = /\*\*\s*Назначить имя:\s*\*\*\s*\[\[([^\]]+)\]\]/;
const CAL_BLOCK_RE =
	/###[^\n]*Неизвестный голос\s*\(`([^`]+)`\)([\s\S]*?)(?=\n### |\s*$)/g;

function isUnknownSpeakerName(name: string): boolean {
	const n = name.trim().toLowerCase();
	return !n || n === "неизвестный" || n === "unknown";
}

/** voice_id / SPEAKER_XX → real name from calibration markdown. */
export function parseCalibrationNames(text: string): Map<string, string> {
	const map = new Map<string, string>();
	const re = new RegExp(CAL_BLOCK_RE.source, "g");
	let match: RegExpExecArray | null;
	while ((match = re.exec(text || "")) !== null) {
		const id = match[1];
		const body = match[2] || "";
		const nm = CAL_NAME_RE.exec(body);
		const rawName = nm?.[1];
		const idKey = id?.trim();
		if (!nm || !rawName || !idKey) {
			continue;
		}
		const name = rawName.trim();
		if (isUnknownSpeakerName(name)) {
			continue;
		}
		map.set(idKey, name);
	}
	return map;
}

/**
 * Merge remote calibration with local names.
 * Local real names win; SPEAKER_00 local name stamps remote voice_* still marked Неизвестный.
 * Fixes boot pull wiping names the user already set in Obsidian.
 */
export function mergeCalibrationPreferLocalNames(local: string, remote: string): string {
	const localNames = parseCalibrationNames(local || "");
	let text = (remote || "").trim() ? remote : local || "";
	if (!localNames.size || !text.trim()) {
		return text || local || "";
	}
	const speaker00 = localNames.get("SPEAKER_00");
	const re = new RegExp(CAL_BLOCK_RE.source, "g");
	return text.replace(re, (full, id: string, body: string) => {
		const cur = CAL_NAME_RE.exec(body || "");
		const curName = cur?.[1]?.trim() || "";
		const curUnknown = isUnknownSpeakerName(curName);
		let want = localNames.get(id);
		if (
			!want &&
			speaker00 &&
			curUnknown &&
			(id === "SPEAKER_00" || String(id).startsWith("voice_"))
		) {
			want = speaker00;
		}
		if (!want) {
			return full;
		}
		if (!curUnknown && curName === want) {
			return full;
		}
		const newBody = (body || "").replace(
			CAL_NAME_RE,
			`**Назначить имя:** [[${want}]]`,
		);
		return full.replace(body, newBody);
	});
}

/** Prefer longer local Name_Hints list; union wikilink bullets without dupes. */
export function mergeNameHintsPreferLocal(local: string, remote: string): string {
	const parse = (text: string): string[] => {
		const names: string[] = [];
		const seen = new Set<string>();
		const re = /^[\s>*-]*\s*\[\[([^\]]+)\]\]\s*$/gm;
		let m: RegExpExecArray | null;
		while ((m = re.exec(text || "")) !== null) {
			const label = (m[1] || "").trim();
			const key = label.toLowerCase().replace(/ё/g, "е");
			if (!label || key === "неизвестный" || key === "unknown" || seen.has(key)) {
				continue;
			}
			seen.add(key);
			names.push(label);
		}
		return names;
	};
	const localNames = parse(local);
	const remoteNames = parse(remote);
	const seen = new Set(localNames.map((n) => n.toLowerCase().replace(/ё/g, "е")));
	const merged = [...localNames];
	for (const n of remoteNames) {
		const key = n.toLowerCase().replace(/ё/g, "е");
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		merged.push(n);
	}
	const base = (local || remote || NAME_HINTS_INTRO).trim();
	const introMatch = base.match(/^[\s\S]*?(?=\n- |\n\* |$)/);
	let intro = (introMatch?.[0] || NAME_HINTS_INTRO).trimEnd();
	if (!intro.includes("Name Hints")) {
		intro = NAME_HINTS_INTRO.trimEnd();
	}
	if (!merged.length) {
		return `${intro}\n`;
	}
	return `${intro}\n${merged.map((n) => `- [[${n}]]`).join("\n")}\n`;
}

export function appendPeopleToNameHints(existing: string, people: string[]): { text: string; added: number } {
	const parse = (text: string): Set<string> => {
		const seen = new Set<string>();
		const re = /^[\s>*-]*\s*\[\[([^\]]+)\]\]\s*$/gm;
		let m: RegExpExecArray | null;
		while ((m = re.exec(text || "")) !== null) {
			const key = (m[1] || "").trim().toLowerCase().replace(/ё/g, "е");
			if (key && key !== "неизвестный" && key !== "unknown") {
				seen.add(key);
			}
		}
		return seen;
	};
	const have = parse(existing);
	const toAdd: string[] = [];
	for (const raw of people) {
		const label = (raw || "").trim();
		const key = label.toLowerCase().replace(/ё/g, "е");
		if (!label || key === "неизвестный" || key === "unknown" || have.has(key)) {
			continue;
		}
		have.add(key);
		toAdd.push(label);
	}
	if (!toAdd.length) {
		return { text: existing || NAME_HINTS_INTRO, added: 0 };
	}
	let text = (existing || NAME_HINTS_INTRO).trimEnd() + "\n";
	for (const name of toAdd) {
		text += `- [[${name}]]\n`;
	}
	return { text, added: toAdd.length };
}

export default class EnotPlugin extends Plugin {
	settings: EnotSettings = { ...DEFAULT_SETTINGS };
	entitlement: Entitlement | null = null;
	private pulling = false;
	private syncingCalibration = false;
	private syncingNameHints = false;
	private syncingBrandHints = false;
	private syncingClarify = false;
	private mediaRecorder: MediaRecorder | null = null;
	private mediaChunks: BlobPart[] = [];
	private mediaStream: MediaStream | null = null;
	private recordPanel: HTMLElement | null = null;
	private recordTimerEl: HTMLElement | null = null;
	private recordWaveCanvas: HTMLCanvasElement | null = null;
	private recordStartedAt = 0;
	private recordTimerId: number | null = null;
	private recordRaf = 0;
	private audioCtx: AudioContext | null = null;
	private analyser: AnalyserNode | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addCommands();
		this.addSettingTab(new EnotSettingTab(this.app, this));
		this.addRibbonIcon("sync", "Fetch notes from Enot", () => {
			void this.syncFromServer(true);
		});
		this.mountCaptureRibbon();
		this.registerEvent(this.app.vault.on("create", (file) => void this.expandGraph(file)));
		this.registerEvent(this.app.vault.on("modify", (file) => void this.onVaultModify(file)));
		this.registerInterval(window.setInterval(() => void this.syncFromServer(false), POLL_MS));

		this.app.workspace.onLayoutReady(() => {
			void this.boot();
		});
	}

	onunload(): void {
		this.teardownRecorder(false);
	}

	private mountCaptureRibbon(): void {
		const el = this.addRibbonIcon("mic", "Enot", (evt) => {
			this.showCaptureMenu(evt);
		});
		el.empty();
		el.addClass("enot-ribbon");
		el.setAttribute("aria-label", "Enot");
		el.setAttribute("data-tooltip-position", "right");
		const icon = el.createDiv({ cls: "enot-ribbon-icon" });
		icon.style.maskImage = `url(${ENOT_RACCOON_ICON_DATA_URL})`;
	}

	private showCaptureMenu(evt: MouseEvent): void {
		const menu = new Menu();
		if (this.mediaRecorder?.state === "recording") {
			menu.addItem((item) => {
				item
					.setTitle("Stop & send")
					.setIcon("square")
					.onClick(() => {
						void this.stopRecordingAndUpload();
					});
			});
		} else {
			menu.addItem((item) => {
				item
					.setTitle("Microphone")
					.setIcon("mic")
					.onClick(() => {
						void this.startRecording();
					});
			});
		}
		menu.addItem((item) => {
			item
				.setTitle("Upload file")
				.setIcon("file-plus")
				.onClick(() => {
					void this.pickAndUploadMedia();
				});
		});
		menu.showAtMouseEvent(evt);
	}

	private addCommands(): void {
		this.addCommand({
			id: "copy-key",
			name: "Copy API key",
			callback: async () => {
				if (!this.settings.apiKey) {
					new Notice("Enot: no API key yet");
					return;
				}
				await navigator.clipboard.writeText(this.settings.apiKey);
				new Notice("Enot: key copied");
			},
		});
		this.addCommand({
			id: "open-checkout",
			name: "Choose plan",
			callback: () => this.openPlansModal(),
		});
		this.addCommand({
			id: "pull-inbox",
			name: "Fetch notes",
			callback: async () => {
				await this.syncFromServer(true);
			},
		});
		this.addCommand({
			id: "upload-media",
			name: "Upload audio or video",
			callback: () => {
				void this.pickAndUploadMedia();
			},
		});
	}

	private async boot(): Promise<void> {
		try {
			await this.hydrateFromVault();
			await this.removeEmptyLegacySystem();
			if (!this.settings.installId) {
				this.settings.installId = newInstallId();
				await this.saveSettings();
			}
		} catch (err) {
			console.error("Enot boot failed", err);
			new Notice(`Enot: vault setup failed - ${errMessage(err)}`);
		}

		void this.syncFromServer(false);

		try {
			await this.ensureOnboardedAndRegistered();
			await this.refreshEntitlement();
			await this.ensureTimezone();
			await this.pushUserSettings();
		} catch (err) {
			console.error("Enot register failed", err);
			new Notice(t(uiLang(this.settings), "notice.register_fail"));
		}
	}

	/** Language modal (once) → Register → seed folders + welcome. */
	async ensureOnboardedAndRegistered(): Promise<void> {
		if (!this.settings.onboarded) {
			await this.promptOnboardingLanguage();
		}
		if (!this.settings.apiKey) {
			await this.ensureRegistered();
		}
		await this.seedVaultLayout();
	}

	promptOnboardingLanguage(): Promise<void> {
		return new Promise((resolve, reject) => {
			let settled = false;
			const finish = (fn: () => void | Promise<void>) => {
				if (settled) {
					return;
				}
				settled = true;
				Promise.resolve(fn()).then(resolve).catch(reject);
			};
			const lang0 = normalizeBaseLanguage(this.settings.baseLanguage);
			const modal = new OnboardingModal(this.app, {
				initialLang: lang0,
				title: t(lang0, "onboarding.title"),
				lead: t(lang0, "onboarding.lead"),
				languageLabel: t(lang0, "onboarding.language"),
				continueLabel: t(lang0, "onboarding.continue"),
				langOptions: BASE_LANGUAGES,
				onContinue: async (lang) => {
					this.settings.baseLanguage = lang;
					this.settings.onboarded = true;
					if (this.settings.speechLanguage === "auto" && lang === "ru") {
						this.settings.speechLanguage = "ru";
					}
					await this.saveSettings();
					new Notice(t(lang, "notice.onboarded"));
					finish(() => undefined);
				},
			});
			const prevClose = modal.onClose.bind(modal);
			modal.onClose = () => {
				prevClose();
				if (!settled) {
					finish(async () => {
						this.settings.baseLanguage = "en";
						this.settings.onboarded = true;
						await this.saveSettings();
					});
				}
			};
			modal.open();
		});
	}

	async ensureFolder(path: string): Promise<void> {
		const rel = path.replace(/^\/+/, "").replace(/\/+$/, "");
		if (!rel) {
			return;
		}
		if (await this.app.vault.adapter.exists(rel)) {
			return;
		}
		const parts = rel.split("/").filter(Boolean);
		let cur = "";
		for (const part of parts) {
			cur = cur ? `${cur}/${part}` : part;
			try {
				if (!(await this.app.vault.adapter.exists(cur))) {
					await this.app.vault.createFolder(cur);
				}
			} catch {
				/* exists */
			}
		}
	}

	async seedVaultLayout(): Promise<void> {
		let wroteSomething = false;
		if (!this.settings.vaultSeeded) {
			for (const folder of SEED_FOLDERS) {
				await this.ensureFolder(folder);
			}
			this.settings.vaultSeeded = true;
			wroteSomething = true;
		}

		const agreementReadme = `${AGREEMENTS_DIR}/README.md`;
		const timelinePath = `${AGREEMENTS_DIR}/_Timeline.md`;
		const agreementTpl = `${TEMPLATES_DIR}/Agreement.md`;

		if (!(await this.app.vault.adapter.exists(agreementReadme))) {
			await this.ensureFolder(AGREEMENTS_DIR);
			await this.app.vault.create(agreementReadme, AGREEMENTS_README);
			wroteSomething = true;
		}
		if (!(await this.app.vault.adapter.exists(timelinePath))) {
			await this.ensureFolder(AGREEMENTS_DIR);
			const today = new Date().toISOString().slice(0, 10);
			await this.app.vault.create(timelinePath, timelineBody(today));
			wroteSomething = true;
		}
		if (!(await this.app.vault.adapter.exists(agreementTpl))) {
			await this.ensureFolder(TEMPLATES_DIR);
			await this.app.vault.create(agreementTpl, AGREEMENT_TEMPLATE);
			wroteSomething = true;
		}

		if (!this.settings.welcomeWritten) {
			if (!(await this.app.vault.adapter.exists(WELCOME_PATH))) {
				await this.ensureFolder(WELCOME_PATH.split("/")[0]!);
				await this.app.vault.create(WELCOME_PATH, WELCOME_BODY_EN);
			}
			this.settings.welcomeWritten = true;
			wroteSomething = true;
		}

		if (wroteSomething) {
			await this.saveSettings();
			new Notice(t(uiLang(this.settings), "notice.vault_ready"));
		}
	}

	private async onVaultModify(file: TAbstractFile): Promise<void> {
		await this.expandGraph(file);
	}

	async loadSettings(): Promise<void> {
		const raw = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()) as EnotSettings;
		raw.writeTargets = normalizeWriteTargets(raw.writeTargets);
		raw.baseLanguage = normalizeBaseLanguage(raw.baseLanguage);
		raw.onboarded = Boolean(raw.onboarded);
		raw.welcomeWritten = Boolean(raw.welcomeWritten);
		raw.vaultSeeded = Boolean(raw.vaultSeeded);
		// Existing installs with an API key skip the language modal
		if (raw.apiKey && !raw.onboarded) {
			raw.onboarded = true;
		}
		this.settings = raw;
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** Folders are created only when writing a file - never pre-seed System/Notes/People/Topics. */
	private async ensureParentFolders(path: string): Promise<void> {
		const parts = path.split("/").filter(Boolean);
		if (parts.length < 2) {
			return;
		}
		let cur = "";
		for (let i = 0; i < parts.length - 1; i++) {
			cur = cur ? `${cur}/${parts[i]}` : parts[i]!;
			try {
				if (!(await this.app.vault.adapter.exists(cur))) {
					await this.app.vault.createFolder(cur);
				}
			} catch {
				/* exists */
			}
		}
	}

	/**
	 * Remove leftover System/ from older plugin versions.
	 * Glossaries + auth live in plugin settings / API now - never recreate System in the vault.
	 */
	async removeEmptyLegacySystem(): Promise<void> {
		const legacyNames = new Set([
			"enot.json",
			"second-brain.json",
			"Name_Hints.md",
			"Brand_Hints.md",
			"Clarify_Queue.md",
			"Voice_Calibration.md",
			"ASR_Patterns.md",
		]);
		const sys = this.app.vault.getAbstractFileByPath("System");
		if (!sys || !("children" in sys)) {
			return;
		}
		const kids = [...((sys as { children?: TAbstractFile[] }).children || [])];
		for (const child of kids) {
			if (legacyNames.has(child.name)) {
				try {
					await this.app.vault.trash(child, true);
				} catch (err) {
					console.warn("Enot: could not remove legacy", child.path, err);
				}
			}
		}
		const remaining = ((sys as { children?: TAbstractFile[] }).children || []).filter(
			(c) => !String(c.name).startsWith("."),
		);
		if (remaining.length > 0) {
			return;
		}
		try {
			await this.app.vault.trash(sys, true);
		} catch (err) {
			console.warn("Enot: could not remove empty System/", err);
		}
	}

	async hydrateFromVault(): Promise<void> {
		if (this.settings.installId && this.settings.apiKey) {
			return;
		}
		const file =
			this.app.vault.getAbstractFileByPath(LEGACY_AUTH_FILE) ??
			this.app.vault.getAbstractFileByPath("System/second-brain.json");
		if (!(file instanceof TFile)) {
			return;
		}
		try {
			const data = asRecord(JSON.parse(await this.app.vault.read(file)));
			this.settings.installId = this.settings.installId || asString(data.install_id);
			this.settings.apiKey = this.settings.apiKey || asString(data.api_key);
			this.settings.userId = this.settings.userId || asString(data.user_id);
			this.settings.endpoint = this.settings.endpoint || asString(data.endpoint);
			const lang = normalizeSpeechLanguage(asString(data.speech_language));
			if (data.speech_language) {
				this.settings.speechLanguage = lang;
			}
			if (typeof data.endpoint === "string" && data.endpoint) {
				this.settings.apiBase = data.endpoint;
			}
			await this.saveSettings();
		} catch (err) {
			console.warn("Enot: cannot read legacy auth file", err);
		}
	}

	async ensureTimezone(): Promise<void> {
		if (this.settings.timezone) {
			return;
		}
		try {
			const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
			this.settings.timezone = tz;
			await this.saveSettings();
		} catch {
			this.settings.timezone = "UTC";
		}
	}

	apiBase(): string {
		return (this.settings.apiBase || DEFAULT_API).replace(/\/$/, "");
	}

	async ensureRegistered(): Promise<void> {
		const L = uiLang(this.settings);
		const base = this.apiBase();
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const modal = new TosAgreeModal(this.app, {
				title: t(L, "tos.title"),
				lead: t(L, "tos.lead"),
				agreeLabel: t(L, "tos.agree"),
				termsLabel: t(L, "tos.terms"),
				privacyLabel: t(L, "tos.privacy"),
				termsUrl: `${base}/legal/terms`,
				privacyUrl: `${base}/legal/privacy`,
				continueLabel: t(L, "tos.continue"),
				cancelLabel: t(L, "tos.cancel"),
				onAgree: async () => {
					settled = true;
					const res = await requestUrl({
						url: `${this.apiBase()}/v1/register`,
						method: "POST",
						contentType: "application/json",
						body: JSON.stringify({
							install_id: this.settings.installId,
							tos_accepted: true,
						}),
					});
					const body = asRecord(res.json);
					this.settings.apiKey = asString(body.api_key);
					this.settings.userId = asString(body.user_id);
					this.settings.installId = asString(body.install_id, this.settings.installId);
					this.settings.endpoint = asString(body.endpoint, this.apiBase());
					await this.saveSettings();
					resolve();
				},
			});
			const prevClose = modal.onClose.bind(modal);
			modal.onClose = () => {
				prevClose();
				if (!settled) {
					reject(new Error("tos_cancelled"));
				}
			};
			modal.open();
		});
	}

	enotVaultWipePaths(): string[] {
		return [
			`${INBOX_DIR}/ (Enot capture notes)`,
			`${MEETINGS_DIR}/ (Enot notes + _enot_processing_* drafts)`,
			`${RESOURCES_DIR}/til/ (Enot TIL notes)`,
			`${DECISIONS_DIR}/ (Enot decision notes)`,
			`${PEOPLE_DIR}/, ${TOPICS_DIR}/, ${PROJECTS_DIR}/ (stubs with source: enot)`,
			`${AGREEMENTS_DIR}/ (notes with enot_commitment: true; rebuild _Timeline.md)`,
		];
	}

	async promptDeleteAccount(): Promise<void> {
		const L = uiLang(this.settings);
		const wipe = await new Promise<boolean | null>((resolve) => {
			let chosen: boolean | null = null;
			const modal = new DeleteAccountModal(this.app, {
				title: t(L, "delete.title"),
				lead: t(L, "delete.lead"),
				vaultLabel: t(L, "delete.vault"),
				vaultListLabel: t(L, "delete.vault_list"),
				vaultPaths: this.enotVaultWipePaths(),
				confirmLabel: t(L, "delete.confirm"),
				cancelLabel: t(L, "tos.cancel"),
				onContinue: (wipeVault) => {
					chosen = wipeVault;
				},
			});
			const prev = modal.onClose.bind(modal);
			modal.onClose = () => {
				prev();
				resolve(chosen);
			};
			modal.open();
		});
		if (wipe === null) {
			return;
		}
		await new Promise<void>((resolve) => {
			let ran = false;
			const modal = new DeleteConfirmModal(this.app, {
				title: t(L, "delete.confirm2_title"),
				lead: t(L, "delete.confirm2_lead"),
				confirmLabel: t(L, "delete.confirm"),
				cancelLabel: t(L, "tos.cancel"),
				onConfirm: async () => {
					ran = true;
					await this.executeDeleteAccount(wipe);
				},
			});
			const prev = modal.onClose.bind(modal);
			modal.onClose = () => {
				prev();
				resolve();
			};
			modal.open();
			void ran;
		});
	}

	async executeDeleteAccount(wipeVault: boolean): Promise<void> {
		const L = uiLang(this.settings);
		if (!this.settings.apiKey) {
			return;
		}
		try {
			await requestUrl({
				url: `${this.apiBase()}/v1/me`,
				method: "DELETE",
				headers: { "X-API-Key": this.settings.apiKey },
			});
			if (wipeVault) {
				await this.wipeEnotVaultContent();
			}
			this.settings.apiKey = "";
			this.settings.userId = "";
			this.entitlement = null;
			await this.saveSettings();
			new Notice(t(L, "delete.done"));
		} catch (err) {
			console.warn("Enot: delete account failed", err);
			new Notice(t(L, "delete.fail"));
			throw err;
		}
	}

	private async wipeEnotVaultContent(): Promise<void> {
		const files = this.app.vault.getMarkdownFiles();
		const captureRoots = [
			`${INBOX_DIR}/`,
			`${MEETINGS_DIR}/`,
			`${RESOURCES_DIR}/til/`,
			`${DECISIONS_DIR}/`,
		];
		const stubRoots = [`${PEOPLE_DIR}/`, `${TOPICS_DIR}/`, `${PROJECTS_DIR}/`];
		for (const file of files) {
			const path = file.path;
			if (path.startsWith(`${MEETINGS_DIR}/_enot_processing_`)) {
				await this.app.vault.trash(file, true);
				continue;
			}
			let markdown = "";
			try {
				markdown = await this.app.vault.read(file);
			} catch {
				continue;
			}
			const front = parseFrontmatter(markdown);
			const inCapture = captureRoots.some((r) => path.startsWith(r));
			const inStub = stubRoots.some((r) => path.startsWith(r));
			const inAgr = path.startsWith(`${AGREEMENTS_DIR}/`);
			if (inCapture && (isEnotCapture(front) || /_enot_processing_/.test(path))) {
				await this.app.vault.trash(file, true);
				continue;
			}
			if (inStub && /source:\s*enot/i.test(front)) {
				await this.app.vault.trash(file, true);
				continue;
			}
			if (
				inAgr &&
				file.name !== "README.md" &&
				file.name !== "_Timeline.md" &&
				(/enot_commitment:\s*true/i.test(front) || /type:\s*agreement/i.test(front))
			) {
				await this.app.vault.trash(file, true);
			}
		}
		try {
			await this.rebuildAgreementsTimeline();
		} catch {
			/* ignore */
		}
	}

	async refreshEntitlement(opts?: { quiet?: boolean }): Promise<void> {
		if (!this.settings.apiKey) {
			return;
		}
		const quiet = Boolean(opts?.quiet);
		const res = await requestUrl({
			url: `${this.apiBase()}/v1/me`,
			method: "GET",
			headers: { "X-API-Key": this.settings.apiKey },
		});
		this.entitlement = asRecord(res.json);
		const lang = normalizeSpeechLanguage(this.entitlement?.speech_language);
		if (this.entitlement?.speech_language && this.settings.speechLanguage !== lang) {
			this.settings.speechLanguage = lang;
			await this.saveSettings();
		}
		if (this.entitlement?.write_targets) {
			this.settings.writeTargets = normalizeWriteTargets(this.entitlement.write_targets);
			await this.saveSettings();
		}
		if (quiet) {
			return;
		}
		if (this.entitlement?.subscription_notice) {
			new Notice(`Enot: ${this.entitlement.subscription_notice}`, 12000);
		}
		if (this.entitlement?.access === "expired") {
			new Notice(
				"Your free week is over. Open the Enot checkout command to continue.",
				0,
			);
		} else if (this.entitlement?.access === "trial") {
			const daysLeft = this.entitlement.days_left ?? 0;
			const used = this.entitlement.hours_used ?? 0;
			const ceiling = this.entitlement.hours_hard ?? this.entitlement.hours_limit;
			const hoursBit =
				ceiling != null ? ` · ${used.toFixed(2)} / ${ceiling} h trial audio` : "";
			new Notice(`Enot: ${daysLeft} trial day(s) left${hoursBit}`);
			const level = this.entitlement.hours_level;
			if (level === "soft" || level === "warn") {
				new Notice("Enot: trial audio is almost used up. Subscribe to keep going.", 10000);
			} else if (level === "hard") {
				new Notice("Enot: trial audio limit reached. Subscribe to continue.", 12000);
			}
		} else if (this.entitlement?.access === "paid") {
			const level = this.entitlement.hours_level;
			const used = this.entitlement.hours_used ?? 0;
			const ceiling = this.entitlement.hours_hard ?? this.entitlement.hours_soft;
			if (level === "hard") {
				new Notice(
					`Enot: monthly limit reached (${used} / ${ceiling} h). Upgrade to continue.`,
					0,
				);
			} else if (level === "soft" || level === "warn") {
				new Notice(
					`Enot: ${used} / ${ceiling} h used this month.`,
					8000,
				);
			}
		}
	}

	/** Seconds left under hard cap; 0 = blocked; null = unknown / no cap. */
	remainingHardSeconds(): number | null {
		const ent = this.entitlement;
		if (!ent) {
			return null;
		}
		if (ent.access === "expired") {
			return 0;
		}
		const hard = asNumber(ent.hours_hard) ?? asNumber(ent.hours_limit);
		if (hard == null || hard <= 0) {
			return null;
		}
		const used = asNumber(ent.hours_used) ?? 0;
		return Math.max(0, (hard - used) * 3600);
	}

	showQuotaGate(title: string, body: string): void {
		new QuotaGateModal(this.app, {
			title,
			body,
			onUpgrade: () => this.openPlansModal(),
		}).open();
	}

	/**
	 * Block record/upload when trial expired or hard hours insufficient.
	 * @param neededSeconds known clip length; omit to only check remaining > 0.
	 */
	async ensureCaptureAllowed(neededSeconds?: number | null): Promise<boolean> {
		try {
			await this.refreshEntitlement({ quiet: true });
		} catch (err) {
			console.warn("Enot: entitlement refresh failed before capture", err);
		}
		const access = this.entitlement?.access || "unknown";
		if (access === "expired") {
			this.showQuotaGate(
				"Trial ended",
				"Your free week is over. Upgrade a plan to keep turning voice into notes.",
			);
			return false;
		}
		const remaining = this.remainingHardSeconds();
		if (remaining === null) {
			return true;
		}
		if (remaining <= 0) {
			const used = asNumber(this.entitlement?.hours_used) ?? 0;
			const hard =
				asNumber(this.entitlement?.hours_hard) ?? asNumber(this.entitlement?.hours_limit) ?? used;
			const kind = access === "trial" ? "trial" : "monthly";
			this.showQuotaGate(
				access === "trial" ? "Trial audio limit reached" : "Monthly audio limit reached",
				`You've used ${used.toFixed(2)} / ${hard} h of ${kind} audio. Upgrade your plan to continue.`,
			);
			return false;
		}
		if (neededSeconds != null && neededSeconds > 0 && neededSeconds > remaining + 2) {
			this.showQuotaGate(
				"File exceeds your remaining audio",
				`This clip is ${formatAudioAllowance(neededSeconds)}, but you have ${formatAudioAllowance(remaining)} left on your plan. Use a shorter file or upgrade.`,
			);
			return false;
		}
		return true;
	}

	handleProcessGateResponse(body: Record<string, unknown>): boolean {
		const status = asString(body.status);
		if (status !== "quota_exceeded" && status !== "payment_required") {
			return false;
		}
		if (asNumber(body.hours_used) != null || asNumber(body.hours_hard) != null) {
			this.entitlement = {
				...(this.entitlement || {}),
				...body,
				access: status === "payment_required" ? "expired" : this.entitlement?.access,
				hours_level: status === "quota_exceeded" ? "hard" : this.entitlement?.hours_level,
			};
		}
		const title =
			asString(body.notification_title) ||
			(status === "payment_required" ? "Trial ended" : "Audio limit reached");
		const fallbackBody =
			status === "payment_required"
				? "Your free week is over. Upgrade a plan to continue."
				: "You've used your audio allowance. Upgrade your plan to continue.";
		this.showQuotaGate(title, asString(body.notification_body, fallbackBody));
		return true;
	}

	openCheckout(planKey?: string): void {
		if (!planKey) {
			this.openPlansModal();
			return;
		}
		const urls = this.entitlement?.checkout_urls || {};
		const fromCatalog = (this.entitlement?.plans || []).find((p) => p.key === planKey);
		const url =
			(fromCatalog?.checkout_url || "").trim() ||
			urls[planKey] ||
			this.entitlement?.checkout_url ||
			urls.plus ||
			urls.lite ||
			urls.pro ||
			"";
		if (!url) {
			new Notice("Checkout URL is not configured on the server yet.");
			return;
		}
		window.open(url);
	}

	openPlansModal(): void {
		const plans =
			this.entitlement?.plans && this.entitlement.plans.length
				? this.entitlement.plans
				: DEFAULT_PLAN_CARDS;
		new PlansModal(this.app, {
			plans,
			currentPlan: this.entitlement?.plan || null,
			access: this.entitlement?.access || "unknown",
			onChoose: (key) => this.openCheckout(key),
		}).open();
	}

	openManageBilling(): void {
		const url = this.entitlement?.manage_url || "";
		if (!url) {
			new Notice("No active Whop membership to manage yet.");
			return;
		}
		window.open(url);
	}


	async syncFromServer(manual: boolean): Promise<number> {
		if (this.pulling) {
			return 0;
		}
		if (!this.settings.apiKey) {
			if (manual) {
				new Notice("Enot: no API key. Open settings and press Register.");
			}
			return 0;
		}
		this.pulling = true;
		try {
			await this.syncActiveJobs();
			return await this.pullInbox(manual);
		} finally {
			this.pulling = false;
		}
	}

	async syncActiveJobs(): Promise<void> {
		if (!this.settings.apiKey) {
			return;
		}
		try {
			const res = await requestUrl({
				url: `${this.apiBase()}/v1/jobs`,
				method: "GET",
				headers: { "X-API-Key": this.settings.apiKey },
			});
			const payload = asRecord(res.json);
			const rawJobs = Array.isArray(payload.jobs) ? payload.jobs : [];
			const jobs: ActiveJob[] = rawJobs.map((item) => {
				const raw = asRecord(item);
				return {
					job_id: asString(raw.job_id),
					status: asString(raw.status, "queued"),
					original_name: asString(raw.original_name),
					progress_pct: Number(raw.progress_pct) || 0,
					queue_position: Number(raw.queue_position) || 1,
					queue_total: Number(raw.queue_total) || 1,
					created_at: asString(raw.created_at),
				};
			});
			const activeIds = new Set<string>();
			for (const job of jobs) {
				if (!job.job_id) {
					continue;
				}
				activeIds.add(job.job_id);
				await this.writeMarkdown(draftVaultPath(job.job_id), draftNoteContent(job, uiLang(this.settings)));
			}
			await this.cleanupStaleDrafts(activeIds);
		} catch (err) {
			console.warn("Enot: jobs sync failed", err);
		}
	}

	private async cleanupStaleDrafts(activeIds: Set<string>): Promise<void> {
		const notesFolder =
			this.app.vault.getAbstractFileByPath(MEETINGS_DIR) ??
			this.app.vault.getAbstractFileByPath("Notes");
		if (!notesFolder || !("children" in notesFolder)) {
			return;
		}
		const children = (notesFolder as { children?: TAbstractFile[] }).children || [];
		for (const child of children) {
			if (!(child instanceof TFile)) {
				continue;
			}
			if (!child.name.startsWith("_enot_processing_") || !child.name.endsWith(".md")) {
				continue;
			}
			const jobId = child.name.slice("_enot_processing_".length, -".md".length);
			if (activeIds.has(jobId)) {
				continue;
			}
			try {
				await this.app.vault.trash(child, true);
			} catch (err) {
				console.warn("Enot: draft cleanup failed", child.path, err);
			}
		}
	}

	private async removeDraft(jobId: string): Promise<void> {
		const path = draftVaultPath(jobId);
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			try {
				await this.app.vault.trash(existing, true);
			} catch (err) {
				console.warn("Enot: remove draft failed", path, err);
			}
		}
	}

	async pullInbox(manual: boolean): Promise<number> {
		if (!this.settings.apiKey) {
			if (manual) {
				new Notice("Enot: no API key. Open settings and press Register.");
			}
			return 0;
		}
		try {
			const res = await requestUrl({
				url: `${this.apiBase()}/v1/inbox`,
				method: "GET",
				headers: { "X-API-Key": this.settings.apiKey },
			});
			const notesRaw = asRecord(res.json).notes;
			const notes = Array.isArray(notesRaw) ? notesRaw : [];
			let saved = 0;
			let wroteAgreements = false;
			for (const item of notes) {
				const note = asRecord(item);
				const filename = asString(note.filename);
				const content = asString(note.content);
				const jobId = asString(note.job_id);
				const calibrationAppend = asString(note.calibration_append);
				if (!filename || !content || !jobId) {
					continue;
				}
				const path = remapPathForTargets(
					noteVaultPath(filename),
					normalizeWriteTargets(this.settings.writeTargets),
				);
				await this.writeMarkdown(path, content);
				await this.removeDraft(jobId);
				// calibration_append already on server vault; plugin is API-only for System data
				void calibrationAppend;
				await this.mergePeopleIntoNameHints(parseYamlList(parseFrontmatter(content), "people"));

				const sidecarsRaw = note.sidecar_notes;
				const sidecars = Array.isArray(sidecarsRaw) ? sidecarsRaw : [];
				for (const side of sidecars) {
					const sc = asRecord(side);
					const scName = asString(sc.filename);
					const scContent = asString(sc.content);
					if (!scName || !scContent) {
						continue;
					}
					const scPath = noteVaultPath(scName);
					await this.writeMarkdown(scPath, scContent);
					if (scPath.startsWith(`${AGREEMENTS_DIR}/`)) {
						wroteAgreements = true;
					}
				}

				await requestUrl({
					url: `${this.apiBase()}/v1/inbox/${jobId}/ack`,
					method: "POST",
					headers: { "X-API-Key": this.settings.apiKey },
				});
				saved += 1;
				new Notice(`Enot: saved ${path}`);
			}
			if (wroteAgreements || saved > 0) {
				try {
					await this.rebuildAgreementsTimeline();
				} catch (err) {
					console.warn("Enot: agreements timeline rebuild failed", err);
				}
			}
			if (manual && saved === 0) {
				new Notice("Enot: no new notes");
			}
			return saved;
		} catch (err) {
			console.warn("Enot: inbox pull failed", err);
			new Notice(`Enot: sync failed - ${errMessage(err)}`);
			return 0;
		}
	}

	/** Rebuild `11 Agreements/_Timeline.md` from agreement frontmatter (due/owner). */
	async rebuildAgreementsTimeline(): Promise<void> {
		await this.ensureFolder(AGREEMENTS_DIR);
		const files = this.app.vault
			.getMarkdownFiles()
			.filter(
				(f) =>
					f.path.startsWith(`${AGREEMENTS_DIR}/`) &&
					f.name !== "README.md" &&
					f.name !== "_Timeline.md" &&
					!f.path.slice(AGREEMENTS_DIR.length + 1).includes("/"),
			);

		type Row = { title: string; due: string; owner: string; status: string };
		const rows: Row[] = [];
		for (const file of files) {
			const markdown = await this.app.vault.read(file);
			const front = parseFrontmatter(markdown);
			const due = parseYamlScalar(front, "due");
			if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) {
				continue;
			}
			const owner = parseYamlScalar(front, "owner");
			const status = (parseYamlScalar(front, "status") || "open").toLowerCase();
			let title = "";
			const h1 = markdown.match(/^#\s+(.+)$/m);
			if (h1?.[1]) {
				title = h1[1].trim();
			}
			if (!title) {
				title = file.basename.replace(/^\d{4}-\d{2}-\d{2}\s+/, "").trim() || file.basename;
			}
			rows.push({ title, due, owner, status });
		}
		rows.sort((a, b) => a.due.localeCompare(b.due) || a.title.localeCompare(b.title));

		const byOwner = new Map<string, Row[]>();
		for (const row of rows) {
			const key = row.owner.trim() || "Open";
			const list = byOwner.get(key) || [];
			list.push(row);
			byOwner.set(key, list);
		}

		const escapeLabel = (s: string): string =>
			s.replace(/[:#]/g, " ").replace(/\s+/g, " ").trim().slice(0, 48) || "task";

		const lines: string[] = [
			"---",
			"type: timeline",
			"enot_generated: true",
			"---",
			"",
			"# Agreements timeline",
			"",
			"Auto-updated when Enot pulls meeting commitments. Edit Agreement notes; this file is rebuilt from their frontmatter.",
			"",
			"```mermaid",
			"gantt",
			"    title Commitments",
			"    dateFormat  YYYY-MM-DD",
			"    axisFormat  %b %d",
		];

		if (rows.length === 0) {
			const today = new Date().toISOString().slice(0, 10);
			lines.push("    section Open");
			lines.push(`    No open commitments yet    :${today}, 1d`);
		} else {
			let idx = 0;
			const owners = [...byOwner.keys()].sort((a, b) => {
				if (a === "Open") return 1;
				if (b === "Open") return -1;
				return a.localeCompare(b);
			});
			for (const owner of owners) {
				lines.push(`    section ${escapeLabel(owner)}`);
				for (const row of byOwner.get(owner) || []) {
					idx += 1;
					const tag = row.status === "done" || row.status === "closed" ? "done" : "active";
					lines.push(`    ${escapeLabel(row.title)}    :${tag}, t${idx}, ${row.due}, 1d`);
				}
			}
		}
		lines.push("```");
		lines.push("");

		await this.writeMarkdown(`${AGREEMENTS_DIR}/_Timeline.md`, `${lines.join("\n")}\n`);
	}

	async pushCalibration(force: boolean = false, contentOverride?: string): Promise<string[]> {
		if ((!force && this.syncingCalibration) || !this.settings.apiKey) {
			return [];
		}
		try {
			const content = contentOverride;
			if (content == null) {
				return [];
			}
			const res = await requestUrl({
				url: `${this.apiBase()}/v1/calibration`,
				method: "POST",
				contentType: "application/json",
				headers: { "X-API-Key": this.settings.apiKey },
				body: JSON.stringify({ content }),
			});
			const clipsRaw = asRecord(res.json).clips;
			const clips = Array.isArray(clipsRaw) ? clipsRaw.map((c) => asString(c)).filter(Boolean) : [];
			return clips;
		} catch (err) {
			console.warn("Enot: calibration push failed", err);
			throw err;
		}
	}

	async confirmClarifyItem(heard: string, canon: string): Promise<void> {
		if (!this.settings.apiKey) {
			throw new Error("No API key");
		}
		await requestUrl({
			url: `${this.apiBase()}/v1/clarify-confirm`,
			method: "POST",
			contentType: "application/json",
			headers: { "X-API-Key": this.settings.apiKey },
			body: JSON.stringify({ heard, canon, as_brand: true }),
		});
	}

	async fetchCalibrationClips(): Promise<string[]> {
		if (!this.settings.apiKey) {
			return [];
		}
		const res = await requestUrl({
			url: `${this.apiBase()}/v1/calibration`,
			method: "GET",
			headers: { "X-API-Key": this.settings.apiKey },
		});
		return Array.isArray(asRecord(res.json).clips)
			? (asRecord(res.json).clips as unknown[]).map((c) => asString(c)).filter(Boolean)
			: [];
	}

	async playCalibrationClip(voiceId: string): Promise<void> {
		if (!this.settings.apiKey || !voiceId) {
			return;
		}
		const res = await requestUrl({
			url: `${this.apiBase()}/v1/calibration/${encodeURIComponent(voiceId)}/audio`,
			method: "GET",
			headers: { "X-API-Key": this.settings.apiKey },
		});
		const blob = new Blob([res.arrayBuffer], { type: "audio/mp4" });
		const url = URL.createObjectURL(blob);
		const audio = new Audio(url);
		audio.addEventListener("ended", () => URL.revokeObjectURL(url));
		audio.addEventListener("error", () => URL.revokeObjectURL(url));
		await audio.play();
	}

	openWriteTargetsModal(): void {
		new WriteTargetsModal(
			this.app,
			normalizeWriteTargets(this.settings.writeTargets),
			async (targets) => {
				this.settings.writeTargets = targets;
				await this.saveSettings();
				await this.pushUserSettings();
			},
		).open();
	}

	openNameHintsTable(): void {
		new NameHintsModal(this.app, {
			loadContent: async () => {
				const res = await requestUrl({
					url: `${this.apiBase()}/v1/name-hints`,
					method: "GET",
					headers: { "X-API-Key": this.settings.apiKey },
				});
				return asString(asRecord(res.json).content, NAME_HINTS_INTRO);
			},
			saveContent: async (content) => {
				await requestUrl({
					url: `${this.apiBase()}/v1/name-hints`,
					method: "POST",
					contentType: "application/json",
					headers: { "X-API-Key": this.settings.apiKey },
					body: JSON.stringify({ content }),
				});
			},
		}).open();
	}

	openBrandHintsTable(): void {
		new BrandHintsModal(this.app, {
			loadContent: async () => {
				const res = await requestUrl({
					url: `${this.apiBase()}/v1/brand-hints`,
					method: "GET",
					headers: { "X-API-Key": this.settings.apiKey },
				});
				return asString(asRecord(res.json).content, BRAND_HINTS_INTRO);
			},
			saveContent: async (content) => {
				await requestUrl({
					url: `${this.apiBase()}/v1/brand-hints`,
					method: "POST",
					contentType: "application/json",
					headers: { "X-API-Key": this.settings.apiKey },
					body: JSON.stringify({ content }),
				});
			},
		}).open();
	}

	openClarifyQueueTable(): void {
		new ClarifyQueueModal(this.app, {
			loadContent: async () => {
				const res = await requestUrl({
					url: `${this.apiBase()}/v1/clarify-queue`,
					method: "GET",
					headers: { "X-API-Key": this.settings.apiKey },
				});
				return asString(asRecord(res.json).content, CLARIFY_INTRO);
			},
			saveContent: async (content) => {
				await requestUrl({
					url: `${this.apiBase()}/v1/clarify-queue`,
					method: "POST",
					contentType: "application/json",
					headers: { "X-API-Key": this.settings.apiKey },
					body: JSON.stringify({ content }),
				});
			},
			confirmClarify: async (heard, canon) => {
				await this.confirmClarifyItem(heard, canon);
			},
		}).open();
	}

	openVoiceCalibrationTable(): void {
		new VoiceCalibrationModal(this.app, {
			loadContent: async () => {
				const res = await requestUrl({
					url: `${this.apiBase()}/v1/calibration`,
					method: "GET",
					headers: { "X-API-Key": this.settings.apiKey },
				});
				return asString(asRecord(res.json).content, CALIBRATION_INTRO);
			},
			saveContent: async (content) => this.pushCalibration(true, content),
			fetchClips: async () => this.fetchCalibrationClips(),
			playClip: async (voiceId) => this.playCalibrationClip(voiceId),
			applyVoiceNamesToNotes: async (renames) => this.applyVoiceNamesToNotes(renames),
		}).open();
	}

	/** Replace voice_* / SPEAKER_xx tags in meeting notes with real names after calibration. */
	async applyVoiceNamesToNotes(renames: Record<string, string>): Promise<number> {
		const entries = Object.entries(renames).filter(
			([id, name]) => id && name && !/^неизвестный$/i.test(name.trim()),
		);
		if (!entries.length) {
			return 0;
		}
		const notesFolder =
			this.app.vault.getAbstractFileByPath(MEETINGS_DIR) ??
			this.app.vault.getAbstractFileByPath("Notes");
		if (!notesFolder || !("children" in notesFolder)) {
			return 0;
		}
		const children = (notesFolder as { children?: TAbstractFile[] }).children || [];
		let updated = 0;
		for (const child of children) {
			if (!(child instanceof TFile) || !child.path.endsWith(".md")) {
				continue;
			}
			let text = await this.app.vault.read(child);
			let changed = false;
			for (const [voiceId, rawName] of entries) {
				const name = rawName.trim();
				if (!text.includes(voiceId)) {
					continue;
				}
				const escaped = voiceId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
				const next = text
					.replace(new RegExp(`\\[\\[${escaped}\\]\\]`, "g"), `[[${name}]]`)
					.replace(new RegExp(`\\[${escaped}\\]`, "g"), `[${name}]`)
					.replace(new RegExp(`\\*\\*${escaped}\\*\\*`, "g"), `**${name}**`);
				if (next !== text) {
					text = next;
					changed = true;
				}
			}
			if (changed) {
				await this.app.vault.modify(child, text);
				updated += 1;
			}
		}
		return updated;
	}


	async pushUserSettings(): Promise<void> {
		if (!this.settings.apiKey) {
			return;
		}
		try {
			await this.ensureTimezone();
			const res = await requestUrl({
				url: `${this.apiBase()}/v1/me/settings`,
				method: "POST",
				contentType: "application/json",
				headers: { "X-API-Key": this.settings.apiKey },
				body: JSON.stringify({
					speech_language: this.settings.speechLanguage || "auto",
					timezone: this.settings.timezone || "UTC",
					write_targets: normalizeWriteTargets(this.settings.writeTargets),
				}),
			});
			this.entitlement = asRecord(res.json);
			const lang = normalizeSpeechLanguage(this.entitlement?.speech_language);
			if (this.entitlement?.speech_language) {
				this.settings.speechLanguage = lang;
			}
			const tz = asString(this.entitlement?.timezone).trim();
			if (tz) {
				this.settings.timezone = tz;
			}
			if (this.entitlement?.write_targets) {
				this.settings.writeTargets = normalizeWriteTargets(this.entitlement.write_targets);
			}
			await this.saveSettings();
		} catch (err) {
			console.warn("Enot: settings push failed", err);
		}
	}

	async startRecording(): Promise<void> {
		if (!this.settings.apiKey) {
			new Notice("Enot: no API key. Open settings and press Register.");
			return;
		}
		if (this.mediaRecorder?.state === "recording") {
			return;
		}
		if (!(await this.ensureCaptureAllowed())) {
			return;
		}
		if (!navigator.mediaDevices?.getUserMedia) {
			new Notice("Enot: microphone not available in this Obsidian build.");
			return;
		}
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			this.mediaStream = stream;
			this.mediaChunks = [];
			const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
				? "audio/webm;codecs=opus"
				: MediaRecorder.isTypeSupported("audio/webm")
					? "audio/webm"
					: "";
			const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
			this.mediaRecorder = recorder;
			recorder.ondataavailable = (ev) => {
				if (ev.data.size > 0) {
					this.mediaChunks.push(ev.data);
				}
			};
			recorder.onerror = () => {
				new Notice("Enot: recording failed");
				this.teardownRecorder(false);
			};
			recorder.start(1000);
			this.mountRecordPanel(stream);
		} catch (err) {
			this.teardownRecorder(false);
			new Notice(`Enot: mic permission denied - ${errMessage(err)}`, 8000);
		}
	}

	async stopRecordingAndUpload(): Promise<void> {
		const recorder = this.mediaRecorder;
		if (!recorder || recorder.state === "inactive") {
			this.teardownRecorder(false);
			return;
		}
		const recordedSec =
			this.recordStartedAt > 0 ? Math.max(0, (Date.now() - this.recordStartedAt) / 1000) : null;
		const blob = await new Promise<Blob>((resolve, reject) => {
			recorder.onstop = () => {
				resolve(new Blob(this.mediaChunks, { type: recorder.mimeType || "audio/webm" }));
			};
			recorder.onerror = () => reject(new Error("recorder error"));
			try {
				recorder.stop();
			} catch (err) {
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		}).catch((err) => {
			new Notice(`Enot: stop failed - ${errMessage(err)}`);
			return null;
		});
		this.teardownRecorder(false);
		if (!blob || blob.size < 256) {
			new Notice("Enot: recording empty");
			return;
		}
		if (!(await this.ensureCaptureAllowed(recordedSec))) {
			return;
		}
		const ext = blob.type.includes("mp4") || blob.type.includes("m4a") ? "m4a" : "webm";
		const file = new File([blob], `enot-record-${Date.now()}.${ext}`, {
			type: blob.type || "audio/webm",
		});
		await this.uploadMediaFile(file, recordedSec);
	}

	private mountRecordPanel(stream: MediaStream): void {
		this.unmountRecordPanel();
		const panel = document.createElement("div");
		panel.className = "enot-recorder";
		panel.setAttribute("role", "dialog");
		panel.setAttribute("aria-label", "Enot voice recorder");

		const head = panel.createDiv({ cls: "enot-recorder__head" });
		const titles = head.createDiv({ cls: "enot-recorder__titles" });
		titles.createDiv({ cls: "enot-recorder__brand", text: "Enot" });
		titles.createDiv({ cls: "enot-recorder__sub", text: "Voice recorder" });
		const live = head.createDiv({ cls: "enot-recorder__live" });
		live.createSpan({ cls: "enot-recorder__live-dot" });
		live.createSpan({ text: "LIVE" });

		this.recordTimerEl = panel.createDiv({ cls: "enot-recorder__timer", text: "00:00" });

		const waveWrap = panel.createDiv({ cls: "enot-recorder__wave" });
		const canvas = waveWrap.createEl("canvas", { cls: "enot-recorder__canvas" });
		canvas.width = 320;
		canvas.height = 64;
		this.recordWaveCanvas = canvas;

		const actions = panel.createDiv({ cls: "enot-recorder__actions" });
		const stopBtn = actions.createEl("button", {
			cls: "enot-recorder__stop",
			text: "Stop & send",
		});
		stopBtn.type = "button";
		stopBtn.addEventListener("click", () => {
			void this.stopRecordingAndUpload();
		});

		document.body.appendChild(panel);
		this.recordPanel = panel;
		this.recordStartedAt = Date.now();
		this.recordTimerId = window.setInterval(() => this.tickRecordTimer(), 250);
		this.startWaveform(stream);
	}

	private tickRecordTimer(): void {
		if (!this.recordTimerEl) {
			return;
		}
		const sec = Math.max(0, Math.floor((Date.now() - this.recordStartedAt) / 1000));
		const mm = String(Math.floor(sec / 60)).padStart(2, "0");
		const ss = String(sec % 60).padStart(2, "0");
		this.recordTimerEl.setText(`${mm}:${ss}`);
	}

	private startWaveform(stream: MediaStream): void {
		try {
			const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
			const ctx = new Ctx();
			const source = ctx.createMediaStreamSource(stream);
			const analyser = ctx.createAnalyser();
			analyser.fftSize = 256;
			analyser.smoothingTimeConstant = 0.75;
			source.connect(analyser);
			this.audioCtx = ctx;
			this.analyser = analyser;
			const data = new Uint8Array(analyser.frequencyBinCount);
			const paint = () => {
				const canvas = this.recordWaveCanvas;
				const a = this.analyser;
				if (!canvas || !a) {
					return;
				}
				a.getByteFrequencyData(data);
				const g = canvas.getContext("2d");
				if (!g) {
					return;
				}
				const { width: w, height: h } = canvas;
				g.clearRect(0, 0, w, h);
				const barColor =
					getComputedStyle(canvas).getPropertyValue("--text-normal").trim() || "#2a2a2a";
				g.fillStyle = barColor;
				const bars = 42;
				const gap = 2;
				const barW = Math.max(2, (w - gap * (bars - 1)) / bars);
				const mid = h / 2;
				for (let i = 0; i < bars; i++) {
					const idx = Math.floor((i / bars) * data.length * 0.7);
					const v = (data[idx] ?? 0) / 255;
					const bh = Math.max(4, v * (h - 8));
					const x = i * (barW + gap);
					const r = Math.min(2, barW / 2);
					const y = mid - bh / 2;
					g.beginPath();
					g.moveTo(x + r, y);
					g.arcTo(x + barW, y, x + barW, y + bh, r);
					g.arcTo(x + barW, y + bh, x, y + bh, r);
					g.arcTo(x, y + bh, x, y, r);
					g.arcTo(x, y, x + barW, y, r);
					g.closePath();
					g.fill();
				}
				this.recordRaf = window.requestAnimationFrame(paint);
			};
			this.recordRaf = window.requestAnimationFrame(paint);
		} catch (err) {
			console.warn("Enot: waveform unavailable", err);
		}
	}

	private unmountRecordPanel(): void {
		if (this.recordRaf) {
			window.cancelAnimationFrame(this.recordRaf);
			this.recordRaf = 0;
		}
		if (this.recordTimerId != null) {
			window.clearInterval(this.recordTimerId);
			this.recordTimerId = null;
		}
		if (this.audioCtx) {
			void this.audioCtx.close().catch(() => undefined);
			this.audioCtx = null;
		}
		this.analyser = null;
		this.recordWaveCanvas = null;
		this.recordTimerEl = null;
		this.recordPanel?.remove();
		this.recordPanel = null;
	}

	private teardownRecorder(_keepNotice: boolean): void {
		try {
			if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
				this.mediaRecorder.onstop = null;
				this.mediaRecorder.stop();
			}
		} catch {
			/* ignore */
		}
		this.mediaRecorder = null;
		this.mediaChunks = [];
		if (this.mediaStream) {
			for (const track of this.mediaStream.getTracks()) {
				track.stop();
			}
			this.mediaStream = null;
		}
		this.unmountRecordPanel();
	}

	async pickAndUploadMedia(): Promise<void> {
		if (!this.settings.apiKey) {
			new Notice("Enot: no API key. Open settings and press Register.");
			return;
		}
		const input = createEl("input", {
			cls: "enot-file-input",
			type: "file",
			attr: {
				accept: "audio/*,video/*,.m4a,.mp3,.wav,.ogg,.mp4,.mov,.webm,.mkv",
			},
		});
		document.body.appendChild(input);
		input.onchange = () => {
			const file = input.files?.[0];
			input.remove();
			if (!file) {
				return;
			}
			void this.uploadMediaFile(file);
		};
		input.click();
	}

	async uploadMediaFile(file: File, knownDurationSec?: number | null): Promise<void> {
		if (!this.settings.apiKey) {
			new Notice("Enot: no API key");
			return;
		}
		const maxMb = 200;
		if (file.size > maxMb * 1024 * 1024) {
			new Notice(`Enot: file exceeds ${maxMb} MB`);
			return;
		}
		let durationSec = knownDurationSec != null && knownDurationSec > 0 ? knownDurationSec : null;
		if (durationSec == null) {
			durationSec = await probeMediaDurationSeconds(file);
		}
		if (!(await this.ensureCaptureAllowed(durationSec))) {
			return;
		}
		new Notice(`Enot: uploading ${file.name}…`);
		try {
			const buf = await file.arrayBuffer();
			const res = await requestUrl({
				url: `${this.apiBase()}/v1/process-audio`,
				method: "POST",
				headers: {
					"X-API-Key": this.settings.apiKey,
					"X-Filename": file.name,
					"Content-Type": file.type || "application/octet-stream",
				},
				body: buf,
				throw: false,
			});
			if (res.status === 413) {
				new Notice("Enot: file too large for server");
				return;
			}
			if (res.status === 415 || res.status === 422) {
				const detail = asString(asRecord(res.json).detail, res.text || "unsupported file");
				new Notice(`Enot: ${detail}`, 8000);
				return;
			}
			const body = asRecord(res.json);
			if (this.handleProcessGateResponse(body)) {
				return;
			}
			if (res.status >= 400) {
				const msg =
					asString(body.message) || asString(body.error) || asString(body.detail) || `HTTP ${res.status}`;
				new Notice(`Enot: upload failed - ${msg}`, 8000);
				return;
			}
			const jobId = asString(body.job_id);
			new Notice(
				jobId ? `Enot: accepted (${jobId.slice(0, 12)}…). Note will appear in inbox.` : "Enot: accepted.",
				6000,
			);
			void this.syncFromServer(false);
		} catch (err) {
			new Notice(`Enot: upload failed - ${errMessage(err)}`, 8000);
		}
	}

	private async mergePeopleIntoNameHints(people: string[]): Promise<void> {
		if (!people.length || !this.settings.apiKey) {
			return;
		}
		try {
			const res = await requestUrl({
				url: `${this.apiBase()}/v1/name-hints`,
				method: "GET",
				headers: { "X-API-Key": this.settings.apiKey },
			});
			const current = asString(asRecord(res.json).content, NAME_HINTS_INTRO);
			const { text, added } = appendPeopleToNameHints(current, people);
			if (!added) {
				return;
			}
			await requestUrl({
				url: `${this.apiBase()}/v1/name-hints`,
				method: "POST",
				contentType: "application/json",
				headers: { "X-API-Key": this.settings.apiKey },
				body: JSON.stringify({ content: text }),
			});
		} catch (err) {
			console.warn("Enot: merge people into name hints failed", err);
		}
	}


	private async writeMarkdown(path: string, content: string): Promise<void> {
		await this.ensureParentFolders(path);
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, content);
			return;
		}
		try {
			await this.app.vault.create(path, content);
		} catch {
			const again = this.app.vault.getAbstractFileByPath(path);
			if (again instanceof TFile) {
				await this.app.vault.modify(again, content);
				return;
			}
			await this.app.vault.adapter.write(path, content);
		}
	}

	async expandGraph(file: TAbstractFile): Promise<void> {
		if (!(file instanceof TFile) || !file.path.endsWith(".md")) {
			return;
		}
		if (
			file.path.startsWith(`${PEOPLE_DIR}/`) ||
			file.path.startsWith(`${TOPICS_DIR}/`) ||
			file.path.startsWith(`${PROJECTS_DIR}/`)
		) {
			return;
		}
		const markdown = await this.app.vault.read(file);
		const front = parseFrontmatter(markdown);
		if (!isEnotCapture(front)) {
			return;
		}
		const sourceTitle = file.basename;
		const people = parseYamlList(front, "people");
		const topics = parseYamlList(front, "topics");
		const project = parseYamlScalar(front, "project");
		const targets = normalizeWriteTargets(this.settings.writeTargets);
		for (const name of people) {
			if (targets.people) {
				await this.upsertStub(PEOPLE_DIR, "person", name, sourceTitle);
			}
		}
		for (const name of topics) {
			if (targets.topics) {
				await this.upsertStub(TOPICS_DIR, "topic", name, sourceTitle);
			}
		}
		if (project && targets.projects) {
			await this.upsertStub(PROJECTS_DIR, "project", project, sourceTitle);
		}
		if (people.length) {
			await this.mergePeopleIntoNameHints(people);
		}
	}

	async upsertStub(
		folder: string,
		kind: "person" | "topic" | "project",
		name: string,
		sourceTitle: string,
	): Promise<void> {
		if (!name) {
			return;
		}
		const path = `${folder}/${name}.md`;
		const existing = this.app.vault.getAbstractFileByPath(path);
		const link = backlinkLine(sourceTitle);
		if (existing instanceof TFile) {
			const current = await this.app.vault.read(existing);
			if (!current.includes(`[[${sourceTitle}]]`)) {
				await this.app.vault.modify(existing, `${current.trimEnd()}\n${link}\n`);
			}
			return;
		}
		await this.ensureParentFolders(path);
		await this.app.vault.create(path, stubNote(kind, name, sourceTitle, uiLang(this.settings)));
	}
}

class EnotSettingTab extends PluginSettingTab {
	plugin: EnotPlugin;

	constructor(app: App, plugin: EnotPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const L = uiLang(this.plugin.settings);
		new Setting(containerEl).setName(t(L, "settings.account")).setHeading();
		containerEl.createEl("p", {
			text: t(L, "settings.intro"),
		});

		const access = this.plugin.entitlement?.access || "unknown";
		const days = this.plugin.entitlement?.days_left ?? "-";
		const planLabel = this.plugin.entitlement?.plan_label || this.plugin.entitlement?.plan || "";
		const hoursSoft = this.plugin.entitlement?.hours_soft;
		const hoursHard = this.plugin.entitlement?.hours_hard;
		const hoursUsed = this.plugin.entitlement?.hours_used ?? 0;
		const hoursLevel = this.plugin.entitlement?.hours_level || "ok";
		const ceiling =
			this.plugin.entitlement?.hours_limit ?? hoursHard ?? hoursSoft;
		let accessDesc = t(L, "access.trial", { days: String(days), hours: "" });
		let hoursCls = "enot-hours-ok";
		if (access === "expired") {
			accessDesc = t(L, "access.expired");
			hoursCls = "enot-hours-hard";
		} else if (access === "trial") {
			const hoursBit =
				ceiling != null
					? t(L, "access.hours_trial", {
							used: hoursUsed.toFixed(2),
							ceiling: String(ceiling),
						})
					: "";
			accessDesc = t(L, "access.trial", { days: String(days), hours: hoursBit });
			if (hoursLevel === "warn") hoursCls = "enot-hours-warn";
			else if (hoursLevel === "soft") hoursCls = "enot-hours-soft";
			else if (hoursLevel === "hard") hoursCls = "enot-hours-hard";
		} else if (access === "paid") {
			const hoursBit =
				ceiling != null
					? t(L, "access.hours_paid", {
							used: hoursUsed.toFixed(2),
							ceiling: String(ceiling),
						})
					: "";
			accessDesc = t(L, "access.paid", { plan: planLabel || "paid", hours: hoursBit });
			if (hoursLevel === "warn") hoursCls = "enot-hours-warn";
			else if (hoursLevel === "soft") hoursCls = "enot-hours-soft";
			else if (hoursLevel === "hard") hoursCls = "enot-hours-hard";
		}

		const accessSetting = new Setting(containerEl)
			.setName(t(L, "settings.access"))
			.setDesc(accessDesc)
			.addButton((btn) =>
				btn.setButtonText(t(L, "settings.refresh")).onClick(async () => {
					try {
						await this.plugin.refreshEntitlement();
						this.display();
					} catch (err) {
						new Notice(t(L, "settings.refresh_fail"));
						console.error(err);
					}
				}),
			);
		accessSetting.descEl.addClass(hoursCls);

		if (this.plugin.entitlement?.subscription_notice) {
			containerEl.createEl("p", {
				text: this.plugin.entitlement.subscription_notice,
				cls: "setting-item-description",
			});
		}

		new Setting(containerEl)
			.setName(t(L, "settings.plans"))
			.setDesc(t(L, "settings.plans_desc"))
			.addButton((btn) =>
				btn
					.setButtonText(t(L, "settings.upgrade"))
					.setCta()
					.onClick(() => this.plugin.openPlansModal()),
			);

		if (this.plugin.entitlement?.manage_url) {
			new Setting(containerEl)
				.setName(t(L, "settings.whop"))
				.setDesc(t(L, "settings.whop_desc"))
				.addButton((btn) =>
					btn
						.setButtonText(t(L, "settings.manage"))
						.onClick(() => this.plugin.openManageBilling()),
				);
		}

		if (!this.plugin.settings.apiKey) {
			new Setting(containerEl)
				.setName(t(L, "settings.account"))
				.setDesc(t(L, "settings.register_desc"))
				.addButton((btn) =>
					btn.setButtonText(t(L, "settings.register")).setCta().onClick(async () => {
						try {
							await this.plugin.ensureOnboardedAndRegistered();
							await this.plugin.refreshEntitlement();
							new Notice(t(uiLang(this.plugin.settings), "notice.key_received"));
							this.display();
						} catch (err) {
							if (String(err).includes("tos_cancelled")) {
								return;
							}
							new Notice(t(uiLang(this.plugin.settings), "notice.register_fail"));
							console.error(err);
						}
					}),
				);
		} else {
			new Setting(containerEl)
				.setName(t(L, "settings.danger"))
				.setDesc(t(L, "settings.danger_desc"))
				.addButton((btn) =>
					btn
						.setButtonText(t(L, "settings.delete_account"))
						.setWarning()
						.onClick(async () => {
							await this.plugin.promptDeleteAccount();
							this.display();
						}),
				);
		}

		new Setting(containerEl)
			.setName(t(L, "settings.base_language"))
			.setDesc(t(L, "settings.base_language_desc"))
			.addDropdown((dd) => {
				for (const { code, label } of BASE_LANGUAGES) {
					dd.addOption(code, label);
				}
				dd.setValue(normalizeBaseLanguage(this.plugin.settings.baseLanguage)).onChange(
					async (value) => {
						this.plugin.settings.baseLanguage = normalizeBaseLanguage(value);
						this.plugin.settings.onboarded = true;
						await this.plugin.saveSettings();
						this.display();
					},
				);
			});

		new Setting(containerEl)
			.setName(t(L, "settings.speech"))
			.setDesc(t(L, "settings.speech_desc"))
			.addDropdown((dd) => {
				for (const { code, label } of SPEECH_LANGUAGES) {
					dd.addOption(code, label);
				}
				dd.setValue(normalizeSpeechLanguage(this.plugin.settings.speechLanguage)).onChange(
					async (value) => {
						const lang = normalizeSpeechLanguage(value);
						this.plugin.settings.speechLanguage = lang;
						await this.plugin.saveSettings();
						await this.plugin.pushUserSettings();
						new Notice(`Enot: speech language → ${lang}`);
					},
				);
			});

		new Setting(containerEl)
			.setName(t(L, "settings.write_folders"))
			.setDesc("Which PARA folders Enot may fill (00 Inbox → 11 Agreements). Opens a checklist.")
			.addButton((btn) =>
				btn.setButtonText("Open").setCta().onClick(() => {
					this.plugin.openWriteTargetsModal();
				}),
			);

		new Setting(containerEl)
			.setName(t(L, "settings.name_hints"))
			.setDesc("People names for transcript correction and LLM. Known voices still hint Whisper.")
			.addButton((btn) =>
				btn.setButtonText("Open").setCta().onClick(() => {
					this.plugin.openNameHintsTable();
				}),
			);

		new Setting(containerEl)
			.setName(t(L, "settings.brand_hints"))
			.setDesc("Products/brands + ASR aliases (DDX | дэдэикс). Correction + LLM only - not Whisper dump.")
			.addButton((btn) =>
				btn.setButtonText("Open").setCta().onClick(() => {
					this.plugin.openBrandHintsTable();
				}),
			);

		new Setting(containerEl)
			.setName(t(L, "settings.clarify"))
			.setDesc("Heard → canon queue from past notes. Confirm rows to teach ASR.")
			.addButton((btn) =>
				btn.setButtonText("Open").setCta().onClick(() => {
					this.plugin.openClarifyQueueTable();
				}),
			);

		new Setting(containerEl)
			.setName(t(L, "settings.voices"))
			.setDesc("Name unknown speakers; clips play from the server.")
			.addButton((btn) =>
				btn.setButtonText("Open").setCta().onClick(() => {
					this.plugin.openVoiceCalibrationTable();
				}),
			);

		new Setting(containerEl)
			.setName(t(L, "settings.timezone"))
			.setDesc(`Local timezone for note folders and upload time (${this.plugin.settings.timezone || "detecting…"}).`)
			.addButton((btn) =>
				btn.setButtonText("Refresh").onClick(async () => {
					this.plugin.settings.timezone = "";
					await this.plugin.ensureTimezone();
					await this.plugin.pushUserSettings();
					new Notice(`Enot: timezone → ${this.plugin.settings.timezone}`);
					this.display();
				}),
			);

		new Setting(containerEl)
			.setName(t(L, "settings.install_id"))
			.setDesc("Stable install id. Reinstalling on the same vault returns the same key.")
			.addText((text) => text.setValue(this.plugin.settings.installId).setDisabled(true));

		new Setting(containerEl)
			.setName(t(L, "settings.api_key"))
			.setDesc("Sent as X-API-Key. Download a personal Shortcut below - key is baked in.")
			.addText((text) => {
				text.inputEl.addClass("enot-key");
				text.setValue(this.plugin.settings.apiKey).setDisabled(true);
			})
			.addButton((btn) =>
				btn.setButtonText("Copy").onClick(async () => {
					await navigator.clipboard.writeText(this.plugin.settings.apiKey);
					new Notice("Key copied");
				}),
			);
	}
}
