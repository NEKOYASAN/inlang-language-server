import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".svelte-kit",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
])
const SOURCE_EXTENSIONS = new Set([
  ".astro",
  ".html",
  ".js",
  ".jsx",
  ".mjs",
  ".svelte",
  ".ts",
  ".tsx",
  ".vue",
])
const DEFAULT_MAX_HINT_LENGTH = 80

export function uriToPath(uri) {
  if (!uri?.startsWith("file://")) return undefined
  return fileURLToPath(uri)
}

export function pathToUri(filePath) {
  return pathToFileURL(filePath).toString()
}

export function positionToOffset(text, position) {
  let line = 0
  let character = 0

  for (let index = 0; index < text.length; index += 1) {
    if (line === position.line && character === position.character) {
      return index
    }

    if (text[index] === "\n") {
      line += 1
      character = 0
    } else {
      character += 1
    }
  }

  return text.length
}

export function offsetToPosition(text, offset) {
  let line = 0
  let character = 0
  const cappedOffset = Math.max(0, Math.min(offset, text.length))

  for (let index = 0; index < cappedOffset; index += 1) {
    if (text[index] === "\n") {
      line += 1
      character = 0
    } else {
      character += 1
    }
  }

  return { line, character }
}

export function rangeForOffsets(text, startOffset, endOffset) {
  return {
    start: offsetToPosition(text, startOffset),
    end: offsetToPosition(text, endOffset),
  }
}

export function getTextInRange(text, range) {
  return text.slice(positionToOffset(text, range.start), positionToOffset(text, range.end))
}

export function rangeContains(range, position) {
  if (position.line < range.start.line || position.line > range.end.line) return false
  if (position.line === range.start.line && position.character < range.start.character) return false
  if (position.line === range.end.line && position.character > range.end.character) return false
  return true
}

export function rangesIntersect(a, b) {
  return comparePositions(a.start, b.end) <= 0 && comparePositions(b.start, a.end) <= 0
}

function comparePositions(a, b) {
  if (a.line !== b.line) return a.line - b.line
  return a.character - b.character
}

export async function discoverProjects(rootPath) {
  const projects = []
  if (!rootPath) return projects

  async function walk(directory) {
    let entries
    try {
      entries = await fs.readdir(directory, { withFileTypes: true })
    } catch {
      return
    }

    if (entries.some((entry) => entry.isFile() && entry.name === "settings.json")) {
      if (directory.endsWith(".inlang")) {
        projects.push(directory)
        return
      }
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue
      await walk(path.join(directory, entry.name))
    }
  }

  await walk(rootPath)
  return projects
}

export async function loadWorkspace(rootPath, settings = {}) {
  const projectPaths = await discoverProjects(rootPath)
  const projects = []

  for (const projectPath of projectPaths) {
    const project = await loadProject(projectPath, settings)
    if (project) projects.push(project)
  }

  return {
    rootPath,
    projects,
    settings,
  }
}

export function selectProjectForFile(projects, filePath) {
  if (projects.length === 0) return undefined
  if (!filePath) return projects[0]

  const containingProjects = projects.filter((project) =>
    isPathInside(filePath, project.projectRoot),
  )
  if (containingProjects.length === 0) {
    return projects.length === 1 ? projects[0] : undefined
  }

  return containingProjects.toSorted((a, b) => b.projectRoot.length - a.projectRoot.length)[0]
}

function isPathInside(filePath, projectRoot) {
  const relativePath = path.relative(projectRoot, filePath)
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
}

