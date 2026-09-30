/** One-shot vault seed: PARA folders, welcome letter, Agreements + templates. */

import {
	AGREEMENTS_DIR,
	ARCHIVE_DIR,
	AREAS_DIR,
	DAILY_DIR,
	DECISIONS_DIR,
	INBOX_DIR,
	MEETINGS_DIR,
	PEOPLE_DIR,
	PROJECTS_DIR,
	RESOURCES_DIR,
	TEMPLATES_DIR,
	TOPICS_DIR,
} from "./graph";

/** Draft welcome — replace with the founder's final English letter. */
export const WELCOME_PATH = `${INBOX_DIR}/Welcome to Enot.md`;

export const WELCOME_BODY_EN = `---
type: welcome
enot_welcome: true
---

# Welcome to Enot

Hi —

Thanks for installing Enot. I built it so your voice and meetings become real notes in Obsidian — decisions, tasks, people — without copy-pasting from a transcript.

Tap the raccoon on the left: **Microphone** to dictate, or **Upload file** for a recording you already have. Finished notes land in \`01 Meetings\` (and related folders). Open **Settings → Enot** anytime for language, plans, and name hints.

If something feels off, reply from the product channels or email — I read them.

— Danylo  
(replace this draft with your final letter)

`;

export const AGREEMENT_TEMPLATE = `---
type: agreement
due: YYYY-MM-DD
owner: ""
status: open
related: []
---

# Agreement title

## What we agreed

-

## Deadline

- Due: \`due\` above

## Owners

-

## Notes

-
`;

export const AGREEMENTS_README = `---
type: meta
---

# Agreements

Track commitments and deadlines from meetings.

1. Enot auto-creates Agreement notes from meeting action items (owner + due).
2. Edit \`due\`, \`owner\`, and \`status\` in the frontmatter anytime.
3. \`_Timeline.md\` rebuilds automatically on inbox sync (Mermaid Gantt — preview mode).

Manual notes from \`07 Templates/Agreement.md\` are indexed the same way.
`;

export function timelineBody(todayIso: string): string {
	return `---
type: timeline
---

# Agreements timeline

Edit the Mermaid block below. Obsidian renders it in **Reading / Live Preview**.
Date format: \`YYYY-MM-DD\`.

\`\`\`mermaid
gantt
    title Commitments
    dateFormat  YYYY-MM-DD
    axisFormat  %b %d
    section Example
    Sample task           :active, t1, ${todayIso}, 7d
    Another commitment    :t2, after t1, 5d
\`\`\`

## How to update

1. Add a section per project or person.
2. Each line: \`Label :id, YYYY-MM-DD, Nd\` or \`after id\`.
3. Keep Agreement notes in this folder with matching \`due\` dates.
`;
}

/** All top-level PARA+ folders to create on onboarding (English paths). */
export const SEED_FOLDERS: string[] = [
	INBOX_DIR,
	MEETINGS_DIR,
	PROJECTS_DIR,
	AREAS_DIR,
	RESOURCES_DIR,
	`${RESOURCES_DIR}/til`,
	DECISIONS_DIR,
	DAILY_DIR,
	TEMPLATES_DIR,
	ARCHIVE_DIR,
	PEOPLE_DIR,
	TOPICS_DIR,
	AGREEMENTS_DIR,
];
