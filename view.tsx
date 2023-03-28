import "core-js/es/array/find-last"  // Mac
import "core-js/es/array/at"  // Mac
import dialogPolyfill from "dialog-polyfill"  // Mac
import { render } from "preact"
import { Ref, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks"
import ReactMarkdown from "react-markdown"
import { open } from '@tauri-apps/api/shell'
import { fetch } from '@tauri-apps/api/http'
import hljs from "highlight.js"
import { clipboard } from "@tauri-apps/api"
import { appWindow } from "@tauri-apps/api/window"
import { useEventListener } from "usehooks-ts"
import remarkGfm from "remark-gfm"
import { getMatches } from '@tauri-apps/api/cli'
import { MessageId, State, api, ctrlOrCmd, db, extractFirstCodeBlock, getTokenUsage, init, isDefaultPrompt, isMac, isWindows, useConfigStore, useStore, invoke, getPricePerToken } from "./state"
import { JSXInternal } from "preact/src/jsx"
import * as icon from "@tabler/icons-react"
import md5 from "md5"

/** Renders markdown contents. */
const Markdown = (props: { content: string, waiting: boolean }) => {
    useLayoutEffect(() => {
        for (const element of document.querySelectorAll<HTMLElement>(".markdown pre code:not(.hljs)")) {
            hljs.highlightElement(element)
        }
    }, [props.content])
    return useMemo(() => {
        if (props.content === "") {
            // Display the cursor animation in a <p></p>
            return <div class={"markdown select-text" + (props.waiting ? " waiting" : "")}><p></p></div>
        }
        return <ReactMarkdown
            className={"markdown select-text" + (props.waiting ? " waiting" : "")}
            remarkPlugins={[remarkGfm]}
            components={{
                code({ node, inline, className, children, ...props }) {
                    if (inline) { return <code className={className} {...props as any}>{children}</code> }
                    const lang = /language-(\w+)/.exec(className || '')?.[1]
                    const content = String(children).replace(/\n$/, '')
                    // The README of react-markdown uses react-syntax-highlighter for syntax highlighting but it freezes the app for a whole second when loading
                    return <div class="light-3d:[box-shadow:0_0_1rem_rgb(0,0,0,0.5)] rounded light-3d:m-4">
                        <div class="bg-gray-700 light-3d:bg-gradient-to-r light-3d:from-slate-700 light-3d:to-slate-900 light-3d:border-b light-3d:border-b-[rgb(255,255,255,0.1)] light-3d:bg-opacity-90 text-zinc-100 pb-1 pt-2 rounded-t light-3d:border-t light-3d:border-t-slate-300 light-3d:border-l light-3d:border-l-slate-400 light-3d:border-r-1 light-3d:border-r-slate-800 flex">
                            <div class="flex-1 pl-4">{lang}</div>
                            <CodeBlockCopyButton content={content} />
                        </div>
                        <code class={"rounded-b light-3d:bg-gradient-to-r light-3d:from-slate-700 light-3d:to-slate-900 light-3d:bg-opacity-90 light-3d:border-r-1 light-3d:border-l light-3d:border-l-slate-400 light-3d:border-4-slate-800 light-3d:border-b-4 light-3d:border-b-slate-800 " + (lang ? `language-${lang}` : "")} {...props as any}>{content}</code>
                    </div>
                },
                a(props) {
                    return <a
                        href={props.href}
                        onClick={(ev) => {
                            ev.preventDefault()
                            if (props.href) {
                                open(props.href)
                            }
                        }}
                        onContextMenu={(ev) => {
                            ev.preventDefault()
                            const dialog = document.querySelector<HTMLDialogElement>("#contextmenu")!

                            render(<>
                                <button class="text-gray-800 dark:text-zinc-100 bg-transparent border-none m-0 py-[0.15rem] px-6 text-left text-sm hover:bg-zinc-200 dark:hover:bg-zinc-600 select-none rounded-lg disabled:text-gray-400 [&::backdrop]:bg-transparent focus-within:outline-none" onClick={() => { clipboard.writeText(props.href ?? "") }}>Copy Link</button>
                            </>, dialog)

                            dialog.style.left = ev.pageX + "px"
                            dialog.style.top = ev.pageY + "px"

                            dialog.showModal()
                            const rect = dialog.getBoundingClientRect()
                            dialog.style.left = Math.min(ev.pageX, window.innerWidth - rect.width) + "px"
                            dialog.style.top = Math.min(ev.pageY, window.scrollY + window.innerHeight - rect.height - 5) + "px"
                        }}>{props.children}</a>
                },
            }}>{props.content}</ReactMarkdown>
    }, [props.content, props.waiting])
}

const CodeBlockCopyButton = (props: { content: string }) => {
    const [copied, setCopied] = useState(false)
    return <div class="px-4 text-sm cursor-pointer" onClick={() => {
        clipboard.writeText(props.content)
        setCopied(true)
        setTimeout(() => { setCopied(false) }, 3000)
    }}>
        {copied && <icon.IconCheck size="1em" stroke={1.25} className="inline-block mr-2 [transform:translateY(-1px)]" />}
        {!copied && <icon.IconClipboard size="1em" stroke={1.25} className="inline-block mr-2 [transform:translateY(-1px)]" />}
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
    const isGPT4 = useStore((s) => s.visibleMessages[props.depth]?.model === "gpt-4" || s.visibleMessages[props.depth]?.model?.startsWith("gpt-4-"))  // gpt-4, gpt-4-0314, gpt-4-32k, gpt-4-32k-0314, etc.
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
    const gravatarUrl = useConfigStore((s) => `https://www.gravatar.com/avatar/${md5(s.gravatarEmail.trim().toLowerCase())}?s=48&d=mp`)
    const showAvatar = useConfigStore((s) => !!s.showAvatar)

    const autoFitTextareaHeight = () => {
        if (!textareaRef.current) { return }
        // Auto-fit to the content https://stackoverflow.com/a/48460773/10710682
        textareaRef.current!.style.height = ""
        textareaRef.current!.style.height = Math.min(window.innerHeight / 2, textareaRef.current!.scrollHeight) + "px"
    }
    useEffect(() => {
        autoFitTextareaHeight()
    }, [editing, textareaRef])
    useEventListener("resize", () => {
        autoFitTextareaHeight()
    })

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

    const isRoleNameDisplayed = !showAvatar || role === "system"
    if (role === "root" || (role === "system" && isDefaultPrompt(content ?? ""))) {
        return <></>
    } else {
        return <div ref={ref} class={"border-b border-b-zinc-200 dark:border-b-0 bg" + (status === 1 ? " bg-red-100 dark:bg-red-900" : role === "assistant" ? " bg-zinc-100 light-3d:bg-zinc-200 light-3d:bg-opacity-25 light-3d-floating-glass-sm dark:bg-zinc-700" : "")}>
            <div class={"max-w-3xl px-8 mx-auto relative"}>
                <div class={"flex" + (showAvatar ? "" : " mb-1")}>
                    <div class="flex-1">
                        {isRoleNameDisplayed && <span class="text-zinc-500 dark:text-zinc-300 select-none" onMouseDown={(ev) => ev.preventDefault()}>{role}</span>}
                    </div>
                    <div class="text-right [&>*]:ml-1">
                        {/* Edit */}
                        {role === "user" && <span title="Edit content" class="text-zinc-600 select-none cursor-pointer hover:bg-zinc-200 dark:hover:bg-zinc-600"
                            onClick={() => { api["message.startEdit"](id!) }}>
                            <icon.IconEdit className="inline stroke-zinc-500 dark:stroke-zinc-300" size="1.25em" strokeWidth={1.25} />
                        </span>}
                        {/* Search engine */}
                        {role === "user" && <span title="Search the web for this message" class="text-zinc-600 select-none cursor-pointer hover:bg-zinc-200 dark:hover:bg-zinc-600"
                            onClick={() => { api["message.google"](id!) }}>
                            <icon.IconWorldSearch className="inline stroke-zinc-500 dark:stroke-zinc-300" size="1.25em" strokeWidth={1.25} />
                        </span>}
                        {role === "assistant" && <CopyResponse content={content ?? ""} />}
                        {role === "assistant" && <span title="Bookmark" class="text-zinc-600 select-none cursor-pointer hover:bg-zinc-200 dark:hover:bg-zinc-600"
                            onClick={() => { api["message.toggleBookmark"](id!) }}>
                            <icon.IconBookmark className="inline stroke-zinc-500 dark:stroke-zinc-300 dark:text-zinc-100" size="1.25em" strokeWidth={1.25} fill={bookmarked ? "currentColor" : "none"} />
                        </span>}
                        {/* Play audio */}
                        <span title="Text-to-speech" class="text-zinc-600 select-none cursor-pointer hover:bg-zinc-200 dark:hover:bg-zinc-600"
                            onClick={() => { api["message.speak"](id!) }}>
                            <icon.IconVolume className="inline stroke-zinc-500 dark:stroke-zinc-300" size="1.25em" strokeWidth={1.25} />
                        </span>
                    </div>
                </div>
                <div class="flex">
                    {showAvatar && <div class="mr-6">
                        {/* Avatar */}
                        {showAvatar && role === "assistant" && <span class={"p-1 light-3d:shadow-dark inline-block rounded-sm" + (isGPT4 ? " bg-black" : " bg-[rgb(16,163,127)]")}><svg width="41" height="41" viewBox="0 0 41 41" fill="none" xmlns="http://www.w3.org/2000/svg" stroke-width="1.5" class="h-6 w-6 inline-block text-white"><path d="M37.5324 16.8707C37.9808 15.5241 38.1363 14.0974 37.9886 12.6859C37.8409 11.2744 37.3934 9.91076 36.676 8.68622C35.6126 6.83404 33.9882 5.3676 32.0373 4.4985C30.0864 3.62941 27.9098 3.40259 25.8215 3.85078C24.8796 2.7893 23.7219 1.94125 22.4257 1.36341C21.1295 0.785575 19.7249 0.491269 18.3058 0.500197C16.1708 0.495044 14.0893 1.16803 12.3614 2.42214C10.6335 3.67624 9.34853 5.44666 8.6917 7.47815C7.30085 7.76286 5.98686 8.3414 4.8377 9.17505C3.68854 10.0087 2.73073 11.0782 2.02839 12.312C0.956464 14.1591 0.498905 16.2988 0.721698 18.4228C0.944492 20.5467 1.83612 22.5449 3.268 24.1293C2.81966 25.4759 2.66413 26.9026 2.81182 28.3141C2.95951 29.7256 3.40701 31.0892 4.12437 32.3138C5.18791 34.1659 6.8123 35.6322 8.76321 36.5013C10.7141 37.3704 12.8907 37.5973 14.9789 37.1492C15.9208 38.2107 17.0786 39.0587 18.3747 39.6366C19.6709 40.2144 21.0755 40.5087 22.4946 40.4998C24.6307 40.5054 26.7133 39.8321 28.4418 38.5772C30.1704 37.3223 31.4556 35.5506 32.1119 33.5179C33.5027 33.2332 34.8167 32.6547 35.9659 31.821C37.115 30.9874 38.0728 29.9178 38.7752 28.684C39.8458 26.8371 40.3023 24.6979 40.0789 22.5748C39.8556 20.4517 38.9639 18.4544 37.5324 16.8707ZM22.4978 37.8849C20.7443 37.8874 19.0459 37.2733 17.6994 36.1501C17.7601 36.117 17.8666 36.0586 17.936 36.0161L25.9004 31.4156C26.1003 31.3019 26.2663 31.137 26.3813 30.9378C26.4964 30.7386 26.5563 30.5124 26.5549 30.2825V19.0542L29.9213 20.998C29.9389 21.0068 29.9541 21.0198 29.9656 21.0359C29.977 21.052 29.9842 21.0707 29.9867 21.0902V30.3889C29.9842 32.375 29.1946 34.2791 27.7909 35.6841C26.3872 37.0892 24.4838 37.8806 22.4978 37.8849ZM6.39227 31.0064C5.51397 29.4888 5.19742 27.7107 5.49804 25.9832C5.55718 26.0187 5.66048 26.0818 5.73461 26.1244L13.699 30.7248C13.8975 30.8408 14.1233 30.902 14.3532 30.902C14.583 30.902 14.8088 30.8408 15.0073 30.7248L24.731 25.1103V28.9979C24.7321 29.0177 24.7283 29.0376 24.7199 29.0556C24.7115 29.0736 24.6988 29.0893 24.6829 29.1012L16.6317 33.7497C14.9096 34.7416 12.8643 35.0097 10.9447 34.4954C9.02506 33.9811 7.38785 32.7263 6.39227 31.0064ZM4.29707 13.6194C5.17156 12.0998 6.55279 10.9364 8.19885 10.3327C8.19885 10.4013 8.19491 10.5228 8.19491 10.6071V19.808C8.19351 20.0378 8.25334 20.2638 8.36823 20.4629C8.48312 20.6619 8.64893 20.8267 8.84863 20.9404L18.5723 26.5542L15.206 28.4979C15.1894 28.5089 15.1703 28.5155 15.1505 28.5173C15.1307 28.5191 15.1107 28.516 15.0924 28.5082L7.04046 23.8557C5.32135 22.8601 4.06716 21.2235 3.55289 19.3046C3.03862 17.3858 3.30624 15.3413 4.29707 13.6194ZM31.955 20.0556L22.2312 14.4411L25.5976 12.4981C25.6142 12.4872 25.6333 12.4805 25.6531 12.4787C25.6729 12.4769 25.6928 12.4801 25.7111 12.4879L33.7631 17.1364C34.9967 17.849 36.0017 18.8982 36.6606 20.1613C37.3194 21.4244 37.6047 22.849 37.4832 24.2684C37.3617 25.6878 36.8382 27.0432 35.9743 28.1759C35.1103 29.3086 33.9415 30.1717 32.6047 30.6641C32.6047 30.5947 32.6047 30.4733 32.6047 30.3889V21.188C32.6066 20.9586 32.5474 20.7328 32.4332 20.5338C32.319 20.3348 32.154 20.1698 31.955 20.0556ZM35.3055 15.0128C35.2464 14.9765 35.1431 14.9142 35.069 14.8717L27.1045 10.2712C26.906 10.1554 26.6803 10.0943 26.4504 10.0943C26.2206 10.0943 25.9948 10.1554 25.7963 10.2712L16.0726 15.8858V11.9982C16.0715 11.9783 16.0753 11.9585 16.0837 11.9405C16.0921 11.9225 16.1048 11.9068 16.1207 11.8949L24.1719 7.25025C25.4053 6.53903 26.8158 6.19376 28.2383 6.25482C29.6608 6.31589 31.0364 6.78077 32.2044 7.59508C33.3723 8.40939 34.2842 9.53945 34.8334 10.8531C35.3826 12.1667 35.5464 13.6095 35.3055 15.0128ZM14.2424 21.9419L10.8752 19.9981C10.8576 19.9893 10.8423 19.9763 10.8309 19.9602C10.8195 19.9441 10.8122 19.9254 10.8098 19.9058V10.6071C10.8107 9.18295 11.2173 7.78848 11.9819 6.58696C12.7466 5.38544 13.8377 4.42659 15.1275 3.82264C16.4173 3.21869 17.8524 2.99464 19.2649 3.1767C20.6775 3.35876 22.0089 3.93941 23.1034 4.85067C23.0427 4.88379 22.937 4.94215 22.8668 4.98473L14.9024 9.58517C14.7025 9.69878 14.5366 9.86356 14.4215 10.0626C14.3065 10.2616 14.2466 10.4877 14.2479 10.7175L14.2424 21.9419ZM16.071 17.9991L20.4018 15.4978L24.7325 17.9975V22.9985L20.4018 25.4983L16.071 22.9985V17.9991Z" fill="currentColor"></path></svg></span>}
                        {showAvatar && role === "user" && <span class="inline-block w-[2.1rem]"><img class="light-3d:shadow-dark inline-block rounded-sm cursor-pointer hover:opacity-75 w-full" src={gravatarUrl} onClick={() => { api["dialog.preferences"]() }}></img></span>}
                    </div>}
                    <div class="flex-1 overflow-x-auto">
                        {/* Textarea */}
                        {editing && <div class="p-1"> {/* padding is added to display the shadow */}
                            <textarea
                                id={`messageEditTextarea${id}`}
                                ref={textareaRef}
                                class="w-full p-2 bg-white light-3d:bg-opacity-20 light-3d-floating-glass shadow-light dark:shadow-dark dark:bg-zinc-700 rounded-lg resize-none"
                                value={content}
                                onKeyDown={(ev) => {
                                    if (ctrlOrCmd(ev) && ev.code === "Enter") {
                                        ev.preventDefault()
                                        api["editInput.submit"](id!)
                                    }
                                }}
                                onInput={autoFitTextareaHeight}></textarea>
                            <div class="text-center">
                                <button class="inline rounded border dark:border-green-700 text-sm px-3 py-1 text-white bg-green-600 hover:bg-green-500 light-3d:shadow-light disabled:bg-zinc-400" onClick={() => { api["editInput.submit"](id!) }}>Save & Submit</button>
                                <button class="inline rounded border dark:border-zinc-600 text-sm px-3 py-1 bg-white dark:bg-zinc-700 hover:bg-zinc-100 light-3d:shadow-light dark:hover:bg-zinc-600 disabled:bg-zinc-300 ml-2" onClick={() => { api["editInput.cancel"](id!) }}>Cancel</button>
                            </div>
                        </div>}

                        {/* Content */}
                        {(isFolded || editing) ? "" : (role === "assistant" || role === "system") ? <Markdown content={processedContent ?? ""} waiting={waiting}></Markdown> : <div class="whitespace-pre-wrap break-words select-text">{content}</div>}
                        {isFolded && <span class="cursor-pointer text-zinc-500 hover:text-zinc-600 decoration-dashed italic" onClick={() => { api["message.unfold"](useStore.getState().visibleMessages[props.depth]!.id) }}>folded</span>}
                    </div>
                </div>
                <div class="pt-6 pb-1">
                    {/* ‹　2 / 3 › */}
                    {numSiblings > 1 && <>
                        <span class={"inline-block px-2" + (hasPreviousSibling ? " cursor-pointer" : "")} onClick={() => { api["message.olderVersion"](id!) }}>‹</span>
                        {siblingPosition + 1}<span class="mx-1">/</span>{numSiblings}
                        <span class={"inline-block px-2" + (hasNextSibling ? " cursor-pointer" : "")} onClick={() => { api["message.newerVersion"](id!) }}>›</span>
                    </>}
                </div>
            </div>
        </div >
    }
}

const CopyResponse = (props: { content: string }) => {
    const [copied, setCopied] = useState(false)
    return <span title="Copy response" class="text-zinc-600 select-none cursor-pointer hover:bg-zinc-200 dark:hover:bg-zinc-600"
        onClick={() => {
            clipboard.writeText(props.content)
            setCopied(true)
            setTimeout(() => { setCopied(false) }, 3000)
        }}>
        {copied && <icon.IconCheck className="inline stroke-zinc-500 dark:stroke-zinc-300" size="1.25em" strokeWidth={1.25} />}
        {!copied && <icon.IconClipboard className="inline stroke-zinc-500 dark:stroke-zinc-300" size="1.25em" strokeWidth="1.25" />}
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
        const dialog = document.querySelector<HTMLDialogElement>("#contextmenu")!

        render(<>
            <button class="text-gray-800 dark:text-zinc-100 bg-transparent border-none m-0 py-[0.15rem] px-6 text-left text-sm hover:bg-zinc-200 dark:hover:bg-zinc-600 select-none rounded-lg disabled:text-gray-400 [&::backdrop]:bg-transparent focus-within:outline-none" onClick={() => { api["thread.editTitle"](id!) }}>Rename</button>
            <button class="text-gray-800 dark:text-zinc-100 bg-transparent border-none m-0 py-[0.15rem] px-6 text-left text-sm hover:bg-zinc-200 dark:hover:bg-zinc-600 select-none rounded-lg disabled:text-gray-400 [&::backdrop]:bg-transparent focus-within:outline-none" onClick={() => { api["thread.autoTitle"](id!) }}>Regenerate thread name</button>
            <button class="text-gray-800 dark:text-zinc-100 bg-transparent border-none m-0 py-[0.15rem] px-6 text-left text-sm hover:bg-zinc-200 dark:hover:bg-zinc-600 select-none rounded-lg disabled:text-gray-400 [&::backdrop]:bg-transparent focus-within:outline-none" onClick={() => { api["thread.delete"](id!) }}>Delete</button>
        </>, dialog)

        dialog.style.left = ev.pageX + "px"
        dialog.style.top = ev.pageY + "px"

        dialog.showModal()
        const rect = dialog.getBoundingClientRect()
        dialog.style.left = Math.min(ev.pageX, window.innerWidth - rect.width) + "px"
        dialog.style.top = Math.min(ev.pageY, window.scrollY + window.innerHeight - rect.height - 5) + "px"
    }

    return <div class={"pl-8 py-2 mb-1 cursor-pointer rounded-lg overflow-x-hidden relative text-ellipsis pr-10" + (active ? " bg-zinc-700 light-3d:bg-slate-700 light-3d:shadow-dark" : " hover:bg-zinc-600 light-3d:transition-colors light-3d:hover:bg-slate-600 light-3d:hover:bg-opacity-30 light-3d:hover:[box-shadow:0_0_1rem_rgba(0,0,0,0.3)]")}
        data-thread-id={id}
        onClick={() => { api["thread.open"](id!) }}
        onContextMenu={onContextMenu}>
        {name !== "Integrated Terminal" && <icon.IconMessage className="inline mr-2" size="1.25em" strokeWidth={2} />}
        {name === "Integrated Terminal" && <icon.IconTerminal className="inline mr-2" size="1.25em" strokeWidth={1.25} />}
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
        {active && !renaming && <icon.IconDots className="absolute right-4 top-0 bottom-0 my-auto p-1 hover:bg-zinc-500 rounded-lg" size="1.75em" strokeWidth={1.25} onClick={onContextMenu as any} />}
    </div>
}

