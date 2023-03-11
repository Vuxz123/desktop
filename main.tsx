import { render } from "preact"
import { Ref, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks"
import ReactMarkdown from "react-markdown"
import { open, Command } from '@tauri-apps/api/shell'
import { fetch } from '@tauri-apps/api/http'
import { create } from "zustand"
import Database from "tauri-plugin-sql-api"
import hljs from "highlight.js"
import { invoke, clipboard } from "@tauri-apps/api"
import { appWindow } from "@tauri-apps/api/window"
import { useEventListener } from "usehooks-ts"
import remarkGfm from "remark-gfm"
import { getMatches } from '@tauri-apps/api/cli'
// @ts-ignore
import createTablesSQL from "./create_tables.sql?raw"
// @ts-ignore
import getTokenUsageSQL from "./get_token_usage.sql?raw"
// @ts-ignore
import findParentsSQL from "./find_parents.sql?raw"
import PQueue from "p-queue"

/** Database connection. */
let db: Database

type PartialMessage = {
    content: string
    role: "user" | "assistant" | "system" | "root"
    status: /* loading */-1 | /* success */0 | /* error */1
}

type Message = PartialMessage & {
    id: number
    parent: number | null
    threadId: number
    createdAt: string
    modifiedAt: string
    note: string | null  // bookmark
}

class SplitLines {
    private content = ""
    constructor(private readonly callback: (line: string) => void) { }
    add(delta: string) {
        this.content += delta
        while (true) {
            const i = this.content.indexOf("\n")
            if (i === -1) { break }
            this.callback(this.content.slice(0, i))
            this.content = this.content.slice(i + 1)
        }
    }
    end() {
        this.callback(this.content)
        this.content = ""
    }
}

class TextToSpeechQueue {
    private readonly preparationQueue = new PQueue({ concurrency: 1 })
    private readonly audioQueue = new PQueue({ concurrency: 1 })
    private textId: number | null = null

    /** Clears the queue. */
    async cancel() {
        await invoke("stop_audio")
        if (window.speechSynthesis) {
            try { window.speechSynthesis.cancel() } catch { }
        }
        this.preparationQueue.clear()
        this.audioQueue.clear()
    }

    /** Clears the queue and enqueues the text. */
    async speakText(content: string | null, messageIdForDeletion: MessageId | null, noCache = false) {
        await this.cancel()
        this.textId = null
        await (await this.prepare(content, messageIdForDeletion, noCache))?.()
    }

    /** Enqueues a text if the given textId is the same as the previous one. */
    async pushSegment(textId: number, content: string, messageIdForDeletion: MessageId | null) {
        if (this.textId !== textId) {
            this.preparationQueue.clear()
            this.audioQueue.clear()
            this.textId = textId
        }
        const speak = this.preparationQueue.add(() => this.prepare(content, messageIdForDeletion))
        this.audioQueue.add(async () => {
            await (await speak)?.()
        })
    }

    private async prepare(content: string | null, messageIdForDeletion: MessageId | null, noCache: boolean = false): Promise<(() => Promise<void>) | void> {
        console.log(`text-to-speech: ${content?.length ?? "-"} characters`)
        if (content?.trim() === "") { return }
        const { ttsBackend, azureTTSRegion, azureTTSResourceKey, azureTTSVoice, azureTTSLang, pico2waveVoice, webSpeechAPILang, webSpeechAPIRate, webSpeechAPIPitch } = useConfigStore.getState()
        switch (ttsBackend) {
            case "off": {
                break
            } case "web-speech-api": {
                if (window.speechSynthesis) {
                    return async () => {
                        speechSynthesis.cancel()
                        const utterance = new SpeechSynthesisUtterance(content ?? "Web Speech API")
                        utterance.lang = webSpeechAPILang
                        utterance.pitch = webSpeechAPIPitch
                        utterance.rate = webSpeechAPIRate
                        speechSynthesis.speak(utterance)
                        return new Promise<void>((resolve, reject) => {
                            utterance.addEventListener("end", () => { resolve() })
                            utterance.addEventListener("pause", () => { resolve() })
                            utterance.addEventListener("error", (ev) => { reject(new Error(ev.error)) })
                        })
                    }
                }
                break
            } case "pico2wave": {
                return async () => { await invoke("speak_pico2wave", { content: content ?? "pico2wave", lang: pico2waveVoice }) }
            } case "azure": {
                if (!azureTTSRegion || !/^[a-z0-9_\-]+$/i.test(azureTTSRegion) || !azureTTSResourceKey || !azureTTSVoice) { return }
                const pronouncedContent = content ?? "Microsoft Speech Service Text-to-Speech API"
                const ssml = `<speak version='1.0' xml:lang='${azureTTSLang}'><voice xml:lang='${azureTTSLang}' name='${azureTTSVoice}'>${pronouncedContent.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("'", "&apos;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</voice></speak>`

                // > You're billed for each character that's converted to speech, including punctuation. Although the SSML document itself is not billable, optional elements that are used to adjust how the text is converted to speech, like phonemes and pitch, are counted as billable characters.
                // > https://learn.microsoft.com/en-us/azure/cognitive-services/speech-service/speech-synthesis-markup
                await db.execute("INSERT INTO textToSpeechUsage (region, numCharacters) VALUES (?, ?)", [azureTTSRegion, pronouncedContent.length])

                const res = await invoke<[ok: boolean, body: string]>("speak_azure", {
                    messageId: messageIdForDeletion,
                    region: azureTTSRegion,
                    resourceKey: azureTTSResourceKey,
                    ssml,
                    beepVolume: 0,
                    preFetch: true,
                    noCache,
                })
                if (!res[0]) { console.error(res[1]); return }
                return async () => {
                    await invoke<[ok: boolean, body: string]>("speak_azure", {
                        messageId: messageIdForDeletion,
                        region: azureTTSRegion,
                        resourceKey: azureTTSResourceKey,
                        ssml,
                        beepVolume: 0,
                        preFetch: false,
                        noCache,
                    })
                }
            } default: {
                ttsBackend satisfies never
            }
        }
    }
}

const isMac = navigator.platform.startsWith("Mac")
const isWindows = navigator.platform.startsWith("Win")
const ctrlOrCmd = (ev: KeyboardEvent) => (isMac ? /* cmd */ev.metaKey : ev.ctrlKey)

/** Renders markdown contents. */
const Markdown = (props: { content: string }) => {
    useLayoutEffect(() => {
        for (const element of document.querySelectorAll<HTMLElement>(".markdown pre code:not(.hljs)")) {
            hljs.highlightElement(element)
        }
    }, [props.content])
    return useMemo(() => <ReactMarkdown
        className="markdown select-text"
        remarkPlugins={[remarkGfm]}
        components={{
            code({ node, inline, className, children, ...props }) {
                if (inline) { return <code className={className} {...props as any}>{children}</code> }
                const lang = /language-(\w+)/.exec(className || '')?.[1]
                const content = String(children).replace(/\n$/, '')
                // The README of react-markdown uses react-syntax-highlighter for syntax highlighting but it freezes the app for a whole second when loading
                return <>
                    <div class="bg-gray-700 text-zinc-100 pb-1 pt-2 rounded-t flex">
                        <div class="flex-1 pl-4">{lang}</div>
                        <CodeBlockCopyButton content={content} />
                    </div>
                    <code class={"rounded-b " + (lang ? `language-${lang}` : "")} {...props as any}>{content}</code>
                </>
            },
            a(props) {
                return <a href={props.href} onClick={(ev) => {
                    ev.preventDefault()
                    if (props.href) {
                        open(props.href)
                    }
                }}>{props.children}</a>
            },
        }}>{props.content}</ReactMarkdown>, [props.content])
}

const CodeBlockCopyButton = (props: { content: string }) => {
    const [copied, setCopied] = useState(false)
    return <div class="px-4 text-sm cursor-pointer" onClick={() => {
        clipboard.writeText(props.content)
        setCopied(true)
        setTimeout(() => { setCopied(false) }, 3000)
    }}>
        {copied && <svg xmlns="http://www.w3.org/2000/svg" class="icon icon-tabler icon-tabler-check inline-block mr-2 [transform:translateY(-1px)]" width="16" height="16" viewBox="0 0 24 24" stroke-width="1.25" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round">
            <path stroke="none" d="M0 0h24v24H0z" fill="none"></path>
            <path d="M5 12l5 5l10 -10"></path>
        </svg>}
        {!copied && <svg xmlns="http://www.w3.org/2000/svg" class="icon icon-tabler icon-tabler-clipboard inline-block mr-2 [transform:translateY(-1px)]" width="16" height="16" viewBox="0 0 24 24" stroke-width="1.25" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round">
            <path stroke="none" d="M0 0h24v24H0z" fill="none"></path>
            <path d="M9 5h-2a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-12a2 2 0 0 0 -2 -2h-2"></path>
            <path d="M9 3m0 2a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v0a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2z"></path>
        </svg>}
        {copied ? "Copied!" : "Copy code"}
    </div>
}

/** Displays an assistant's or user's message. */
const Message = (props: { depth: number }) => {
    const role = useStore((s) => s.visibleMessages[props.depth]?.role)
    const bookmarked = useStore((s) => typeof s.visibleMessages[props.depth]?.note === "string")
    const status = useStore((s) => s.visibleMessages[props.depth]?.status)
    const content = useStore((s) => s.visibleMessages[props.depth]?.content)
    const numSiblings = useStore((s) => s.visibleMessages[props.depth - 1]?.children.length ?? 1)
    const getSiblingId = (s: State) => s.visibleMessages[props.depth - 1]?.children.findIndex((v) => v.id === s.visibleMessages[props.depth]?.id) ?? 1
    const siblingId = useStore(getSiblingId)
    const hasPreviousSibling = useStore((s) => getSiblingId(s) > 0)
    const hasNextSibling = useStore((s) => getSiblingId(s) < (s.visibleMessages[props.depth - 1]?.children.length ?? 1) - 1)
    const [editing, setEditing] = useState(false)
    const textareaRef = useRef<HTMLTextAreaElement>(null)
    const waiting = useStore((s) => s.visibleMessages[props.depth]?.status === -1 && s.waitingAssistantsResponse.includes(s.visibleMessages[props.depth]!.id))
    const isFolded = useStore((s) => s.folded.has(s.visibleMessages[props.depth]?.id as number))
    const scrollIntoView = useStore((s) => s.scrollIntoView === s.visibleMessages[props.depth]?.id)
    const ref = useRef<HTMLDivElement>(null)
    const isResponseInIntegratedTerminal = useStore((s) => role === "assistant" && s.threads.find((v) => v.id === s.visibleMessages[0]?.id)?.name === "Integrated Terminal")

    const autoFitTextareaHeight = () => {
        if (!textareaRef.current) { return }
        // Auto-fit to the content https://stackoverflow.com/a/48460773/10710682
        textareaRef.current!.style.height = ""
        textareaRef.current!.style.height = Math.min(window.innerHeight / 2, textareaRef.current!.scrollHeight) + "px"
    }
    useEffect(() => {
        autoFitTextareaHeight()
    }, [editing, textareaRef])

    let processedContent = content
    if (isResponseInIntegratedTerminal && content?.trim()) {
        if (content?.trim()?.includes("```")) {
            const block = extractFirstCodeBlock(content)
            if (block) {
                processedContent = "```\n" + block + "\n```"
            }
        } else {
            processedContent = "```" + (isWindows ? "powershell" : "bash") + "\n" + content + "\n```"
        }
    }
    useEffect(() => {
        if (!scrollIntoView) { return }
        ref.current?.scrollIntoView({ behavior: "smooth" })
        useStore.setState({ scrollIntoView: null })
    }, [ref, scrollIntoView])

    if (role === "root" || (role === "system" && isDefaultPrompt(content ?? ""))) {
        return <></>
    } else {
        const saveAndSubmit = async () => {
            const s = useStore.getState()
            const path = await appendMessage(s.visibleMessages.slice(0, props.depth).map((v) => v.id), { role: "user", content: textareaRef.current!.value, status: 0 })
            setEditing(false)
            await completeAndAppend(path)
        }
        return <div ref={ref} class={"border-b border-b-zinc-200 dark:border-b-0" + (status === 1 ? " bg-red-100 dark:bg-red-900" : role === "assistant" ? " bg-zinc-100 dark:bg-zinc-700" : "")}>
            <div class="max-w-3xl mx-auto relative p-6 pt-8">
                {/* Role and toggle switches */}
                <span class="text-zinc-600 absolute top-0 left-6 select-none cursor-default">
                    <span class="text-zinc-500 dark:text-zinc-300 select-none" onMouseDown={(ev) => ev.preventDefault()}>{role}</span>
                    {numSiblings > 1 && <>
                        <span class={"inline-block px-2 ml-2" + (hasPreviousSibling ? " cursor-pointer" : "")} onClick={() => {
                            if (!hasPreviousSibling) { return }
                            const s = useStore.getState()
                            const path = s.visibleMessages.map((v) => v.id)
                            path[props.depth] = s.visibleMessages[props.depth - 1]!.children[siblingId - 1]!.id
                            reload(path)
                        }}>‹</span>
                        {siblingId + 1}<span class="mx-1">/</span>{numSiblings}
                        <span class={"inline-block px-2" + (hasNextSibling ? " cursor-pointer" : "")} onClick={() => {
                            if (!hasNextSibling) { return }
                            const s = useStore.getState()
                            const path = s.visibleMessages.map((v) => v.id)
                            path[props.depth] = s.visibleMessages[props.depth - 1]!.children[siblingId + 1]!.id
                            reload(path)
                        }}>›</span>
                    </>}
                </span>

                {/* Play audio */}
                <span title="Play audio" class="text-zinc-600 absolute top-1 right-4 select-none cursor-pointer hover:bg-zinc-200 dark:hover:bg-zinc-600"
                    onClick={() => {
                        if (content) {
                            const id = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)
                            const splitLines = new SplitLines((line) => {
                                useStore.getState().ttsQueue.pushSegment(id, line, id)
                            })
                            splitLines.add(content)
                            splitLines.end()
                        }
                    }}>
                    <svg xmlns="http://www.w3.org/2000/svg" class="icon icon-tabler icon-tabler-volume inline dark:stroke-zinc-300" width="20" height="20" viewBox="0 0 24 24" stroke-width="1.25" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round">
                        <path stroke="none" d="M0 0h24v24H0z" fill="none"></path>
                        <path d="M15 8a5 5 0 0 1 0 8"></path>
                        <path d="M17.7 5a9 9 0 0 1 0 14"></path>
                        <path d="M6 15h-2a1 1 0 0 1 -1 -1v-4a1 1 0 0 1 1 -1h2l3.5 -4.5a.8 .8 0 0 1 1.5 .5v14a.8 .8 0 0 1 -1.5 .5l-3.5 -4.5"></path>
                    </svg>

                    {/* TODO: stop */}
                    {/* <svg xmlns="http://www.w3.org/2000/svg" class="icon icon-tabler icon-tabler-player-stop inline dark:stroke-zinc-300" width="20" height="20" viewBox="0 0 24 24" stroke-width="1.25" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round">
                        <path stroke="none" d="M0 0h24v24H0z" fill="none"></path>
                        <path d="M5 5m0 2a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2z"></path>
                    </svg> */}
                </span>

                {/* Edit */}
                {role === "user" && <span title="Edit content" class="text-zinc-600 absolute top-1 right-10 select-none cursor-pointer hover:bg-zinc-200 dark:hover:bg-zinc-600"
                    onClick={() => { setEditing(true) }}>
                    <svg xmlns="http://www.w3.org/2000/svg" class="icon icon-tabler icon-tabler-edit inline dark:stroke-zinc-300" width="20" height="20" viewBox="0 0 24 24" stroke-width="1.25" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round">
                        <path stroke="none" d="M0 0h24v24H0z" fill="none"></path>
                        <path d="M7 7h-1a2 2 0 0 0 -2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2 -2v-1"></path>
                        <path d="M20.385 6.585a2.1 2.1 0 0 0 -2.97 -2.97l-8.415 8.385v3h3l8.385 -8.415z"></path>
                        <path d="M16 5l3 3"></path>
                    </svg>
                </span>}

                {role === "assistant" && <CopyResponse content={content ?? ""} />}

                {role === "assistant" && <span title="Bookmark" class="text-zinc-600 absolute top-1 right-10 select-none cursor-pointer hover:bg-zinc-200 dark:hover:bg-zinc-600"
                    onClick={async () => {
                        const s = useStore.getState()
                        if (bookmarked) {
                            await db.execute("DELETE FROM bookmark WHERE messageId = ?", [s.visibleMessages[props.depth]!.id])
                        } else {
                            await db.execute("INSERT INTO bookmark VALUES (?, ?)", [s.visibleMessages[props.depth]!.id, ""])
                        }
                        reload(s.visibleMessages.map((v) => v.id))
                    }}>
                    <svg xmlns="http://www.w3.org/2000/svg" class="icon icon-tabler icon-tabler-bookmark inline dark:stroke-zinc-300" width="20" height="20" viewBox="0 0 24 24" stroke-width="1.25" stroke="currentColor" fill={bookmarked ? "currentColor" : "none"} stroke-linecap="round" stroke-linejoin="round">
                        <path stroke="none" d="M0 0h24v24H0z" fill="none"></path>
                        <path d="M9 4h6a2 2 0 0 1 2 2v14l-5 -3l-5 3v-14a2 2 0 0 1 2 -2"></path>
                    </svg>
                </span>}

                {/* Textarea */}
                {editing && <>
                    <textarea ref={textareaRef} class="w-full mt-2 p-2 shadow-light dark:shadow-dark dark:bg-zinc-700 rounded-lg resize-none" value={content}
                        onKeyDown={(ev) => {
                            if (ctrlOrCmd(ev) && ev.code === "Enter") {
                                ev.preventDefault()
                                saveAndSubmit()
                            }
                        }}
                        onInput={autoFitTextareaHeight}></textarea>
                    <div class="text-center">
                        <button class="inline rounded border dark:border-green-700 text-sm px-3 py-1 text-white bg-green-600 hover:bg-green-500 disabled:bg-zinc-400" onClick={saveAndSubmit}>Save & Submit</button>
                        <button class="inline rounded border dark:border-zinc-600 text-sm px-3 py-1 bg-white dark:bg-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-600 disabled:bg-zinc-300 ml-2" onClick={() => { setEditing(false) }}>Cancel</button>
                    </div>
                </>}

                {/* Response */}
                {(isFolded || editing) ? "" : (role === "assistant" || role === "system") ? <Markdown content={processedContent ?? ""}></Markdown> : <div class="whitespace-pre-wrap break-words select-text">{content}</div>}
                {isFolded && <span class="cursor-pointer text-zinc-500 hover:text-zinc-600 decoration-dashed italic" onClick={() => {
                    const set = new Set(useStore.getState().folded)
                    set.delete(useStore.getState().visibleMessages[props.depth]!.id)
                    useStore.setState({ folded: set })
                }}>folded</span>}

                {/* Cursor animation */}
                {waiting && <span class="mt-1 border-l-8 border-l-zinc-600 dark:border-l-zinc-100 h-5 [animation:cursor_1s_infinite] inline-block"></span>}
            </div>
        </div >
    }
}