export async function loadProject(
  projectPath,
  settings: { baseLocale?: string; previewLocale?: string } = {},
) {
  const settingsPath = path.join(projectPath, "settings.json")
  const parsedSettings = await readJson(settingsPath)
  if (!parsedSettings) return undefined

  const locales = Array.isArray(parsedSettings.locales)
    ? parsedSettings.locales.filter((locale) => typeof locale === "string")
    : []
  const baseLocale =
    typeof settings.baseLocale === "string"
      ? settings.baseLocale
      : typeof parsedSettings.baseLocale === "string"
        ? parsedSettings.baseLocale
        : locales[0]
  const previewLocale =
    typeof settings.previewLocale === "string" && locales.includes(settings.previewLocale)
      ? settings.previewLocale
      : baseLocale
  const pathPattern = getPathPattern(parsedSettings)

  if (!baseLocale || !pathPattern || locales.length === 0) {
    return {
      projectPath,
      projectRoot: path.dirname(projectPath),
      settingsPath,
      settings: parsedSettings,
      baseLocale,
      previewLocale,
      locales,
      pathPattern,
      messagesByLocale: new Map(),
      messageValuesByLocale: new Map(),
      messageFilesByLocale: new Map(),
      errors: ["Missing baseLocale, locales, or plugin.inlang.json.pathPattern."],
    }
  }

  const messagesByLocale = new Map()
  const messageValuesByLocale = new Map()
  const messageFilesByLocale = new Map()
  const errors = []
  const projectRoot = path.dirname(projectPath)

  for (const locale of locales) {
    const messageFile = path.resolve(
      projectRoot,
      pathPattern.replaceAll("{languageTag}", locale).replaceAll("{locale}", locale),
    )
    if (!isPathInside(messageFile, projectRoot)) {
      errors.push(
        `Ignoring message path for locale '${locale}' outside project root: ${messageFile}.`,
      )
      messagesByLocale.set(locale, new Map())
      messageValuesByLocale.set(locale, new Map())
      continue
    }
    messageFilesByLocale.set(locale, messageFile)

    const messages = await readJson(messageFile)
    if (!messages) {
      errors.push(`Could not read messages for locale '${locale}' at ${messageFile}.`)
      messagesByLocale.set(locale, new Map())
      messageValuesByLocale.set(locale, new Map())
      continue
    }
    messagesByLocale.set(locale, flattenMessageValues(messages, stringifyMessageValue))
    messageValuesByLocale.set(locale, flattenRawMessageValues(messages))
  }

  return {
    projectPath,
    projectRoot,
    settingsPath,
    settings: parsedSettings,
    baseLocale,
    previewLocale,
    locales,
    pathPattern,
    messagesByLocale,
    messageValuesByLocale,
    messageFilesByLocale,
    errors,
  }
}

function getPathPattern(settings) {
  const jsonPattern = settings?.["plugin.inlang.json"]?.pathPattern
  const messageFormatPattern = settings?.["plugin.inlang.messageFormat"]?.pathPattern
  return typeof jsonPattern === "string"
    ? jsonPattern
    : typeof messageFormatPattern === "string"
      ? messageFormatPattern
      : undefined
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"))
  } catch {
    return undefined
  }
}

export function flattenMessages(json) {
  return flattenMessageValues(json, stringifyMessageValue)
}

function flattenRawMessageValues(json) {
  const messages = new Map()
  const stack = [{ value: json, keyPath: "", isRoot: true }]

  while (stack.length > 0) {
    const { value, keyPath, isRoot } = stack.pop()

    if (isRoot && isPlainObject(value)) {
      pushNestedMessages(stack, value, "", true)
      continue
    }

    if (stringifyMessageValue(value) !== undefined) {
      messages.set(keyPath, value)
      continue
    }

    if (isPlainObject(value)) {
      pushNestedMessages(stack, value, keyPath, false)
    }
  }

  return messages
}

function flattenMessageValues(json, stringify) {
  const messages = new Map()
  const stack = [{ value: json, keyPath: "", isRoot: true }]

  while (stack.length > 0) {
    const { value, keyPath, isRoot } = stack.pop()

    if (isRoot && isPlainObject(value)) {
      pushNestedMessages(stack, value, "", true)
      continue
    }

    const text = stringify(value)
    if (typeof text === "string") {
      messages.set(keyPath, text)
      continue
    }

    if (isPlainObject(value)) {
      pushNestedMessages(stack, value, keyPath, false)
    }
  }

  return messages
}

function pushNestedMessages(stack, value, keyPath, isRoot) {
  const entries = Object.entries(value)
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const [key, nestedValue] = entries[index]
    if (isRoot && key === "$schema") continue
    stack.push({
      value: nestedValue,
      keyPath: keyPath ? `${keyPath}.${key}` : key,
      isRoot: false,
    })
  }
}

export function stringifyMessageValue(value) {
  return stringifyMessageValueWithArgs(value)
}

function stringifyMessageValueWithArgs(value, args = {}) {
  if (typeof value === "string") return interpolatePlaceholders(value, args)
  if (Array.isArray(value)) {
    return stringifyMessageFormatArray(value, args) ?? stringifyPattern(value, args)
  }
  if (!isPlainObject(value)) return undefined

  if (typeof value.message === "string") return interpolatePlaceholders(value.message, args)
  if (typeof value.value === "string") return interpolatePlaceholders(value.value, args)
  if (Array.isArray(value.pattern)) return stringifyPattern(value.pattern, args)
  if (Array.isArray(value.variants)) {
    const variant = value.variants.find((candidate) => Array.isArray(candidate?.pattern))
    if (variant) return stringifyPattern(variant.pattern, args)
  }

  return undefined
}

