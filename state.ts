import { clipboard, invoke as _invoke } from "@tauri-apps/api"
import { open, Command } from '@tauri-apps/api/shell'
import { create } from "zustand"
import Database from "tauri-plugin-sql-api"
import PQueue from "p-queue"
// @ts-ignore
import getTokenUsageSQL from "./get_token_usage.sql?raw"
// @ts-ignore
import createTablesSQL from "./create_tables.sql?raw"
// @ts-ignore
import findParentsSQL from "./find_parents.sql?raw"
import "element.scrollintoviewifneeded-polyfill"
import Toastify from "toastify-js"

type ChatMLMessage = { role: "assistant" | "user" | "system", name?: string, content: string }

export const invoke = _invoke as any as {
    (cmd: "sound_test"): Promise<void>
    (cmd: "sound_focus_input"): Promise<void>
    (cmd: "sound_waiting_text_completion"): Promise<void>
    (cmd: "speak_azure", args: { messageId: number | null, region: string, resourceKey: string, ssml: string, beepVolume: number, preFetch: boolean, noCache: boolean }): Promise<string>
    (cmd: "count_tokens", args: { content: string }): Promise<number>
    (cmd: "speak_pico2wave", args: { content: string, lang: string }): Promise<void>
    (cmd: "get_input_loudness"): Promise<number>
    (cmd: "start_listening", args: { openaiKey: string, language: string }): Promise<string>
    (cmd: "stop_listening"): Promise<void>
    (cmd: "cancel_listening"): Promise<void>
    (cmd: "start_chat_completion", args: { requestId: number, secretKey: string, body: string, endpoint: string, apiKeyAuthentication: boolean }): Promise<undefined>
    (cmd: "stop_all_chat_completions"): Promise<void>
    (cmd: "get_chat_completion", args: { requestId: number }): Promise<string[]>
    (cmd: "stop_audio"): Promise<void>
    (cmd: "count_tokens_gpt3_5_turbo_0301", args: { messages: ChatMLMessage[] }): Promise<number>
}

class Canceled extends Error { }

window.addEventListener("unhandledrejection", (err) => {
    if (err.reason instanceof Canceled) { return }
    const text = err.reason + ""
    const toast = Toastify({
        text,
        duration: -1,
        close: true,
        onClick: () => {
            clipboard.writeText(text);
            (toast.toastElement as HTMLElement).innerText = "Copied!"
            setTimeout(() => {
                toast.hideToast()
            }, 1000)
        },
    })
    toast.showToast()
})

/** Database connection. */
export let db: { current: Database } = {} as any

type PartialMessage = {
    content: string
    role: "user" | "assistant" | "system" | "root"
    status: /* loading */-1 | /* success */0 | /* error */1
}

export type MessageId = number

