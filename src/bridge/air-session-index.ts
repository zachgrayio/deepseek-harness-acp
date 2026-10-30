/**
 * JetBrains Air session-index extension.
 *
 * Air only offers Mark as Done, Reopen, and the Done list when the agent
 * advertises `jetbrains.air` in the top-level initialize `_meta` (not under
 * `agentCapabilities._meta`) and answers the session-index requests. The
 * archive flag and an explicit title live in a small JSON sidecar next to the
 * DSH session store so they survive restarts.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
    RequestError,
    type ListSessionsRequest,
    type ListSessionsResponse,
    type SessionInfo,
} from "@agentclientprotocol/sdk/unstable";
import type { UserMessage } from "@deepseek-ai/dsh-llm";
import type { SessionEvent, SessionId } from "@deepseek-ai/dsh-session";
import type { foldSessionTitle } from "@deepseek-ai/dsh-session-title";
// Side-effect type imports: merge the agent and title events into SessionEventMap.
import type {} from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-session-title";

export const AIR_SESSION_INDEX_VERSION = 1 as const;
export const AIR_SESSION_INDEX_FILE = "acp-session-index.json";
export const AIR_SESSION_INDEX_CAPABILITIES = ["sessionIndex", "sessionArchive", "sessionRename"] as const;

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 200;
const TITLE_BATCH_SIZE = 8;
const MAX_DERIVED_TITLE_LENGTH = 80;
const ARCHIVE_FILTERS = ["unarchived", "archived", "all"] as const;

export type AirSessionArchiveFilter = typeof ARCHIVE_FILTERS[number];

export interface AirSessionIndexMeta {
    jetbrains: {
        air: {
            version: typeof AIR_SESSION_INDEX_VERSION;
            capabilities: string[];
        };
    };
}

/** The top-level initialize `_meta` fragment Air reads its capabilities from. */
export function initializeMeta(): AirSessionIndexMeta {
    return {
        jetbrains: {
            air: {
                version: AIR_SESSION_INDEX_VERSION,
                capabilities: [...AIR_SESSION_INDEX_CAPABILITIES],
            },
        },
    };
}

export interface AirSessionListOptions {
    readonly archived: AirSessionArchiveFilter;
    readonly limit: number;
    readonly isAir: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidParams(detail: string, data?: unknown): RequestError {
    return RequestError.invalidParams(data, detail);
}

/** Read `_meta.jetbrains.air.list`; missing Air meta keeps the pre-index list. */
export function parseListOptions(params: unknown): AirSessionListOptions {
    const meta = isRecord(params) ? params["_meta"] : undefined;
    const jetbrains = isRecord(meta) ? meta["jetbrains"] : undefined;
    const air = isRecord(jetbrains) ? jetbrains["air"] : undefined;
    const isAir = air !== undefined;
    const list = isRecord(air) && isRecord(air["list"]) ? air["list"] : undefined;

    const rawArchived = list?.["archived"] ?? (isAir ? "unarchived" : "all");
    if (rawArchived !== "unarchived" && rawArchived !== "archived" && rawArchived !== "all") {
        throw invalidParams(
            '`_meta.jetbrains.air.list.archived` must be "unarchived", "archived" or "all"',
            { archived: rawArchived },
        );
    }

    const rawLimit = list?.["limit"] ?? DEFAULT_LIST_LIMIT;
    if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit) || rawLimit < 1) {
        throw invalidParams(
            "`_meta.jetbrains.air.list.limit` must be an integer of at least 1",
            { limit: rawLimit },
        );
    }

    return {
        archived: rawArchived,
        limit: Math.min(MAX_LIST_LIMIT, rawLimit),
        isAir,
    };
}

interface AirSessionIndexState {
    version: typeof AIR_SESSION_INDEX_VERSION;
    archived: string[];
    titles: Record<string, string>;
}

function emptyState(): AirSessionIndexState {
    return { version: AIR_SESSION_INDEX_VERSION, archived: [], titles: {} };
}

