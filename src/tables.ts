import { App, Modal, Notice, Setting } from "obsidian";
import {
	WRITE_TARGET_META,
	normalizeWriteTargets,
	type WriteTargets,
} from "./graph";

export const NAME_HINTS_FILE = "System/Name_Hints.md";
export const CALIBRATION_FILE = "System/Voice_Calibration.md";
export const BRAND_HINTS_FILE = "System/Brand_Hints.md";
export const CLARIFY_QUEUE_FILE = "System/Clarify_Queue.md";

export const NAME_HINTS_INTRO =
	"# Name Hints\n\n" +
	"Имена и фамилии - по одному в строке. Enot правит опечатки в расшифровке " +
	"и подставляет совпадения в LLM.\n\n";

export const CALIBRATION_INTRO =
	"# Voice Calibration\n\n" +
	"Только новые неизвестные отпечатки. Имена - в Name Hints.\n\n";

export const BRAND_HINTS_INTRO =
	"# Brand Hints\n\n" +
	"Канон и алиасы ASR - по одному в строке:\n" +
	"`- [[DDX]] | дэдэикс, ддх, ddx`\n\n" +
	"Enot подставляет совпадения в LLM и правит расшифровку.\n\n";

export const CLARIFY_INTRO =
	"# Clarify Queue\n\n" +
	"Сомнительные куски ASR. Подтвердите канон - Enot запомнит паттерн.\n\n" +
	"## Pending\n\n";

const CAL_NAME_RE = /\*\*\s*Назначить имя:\s*\*\*\s*\[\[([^\]]+)\]\]/;
const CAL_PHRASE_RE = /\*\*\s*Пример фразы:\s*\*\*\s*\*"([^"]*)"\*/;
const CAL_MEETING_RE = /\*\*\s*Встреча:\s*\*\*\s*\[\[([^\]]+)\]\]/;
const CAL_BLOCK_RE =
	/###[^\n]*Неизвестный голос\s*\(`([^`]+)`\)([\s\S]*?)(?=\n### |\s*$)/g;

export function isUnknownSpeakerName(name: string): boolean {
	const n = name.trim().toLowerCase();
	return !n || n === "неизвестный" || n === "unknown";
}

export function parseNameHintList(text: string): string[] {
	const names: string[] = [];
	const seen = new Set<string>();
	const re = /^[\s>*-]*\s*\[\[([^\]]+)\]\]\s*$/gm;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text || "")) !== null) {
		const label = (m[1] || "").trim();
		const key = label.toLowerCase().replace(/ё/g, "е");
		if (!label || isUnknownSpeakerName(label) || seen.has(key)) {
			continue;
		}
		seen.add(key);
		names.push(label);
	}
	return names;
}

export function serializeNameHints(names: string[]): string {
	const clean: string[] = [];
	const seen = new Set<string>();
	for (const raw of names) {
		const label = (raw || "").trim();
		const key = label.toLowerCase().replace(/ё/g, "е");
		if (!label || isUnknownSpeakerName(label) || seen.has(key)) {
			continue;
		}
		seen.add(key);
		clean.push(label);
	}
	if (!clean.length) {
		return NAME_HINTS_INTRO;
	}
	return `${NAME_HINTS_INTRO.trimEnd()}\n${clean.map((n) => `- [[${n}]]`).join("\n")}\n`;
}

export interface CalibrationRow {
	id: string;
	phrase: string;
	meeting: string;
	name: string;
}

export function parseCalibrationRows(text: string): CalibrationRow[] {
	const rows: CalibrationRow[] = [];
	const re = new RegExp(CAL_BLOCK_RE.source, "g");
	let match: RegExpExecArray | null;
	while ((match = re.exec(text || "")) !== null) {
		const id = (match[1] || "").trim();
		const body = match[2] || "";
		if (!id) {
			continue;
		}
		const name = CAL_NAME_RE.exec(body)?.[1]?.trim() || "Неизвестный";
		const phrase = CAL_PHRASE_RE.exec(body)?.[1]?.trim() || "";
		const meeting = CAL_MEETING_RE.exec(body)?.[1]?.trim() || "";
		rows.push({ id, phrase, meeting, name });
	}
	return rows;
}

