export const INBOX_DIR = "00 Inbox";
export const MEETINGS_DIR = "01 Meetings";
export const PROJECTS_DIR = "02 Projects";
export const AREAS_DIR = "03 Areas";
export const RESOURCES_DIR = "04 Resources";
export const DECISIONS_DIR = "05 Decisions";
export const DAILY_DIR = "06 Daily";
export const TEMPLATES_DIR = "07 Templates";
export const ARCHIVE_DIR = "08 Archive";
export const PEOPLE_DIR = "09 People";
export const TOPICS_DIR = "10 Topics";

/** Vault roots the server may write into (developer PARA+). */
export const ENOT_PATH_ROOTS = [
	`${INBOX_DIR}/`,
	`${MEETINGS_DIR}/`,
	`${PROJECTS_DIR}/`,
	`${RESOURCES_DIR}/`,
	`${DECISIONS_DIR}/`,
	`${PEOPLE_DIR}/`,
	`${TOPICS_DIR}/`,
	// Legacy
	"Notes/",
	"00-inbox/",
	"10-projects/",
	"30-resources/",
	"70-adrs/",
	"People/",
	"Topics/",
	"📥 Inbox/",
	"🎙️ Meetings/",
	"🎯 Projects/",
	"📚 Resources/",
	"⚖️ Decisions/",
	"👤 People/",
	"🏷️ Topics/",
] as const;

export type WriteTargetKey =
	| "meeting"
	| "inbox"
	| "til"
	| "decision"
	| "people"
	| "topics"
	| "projects";

export const WRITE_TARGET_META: {
	key: WriteTargetKey;
	folder: string;
	desc: string;
	noteKind?: boolean;
}[] = [
	{ key: "inbox", folder: INBOX_DIR, desc: "Raw thoughts / monologues", noteKind: true },
	{ key: "meeting", folder: MEETINGS_DIR, desc: "Calls and meetings", noteKind: true },
	{ key: "til", folder: `${RESOURCES_DIR}/til`, desc: "Learned facts (TIL)", noteKind: true },
	{ key: "decision", folder: DECISIONS_DIR, desc: "ADRs / decisions", noteKind: true },
	{ key: "projects", folder: PROJECTS_DIR, desc: "Project stub cards", noteKind: false },
	{ key: "people", folder: PEOPLE_DIR, desc: "Person stub cards", noteKind: false },
	{ key: "topics", folder: TOPICS_DIR, desc: "Topic stub cards", noteKind: false },
];

export type WriteTargets = Record<WriteTargetKey, boolean>;

export const DEFAULT_WRITE_TARGETS: WriteTargets = {
	meeting: true,
	inbox: true,
	til: true,
	decision: true,
	people: true,
	topics: true,
	projects: true,
};

const NOTE_KIND_FALLBACK: WriteTargetKey[] = ["inbox", "meeting", "til", "decision"];

export function normalizeWriteTargets(raw: unknown): WriteTargets {
	const out: WriteTargets = { ...DEFAULT_WRITE_TARGETS };
	if (!raw || typeof raw !== "object") {
		return out;
	}
	const obj = raw as Record<string, unknown>;
	for (const key of Object.keys(DEFAULT_WRITE_TARGETS) as WriteTargetKey[]) {
		if (key in obj) {
			out[key] = Boolean(obj[key]);
		}
	}
	if (!NOTE_KIND_FALLBACK.some((k) => out[k])) {
		out.inbox = true;
	}
	return out;
}