const CopyResponse = (props: { content: string }) => {
    const [copied, setCopied] = useState(false)
    return <span title="Copy response" class="text-zinc-600 absolute top-1 right-16 select-none cursor-pointer hover:bg-zinc-200 dark:hover:bg-zinc-600"
        onClick={() => {
            clipboard.writeText(props.content)
            setCopied(true)
            setTimeout(() => { setCopied(false) }, 3000)
        }}>
        {copied && <svg xmlns="http://www.w3.org/2000/svg" class="icon icon-tabler icon-tabler-check inline dark:stroke-zinc-300" width="20" height="20" viewBox="0 0 24 24" stroke-width="1.25" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round">
            <path stroke="none" d="M0 0h24v24H0z" fill="none"></path>
            <path d="M5 12l5 5l10 -10"></path>
        </svg>}
        {!copied && <svg xmlns="http://www.w3.org/2000/svg" class="icon icon-tabler icon-tabler-clipboard inline dark:stroke-zinc-300" width="20" height="20" viewBox="0 0 24 24" stroke-width="1.25" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round">
            <path stroke="none" d="M0 0h24v24H0z" fill="none"></path>
            <path d="M9 5h-2a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-12a2 2 0 0 0 -2 -2h-2"></path>
            <path d="M9 3m0 2a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v0a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2z"></path>
        </svg>}
    </span>
}

type MessageId = number

const defaultConfigValues = {
    APIKey: "",
    azureApiKeyAuthentication: 1,
    azureAPIKey: "",
    azureEndpoint: "",
    openaiService: "openai" as "openai" | "openai-proxy" | "azure",
    ttsBackend: (window.speechSynthesis ? "web-speech-api" : "off") as "off" | "pico2wave" | "web-speech-api" | "azure",
    azureTTSRegion: "",
    azureTTSResourceKey: "",
    azureTTSVoice: "en-US-ChristopherNeural",
    azureTTSLang: "en-US",
    pico2waveVoice: "en-US" as "en-US" | "en-GB" | "de-DE" | "es-ES" | "fr-FR" | "it-IT",
    budget: 1,
    maxCostPerMessage: 0.015,
    audioFeedback: 1,
    webSpeechAPILang: "en-US",
    webSpeechAPIPitch: 1,
    webSpeechAPIRate: 1,
    reversedView: 0,
    whisperLanguage: "",
    editVoiceInputBeforeSending: 0,
    theme: "automatic" as "automatic" | "light" | "dark",
    sidebar: "automatic" as "automatic" | "hide" | "show",
    openaiProxyAPIKey: "",
    openaiProxyUrl: "",
} satisfies Record<string, string | number>

const _useConfigStore = create<typeof defaultConfigValues>()(() => defaultConfigValues)
const _setState = _useConfigStore.setState
type AsyncStore<S> = {
    setState(partial: Partial<S>): Promise<void>
    getState(): S
    subscribe(callback: (state: S, previous: S) => void): void
    <U>(selector: (state: S) => U, equals?: (a: U, b: U) => boolean): U
}
const useConfigStore: AsyncStore<typeof defaultConfigValues> = Object.assign(_useConfigStore, {
    setState: async (partial: Partial<typeof defaultConfigValues>) => {
        for (const [k, v] of Object.entries(partial)) {
            await db.execute("INSERT OR REPLACE INTO config VALUES (?, ?)", [k, v])
        }
        _setState.call(_useConfigStore, partial)
    }
})

/** Initializes the useConfigStore. */
const loadConfig = async () => {
    // Retrieve data from the database
    const obj = Object.fromEntries((await db.select<{ key: string, value: string }[]>("SELECT key, value FROM config", []))
        .map(({ key, value }) => [key, typeof defaultConfigValues[key as keyof typeof defaultConfigValues] === "number" ? +value : value]))

    // Set default values
    for (const [k, v] of Object.entries(defaultConfigValues)) {
        if (!(k in obj)) {
            obj[k] = v
        }
    }

    await useConfigStore.setState(obj)
}

type State = {
    waitingAssistantsResponse: MessageId[]
    threads: { id: MessageId, name: string | null }[]
    visibleMessages: (Message & { children: Message[] })[]
    search: string
    folded: Set<MessageId>
    scrollIntoView: MessageId | null
    listening: boolean
    ttsQueue: TextToSpeechQueue
    openUsageDialog: () => void
    openBookmarkDialog: () => void
}

let useStore = create<State>()(() => ({
    waitingAssistantsResponse: [],
    threads: [],
    visibleMessages: [],
    password: "",
    search: "",
    folded: new Set(),
    scrollIntoView: null,
    listening: false,
    ttsQueue: new TextToSpeechQueue(),
    openUsageDialog: () => { },
    openBookmarkDialog: () => { }
}))

// @ts-ignore
if (import.meta.env.DEV) { window.useStore = useStore = (window.useStore ?? useStore) }

/**
 * Reloads everything from the database.
 * @param path - specifies which messages to display. If path is [], no thread is shown. Otherwise, the best matching thread is shown.
 */
const reload = async (path: MessageId[]) => {
    const visibleMessages: (Message & { children: Message[] })[] = []
    let node = path.length === 0 ? undefined : (await db.select<Message[]>("SELECT * FROM message LEFT OUTER JOIN bookmark ON message.id = bookmark.messageId WHERE id = ?", [path[0]!]))[0]
    let depth = 1
    while (node) {
        const children = await db.select<Message[]>("SELECT * FROM message LEFT OUTER JOIN bookmark ON message.id = bookmark.messageId WHERE parent = ?", [node.id])
        visibleMessages.push({ ...node, children })
        node = children.find((v) => v.id === path[depth]) ?? children.at(-1)
        depth++
    }

    useStore.setState({ visibleMessages })
    db.select<{ id: number, name: string | null }[]>("SELECT message.id as id, threadName.name as name FROM message LEFT OUTER JOIN threadName ON message.id = threadName.messageId WHERE message.parent IS NULL ORDER BY message.createdAt DESC")
        .then((threads) => { useStore.setState({ threads }) })
}

/** Appends a message to the thread and returns its path. */
const appendMessage = async (parents: readonly number[], message: Readonly<PartialMessage>) => {
    let id: number
    if (parents.length === 0) {
        // fixes: cannot store TEXT value in INTEGER column message.parent
        id = (await db.execute("INSERT INTO message (parent, role, status, content) VALUES (NULL, ?, ?, ?) RETURNING id", [message.role, message.status, message.content])).lastInsertId
    } else {
        id = (await db.execute("INSERT INTO message (parent, role, status, content) VALUES (?, ?, ?, ?) RETURNING id", [parents.at(-1)!, message.role, message.status, message.content])).lastInsertId
    }
    await reload([...parents, id])
    return [...parents, id]
}

const chatGPTPricePerToken = 0.002 / 1000