export function serializeCalibration(rows: CalibrationRow[]): string {
	if (!rows.length) {
		return CALIBRATION_INTRO;
	}
	let out = CALIBRATION_INTRO;
	for (const row of rows) {
		const name = (row.name || "").trim() || "Неизвестный";
		const phrase = (row.phrase || "").replace(/"/g, "'");
		const meeting = (row.meeting || "").trim() || "Запись";
		out +=
			`### 🎙️ Неизвестный голос (\`${row.id}\`)\n` +
			`* **Встреча:** [[${meeting}]]\n` +
			`* **Пример фразы:** *"${phrase}"*\n` +
			`* **Назначить имя:** [[${name}]]\n\n---\n\n`;
	}
	return out;
}

/** Keep only unnamed voices (after names were synced to the server). */
export function stripNamedCalibrationRows(rows: CalibrationRow[]): CalibrationRow[] {
	return rows.filter((r) => isUnknownSpeakerName(r.name));
}

type ContentStore = {
	loadContent: () => Promise<string>;
	saveContent: (content: string) => Promise<void>;
};

type VoiceSync = {
	loadContent: () => Promise<string>;
	saveContent: (content: string) => Promise<string[]>;
	fetchClips: () => Promise<string[]>;
	playClip: (voiceId: string) => Promise<void>;
	applyVoiceNamesToNotes: (renames: Record<string, string>) => Promise<number>;
};

export class NameHintsModal extends Modal {
	private rows: string[] = [];
	private dirty = false;
	private listEl: HTMLElement | null = null;

	constructor(
		app: App,
		private store: ContentStore,
	) {
		super(app);
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		this.modalEl.addClass("enot-table-modal");
		contentEl.createEl("h2", { text: "Name hints" });
		contentEl.createEl("p", {
			text: "Names for correction + LLM. Synced to your account - nothing written into the vault.",
			cls: "enot-modal-lead",
		});

		this.listEl = contentEl.createDiv({ cls: "enot-name-list" });
		try {
			this.rows = parseNameHintList(await this.store.loadContent());
		} catch {
			this.rows = [];
		}
		this.renderRows();

		const actions = contentEl.createDiv({ cls: "enot-modal-actions" });
		new Setting(actions)
			.addButton((btn) =>
				btn.setButtonText("Add name").onClick(() => {
					this.rows.push("");
					this.dirty = true;
					this.renderRows();
				}),
			)
			.addButton((btn) =>
				btn.setButtonText("Save & sync").setCta().onClick(async () => {
					await this.saveAndSync();
				}),
			)
			.addButton((btn) =>
				btn.setButtonText("Close").onClick(() => this.close()),
			);
	}

	private renderRows(): void {
		if (!this.listEl) {
			return;
		}
		this.listEl.empty();

		if (!this.rows.length) {
			this.listEl.createDiv({
				cls: "enot-table-empty",
				text: "No names yet - add people you often mention.",
			});
		}

		this.rows.forEach((name, index) => {
			const row = this.listEl!.createDiv({ cls: "enot-name-row" });
			const input = row.createEl("input", {
				type: "text",
				cls: "enot-table-input",
				value: name,
				attr: { placeholder: "Данила Некрасов" },
			});
			input.addEventListener("input", () => {
				this.rows[index] = input.value;
				this.dirty = true;
			});
			const del = row.createEl("button", {
				cls: "enot-table-del",
				text: "Remove",
				attr: { type: "button" },
			});
			del.addEventListener("click", () => {
				this.rows.splice(index, 1);
				this.dirty = true;
				this.renderRows();
			});
		});
	}

	private async saveAndSync(): Promise<void> {
		const content = serializeNameHints(this.rows);
		this.rows = parseNameHintList(content);
		try {
			await this.store.saveContent(content);
			this.dirty = false;
			this.renderRows();
			new Notice("Enot: name hints saved");
		} catch (err) {
			console.error(err);
			new Notice("Enot: failed to save name hints");
		}
	}

	onClose(): void {
		if (this.dirty) {
			new Notice("Enot: name hints not synced - open again and Save & sync");
		}
		this.contentEl.empty();
	}
}

export class VoiceCalibrationModal extends Modal {
	private rows: CalibrationRow[] = [];
	private clipIds = new Set<string>();
	private dirty = false;
	private listEl: HTMLElement | null = null;
	private playing: HTMLAudioElement | null = null;

	constructor(
		app: App,
		private syncIO: VoiceSync,
	) {
		super(app);
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		this.modalEl.addClass("enot-table-modal");
		contentEl.createEl("h2", { text: "Unknown voices" });
		contentEl.createEl("p", {
			text: "Name the speaker, then Save & sync. Preview plays a short clip when available.",
			cls: "enot-modal-lead",
		});

		this.listEl = contentEl.createDiv({ cls: "enot-voice-list" });
		try {
			this.rows = parseCalibrationRows(await this.syncIO.loadContent());
		} catch {
			this.rows = [];
		}
		try {
			this.clipIds = new Set(await this.syncIO.fetchClips());
		} catch {
			this.clipIds = new Set();
		}
		this.renderRows();

		const actions = contentEl.createDiv({ cls: "enot-modal-actions" });
		new Setting(actions)
			.addButton((btn) =>
				btn.setButtonText("Save & sync").setCta().onClick(async () => {
					await this.saveAndSync();
				}),
			)
			.addButton((btn) =>
				btn.setButtonText("Close").onClick(() => this.close()),
			);
	}

	private renderRows(): void {
		if (!this.listEl) {
			return;
		}
		this.listEl.empty();

		if (!this.rows.length) {
			this.listEl.createDiv({
				cls: "enot-table-empty",
				text: "No unknown voices right now.",
			});
			return;
		}

		this.rows.forEach((row, index) => {
			const hasClip = this.clipIds.has(row.id);
			const card = this.listEl!.createDiv({
				cls: hasClip ? "enot-voice-card enot-voice-card--clip" : "enot-voice-card",
			});

			const top = card.createDiv({ cls: "enot-voice-card__top" });
			const meta = top.createDiv({ cls: "enot-voice-card__meta" });
			meta.createDiv({
				text: row.meeting || "Untitled recording",
				cls: "enot-voice-card__meeting",
			});
			if (hasClip) {
				meta.createSpan({ text: "Clip", cls: "enot-voice-badge" });
			}

			const actions = top.createDiv({ cls: "enot-voice-card__actions" });
			if (hasClip) {
				const play = actions.createEl("button", {
					cls: "enot-play-btn",
					text: "▶ Play",
					attr: { type: "button", title: "Play short preview" },
				});
				play.addEventListener("click", () => {
					void (async () => {
						try {
							if (this.playing) {
								this.playing.pause();
								this.playing = null;
							}
							await this.syncIO.playClip(row.id);
						} catch (err) {
							console.error(err);
							new Notice("Enot: could not play clip");
						}
					})();
				});
			}
			const del = actions.createEl("button", {
				cls: "enot-table-del",
				text: "Remove",
				attr: { type: "button" },
			});
			del.addEventListener("click", () => {
				void (async () => {
					this.rows.splice(index, 1);
					this.dirty = true;
					this.renderRows();
					try {
						const content = serializeCalibration(this.rows);
						const clips = await this.syncIO.saveContent(content);
						this.clipIds = new Set(clips);
						this.dirty = false;
						this.renderRows();
						new Notice("Enot: voice removed");
					} catch (err) {
						console.error(err);
						new Notice("Enot: could not remove voice on server");
					}
				})();
			});
			card.createDiv({
				cls: "enot-voice-card__phrase",
				text: row.phrase ? `“${row.phrase}”` : "No sample phrase",
			});

			const nameRow = card.createDiv({ cls: "enot-voice-card__name" });
			nameRow.createSpan({ text: "Name", cls: "enot-voice-card__label" });
			const nameInput = nameRow.createEl("input", {
				type: "text",
				cls: "enot-table-input",
				value: isUnknownSpeakerName(row.name) ? "" : row.name,
				attr: { placeholder: "e.g. Света" },
			});
			nameInput.addEventListener("input", () => {
				const target = this.rows[index];
				if (!target) {
					return;
				}
				target.name = nameInput.value.trim() || "Неизвестный";
				this.dirty = true;
			});
		});
	}

	private async saveAndSync(): Promise<void> {
		try {
			const renames: Record<string, string> = {};
			for (const row of this.rows) {
				if (!isUnknownSpeakerName(row.name)) {
					renames[row.id] = row.name.trim();
				}
			}

			const withNames = serializeCalibration(this.rows);
			await this.syncIO.saveContent(withNames);

			this.rows = stripNamedCalibrationRows(this.rows);
			const cleaned = serializeCalibration(this.rows);
			const clips = await this.syncIO.saveContent(cleaned);
			this.clipIds = new Set(clips);

			let rewritten = 0;
			if (Object.keys(renames).length) {
				rewritten = await this.syncIO.applyVoiceNamesToNotes(renames);
			}

			this.dirty = false;
			this.renderRows();
			if (rewritten > 0) {
				new Notice(`Enot: voices synced · updated ${rewritten} note(s)`);
			} else {
				new Notice("Enot: voices synced");
			}
		} catch (err) {
			console.error(err);
			new Notice("Enot: failed to sync voices");
		}
	}

	onClose(): void {
		if (this.playing) {
			this.playing.pause();
			this.playing = null;
		}
		if (this.dirty) {
			new Notice("Enot: voice edits not synced - open again and Save & sync");
		}
		this.contentEl.empty();
	}
}

export interface BrandRow {
	canon: string;
	aliases: string;
}

export function parseBrandRows(text: string): BrandRow[] {
	const rows: BrandRow[] = [];
	const seen = new Set<string>();
	const re = /^[\s>*-]*\s*\[\[([^\]]+)\]\]\s*(?:\|\s*(.+))?\s*$/gm;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text || "")) !== null) {
		const canon = (m[1] || "").trim();
		const key = canon.toLowerCase().replace(/ё/g, "е");
		if (!canon || seen.has(key)) {
			continue;
		}
		seen.add(key);
		rows.push({ canon, aliases: (m[2] || "").trim() });
	}
	return rows;
}