function normalizeState(raw: unknown): AirSessionIndexState {
    const state = emptyState();
    if (!isRecord(raw)) return state;

    if (Array.isArray(raw["archived"])) {
        for (const value of raw["archived"]) {
            if (typeof value === "string" && value.length > 0 && !state.archived.includes(value)) {
                state.archived.push(value);
            }
        }
    }

    if (isRecord(raw["titles"])) {
        for (const [id, value] of Object.entries(raw["titles"])) {
            if (id.length > 0 && typeof value === "string" && value.trim().length > 0) {
                state.titles[id] = value.trim();
            }
        }
    }

    return state;
}

/** `$DSH_HOME/storages/acp-session-index.json` (or `~/.dsh/...`). */
export function sessionIndexPath(): string {
    const home = process.env["DSH_HOME"];
    const root = home !== undefined && home.length > 0 ? home : join(homedir(), ".dsh");
    return join(root, "storages", AIR_SESSION_INDEX_FILE);
}

function readState(): AirSessionIndexState {
    const path = sessionIndexPath();
    if (!existsSync(path)) return emptyState();
    try {
        return normalizeState(JSON.parse(readFileSync(path, "utf8")));
    } catch {
        return emptyState();
    }
}

function writeState(state: AirSessionIndexState): void {
    const path = sessionIndexPath();
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(normalizeState(state), null, 2)}\n`, "utf8");
    renameSync(temporary, path);
}

function sessionIdOf(params: unknown): string {
    const record = isRecord(params) ? params : {};
    const raw = record["sessionId"];
    if (typeof raw !== "string" || raw.trim().length === 0) {
        throw invalidParams("params require a non-empty sessionId");
    }
    return raw.trim();
}

/** `_session/archive`: hide a session from the active list and show it in Done. */
export function archive(params: unknown): Record<string, unknown> {
    const sessionId = sessionIdOf(params);
    const state = readState();
    if (!state.archived.includes(sessionId)) {
        state.archived.push(sessionId);
        writeState(state);
    }
    return {};
}

/** `_session/unarchive`: move a session from Done back to the active list. */
export function unarchive(params: unknown): Record<string, unknown> {
    const sessionId = sessionIdOf(params);
    const state = readState();
    const retained = state.archived.filter((id) => id !== sessionId);
    if (retained.length !== state.archived.length) {
        state.archived = retained;
        writeState(state);
    }
    return {};
}

/** `_session/rename`: pin the title Air shows (and this list returns). */
export function rename(params: unknown): Record<string, unknown> {
    const sessionId = sessionIdOf(params);
    const record = isRecord(params) ? params : {};
    const raw = record["title"];
    const title = typeof raw === "string" ? raw.replace(/\s+/gu, " ").trim() : "";
    if (title.length === 0) throw invalidParams("title must be a non-empty string");
    const state = readState();
    state.titles[sessionId] = title;
    writeState(state);
    return {};
}

export interface AirSessionHeader {
    readonly id: SessionId;
    readonly cwd?: string;
    readonly createdAt?: number;
    readonly updatedAt?: number;
    readonly origin?: string;
}

export interface AirSessionListDependencies {
    readonly headers: readonly AirSessionHeader[];
    /** Explicit title from the projection cache, when the host mounts it. */
    readonly projectedTitle?: (header: AirSessionHeader) => string | undefined;
    readonly readEvents: (id: SessionId) => Promise<readonly SessionEvent[]>;
    readonly foldTitle: typeof foldSessionTitle;
    readonly isSubagent: (header: AirSessionHeader | undefined) => boolean;
}

/** Titles already folded from a session log, to avoid rereading every list. */
const titleCache = new Map<string, string>();

function textOfMessage(message: UserMessage): string | undefined {
    for (const block of message.content) {
        if (block.type === "text" && block.text.trim().length > 0) return block.text;
    }
    return undefined;
}

function userTextOfEvent(event: SessionEvent): string | undefined {
    switch (event.type) {
        case "agent/inbox/spliced": {
            for (const message of event.data.inserted) {
                if (message.source.kind !== "user") continue;
                const text = textOfMessage(message);
                if (text !== undefined) return text;
            }
            return undefined;
        }
        case "user/message":
            return event.data.source.kind === "user" ? textOfMessage(event.data) : undefined;
        default:
            return undefined;
    }
}

/** First real user prompt, for sessions whose title event predates the list. */
function deriveTitle(events: readonly SessionEvent[]): string | undefined {
    for (const event of events) {
        const text = userTextOfEvent(event);
        if (text === undefined) continue;
        const line = text.replace(/\s+/gu, " ").trim();
        if (line.length === 0 || line.startsWith("<system-reminder>")) continue;
        return line.length > MAX_DERIVED_TITLE_LENGTH
            ? `${line.slice(0, MAX_DERIVED_TITLE_LENGTH - 3)}...`
            : line;
    }
    return undefined;
}

async function resolveRow(
    header: AirSessionHeader,
    archived: boolean,
    state: AirSessionIndexState,
    dependencies: AirSessionListDependencies,
    includeUntitled: boolean,
): Promise<SessionInfo | undefined> {
    const sessionId = String(header.id);
    let title = state.titles[sessionId];
    if (title === undefined) title = dependencies.projectedTitle?.(header);
    if (title === undefined) title = titleCache.get(sessionId);
    if (title === undefined) {
        let events: readonly SessionEvent[];
        try {
            events = await dependencies.readEvents(header.id);
        } catch {
            if (!includeUntitled) return undefined;
            events = [];
        }
        const folded = dependencies.foldTitle(events)?.title;
        if (typeof folded === "string" && folded.length > 0) {
            title = folded;
            titleCache.set(sessionId, title);
        } else {
            title = deriveTitle(events);
        }
    }
    if ((typeof title !== "string" || title.length === 0) && !includeUntitled) return undefined;

    const updatedAt = header.updatedAt ?? header.createdAt;
    return {
        sessionId,
        cwd: header.cwd ?? "",
        ...(typeof title === "string" && title.length > 0 ? { title } : {}),
        ...(updatedAt !== undefined ? { updatedAt: new Date(updatedAt).toISOString() } : {}),
        _meta: { jetbrains: { air: { archived } } },
    };
}

/**
 * `session/list` with the Air filter and row metadata. Sessions with no title
 * and no user prompt are empty; they are omitted rather than exposed by GUID.
 */
export async function listSessions(
    params: ListSessionsRequest,
    dependencies: AirSessionListDependencies,
): Promise<ListSessionsResponse> {
    const options = parseListOptions(params);
    const state = readState();
    const archivedIds = new Set(state.archived);

    const candidates: Array<{ header: AirSessionHeader; archived: boolean }> = [];
    for (const header of dependencies.headers) {
        if (dependencies.isSubagent(header)) continue;
        if (params.cwd !== undefined && params.cwd !== null && header.cwd !== params.cwd) continue;
        const archived = archivedIds.has(String(header.id));
        if (options.archived === "unarchived" && archived) continue;
        if (options.archived === "archived" && !archived) continue;
        candidates.push({ header, archived });
        if (candidates.length >= options.limit * 2) break;
    }
    candidates.sort((a, b) =>
        (b.header.updatedAt ?? b.header.createdAt ?? 0) - (a.header.updatedAt ?? a.header.createdAt ?? 0)
    );

    const sessions: SessionInfo[] = [];
    for (let index = 0; index < candidates.length && sessions.length < options.limit; index += TITLE_BATCH_SIZE) {
        const batch = candidates.slice(index, index + TITLE_BATCH_SIZE);
        const resolved = await Promise.all(
            batch.map(({ header, archived }) =>
                resolveRow(header, archived, state, dependencies, !options.isAir)
            ),
        );
        for (const session of resolved) {
            if (session !== undefined && sessions.length < options.limit) sessions.push(session);
        }
    }
    return { sessions };
}