function stringifyPattern(pattern, args = {}) {
  return pattern
    .map((element) => {
      if (typeof element === "string") return interpolatePlaceholders(element, args)
      if (element?.type === "text") return element.value ?? ""
      if (element?.type === "expression") {
        const arg = element.arg
        if (arg?.type === "variable-reference") return formatPlaceholder(arg.name, args)
        if (arg?.type === "literal") return String(arg.value ?? "")
      }
      return ""
    })
    .join("")
}

function stringifyMessageFormatArray(value, args) {
  for (const element of value) {
    if (!isPlainObject(element)) continue
    if (isPlainObject(element.match)) {
      return stringifyMessageFormatMatch(element.match, element.selectors, args)
    }
    if (Array.isArray(element.pattern)) return stringifyPattern(element.pattern, args)
  }

  return undefined
}

function stringifyMessageFormatMatch(match, selectors, args) {
  const entries = Object.entries(match)
  if (entries.length === 0) return undefined

  const selectorNames = Array.isArray(selectors)
    ? selectors.filter((selector) => typeof selector === "string")
    : []
  const selected = selectMessageFormatVariant(entries, selectorNames, args) ?? entries[0]?.[1]
  return stringifyMessageFormatValue(selected, args)
}

function selectMessageFormatVariant(entries, selectors, args) {
  let best

  for (const [conditionText, value] of entries) {
    const conditions = parseMessageFormatConditions(conditionText)
    let score = 0
    let matches = true

    for (const selector of selectors) {
      const expected = conditions.get(selector)
      const actual = args[selector]
      if (expected === undefined) continue
      if (expected === "*") continue
      if (actual === undefined || String(actual) !== expected) {
        matches = false
        break
      }
      score += 1
    }

    if (matches && (!best || score > best.score)) {
      best = { score, value }
    }
  }

  return best?.value
}

function parseMessageFormatConditions(text) {
  const conditions = new Map()
  for (const part of String(text).split(",")) {
    const [name, value] = part.split("=")
    if (name && value) conditions.set(name.trim(), value.trim())
  }
  return conditions
}

function stringifyMessageFormatValue(value, args) {
  if (typeof value === "string") return interpolatePlaceholders(value, args)
  if (Array.isArray(value)) return stringifyPattern(value, args)
  if (isPlainObject(value)) return stringifyMessageValueWithArgs(value, args)
  return undefined
}

function interpolatePlaceholders(text, args) {
  return text.replace(/\{([A-Za-z_$][\w$]*)\}/g, (_, name) => formatPlaceholder(name, args))
}