export function serializeBrandRows(rows: BrandRow[]): string {
	const lines: string[] = [];
	const seen = new Set<string>();
	for (const row of rows) {
		const canon = (row.canon || "").trim();
		const key = canon.toLowerCase().replace(/ё/g, "е");
		if (!canon || seen.has(key)) {
			continue;
		}
		seen.add(key);
		const aliases = (row.aliases || "").trim();
		if (aliases) {
			lines.push(`- [[${canon}]] | ${aliases}`);
		} else {
			lines.push(`- [[${canon}]]`);
		}
	}
	if (!lines.length) {
		return BRAND_HINTS_INTRO;
	}
	return `${BRAND_HINTS_INTRO.trimEnd()}\n${lines.join("\n")}\n`;
}

type BrandSync = {
	loadContent: () => Promise<string>;
	saveContent: (content: string) => Promise<void>;
};

export class BrandHintsModal extends Modal {
	private rows: BrandRow[] = [];
	private dirty = false;
	private listEl: HTMLElement | null = null;

	constructor(
		app: App,
		private store: BrandSync,
	) {
		super(app);
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		this.modalEl.addClass("enot-table-modal");
		contentEl.createEl("h2", { text: "Brand hints" });
		contentEl.createEl("p", {
			text: "Canon + ASR aliases (e.g. DDX | дэдэикс, ddx). Synced to your account - not written into the vault.",
			cls: "enot-modal-lead",
		});

		this.listEl = contentEl.createDiv({ cls: "enot-name-list" });
		try {
			this.rows = parseBrandRows(await this.store.loadContent());
		} catch {
			this.rows = [];
		}
		this.renderRows();

		const actions = contentEl.createDiv({ cls: "enot-modal-actions" });
		new Setting(actions)
			.addButton((btn) =>
				btn.setButtonText("Add brand").onClick(() => {
					this.rows.push({ canon: "", aliases: "" });
					this.dirty = true;
					this.renderRows();
				}),
			)
			.addButton((btn) =>
				btn.setButtonText("Save & sync").setCta().onClick(async () => {
					await this.saveAndSync();
				}),
			)
			.addButton((btn) =>
				btn.setButtonText("Close").onClick(() => this.close()),
			);
	}