/** Renders the search bar for threads. */
const SearchBar = () => {
    const value = useStore((s) => s.search)
    return <input class="w-full pl-8 py-2 bg-zinc-700 light-3d:bg-white light-3d:bg-opacity-10 light-3d:focus-within:outline-none light-3d:focus-within:bg-opacity-[0.15] light-3d:shadow-light-subtle transition-colors my-2"
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
        if (ev.target instanceof HTMLInputElement ||  // clicked on an input
            ev.target instanceof HTMLTextAreaElement ||  // clicked on a textarea
            document.getSelection()?.isCollapsed === false || // has a selection
            ev.target instanceof Element && ev.target.matches(".select-text, .select-text *")  // clicked on a selectable text
        ) { return }
        ev.preventDefault()
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

        if (ctrlOrCmd(ev) && ev.key === "+") {
            api["window.zoomIn"]()
            autoFitTextareaHeight()  // todo: move to api
        } else if (ctrlOrCmd(ev) && ev.key === "-") {
            api["window.zoomOut"]()
            autoFitTextareaHeight()
        } else if (ev.code === "Escape" && !document.querySelector("dialog[open]")) {
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
                api["microphone.stop"]()
            } else {
                api["microphone.start"]()
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
            api["sideBar.toggle"]()
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

    const shouldDisplayAPIKeyInputOverride = useStore((s) => s.shouldDisplayAPIKeyInputOverride)
    const shouldDisplayAPIKeyInput = useStore((s) => s.threads.length === 0) || shouldDisplayAPIKeyInputOverride
    const threadName = useStore((s) => s.threads.find((v) => v.id === s.visibleMessages[0]?.id)?.name ?? "New chat")
    const reversed = useConfigStore((s) => !!s.reversedView)
    const lastMessageRole = useStore((s) => s.visibleMessages.findLast((v) => v.role === "user" || v.role === "assistant")?.role)

    useEffect(() => {
        appWindow.setTitle(`ChatGPT - ${threadName}`)
    }, [threadName])

    return <>
        {!isSideBarOpen && <div title="Open side bar" class="absolute top-4 left-4 cursor-pointer z-40 hover:bg-zinc-100 dark:hover:bg-zinc-700 dark:text-zinc-200 select-none rounded-lg" onClick={(ev) => { ev.preventDefault(); api["sideBar.show"]() }}>
            <icon.IconMenu2 className="icon" size="1.875em" strokeWidth={1.25} />
        </div>}
        <div class="flex">
            <div class={"text-sm overflow-x-hidden whitespace-nowrap bg-zinc-800 light-3d:[background-image:url('/textures/egg-shell.png'),linear-gradient(to_right,var(--tw-gradient-stops))] light-3d:from-slate-900 light-3d:to-slate-700 dark:bg-zinc-900 h-[100vh] text-white flex flex-col relative" + (isSideBarOpen ? " w-80" : " w-0")}>
                {isSideBarOpen && <div title="Close side bar" class="absolute top-5 right-4 cursor-pointer z-40 hover:bg-zinc-700 select-none rounded-lg" onClick={(ev) => { ev.preventDefault(); api["sideBar.hide"]() }}>
                    <icon.IconChevronsLeft className="icon" size="1.875em" strokeWidth={1.25} />
                </div>}
                <div class="pl-4 pr-16 pb-2 pt-4">
                    <div class={"px-4 py-2 rounded-lg border border-zinc-600" + (numMessages === 0 ? " bg-zinc-600 light-3d:bg-slate-600" : " hover:bg-zinc-700 light-3d:hover:bg-slate-700 cursor-pointer")} onClick={() => { api["thread.new"]() }}>
                        <icon.IconPlus className="inline mr-4 [transform:translateY(-2px)]" size="1.25em" strokeWidth={2} />
                        New chat
                    </div>
                </div>
                <SearchBar />
                <div class="flex-1 overflow-y-auto">
                    {Array(numThreads).fill(0).map((_, i) => <ThreadListItem key={i} i={i} />)}
                    <SearchResult />
                </div>
                <hr class="border-t border-t-zinc-600"></hr>

                <div class="pl-8 py-2 cursor-pointer hover:bg-zinc-600 rounded-lg"
                    onClick={async (ev) => { ev.preventDefault(); api["dialog.bookmark"]() }}>
                    <icon.IconBookmark className="inline mr-2 [transform:translateY(-1px)]" size="1.25em" strokeWidth={1.25} />
                    Bookmarks
                </div>
                <div class="pl-8 py-2 cursor-pointer hover:bg-zinc-600 rounded-lg"
                    onClick={async (ev) => { ev.preventDefault(); api["dialog.budget"]() }}>
                    <icon.IconCoins className="inline mr-2" size="1.25em" strokeWidth={1.25} />
                    Budget
                </div>
                <div class="pl-8 py-2 cursor-pointer hover:bg-zinc-600 rounded-lg"
                    onClick={(ev) => {
                        ev.preventDefault()
                        useStore.setState((s) => ({ shouldDisplayAPIKeyInputOverride: !s.shouldDisplayAPIKeyInputOverride }))
                    }}>
                    <icon.IconKey className="inline mr-2" size="1.25em" strokeWidth={1.25} />
                    OpenAI API key / Language model
                </div>
                <div class="pl-8 py-2 cursor-pointer hover:bg-zinc-600 rounded-lg"
                    onClick={(ev) => { ev.preventDefault(); api["dialog.speaker"]() }}>
                    <icon.IconVolume className="inline mr-2" size="1.25em" strokeWidth={1.25} />
                    Text-to-speech / Audio feedback
                </div>
                <div class="pl-8 py-2 cursor-pointer hover:bg-zinc-600 rounded-lg"
                    onClick={(ev) => { ev.preventDefault(); api["dialog.microphone"]() }}>
                    <icon.IconMicrophone className="inline mr-2" size="1.25em" strokeWidth={1.25} />
                    Speech-to-text
                </div>
                <div class="pl-8 py-2 cursor-pointer hover:bg-zinc-600 rounded-lg"
                    onClick={(ev) => { ev.preventDefault(); api["dialog.preferences"]() }}>
                    <icon.IconSettings className="inline mr-2" size="1.25em" strokeWidth={1.25} />
                    Preferences
                </div>
                <div class="pl-8 py-2 cursor-pointer hover:bg-zinc-600 rounded-lg"
                    onClick={(ev) => {
                        ev.preventDefault()
                        open("https://github.com/chatgptui/desktop")
                    }}>
                    <icon.IconQuestionMark className="inline mr-2" size="1.25em" strokeWidth={1.25} />
                    About this app
                </div>
            </div>
            <div class="flex h-[100vh] overflow-hidden flex-1 flex-col bg-white light-3d:[background-image:url('/textures/gradient-squares.png')] light-3d:[box-shadow:2rem_0_100rem_0rem_rgb(51,65,85,0.5)_inset] dark:bg-zinc-800 dark:text-zinc-100 relative" id="main">
                {/* shadow */}
                {isSideBarOpen && <div class="hidden light-3d:block absolute z-50 top-0 left-0 h-full pointer-events-none select-none w-[0.6rem] bg-gradient-to-r from-[rgb(0,0,0,0.4)] to-transparent"></div>}
                {isSideBarOpen && <div class="hidden light-3d:block absolute z-50 top-0 left-0 h-full pointer-events-none select-none w-[0.2rem] [background:url('/textures/egg-shell.png'),#1e293b]"></div>}

                {shouldDisplayAPIKeyInput && <APIKeyInputDialog isSideBarOpen={isSideBarOpen} />}
                <div id="mainScroller" class="flex-1 overflow-y-auto" onScroll={() => { document.querySelector<HTMLElement>("#main")!.style.backgroundPositionY = `${-document.querySelector<HTMLElement>("#mainScroller")!.scrollTop * 0.05}px` }}>
                    {reversed && <div class={"h-32 " + (lastMessageRole === "assistant" ? "bg-zinc-100 light-3d:bg-transparent dark:bg-zinc-700" : "")}></div>}
                    {!reversed && <div class={"text-center" + (isSideBarOpen ? "" : " px-16")}>
                        <div class="mt-4 border-b border-b-zinc-600 border-opacity-10 pb-1 dark:border-b-zinc-600 cursor-default" onMouseDown={(ev) => ev.preventDefault()}>{threadName}</div>
                    </div>}
                    {(reversed ? (x: number[]) => x.reverse() : (x: number[]) => x)([...Array(numMessages).keys()]).map((i) => <MessageRenderer key={i} depth={i} />)}
                    <div class="h-20"></div>
                </div>
                <div class={(reversed ? "top-4 left-0 right-0 mx-auto text-center absolute max-w-3xl px-8" : "pt-4 pb-4 px-8 relative light-3d:[box-shadow:0_0_2rem_rgba(0,0,0,0.15)]")}>
                    <RegenerateResponse />
                    <div class="leading-4 flex">
                        {isResponseInIntegratedTerminal && <>
                            <div class={"flex-1 flex " + (!isSideBarOpen && reversed ? /* make the hamburger menu and the textarea not to overlap */"ml-16 51rem:ml-0 " : "")}>
                                <div class={"shadow-light text-center bg-zinc-100 py-3 relative cursor-pointer hover:bg-zinc-200 [&:has(svg:hover)]:bg-zinc-100 text-zinc-600 dark:shadow-dark rounded-lg bg-zinc100 flex-1 " + (reversed ? "dark:bg-zinc-600" : "dark:bg-zinc-700")}
                                    onClick={() => { api["console.runLatest"]() }}>
                                    Execute
                                    <icon.IconX className="absolute top-0 bottom-0 my-auto right-0 p-2 hover:bg-zinc-300 dark:stroke-slate-100 rounded" size="2.5em" strokeWidth={1.25} onClick={(ev) => {
                                        ev.preventDefault()
                                        // @ts-ignore
                                        ev.stopImmediatePropagation()
                                    }} />
                                </div>
                            </div>
                        </>}
                        {!isResponseInIntegratedTerminal && <>
                            <div class={"shadow-light dark:shadow-dark rounded-lg bg-white light-3d:bg-opacity-20 light-3d:focus-within:bg-opacity-70 light-3d:transition-colors light-3d-floating-glass relative flex-1 " + (isSideBarOpen ? "" : "ml-16 51rem:ml-0 ") + (reversed ? "dark:bg-zinc-600" : "dark:bg-zinc-700")}>
                                <textarea
                                    id="userPromptTextarea"
                                    ref={textareaRef}
                                    class="dark:text-zinc-100 leading-6 w-[calc(100%-1.25rem)] py-2 pl-4 pr-12 resize-none bg-transparent focus-within:outline-none placeholder-gray-400 placeholder:italic"
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
                                    <icon.IconSend className="dark:stroke-slate-100" size="1.125em" strokeWidth={1.3} stroke="#000000" fill="none" strokeLinecap="round" strokeLinejoin="round" />
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
        <Dialog
            id="contextmenu"
            class="m-0 px-0 py-[0.15rem] absolute left-0 top-0 z-30 flex flex-col bg-zinc-100 dark:bg-zinc-800 outline-gray-200 dark:outline-zinc-600 shadow-lg whitespace-pre rounded-lg [&:not([open])]:hidden [&::backdrop]:bg-transparent"
            onClick={(ev) => { ev.currentTarget.close() }}></Dialog>
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
    const model = useConfigStore((s) => s.model)

    return <div class={"absolute rounded-lg top-32 left-0 right-0 z-50 text-center w-fit max-w-full m-auto overflow-auto" + (hasMessage ? " bg-white dark:bg-black bg-opacity-40 dark:bg-opacity-25 backdrop-blur shadow-light dark:shadow-dark" : "") + (isSideBarOpen ? "" : " px-16")}>
        <div class="p-8">
            <p class="dark:text-zinc-100 mb-2">
                <select value={openaiService} onChange={(ev) => { useConfigStore.setState({ openaiService: ev.currentTarget.value as any }) }} class="ml-2 px-2 text-zinc-600 bg-zinc-200">
                    <option value="openai">OpenAI API</option>
                    <option value="openai-proxy">OpenAI API (custom endpoint)</option>
                    <option value="azure">Azure OpenAI Service</option>
                </select>
            </p>
            {hasMessage && <icon.IconX className="absolute right-3 top-3 cursor-pointer dark:stroke-slate-100" size="1.25em" strokeWidth={1.25} onClick={() => { useStore.setState({ shouldDisplayAPIKeyInputOverride: false }) }} />}
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
            {!!(openaiService !== "openai" || apiKey) && <p class="mt-8">
                Model (gpt-3.5-turbo, gpt-4, or <a class="cursor-pointer text-blue-700 dark:text-blue-300 border-b border-b-blue-700 dark:border-b-blue-300 whitespace-nowrap" onClick={(ev) => { ev.preventDefault(); open("https://platform.openai.com/docs/models/gpt-4") }}>others</a>)<br />
                <input
                    autocomplete="off"
                    value={model}
                    onChange={(ev) => { useConfigStore.setState({ model: ev.currentTarget.value }) }}
                    class="mb-2 w-80 shadow-light dark:shadow-dark rounded-lg font-mono px-4 dark:bg-zinc-700 dark:text-zinc-100"
                    placeholder="gpt-3.5-turbo"></input>
                {model !== "gpt-3.5-turbo" && <p class="opacity-50 hover:opacity-70 cursor-pointer" onClick={() => { api["dialog.budget"]() }}>Adjust budget</p>}
            </p>}
        </div>
    </div>
}

const PreferencesDialog = () => {
    const reversed = useConfigStore((s) => s.reversedView)
    const theme = useConfigStore((s) => s.theme)
    const sidebar = useConfigStore((s) => s.sidebar)
    const searchEngine = useConfigStore((s) => s.searchEngine)
    const showAvatar = useConfigStore((s) => !!s.showAvatar)
    const gravatarEmail = useConfigStore((s) => s.gravatarEmail)

    return <Dialog id="preferences" class="p-0 bg-zinc-700 text-zinc-100 shadow-dark rounded-lg" onClick={(ev) => { ev.target === ev.currentTarget && ev.currentTarget.close() }}>
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
                            <option value="light-3d">light 3D</option>
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
                        <td>Avatar</td>
                        <td><select class="ml-2 px-2 text-zinc-600" value={showAvatar ? "1" : "0"} onChange={(ev) => {
                            useConfigStore.setState({ showAvatar: ev.currentTarget.value === "1" ? 1 : 0 })
                        }}>
                            <option value="1">visible</option>
                            <option value="0">hide</option>
                        </select></td>
                    </tr>
                    {showAvatar && <tr>
                        <td>Avatar email</td>
                        <td><input
                            class="ml-2 bg-zinc-600 pl-2 rounded w-80 text-xs py-1"
                            value={gravatarEmail}
                            onChange={(ev) => {
                                useConfigStore.setState({ gravatarEmail: ev.currentTarget.value as any })
                            }}
                            placeholder="name@example.com"></input></td>
                    </tr>}
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
    </Dialog>
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
    return <Dialog id="bookmark" class="p-0 bg-zinc-700 text-zinc-100 shadow-dark rounded-lg" onClick={(ev) => { ev.target === ev.currentTarget && ev.currentTarget.close() }}>
        <div class="px-20 py-8 w-fit">
            <h2 class="text-xl border-b mb-4 text-emerald-400 border-b-emerald-400">Bookmarks</h2>
            {bookmarks.map((b) => <div class="cursor-pointer hover:bg-zinc-600 leading-1"
                onClick={() => { api["message.show"](b.id) }}>
                <span class="inline-block w-[80vw] px-2 whitespace-nowrap overflow-x-hidden overflow-ellipsis">{b.content}</span>
            </div>)}
        </div>
    </Dialog>
}

const InputVolumeIndicator = () => {
    const listening = useStore((s) => s.listening)
    const [volume, setVolume] = useState(0)
    const [transcribing, setTranscribing] = useState(false)
    useEffect(() => {
        let canceled = false
        const loop = async () => {
            if (canceled) { return }
            const value = await invoke("get_input_loudness")
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
            <icon.IconX className="absolute right-3 top-3 cursor-pointer dark:stroke-slate-100" size="1.5625em" strokeWidth={1.25} onClick={() => { invoke("cancel_listening") }} />
            <icon.IconMicrophone className="inline-block dark:stroke-zinc-200" size="6.875em" strokeWidth={1.25} />
            {transcribing && <div class="dark:text-zinc-100">
                Transcribing...
            </div>}
            {!transcribing && <div class="h-3 w-44 mx-auto mt-4">
                <svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
                    <defs>
                        <pattern id="pattern_green" patternUnits="userSpaceOnUse" width="13" height="13"
                            patternTransform="rotate(0)">
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
                <icon.IconPlayerStop className="inline-block transform:-translate-y-1 mr-1" size="1.25em" strokeWidth={1.25} />
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
            setCount(await invoke("count_tokens_gpt3_5_turbo_0301", {
                messages: [
                    ...useStore.getState().visibleMessages.flatMap((v) => v.role === "root" ? [] : [{ content: v.content, role: v.role }]),
                    { content: props.textareaRef.current?.value ?? "", role: "user" },
                ],
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
    return <Dialog id="speech-to-text" class="p-0 bg-zinc-700 text-zinc-100 shadow-dark rounded-lg" onClick={(ev) => { ev.target === ev.currentTarget && ev.currentTarget.close() }}>
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
    </Dialog>
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
    const webSpeechAPIVoice = useConfigStore((s) => s.webSpeechAPIVoice)
    const [webSpeechAPIVoices, setWebSpeechAPIVoices] = useState<SpeechSynthesisVoice[]>([])
    const [voiceList, setVoiceList] = useState<AzureVoiceInfo[]>([])
    const [isPasswordVisible, setIsPasswordVisible] = useState(false)
    const audioFeedback = useConfigStore((s) => s.audioFeedback)
    const getVoiceList = async () => {
        if (!azureTTSRegion || !/^[a-z0-9_\-]+$/i.test(azureTTSRegion) || !azureTTSResourceKey) { return }
        const res = await fetch<AzureVoiceInfo[]>(`https://${azureTTSRegion}.tts.speech.microsoft.com/cognitiveservices/voices/list`, { method: "GET", headers: { "Ocp-Apim-Subscription-Key": azureTTSResourceKey } })
        if (!res.ok) { return }
        setVoiceList(res.data)
    }
    useEffect(() => {
        if (ttsBackend === "web-speech-api" && window.speechSynthesis && window.speechSynthesis.getVoices) {
            setWebSpeechAPIVoices(window.speechSynthesis.getVoices())
        }
    }, [ttsBackend])

    return <Dialog id="text-to-speech" class="p-0 bg-zinc-700 text-zinc-100 shadow-dark rounded-lg" onClick={(ev) => { ev.target === ev.currentTarget && ev.currentTarget.close() }}>
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
                        <tr>
                            <td>Voice</td>
                            <td><select
                                class="px-2 text-zinc-600"
                                value={webSpeechAPIVoice}
                                onChange={(ev) => {
                                    useConfigStore.setState({ webSpeechAPIVoice: ev.currentTarget.value })
                                }}
                                autocomplete="off">
                                <option value="default">default</option>
                                {webSpeechAPIVoices.map((v) => <option value={v.name}>{v.name}</option>)}
                            </select></td>
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
    </Dialog>
}

const Dialog = (props: JSXInternal.DOMAttributes<HTMLDialogElement> & { id?: string, class?: string }) => {
    const ref = useRef<HTMLDialogElement>(null)
    useEffect(() => {
        if (isMac && ref.current) {
            dialogPolyfill.registerDialog(ref.current)
        }
    }, [])
    return <dialog ref={ref} {...props}></dialog>
}

const BudgetDialog = () => {
    const [totalTokens, setTotalTokens] = useState<{ model: string, prompt_tokens_sum: number, completion_tokens_sum: number, count: number }[]>([])
    const [totalTTSCharacters, setTotalTTSCharacters] = useState<number>(-1)
    const [totalSpeechToTextMinutes, setTotalSpeechToTextMinutes] = useState<number>(-1)
    const budget = useConfigStore((s) => s.budget)
    const maxCostPerMessage = useConfigStore((s) => s.maxCostPerMessage)
    const [month, setMonth] = useState("")
    const maxTokens = useConfigStore((s) => Math.floor(maxCostPerMessage / (getPricePerToken(s.model)?.prompt ?? 0)))
    const model = useConfigStore((s) => s.model)

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

    return <Dialog id="budget" class="p-0 bg-zinc-700 text-zinc-100 shadow-dark rounded-lg"
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
                        {maxTokens} {model} tokens
                    </td></tr>
            </table>
            <h2 class="text-xl border-b mb-4 mt-8 text-emerald-400 border-b-emerald-400">ChatGPT Usage ({month})</h2>
            <table class="mx-auto">
                <thead class="[&_th]:px-4">
                    <tr class="border-b border-b-zinc-300"><th>Model</th><th>Prompt Tokens</th><th>Generated Tokens</th><th>Price [USD]</th><th>Requests</th></tr>
                </thead>
                <tbody class="[&_td]:px-4">
                    {totalTokens.map((v) => <tr class="select-text"><td class="text-left">{v.model}</td><td class="text-right">{v.prompt_tokens_sum}</td><td class="text-right">{v.completion_tokens_sum}</td><td class="text-right">{(getPricePerToken(v.model) ? (v.prompt_tokens_sum * getPricePerToken(v.model)!.prompt + v.completion_tokens_sum * getPricePerToken(v.model)!.generated).toFixed(6) : "?")}</td><td class="text-right">{v.count}</td></tr>)}
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
    </Dialog>
}

/** Regenerates an assistant's message. */
const RegenerateResponse = () => {
    const reversed = useConfigStore((s) => !!s.reversedView)
    const canRegenerateResponse = useStore((s) => s.visibleMessages.length >= 2 && s.visibleMessages.at(-1)?.role === "assistant")
    const waitingAssistantsResponse = useStore((s) => s.waitingAssistantsResponse.includes(s.visibleMessages.at(-1)?.id as number))
    if (waitingAssistantsResponse) {
        return <div class={"border border-zinc-200 dark:border-zinc-600 bg-white light-3d:bg-opacity-50 light-3d-floating-glass dark:bg-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-600 cursor-pointer w-fit px-3 py-2 rounded-lg absolute left-0 right-0 mx-auto text-center bottom-full text-sm " + (reversed ? "top-full mt-2 h-fit" : "mb-2")} onClick={() => {
            invoke("stop_all_chat_completions")
        }}>
            <icon.IconPlayerStop className="inline mr-2" size="1.125em" strokeWidth={1.25} />
            Stop generating
        </div>
    }
    if (canRegenerateResponse) {
        return <div class={"border border-zinc-200 dark:border-zinc-600 bg-white light-3d:bg-opacity-25 light-3d-floating-glass dark:bg-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-600 cursor-pointer w-fit px-3 py-2 rounded-lg absolute left-0 right-0 mx-auto text-center bottom-full text-sm whitespace-nowrap " + (reversed ? "top-full mt-2 h-fit" : "mb-2")} onClick={() => { api["assistant.regenerateResponse"]() }}>
            <icon.IconRefresh className="inline mr-2" size="1.125em" strokeWidth={1.25} />
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
        if (theme === "light-3d") {
            document.documentElement.classList.add("light-3d")
        } else {
            document.documentElement.classList.remove("light-3d")
        }
    }
    applyTheme()
    useConfigStore.subscribe((state, prev) => { if (state.theme !== prev.theme) { applyTheme() } })
    const mediaQueryList = window.matchMedia('(prefers-color-scheme: dark)')
    if ("addEventListener" in mediaQueryList as any) {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener("change", () => { applyTheme() })
    } else {
        // Mac
        mediaQueryList.addListener(() => { applyTheme() })
    }

    // zoom
    document.documentElement.style.fontSize = Math.round(1.2 ** useConfigStore.getState().zoomLevel * 100) + "%"

    const args = (await getMatches()).args
    render(<App prompt={typeof args.prompt?.value === "string" ? args.prompt.value : undefined} send={args.send?.occurrences === 1} voiceInput={args["voice-input"]?.occurrences === 1} />, document.body)
}

main()
