import { render } from "preact"
import { Ref, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks"
import ReactMarkdown from "react-markdown"
import { open } from '@tauri-apps/api/shell'
import { fetch } from '@tauri-apps/api/http'
import hljs from "highlight.js"
import { invoke, clipboard } from "@tauri-apps/api"
import { appWindow } from "@tauri-apps/api/window"
import { useEventListener } from "usehooks-ts"
import remarkGfm from "remark-gfm"
import { getMatches } from '@tauri-apps/api/cli'
import { MessageId, State, api, chatGPTPricePerToken, ctrlOrCmd, db, extractFirstCodeBlock, getTokenUsage, init, isDefaultPrompt, isMac, isWindows, useConfigStore, useStore } from "./state"

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
const MessageRenderer = (props: { depth: number }) => {
    const role = useStore((s) => s.visibleMessages[props.depth]?.role)
    const bookmarked = useStore((s) => typeof s.visibleMessages[props.depth]?.note === "string")
    const status = useStore((s) => s.visibleMessages[props.depth]?.status)
    const content = useStore((s) => s.visibleMessages[props.depth]?.content)
    const id = useStore((s) => s.visibleMessages[props.depth]?.id)
    const numSiblings = useStore((s) => s.visibleMessages[props.depth - 1]?.children.length ?? 1)
    const getSiblingPosition = (s: State) => s.visibleMessages[props.depth - 1]?.children.findIndex((v) => v.id === s.visibleMessages[props.depth]?.id) ?? 1
    const siblingPosition = useStore(getSiblingPosition)
    const hasPreviousSibling = useStore((s) => getSiblingPosition(s) > 0)
    const hasNextSibling = useStore((s) => getSiblingPosition(s) < (s.visibleMessages[props.depth - 1]?.children.length ?? 1) - 1)
    const editing = useStore((s) => s.editing.has(s.visibleMessages[props.depth]?.id as number))
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
        return <div ref={ref} class={"border-b border-b-zinc-200 dark:border-b-0" + (status === 1 ? " bg-red-100 dark:bg-red-900" : role === "assistant" ? " bg-zinc-100 dark:bg-zinc-700" : "")}>
            <div class="max-w-3xl mx-auto relative p-6 pt-8">
                <span class="text-zinc-600 absolute top-0 left-6 select-none cursor-default">
                    {/* role name */}
                    <span class="text-zinc-500 dark:text-zinc-300 select-none" onMouseDown={(ev) => ev.preventDefault()}>{role}</span>

                    {/* ‹　2 / 3 › */}
                    {numSiblings > 1 && <>
                        <span class={"inline-block px-2 ml-2" + (hasPreviousSibling ? " cursor-pointer" : "")} onClick={() => { api["message.olderVersion"](id!) }}>‹</span>
                        {siblingPosition + 1}<span class="mx-1">/</span>{numSiblings}
                        <span class={"inline-block px-2" + (hasNextSibling ? " cursor-pointer" : "")} onClick={() => { api["message.newerVersion"](id!) }}>›</span>
                    </>}
                </span>

                {/* Play audio */}
                <span title="Text-to-speech" class="text-zinc-600 absolute top-1 right-4 select-none cursor-pointer hover:bg-zinc-200 dark:hover:bg-zinc-600"
                    onClick={() => { api["message.speak"](id!) }}>
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

                {/* Search engine */}
                {role === "user" && <span title="Search the web for this message" class="text-zinc-600 absolute top-1 right-16 select-none cursor-pointer hover:bg-zinc-200 dark:hover:bg-zinc-600"
                    onClick={() => { api["message.google"](id!) }}>
                    <svg xmlns="http://www.w3.org/2000/svg" class="icon icon-tabler icon-tabler-world-search inline dark:stroke-zinc-300" width="20" height="20" viewBox="0 0 24 24" stroke-width="1.25" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round">
                        <path stroke="none" d="M0 0h24v24H0z" fill="none"></path>
                        <path d="M21 12a9 9 0 1 0 -9 9"></path>
                        <path d="M3.6 9h16.8"></path>
                        <path d="M3.6 15h7.9"></path>
                        <path d="M11.5 3a17 17 0 0 0 0 18"></path>
                        <path d="M12.5 3a16.984 16.984 0 0 1 2.574 8.62"></path>
                        <path d="M18 18m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0"></path>
                        <path d="M20.2 20.2l1.8 1.8"></path>
                    </svg>
                </span>}

                {/* Edit */}
                {role === "user" && <span title="Edit content" class="text-zinc-600 absolute top-1 right-10 select-none cursor-pointer hover:bg-zinc-200 dark:hover:bg-zinc-600"
                    onClick={() => { api["message.startEdit"](id!) }}>
                    <svg xmlns="http://www.w3.org/2000/svg" class="icon icon-tabler icon-tabler-edit inline dark:stroke-zinc-300" width="20" height="20" viewBox="0 0 24 24" stroke-width="1.25" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round">
                        <path stroke="none" d="M0 0h24v24H0z" fill="none"></path>
                        <path d="M7 7h-1a2 2 0 0 0 -2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2 -2v-1"></path>
                        <path d="M20.385 6.585a2.1 2.1 0 0 0 -2.97 -2.97l-8.415 8.385v3h3l8.385 -8.415z"></path>
                        <path d="M16 5l3 3"></path>
                    </svg>
                </span>}

                {/* {role === "assistant" && <span title="Fact-check" class="text-zinc-600 absolute top-1 right-[5.5rem] select-none cursor-pointer hover:bg-zinc-200 dark:hover:bg-zinc-600"
                    onClick={() => { }}>
                    <svg xmlns="http://www.w3.org/2000/svg" class="icon icon-tabler icon-tabler-book inline dark:stroke-zinc-300" width="20" height="20" viewBox="0 0 24 24" stroke-width="1.25" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round">
                        <path stroke="none" d="M0 0h24v24H0z" fill="none"></path>
                        <path d="M3 19a9 9 0 0 1 9 0a9 9 0 0 1 9 0"></path>
                        <path d="M3 6a9 9 0 0 1 9 0a9 9 0 0 1 9 0"></path>
                        <path d="M3 6l0 13"></path>
                        <path d="M12 6l0 13"></path>
                        <path d="M21 6l0 13"></path>
                    </svg>
                </span>} */}

                {role === "assistant" && <CopyResponse content={content ?? ""} />}

                {role === "assistant" && <span title="Bookmark" class="text-zinc-600 absolute top-1 right-10 select-none cursor-pointer hover:bg-zinc-200 dark:hover:bg-zinc-600"
                    onClick={() => { api["message.toggleBookmark"](id!) }}>
                    <svg xmlns="http://www.w3.org/2000/svg" class="icon icon-tabler icon-tabler-bookmark inline dark:stroke-zinc-300" width="20" height="20" viewBox="0 0 24 24" stroke-width="1.25" stroke="currentColor" fill={bookmarked ? "currentColor" : "none"} stroke-linecap="round" stroke-linejoin="round">
                        <path stroke="none" d="M0 0h24v24H0z" fill="none"></path>
                        <path d="M9 4h6a2 2 0 0 1 2 2v14l-5 -3l-5 3v-14a2 2 0 0 1 2 -2"></path>
                    </svg>
                </span>}

                {/* Textarea */}
                {editing && <>
                    <textarea
                        id={`messageEditTextarea${id}`}
                        ref={textareaRef}
                        class="w-full mt-2 p-2 shadow-light dark:shadow-dark dark:bg-zinc-700 rounded-lg resize-none"
                        value={content}
                        onKeyDown={(ev) => {
                            if (ctrlOrCmd(ev) && ev.code === "Enter") {
                                ev.preventDefault()
                                api["editInput.submit"](id!)
                            }
                        }}
                        onInput={autoFitTextareaHeight}></textarea>
                    <div class="text-center">
                        <button class="inline rounded border dark:border-green-700 text-sm px-3 py-1 text-white bg-green-600 hover:bg-green-500 disabled:bg-zinc-400" onClick={() => { api["editInput.submit"](id!) }}>Save & Submit</button>
                        <button class="inline rounded border dark:border-zinc-600 text-sm px-3 py-1 bg-white dark:bg-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-600 disabled:bg-zinc-300 ml-2" onClick={() => { api["editInput.cancel"](id!) }}>Cancel</button>
                    </div>
                </>}

                {/* Response */}
                {(isFolded || editing) ? "" : (role === "assistant" || role === "system") ? <Markdown content={processedContent ?? ""}></Markdown> : <div class="whitespace-pre-wrap break-words select-text">{content}</div>}
                {isFolded && <span class="cursor-pointer text-zinc-500 hover:text-zinc-600 decoration-dashed italic" onClick={() => { api["message.unfold"](useStore.getState().visibleMessages[props.depth]!.id) }}>folded</span>}

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

/** Highlights matching substrings. */
const getHighlightedText = (text: string, highlight: string) => {
    const parts = text.split(new RegExp(`(${highlight.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, "gi"))
    return <span>{parts.map(part => part.toLowerCase() === highlight.toLowerCase() ? <b class="text-orange-200">{part}</b> : part)}</span>
}

/** Renders an entry in the thread list. */
const ThreadListItem = (props: { i: number }) => {
    const name = useStore((s) => s.threads[props.i]?.name ?? "New chat")
    const active = useStore((s) => s.visibleMessages[0]?.id === s.threads[props.i]?.id)
    const id = useStore((s) => s.threads[props.i]?.id)
    const searchQuery = useStore((s) => s.search)
    const renaming = useStore((s) => s.renamingThread === s.threads[props.i]?.id)
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
            <button class="text-gray-800 dark:text-zinc-100 bg-transparent border-none m-0 py-[0.15rem] px-6 text-left text-sm hover:bg-zinc-200 dark:hover:bg-zinc-600 select-none rounded-lg disabled:text-gray-400 [&::backdrop]:bg-transparent focus-within:outline-none" onClick={() => { api["thread.editTitle"](id!) }}>Rename</button>
            <button class="text-gray-800 dark:text-zinc-100 bg-transparent border-none m-0 py-[0.15rem] px-6 text-left text-sm hover:bg-zinc-200 dark:hover:bg-zinc-600 select-none rounded-lg disabled:text-gray-400 [&::backdrop]:bg-transparent focus-within:outline-none" onClick={() => { api["thread.autoTitle"](id!) }}>Regenerate thread name</button>
            <button class="text-gray-800 dark:text-zinc-100 bg-transparent border-none m-0 py-[0.15rem] px-6 text-left text-sm hover:bg-zinc-200 dark:hover:bg-zinc-600 select-none rounded-lg disabled:text-gray-400 [&::backdrop]:bg-transparent focus-within:outline-none" onClick={() => { api["thread.delete"](id!) }}>Delete</button>
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
        onClick={() => { api["thread.open"](id!) }}
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
            onChange={async (ev) => { await db.current.execute("INSERT OR REPLACE INTO threadName VALUES (?, ?)", [id, ev.currentTarget.value]) }}
            onBlur={async () => { api["thread.confirmTitle"]() }}
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

/** Renders the application. */
const App = (props: { send?: boolean, prompt?: string, voiceInput?: boolean }) => {
    const textareaRef = useRef<HTMLTextAreaElement>(null)
    const numMessages = useStore((s) => s.visibleMessages.length)
    const numThreads = useStore((s) => s.threads.length)
    const isResponseInIntegratedTerminal = useStore((s) => s.threads.find((v) => v.id === s.visibleMessages[0]?.id)?.name === "Integrated Terminal" && s.visibleMessages.at(-1)?.role === "assistant")

    useEffect(() => {
        api["messageInput.focus"]()
        if (props.send) { api["messageInput.submit"]() }
        if (props.voiceInput) { api["microphone.start"]() }
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

    const [isWaitingNextKeyPress, setIsWaitingNextKeyPress] = useState(false)
    useEventListener("keydown", (ev) => {
        if (isWaitingNextKeyPress) {
            setIsWaitingNextKeyPress(false)
            if (ev.key === "0") {
                ev.preventDefault()
                api["activeThread.foldAll"]()
                return
            } else if (ev.code === "KeyJ") {
                ev.preventDefault()
                api["activeThread.unfoldAll"]()
                return
            }
        }

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
                api["microphone.stop"]
            } else {
                api["microphone.start"]
            }
        } else if (ctrlOrCmd(ev) && ev.shiftKey && ev.code === "KeyO") {
            ev.preventDefault()
            api["dialog.bookmark"]()
        } else if (ctrlOrCmd(ev) && ev.code === "KeyU") {
            ev.preventDefault()
            api["messageInput.speak"]()
        } else if (ctrlOrCmd(ev) && ev.key === "/") {
            ev.preventDefault()
            api["console.open"]()
        } else if (ctrlOrCmd(ev) && ev.code === "KeyL") {
            ev.preventDefault()
            api["messageInput.focus"]()
        } else if (ctrlOrCmd(ev) && ev.code === "KeyN") {
            ev.preventDefault()
            api["thread.new"]()
        } else if (ctrlOrCmd(ev) && ev.shiftKey && ev.code === "KeyS") {
            ev.preventDefault()
            api["assistant.abortResponse"]()
        } else if (ctrlOrCmd(ev) && ev.key === ",") {
            ev.preventDefault()
            api["dialog.preferences"]()
        } else if (ctrlOrCmd(ev) && !ev.shiftKey && ev.code === "KeyR") {
            ev.preventDefault()
            const id = api["activeThread.lastAssistantMessage"]()
            if (id !== null) {
                api["message.speak"](id)
            }
        } else if (ctrlOrCmd(ev) && ev.shiftKey && ev.code === "KeyR") {
            // Regenerate response
            ev.preventDefault()
            api["assistant.regenerateResponse"]()
        } else if (ctrlOrCmd(ev) && ev.shiftKey && ev.code === "Tab") {
            ev.preventDefault()
            api["thread.next"]()
        } else if (ctrlOrCmd(ev) && !ev.shiftKey && ev.code === "Tab") {
            ev.preventDefault()
            api["thread.previous"]()
        } else if (ctrlOrCmd(ev) && ev.shiftKey && ev.code === "KeyE") {
            ev.preventDefault()
            api["sideBar.show"]()
        } else if (ctrlOrCmd(ev) && ev.code === "KeyB") {
            ev.preventDefault()
            api["sideBar.toggle"]
        } else if (ctrlOrCmd(ev) && ev.code === "KeyG") {
            ev.preventDefault()
            const id = api["activeThread.lastUserMessage"]()
            if (id !== null) {
                api["message.google"](id)
            }
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
    const isSideBarOpen = useStore((s) => s.isSideBarOpen)

    const [shouldDisplayAPIKeyInputOverride, setShouldDisplayAPIKeyInputOverride] = useState(false)
    const shouldDisplayAPIKeyInput = useStore((s) => s.threads.length === 0) || shouldDisplayAPIKeyInputOverride
    const threadName = useStore((s) => s.threads.find((v) => v.id === s.visibleMessages[0]?.id)?.name ?? "New chat")
    const reversed = useConfigStore((s) => !!s.reversedView)
    const lastMessageRole = useStore((s) => s.visibleMessages.findLast((v) => v.role === "user" || v.role === "assistant")?.role)

    useEffect(() => {
        appWindow.setTitle(`ChatGPT - ${threadName}`)
    }, [threadName])

    return <>
        {!isSideBarOpen && <div title="Open side bar" class="absolute top-4 left-4 cursor-pointer z-40 hover:bg-zinc-100 dark:hover:bg-zinc-700 dark:text-zinc-200 select-none rounded-lg" onClick={(ev) => { ev.preventDefault(); api["sideBar.show"]() }}>
            <svg xmlns="http://www.w3.org/2000/svg" class="icon icon-tabler icon-tabler-menu-2" width="30" height="30" viewBox="0 0 24 24" stroke-width="1.25" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round">
                <path stroke="none" d="M0 0h24v24H0z" fill="none"></path>
                <path d="M4 6l16 0"></path>
                <path d="M4 12l16 0"></path>
                <path d="M4 18l16 0"></path>
            </svg>
        </div>}
        <div class="flex">
            <div class={"text-sm overflow-x-hidden whitespace-nowrap bg-zinc-800 dark:bg-zinc-900 h-[100vh] text-white flex flex-col relative" + (isSideBarOpen ? " w-80" : " w-0")}>
                {isSideBarOpen && <div title="Close side bar" class="absolute top-5 right-4 cursor-pointer z-40 hover:bg-zinc-700 select-none rounded-lg" onClick={(ev) => { ev.preventDefault(); api["sideBar.hide"]() }}>
                    <svg xmlns="http://www.w3.org/2000/svg" class="icon icon-tabler icon-tabler-chevrons-left" width="30" height="30" viewBox="0 0 24 24" stroke-width="1.25" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round">
                        <path stroke="none" d="M0 0h24v24H0z" fill="none"></path>
                        <path d="M11 7l-5 5l5 5"></path>
                        <path d="M17 7l-5 5l5 5"></path>
                    </svg>
                </div>}
                <div class="pl-4 pr-16 pb-2 pt-4">
                    <div class={"px-4 py-2 rounded-lg border border-zinc-600" + (numMessages === 0 ? " bg-zinc-700" : " hover:bg-zinc-700 cursor-pointer")} onClick={() => { api["thread.new"]() }}>
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
                    onClick={async (ev) => { ev.preventDefault(); api["dialog.bookmark"]() }}>
                    <svg xmlns="http://www.w3.org/2000/svg" class="icon icon-tabler icon-tabler-bookmark inline mr-2 [transform:translateY(-1px)]" width="20" height="20" viewBox="0 0 24 24" stroke-width="1.25" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round">
                        <path stroke="none" d="M0 0h24v24H0z" fill="none"></path>
                        <path d="M9 4h6a2 2 0 0 1 2 2v14l-5 -3l-5 3v-14a2 2 0 0 1 2 -2"></path>
                    </svg>
                    Bookmarks
                </div>
                <div class="pl-8 py-2 cursor-pointer hover:bg-zinc-600 rounded-lg"
                    onClick={async (ev) => { ev.preventDefault(); api["dialog.budget"]() }}>
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
                    onClick={(ev) => { ev.preventDefault(); api["dialog.speaker"]() }}>
                    <svg xmlns="http://www.w3.org/2000/svg" class="icon icon-tabler icon-tabler-volume inline mr-2 [transform:translateY(-1px)]" width="20" height="20" viewBox="0 0 24 24" stroke-width="1.25" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round">
                        <path stroke="none" d="M0 0h24v24H0z" fill="none"></path>
                        <path d="M15 8a5 5 0 0 1 0 8"></path>
                        <path d="M17.7 5a9 9 0 0 1 0 14"></path>
                        <path d="M6 15h-2a1 1 0 0 1 -1 -1v-4a1 1 0 0 1 1 -1h2l3.5 -4.5a.8 .8 0 0 1 1.5 .5v14a.8 .8 0 0 1 -1.5 .5l-3.5 -4.5"></path>
                    </svg>
                    Text-to-speech / Audio feedback
                </div>
                <div class="pl-8 py-2 cursor-pointer hover:bg-zinc-600 rounded-lg"
                    onClick={(ev) => { ev.preventDefault(); api["dialog.microphone"]() }}>
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
                    onClick={(ev) => { ev.preventDefault(); api["dialog.preferences"]() }}>
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
                    {(reversed ? (x: number[]) => x.reverse() : (x: number[]) => x)([...Array(numMessages).keys()]).map((i) => <MessageRenderer key={i} depth={i} />)}
                    <div class="h-20"></div>
                </div>
                <div class={"px-2 " + (reversed ? "top-4 left-0 right-0 mx-auto text-center absolute max-w-3xl" : "pt-4 pb-4 relative bg-white dark:bg-zinc-800")}>
                    <RegenerateResponse />
                    <div class="leading-4 flex">
                        {isResponseInIntegratedTerminal && <>
                            <div class={"flex-1 flex " + (isSideBarOpen ? "" : "ml-16 51rem:ml-0 ")}>
                                <div class={"shadow-light text-center bg-zinc-100 py-3 relative cursor-pointer hover:bg-zinc-200 [&:has(svg:hover)]:bg-zinc-100 text-zinc-600 dark:shadow-dark rounded-lg bg-zinc100 flex-1 " + (reversed ? "dark:bg-zinc-600" : "dark:bg-zinc-700")}
                                    onClick={() => { api["console.runLatest"]() }}>
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
                                    id="userPromptTextarea"
                                    ref={textareaRef}
                                    class="dark:text-zinc-100 leading-6 w-[calc(100%-1.25rem)] py-2 pl-4 pr-12 resize-none bg-transparent focus-within:outline-none"
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
                                            api["messageInput.submit"]()
                                            return
                                        }
                                    }}
                                    onInput={autoFitTextareaHeight}></textarea>
                                <div
                                    class={"absolute bottom-2 right-5 cursor-pointer p-1"}
                                    onClick={() => { api["messageInput.submit"]() }}>
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

const PreferencesDialog = () => {
    const reversed = useConfigStore((s) => s.reversedView)
    const theme = useConfigStore((s) => s.theme)
    const sidebar = useConfigStore((s) => s.sidebar)
    const searchEngine = useConfigStore((s) => s.searchEngine)

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
                    <tr>
                        <td>Search engine</td>
                        <td>
                            <input
                                class="ml-2 bg-zinc-600 pl-2 rounded w-80 text-xs py-1"
                                value={searchEngine}
                                onChange={(ev) => {
                                    useConfigStore.setState({ searchEngine: ev.currentTarget.value as any })
                                }}
                                placeholder={`https://www.google.com/search?q={searchTerms}`}></input>
                            <button class="ml-1 inline rounded border border-green-700 dark:border-green-700 text-sm px-3 text-white bg-green-600 hover:bg-green-500 disabled:bg-zinc-400" onClick={async () => {
                                await api["thread.new"]()
                                await api["messageInput.set"](`\
Google: https://www.google.com/search?q={searchTerms}
StackOverflow: https://stackoverflow.com/search?q={searchTerms}
MDN: https://developer.mozilla.org/en-US/search?q={searchTerms}
What's the template URL for Bing?`)
                                document.querySelector<HTMLDialogElement>("dialog[open]")?.close()
                            }}>help</button>
                        </td>
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
                db.current.select<Bookmark[]>("SELECT id, content, note, createdAt, modifiedAt FROM bookmark JOIN message ON message.id = bookmark.messageId ORDER BY createdAt DESC")
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
                        onClick={() => { api["message.show"](b.id) }}>
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

const SearchResult = () => {
    const search = useStore((s) => s.search)
    const [messages, setMessages] = useState<{ id: number, content: string }[]>([])
    useEffect(() => {
        if (search.length === 0) {
            setMessages([])
            return
        }
        (async () => {
            setMessages(await db.current.select<{ id: number, content: string }[]>("SELECT id, content FROM message WHERE content LIKE ?", ["%" + search + "%"]))
        })()
    }, [search])
    return <>{messages.map((message) => {
        return <div key={message.id} class="pl-8 py-2 mb-1 cursor-pointer rounded-lg overflow-x-hidden relative hover:bg-zinc-600"
            onClick={() => { api["message.show"](message.id) }}>
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
    return <span class="inline-block bg-zinc-300 py-1 px-3 ml-4 mb-2 text-zinc-600 rounded cursor-pointer" onClick={() => { open("https://platform.openai.com/tokenizer") }}>{count}</span>
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
                setTotalTTSCharacters((await db.current.select<{ count: number }[]>(`\
SELECT
    coalesce(sum(numCharacters), 0) as count
FROM textToSpeechUsage
WHERE date(timestamp, 'start of month') = date(?, 'start of month')`, [now.toISOString()]))[0]?.count ?? 0)
                setTotalSpeechToTextMinutes(((await db.current.select<{ sumMs: number }[]>(`\
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
        return <div class={"border border-zinc-200 dark:border-zinc-600 bg-white dark:bg-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-600 cursor-pointer w-fit px-3 py-2 rounded-lg absolute left-0 right-0 mx-auto text-center bottom-full text-sm " + (reversed ? "top-full mt-2 h-fit" : "mb-2")} onClick={() => { api["assistant.regenerateResponse"]() }}>
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
    await init()

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