	private renderRows(): void {
		if (!this.listEl) {
			return;
		}
		this.listEl.empty();

		if (!this.rows.length) {
			this.listEl.createDiv({
				cls: "enot-table-empty",
				text: "No brands yet - add products you mention often.",
			});
		}

		this.rows.forEach((row, index) => {
			const el = this.listEl!.createDiv({ cls: "enot-brand-row" });
			const canon = el.createEl("input", {
				type: "text",
				cls: "enot-table-input enot-brand-canon",
				value: row.canon,
				attr: { placeholder: "DDX" },
			});
			canon.addEventListener("input", () => {
				row.canon = canon.value;
				this.dirty = true;
			});
			const aliases = el.createEl("input", {
				type: "text",
				cls: "enot-table-input enot-brand-aliases",
				value: row.aliases,
				attr: { placeholder: "дэдэикс, ддх, ddx" },
			});
			aliases.addEventListener("input", () => {
				row.aliases = aliases.value;
				this.dirty = true;
			});
			const del = el.createEl("button", {
				cls: "enot-table-del",
				text: "Remove",
				attr: { type: "button" },
			});
			del.addEventListener("click", () => {
				this.rows.splice(index, 1);
				this.dirty = true;
				this.renderRows();
			});
		});
	}

	private async saveAndSync(): Promise<void> {
		const content = serializeBrandRows(this.rows);
		this.rows = parseBrandRows(content);
		try {
			await this.store.saveContent(content);
			this.dirty = false;
			this.renderRows();
			new Notice("Enot: brand hints saved");
		} catch (err) {
			console.error(err);
			new Notice("Enot: failed to save brand hints");
		}
	}