/** Generates an assistant's response. */
const complete = async (messages: readonly Pick<PartialMessage, "role" | "content">[], handleStream?: (content: string, delta: string) => Promise<void>): Promise<PartialMessage> => {
    try {
        const usage = await getTokenUsage()
        if (
            usage.map((v) => v.model === "gpt-3.5-turbo" ? v.sum * chatGPTPricePerToken : 0).reduce((a, b) => a + b, 0)
            >= +(await db.select<{ value: number }[]>("SELECT value FROM config WHERE key = 'budget'"))[0]!.value
        ) {
            return { role: "assistant", status: 1, content: "Monthly budget exceeded." }
        }

        const maxCostPerMessage = +(await db.select<{ value: number }[]>("SELECT value FROM config WHERE key = 'maxCostPerMessage'"))[0]!.value
        const messagesFed = messages.filter((v) => v.role !== "root").map((v) => ({ role: v.role, content: v.content }))
        let numParentsFed = -1 // all

        // Drop messages
        const expectedGeneratedTokenCount = 150
        let omitted = false
        while (true) {
            // TODO: performance optimization
            const tokens = await invoke<number>("count_tokens", { content: messagesFed.map((v) => v.content).join(" ") }) + expectedGeneratedTokenCount
            const maxTokens = maxCostPerMessage / chatGPTPricePerToken
            if (tokens < maxTokens) {
                break
            }
            if (messagesFed.length > 1) {
                messagesFed.splice(0, 1)  // drop the oldest message
                numParentsFed = messagesFed.length
            } else {
                const content = messagesFed[0]!.content
                messagesFed[0]!.content = content.slice(0, Math.floor(content.length * maxTokens / tokens * 0.9))  // cut tail
                omitted = true
            }
        }
        if (omitted) {
            messagesFed[0]!.content += " ... (omitted)"
        }

        // FIXME: display the number of parents fed
        console.log(`numParentsFed: ${numParentsFed}`)
        console.log(messagesFed)

        const model = "gpt-3.5-turbo"
        let done = false
        let err: string | null
        const requestId = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)
        const dataFetchPromise = new Promise<PartialMessage>((resolve, reject) => {
            const result: PartialMessage = { content: "", role: "assistant", status: 0 }
            const loop = async () => {
                const done2 = done
                try {
                    let delta = ""
                    for (const v of await invoke<string[]>("get_chat_completion", { requestId })) {
                        let partial: {
                            choices: {
                                delta?: {
                                    role?: "assistant"
                                    content?: string
                                }
                                index?: number
                                finish_reason?: string | null
                            }[]
                            created?: number
                            id?: string
                            model?: string
                            object?: string
                        }
                        try { partial = JSON.parse(v) } catch (err) {
                            throw new Error(`Parse error: ${v}`)
                        }
                        if (partial.choices[0]?.delta?.content) {
                            delta += partial.choices[0].delta.content
                        }
                    }
                    result.content += delta
                    if (!err) {
                        await handleStream?.(result.content, delta)
                    }
                } catch (err) {
                    reject(err)
                }
                if (done2) { resolve(result); return }
                setTimeout(loop, 50)
            }
            loop()
        })
        try {
            const { APIKey, openaiService, azureEndpoint, azureApiKeyAuthentication, azureAPIKey, openaiProxyAPIKey, openaiProxyUrl } = useConfigStore.getState()
            if (openaiService === "azure") {
                err = await invoke<string | null>("start_chat_completion", {
                    requestId,
                    secretKey: azureAPIKey,
                    body: JSON.stringify({
                        prompt: messagesFed.map((v) => `<|im_start|>${v.role}\n${v.content}\n<|im_end|>\n`).join("") + "<|im_start|>assistant",
                        stream: true,
                        stop: ["<|im_end|>"],
                    }),
                    endpoint: azureEndpoint,
                    apiKeyAuthentication: !!azureApiKeyAuthentication,
                })
            } else if (openaiService === "openai-proxy") {
                err = await invoke<string | null>("start_chat_completion", {
                    requestId,
                    secretKey: openaiProxyAPIKey,
                    body: JSON.stringify({
                        model,
                        messages: messagesFed,
                        stream: true,
                    }),
                    endpoint: openaiProxyUrl,
                    apiKeyAuthentication: false,
                })
            } else {  // openai
                err = await invoke<string | null>("start_chat_completion", {
                    requestId,
                    secretKey: APIKey,
                    body: JSON.stringify({
                        model,
                        messages: messagesFed,
                        stream: true,
                    }),
                    endpoint: "https://api.openai.com/v1/chat/completions",
                    apiKeyAuthentication: false,
                })
            }
        } finally {
            done = true
        }
        if (err) {
            let json: unknown = null
            try { json = JSON.parse(err) } catch { }
            if (typeof json === "object" && json !== null && "error" in json && typeof json.error === "object" && json.error !== null && "message" in json.error && typeof json.error.message === "string") {
                return { role: "assistant", status: 1, content: ("type" in json.error ? json.error.type + ": " : "") + json.error.message }
            }
            return { role: "assistant", status: 1, content: err }
        } else {
            const result = await dataFetchPromise
            Promise.all([
                invoke<number>("count_tokens", { content: messagesFed.join(" ") }),
                invoke<number>("count_tokens", { content: result.content })
            ]).then(([promptTokens, completionTokens]) => {
                db.execute("INSERT INTO textCompletionUsage (model, prompt_tokens, completion_tokens, total_tokens) VALUES (?, ?, ?, ?)", [model, promptTokens, completionTokens, promptTokens + completionTokens])
            })
            return result
        }
    } catch (err) {
        console.error(err)
        return { role: "assistant", status: 1, content: err instanceof Error ? err.message : err + "" }
    }
}

const extractFirstCodeBlock = (content: string) => /```[^\n]*\n*([\s\S]*?)```/.exec(content)?.[1]

/** Generates an assistant's response and appends it to the thread. */
const completeAndAppend = async (messages: readonly MessageId[]): Promise<{ message: PartialMessage, path: MessageId[] }> => {
    const path = await appendMessage(messages, { role: "assistant", content: "", status: -1 })
    const id = path.at(-1)!
    useStore.setState((s) => ({ waitingAssistantsResponse: [...s.waitingAssistantsResponse, id] }))
    try {
        const ttsId = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)
        const splitLines = new SplitLines((line) => {
            useStore.getState().ttsQueue.pushSegment(ttsId, line, id)
        })
        const newMessage = await complete(
            await Promise.all(messages.map((v) =>
                db.select<{ role: "user" | "assistant" | "system", content: string }[]>(
                    "SELECT role, content FROM message WHERE id = ?", [v]).then((records) => records[0]!))),
            async (content, delta) => {
                splitLines.add(delta)
                await db.execute("UPDATE message SET content = ? WHERE id = ?", [content, id])
                reload(path)
            },
        )
        splitLines.end()
        if (newMessage.status === 1) {
            await db.execute("UPDATE message SET role = ?, status = ?, content = content || '\n' || ? WHERE id = ?", [newMessage.role, newMessage.status, newMessage.content, id])
            useStore.getState().ttsQueue.speakText(newMessage.content + `\nPress ${isMac ? "command" : "control"} plus shift plus R to retry.`, id)
        } else {
            if (useStore.getState().threads.find((v) => v.id === messages[0]!)?.name === "Integrated Terminal") {
                // Extract the first code block
                const block = extractFirstCodeBlock(newMessage.content)
                if (block) {
                    newMessage.content = block
                }
            }
            await db.execute("UPDATE message SET role = ?, status = ?, content = ? WHERE id = ?", [newMessage.role, newMessage.status, newMessage.content, id])
        }
        reload(path)
        useStore.setState({ scrollIntoView: id })
        return { message: newMessage, path }
    } finally {
        useStore.setState((s) => ({ waitingAssistantsResponse: s.waitingAssistantsResponse.filter((v) => v !== id) }))
    }
}

/** Automatically names the thread. */
const autoName = async (content: string, root: MessageId, tags: readonly string[]) => {
    const res = await complete([
        { role: "user", content: `What is the topic of the following message? Answer using only a few words, and refrain from adding any additional comments beyond the topic name.\n\nMessage:${content}` }
    ])
    if (!res.status) {
        res.content = res.content.trim()
        let m: RegExpExecArray | null
        if ((m = /^[^"]*topic[^"]*"([^"]+)"[^"]*$/i.exec(res.content)) !== null) {
            // Topic: "test", The topic is "test".
            res.content = m[1]!
        } else if ((m = /^topic:\s*(.+)$/i.exec(res.content)) !== null) {
            // Topic: test
            res.content = m[1]!
        } else if ((m = /^"(.+)"$/i.exec(res.content)) !== null) {
            // "test"
            res.content = m[1]!
        }
        await db.execute("INSERT OR REPLACE INTO threadName VALUES (?, ?)", [root, res.content + tags.map((t) => ` #${t}`).join("")])
        reload(useStore.getState().visibleMessages.map((v) => v.id))
        return
    }
    console.error(res)
}