function formatPlaceholder(name, args) {
  return Object.hasOwn(args, name) ? String(args[name]) : `{${name}}`
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function findMessageReferences(text) {
  const references = []
  const seen = new Set()

  const patterns = [
    {
      regex: /\b(?:[\w$]+\.)?(?:t|\$t|gettext|msg)\s*\(\s*(["'`])([^"'`]+)\1\s*\)/g,
      keyGroup: 2,
      keyOffset: (match) => match[0].lastIndexOf(match[2]),
      kind: "call",
    },
    {
      regex: /\b(?:i18next|i18n|intl)\.t\s*\(\s*(["'`])([^"'`]+)\1\s*\)/g,
      keyGroup: 2,
      keyOffset: (match) => match[0].lastIndexOf(match[2]),
      kind: "call",
    },
    {
      regex: /\bformatMessage\s*\(\s*\{\s*id\s*:\s*(["'`])([^"'`]+)\1[^}]*\}\s*\)/g,
      keyGroup: 2,
      keyOffset: (match) => match[0].lastIndexOf(match[2]),
      kind: "formatMessage",
    },
    {
      regex: /\b(?:m|messages)\s*\[\s*(["'`])([^"'`]+)\1\s*\]\s*(?:\()?/g,
      keyGroup: 2,
      keyOffset: (match) => match[0].lastIndexOf(match[2]),
      kind: "paraglide-bracket",
    },
    {
      regex: /\b(?:m|messages)\.([A-Za-z_$][\w$]*)\s*\(/g,
      keyGroup: 1,
      keyOffset: (match) => match[0].indexOf(match[1]),
      kind: "paraglide-dot",
    },
  ]

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern.regex)) {
      const rawKey = match[pattern.keyGroup]
      const startOffset = match.index + pattern.keyOffset(match)
      const endOffset = startOffset + rawKey.length
      const id = `${startOffset}:${endOffset}:${rawKey}`
      if (seen.has(id)) continue
      seen.add(id)

      references.push({
        rawKey,
        range: rangeForOffsets(text, startOffset, endOffset),
        fullRange: rangeForOffsets(text, match.index, messageReferenceEndOffset(text, match)),
        args: messageReferenceArguments(text, match),
        kind: pattern.kind,
      })
    }
  }

  return references.toSorted((a, b) => comparePositions(a.range.start, b.range.start))
}

function messageReferenceEndOffset(text, match) {
  const openParenOffset = callOpenParenOffset(match)
  if (openParenOffset === undefined) return match.index + match[0].length

  const closeParenOffset = matchingDelimiterOffset(text, openParenOffset, "(", ")")
  return closeParenOffset === undefined ? match.index + match[0].length : closeParenOffset + 1
}

function messageReferenceArguments(text, match) {
  const openParenOffset = callOpenParenOffset(match)
  if (openParenOffset === undefined) return {}

  const closeParenOffset = matchingDelimiterOffset(text, openParenOffset, "(", ")")
  if (closeParenOffset === undefined) return {}

  const argumentText = text.slice(openParenOffset + 1, closeParenOffset).trim()
  if (!argumentText.startsWith("{")) return {}

  const objectEndOffset = matchingDelimiterOffset(argumentText, 0, "{", "}")
  if (objectEndOffset === undefined) return {}

  return parseObjectLiteralArguments(argumentText.slice(0, objectEndOffset + 1))
}

function callOpenParenOffset(match) {
  const relativeOffset = match[0].lastIndexOf("(")
  return relativeOffset === -1 ? undefined : match.index + relativeOffset
}

function parseObjectLiteralArguments(text) {
  const args = {}
  const stringPropertyPattern =
    /(?:^|[,{])\s*(?:([A-Za-z_$][\w$]*)|(["'`])([^"'`]+)\2)\s*:\s*(["'`])((?:\\.|(?!\4)[^\\])*)\4/g
  const primitivePropertyPattern =
    /(?:^|[,{])\s*(?:([A-Za-z_$][\w$]*)|(["'`])([^"'`]+)\2)\s*:\s*(-?\d+(?:\.\d+)?|true|false|null)\b/g

  for (const match of text.matchAll(stringPropertyPattern)) {
    args[match[1] ?? match[3]] = unescapeJsString(match[5], match[4])
  }
  for (const match of text.matchAll(primitivePropertyPattern)) {
    const key = match[1] ?? match[3]
    if (Object.hasOwn(args, key)) continue
    args[key] = parsePrimitiveLiteral(match[4])
  }

  return args
}

function parsePrimitiveLiteral(value) {
  if (value === "true") return true
  if (value === "false") return false
  if (value === "null") return null
  return Number(value)
}

export function resolveMessageId(project, rawKey) {
  const baseMessages = project.messagesByLocale.get(project.baseLocale) ?? new Map()
  if (baseMessages.has(rawKey)) return rawKey

  for (const key of baseMessages.keys()) {
    if (key.replaceAll(".", "_") === rawKey) return key
  }

  return rawKey
}

export function translationFor(project, rawKey, locale = project.previewLocale, args = {}) {
  const messageId = resolveMessageId(project, rawKey)
  const messages = project.messagesByLocale.get(locale) ?? new Map()
  const rawMessages = project.messageValuesByLocale?.get(locale)
  const message = rawMessages?.has(messageId)
    ? stringifyMessageValueWithArgs(rawMessages.get(messageId), args)
    : messages.has(messageId)
      ? stringifyMessageValueWithArgs(messages.get(messageId), args)
      : undefined
  return {
    messageId,
    message,
    exists: messages.has(messageId),
  }
}

export function createInlayHints(
  text,
  project,
  range = undefined,
  settings: { maxHintLength?: number } = {},
) {
  const maxLength = Number.isInteger(settings.maxHintLength)
    ? settings.maxHintLength
    : DEFAULT_MAX_HINT_LENGTH

  return findMessageReferences(text)
    .filter((reference) => !range || rangesIntersect(reference.range, range))
    .map((reference) => {
      const { messageId, message, exists } = translationFor(
        project,
        reference.rawKey,
        project.previewLocale,
        reference.args,
      )
      const label = exists
        ? message.trim() === ""
          ? `[empty: ${messageId}]`
          : truncate(resolveEscapedCharacters(message), maxLength)
        : `[missing: ${messageId}]`

      return {
        position: hintPosition(text, reference),
        label: ` ${label}`,
        kind: 1,
        paddingLeft: true,
      }
    })
}

function hintPosition(text, reference) {
  const fullRangeEndOffset = positionToOffset(text, reference.fullRange.end)
  const nextNonWhitespaceMatch = text.slice(fullRangeEndOffset).match(/^\s*}/)
  if (nextNonWhitespaceMatch) {
    return offsetToPosition(text, fullRangeEndOffset + nextNonWhitespaceMatch[0].length)
  }

  return reference.fullRange.end
}

export function createHover(text, project, position) {
  const reference = findMessageReferences(text).find((candidate) =>
    rangeContains(candidate.range, position),
  )
  if (!reference) return undefined

  const messageId = resolveMessageId(project, reference.rawKey)
  const rows = project.locales
    .map((locale) => {
      const message = translationFor(project, reference.rawKey, locale, reference.args).message
      return `| ${escapeMarkdown(locale)} | ${escapeMarkdown(typeof message === "string" ? message : "[missing]")} |`
    })
    .join("\n")

  return {
    contents: {
      kind: "markdown",
      value: `**${escapeMarkdown(messageId)}**\n\n| Locale | Message |\n| --- | --- |\n${rows}`,
    },
    range: reference.range,
  }
}

export function createDefinition(text, project, position) {
  const reference = findMessageReferences(text).find((candidate) =>
    rangeContains(candidate.range, position),
  )
  if (!reference) return undefined

  const messageId = resolveMessageId(project, reference.rawKey)
  const locations = []

  for (const locale of project.locales) {
    const messageFile = project.messageFilesByLocale.get(locale)
    if (!messageFile) continue

    const messageFileText = readFileSyncSafe(messageFile)
    if (messageFileText === undefined) continue

    const range = findJsonKeyRange(messageFileText, messageId)
    if (!range) continue

    locations.push({
      uri: pathToUri(messageFile),
      range,
    })
  }

  return locations.length > 0 ? locations : undefined
}

export async function createReferences({ documentUri, text, position, project }) {
  const messageId = messageIdAtPositionInMessageFile({ documentUri, text, position, project })
  if (!messageId) return []

  return findProjectReferenceLocations(project, messageId)
}

export function createDiagnostics(
  text,
  project,
  settings: { existingMessageValueDiagnostics?: boolean } = {},
) {
  const diagnostics = []

  for (const reference of findMessageReferences(text)) {
    const messageId = resolveMessageId(project, reference.rawKey)
    const baseMessages = project.messagesByLocale.get(project.baseLocale)

    if (!baseMessages?.has(messageId)) {
      diagnostics.push({
        range: reference.range,
        severity: 1,
        source: "Inlang",
        code: "missing-message",
        message: `Message '${messageId}' is missing in base locale '${project.baseLocale}'.`,
      })
      continue
    }

    for (const locale of project.locales) {
      const message = project.messagesByLocale.get(locale)?.get(messageId)
      if (typeof message !== "string") {
        diagnostics.push({
          range: reference.range,
          severity: 2,
          source: "Inlang",
          code: "missing-translation",
          message: `Message '${messageId}' is missing for locale '${locale}'.`,
        })
      } else if (message.trim() === "") {
        diagnostics.push({
          range: reference.range,
          severity: 2,
          source: "Inlang",
          code: "empty-translation",
          message: `Message '${messageId}' has an empty translation for locale '${locale}'.`,
        })
      }
    }
  }

  if (settings.existingMessageValueDiagnostics !== false) {
    diagnostics.push(...createExistingMessageValueDiagnostics(text, project))
  }

  return diagnostics
}

function createExistingMessageValueDiagnostics(text, project) {
  const baseMessages = project.messagesByLocale.get(project.baseLocale)
  if (!baseMessages) return []

  const diagnostics = []
  for (const message of uniqueMessagesByLength(
    [...baseMessages.values()].filter((value) => typeof value === "string" && value !== ""),
  )) {
    let index = text.indexOf(message)
    while (index !== -1) {
      const messageIds = [...baseMessages.entries()]
        .filter(([, value]) => value === message)
        .map(([messageId]) => messageId)
      diagnostics.push({
        range: rangeForOffsets(text, index, index + message.length),
        severity: 3,
        source: "Inlang",
        code: "existing-message-value",
        message: `Text matches existing Inlang message ${messageIds.map((messageId) => `'${messageId}'`).join(", ")}.`,
      })

      index = text.indexOf(message, index + 1)
    }
  }

  return diagnostics
}

export async function createReferenceCodeLenses({ documentUri, text, project }) {
  const documentPath = uriToPath(documentUri)
  if (!documentPath || !isMessageFile(project, documentPath)) return []

  const messages = parseMessagesFromText(text)
  if (!messages) return []

  const referenceCounts = await countProjectReferences(project)
  const referenceLocationsByMessage = await findProjectReferenceLocationsByMessage(project)
  const lenses = []

  for (const messageId of messages.keys()) {
    const range = findJsonKeyRange(text, messageId)
    if (!range) continue

    const count = referenceCounts.get(messageId) ?? 0
    const referenceLocations = referenceLocationsByMessage.get(messageId) ?? []
    const firstReference = referenceLocations[0]
    lenses.push({
      range,
      command: {
        title: `${count} ${count === 1 ? "reference" : "references"}`,
        command: firstReference ? "editor.action.showReferences" : "inlang.noop",
        arguments: firstReference ? [documentUri, range.start, referenceLocations] : [],
      },
    })
  }

  return lenses
}

export async function createMessageFileDiagnostics({ documentUri, text, project }) {
  const documentPath = uriToPath(documentUri)
  if (!documentPath || !isMessageFile(project, documentPath)) return undefined

  const messages = parseMessagesFromText(text)
  if (!messages) return []

  const referenceCounts = await countProjectReferences(project)
  return [...messages.entries()].flatMap(([messageId]) => {
    const diagnostics = []
    const range = findJsonKeyRange(text, messageId)
    if (!range) return diagnostics

    if ((referenceCounts.get(messageId) ?? 0) === 0) {
      diagnostics.push({
        range,
        severity: 2,
        source: "Inlang",
        code: "unused-message",
        message: `Message '${messageId}' is not referenced in this Inlang project.`,
      })
    }

    return diagnostics
  })
}

async function findProjectReferenceLocations(project, messageId) {
  return (await findProjectReferenceLocationsByMessage(project)).get(messageId) ?? []
}

async function findProjectReferenceLocationsByMessage(project) {
  const locationsByMessage = new Map()

  for (const filePath of await discoverSourceFiles(project.projectRoot)) {
    const text = await readText(filePath)
    if (text === undefined) continue

    for (const reference of findMessageReferences(text)) {
      const messageId = resolveMessageId(project, reference.rawKey)

      const locations = locationsByMessage.get(messageId) ?? []
      locations.push({
        uri: pathToUri(filePath),
        range: reference.range,
      })
      locationsByMessage.set(messageId, locations)
    }
  }

  return locationsByMessage
}

function messageIdAtPositionInMessageFile({ documentUri, text, position, project }) {
  const documentPath = uriToPath(documentUri)
  if (!documentPath || !isMessageFile(project, documentPath)) return undefined

  const messages = parseMessagesFromText(text)
  if (!messages) return undefined

  for (const messageId of messages.keys()) {
    const range = findJsonKeyRange(text, messageId)
    if (range && rangeContains(range, position)) return messageId
  }

  return undefined
}

function isMessageFile(project, filePath) {
  return [...project.messageFilesByLocale.values()].some(
    (messageFilePath) => path.resolve(messageFilePath) === path.resolve(filePath),
  )
}

function parseMessagesFromText(text) {
  try {
    const parsed = JSON.parse(text)
    return isPlainObject(parsed) ? flattenMessages(parsed) : undefined
  } catch {
    return undefined
  }
}

async function countProjectReferences(project) {
  const counts = new Map()

  for (const filePath of await discoverSourceFiles(project.projectRoot)) {
    const text = await readText(filePath)
    if (text === undefined) continue

    for (const reference of findMessageReferences(text)) {
      const messageId = resolveMessageId(project, reference.rawKey)
      counts.set(messageId, (counts.get(messageId) ?? 0) + 1)
    }
  }

  return counts
}

async function discoverSourceFiles(rootPath) {
  const files = []

  async function walk(directory) {
    let entries
    try {
      entries = await fs.readdir(directory, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || isGeneratedParaglidePath(entryPath)) continue
        await walk(entryPath)
        continue
      }

      if (!entry.isFile()) continue
      if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue
      if (isGeneratedParaglidePath(entryPath)) continue
      files.push(entryPath)
    }
  }

  await walk(rootPath)
  return files
}

function isGeneratedParaglidePath(filePath) {
  return path
    .normalize(filePath)
    .split(path.sep)
    .some((part) => part === "paraglide" || part === ".paraglide")
}

async function readText(filePath) {
  try {
    return await fs.readFile(filePath, "utf8")
  } catch {
    return undefined
  }
}

export function createExtractCodeAction({ documentUri, text, range, project }) {
  const selection = normalizeSelection(getTextInRange(text, range))
  if (!selection.text) return undefined

  const baseMessageFile = project.messageFilesByLocale.get(project.baseLocale)
  const baseMessages = project.messagesByLocale.get(project.baseLocale)
  if (!baseMessageFile || !baseMessages) return undefined

  const messageId = uniqueMessageId(humanMessageId(selection.text), baseMessages)
  const messageFileUri = pathToUri(baseMessageFile)
  const messageFileText = readFileSyncSafe(baseMessageFile)
  if (messageFileText === undefined) return undefined

  const nextMessageFileText = upsertFlatJsonMessage(messageFileText, messageId, selection.text)
  if (nextMessageFileText === undefined) return undefined

  const replacement = messageReferenceReplacement({
    documentUri,
    text,
    range,
    messageId,
    selectedTextWasQuoted: selection.wasQuoted,
  })

  return {
    title: `Inlang: Extract '${messageId}'`,
    kind: "refactor.extract",
    edit: {
      changes: {
        [documentUri]: [
          {
            range,
            newText: replacement,
          },
        ],
        [messageFileUri]: [
          {
            range: wholeDocumentRange(messageFileText),
            newText: nextMessageFileText,
          },
        ],
      },
    },
  }
}

export function createReplaceWithExistingMessageCodeActions({ documentUri, text, range, project }) {
  const baseMessages = project.messagesByLocale.get(project.baseLocale)
  if (!baseMessages) return []

  const target = replacementTargetForRange(
    text,
    range,
    [...baseMessages.values()].filter((message) => typeof message === "string"),
  )
  if (!target) return []

  return [...baseMessages.entries()]
    .filter(([, message]) => message === target.text)
    .map(([messageId]) => ({
      title: `Inlang: Replace with '${messageId}'`,
      kind: "refactor.rewrite",
      edit: {
        changes: {
          [documentUri]: [
            {
              range: target.range,
              newText: messageReferenceReplacement({
                documentUri,
                text,
                range: target.range,
                messageId,
                selectedTextWasQuoted: target.wasQuoted,
              }),
            },
          ],
        },
      },
    }))
}

function replacementTargetForRange(text, range, messages: string[]) {
  const selectionText = getTextInRange(text, range)
  const selection = normalizeSelection(selectionText)
  if (selection.text) {
    if (selection.wasQuoted) return { text: selection.text, range, wasQuoted: true }

    const rangeStartOffset = positionToOffset(text, range.start)
    const leadingWhitespaceLength = selectionText.match(/^\s*/)[0].length
    const startOffset = rangeStartOffset + leadingWhitespaceLength
    return targetForMessageOccurrence(text, startOffset, startOffset + selection.text.length)
  }

  const offset = positionToOffset(text, range.start)
  for (const message of uniqueMessagesByLength(messages)) {
    if (!message) continue

    let index = text.indexOf(message)
    while (index !== -1) {
      const endOffset = index + message.length
      if (index <= offset && offset <= endOffset) {
        return targetForMessageOccurrence(text, index, endOffset)
      }

      index = text.indexOf(message, index + 1)
    }
  }

  return undefined
}

function uniqueMessagesByLength(messages: string[]) {
  return [...new Set(messages)].toSorted((a, b) => b.length - a.length)
}

function targetForMessageOccurrence(text, startOffset, endOffset) {
  const quote = text[startOffset - 1]
  if ((quote === "'" || quote === '"' || quote === "`") && text[endOffset] === quote) {
    return {
      text: text.slice(startOffset, endOffset),
      range: rangeForOffsets(text, startOffset - 1, endOffset + 1),
      wasQuoted: true,
    }
  }

  return {
    text: text.slice(startOffset, endOffset),
    range: rangeForOffsets(text, startOffset, endOffset),
    wasQuoted: false,
  }
}

function readFileSyncSafe(filePath) {
  try {
    return String(globalThis.inlangReadFileSync(filePath))
  } catch {
    return undefined
  }
}

export function installSyncFileReader(readFileSync) {
  globalThis.inlangReadFileSync = readFileSync
}

export function upsertFlatJsonMessage(text, messageId, message) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isPlainObject(parsed)) return undefined

  parsed[messageId] = message
  const indent = text.includes("\n\t") ? "\t" : 2
  const trailingNewline = text.endsWith("\n")
  return `${JSON.stringify(parsed, null, indent)}${trailingNewline ? "\n" : ""}`
}

export function findJsonKeyRange(text, messageId) {
  const token = findJsonPropertyToken(text, messageId)
  return token ? rangeForOffsets(text, token.keyStartOffset, token.keyEndOffset) : undefined
}

function findJsonPropertyToken(text, messageId) {
  const directToken = findFlatJsonPropertyToken(text, messageId)
  if (directToken) return directToken

  const parts = messageId.split(".")
  if (parts.length < 2) return undefined

  return findNestedJsonPropertyToken(text, parts)
}

function findFlatJsonPropertyToken(text, key) {
  for (const token of jsonPropertyTokens(text)) {
    if (token.key === key) return token
  }

  return undefined
}

function findNestedJsonPropertyToken(text, parts) {
  const tokens = [...jsonPropertyTokens(text)]
  const stack = []

  for (const token of tokens) {
    while (stack.length > 0 && token.offset > stack.at(-1).objectEndOffset) {
      stack.pop()
    }

    const tokenPath = [...stack.map((entry) => entry.key), token.key]
    if (tokenPath.join(".") === parts.join(".")) {
      return token
    }

    const objectStartOffset = nextNonWhitespaceOffset(text, token.colonOffset + 1)
    if (text[objectStartOffset] === "{") {
      const objectEndOffset = matchingBraceOffset(text, objectStartOffset)
      if (objectEndOffset !== undefined) {
        stack.push({ key: token.key, objectEndOffset })
      }
    }
  }

  return undefined
}

function* jsonPropertyTokens(text) {
  for (const match of text.matchAll(/"((?:\\.|[^"\\])*)"\s*:/g)) {
    const keyStartOffset = match.index + 1
    const keyEndOffset = keyStartOffset + match[1].length
    yield {
      key: unescapeJsonString(match[1]),
      keyStartOffset,
      keyEndOffset,
      offset: match.index,
      colonOffset: match.index + match[0].lastIndexOf(":"),
    }
  }
}

function nextNonWhitespaceOffset(text, offset) {
  let index = offset
  while (index < text.length && /\s/.test(text[index])) index += 1
  return index
}

function matchingBraceOffset(text, openOffset) {
  return matchingDelimiterOffset(text, openOffset, "{", "}")
}

function matchingDelimiterOffset(text, openOffset, openCharacter, closeCharacter) {
  let depth = 0
  let inString = false
  let escaped = false
  let stringQuote = undefined

  for (let index = openOffset; index < text.length; index += 1) {
    const character = text[index]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (character === "\\") {
        escaped = true
      } else if (character === stringQuote) {
        inString = false
        stringQuote = undefined
      }
      continue
    }

    if (character === '"' || character === "'" || character === "`") {
      inString = true
      stringQuote = character
    } else if (character === openCharacter) {
      depth += 1
    } else if (character === closeCharacter) {
      depth -= 1
      if (depth === 0) return index
    }
  }

  return undefined
}

function unescapeJsonString(value) {
  try {
    return JSON.parse(`"${value}"`)
  } catch {
    return value
  }
}

function unescapeJsString(value, quote) {
  if (quote === '"') return unescapeJsonString(value)

  return value
    .replace(/\\u\{([\dA-Fa-f]+)\}/g, (_, group) =>
      String.fromCodePoint(Number.parseInt(group, 16)),
    )
    .replace(/\\u([\dA-Fa-f]{4})/g, (_, group) => String.fromCodePoint(Number.parseInt(group, 16)))
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\`/g, "`")
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\")
}

function wholeDocumentRange(text) {
  return {
    start: { line: 0, character: 0 },
    end: offsetToPosition(text, text.length),
  }
}

function normalizeSelection(text) {
  const trimmed = text.trim()
  if (trimmed.length === 0) return { text: "", wasQuoted: false }
  const quote = trimmed[0]
  if ((quote === "'" || quote === '"' || quote === "`") && trimmed.at(-1) === quote) {
    return { text: trimmed.slice(1, -1), wasQuoted: true }
  }
  return { text: trimmed, wasQuoted: false }
}

function messageReferenceReplacement({
  documentUri,
  text,
  range,
  messageId,
  selectedTextWasQuoted,
}) {
  const usesParaglideMessages =
    /\bimport\s*\{\s*m\s*\}\s*from\s*["'][^"']*paraglide\/messages["']/.test(text)
  if (!usesParaglideMessages) return `t(${JSON.stringify(messageId)})`

  const reference = isValidJsIdentifier(messageId)
    ? `m.${messageId}()`
    : `m[${JSON.stringify(messageId)}]()`

  if (selectedTextWasQuoted) return reference
  if (documentUri.endsWith(".svelte") && !isPositionInsideScriptTag(text, range.start)) {
    return `{${reference}}`
  }

  return reference
}

function isPositionInsideScriptTag(text, position) {
  const offset = positionToOffset(text, position)
  const before = text.slice(0, offset)
  return before.lastIndexOf("<script") > before.lastIndexOf("</script>")
}

function isValidJsIdentifier(value) {
  try {
    new Function(`const ${value} = undefined;`)
    return true
  } catch {
    return false
  }
}

export function humanMessageId(message) {
  const normalized = message
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase()

  return normalized.slice(0, 48) || "message"
}

function uniqueMessageId(baseId, messages) {
  if (!messages.has(baseId)) return baseId

  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${baseId}_${index}`
    if (!messages.has(candidate)) return candidate
  }

  return `${baseId}_${Date.now()}`
}

function truncate(text, maxLength) {
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text
}

function resolveEscapedCharacters(text) {
  return text
    .replace(/\\u([\dA-Fa-f]{4})/g, (_, group) => String.fromCodePoint(Number.parseInt(group, 16)))
    .replace(/\\[^\s]/g, "")
}

function escapeMarkdown(text) {
  return String(text).replaceAll("|", "\\|").replaceAll("\n", "<br>")
}