	onClose(): void {
		if (this.dirty) {
			new Notice("Enot: brand hints not synced - open again and Save & sync");
		}
		this.contentEl.empty();
	}
}

export interface ClarifyRow {
	heard: string;
	candidates: string;
	note: string;
	canon: string;
}

export function parseClarifyRows(text: string): ClarifyRow[] {
	const rows: ClarifyRow[] = [];
	const seen = new Set<string>();
	const re =
		/^[\s>*-]*\s*heard:\s*`([^`]+)`\s*\|\s*candidates:\s*([^|\n]+?)(?:\s*\|\s*note:\s*(.+))?\s*$/gim;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text || "")) !== null) {
		const heard = (m[1] || "").trim();
		const key = heard.toLowerCase().replace(/ё/g, "е");
		if (!heard || seen.has(key)) {
			continue;
		}
		seen.add(key);
		const candidates = (m[2] || "").trim();
		const note = (m[3] || "").trim();
		const firstCand = candidates.split(/[,;/]/)[0]?.trim() || "";
		const canon = firstCand === "-" ? "" : firstCand;
		rows.push({ heard, candidates, note, canon });
	}
	return rows;
}

export function serializeClarifyRows(rows: ClarifyRow[]): string {
	if (!rows.length) {
		return CLARIFY_INTRO;
	}
	const lines = [CLARIFY_INTRO.trimEnd(), ""];
	for (const row of rows) {
		const cands = (row.candidates || "").trim() || "-";
		let line = `- heard: \`${row.heard}\` | candidates: ${cands}`;
		if (row.note) {
			line += ` | note: ${row.note}`;
		}
		lines.push(line);
	}
	return `${lines.join("\n")}\n`;
}