/** Highlights matching substrings. */
const getHighlightedText = (text: string, highlight: string) => {
    const parts = text.split(new RegExp(`(${highlight.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, "gi"))
    return <span>{parts.map(part => part.toLowerCase() === highlight.toLowerCase() ? <b class="text-orange-200">{part}</b> : part)}</span>
}

/** "test #foo #bar" -> ["foo", "bar"] */
const extractHashtags = (content: string) => {
    const m = /(?: #[^#\s]+?)*$/.exec(content)
    if (!m || !m[0]) { return [] }
    return m[0].split('#').map((v) => v.trim()).filter((v) => v)
}

/** Renders an entry in the thread list. */
const ThreadListItem = (props: { i: number }) => {
    const name = useStore((s) => s.threads[props.i]?.name ?? "New chat")
    const active = useStore((s) => s.visibleMessages[0]?.id === s.threads[props.i]?.id)
    const id = useStore((s) => s.threads[props.i]?.id)
    const searchQuery = useStore((s) => s.search)
    const [renaming, setRenaming] = useState(false)
    const renameInputRef = useRef<HTMLInputElement>(null)
    useEffect(() => {
        if (renaming) {
            renameInputRef.current?.focus()
            renameInputRef.current?.select()
        }
    }, [renaming])

    if (searchQuery && !name.toLowerCase().includes(searchQuery.toLowerCase())) { return <></> }

    const onContextMenu = (ev: MouseEvent) => {
        ev.preventDefault()
        ev.stopImmediatePropagation()
        if (ev.type === "mousedown" && ev.button === 2) { return }  // right click should be handled with onContextMenu
        const dialog = document.querySelector<HTMLDialogElement>("#contextmenu")!

        render(<>
            <button class="text-gray-800 dark:text-zinc-100 bg-transparent border-none m-0 py-[0.15rem] px-6 text-left text-sm hover:bg-zinc-200 dark:hover:bg-zinc-600 select-none rounded-lg disabled:text-gray-400 [&::backdrop]:bg-transparent focus-within:outline-none" onClick={() => { setRenaming(true) }}>Rename</button>
            <button class="text-gray-800 dark:text-zinc-100 bg-transparent border-none m-0 py-[0.15rem] px-6 text-left text-sm hover:bg-zinc-200 dark:hover:bg-zinc-600 select-none rounded-lg disabled:text-gray-400 [&::backdrop]:bg-transparent focus-within:outline-none" onClick={async () => {
                let node = (await db.select<(PartialMessage & { id: MessageId })[]>("SELECT * FROM message WHERE parent = ?", [id])).at(-1)
                while (node) {
                    if (node.role === "user") {
                        autoName(node.content, id!, extractHashtags(node.content))
                        break
                    }
                    node = (await db.select<(PartialMessage & { id: MessageId })[]>("SELECT * FROM message WHERE parent = ?", [node.id])).at(-1)
                }
            }}>Regenerate thread name</button>
            <button class="text-gray-800 dark:text-zinc-100 bg-transparent border-none m-0 py-[0.15rem] px-6 text-left text-sm hover:bg-zinc-200 dark:hover:bg-zinc-600 select-none rounded-lg disabled:text-gray-400 [&::backdrop]:bg-transparent focus-within:outline-none" onClick={async () => {
                await db.execute("DELETE FROM message WHERE id = ?", [id])
                await reload(useStore.getState().visibleMessages.map((v) => v.id))
            }}>Delete</button>
        </>, dialog)

        // Set left and top before calling showModal() to prevent scrolling
        dialog.style.left = ev.pageX + "px"
        dialog.style.top = ev.pageY + "px"

        dialog.showModal()
        const rect = dialog.getBoundingClientRect()
        dialog.style.left = Math.min(ev.pageX, window.innerWidth - rect.width) + "px"
        dialog.style.top = Math.min(ev.pageY, window.scrollY + window.innerHeight - rect.height - 5) + "px"
    }

    return <div class={"pl-8 py-2 mb-1 cursor-pointer rounded-lg overflow-x-hidden relative text-ellipsis pr-10" + (active ? " bg-zinc-700" : " hover:bg-zinc-600")}
        data-thread-id={id}
        onClick={() => reload([id!])}
        onContextMenu={onContextMenu}>
        {name !== "Integrated Terminal" && <svg xmlns="http://www.w3.org/2000/svg" class="icon icon-tabler icon-tabler-message inline mr-2" width="20" height="20" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round">
            <path stroke="none" d="M0 0h24v24H0z" fill="none"></path>
            <path d="M4 21v-13a3 3 0 0 1 3 -3h10a3 3 0 0 1 3 3v6a3 3 0 0 1 -3 3h-9l-4 4"></path>
            <path d="M8 9l8 0"></path>
            <path d="M8 13l6 0"></path>
        </svg>}
        {name === "Integrated Terminal" && <svg xmlns="http://www.w3.org/2000/svg" class="icon icon-tabler icon-tabler-terminal inline mr-2" width="20" height="20" viewBox="0 0 24 24" stroke-width="1.25" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round">
            <path stroke="none" d="M0 0h24v24H0z" fill="none"></path>
            <path d="M5 7l5 5l-5 5"></path>
            <path d="M12 19l7 0"></path>
        </svg>}
        {renaming ? "" : (searchQuery ? getHighlightedText(name, searchQuery) : name)}
        {renaming && <input
            ref={renameInputRef}
            class="bg-transparent focus-within:outline-none w-full"
            value={name}
            onKeyDown={(ev) => {
                if (ev.code === "Escape" || ev.code === "Enter") {
                    ev.currentTarget.blur()
                }
            }}
            onChange={async (ev) => {
                await db.execute("INSERT OR REPLACE INTO threadName VALUES (?, ?)", [id, ev.currentTarget.value])
            }}
            onBlur={async () => {
                setRenaming(false)
                await reload(useStore.getState().visibleMessages.map((v) => v.id))
            }}
            onClick={(ev) => { ev.stopImmediatePropagation() }}></input>}
        {active && !renaming && <svg xmlns="http://www.w3.org/2000/svg"
            class="icon icon-tabler icon-tabler-dots absolute right-4 top-0 bottom-0 my-auto p-1 hover:bg-zinc-500 rounded-lg"
            width="28" height="28" viewBox="0 0 24 24" stroke-width="1.25" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round"
            onClick={onContextMenu}>
            <path stroke="none" d="M0 0h24v24H0z" fill="none"></path>
            <path d="M5 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"></path>
            <path d="M12 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"></path>
            <path d="M19 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"></path>
        </svg>}
    </div>
}

/** Renders the search bar for threads. */
const SearchBar = () => {
    const value = useStore((s) => s.search)
    return <input class="w-full pl-8 py-2 bg-zinc-700 my-2"
        value={value}
        onKeyDown={(ev) => { if (ev.code === "Enter") { useStore.setState({ search: ev.currentTarget.value }) } }}
        onBlur={(ev) => useStore.setState({ search: ev.currentTarget.value })}
        placeholder="Search"></input>
}

const defaultPrompt = `\
Assistant is a large language model trained by OpenAI.
knowledge cutoff: 2021-09
Current date: ${Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric" }).format(new Date())}
Browsing: disabled`

const isDefaultPrompt = (prompt: string) =>
    new RegExp(String.raw`^Assistant is a large language model trained by OpenAI\.
knowledge cutoff: 2021-09
Current date: \w+ \d+, \d+
Browsing: disabled$`).test(prompt)

if (!isDefaultPrompt(defaultPrompt)) {
    console.error(`!isDefaultPrompt(defaultPrompt)`)
}

/** Renders the application. */
const App = (props: { send?: boolean, prompt?: string, voiceInput?: boolean }) => {
    const textareaRef = useRef<HTMLTextAreaElement>(null)
    const numMessages = useStore((s) => s.visibleMessages.length)
    const numThreads = useStore((s) => s.threads.length)
    const isResponseInIntegratedTerminal = useStore((s) => s.threads.find((v) => v.id === s.visibleMessages[0]?.id)?.name === "Integrated Terminal" && s.visibleMessages.at(-1)?.role === "assistant")

    useEffect(() => {
        focusInput()
        if (props.send) { send() }
        if (props.voiceInput) { startListening() }
    }, [])

    // undo/redo in textarea
    useEventListener("keydown", (ev) => {
        if (!(document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement)) { return }
        const ctrl = ctrlOrCmd(ev)
        if (ctrl && ev.code === "KeyZ") {
            ev.preventDefault()
            document.execCommand('undo', false)
        } else if (ctrl && (ev.shiftKey && ev.code === "KeyZ" || ev.code === "KeyY")) {
            ev.preventDefault()
            document.execCommand('redo', false)
        }
    })

    /** Disable context menus on most places. */
    useEventListener("contextmenu", (ev) => {
        if (document.querySelector<HTMLDialogElement>("#contextmenu")!.open) {
            return
        } else {
            if (ev.target instanceof HTMLInputElement ||  // clicked on an input
                ev.target instanceof HTMLTextAreaElement ||  // clicked on a textarea
                document.getSelection()?.isCollapsed === false || // has a selection
                ev.target instanceof Element && ev.target.matches(".select-text, .select-text *")  // clicked on a selectable text
            ) { return }
            ev.preventDefault()
        }
    })

    const focusInput = () => {
        textareaRef.current?.focus()
        textareaRef.current?.select()
        if (useConfigStore.getState().audioFeedback) { invoke("sound_focus_input") }
    }

    const openThread = (id: MessageId) => {
        reload([id])
        focusInput()
        if (useConfigStore.getState().audioFeedback) { useStore.getState().ttsQueue.speakText(useStore.getState().threads.find((v) => v.id === id)?.name ?? "untitled thread", id) }
        document.querySelector(`[data-thread-id="${id}"]`)?.scrollIntoView({})
    }

    const startListening = () => {
        const startTime = Date.now()
        useStore.getState().ttsQueue.cancel()
        invoke("start_listening", { openaiKey: useConfigStore.getState().APIKey, language: useConfigStore.getState().whisperLanguage.trim() })
            .then((res) => {
                db.execute("INSERT INTO speechToTextUsage (model, durationMs) VALUES (?, ?)", ["whisper-1", (Date.now() - startTime) / 1000])
                textareaRef.current!.value += res as string
                autoFitTextareaHeight()
                if (!useConfigStore.getState().editVoiceInputBeforeSending) {
                    send()
                }
            })
            .finally(() => {
                useStore.setState({ listening: false })
            })
        useStore.setState({ listening: true })
    }

    const [isWaitingNextKeyPress, setIsWaitingNextKeyPress] = useState(false)
    useEventListener("keydown", (ev) => {
        if (isWaitingNextKeyPress) {
            setIsWaitingNextKeyPress(false)
            if (ev.key === "0") {
                // Fold all 
                ev.preventDefault()
                const s = useStore.getState()
                useStore.setState({ folded: new Set([...s.folded, ...s.visibleMessages.filter((v) => v.role === "assistant").map((v) => v.id)]) })
                return
            } else if (ev.code === "KeyJ") {
                // Unfold all
                useStore.setState({ folded: new Set() })
                ev.preventDefault()
                return
            }
        }

        const speakAudioFeedback = (content: string) => { if (useConfigStore.getState().audioFeedback) { useStore.getState().ttsQueue.speakText(content, null) } }

        if (ev.code === "Escape" && !document.querySelector("dialog[open]")) {
            ev.preventDefault()
            useStore.getState().ttsQueue.cancel()
        } else if (ctrlOrCmd(ev) && ev.code === "KeyH") {
            // Help
            ev.preventDefault()
            const ctrlStr = isMac ? "command" : "control"
            const keybindings: [string, string][] = [
                [`Help`, `${ctrlStr} plus H`],
                [`Speak the text in the input box`, `${ctrlStr} plus U`],
                [`Focus the input box`, `${ctrlStr} plus L`],
                [`Create a new thread`, `${ctrlStr} plus N`],
                [`Speak the last response from the assistant`, `${ctrlStr} plus R`],
                [`Stop generating`, `${ctrlStr} plus shift plus S`],
                [`Stop speaking`, `Escape`],
                [`Move to the next thread`, `${ctrlStr} plus tab`],
                [`Move to the previous thread`, `${ctrlStr} plus shift plus tab`],
                [`Regenerate response`, `${ctrlStr} plus shift plus R`],
                [`Send message`, `${ctrlStr} plus enter`],
                [`Fold all assistant's responses`, `${ctrlStr} plus K, then zero`],
                [`Unfold all assistant's responses`, `${ctrlStr} plus K, then J`],
                [`Show bookmarks`, `${ctrlStr} plus shift plus O`],
                [`Start or Stop recording`, `${ctrlStr} plus shift plus V`],
            ]
            useStore.getState().ttsQueue.speakText(keybindings.map((v) => `${v[1]}: ${v[0]}`).join(". "), null)
        } else if (ctrlOrCmd(ev) && ev.shiftKey && ev.code === "KeyV") {
            ev.preventDefault()
            if (useStore.getState().listening) {
                invoke("stop_listening")
            } else {
                startListening()
            }
        } else if (ctrlOrCmd(ev) && ev.shiftKey && ev.code === "KeyO") {
            ev.preventDefault()
            useStore.getState().openBookmarkDialog()
        } else if (ctrlOrCmd(ev) && ev.code === "KeyU") {
            // Speak texts in the input box
            ev.preventDefault()
            useStore.getState().ttsQueue.speakText(textareaRef.current!.value, null, true)
        } else if (ctrlOrCmd(ev) && ev.key === "/") {
            // Focus the input box
            ev.preventDefault()
            focusInput()
            textareaRef.current!.value = "/"
            textareaRef.current!.selectionStart = 1
            textareaRef.current!.selectionEnd = 1
        } else if (ctrlOrCmd(ev) && ev.code === "KeyL") {
            // Focus the input box
            ev.preventDefault()
            focusInput()
        } else if (ctrlOrCmd(ev) && ev.code === "KeyN") {
            // Move to a new thread
            ev.preventDefault()
            reload([])
            focusInput()
        } else if (ctrlOrCmd(ev) && ev.shiftKey && ev.code === "KeyS") {
            // Stop generating
            ev.preventDefault()
            invoke("stop_all_chat_completions")
            invoke("cancel_listening")
        } else if (ctrlOrCmd(ev) && ev.key === ",") {
            ev.preventDefault()
            document.querySelector<HTMLDialogElement>("#preferences")?.showModal()
        } else if (ctrlOrCmd(ev) && !ev.shiftKey && ev.code === "KeyR") {
            // Speak the last response from the assistant
            ev.preventDefault()
            const visibleMessages = useStore.getState().visibleMessages
            if (visibleMessages.length === 0) {
                speakAudioFeedback("No messages in the thread.")
            } else {
                const id = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)
                const message = visibleMessages.at(-1)!
                const splitLines = new SplitLines((line) => {
                    useStore.getState().ttsQueue.pushSegment(id, line, message.id)
                })
                splitLines.add(message.content)
                splitLines.end()
            }
        } else if (ctrlOrCmd(ev) && ev.shiftKey && ev.code === "KeyR") {
            // Regenerate response
            ev.preventDefault()
            regenerateResponse()
        } else if (ctrlOrCmd(ev) && ev.shiftKey && ev.code === "Tab") {
            // Move to the newer thread
            ev.preventDefault()
            const s = useStore.getState()
            if (s.visibleMessages.length === 0) {
                speakAudioFeedback("There are no newer threads.")
            } else {
                const i = s.threads.findIndex((v) => v.id === s.visibleMessages[0]!.id)
                if (i === -1) {
                    speakAudioFeedback("Something went wrong.")
                } else if (i <= 0) {
                    reload([])
                    focusInput()
                    speakAudioFeedback("new thread")
                } else {
                    openThread(s.threads[i - 1]!.id)
                }
            }
        } else if (ctrlOrCmd(ev) && !ev.shiftKey && ev.code === "Tab") {
            // Move to the older thread
            ev.preventDefault()
            const s = useStore.getState()
            if (s.threads.length === 0) {
                speakAudioFeedback("There are no threads.")
            } else if (s.visibleMessages.length === 0) {
                openThread(s.threads[0]!.id)
            } else {
                const i = s.threads.findIndex((v) => v.id === s.visibleMessages[0]!.id)
                if (i === -1) {
                    speakAudioFeedback("Something went wrong.")
                } else if (i >= s.threads.length - 1) {
                    speakAudioFeedback("There are no older threads.")
                } else {
                    openThread(s.threads[i + 1]!.id)
                }
            }
        } else if (ctrlOrCmd(ev) && ev.shiftKey && ev.code === "KeyE") {
            // Open Side Bar
            ev.preventDefault()
            setIsSideBarOpen(() => true)
        } else if (ctrlOrCmd(ev) && ev.code === "KeyB") {
            // Toggle Side Bar
            ev.preventDefault()
            setIsSideBarOpen((v) => !v)
        } else if (ctrlOrCmd(ev) && ev.code === "KeyK") {
            ev.preventDefault()
            setIsWaitingNextKeyPress(true)
        }
    })

    /** Auto-fit the height of the textarea to its content https://stackoverflow.com/a/48460773/10710682 */
    const autoFitTextareaHeight = () => {
        textareaRef.current!.style.height = ""
        textareaRef.current!.style.height = Math.min(window.innerHeight / 2, textareaRef.current!.scrollHeight) + "px"
    }

    /** Sends the user's message. */
    const send = async () => {
        if (textareaRef.current!.value === "") { return }
        let s = useStore.getState()

        let path: MessageId[]

        const run = async (shouldAutoName: string | null, tags: string[]) => {
            setTextareaValueAndAutoResize(textareaRef.current!, "")
            const assistant = await completeAndAppend(path)
            if (assistant.message.status === 0 && shouldAutoName) {
                // do not wait
                autoName(shouldAutoName, path[0]!, tags)
            }
            return assistant
        }

        if (textareaRef.current!.value.startsWith("/")) {
            // Generate a shell script if the prompt is prefixed with "/"
            // remove "/"
            const content = textareaRef.current!.value.slice(1)
            setTextareaValueAndAutoResize(textareaRef.current!, "")

            const thread = s.threads.find((v) => v.name === "Integrated Terminal")
            if (!thread) {
                path = await appendMessage([], { role: "root", content: "", status: 0 })
                await db.execute("INSERT OR REPLACE INTO threadName VALUES (?, ?)", [path[0]!, "Integrated Terminal"])
                await reload(path)
            } else {
                path = [thread.id]
            }
            path = await appendMessage(path, { role: "user", content, status: 0 })
            path = await appendMessage(path, {
                // The prompt from https://github.com/TheR1D/shell_gpt/ version 0.7.0, MIT License, Copyright (c) 2023 Farkhod Sadykov
                role: "system",
                content: `Provide only ${isWindows ? "PowerShell" : "Bash"} command as output, without any additional text or prompt.`,
                status: 0,
            })
            await run(null, [])
        } else if (s.visibleMessages.length === 0) {
            // Append the system message if this is the first message in the thread
            path = await appendMessage([], { role: "root", content: "", status: 0 })
            path = await appendMessage(path, {
                role: "system", content: defaultPrompt, status: 0
            })
            const content = textareaRef.current!.value
            path = await appendMessage(path, { role: "user", content, status: 0 })
            run(content, [])
        } else {
            path = await appendMessage(s.visibleMessages.map((v) => v.id), { role: "user", content: textareaRef.current!.value, status: 0 })
            run(null, [])
        }
    }

    const [isSideBarOpen, setIsSideBarOpen] = useState<boolean>(() => {
        const { sidebar } = useConfigStore.getState()
        return sidebar === "show" || sidebar === "automatic" && window.innerWidth > 800
    })
    const [shouldDisplayAPIKeyInputOverride, setShouldDisplayAPIKeyInputOverride] = useState(false)
    const shouldDisplayAPIKeyInput = useStore((s) => s.threads.length === 0) || shouldDisplayAPIKeyInputOverride
    const threadName = useStore((s) => s.threads.find((v) => v.id === s.visibleMessages[0]?.id)?.name ?? "New chat")
    const reversed = useConfigStore((s) => !!s.reversedView)
    const lastMessageRole = useStore((s) => s.visibleMessages.findLast((v) => v.role === "user" || v.role === "assistant")?.role)

    useEffect(() => {
        appWindow.setTitle(`ChatGPT - ${threadName}`)
    }, [threadName])

    return <>
        {!isSideBarOpen && <div title="Open side bar" class="absolute top-4 left-4 cursor-pointer z-40 hover:bg-zinc-100 dark:hover:bg-zinc-700 dark:text-zinc-200 select-none rounded-lg" onClick={(ev) => { ev.preventDefault(); setIsSideBarOpen((v) => !v) }}>
            <svg xmlns="http://www.w3.org/2000/svg" class="icon icon-tabler icon-tabler-menu-2" width="30" height="30" viewBox="0 0 24 24" stroke-width="1.25" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round">
                <path stroke="none" d="M0 0h24v24H0z" fill="none"></path>
                <path d="M4 6l16 0"></path>
                <path d="M4 12l16 0"></path>
                <path d="M4 18l16 0"></path>
            </svg>
        </div>}
        <div class="flex">
            <div class={"text-sm overflow-x-hidden whitespace-nowrap bg-zinc-800 dark:bg-zinc-900 h-[100vh] text-white flex flex-col relative" + (isSideBarOpen ? " w-80" : " w-0")}>
                {isSideBarOpen && <div title="Close side bar" class="absolute top-5 right-4 cursor-pointer z-40 hover:bg-zinc-700 select-none rounded-lg" onClick={(ev) => { ev.preventDefault(); setIsSideBarOpen((v) => !v) }}>
                    <svg xmlns="http://www.w3.org/2000/svg" class="icon icon-tabler icon-tabler-chevrons-left" width="30" height="30" viewBox="0 0 24 24" stroke-width="1.25" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round">
                        <path stroke="none" d="M0 0h24v24H0z" fill="none"></path>
                        <path d="M11 7l-5 5l5 5"></path>
                        <path d="M17 7l-5 5l5 5"></path>
                    </svg>
                </div>}
                <div class="pl-4 pr-16 pb-2 pt-4">
                    <div class={"px-4 py-2 rounded-lg border border-zinc-600" + (numMessages === 0 ? " bg-zinc-700" : " hover:bg-zinc-700 cursor-pointer")} onClick={() => {
                        reload([])
                        focusInput()
                    }}>
                        <svg xmlns="http://www.w3.org/2000/svg" class="icon icon-tabler icon-tabler-plus inline mr-4 [transform:translateY(-2px)]" width="20" height="20" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round">
                            <path stroke="none" d="M0 0h24v24H0z" fill="none"></path>
                            <path d="M12 5l0 14"></path>
                            <path d="M5 12l14 0"></path>
                        </svg>
                        New chat
                    </div>
                </div>
                <SearchBar />
                <div class="flex-1 overflow-y-auto">
                    {Array(numThreads).fill(0).map((_, i) => <ThreadListItem i={i} />)}
                    <SearchResult />
                </div>
                <hr class="border-t border-t-zinc-600"></hr>

                <div class="pl-8 py-2 cursor-pointer hover:bg-zinc-600 rounded-lg"
                    onClick={async (ev) => {
                        ev.preventDefault()
                        useStore.getState().openBookmarkDialog()
                    }}>
                    <svg xmlns="http://www.w3.org/2000/svg" class="icon icon-tabler icon-tabler-bookmark inline mr-2 [transform:translateY(-1px)]" width="20" height="20" viewBox="0 0 24 24" stroke-width="1.25" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round">
                        <path stroke="none" d="M0 0h24v24H0z" fill="none"></path>
                        <path d="M9 4h6a2 2 0 0 1 2 2v14l-5 -3l-5 3v-14a2 2 0 0 1 2 -2"></path>
                    </svg>
                    Bookmarks
                </div>
                <div class="pl-8 py-2 cursor-pointer hover:bg-zinc-600 rounded-lg"
                    onClick={async (ev) => {
                        ev.preventDefault()
                        useStore.getState().openUsageDialog()
                    }}>
                    <svg xmlns="http://www.w3.org/2000/svg" class="icon icon-tabler icon-tabler-coins inline mr-2 [transform:translateY(-1px)]" width="20" height="20" viewBox="0 0 24 24" stroke-width="1.25" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round">
                        <path stroke="none" d="M0 0h24v24H0z" fill="none"></path>
                        <path d="M9 14c0 1.657 2.686 3 6 3s6 -1.343 6 -3s-2.686 -3 -6 -3s-6 1.343 -6 3z"></path>
                        <path d="M9 14v4c0 1.656 2.686 3 6 3s6 -1.344 6 -3v-4"></path>
                        <path d="M3 6c0 1.072 1.144 2.062 3 2.598s4.144 .536 6 0c1.856 -.536 3 -1.526 3 -2.598c0 -1.072 -1.144 -2.062 -3 -2.598s-4.144 -.536 -6 0c-1.856 .536 -3 1.526 -3 2.598z"></path>
                        <path d="M3 6v10c0 .888 .772 1.45 2 2"></path>
                        <path d="M3 11c0 .888 .772 1.45 2 2"></path>
                    </svg>
                    Budget
                </div>
                <div class="pl-8 py-2 cursor-pointer hover:bg-zinc-600 rounded-lg"
                    onClick={(ev) => {
                        ev.preventDefault()
                        setShouldDisplayAPIKeyInputOverride((v) => !v)
                    }}>
                    <svg xmlns="http://www.w3.org/2000/svg" class="icon icon-tabler icon-tabler-key inline mr-2 [transform:translateY(-1px)]" width="20" height="20" viewBox="0 0 24 24" stroke-width="1.25" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round">
                        <path stroke="none" d="M0 0h24v24H0z" fill="none"></path>
                        <path d="M16.555 3.843l3.602 3.602a2.877 2.877 0 0 1 0 4.069l-2.643 2.643a2.877 2.877 0 0 1 -4.069 0l-.301 -.301l-6.558 6.558a2 2 0 0 1 -1.239 .578l-.175 .008h-1.172a1 1 0 0 1 -.993 -.883l-.007 -.117v-1.172a2 2 0 0 1 .467 -1.284l.119 -.13l.414 -.414h2v-2h2v-2l2.144 -2.144l-.301 -.301a2.877 2.877 0 0 1 0 -4.069l2.643 -2.643a2.877 2.877 0 0 1 4.069 0z"></path>
                        <path d="M15 9h.01"></path>
                    </svg>
                    OpenAI API key
                </div>
                <div class="pl-8 py-2 cursor-pointer hover:bg-zinc-600 rounded-lg"
                    onClick={(ev) => {
                        ev.preventDefault()
                        document.querySelector<HTMLDialogElement>("#text-to-speech")?.showModal()
                    }}>
                    <svg xmlns="http://www.w3.org/2000/svg" class="icon icon-tabler icon-tabler-volume inline mr-2 [transform:translateY(-1px)]" width="20" height="20" viewBox="0 0 24 24" stroke-width="1.25" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round">
                        <path stroke="none" d="M0 0h24v24H0z" fill="none"></path>
                        <path d="M15 8a5 5 0 0 1 0 8"></path>
                        <path d="M17.7 5a9 9 0 0 1 0 14"></path>
                        <path d="M6 15h-2a1 1 0 0 1 -1 -1v-4a1 1 0 0 1 1 -1h2l3.5 -4.5a.8 .8 0 0 1 1.5 .5v14a.8 .8 0 0 1 -1.5 .5l-3.5 -4.5"></path>
                    </svg>
                    Text-to-speech / Audio feedback
                </div>
                <div class="pl-8 py-2 cursor-pointer hover:bg-zinc-600 rounded-lg"
                    onClick={(ev) => {
                        ev.preventDefault()
                        document.querySelector<HTMLDialogElement>("#speech-to-text")!.showModal()
                    }}>
                    <svg xmlns="http://www.w3.org/2000/svg" class="icon icon-tabler icon-tabler-microphone inline mr-2 [transform:translateY(-1px)]" width="20" height="20" viewBox="0 0 24 24" stroke-width="1.25" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round">
                        <path stroke="none" d="M0 0h24v24H0z" fill="none"></path>
                        <path d="M9 2m0 3a3 3 0 0 1 3 -3h0a3 3 0 0 1 3 3v5a3 3 0 0 1 -3 3h0a3 3 0 0 1 -3 -3z"></path>
                        <path d="M5 10a7 7 0 0 0 14 0"></path>
                        <path d="M8 21l8 0"></path>
                        <path d="M12 17l0 4"></path>
                    </svg>
                    Speech-to-text
                </div>
                <div class="pl-8 py-2 cursor-pointer hover:bg-zinc-600 rounded-lg"
                    onClick={(ev) => {
                        ev.preventDefault()
                        document.querySelector<HTMLDialogElement>("#preferences")?.showModal()
                    }}>
                    <svg xmlns="http://www.w3.org/2000/svg" class="icon icon-tabler icon-tabler-settings inline mr-2 [transform:translateY(-1px)]" width="20" height="20" viewBox="0 0 24 24" stroke-width="1.25" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round">
                        <path stroke="none" d="M0 0h24v24H0z" fill="none"></path>
                        <path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065z"></path>
                        <path d="M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0"></path>
                    </svg>
                    Preferences
                </div>
                <div class="pl-8 py-2 cursor-pointer hover:bg-zinc-600 rounded-lg"
                    onClick={(ev) => {
                        ev.preventDefault()
                        open("https://github.com/chatgptui/desktop")
                    }}>
                    <svg xmlns="http://www.w3.org/2000/svg" class="icon icon-tabler icon-tabler-question-mark inline mr-2 [transform:translateY(-1px)]" width="20" height="20" viewBox="0 0 24 24" stroke-width="1.25" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round">
                        <path stroke="none" d="M0 0h24v24H0z" fill="none"></path>
                        <path d="M8 8a3.5 3 0 0 1 3.5 -3h1a3.5 3 0 0 1 3.5 3a3 3 0 0 1 -2 3a3 4 0 0 0 -2 4"></path>
                        <path d="M12 19l0 .01"></path>
                    </svg>
                    About this app
                </div>
            </div>
            <div class="flex h-[100vh] overflow-hidden flex-1 flex-col bg-white dark:bg-zinc-800 dark:text-zinc-100 relative" id="main">
                {shouldDisplayAPIKeyInput && <APIKeyInputDialog isSideBarOpen={isSideBarOpen} />}
                <div class="flex-1 overflow-y-auto">
                    {reversed && <div class={"h-32 " + (lastMessageRole === "assistant" ? "bg-zinc-100 dark:bg-zinc-700" : "bg-white dark:bg-zinc-800")}></div>}
                    {!reversed && <div class={"text-center" + (isSideBarOpen ? "" : " px-16")}>
                        <div class="mt-4 border-b pb-1 dark:border-b-zinc-600 cursor-default" onMouseDown={(ev) => ev.preventDefault()}>{threadName}</div>
                    </div>}
                    {(reversed ? (x: number[]) => x.reverse() : (x: number[]) => x)([...Array(numMessages).keys()]).map((i) => <Message key={i} depth={i} />)}
                    <div class="h-20"></div>
                </div>
                <div class={"px-2 " + (reversed ? "top-4 left-0 right-0 mx-auto text-center absolute max-w-3xl" : "pt-4 pb-4 relative bg-white dark:bg-zinc-800")}>
                    <RegenerateResponse />
                    <div class="leading-4 flex">
                        {isResponseInIntegratedTerminal && <>
                            <div class={"flex-1 flex " + (isSideBarOpen ? "" : "ml-16 51rem:ml-0 ")}>
                                <div class={"shadow-light text-center bg-zinc-100 py-3 relative cursor-pointer hover:bg-zinc-200 [&:has(svg:hover)]:bg-zinc-100 text-zinc-600 dark:shadow-dark rounded-lg bg-zinc100 flex-1 " + (reversed ? "dark:bg-zinc-600" : "dark:bg-zinc-700")}
                                    onClick={async () => {
                                        const path = useStore.getState().visibleMessages.map((v) => v.id)
                                        const { content } = useStore.getState().visibleMessages.at(-1)!
                                        const p = isWindows
                                            ? new Command("exec-pwsh", ["-c", content]) // untested
                                            : new Command("exec-bash", ["-c", content])

                                        // TODO: stream output
                                        const lines: string[] = []
                                        p.stdout.on("data", (line) => { lines.push(line) })
                                        p.stderr.on("data", (line) => { lines.push(line) })
                                        let appended = false
                                        p.on("error", (err) => {
                                            if (appended) { return }
                                            appended = true
                                            appendMessage(path, {
                                                role: "system",
                                                content: `The command returned the following error:\n\`\`\`\n${err}\n\`\`\``,
                                                status: 1,
                                            })
                                        })
                                        p.on("close", (data) => {
                                            if (appended) { return }
                                            appended = true
                                            let concatenatedOutput = lines.join("\n")
                                            // Cut at ~1000 tokens to avoid bankruptcy
                                            // TODO: add a way to display the entire output
                                            concatenatedOutput = concatenatedOutput.length > 4000 ? concatenatedOutput.slice(0, 4000) + "\n..." : concatenatedOutput
                                            const statusText = (data.code === 0 ? `The command finished successfully.` : `The command finished with code ${data.code}${data.signal ? ` with signal ${data.signal}` : ""}.`)
                                            useStore.getState().ttsQueue.speakText(statusText, null)
                                            appendMessage(path, {
                                                role: "system",
                                                content: statusText + `\nThe output was:\n\`\`\`\n${concatenatedOutput}\n\`\`\``,
                                                status: 0,
                                            })
                                        })
                                        await p.spawn()
                                    }}>
                                    Execute
                                    <svg xmlns="http://www.w3.org/2000/svg" class="icon icon-tabler icon-tabler-x absolute top-0 bottom-0 my-auto right-0 p-2 hover:bg-zinc-300 dark:stroke-slate-100 rounded" width="40" height="40" viewBox="0 0 24 24" stroke-width="1.25" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round"
                                        onClick={(ev) => {
                                            ev.preventDefault()
                                            ev.stopImmediatePropagation()

                                        }}>
                                        <path stroke="none" d="M0 0h24v24H0z" fill="none"></path>
                                        <path d="M18 6l-12 12"></path>
                                        <path d="M6 6l12 12"></path>
                                    </svg>
                                </div>
                            </div>
                        </>}
                        {!isResponseInIntegratedTerminal && <>
                            <div class={"shadow-light dark:shadow-dark rounded-lg bg-white relative flex-1 " + (isSideBarOpen ? "" : "ml-16 51rem:ml-0 ") + (reversed ? "dark:bg-zinc-600" : "dark:bg-zinc-700")}>
                                <textarea
                                    ref={textareaRef}
                                    class="dark:text-zinc-100 leading-6 w-[calc(100%-1.25rem)] py-2 px-4 resize-none bg-transparent focus-within:outline-none"
                                    placeholder="Explain quantum computing in simple terms"
                                    rows={1}
                                    defaultValue={props.prompt}
                                    onKeyDown={(ev) => {
                                        if (
                                            // Single line & Enter
                                            !ev.ctrlKey && !ev.shiftKey && !ev.altKey && !ev.metaKey && ev.code === "Enter" && textareaRef.current!.value !== "" && !textareaRef.current!.value.includes("\n") ||

                                            // Multi-line & Ctrl(Cmd)+Enter
                                            ctrlOrCmd(ev) && ev.code === "Enter"
                                        ) {
                                            ev.preventDefault()
                                            send()
                                            return
                                        }
                                    }}
                                    onInput={autoFitTextareaHeight}></textarea>
                                <div
                                    class={"absolute bottom-2 right-5 cursor-pointer p-1"}
                                    onClick={() => { send() }}>
                                    {/* tabler-icons, MIT license, Copyright (c) 2020-2023 Paweł Kuna */}
                                    <svg xmlns="http://www.w3.org/2000/svg" class="icon icon-tabler icon-tabler-send dark:stroke-slate-100" width="18" height="18" viewBox="0 0 24 24" stroke-width="1.3" stroke="#000000" fill="none" stroke-linecap="round" stroke-linejoin="round">
                                        <path stroke="none" d="M0 0h24v24H0z" fill="none" />
                                        <line x1="10" y1="14" x2="21" y2="3" />
                                        <path d="M21 3l-6.5 18a0.55 .55 0 0 1 -1 0l-3.5 -7l-7 -3.5a0.55 .55 0 0 1 0 -1l18 -6.5" />
                                    </svg>
                                </div>
                            </div>
                            <div class="flex items-end">
                                <TokenCounter textareaRef={textareaRef} />
                            </div>
                        </>}
                    </div>
                </div>
            </div>
        </div>
        <SpeechToTextDialog />
        <TextToSpeechDialog />
        <BudgetDialog />
        <InputVolumeIndicator />
        <BookmarkDialog />
        <PreferencesDialog />
        <dialog
            id="contextmenu"
            class="m-0 px-0 py-[0.15rem] absolute left-0 top-0 z-30 flex flex-col bg-zinc-100 dark:bg-zinc-800 outline-gray-200 dark:outline-zinc-600 shadow-lg whitespace-pre rounded-lg [&:not([open])]:hidden [&::backdrop]:bg-transparent"
            onClick={(ev) => { ev.currentTarget.close() }}></dialog>
    </>
}

