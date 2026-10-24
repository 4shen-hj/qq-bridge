const sectionDefaults = {
  self: true,
  role: true,
  enabledTools: true,
  replyTiming: true,
  unreadCount: true,
  recentCount: true,
  currentWakeConfig: true,
  wakeSafety: true,
  recommended: false,
  memory: false,
  participation: false,
  slang: false,
  stickers: false,
  voices: false,
};

export const PROMPT_SECTIONS = Object.freeze(Object.keys(sectionDefaults));
export const DEFAULT_PROMPT_SECTIONS = Object.freeze(PROMPT_SECTIONS.filter((name) => sectionDefaults[name]));

export function parsePromptSections(value) {
  if (value === null) return DEFAULT_PROMPT_SECTIONS;
  const sections = value.split(',').map((name) => name.trim());
  if (sections.some((name) => !PROMPT_SECTIONS.includes(name))) {
    throw new Error(`sections 必须是非空栏目列表：${PROMPT_SECTIONS.join(',')}`);
  }
  return [...new Set(sections)];
}

export function wakeVisibleMessages(snapshot) {
  return snapshot ? [...snapshot.messages, ...snapshot.recent] : [];
}

function containsTerm(text, term) {
  const haystack = String(text ?? '').toLowerCase();
  const needle = String(term ?? '').trim().toLowerCase();
  if (!needle) return false;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    const before = haystack[at - 1] ?? '';
    const after = haystack[at + needle.length] ?? '';
    if ((!/[a-z0-9_]/.test(needle[0]) || !/[a-z0-9_]/.test(before))
      && (!/[a-z0-9_]/.test(needle.at(-1)) || !/[a-z0-9_]/.test(after))) return true;
    at = haystack.indexOf(needle, at + 1);
  }
  return false;
}

function visibleMessageText(message) {
  return [message.text, message.plain, message.tail].filter((value) => typeof value === 'string').join('\n');
}

export function selectWakeSlang(entries, messages) {
  return entries.filter((entry) => entry.status === 'confirmed' && entry.content && entry.meaning
    && messages.some((message) => containsTerm(visibleMessageText(message), entry.content)));
}

export function selectWakeMemory(state, messages, reason, now = Date.now()) {
  const participants = new Set(messages.flatMap((message) => [message.sender, message.userId])
    .filter((value) => value !== undefined && value !== null).map(String));
  const exploratory = reason === 'bootstrap' || reason === 'proactiveCheck';
  return {
    activeTopics: (state.activeTopics ?? []).filter((topic) => topic?.text && (exploratory
      || topic.pendingQuestion
      || (Array.isArray(topic.participants) && topic.participants.some((participant) => participants.has(String(participant))))
      || messages.some((message) => containsTerm(visibleMessageText(message), topic.text)))),
    pendingThoughts: (state.pendingThoughts ?? []).filter((thought) => thought?.text
      && (!thought.expiresAt || now < thought.expiresAt)),
    memberImpressions: Object.fromEntries(Object.entries(state.memberImpressions ?? {})
      .filter(([name]) => participants.has(name))),
  };
}
