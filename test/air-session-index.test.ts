import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RequestError, type ListSessionsRequest, type SessionInfo } from '@agentclientprotocol/sdk/unstable'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionTitleSnapshot } from '@deepseek-ai/dsh-session-title'
import {
    archive,
    initializeMeta,
    listSessions,
    parseListOptions,
    rename,
    sessionIndexPath,
    unarchive,
    type AirSessionHeader,
} from '../src/bridge/air-session-index.ts'

let home: string

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dsh-air-index-'))
    process.env['DSH_HOME'] = home
})

afterEach(() => {
    delete process.env['DSH_HOME']
    rmSync(home, { recursive: true, force: true })
})

function sessionId(value: string): SessionId {
    return value as SessionId
}

function header(value: string, createdAt: number, extra: Partial<AirSessionHeader> = {}): AirSessionHeader {
    return { id: sessionId(value), cwd: '/repo', createdAt, ...extra }
}

function titleEvent(title: string, seq = 1): SessionEvent {
    return {
        type: 'session/title',
        seq,
        time: seq,
        data: { title, messageSeqs: [], source: { kind: 'user' } },
    } as unknown as SessionEvent
}

function userEvent(text: string, seq = 2): SessionEvent {
    return {
        type: 'user/message',
        seq,
        time: seq,
        data: {
            id: `message-${seq}`,
            role: 'user',
            source: { kind: 'user' },
            content: [{ type: 'text', text }],
        },
        surfaceOp: 'append',
    } as unknown as SessionEvent
}

function foldTitle(events: readonly SessionEvent[]): SessionTitleSnapshot | undefined {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index]
        if (event?.type === 'session/title') {
            return {
                title: event.data.title,
                messageSeqs: event.data.messageSeqs,
                source: event.data.source,
                eventSeq: event.seq,
                updatedAt: event.time,
            }
        }
    }
    return undefined
}

function dependencies(
    headers: readonly AirSessionHeader[],
    events: Map<string, readonly SessionEvent[]>,
) {
    return {
        headers,
        readEvents: async (id: SessionId) => events.get(String(id)) ?? [],
        foldTitle,
        isSubagent: (item: AirSessionHeader | undefined) => item?.origin === 'subagent',
    }
}

function listParams(archived: 'unarchived' | 'archived' | 'all', limit = 100): ListSessionsRequest {
    return {
        cwd: '/repo',
        _meta: { jetbrains: { air: { version: 1, list: { archived, limit } } } },
    } as unknown as ListSessionsRequest
}

function archivedOf(session: SessionInfo): boolean | undefined {
    const meta = session._meta as
        | { jetbrains?: { air?: { archived?: boolean } } }
        | null
        | undefined
    return meta?.jetbrains?.air?.archived
}

describe('Air session index', () => {
    it('advertises the request surface Air reads from the top-level initialize meta', () => {
        expect(initializeMeta()).toEqual({
            jetbrains: {
                air: {
                    version: 1,
                    capabilities: ['sessionIndex', 'sessionArchive', 'sessionRename'],
                },
            },
        })
    })

    it('defaults non-Air clients to all sessions and Air clients to unarchived', () => {
        expect(parseListOptions({})).toMatchObject({ archived: 'all', limit: 100, isAir: false })
        expect(parseListOptions({ _meta: { jetbrains: { air: {} } } })).toMatchObject({
            archived: 'unarchived',
            limit: 100,
            isAir: true,
        })
        expect(() =>
            parseListOptions({ _meta: { jetbrains: { air: { list: { archived: 'bogus' } } } } })
        ).toThrow(RequestError)
    })

    it('lists titled and prompt-derived sessions, skips empty and subagent rows', async () => {
        const headers = [
            header('alpha', 500),
            header('bravo', 400),
            header('empty', 300),
            header('subagent', 600, { origin: 'subagent' }),
        ]
        const events = new Map<string, readonly SessionEvent[]>([
            ['alpha', [titleEvent('Alpha title')]],
            ['bravo', [userEvent('Bravo first prompt')]],
        ])

        const result = await listSessions(listParams('unarchived'), dependencies(headers, events))

        expect(result.sessions.map((session) => session.sessionId)).toEqual(['alpha', 'bravo'])
        expect(result.sessions.map((session) => session.title)).toEqual([
            'Alpha title',
            'Bravo first prompt',
        ])
        expect(result.sessions.every((session) => archivedOf(session) === false)).toBe(true)
    })

    it('keeps untitled sessions for clients that did not declare the Air extension', async () => {
        const headers = [header('golf', 100)]
        const result = await listSessions(
            { cwd: '/repo' } as ListSessionsRequest,
            dependencies(headers, new Map()),
        )

        expect(result.sessions.map((session) => session.sessionId)).toEqual(['golf'])
        expect(result.sessions[0]?.title).toBeUndefined()
    })

    it('persists archive, rename, and unarchive across list calls', async () => {
        const headers = [header('delta', 100), header('echo', 200)]
        const events = new Map<string, readonly SessionEvent[]>([
            ['delta', [titleEvent('Delta title')]],
            ['echo', [titleEvent('Echo title')]],
        ])
        const deps = dependencies(headers, events)

        archive({ sessionId: 'delta' })
        expect(JSON.parse(readFileSync(sessionIndexPath(), 'utf8')).archived).toContain('delta')

        const archived = await listSessions(listParams('archived'), deps)
        expect(archived.sessions.map((session) => session.sessionId)).toEqual(['delta'])
        expect(archivedOf(archived.sessions[0]!)).toBe(true)

        rename({ sessionId: 'delta', title: 'Delta renamed' })
        const unarchived = await listSessions(listParams('unarchived'), deps)
        expect(unarchived.sessions.map((session) => session.sessionId)).toEqual(['echo'])

        unarchive({ sessionId: 'delta' })
        const restored = await listSessions(listParams('unarchived'), deps)
        expect(restored.sessions.find((session) => session.sessionId === 'delta')?.title).toBe(
            'Delta renamed',
        )
    })

    it('rejects archive and rename requests without their required fields', () => {
        expect(() => archive({})).toThrow(RequestError)
        expect(() => rename({ sessionId: 'foxtrot', title: '   ' })).toThrow(RequestError)
    })
})