type ClarifySync = {
	loadContent: () => Promise<string>;
	saveContent: (content: string) => Promise<void>;
	confirmClarify: (heard: string, canon: string) => Promise<void>;
};

export class ClarifyQueueModal extends Modal {
	private rows: ClarifyRow[] = [];
	private dirty = false;
	private listEl: HTMLElement | null = null;

	constructor(
		app: App,
		private syncIO: ClarifySync,
	) {
		super(app);
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		this.modalEl.addClass("enot-table-modal");
		contentEl.createEl("h2", { text: "Clarify queue" });
		contentEl.createEl("p", {
			text: "Doubtful ASR tokens. Confirm a canon - saved as a personal pattern. Nothing written into the vault.",
			cls: "enot-modal-lead",
		});

		this.listEl = contentEl.createDiv({ cls: "enot-name-list" });
		try {
			this.rows = parseClarifyRows(await this.syncIO.loadContent());
		} catch {
			this.rows = [];
		}
		this.renderRows();

		const actions = contentEl.createDiv({ cls: "enot-modal-actions" });
		new Setting(actions)
			.addButton((btn) =>
				btn.setButtonText("Save queue").onClick(async () => {
					await this.saveQueue();
				}),
			)
			.addButton((btn) =>
				btn.setButtonText("Close").onClick(() => this.close()),
			);
	}

	private renderRows(): void {
		if (!this.listEl) {
			return;
		}
		this.listEl.empty();

		if (!this.rows.length) {
			this.listEl.createDiv({
				cls: "enot-table-empty",
				text: "Queue empty - doubts appear after processing notes.",
			});
		}

		this.rows.forEach((row, index) => {
			const el = this.listEl!.createDiv({ cls: "enot-clarify-row" });
			el.createDiv({ cls: "enot-clarify-heard", text: row.heard });
			if (row.note) {
				el.createDiv({ cls: "enot-clarify-note", text: row.note });
			}
			const canon = el.createEl("input", {
				type: "text",
				cls: "enot-table-input",
				value: row.canon,
				attr: { placeholder: "Canon (e.g. DDX)" },
			});
			canon.addEventListener("input", () => {
				row.canon = canon.value;
				this.dirty = true;
			});
			const confirm = el.createEl("button", {
				cls: "enot-table-confirm",
				text: "Confirm",
				attr: { type: "button" },
			});
			confirm.addEventListener("click", () => {
				void (async () => {
					const c = (row.canon || "").trim();
					if (!c) {
						new Notice("Enot: enter a canon first");
						return;
					}
					try {
						await this.syncIO.confirmClarify(row.heard, c);
						this.rows.splice(index, 1);
						await this.syncIO.saveContent(serializeClarifyRows(this.rows));
						this.dirty = false;
						this.renderRows();
						new Notice(`Enot: ${row.heard} → ${c}`);
					} catch (err) {
						console.error(err);
						new Notice("Enot: confirm failed");
					}
				})();
			});
			const del = el.createEl("button", {
				cls: "enot-table-del",
				text: "Dismiss",
				attr: { type: "button" },
			});
			del.addEventListener("click", () => {
				this.rows.splice(index, 1);
				this.dirty = true;
				this.renderRows();
			});
		});
	}

	private async saveQueue(): Promise<void> {
		const content = serializeClarifyRows(this.rows);
		try {
			await this.syncIO.saveContent(content);
			this.dirty = false;
			new Notice("Enot: clarify queue saved");
		} catch (err) {
			console.error(err);
			new Notice("Enot: failed to save clarify queue");
		}
	}

	onClose(): void {
		if (this.dirty) {
			new Notice("Enot: clarify edits not synced - open again and Save");
		}
		this.contentEl.empty();
	}
}

