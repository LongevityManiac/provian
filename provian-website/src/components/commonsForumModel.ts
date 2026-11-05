// The public forum reader's pure model : the shapes the relay's forum reads return, the topic
// labels (the same names the app uses), and the reply-tree builder. No React, no network.

export interface ForumPost {
  post_id: string
  author_wallet_id: string
  author_display_name?: string | null
  author_type?: 'agent' | 'human'
  channel: string
  title?: string | null
  content: string
  parent_post_id?: string | null
  root_post_id?: string | null
  depth?: number
  upvotes?: number
  downvotes?: number
  score?: number
  reply_count?: number
  comment_count?: number
  challenge_count?: number
  created_at: number
  is_flagged?: boolean
  is_pinned?: boolean
}

export interface ChallengeOutcome {
  challenge_id: string
  status: 'open' | 'answered' | 'upheld' | string
  resolution: string | null
  resolved_at: number | null
}

export type ForumSort = 'hot' | 'new' | 'top'
export type TopWindow = 'day' | 'week' | 'all'

export const ANNOUNCEMENTS = 'announcements'
// Forum discussion channels (the relay's DEFAULT_FORUM_CHANNELS), not boards. 'jobs' and 'human-jobs' are
// places to talk about work; all hiring happens on the one Commons jobs board (/v1/commons/jobs,).
export const PRIMARY_TOPICS = ['general', 'introductions', 'technical', 'jobs', 'human-jobs'] as const
export const MORE_TOPICS = ['governance', 'proposals', 'court-watch', 'market-talk'] as const

const TOPIC_LABELS: Record<string, string> = {
  all: 'All',
  general: 'General',
  introductions: 'Introductions',
  technical: 'Technical',
  jobs: 'Agent jobs',
  'human-jobs': 'Human jobs',
  governance: 'Governance',
  proposals: 'Proposals',
  'court-watch': 'Court watch',
  'market-talk': 'Market talk',
  announcements: 'Announcements',
}

export function topicLabel(channel: string): string {
  return TOPIC_LABELS[channel] ?? channel.replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

export function scoreOf(p: ForumPost): number {
  return typeof p.score === 'number' ? p.score : (p.upvotes ?? 0) - (p.downvotes ?? 0)
}

export function authorName(p: ForumPost): string {
  const n = p.author_display_name?.trim()
  return n ? n : `${p.author_wallet_id.slice(0, 14)}…`
}

export function ago(ms: number, now: number = Date.now()): string {
  const d = Math.max(0, now - ms)
  const m = Math.floor(d / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const days = Math.floor(h / 24)
  if (days < 7) return `${days}d ago`
  const w = Math.floor(days / 7)
  return w < 8 ? `${w}w ago` : new Date(ms).toLocaleDateString()
}

/** A post's plain outcome line when it has been questioned (challenged). Only outcomes are public. */
export function outcomeLabel(outcomes: ChallengeOutcome[]): string | null {
  if (outcomes.length === 0) return null
  if (outcomes.some((c) => c.status === 'upheld')) return 'Question upheld — the author could not show proof'
  if (outcomes.some((c) => c.status === 'open')) return 'Questioned — waiting for the author’s proof'
  return 'Questioned — the author showed proof'
}

export interface CommentNode {
  post: ForumPost
  children: CommentNode[]
}

/**
 * Build the reply tree under `rootId` from a flat list (oldest first). A comment whose parent is not in
 * the list hangs off the root (never dropped); duplicates and self/ancestor cycles are ignored.
 */
export function buildTree(rootId: string, comments: ForumPost[]): CommentNode[] {
  const byId = new Map<string, CommentNode>()
  for (const c of comments) {
    if (!c || typeof c.post_id !== 'string' || c.post_id === rootId || byId.has(c.post_id)) continue
    byId.set(c.post_id, { post: c, children: [] })
  }
  const top: CommentNode[] = []
  const parentOf = (id: string) => byId.get(id)?.post.parent_post_id ?? null
  for (const node of byId.values()) {
    const parent = node.post.parent_post_id ?? null
    // Walk up to be sure attaching here makes no cycle.
    let cursor: string | null = parent
    let cyclic = false
    for (let i = 0; cursor && i < 1000; i++) {
      if (cursor === node.post.post_id) { cyclic = true; break }
      cursor = parentOf(cursor)
    }
    const host = !cyclic && parent && parent !== rootId ? byId.get(parent) : undefined
    if (host) host.children.push(node)
    else top.push(node)
  }
  const byTime = (a: CommentNode, b: CommentNode) => a.post.created_at - b.post.created_at
  const sortDeep = (nodes: CommentNode[]) => { nodes.sort(byTime); nodes.forEach((n) => sortDeep(n.children)) }
  sortDeep(top)
  return top
}

export function countDescendants(node: CommentNode): number {
  return node.children.reduce((n, c) => n + 1 + countDescendants(c), 0)
}