/** Map a server path to an allowed folder when write targets changed. */
export function remapPathForTargets(path: string, targets: WriteTargets): string {
	const kind = detectKindFromPath(path);
	if (!kind || targets[kind]) {
		return path;
	}
	const fallback = NOTE_KIND_FALLBACK.find((k) => targets[k]) || "inbox";
	const base = path.split("/").pop() || "Voice note.md";
	const dayMatch = base.match(/^(\d{4}-\d{2}-\d{2})\s*-\s*(.+)$/);
	const dateFolder = path.match(/(\d{4}-\d{2}-\d{2})/);
	const day = dateFolder?.[1] || new Date().toISOString().slice(0, 10);
	if (fallback === "inbox") {
		const title = dayMatch?.[2] || base;
		return `${INBOX_DIR}/${day} - ${title}`;
	}
	if (fallback === "meeting") {
		const title = dayMatch ? dayMatch[2] : base;
		return `${MEETINGS_DIR}/${day}/${title}`;
	}
	if (fallback === "til") {
		return `${RESOURCES_DIR}/til/${base}`;
	}
	return `${DECISIONS_DIR}/${base}`;
}

function detectKindFromPath(path: string): WriteTargetKey | null {
	const p = path.replace(/^\/+/, "");
	if (p.startsWith(MEETINGS_DIR) || p.startsWith("Notes/") || p.includes("Meetings")) {
		return "meeting";
	}
	if (p.startsWith(INBOX_DIR) || p.startsWith("00-inbox") || p.includes("Inbox")) {
		return "inbox";
	}
	if (p.includes("/til/") || p.startsWith(RESOURCES_DIR) || p.startsWith("30-resources")) {
		return "til";
	}
	if (p.startsWith(DECISIONS_DIR) || p.startsWith("70-adrs") || p.includes("Decisions")) {
		return "decision";
	}
	return null;
}

const ENOT_TYPES = /^(meeting|inbox|til|adr|voice_capture)$/;

export function parseFrontmatter(markdown: string): string {
	if (!markdown.startsWith("---")) {
		return "";
	}
	const end = markdown.indexOf("\n---", 3);
	if (end < 0) {
		return "";
	}
	return markdown.slice(4, end);
}

export function isVoiceCapture(frontmatter: string): boolean {
	return isEnotCapture(frontmatter);
}

export function isEnotCapture(frontmatter: string): boolean {
	if (/^source:\s*enot\s*$/m.test(frontmatter)) {
		return true;
	}
	const typeMatch = frontmatter.match(/^type:\s*(\S+)\s*$/m);
	return Boolean(typeMatch && ENOT_TYPES.test(typeMatch[1] || ""));
}

export function parseYamlList(frontmatter: string, key: string): string[] {
	const lines = frontmatter.split("\n");
	const out: string[] = [];
	let inKey = false;
	for (const line of lines) {
		if (line.startsWith(`${key}:`)) {
			const rest = line.slice(key.length + 1).trim();
			if (rest === "[]") {
				return [];
			}
			if (rest.startsWith("[") && rest.endsWith("]")) {
				return rest
					.slice(1, -1)
					.split(",")
					.map((item) => item.trim())
					.filter(Boolean);
			}
			inKey = true;
			continue;
		}
		if (inKey) {
			const item = line.match(/^ {2}- (.+)$/);
			if (item?.[1]) {
				out.push(item[1].trim());
				continue;
			}
			break;
		}
	}
	return out;
}

export function parseYamlScalar(frontmatter: string, key: string): string {
	const re = new RegExp(`^${key}:\\s*(.+)$`, "m");
	const match = frontmatter.match(re);
	if (!match?.[1]) {
		return "";
	}
	return match[1].trim().replace(/^["']|["']$/g, "").replace(/^\[\[|\]\]$/g, "").trim();
}

export function stubNote(
	kind: "person" | "topic" | "project",
	name: string,
	sourceTitle: string,
	lang: "ru" | "en" = "en",
): string {
	const type = kind === "person" ? "person" : kind === "topic" ? "topic" : "project";
	const mentioned = lang === "ru" ? "Упомянут в:" : "Mentioned in:";
	const statusLine = kind === "project" ? "status: active\n" : "";
	return `---
type: ${type}
source: enot
${statusLine}tags:
  - social-graph
---

# ${name}

${mentioned}
- [[${sourceTitle}]]
`;
}

export function backlinkLine(sourceTitle: string): string {
	return `- [[${sourceTitle}]]`;
}