const APIKeyInputDialog = ({ isSideBarOpen }: { isSideBarOpen: boolean }) => {
    const apiKey = useConfigStore((s) => s.APIKey)
    const azureAPIKey = useConfigStore((s) => s.azureAPIKey)
    const openaiService = useConfigStore((s) => s.openaiService)
    const azureEndpoint = useConfigStore((s) => s.azureEndpoint)
    const azureApiKeyAuthentication = useConfigStore((s) => s.azureApiKeyAuthentication)
    const hasMessage = useStore((s) => s.visibleMessages.length > 0)
    const openaiProxyAPIKey = useConfigStore((s) => s.openaiProxyAPIKey)
    const openaiProxyUrl = useConfigStore((s) => s.openaiProxyUrl)

    return <div class={"absolute rounded-lg top-32 left-0 right-0 z-50 text-center w-fit max-w-full m-auto overflow-auto" + (hasMessage ? " bg-white dark:bg-black bg-opacity-40 dark:bg-opacity-25 backdrop-blur shadow-light dark:shadow-dark" : "") + (isSideBarOpen ? "" : " px-16")}>
        <div class="p-8">
            <p class="dark:text-zinc-100 mb-2">
                <select value={openaiService} onChange={(ev) => { useConfigStore.setState({ openaiService: ev.currentTarget.value as any }) }} class="ml-2 px-2 text-zinc-600">
                    <option value="openai">OpenAI API</option>
                    <option value="openai-proxy">OpenAI API (custom endpoint)</option>
                    <option value="azure">Azure OpenAI Service</option>
                </select>
            </p>
            {openaiService === "openai" && <>
                <p>
                    <input
                        type="password"
                        autocomplete="off"
                        value={apiKey}
                        onChange={(ev) => { useConfigStore.setState({ APIKey: ev.currentTarget.value }) }}
                        class="mb-2 w-80 shadow-light dark:shadow-dark rounded-lg font-mono px-4 dark:bg-zinc-700 dark:text-zinc-100"
                        placeholder="OpenAI API Key"></input>
                </p>
                <p>
                    <a class="cursor-pointer ml-4 text-blue-700 dark:text-blue-300 border-b border-b-blue-700 dark:border-b-blue-300 whitespace-nowrap" onClick={(ev) => { ev.preventDefault(); open("https://platform.openai.com/account/api-keys") }}>Get your API key here</a>
                </p>
            </>}
            {openaiService === "openai-proxy" && <>
                <table>
                    <tbody class="text-left [&_td]:px-2">
                        <tr>
                            <td>OpenAI API key</td>
                            <td><input
                                type="password"
                                autocomplete="off"
                                value={openaiProxyAPIKey}
                                onChange={(ev) => { useConfigStore.setState({ openaiProxyAPIKey: ev.currentTarget.value }) }}
                                class="mb-2 w-80 shadow-light dark:shadow-dark rounded-lg font-mono px-4 dark:bg-zinc-700 dark:text-zinc-100"
                                placeholder="sk-..."></input></td>
                        </tr>
                        <tr>
                            <td>Endpoint</td>
                            <td><input
                                autocomplete="off"
                                value={openaiProxyUrl}
                                onChange={(ev) => { useConfigStore.setState({ openaiProxyUrl: ev.currentTarget.value }) }}
                                class="mb-2 w-[35rem] shadow-light dark:shadow-dark rounded-lg font-mono px-4 dark:bg-zinc-700 dark:text-zinc-100"
                                placeholder="https://api.openai.com/v1/chat/completions"></input></td>
                        </tr>
                    </tbody>
                </table>
                <p class="italic text-left mt-8">
                    <b>This feature has not been tested:</b>

                    <p>
                        If you're experiencing issues, please <a class="cursor-pointer underline" onClick={() => { open("https://github.com/chatgptui/desktop/issues") }}>open an issue on GitHub</a>.<br />
                        If you find that the feature works well, you can also let us know by <a class="cursor-pointer underline" onClick={() => { open("https://github.com/chatgptui/desktop/issues") }}>opening an issue on GitHub</a> and we'll remove this notice.
                    </p>
                </p>
            </>}
            {openaiService === "azure" && <>
                <table>
                    <tbody class="text-left [&_td]:px-2">
                        <tr>
                            <td>endpoint</td>
                            <td><input
                                autocomplete="off"
                                value={azureEndpoint}
                                onChange={(ev) => { useConfigStore.setState({ azureEndpoint: ev.currentTarget.value }) }}
                                class="mb-2 w-80 shadow-light dark:shadow-dark rounded-lg font-mono px-4 dark:bg-zinc-700 dark:text-zinc-100"
                                placeholder="endpoint"></input></td>
                        </tr>
                        <tr>
                            <td>Authentication method</td>
                            <td><select value={azureApiKeyAuthentication ? "api-key" : "active-directory"}
                                onChange={(ev) => { useConfigStore.setState({ azureApiKeyAuthentication: ev.currentTarget.value === "api-key" ? 1 : 0 }) }}
                                class="mb-2 px-2 text-zinc-600">
                                <option value="api-key">API key</option>
                                <option value="active-directory">Azure Active Directory token</option>
                            </select></td>
                        </tr>
                        <tr>
                            <td>{azureApiKeyAuthentication ? "API key" : "Azure Active Directory token"}</td>
                            <td><input
                                type="password"
                                autocomplete="off"
                                value={azureAPIKey}
                                onChange={(ev) => { useConfigStore.setState({ azureAPIKey: ev.currentTarget.value }) }}
                                class="w-80 shadow-light dark:shadow-dark rounded-lg font-mono px-4 dark:bg-zinc-700 dark:text-zinc-100"></input></td>
                        </tr>
                    </tbody>
                </table>
                <p class="italic text-left mt-8">
                    <b>This feature has not been tested:</b>

                    <p>
                        If you're experiencing issues, please <a class="cursor-pointer underline" onClick={() => { open("https://github.com/chatgptui/desktop/issues") }}>open an issue on GitHub</a>.<br />
                        If you find that the feature works well, you can also let us know by <a class="cursor-pointer underline" onClick={() => { open("https://github.com/chatgptui/desktop/issues") }}>opening an issue on GitHub</a> and we'll remove this notice.
                    </p>
                </p>
            </>}
        </div>
    </div>
}