type Message = PartialMessage & {
    id: MessageId
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
    private preparationQueue = new PQueue({ concurrency: 1 })
    private audioQueue = new PQueue({ concurrency: 1 })
    private readonly rejectedTtsIds = new Set<number>()
    private ttsId: number | null = null

    /** Clears the queue. */
    async cancel() {
        await invoke("stop_audio")
        if (window.speechSynthesis) {
            try { window.speechSynthesis.cancel() } catch { }
        }
        // .clear() does not work because it does not remove the running queue entry
        this.preparationQueue = new PQueue({ concurrency: 1 })
        this.audioQueue = new PQueue({ concurrency: 1 })
    }

    /** Clears the queue and enqueues the text. */
    async speakText(content: string | null, messageIdForDeletion: MessageId | null, noCache = false) {
        await this.cancel()
        this.ttsId = null
        await (await this.prepare(content, messageIdForDeletion, noCache))?.()
    }

    /** Enqueues a text if the given textId is the same as the previous one. */
    async pushSegment(ttsId: number, content: string, messageIdForDeletion: MessageId | null) {
        if (this.rejectedTtsIds.has(ttsId)) { return }
        if (this.ttsId !== ttsId) {
            this.preparationQueue = new PQueue({ concurrency: 1 })
            this.audioQueue = new PQueue({ concurrency: 1 })
            this.ttsId = ttsId
        }
        const speak = this.preparationQueue.add(() => this.prepare(content, messageIdForDeletion))
        this.audioQueue.add(async () => {
            await (await speak)?.()
        }).catch((err) => {
            if (this.rejectedTtsIds.has(ttsId)) { return }
            this.rejectedTtsIds.add(ttsId)
            throw err
        })
    }

    private async prepare(content: string | null, messageIdForDeletion: MessageId | null, noCache: boolean = false): Promise<(() => Promise<void>) | void> {
        console.log(`text-to-speech: ${content?.length ?? "-"} characters`)
        if (content?.trim() === "") { return }
        const { ttsBackend, azureTTSRegion, azureTTSResourceKey, azureTTSVoice, azureTTSLang, pico2waveVoice, webSpeechAPILang, webSpeechAPIRate, webSpeechAPIVoice, webSpeechAPIPitch } = useConfigStore.getState()
        switch (ttsBackend) {
            case "off": {
                break
            } case "web-speech-api": {
                if (!window.speechSynthesis) { return }
                return async () => {
                    speechSynthesis.cancel()
                    const utterance = new SpeechSynthesisUtterance(content ?? "Web Speech API")
                    utterance.lang = webSpeechAPILang
                    utterance.pitch = webSpeechAPIPitch
                    utterance.rate = webSpeechAPIRate
                    const voice = webSpeechAPIVoice === "default" ? null : window.speechSynthesis.getVoices().find((v) => v.name === webSpeechAPIVoice)
                    if (voice) {
                        utterance.voice = voice
                    }
                    speechSynthesis.speak(utterance)
                    return new Promise<void>((resolve, reject) => {
                        utterance.addEventListener("end", () => { resolve() })
                        utterance.addEventListener("pause", () => { resolve() })
                        utterance.addEventListener("error", (ev) => {
                            switch (ev.error) {
                                case "interrupted": case "canceled":
                                    reject(new Canceled())
                                    break
                                default:
                                    reject(new Error(ev.error))
                            }
                        })
                    })
                }
            } case "pico2wave": {
                return async () => { await invoke("speak_pico2wave", { content: content ?? "pico2wave", lang: pico2waveVoice }) }
            } case "azure": {
                if (!azureTTSRegion || !/^[a-z0-9_\-]+$/i.test(azureTTSRegion) || !azureTTSResourceKey || !azureTTSVoice) { return }
                const pronouncedContent = content ?? "Microsoft Speech Service Text-to-Speech API"
                const ssml = `<speak version='1.0' xml:lang='${azureTTSLang}'><voice xml:lang='${azureTTSLang}' name='${azureTTSVoice}'>${pronouncedContent.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("'", "&apos;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</voice></speak>`

                // > You're billed for each character that's converted to speech, including punctuation. Although the SSML document itself is not billable, optional elements that are used to adjust how the text is converted to speech, like phonemes and pitch, are counted as billable characters.
                // > https://learn.microsoft.com/en-us/azure/cognitive-services/speech-service/speech-synthesis-markup
                await db.current.execute("INSERT INTO textToSpeechUsage (region, numCharacters) VALUES (?, ?)", [azureTTSRegion, pronouncedContent.length])

                await invoke("speak_azure", {
                    messageId: messageIdForDeletion,
                    region: azureTTSRegion,
                    resourceKey: azureTTSResourceKey,
                    ssml,
                    beepVolume: 0,
                    preFetch: true,
                    noCache,
                })
                return async () => {
                    await invoke("speak_azure", {
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

export const isMac = navigator.platform.startsWith("Mac")
export const isWindows = navigator.platform.startsWith("Win")
export const ctrlOrCmd = (ev: KeyboardEvent) => (isMac ? /* cmd */ev.metaKey : ev.ctrlKey)

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
    webSpeechAPIVoice: "default",
    reversedView: 0,
    whisperLanguage: "",
    editVoiceInputBeforeSending: 0,
    theme: "automatic" as "automatic" | "light" | "dark",
    sidebar: "automatic" as "automatic" | "hide" | "show",
    openaiProxyAPIKey: "",
    openaiProxyUrl: "",
    searchEngine: `https://www.google.com/search?q={searchTerms}`,
    zoomLevel: 0,
} satisfies Record<string, string | number>

const _useConfigStore = create<typeof defaultConfigValues>()(() => defaultConfigValues)
const _setState = _useConfigStore.setState
type AsyncStore<S> = {
    setState(partial: Partial<S>): Promise<void>
    getState(): S
    subscribe(callback: (state: S, previous: S) => void): void
    <U>(selector: (state: S) => U, equals?: (a: U, b: U) => boolean): U
}
export const useConfigStore: AsyncStore<typeof defaultConfigValues> = Object.assign(_useConfigStore, {
    setState: async (partial: Partial<typeof defaultConfigValues>) => {
        for (const [k, v] of Object.entries(partial)) {
            await db.current.execute("INSERT OR REPLACE INTO config VALUES (?, ?)", [k, v])
        }
        _setState.call(_useConfigStore, partial)
    }
})

/** Initializes the useConfigStore. */
const loadConfig = async () => {
    // Retrieve data from the database
    const obj = Object.fromEntries((await db.current.select<{ key: string, value: string }[]>("SELECT key, value FROM config", []))
        .map(({ key, value }) => [key, typeof defaultConfigValues[key as keyof typeof defaultConfigValues] === "number" ? +value : value]))

    // Set default values
    for (const [k, v] of Object.entries(defaultConfigValues)) {
        if (!(k in obj)) {
            obj[k] = v
        }
    }

    await useConfigStore.setState(obj)
}

export const init = async () => {
    db.current = await Database.load("sqlite:chatgpt_tauri.db")
    await db.current.execute(createTablesSQL)
    await reload([])
    await loadConfig()

    const { sidebar } = useConfigStore.getState()
    useStore.setState({ isSideBarOpen: sidebar === "show" || sidebar === "automatic" && window.innerWidth > 800 })
}

export type State = {
    waitingAssistantsResponse: MessageId[]
    threads: { id: MessageId, name: string | null }[]
    visibleMessages: (Message & { children: Message[] })[]
    search: string
    folded: Set<MessageId>
    scrollIntoView: MessageId | null
    listening: boolean
    ttsQueue: TextToSpeechQueue
    isSideBarOpen: boolean
    editing: Set<MessageId>
    renamingThread: MessageId | null
    shouldDisplayAPIKeyInputOverride: boolean
    openUsageDialog: () => void
    openBookmarkDialog: () => void
}

let _useStore = create<State>()(() => ({
    waitingAssistantsResponse: [],
    threads: [],
    visibleMessages: [],
    password: "",
    search: "",
    folded: new Set(),
    scrollIntoView: null,
    listening: false,
    ttsQueue: new TextToSpeechQueue(),
    isSideBarOpen: false,
    editing: new Set(),
    renamingThread: null,
    shouldDisplayAPIKeyInputOverride: false,
    openUsageDialog: () => { },
    openBookmarkDialog: () => { }
}))

// @ts-ignore
if (import.meta.env.DEV) { window.useStore = _useStore = (window.useStore ?? _useStore) }
export const useStore = _useStore

const getChatInput = () => document.querySelector<HTMLTextAreaElement>("#userPromptTextarea")
const speakIfAudioFeedbackIsEnabled = (content: string) => { if (useConfigStore.getState().audioFeedback) { useStore.getState().ttsQueue.speakText(content, null) } }
const setTextareaValueAndAutoResize = (textarea: HTMLTextAreaElement, value: string) => {
    textarea.value = value
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true }))
}

/**
 * Reloads everything from the database.
 * @param path - specifies which messages to display. If path is [], no thread is shown. Otherwise, the best matching thread is shown.
 */
const reload = async (path: MessageId[]) => {
    const visibleMessages: (Message & { children: Message[] })[] = []
    let node = path.length === 0 ? undefined : (await db.current.select<Message[]>("SELECT * FROM message LEFT OUTER JOIN bookmark ON message.id = bookmark.messageId WHERE id = ?", [path[0]!]))[0]
    let depth = 1
    while (node) {
        const children = await db.current.select<Message[]>("SELECT * FROM message LEFT OUTER JOIN bookmark ON message.id = bookmark.messageId WHERE parent = ?", [node.id])
        visibleMessages.push({ ...node, children })
        node = children.find((v) => v.id === path[depth]) ?? children.at(-1)
        depth++
    }

    useStore.setState({ visibleMessages })
    db.current.select<{ id: number, name: string | null }[]>("SELECT message.id as id, threadName.name as name FROM message LEFT OUTER JOIN threadName ON message.id = threadName.messageId WHERE message.parent IS NULL ORDER BY message.createdAt DESC")
        .then((threads) => { useStore.setState({ threads }) })

}

export const chatGPTPricePerToken = 0.002 / 1000

export const getTokenUsage = (now = new Date()) => db.current.select<{ model: string, sum: number, count: number }[]>(getTokenUsageSQL, [now.toISOString()])

/** Generates an assistant's response. */
const complete = async (messages: readonly Pick<PartialMessage, "role" | "content">[], handleStream?: (content: string, delta: string) => Promise<void>): Promise<PartialMessage> => {
    try {
        const usage = await getTokenUsage()
        if (
            usage.map((v) => v.model === "gpt-3.5-turbo" ? v.sum * chatGPTPricePerToken : 0).reduce((a, b) => a + b, 0)
            >= +(await db.current.select<{ value: number }[]>("SELECT value FROM config WHERE key = 'budget'"))[0]!.value
        ) {
            return { role: "assistant", status: 1, content: "Monthly budget exceeded." }
        }

        const maxCostPerMessage = +(await db.current.select<{ value: number }[]>("SELECT value FROM config WHERE key = 'maxCostPerMessage'"))[0]!.value
        const messagesFed = messages
            .flatMap((v) => v.role === "root" ? [] : [{ role: v.role, content: v.content }])
            .map((v) => ({ role: v.role, content: v.content }))
        let numParentsFed = -1 // all

        // Drop messages
        const expectedGeneratedTokenCount = 150
        let omitted = false
        while (true) {
            // TODO: performance optimization
            const tokens = await invoke("count_tokens_gpt3_5_turbo_0301", { messages: messagesFed }) + expectedGeneratedTokenCount
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
        let err: string | null | undefined
        const requestId = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)
        const dataFetchPromise = new Promise<PartialMessage & { role: "assistant" }>((resolve, reject) => {
            const result: PartialMessage & { role: "assistant" } = { content: "", role: "assistant", status: 0 }
            const loop = async () => {
                const done2 = done
                try {
                    let delta = ""
                    for (const v of await invoke("get_chat_completion", { requestId })) {
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
                err = await invoke("start_chat_completion", {
                    requestId,
                    secretKey: azureAPIKey,
                    body: JSON.stringify({
                        prompt: messagesFed.map((v) => `<|im_start|>${v.role}\n${v.content}\n<|im_end|>\n`).join("") + "<|im_start|>assistant",
                        stream: true,
                        stop: ["<|im_end|>"],
                    }),
                    endpoint: azureEndpoint,
                    apiKeyAuthentication: !!azureApiKeyAuthentication,
                }).catch((err) => err + "")
            } else if (openaiService === "openai-proxy") {
                err = await invoke("start_chat_completion", {
                    requestId,
                    secretKey: openaiProxyAPIKey,
                    body: JSON.stringify({
                        model,
                        messages: messagesFed,
                        stream: true,
                    }),
                    endpoint: openaiProxyUrl,
                    apiKeyAuthentication: false,
                }).catch((err) => err + "")
            } else {  // openai
                err = await invoke("start_chat_completion", {
                    requestId,
                    secretKey: APIKey,
                    body: JSON.stringify({
                        model,
                        messages: messagesFed,
                        stream: true,
                    }),
                    endpoint: "https://api.openai.com/v1/chat/completions",
                    apiKeyAuthentication: false,
                }).catch((err) => err + "")
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
                invoke("count_tokens_gpt3_5_turbo_0301", { messages: messagesFed }),
                invoke("count_tokens_gpt3_5_turbo_0301", { messages: [result] })
            ]).then(([promptTokens, completionTokens]) => {
                completionTokens -= 4 // "<im_start>" "assistant" "<im_start>" "assistant"
                db.current.execute("INSERT INTO textCompletionUsage (model, prompt_tokens, completion_tokens, total_tokens) VALUES (?, ?, ?, ?)", [model, promptTokens, completionTokens, promptTokens + completionTokens])
            })
            return result
        }
    } catch (err) {
        console.error(err)
        return { role: "assistant", status: 1, content: err instanceof Error ? err.message : err + "" }
    }
}

/** Appends a message to the thread and returns its path. */
const appendMessage = async (parents: readonly number[], message: Readonly<PartialMessage>) => {
    let id: number
    if (parents.length === 0) {
        // fixes: cannot store TEXT value in INTEGER column message.parent
        id = (await db.current.execute("INSERT INTO message (parent, role, status, content) VALUES (NULL, ?, ?, ?) RETURNING id", [message.role, message.status, message.content])).lastInsertId
    } else {
        id = (await db.current.execute("INSERT INTO message (parent, role, status, content) VALUES (?, ?, ?, ?) RETURNING id", [parents.at(-1)!, message.role, message.status, message.content])).lastInsertId
    }
    await reload([...parents, id])
    return [...parents, id]
}

export const extractFirstCodeBlock = (content: string) => /```[^\n]*\n*([\s\S]*?)```/.exec(content)?.[1]

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
                db.current.select<{ role: "user" | "assistant" | "system" | "root", content: string }[]>(
                    "SELECT role, content FROM message WHERE id = ?", [v]).then((records) => records[0]!))),
            async (content, delta) => {
                splitLines.add(delta)
                await db.current.execute("UPDATE message SET content = ? WHERE id = ?", [content, id])
                reload(path)
            },
        )
        splitLines.end()
        if (newMessage.status === 1) {
            await db.current.execute("UPDATE message SET role = ?, status = ?, content = content || '\n' || ? WHERE id = ?", [newMessage.role, newMessage.status, newMessage.content, id])
            useStore.getState().ttsQueue.speakText(newMessage.content + `\nPress ${isMac ? "command" : "control"} plus shift plus R to retry.`, id)
        } else {
            if (useStore.getState().threads.find((v) => v.id === messages[0]!)?.name === "Integrated Terminal") {
                // Extract the first code block
                const block = extractFirstCodeBlock(newMessage.content)
                if (block) {
                    newMessage.content = block
                }
            }
            await db.current.execute("UPDATE message SET role = ?, status = ?, content = ? WHERE id = ?", [newMessage.role, newMessage.status, newMessage.content, id])
        }
        reload(path)
        useStore.setState({ scrollIntoView: id })
        return { message: newMessage, path }
    } finally {
        useStore.setState((s) => ({ waitingAssistantsResponse: s.waitingAssistantsResponse.filter((v) => v !== id) }))
    }
}