export type PlanCard = {
	key: string;
	label: string;
	price_usd: number;
	soft_hours: number;
	hard_hours: number;
	blurb: string;
	recommended?: boolean;
	checkout_url?: string;
};

export class PlansModal extends Modal {
	constructor(
		app: App,
		private opts: {
			plans: PlanCard[];
			currentPlan: string | null;
			access: string;
			onChoose: (planKey: string) => void;
		},
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.modalEl.addClass("enot-plans-modal");
		contentEl.createEl("h2", { text: "Choose your Enot plan" });
		contentEl.createEl("p", {
			text: "Cloud audio hours reset each month on paid plans. Switching plans cancels the old Whop membership at period end — hours do not stack.",
			cls: "enot-modal-lead",
		});

		const current = (this.opts.currentPlan || "").toLowerCase();
		const grid = contentEl.createDiv({ cls: "enot-plans-grid" });

		for (const plan of this.opts.plans) {
			const isCurrent = this.opts.access === "paid" && plan.key === current;
			const card = grid.createDiv({
				cls: "enot-plan-card" + (plan.recommended ? " enot-plan-card--recommended" : ""),
			});
			const top = card.createDiv({ cls: "enot-plan-card__top" });
			top.createDiv({ cls: "enot-plan-card__name", text: plan.label });
			if (plan.recommended) {
				top.createSpan({ cls: "enot-plan-card__badge", text: "Recommended" });
			}
			if (isCurrent) {
				top.createSpan({ cls: "enot-plan-card__badge enot-plan-card__badge--current", text: "Current" });
			}
			const price = card.createDiv({ cls: "enot-plan-card__price" });
			price.createSpan({ text: `$${plan.price_usd}` });
			price.createSpan({ cls: "enot-plan-card__per", text: "/ mo" });
			card.createDiv({
				cls: "enot-plan-card__hours",
				text: `Up to ~${plan.soft_hours} h / month (hard stop ~${plan.hard_hours} h)`,
			});
			card.createEl("p", { cls: "enot-plan-card__blurb", text: plan.blurb });
			const btn = card.createEl("button", {
				cls: "enot-plan-card__cta" + (plan.recommended ? " mod-cta" : ""),
				text: isCurrent ? "Current plan" : `Continue with ${plan.label}`,
			});
			btn.type = "button";
			btn.disabled = isCurrent;
			btn.addEventListener("click", () => {
				this.opts.onChoose(plan.key);
				this.close();
			});
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class WriteTargetsModal extends Modal {
	private draft: WriteTargets;

	constructor(
		app: App,
		initial: WriteTargets,
		private onSave: (targets: WriteTargets) => Promise<void>,
	) {
		super(app);
		this.draft = normalizeWriteTargets(initial);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.modalEl.addClass("enot-table-modal");
		contentEl.createEl("h2", { text: "Where Enot may write" });
		contentEl.createEl("p", {
			text: "Folders sort 00 → 10 in the sidebar. Uncheck to skip that destination; notes fall back to the next allowed note folder.",
			cls: "enot-modal-lead",
		});

		for (const meta of WRITE_TARGET_META) {
			new Setting(contentEl)
				.setName(meta.folder)
				.setDesc(meta.desc)
				.addToggle((tog) =>
					tog.setValue(this.draft[meta.key]).onChange((on) => {
						this.draft = normalizeWriteTargets({
							...this.draft,
							[meta.key]: on,
						});
					}),
				);
		}

		const actions = contentEl.createDiv({ cls: "enot-modal-actions" });
		new Setting(actions)
			.addButton((btn) =>
				btn.setButtonText("Save").setCta().onClick(async () => {
					try {
						await this.onSave(normalizeWriteTargets(this.draft));
						new Notice("Enot: write folders saved");
						this.close();
					} catch (err) {
						console.error(err);
						new Notice("Enot: failed to save write folders");
					}
				}),
			)
			.addButton((btn) =>
				btn.setButtonText("Cancel").onClick(() => this.close()),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