const setTextareaValueAndAutoResize = (textarea: HTMLTextAreaElement, value: string) => {
    textarea.value = value
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true }))
}

const PreferencesDialog = () => {
    const reversed = useConfigStore((s) => s.reversedView)
    const theme = useConfigStore((s) => s.theme)
    const sidebar = useConfigStore((s) => s.sidebar)
    return <dialog id="preferences" class="p-0 bg-zinc-700 text-zinc-100 shadow-dark rounded-lg" onClick={(ev) => { ev.target === ev.currentTarget && ev.currentTarget.close() }}>
        <div class="px-20 py-8 w-fit">
            <h2 class="text-xl border-b mb-4 text-emerald-400 border-b-emerald-400">Preferences</h2>
            <table>
                <tbody>
                    <tr>
                        <td>Theme</td>
                        <td><select class="ml-2 px-2 text-zinc-600" value={theme} onChange={(ev) => {
                            useConfigStore.setState({ theme: ev.currentTarget.value as any })
                        }}>
                            <option value="automatic">automatic</option>
                            <option value="light">light</option>
                            <option value="dark">dark</option>
                        </select></td>
                    </tr>
                    <tr>
                        <td>Direction</td>
                        <td><select class="ml-2 px-2 text-zinc-600" value={reversed ? "reversed" : "normal"} onChange={(ev) => {
                            useConfigStore.setState({ reversedView: ev.currentTarget.value === "reversed" ? 1 : 0 })
                        }}>
                            <option value="normal">normal</option>
                            <option value="reversed">reversed</option>
                        </select></td>
                    </tr>
                    <tr>
                        <td>Sidebar</td>
                        <td><select class="ml-2 px-2 text-zinc-600" value={sidebar} onChange={(ev) => {
                            useConfigStore.setState({ sidebar: ev.currentTarget.value as any })
                        }}>
                            <option value="automatic">automatic</option>
                            <option value="show">open by default</option>
                            <option value="hide">hide by default</option>
                        </select></td>
                    </tr>
                </tbody>
            </table>
        </div>
    </dialog>
}

const BookmarkDialog = () => {
    type Bookmark = { id: MessageId, content: String, note: String, createdAt: string, modifiedAt: string }
    const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
    useEffect(() => {
        useStore.setState({
            openBookmarkDialog: () => {
                db.select<Bookmark[]>("SELECT id, content, note, createdAt, modifiedAt FROM bookmark JOIN message ON message.id = bookmark.messageId ORDER BY createdAt DESC")
                    .then((res) => { setBookmarks(res) })
                document.querySelector<HTMLDialogElement>("#bookmark")!.showModal()
            }
        })
    }, [])
    return <dialog id="bookmark" class="p-0 bg-zinc-700 text-zinc-100 shadow-dark rounded-lg" onClick={(ev) => { ev.target === ev.currentTarget && ev.currentTarget.close() }}>
        <div class="px-20 py-8 w-fit">
            <h2 class="text-xl border-b mb-4 text-emerald-400 border-b-emerald-400">Bookmarks</h2>
            <table>
                <thead>
                    <tr>
                        <th>Date</th>
                        <th>Content</th>
                        {/* <th>Note</th> */}
                        {/* <th>Modified at</th> */}
                    </tr>
                </thead>
                <tbody>
                    {bookmarks.map((b) => <tr class="cursor-pointer hover:bg-zinc-600"
                        onClick={() => {
                            findParents(b.id).then(async (res) => {
                                await reload(res)
                                useStore.setState({ scrollIntoView: res.at(-1)! })
                            })
                        }}>
                        <td class="px-2 whitespace-nowrap">{b.createdAt}</td>
                        <td class="px-2 whitespace-nowrap max-w-[40vw] overflow-x-scroll py-4">{b.content}</td>
                        {/* <td class="px-2">{b.note}</td> */}
                        {/* <td class="px-2 whitespace-nowrap">{b.modifiedAt}</td> */}
                    </tr>)}
                </tbody>
            </table>
        </div>
    </dialog>
}

