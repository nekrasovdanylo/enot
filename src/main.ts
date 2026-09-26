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
	MEETINGS_DIR,
	PEOPLE_DIR,
	PROJECTS_DIR,
	TOPICS_DIR,
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
import {
	BrandHintsModal,
	ClarifyQueueModal,
	NameHintsModal,
	VoiceCalibrationModal,
	WriteTargetsModal,
	NAME_HINTS_INTRO,
	BRAND_HINTS_INTRO,
	CLARIFY_INTRO,
	CALIBRATION_INTRO,
} from "./tables";

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
	timezone: string;
	writeTargets: WriteTargets;
}

interface Entitlement {
	access?: string;
	days_left?: number;
	checkout_url?: string;
	checkout_urls?: Record<string, string>;
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

function uiLang(settings: { speechLanguage: string }): "ru" | "en" {
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
			name: "Open checkout",
			callback: () => this.openCheckout(),
		});
		this.addCommand({
			id: "pull-inbox",
			name: "Fetch notes",
			callback: async () => {
				await this.syncFromServer(true);
			},
		});
		this.addCommand({
			id: "download-shortcut-phone",
			name: "Download capture shortcut (iPhone)",
			callback: async () => {
				await this.downloadShortcut("phone");
			},
		});
		this.addCommand({
			id: "download-shortcut-mac",
			name: "Download capture shortcut (Mac)",
			callback: async () => {
				await this.downloadShortcut("mac");
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
			await this.ensureRegistered();
			await this.refreshEntitlement();
			await this.ensureTimezone();
			await this.pushUserSettings();
		} catch (err) {
			console.error("Enot register failed", err);
			new Notice("Enot: could not register. Try again or check your connection.");
		}
	}

	private async onVaultModify(file: TAbstractFile): Promise<void> {
		await this.expandGraph(file);
	}

	async loadSettings(): Promise<void> {
		const raw = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()) as EnotSettings;
		raw.writeTargets = normalizeWriteTargets(raw.writeTargets);
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
		const res = await requestUrl({
			url: `${this.apiBase()}/v1/register`,
			method: "POST",
			contentType: "application/json",
			body: JSON.stringify({ install_id: this.settings.installId }),
		});
		const body = asRecord(res.json);
		this.settings.apiKey = asString(body.api_key);
		this.settings.userId = asString(body.user_id);
		this.settings.installId = asString(body.install_id, this.settings.installId);
		this.settings.endpoint = asString(body.endpoint, this.apiBase());
		await this.saveSettings();
	}

	async refreshEntitlement(): Promise<void> {
		if (!this.settings.apiKey) {
			return;
		}
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
		if (this.entitlement?.subscription_notice) {
			new Notice(`Enot: ${this.entitlement.subscription_notice}`, 12000);
		}
		if (this.entitlement?.access === "expired") {
			new Notice(
				"Your free week is over. Open the Enot checkout command to continue.",
				0,
			);
		} else if (this.entitlement?.access === "trial") {
			new Notice(`Enot: ${this.entitlement.days_left} trial day(s) left`);
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

	openCheckout(planKey?: string): void {
		const urls = this.entitlement?.checkout_urls || {};
		const url =
			(planKey && urls[planKey]) ||
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
				await requestUrl({
					url: `${this.apiBase()}/v1/inbox/${jobId}/ack`,
					method: "POST",
					headers: { "X-API-Key": this.settings.apiKey },
				});
				saved += 1;
				new Notice(`Enot: saved ${path}`);
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
		const ext = blob.type.includes("mp4") || blob.type.includes("m4a") ? "m4a" : "webm";
		const file = new File([blob], `enot-record-${Date.now()}.${ext}`, {
			type: blob.type || "audio/webm",
		});
		await this.uploadMediaFile(file);
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

	async uploadMediaFile(file: File): Promise<void> {
		if (!this.settings.apiKey) {
			new Notice("Enot: no API key");
			return;
		}
		const maxMb = 200;
		if (file.size > maxMb * 1024 * 1024) {
			new Notice(`Enot: file exceeds ${maxMb} MB`);
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
			if (res.status >= 400) {
				const body = asRecord(res.json);
				const msg =
					asString(body.message) || asString(body.error) || asString(body.detail) || `HTTP ${res.status}`;
				new Notice(`Enot: upload failed - ${msg}`, 8000);
				return;
			}
			const jobId = asString(asRecord(res.json).job_id);
			new Notice(
				jobId ? `Enot: accepted (${jobId.slice(0, 12)}…). Note will appear in inbox.` : "Enot: accepted.",
				6000,
			);
			void this.syncFromServer(false);
		} catch (err) {
			new Notice(`Enot: upload failed - ${errMessage(err)}`, 8000);
		}
	}

	async downloadShortcut(variant: "phone" | "mac"): Promise<void> {
		if (!this.settings.apiKey) {
			new Notice("Enot: no API key");
			return;
		}
		try {
			const res = await requestUrl({
				url: `${this.apiBase()}/v1/me/shortcut?variant=${variant}`,
				method: "GET",
				headers: { "X-API-Key": this.settings.apiKey },
			});
			const bytes = res.arrayBuffer;
			const name =
				variant === "phone" ? "Enot Capture iPhone.shortcut" : "Enot Capture Mac.shortcut";
			// Desktop: write to user Downloads via Node fs when available
			const nodeRequire = (window as unknown as { require?: (m: string) => unknown }).require;
			const fs = nodeRequire?.("fs") as
				| { writeFileSync: (path: string, data: Uint8Array) => void }
				| undefined;
			const os = nodeRequire?.("os") as { homedir: () => string } | undefined;
			const pathMod = nodeRequire?.("path") as { join: (...parts: string[]) => string } | undefined;
			if (fs && os && pathMod) {
				const dest = pathMod.join(os.homedir(), "Downloads", name);
				fs.writeFileSync(dest, new Uint8Array(bytes));
				new Notice(
					`Enot: saved ${dest}. Open it in Shortcuts (allow Untrusted Shortcuts once).`,
					10000,
				);
				return;
			}
			// Fallback: copy base64 notice
			const b64 = btoa(String.fromCharCode(...new Uint8Array(bytes)));
			await navigator.clipboard.writeText(b64);
			new Notice("Enot: shortcut bytes copied as base64 - use desktop Obsidian to save the file.", 8000);
		} catch (err) {
			console.error(err);
			new Notice(`Enot: shortcut download failed - ${errMessage(err)}`);
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
		new Setting(containerEl).setName("Account").setHeading();
		containerEl.createEl("p", {
			text: "Tap the raccoon to record or upload. This plugin pulls finished notes into PARA folders and optional People / Topics / Projects stubs.",
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
		let accessDesc = `Trial: ${days} day(s) left.`;
		let hoursCls = "enot-hours-ok";
		if (access === "expired") {
			accessDesc = "Trial ended. Voice notes pause until you subscribe.";
			hoursCls = "enot-hours-hard";
		} else if (access === "paid") {
			const hoursBit =
				ceiling != null ? ` · ${hoursUsed.toFixed(2)} / ${ceiling} h this month` : "";
			accessDesc = `Plan: ${planLabel || "paid"}${hoursBit}.`;
			if (hoursLevel === "warn") hoursCls = "enot-hours-warn";
			else if (hoursLevel === "soft") hoursCls = "enot-hours-soft";
			else if (hoursLevel === "hard") hoursCls = "enot-hours-hard";
		}

		const accessSetting = new Setting(containerEl)
			.setName("Access")
			.setDesc(accessDesc)
			.addButton((btn) =>
				btn.setButtonText("Refresh status").onClick(async () => {
					try {
						await this.plugin.refreshEntitlement();
						this.display();
					} catch (err) {
						new Notice("Could not refresh access");
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
			.setName("Plans")
			.setDesc("Upgrade or change plan. Old Whop membership is canceled at period end (no hour summing).")
			.addButton((btn) =>
				btn.setButtonText("Lite $9").onClick(() => this.plugin.openCheckout("lite")),
			)
			.addButton((btn) =>
				btn.setButtonText("Plus $29").setCta().onClick(() => this.plugin.openCheckout("plus")),
			)
			.addButton((btn) =>
				btn.setButtonText("Pro $79").onClick(() => this.plugin.openCheckout("pro")),
			);

		if (this.plugin.entitlement?.manage_url) {
			new Setting(containerEl)
				.setName("Whop billing")
				.setDesc("Cancel or manage the active membership in Whop.")
				.addButton((btn) =>
					btn.setButtonText("Manage subscription").onClick(() => this.plugin.openManageBilling()),
				);
		}

		if (!this.plugin.settings.apiKey) {
			new Setting(containerEl)
				.setName("Account")
				.setDesc("Connect this vault to Enot to get your API key.")
				.addButton((btn) =>
					btn.setButtonText("Register").setCta().onClick(async () => {
						try {
							await this.plugin.ensureRegistered();
							await this.plugin.refreshEntitlement();
							new Notice("Enot: key received");
							this.display();
						} catch (err) {
							new Notice("Enot: registration failed");
							console.error(err);
						}
					}),
				);
		}

		new Setting(containerEl)
			.setName("Speech language")
			.setDesc("Pinned language for Whisper and note labels (auto = detect per recording). Saved to your account.")
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
			.setName("Write folders")
			.setDesc("Which PARA folders Enot may fill (00 Inbox → 10 Topics). Opens a checklist.")
			.addButton((btn) =>
				btn.setButtonText("Open").setCta().onClick(() => {
					this.plugin.openWriteTargetsModal();
				}),
			);

		new Setting(containerEl)
			.setName("Name hints")
			.setDesc("People names for transcript correction and LLM. Known voices still hint Whisper.")
			.addButton((btn) =>
				btn.setButtonText("Open").setCta().onClick(() => {
					this.plugin.openNameHintsTable();
				}),
			);

		new Setting(containerEl)
			.setName("Brand hints")
			.setDesc("Products/brands + ASR aliases (DDX | дэдэикс). Correction + LLM only - not Whisper dump.")
			.addButton((btn) =>
				btn.setButtonText("Open").setCta().onClick(() => {
					this.plugin.openBrandHintsTable();
				}),
			);

		new Setting(containerEl)
			.setName("Clarify queue")
			.setDesc("Doubtful ASR tokens. Confirm a canon to teach future decoding.")
			.addButton((btn) =>
				btn.setButtonText("Open").setCta().onClick(() => {
					this.plugin.openClarifyQueueTable();
				}),
			);

		new Setting(containerEl)
			.setName("Unknown voices")
			.setDesc("New fingerprints waiting for a name. Open to listen, name, or remove.")
			.addButton((btn) =>
				btn.setButtonText("Open").setCta().onClick(() => {
					this.plugin.openVoiceCalibrationTable();
				}),
			);

		new Setting(containerEl)
			.setName("Capture shortcut")
			.setDesc(
				"Personal Shortcut with your API key inside. iPhone: Record Audio. Mac: pick an audio file. Enable Untrusted Shortcuts once on first import.",
			)
			.addButton((btn) =>
				btn.setButtonText("iPhone").setCta().onClick(async () => {
					await this.plugin.downloadShortcut("phone");
				}),
			)
			.addButton((btn) =>
				btn.setButtonText("Mac").onClick(async () => {
					await this.plugin.downloadShortcut("mac");
				}),
			);

		new Setting(containerEl)
			.setName("Timezone")
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
			.setName("Install ID")
			.setDesc("Stable install id. Reinstalling on the same vault returns the same key.")
			.addText((text) => text.setValue(this.plugin.settings.installId).setDisabled(true));

		new Setting(containerEl)
			.setName("API key")
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