const defaultPrompt = `\
Assistant is a large language model trained by OpenAI.
knowledge cutoff: 2021-09
Current date: ${Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric" }).format(new Date())}
Browsing: disabled`

export const isDefaultPrompt = (prompt: string) =>
    new RegExp(String.raw`^Assistant is a large language model trained by OpenAI\.
knowledge cutoff: 2021-09
Current date: \w+ \d+, \d+
Browsing: disabled$`).test(prompt)

if (!isDefaultPrompt(defaultPrompt)) {
    console.error(`!isDefaultPrompt(defaultPrompt)`)
}

const findParents = async (id: MessageId) => {
    return (await db.current.select<{ id: number }[]>(findParentsSQL, [id])).reverse().map((v) => v.id)
}

export const api = {
    // "object.action"
    "dialog.bookmark": () => { useStore.getState().openBookmarkDialog() },
    "dialog.preferences": () => { document.querySelector<HTMLDialogElement>("#preferences")?.showModal() },
    "dialog.budget": () => { useStore.getState().openUsageDialog() },
    "dialog.speaker": () => { document.querySelector<HTMLDialogElement>("#text-to-speech")?.showModal() },
    "dialog.microphone": () => { document.querySelector<HTMLDialogElement>("#speech-to-text")!.showModal() },
    "messageInput.focus": async (audioFeedback = true) => {
        const textarea = getChatInput()
        if (!textarea) { return } // TODO:
        textarea.focus()
        textarea.select()
        if (useConfigStore.getState().audioFeedback && audioFeedback) { await invoke("sound_focus_input") }
    },
    "messageInput.set": (value: string) => {
        const textarea = getChatInput()
        if (!textarea) { return } // TODO:
        setTextareaValueAndAutoResize(textarea, value)
    },
    "messageInput.get": (): string => {
        const textarea = getChatInput()
        if (!textarea) { return "" } // TODO:
        return textarea.value
    },
    "messageInput.submit": async () => {
        const textarea = getChatInput()
        if (!textarea || textarea.value === "") { return }
        let s = useStore.getState()

        let path: MessageId[]

        const run = async (shouldAutoName: boolean) => {
            api["messageInput.set"]("")
            const assistant = await completeAndAppend(path)
            if (assistant.message.status === 0 && shouldAutoName) {
                // do not wait
                api["thread.autoTitle"](path[0]!)
            }
            return assistant
        }

        if (textarea.value.startsWith("/")) {
            // Generate a shell script if the prompt is prefixed with "/"
            // remove "/"
            const content = textarea.value.slice(1)
            const thread = s.threads.find((v) => v.name === "Integrated Terminal")
            if (!thread) {
                path = await appendMessage([], { role: "root", content: "", status: 0 })
                await db.current.execute("INSERT OR REPLACE INTO threadName VALUES (?, ?)", [path[0]!, "Integrated Terminal"])
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
            await run(false)
        } else if (s.visibleMessages.length === 0) {
            // Append the system message if this is the first message in the thread
            path = await appendMessage([], { role: "root", content: "", status: 0 })
            path = await appendMessage(path, {
                role: "system", content: defaultPrompt, status: 0
            })
            path = await appendMessage(path, { role: "user", content: textarea.value, status: 0 })
            await run(true)
        } else {
            path = await appendMessage(s.visibleMessages.map((v) => v.id), { role: "user", content: textarea.value, status: 0 })
            await run(false)
        }
    },
    "messageInput.speak": async () => {
        const textarea = getChatInput()
        if (!textarea) { return } // todo
        await useStore.getState().ttsQueue.speakText(textarea.value, null, true)
    },
    "editInput.submit": async (id: MessageId) => {
        const textarea = document.querySelector<HTMLTextAreaElement>(`#messageEditTextarea${id}`)
        if (!textarea) { return } // TODO
        const s = useStore.getState()
        const depth = s.visibleMessages.findIndex((v) => v.id === id)
        if (depth === -1) { return }
        const path = await appendMessage(s.visibleMessages.slice(0, depth).map((v) => v.id), { role: "user", content: textarea.value, status: 0 })
        useStore.setState((s) => ({ editing: new Set([...s.editing].filter((v) => v !== id)) }))
        await completeAndAppend(path)
    },
    "editInput.cancel": async (id: MessageId) => {
        useStore.setState((s) => ({ editing: new Set([...s.editing].filter((v) => v !== id)) }))
    },
    "thread.autoTitle": async (id: MessageId) => {
        const firstUserMessage = await (async () => {
            let node = (await db.current.select<(PartialMessage & { id: MessageId })[]>("SELECT * FROM message WHERE parent = ?", [id])).at(-1)
            while (node) {
                if (node.role === "user") {
                    return node.content
                }
                node = (await db.current.select<(PartialMessage & { id: MessageId })[]>("SELECT * FROM message WHERE parent = ?", [node.id])).at(-1)
            }
        })()
        if (!firstUserMessage) { return }

        const res = await complete([
            { role: "user", content: `What is the topic of the following message? Answer using only a few words, and refrain from adding any additional comments beyond the topic name.\n\nMessage:${firstUserMessage}` }
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
            await db.current.execute("INSERT OR REPLACE INTO threadName VALUES (?, ?)", [id, res.content])
            reload(useStore.getState().visibleMessages.map((v) => v.id))
            return
        }
        console.error(res)
    },
    "thread.delete": async (id: MessageId) => {
        await db.current.execute("DELETE FROM message WHERE id = ?", [id])
        await reload(useStore.getState().visibleMessages.map((v) => v.id))
    },
    "thread.editTitle": (id: MessageId) => {
        useStore.setState({ renamingThread: id })
        // TODO: wait rendering and focusing
    },
    "thread.confirmTitle": async () => {
        useStore.setState({ renamingThread: null })
        await reload(useStore.getState().visibleMessages.map((v) => v.id))
    },
    "thread.open": async (id: MessageId, audioFeedback = false) => {
        reload([id])
        await api["messageInput.focus"](audioFeedback)
        if (useConfigStore.getState().audioFeedback && audioFeedback) { useStore.getState().ttsQueue.speakText(useStore.getState().threads.find((v) => v.id === id)?.name ?? "untitled thread", id) }
        // scrollIntoViewIfNeeded is polyfilled by the "element.scrollintoviewifneeded-polyfill" package
        // @ts-ignore
        document.querySelector(`[data-thread-id="${id}"]`)?.scrollIntoViewIfNeeded()
    },
    "thread.new": async () => {
        await reload([])
        await api["messageInput.focus"]()
    },
    "thread.next": async () => {
        const s = useStore.getState()
        if (s.visibleMessages.length === 0) {
            speakIfAudioFeedbackIsEnabled("There are no newer threads.")
        } else {
            const i = s.threads.findIndex((v) => v.id === s.visibleMessages[0]!.id)
            if (i === -1) {
                speakIfAudioFeedbackIsEnabled("Something went wrong.")
            } else if (i <= 0) {
                await reload([])
                await api["messageInput.focus"]()
                speakIfAudioFeedbackIsEnabled("new thread")
            } else {
                await api["thread.open"](s.threads[i - 1]!.id, true)
            }
        }
    },
    "thread.previous": async () => {
        const s = useStore.getState()
        if (s.threads.length === 0) {
            speakIfAudioFeedbackIsEnabled("There are no threads.")
        } else if (s.visibleMessages.length === 0) {
            await api["thread.open"](s.threads[0]!.id, true)
        } else {
            const i = s.threads.findIndex((v) => v.id === s.visibleMessages[0]!.id)
            if (i === -1) {
                speakIfAudioFeedbackIsEnabled("Something went wrong.")
            } else if (i >= s.threads.length - 1) {
                speakIfAudioFeedbackIsEnabled("There are no older threads.")
            } else {
                await api["thread.open"](s.threads[i + 1]!.id, true)
            }
        }
    },
    "activeThread.foldAll": () => {
        const s = useStore.getState()
        useStore.setState({ folded: new Set([...s.folded, ...s.visibleMessages.filter((v) => v.role === "assistant").map((v) => v.id)]) })
    },
    "activeThread.unfoldAll": () => {
        useStore.setState({ folded: new Set() })
    },
    "activeThread.lastUserMessage": (): MessageId | null => {
        const message = useStore.getState().visibleMessages.findLast((v) => v.role === "user")
        return message?.id ?? null
    },
    "activeThread.lastAssistantMessage": (): MessageId | null => {
        const message = useStore.getState().visibleMessages.findLast((v) => v.role === "assistant")
        return message?.id ?? null
    },
    "sideBar.show": () => { useStore.setState({ isSideBarOpen: true }) },
    "sideBar.hide": () => { useStore.setState({ isSideBarOpen: false }) },
    "sideBar.toggle": () => { useStore.setState((s) => ({ isSideBarOpen: !s.isSideBarOpen })) },
    "microphone.start": () => {
        const startTime = Date.now()
        useStore.getState().ttsQueue.cancel()
        invoke("start_listening", { openaiKey: useConfigStore.getState().APIKey, language: useConfigStore.getState().whisperLanguage.trim() })
            .then((res) => {
                db.current.execute("INSERT INTO speechToTextUsage (model, durationMs) VALUES (?, ?)", ["whisper-1", Date.now() - startTime])
                api["messageInput.set"](api["messageInput.get"]() + res as string)
                if (!useConfigStore.getState().editVoiceInputBeforeSending) {
                    api["messageInput.submit"]()
                }
            })
            .finally(() => {
                useStore.setState({ listening: false })
            })
        useStore.setState({ listening: true })
    },
    "microphone.stop": async () => {
        await invoke("stop_listening")
    },
    "assistant.abortResponse": async () => {
        await invoke("stop_all_chat_completions")
        await invoke("cancel_listening")
    },
    "assistant.regenerateResponse": async () => {
        const s = useStore.getState()
        await completeAndAppend(s.visibleMessages.slice(0, -1).map((v) => v.id))
    },
    "console.open": () => {
        api["messageInput.focus"]()
        api["messageInput.set"]("/")
        const textarea = getChatInput()
        if (!textarea) { return } // TODO:
        textarea.selectionStart = 1
        textarea.selectionEnd = 1
    },
    "console.runLatest": async () => {
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
    },
    "message.olderVersion": (id: MessageId) => {
        const s = useStore.getState()
        const depth = s.visibleMessages.findIndex((v) => v.id === id)
        if (depth === -1 || depth === 0) { return } // TODO
        const siblingPosition = s.visibleMessages[depth - 1]!.children.findIndex((v) => v.id === id)
        if (siblingPosition === -1) { console.error("siblingPosition === -1"); return }
        if (siblingPosition === 0) { return }
        const path = s.visibleMessages.map((v) => v.id)
        path[depth] = s.visibleMessages[depth - 1]!.children[siblingPosition - 1]!.id
        reload(path)
    },
    "message.newerVersion": (id: MessageId) => {
        const s = useStore.getState()
        const depth = s.visibleMessages.findIndex((v) => v.id === id)
        if (depth === -1 || depth === 0) { return } // TODO
        const siblingPosition = s.visibleMessages[depth - 1]!.children.findIndex((v) => v.id === id)
        if (siblingPosition === -1) { console.error("siblingPosition === -1"); return }
        if (siblingPosition === s.visibleMessages[depth - 1]!.children.length - 1) { return }
        const path = s.visibleMessages.map((v) => v.id)
        path[depth] = s.visibleMessages[depth - 1]!.children[siblingPosition + 1]!.id
        reload(path)
    },
    "message.startEdit": (id: MessageId) => {
        useStore.setState((s) => ({ editing: new Set([...s.editing, id]) }))
        // TODO: wait rendering
    },
    "message.bookmark": async (id: MessageId) => {
        const s = useStore.getState()
        await db.current.execute("INSERT INTO bookmark VALUES (?, ?)", [id, ""])
        reload(s.visibleMessages.map((v) => v.id))
    },
    "message.removeBookmark": async (id: MessageId) => {
        const s = useStore.getState()
        await db.current.execute("DELETE FROM bookmark WHERE messageId = ?", [id])
        reload(s.visibleMessages.map((v) => v.id))
    },
    "message.toggleBookmark": async (id: MessageId) => {
        const s = useStore.getState()
        const message = s.visibleMessages.find((v) => v.id === id)
        if (!message) { return } // TODO
        if (typeof message.note === "string") {
            api["message.removeBookmark"](id)
        } else {
            api["message.bookmark"](id)
        }
    },
    "message.show": async (id: MessageId) => {
        findParents(id).then(async (res) => {
            await reload(res)
            useStore.setState({ scrollIntoView: res.at(-1)! })
        })
    },
    "message.unfold": (id: MessageId) => {
        const set = new Set(useStore.getState().folded)
        set.delete(id)
        useStore.setState({ folded: set })
    },
    "message.speak": (id: MessageId) => {
        const s = useStore.getState()
        const message = s.visibleMessages.find((v) => v.id === id)
        if (!message) { return } // TODO
        const ttsId = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)
        const splitLines = new SplitLines((line) => {
            s.ttsQueue.pushSegment(ttsId, line, id)
        })
        splitLines.add(message.content)
        splitLines.end()
    },
    "message.google": async (id: MessageId) => {
        const records = await db.current.select<{ content: string }[]>("SELECT content FROM message WHERE id = ?", [id])
        if (records.length === 0) { return } // TODO
        open(useConfigStore.getState().searchEngine.replaceAll("{searchTerms}", encodeURIComponent(records[0]!.content)))
    },
    "window.zoomIn": async () => {
        const zoomLevel = useConfigStore.getState().zoomLevel + 1
        await useConfigStore.setState({ zoomLevel })
        document.documentElement.style.fontSize = Math.round(1.2 ** zoomLevel * 100) + "%"
    },
    "window.zoomOut": async () => {
        const zoomLevel = useConfigStore.getState().zoomLevel - 1
        await useConfigStore.setState({ zoomLevel })
        document.documentElement.style.fontSize = Math.round(1.2 ** zoomLevel * 100) + "%"
    },
} satisfies Record<string, (...args: readonly any[]) => any>