const InputVolumeIndicator = () => {
    const listening = useStore((s) => s.listening)
    const [volume, setVolume] = useState(0)
    const [transcribing, setTranscribing] = useState(false)
    useEffect(() => {
        let canceled = false
        const loop = async () => {
            if (canceled) { return }
            const value = await invoke("get_input_volume") as number
            if (value === -1) {
                setTranscribing(true)
            } else {
                setVolume(value * 250)
                setTranscribing(false)
            }
            setTimeout(loop, 100)
        }
        if (listening) { loop() }
        return () => { canceled = true }
    }, [listening])
    if (!listening) { return <></> }
    return <div class="absolute top-[35%] left-0 right-0 mx-0 text-center z-50 pointer-events-none">
        <div class="bg-white dark:bg-zinc-700 w-fit inline-block p-8 rounded-lg shadow-light dark:shadow-dark pointer-events-auto relative">
            <svg xmlns="http://www.w3.org/2000/svg" class="icon icon-tabler icon-tabler-x absolute right-3 top-3 cursor-pointer dark:stroke-slate-100" width="25" height="25" viewBox="0 0 24 24" stroke-width="1.25" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round"
                onClick={() => { invoke("cancel_listening") }}>
                <path stroke="none" d="M0 0h24v24H0z" fill="none"></path>
                <path d="M18 6l-12 12"></path>
                <path d="M6 6l12 12"></path>
            </svg>
            <svg xmlns="http://www.w3.org/2000/svg" class="icon icon-tabler icon-tabler-microphone inline-block dark:stroke-zinc-200" width="110" height="110" viewBox="0 0 24 24" stroke-width="1.25" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round">
                <path stroke="none" d="M0 0h24v24H0z" fill="none"></path>
                <path d="M9 2m0 3a3 3 0 0 1 3 -3h0a3 3 0 0 1 3 3v5a3 3 0 0 1 -3 3h0a3 3 0 0 1 -3 -3z"></path>
                <path d="M5 10a7 7 0 0 0 14 0"></path>
                <path d="M8 21l8 0"></path>
                <path d="M12 17l0 4"></path>
            </svg>
            {transcribing && <div class="dark:text-zinc-100">
                Transcribing...
            </div>}
            {!transcribing && <div class="h-3 w-44 mx-auto mt-4">
                <svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
                    <defs>
                        <pattern id="pattern_green" patternUnits="userSpaceOnUse" width="13" height="13" patternTransform="rotate(0)">
                            <line x1="0" y="0" x2="0" y2="13" stroke="#194d70" stroke-width="18" />
                        </pattern>
                        <pattern id="pattern_gray" patternUnits="userSpaceOnUse" width="13" height="13" patternTransform="rotate(0)">
                            <line x1="0" y="0" x2="0" y2="13" stroke="#aaaaaa" stroke-width="18" />
                        </pattern>
                    </defs>
                    <rect width={Math.round(volume) + "%"} height="100%" fill="url(#pattern_green)" opacity="1" />
                    <rect x={Math.round(volume) + "%"} width={(100 - Math.round(volume)) + "%"} height="100%" fill="url(#pattern_gray)" opacity="1" />
                </svg>
            </div>}
            {!transcribing && <div class="w-fit dark:text-zinc-100 px-4 mx-auto mt-4 rounded-lg shadow-light dark:shadow-dark cursor-pointer border border-zinc-200 dark:border-zinc-600 bg-white dark:bg-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-600"
                onClick={() => {
                    invoke("stop_listening")
                }}>
                <svg xmlns="http://www.w3.org/2000/svg" class="icon icon-tabler icon-tabler-player-stop inline-block [transform:translateY(-1px)] mr-1" width="20" height="20" viewBox="0 0 24 24" stroke-width="1.25" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round">
                    <path stroke="none" d="M0 0h24v24H0z" fill="none"></path>
                    <path d="M17 4h-10a3 3 0 0 0 -3 3v10a3 3 0 0 0 3 3h10a3 3 0 0 0 3 -3v-10a3 3 0 0 0 -3 -3z" stroke-width="0" fill="currentColor"></path>
                </svg>
                stop
            </div>}
        </div>
    </div>
}

const findParents = async (id: MessageId) => {
    return (await db.select<{ id: number }[]>(findParentsSQL, [id])).reverse().map((v) => v.id)
}

const SearchResult = () => {
    const search = useStore((s) => s.search)
    const [messages, setMessages] = useState<{ id: number, content: string }[]>([])
    useEffect(() => {
        if (search.length === 0) {
            setMessages([])
            return
        }
        (async () => {
            setMessages(await db.select<{ id: number, content: string }[]>("SELECT id, content FROM message WHERE content LIKE ?", ["%" + search + "%"]))
        })()
    }, [search])
    return <>{messages.map((message) => {
        return <div key={message.id} class="pl-8 py-2 mb-1 cursor-pointer rounded-lg overflow-x-hidden relative hover:bg-zinc-600"
            onClick={() => {
                findParents(message.id).then(async (res) => {
                    await reload(res)
                    useStore.setState({ scrollIntoView: res.at(-1)! })
                })
            }}>
            {getHighlightedText(message.content.slice(message.content.toLowerCase().indexOf(search.toLowerCase())), search)}
        </div>
    })}</>
}

const TokenCounter = (props: { textareaRef: Ref<HTMLTextAreaElement> }) => {
    const [count, setCount] = useState(0)
    useEffect(() => {
        let stop = false
        const loop = async () => {
            if (stop) { return }
            setCount(await invoke<number>("count_tokens", {
                content: [...useStore.getState().visibleMessages.map((v) => v.content), props.textareaRef.current?.value ?? ""].join(" "),
            }))
            setTimeout(loop, 500)
        }
        loop()
        return () => { stop = true }
    }, [props.textareaRef])
    return <span class="inline-block bg-zinc-300 py-1 px-3 ml-4 mb-2 text-zinc-600 rounded">{count}</span>
}

type AzureVoiceInfo = {
    Name: string  // 'Microsoft Server Speech Text to Speech Voice (af-ZA, AdriNeural)'
    DisplayName: string  // 'Adri'
    LocalName: string  // 'Adri'
    ShortName: string  // 'af-ZA-AdriNeural'
    Gender: string  // 'Female'
    Locale: string  // 'af-ZA'
    LocaleName: string  // 'Afrikaans (South Africa)'
    SampleRateHertz: string  // '48000'
    VoiceType: string  // 'Neural'
    Status: string  // 'GA'
    WordsPerMinute: string  // '147'
}

const SpeechToTextDialog = () => {
    const whisperLanguage = useConfigStore((s) => s.whisperLanguage)
    const editVoiceInputBeforeSending = useConfigStore((s) => !!s.editVoiceInputBeforeSending)
    return <dialog id="speech-to-text" class="p-0 bg-zinc-700 text-zinc-100 shadow-dark rounded-lg" onClick={(ev) => { ev.target === ev.currentTarget && ev.currentTarget.close() }}>
        <div class="px-20 py-8 w-fit">
            <h2 class="text-xl border-b mb-3 text-emerald-400 border-b-emerald-400">Speech to text</h2>
            <h3 class="font-semibold my-2">Keybinding</h3>
            <ul>
                <li>Start <code class="ml-2">Ctrl (or Cmd) + Shift + V</code></li>
                <li>Stop <code class="ml-2">Ctrl (or Cmd) + Shift + V</code></li>
                <li>Cancel <code class="ml-2">Ctrl (or Cmd) + Shift + S</code></li>
            </ul>
            <h3 class="font-semibold my-2">Language</h3>
            <input value={whisperLanguage} onChange={(ev) => { useConfigStore.setState({ whisperLanguage: ev.currentTarget.value }) }} class="mb-1 shadow-light text-zinc-600 dark:shadow-none rounded font-mono px-4 dark:bg-zinc-600 dark:text-zinc-100" placeholder="en"></input>
            <p>
                Specify <a class="cursor-pointer text-blue-300 border-b border-b-blue-300 whitespace-nowrap" onClick={() => { open("https://en.wikipedia.org/wiki/List_of_ISO_639-1_codes") }}>ISO-639-1 language code</a> for improved performance.
            </p>
            <h3 class="font-semibold my-2">Edit text before sending</h3>
            <select class="text-zinc-600 px-2" value={editVoiceInputBeforeSending ? "enabled" : "disabled"} onChange={(ev) => { useConfigStore.setState({ editVoiceInputBeforeSending: ev.currentTarget.value === "enabled" ? 1 : 0 }) }}>
                <option value="enabled">yes</option>
                <option value="disabled">no</option>
            </select>
        </div>
    </dialog>
}

const TextToSpeechDialog = () => {
    const azureTTSRegion = useConfigStore((s) => s.azureTTSRegion)
    const azureTTSResourceKey = useConfigStore((s) => s.azureTTSResourceKey)
    const azureTTSVoice = useConfigStore((s) => s.azureTTSVoice)
    const pico2waveVoice = useConfigStore((s) => s.pico2waveVoice)
    const ttsBackend = useConfigStore((s) => s.ttsBackend)
    const webSpeechAPILang = useConfigStore((s) => s.webSpeechAPILang)
    const webSpeechAPIPitch = useConfigStore((s) => s.webSpeechAPIPitch)
    const webSpeechAPIRate = useConfigStore((s) => s.webSpeechAPIRate)
    const [voiceList, setVoiceList] = useState<AzureVoiceInfo[]>([])
    const [isPasswordVisible, setIsPasswordVisible] = useState(false)
    const audioFeedback = useConfigStore((s) => s.audioFeedback)
    const getVoiceList = async () => {
        if (!azureTTSRegion || !/^[a-z0-9_\-]+$/i.test(azureTTSRegion) || !azureTTSResourceKey) { return }
        const res = await fetch<AzureVoiceInfo[]>(`https://${azureTTSRegion}.tts.speech.microsoft.com/cognitiveservices/voices/list`, { method: "GET", headers: { "Ocp-Apim-Subscription-Key": azureTTSResourceKey } })
        if (!res.ok) { return }
        setVoiceList(res.data)
    }

    return <dialog id="text-to-speech" class="p-0 bg-zinc-700 text-zinc-100 shadow-dark rounded-lg" onClick={(ev) => { ev.target === ev.currentTarget && ev.currentTarget.close() }}>
        <div class="px-20 py-8 w-fit">
            <h2 class="text-xl border-b mb-3 text-emerald-400 border-b-emerald-400">Output Device</h2>
            <button class="mb-6 inline rounded border border-green-700 dark:border-green-700 text-sm px-3 py-1 text-white bg-green-600 hover:bg-green-500 disabled:bg-zinc-400" onClick={() => { invoke("sound_test") }}>Test speaker</button>
            <button class="mb-6 inline rounded border border-green-700 dark:border-green-700 text-sm px-3 py-1 text-white bg-green-600 hover:bg-green-500 disabled:bg-zinc-400 ml-2" onClick={() => { useStore.getState().ttsQueue.speakText(null, null) }}>Test text-to-speech</button>
            <h2 class="text-xl border-b mb-3 text-emerald-400 border-b-emerald-400">Text-to-speech</h2>
            <span class="mr-2">Backend</span><select value={ttsBackend} class="px-2 text-zinc-600" onChange={(ev) => { useConfigStore.setState({ ttsBackend: ev.currentTarget.value as any }) }}>
                <option value="off">Disabled</option>
                <option value="pico2wave">pico2wave</option>
                <option value="web-speech-api" disabled={!window.speechSynthesis}>Web Speech API {window.speechSynthesis ? "" : "(undetected)"}</option>
                <option value="azure">Microsoft Azure Text-to-speech API</option>
            </select>
            {ttsBackend === "pico2wave" && <div>
                <table class="border-separate border-spacing-2">
                    <tbody>
                        <tr>
                            <td>Installation (Debian/Ubuntu)</td>
                            <td><code class="select-text">sudo apt install -y libttspico-utils</code></td>
                        </tr>
                        <tr>
                            <td>Voice</td>
                            <td><select value={pico2waveVoice} onChange={(ev) => { useConfigStore.setState({ pico2waveVoice: ev.currentTarget.value as any }) }} class="text-zinc-600 px-2">
                                <option value="en-US">en-US</option>
                                <option value="en-GB">en-GB</option>
                                <option value="de-DE">de-DE</option>
                                <option value="es-ES">es-ES</option>
                                <option value="fr-FR">fr-FR</option>
                                <option value="it-IT">it-IT</option>
                            </select></td>
                        </tr>
                    </tbody>
                </table>
            </div>}
            {ttsBackend === "azure" && <>
                <table class="border-separate border-spacing-2">
                    <tbody>
                        <tr>
                            <td>Region</td>
                            <td><input
                                value={azureTTSRegion}
                                onInput={(ev) => { useConfigStore.setState({ azureTTSRegion: ev.currentTarget.value }) }}
                                autocomplete="off"
                                class="shadow-light text-zinc-600 dark:shadow-none rounded font-mono px-4 dark:bg-zinc-600 dark:text-zinc-100" placeholder="eastus"></input></td>
                        </tr>
                        <tr>
                            <td>Resource key</td>
                            <td>
                                <input
                                    value={azureTTSResourceKey}
                                    onInput={(ev) => { useConfigStore.setState({ azureTTSResourceKey: ev.currentTarget.value }) }}
                                    type={isPasswordVisible ? "" : "password"}
                                    autocomplete="off"
                                    class="shadow-light text-zinc-600 dark:shadow-none rounded font-mono px-4 dark:bg-zinc-600 dark:text-zinc-100"
                                    placeholder="12345abcd567890ef"></input>
                                <button class="ml-2 px-2 bg-zinc-500 hover:bg-zinc-600"
                                    onClick={() => { setIsPasswordVisible((s) => !s) }}>View</button>
                            </td>
                        </tr>
                        <tr>
                            <td>Voice</td>
                            <td class="whitespace-nowrap">
                                {voiceList.length === 0 && <span class="bg-zinc-200 px-4 text-zinc-600 inline-block rounded">{azureTTSVoice}</span>}
                                {voiceList.length > 0 && <select value={azureTTSVoice} class="text-zinc-600 pl-2 rounded" onChange={(ev) => {
                                    useConfigStore.setState({
                                        azureTTSVoice: ev.currentTarget.value,
                                        azureTTSLang: voiceList.find((v) => v.ShortName === ev.currentTarget.value)!.Locale,
                                    })
                                }}>{voiceList.map((value) => <option value={value.ShortName}>{value.ShortName}, {value.LocalName}, {value.LocaleName}</option>)}</select>}
                                <button
                                    class="ml-2 inline rounded border border-green-700 dark:border-green-700 text-sm px-3 py-1 text-white bg-green-600 hover:bg-green-500 disabled:bg-zinc-400"
                                    onClick={() => { getVoiceList() }}>Edit</button>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </>}
            {ttsBackend === "web-speech-api" && <>
                <table class="border-separate border-spacing-2">
                    <tbody>
                        <tr>
                            <td>Language</td>
                            <td><input
                                value={webSpeechAPILang}
                                onInput={(ev) => {
                                    useConfigStore.setState({ webSpeechAPILang: ev.currentTarget.value })
                                }}
                                autocomplete="off"
                                class="shadow-light text-zinc-600 dark:shadow-none rounded font-mono px-4 dark:bg-zinc-600 dark:text-zinc-100"
                                placeholder="en-US"></input></td>
                        </tr>
                        <tr>
                            <td>Pitch</td>
                            <td><input
                                value={("" + webSpeechAPIPitch).includes(".") ? webSpeechAPIPitch : webSpeechAPIPitch.toFixed(1)}
                                onInput={(ev) => {
                                    if (!Number.isFinite(+ev.currentTarget.value!)) { return }
                                    useConfigStore.setState({ webSpeechAPIPitch: +ev.currentTarget.value })
                                }}
                                autocomplete="off"
                                class="shadow-light text-zinc-600 dark:shadow-none rounded font-mono px-4 dark:bg-zinc-600 dark:text-zinc-100"
                                placeholder="1.0"></input></td>
                        </tr>
                        <tr>
                            <td>Rate</td>
                            <td><input
                                value={("" + webSpeechAPIRate).includes(".") ? webSpeechAPIRate : webSpeechAPIRate.toFixed(1)}
                                onInput={(ev) => {
                                    if (!Number.isFinite(+ev.currentTarget.value!)) { return }
                                    useConfigStore.setState({ webSpeechAPIRate: +ev.currentTarget.value })
                                }}
                                autocomplete="off"
                                class="shadow-light text-zinc-600 dark:shadow-none rounded font-mono px-4 dark:bg-zinc-600 dark:text-zinc-100"
                                placeholder="1.0"></input></td>
                        </tr>
                    </tbody>
                </table>
            </>}
            <h2 class="text-xl border-b mt-6 mb-3 text-emerald-400 border-b-emerald-400">Audio Feedback</h2>
            <select class="px-2 text-zinc-600" value={audioFeedback ? "on" : "off"} onChange={(ev) => { useConfigStore.setState({ audioFeedback: ev.currentTarget.value === "on" ? 1 : 0 }) }}>
                <option value="on">enabled</option>
                <option value="off">disabled</option>
            </select>
        </div>
    </dialog>
}

const getTokenUsage = (now = new Date()) => db.select<{ model: string, sum: number, count: number }[]>(getTokenUsageSQL, [now.toISOString()])

const BudgetDialog = () => {
    const [totalTokens, setTotalTokens] = useState<{ model: string, sum: number, count: number }[]>([])
    const [totalTTSCharacters, setTotalTTSCharacters] = useState<number>(-1)
    const [totalSpeechToTextMinutes, setTotalSpeechToTextMinutes] = useState<number>(-1)
    const budget = useConfigStore((s) => s.budget)
    const maxCostPerMessage = useConfigStore((s) => s.maxCostPerMessage)
    const [month, setMonth] = useState("")

    useEffect(() => {
        useStore.setState({
            openUsageDialog: async () => {
                const now = new Date()
                setMonth(Intl.DateTimeFormat("en-US", { year: "numeric", month: "long" }).format(now))
                setTotalTokens(await getTokenUsage(now))
                setTotalTTSCharacters((await db.select<{ count: number }[]>(`\
SELECT
    coalesce(sum(numCharacters), 0) as count
FROM textToSpeechUsage
WHERE date(timestamp, 'start of month') = date(?, 'start of month')`, [now.toISOString()]))[0]?.count ?? 0)
                setTotalSpeechToTextMinutes(((await db.select<{ sumMs: number }[]>(`\
SELECT
    coalesce(sum(durationMs), 0) as sumMs
FROM speechToTextUsage
WHERE date(timestamp, 'start of month') = date(?, 'start of month')`, []))[0]?.sumMs ?? 0) / 1000 / 60)
                document.querySelector<HTMLDialogElement>("#budget")?.showModal()
            }
        })
    }, [])

    return <dialog id="budget" class="p-0 bg-zinc-700 text-zinc-100 shadow-dark rounded-lg"
        onClick={(ev) => { ev.target === ev.currentTarget && ev.currentTarget.close() }}>
        <div class="px-20 py-8 w-fit">
            <h2 class="text-xl border-b mb-4 text-emerald-400 border-b-emerald-400">Budget</h2>
            <table class="border-separate border-spacing-2 w-full">
                <tr><td>
                    Max cost per month<br />
                    <span class="text-xs">Alerts and temporary disables the application when usage exceeds this amount.</span>
                </td><td>$ <input class="bg-zinc-600 pl-2 rounded" value={("" + budget).includes(".") ? budget : budget.toFixed(1)} onInput={(ev) => {
                    if (!Number.isFinite(+ev.currentTarget.value!)) { return }
                    useConfigStore.setState({ budget: +ev.currentTarget.value! })
                }}></input></td></tr>
                <tr><td>
                    Max cost per message<br />
                    <span class="text-xs">Excludes past messages from the request to keep the cost below this value.</span>
                </td><td>
                        $ <input class="bg-zinc-600 pl-2 rounded" value={("" + maxCostPerMessage).includes(".") ? maxCostPerMessage : maxCostPerMessage.toFixed(1)} onInput={(ev) => {
                            if (!Number.isFinite(+ev.currentTarget.value!)) { return }
                            useConfigStore.setState({ maxCostPerMessage: +ev.currentTarget.value })
                        }}></input> =
                        {Math.floor(maxCostPerMessage / chatGPTPricePerToken)} tokens
                    </td></tr>
            </table>
            <h2 class="text-xl border-b mb-4 mt-8 text-emerald-400 border-b-emerald-400">ChatGPT Usage ({month})</h2>
            <table class="mx-auto">
                <thead class="[&_th]:px-4">
                    <tr class="border-b border-b-zinc-300"><th>Model</th><th>Tokens</th><th>Price [USD]</th><th>Requests</th></tr>
                </thead>
                <tbody class="[&_td]:px-4">
                    {totalTokens.map((v) => <tr class="select-text"><td class="text-left">{v.model}</td><td class="text-right">{v.sum}</td><td class="text-right">{(v.model === "gpt-3.5-turbo" ? (v.sum * chatGPTPricePerToken).toFixed(6) : "?")}</td><td class="text-right">{v.count}</td></tr>)}
                </tbody>
            </table>
            <h2 class="text-xl border-b mb-4 mt-8 text-emerald-400 border-b-emerald-400">Text-to-speech Usage ({month})</h2>
            <table class="mx-auto">
                <thead class="[&_th]:px-4">
                    <tr class="border-b border-b-zinc-300"><th>Backend</th><th>Characters</th><th>F0 Free Tier (per month)</th><th>S0 Standard Tier [USD]</th></tr>
                </thead>
                <tbody class="[&_td]:px-4">
                    <tr class="select-text"><td>Azure</td><td class="text-left">{totalTTSCharacters}</td><td class="text-right">{totalTTSCharacters} / 500000 ({(totalTTSCharacters / 500000 * 100).toFixed(1)}%)</td><td class="text-right">{(totalTTSCharacters / 1000000 * 16).toFixed(6)}</td></tr>
                </tbody>
            </table>
            <h2 class="text-xl border-b mb-4 mt-8 text-emerald-400 border-b-emerald-400">Speech-to-text Usage ({month})</h2>
            <table class="mx-auto">
                <thead class="[&_th]:px-4">
                    <tr class="border-b border-b-zinc-300"><th>Model</th><th>Usage [min]</th><th>Price [USD]</th></tr>
                </thead>
                <tbody class="[&_td]:px-4">
                    <tr class="select-text"><td>whisper-1</td><td>{totalSpeechToTextMinutes.toFixed(1)}</td><td>{(totalSpeechToTextMinutes * 0.006).toFixed(3)}</td></tr>
                </tbody>
            </table>
            <div class="mt-8 italic text-zinc-300">The pricing information provided by this software is an estimate, and the hard-coded prices can be out of date.</div>
        </div>
    </dialog>
}

const regenerateResponse = async () => {
    const s = useStore.getState()
    await completeAndAppend(s.visibleMessages.slice(0, -1).map((v) => v.id))
}

/** Regenerates an assistant's message. */
const RegenerateResponse = () => {
    const reversed = useConfigStore((s) => !!s.reversedView)
    const canRegenerateResponse = useStore((s) => s.visibleMessages.length >= 2 && s.visibleMessages.at(-1)?.role === "assistant")
    const waitingAssistantsResponse = useStore((s) => s.waitingAssistantsResponse.includes(s.visibleMessages.at(-1)?.id as number))
    if (waitingAssistantsResponse) {
        return <div class={"border border-zinc-200 dark:border-zinc-600 bg-white dark:bg-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-600 cursor-pointer w-fit px-3 py-2 rounded-lg absolute left-0 right-0 mx-auto text-center bottom-full text-sm " + (reversed ? "top-full mt-2 h-fit" : "mb-2")} onClick={() => {
            invoke("stop_all_chat_completions")
        }}>
            <svg xmlns="http://www.w3.org/2000/svg" class="icon icon-tabler icon-tabler-player-stop inline mr-2" width="18" height="18" viewBox="0 0 24 24" stroke-width="1.25" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round">
                <path stroke="none" d="M0 0h24v24H0z" fill="none"></path>
                <path d="M5 5m0 2a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2z"></path>
            </svg>
            Stop generating
        </div>
    }
    if (canRegenerateResponse) {
        return <div class={"border border-zinc-200 dark:border-zinc-600 bg-white dark:bg-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-600 cursor-pointer w-fit px-3 py-2 rounded-lg absolute left-0 right-0 mx-auto text-center bottom-full text-sm " + (reversed ? "top-full mt-2 h-fit" : "mb-2")} onClick={regenerateResponse}>
            <svg xmlns="http://www.w3.org/2000/svg" class="icon icon-tabler icon-tabler-refresh inline mr-2" width="18" height="18" viewBox="0 0 24 24" stroke-width="1.25" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round">
                <path stroke="none" d="M0 0h24v24H0z" fill="none"></path>
                <path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4"></path>
                <path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"></path>
            </svg>
            Regenerate response
        </div>
    }
    return <></>
}

/** The entry point. */
const main = async () => {
    db = await Database.load("sqlite:chatgpt_tauri.db")
    await db.execute(createTablesSQL)
    await reload([])
    await loadConfig()

    // Theme
    const applyTheme = () => {
        const theme = useConfigStore.getState().theme
        if (theme === "dark" || theme === "automatic" && window.matchMedia('(prefers-color-scheme: dark)').matches) {
            document.documentElement.classList.add("dark")
            localStorage.setItem("theme", "dark")
        } else {
            document.documentElement.classList.remove("dark")
            localStorage.setItem("theme", "light")
        }
    }
    applyTheme()
    useConfigStore.subscribe((state, prev) => { if (state.theme !== prev.theme) { applyTheme() } })
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener("change", () => { applyTheme() })

    const args = (await getMatches()).args
    render(<App prompt={typeof args.prompt?.value === "string" ? args.prompt.value : undefined} send={args.send?.occurrences === 1} voiceInput={args["voice-input"]?.occurrences === 1} />, document.body)
}

// Zoom in/out with ctrl(cmd)+plus/minus
{
    let zoomLevel = 0
    window.addEventListener("keydown", (ev) => {
        if (ctrlOrCmd(ev) && ev.key === "+") {
            zoomLevel++
            document.documentElement.style.fontSize = Math.round(1.2 ** zoomLevel * 100) + "%"
        }
        if (ctrlOrCmd(ev) && ev.key === "-") {
            zoomLevel--
            document.documentElement.style.fontSize = Math.round(1.2 ** zoomLevel * 100) + "%"
        }
    })
}

main().catch(console.error)
