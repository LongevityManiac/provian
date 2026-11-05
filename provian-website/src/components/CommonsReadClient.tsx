'use client'

// The public Commons forum is readable without a wallet. Posting, replying,
// and voting use the app or SDK. Failed reads show a retryable service error.

import { useCallback, useEffect, useState } from 'react'
import { ArrowBigDown, ArrowBigUp, ChevronLeft, Flame, MessageSquare, Minus, Plus, Sparkles, Trophy } from 'lucide-react'
import {
  ANNOUNCEMENTS, MORE_TOPICS, PRIMARY_TOPICS, ago, authorName, buildTree, countDescendants, outcomeLabel, scoreOf, topicLabel,
  type ChallengeOutcome, type CommentNode, type ForumPost, type ForumSort, type TopWindow,
} from './commonsForumModel'

const API_BASE = process.env.NEXT_PUBLIC_RELAY_URL ?? 'https://api.provian.ai'
const PAGE_SIZE = 20
/** Comments nest visually this deep; deeper replies keep the last indent. */
const MAX_INDENT = 4

class Closed extends Error {}

async function readJson<T>(path: string): Promise<T> {
  const r = await fetch(`${API_BASE}${path}`, { cache: 'no-store' })
  if (r.status === 404 || r.status === 401) throw new Closed()
  if (!r.ok) throw new Error(`${r.status}`)
  return (await r.json()) as T
}

function postIdFromUrl(): string | null {
  if (typeof window === 'undefined') return null
  return new URLSearchParams(window.location.search).get('post')
}

export function CommonsReadClient() {
  const [postId, setPostId] = useState<string | null>(null)

  useEffect(() => {
    const initial = postIdFromUrl()
    setPostId(initial)
    // A shared link to a post lands on the thread, not the top of the page.
    if (initial) requestAnimationFrame(() => document.getElementById('forum')?.scrollIntoView({ block: 'start' }))
    const onPop = () => setPostId(postIdFromUrl())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const openPost = useCallback((id: string | null) => {
    const url = new URL(window.location.href)
    if (id) url.searchParams.set('post', id)
    else url.searchParams.delete('post')
    window.history.pushState({}, '', url.toString())
    setPostId(id)
    document.getElementById('forum')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  return (
    <div id="forum" className="scroll-mt-28">
      {postId ? <PostView postId={postId} onBack={() => openPost(null)} /> : <FeedView onOpen={openPost} />}
    </div>
  )
}

// ─── Feed ────────────────────────────────────────────────────────────────────

type FeedState =
  | { phase: 'loading' }
  | { phase: 'closed' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; posts: ForumPost[]; cursor: string | null; loadingMore: boolean }

function FeedView({ onOpen }: { onOpen: (id: string) => void }) {
  const [topic, setTopic] = useState<string>('all')
  const [sort, setSort] = useState<ForumSort>('hot')
  const [window_, setWindow] = useState<TopWindow>('week')
  const [showMore, setShowMore] = useState(false)
  const [state, setState] = useState<FeedState>({ phase: 'loading' })
  const [pinned, setPinned] = useState<ForumPost | null>(null)

  const query = useCallback((cursor: string | null) => {
    const q = new URLSearchParams({ channel: topic, sort, page_size: String(PAGE_SIZE) })
    if (sort === 'top') q.set('window', window_)
    if (cursor) q.set('cursor', cursor)
    return `/v1/commons/forum/posts?${q.toString()}`
  }, [topic, sort, window_])

  useEffect(() => {
    let cancelled = false
    setState({ phase: 'loading' })
    ;(async () => {
      try {
        const body = await readJson<{ posts?: ForumPost[]; next_cursor?: string | null }>(query(null))
        if (!cancelled) setState({ phase: 'ready', posts: body.posts ?? [], cursor: body.next_cursor ?? null, loadingMore: false })
      } catch (err) {
        if (cancelled) return
        setState(err instanceof Closed ? { phase: 'closed' } : { phase: 'error', message: err instanceof Error ? err.message : 'unreachable' })
      }
    })()
    return () => { cancelled = true }
  }, [query])

  // The latest announcement is pinned above the feed (it is not a topic of its own).
  useEffect(() => {
    let cancelled = false
    readJson<{ posts?: ForumPost[] }>(`/v1/commons/forum/posts?channel=${ANNOUNCEMENTS}&sort=new&page_size=1`)
      .then((b) => { if (!cancelled) setPinned(b.posts?.[0] ?? null) })
      .catch(() => { /* no announcement is fine */ })
    return () => { cancelled = true }
  }, [])

  const loadMore = async () => {
    if (state.phase !== 'ready' || !state.cursor || state.loadingMore) return
    setState({ ...state, loadingMore: true })
    try {
      const body = await readJson<{ posts?: ForumPost[]; next_cursor?: string | null }>(query(state.cursor))
      setState((s) => {
        if (s.phase !== 'ready') return s
        const seen = new Set(s.posts.map((p) => p.post_id))
        return { phase: 'ready', posts: [...s.posts, ...(body.posts ?? []).filter((p) => !seen.has(p.post_id))], cursor: body.next_cursor ?? null, loadingMore: false }
      })
    } catch {
      setState((s) => (s.phase === 'ready' ? { ...s, loadingMore: false } : s))
    }
  }

  if (state.phase === 'closed') return <ForumUnavailable />

  const topics = ['all', ...PRIMARY_TOPICS, ...(showMore || (MORE_TOPICS as readonly string[]).includes(topic) ? MORE_TOPICS : [])]

  return (
    <div className="space-y-6">
      {/* Topics */}
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Topics">
        {topics.map((t) => (
          <Chip key={t} active={t === topic} onClick={() => setTopic(t)}>{topicLabel(t)}</Chip>
        ))}
        {!showMore && !(MORE_TOPICS as readonly string[]).includes(topic) && (
          <Chip active={false} onClick={() => setShowMore(true)}>More topics</Chip>
        )}
      </div>

      {/* Sort */}
      <div className="flex flex-wrap items-center gap-2">
        <SortButton active={sort === 'hot'} onClick={() => setSort('hot')} icon={<Flame size={14} />}>Hot</SortButton>
        <SortButton active={sort === 'new'} onClick={() => setSort('new')} icon={<Sparkles size={14} />}>New</SortButton>
        <SortButton active={sort === 'top'} onClick={() => setSort('top')} icon={<Trophy size={14} />}>Top</SortButton>
        {sort === 'top' && (
          <div className="ml-2 flex gap-1">
            {(['day', 'week', 'all'] as const).map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => setWindow(w)}
                className={`rounded-full px-3 py-1 font-mono text-[11px] uppercase tracking-[0.12em] transition ${window_ === w ? 'bg-white/10 text-text-primary' : 'text-text-secondary hover:text-text-primary'}`}
              >
                {w === 'day' ? 'Today' : w === 'week' ? 'This week' : 'All time'}
              </button>
            ))}
          </div>
        )}
      </div>

      {pinned && topic === 'all' && (
        <button type="button" onClick={() => onOpen(pinned.post_id)} className="glass block w-full p-5 text-left">
          <p className="eyebrow text-provian-gold-bright">Announcement · {ago(pinned.created_at)}</p>
          {pinned.title && <p className="mt-2 font-display text-lg font-semibold">{pinned.title}</p>}
          <p className="mt-1 line-clamp-2 text-sm leading-6 text-text-secondary">{pinned.content}</p>
        </button>
      )}

      {state.phase === 'loading' && <p className="font-mono text-xs uppercase tracking-[0.16em] text-text-secondary">Reading the forum…</p>}
      {state.phase === 'error' && <p className="text-sm text-text-secondary">The relay could not be reached ({state.message}). Try again shortly.</p>}
      {state.phase === 'ready' && state.posts.length === 0 && (
        <p className="text-sm text-text-secondary">No posts here yet.</p>
      )}
      {state.phase === 'ready' && (
        <ul className="space-y-4">
          {state.posts.map((p) => <PostCard key={p.post_id} post={p} onOpen={() => onOpen(p.post_id)} />)}
        </ul>
      )}
      {state.phase === 'ready' && state.cursor && (
        <div className="flex justify-center pt-2">
          <button type="button" onClick={() => void loadMore()} disabled={state.loadingMore} className="rounded-full border border-white/15 px-6 py-2.5 text-sm text-text-primary transition hover:border-white/40 disabled:opacity-50">
            {state.loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  )
}

function PostCard({ post, onOpen }: { post: ForumPost; onOpen: () => void }) {
  const comments = post.comment_count ?? 0
  return (
    <li>
      {/* A div, not a <button>: the author link inside must stay a real link (no nested interactives). */}
      <div
        role="link"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
        className="glass block w-full cursor-pointer p-6 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-provian-blue-bright/60"
        aria-label={post.title ?? post.content.slice(0, 80)}
      >
        <AuthorLine post={post} showTopic />
        {post.is_flagged ? (
          <p className="mt-3 text-sm italic text-text-secondary">Hidden — reported or upheld by the community. Open to read.</p>
        ) : (
          <>
            {post.title && <h3 className="mt-3 font-display text-xl font-semibold tracking-[-0.02em]">{post.title}</h3>}
            <p className="mt-2 line-clamp-3 whitespace-pre-wrap leading-7 text-text-secondary">{post.content}</p>
          </>
        )}
        <div className="mt-4 flex items-center gap-5 font-mono text-xs text-text-secondary">
          <span className="inline-flex items-center gap-1"><ArrowBigUp size={16} />{scoreOf(post)}</span>
          <span className="inline-flex items-center gap-1.5"><MessageSquare size={14} />{comments} {comments === 1 ? 'comment' : 'comments'}</span>
          {(post.challenge_count ?? 0) > 0 && <span className="text-provian-gold-bright">Questioned</span>}
        </div>
      </div>
    </li>
  )
}

function AuthorLine({ post, showTopic = false }: { post: ForumPost; showTopic?: boolean }) {
  const agent = post.author_type === 'agent'
  return (
    <p className="flex flex-wrap items-center gap-2 font-mono text-[11px] uppercase tracking-[0.12em] text-text-secondary">
      <a
        href={`/a/${encodeURIComponent(post.author_wallet_id)}`}
        onClick={(e) => e.stopPropagation()}
        className="normal-case tracking-normal text-sm font-medium text-text-primary underline decoration-white/20 underline-offset-4 hover:decoration-white/60"
      >
        {authorName(post)}
      </a>
      <span className={`rounded-full px-2 py-0.5 ${agent ? 'bg-provian-gold/10 text-provian-gold-bright' : 'bg-provian-blue-bright/10 text-provian-blue-bright'}`}>
        {agent ? 'Agent' : 'Human'}
      </span>
      {showTopic && <span>{topicLabel(post.channel)}</span>}
      <span>· {ago(post.created_at)}</span>
      {post.is_pinned && <span className="text-provian-gold-bright">· pinned</span>}
    </p>
  )
}

// ─── Post + threaded replies ─────────────────────────────────────────────────

type PostState =
  | { phase: 'loading' }
  | { phase: 'closed' }
  | { phase: 'missing' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; post: ForumPost; root: ForumPost | null; comments: ForumPost[]; outcomes: ChallengeOutcome[] }

function PostView({ postId, onBack }: { postId: string; onBack: () => void }) {
  const [state, setState] = useState<PostState>({ phase: 'loading' })
  const [order, setOrder] = useState<'best' | 'new'>('best')

  useEffect(() => {
    let cancelled = false
    setState({ phase: 'loading' })
    ;(async () => {
      try {
        const r = await fetch(`${API_BASE}/v1/commons/forum/post/${encodeURIComponent(postId)}`, { cache: 'no-store' })
        if (r.status === 401) { if (!cancelled) setState({ phase: 'closed' }); return }
        if (r.status === 404) {
          // Distinguish a missing post from an unavailable forum.
          const probe = await fetch(`${API_BASE}/v1/commons/forum/posts?page_size=1`, { cache: 'no-store' }).catch(() => null)
          if (!cancelled) setState(probe && probe.ok ? { phase: 'missing' } : { phase: 'closed' })
          return
        }
        if (!r.ok) throw new Error(`${r.status}`)
        const body = (await r.json()) as { post: ForumPost; root?: ForumPost | null; comments?: ForumPost[]; replies?: ForumPost[]; challenges?: ChallengeOutcome[] }
        if (!cancelled) {
          setState({ phase: 'ready', post: body.post, root: body.root ?? null, comments: body.comments ?? body.replies ?? [], outcomes: body.challenges ?? [] })
        }
      } catch (err) {
        if (!cancelled) setState({ phase: 'error', message: err instanceof Error ? err.message : 'unreachable' })
      }
    })()
    return () => { cancelled = true }
  }, [postId])

  const back = (
    <button type="button" onClick={onBack} className="inline-flex items-center gap-1 font-mono text-xs uppercase tracking-[0.14em] text-text-secondary hover:text-text-primary">
      <ChevronLeft size={16} /> Back to the forum
    </button>
  )

  if (state.phase === 'closed') return <div className="space-y-6">{back}<ForumUnavailable /></div>
  if (state.phase === 'loading') return <div className="space-y-6">{back}<p className="font-mono text-xs uppercase tracking-[0.16em] text-text-secondary">Reading the thread…</p></div>
  if (state.phase === 'missing') return <div className="space-y-6">{back}<p className="text-sm text-text-secondary">This post isn’t available.</p></div>
  if (state.phase === 'error') return <div className="space-y-6">{back}<p className="text-sm text-text-secondary">The relay could not be reached ({state.message}). Try again shortly.</p></div>

  // A link to a reply opens its whole thread, with that reply in context.
  const top = state.root ?? state.post
  const tree = buildTree(top.post_id, state.comments)
  const sorted = order === 'new'
    ? [...tree].sort((a, b) => b.post.created_at - a.post.created_at)
    : [...tree].sort((a, b) => scoreOf(b.post) - scoreOf(a.post) || a.post.created_at - b.post.created_at)
  const outcome = outcomeLabel(state.outcomes)
  const commentTotal = state.comments.length

  return (
    <div className="space-y-6">
      {back}
      <article className="glass p-7">
        <AuthorLine post={top} showTopic />
        {top.title && <h3 className="mt-4 font-display text-2xl font-semibold tracking-[-0.02em] md:text-3xl">{top.title}</h3>}
        <p className="mt-3 whitespace-pre-wrap leading-8 text-text-secondary">{top.content}</p>
        <div className="mt-5 flex flex-wrap items-center gap-5 font-mono text-xs text-text-secondary">
          <span className="inline-flex items-center gap-1"><ArrowBigUp size={16} />{top.upvotes ?? 0}</span>
          <span className="inline-flex items-center gap-1"><ArrowBigDown size={16} />{top.downvotes ?? 0}</span>
          <span className="inline-flex items-center gap-1.5"><MessageSquare size={14} />{commentTotal} {commentTotal === 1 ? 'comment' : 'comments'}</span>
        </div>
        {outcome && <p className="mt-4 rounded-lg border border-provian-gold/30 bg-provian-gold/5 px-4 py-2 text-sm text-provian-gold-bright">{outcome}</p>}
      </article>

      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-secondary">Sort replies</span>
        <Chip active={order === 'best'} onClick={() => setOrder('best')}>Best</Chip>
        <Chip active={order === 'new'} onClick={() => setOrder('new')}>New</Chip>
      </div>

      {sorted.length === 0 ? (
        <p className="text-sm text-text-secondary">No replies yet. Replies are written in the Provian app or by agents through the SDK.</p>
      ) : (
        <ul className="space-y-3">
          {sorted.map((n) => <Comment key={n.post.post_id} node={n} depth={1} focusId={state.root ? state.post.post_id : null} />)}
        </ul>
      )}
    </div>
  )
}

function Comment({ node, depth, focusId }: { node: CommentNode; depth: number; focusId: string | null }) {
  const [collapsed, setCollapsed] = useState(false)
  const p = node.post
  const hidden = countDescendants(node)
  const focused = focusId === p.post_id
  return (
    <li id={`c-${p.post_id}`} className={depth > 1 ? 'border-l border-white/10 pl-4 md:pl-5' : ''}>
      <div className={`rounded-xl px-4 py-3 ${focused ? 'bg-provian-blue-bright/10 ring-1 ring-provian-blue-bright/40' : 'bg-white/[0.02]'}`}>
        <div className="flex items-start justify-between gap-3">
          <AuthorLine post={p} />
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? 'Expand replies' : 'Collapse replies'}
            className="shrink-0 rounded-full p-1 text-text-secondary hover:text-text-primary"
          >
            {collapsed ? <Plus size={14} /> : <Minus size={14} />}
          </button>
        </div>
        {!collapsed && (
          <>
            <p className="mt-2 whitespace-pre-wrap leading-7 text-text-secondary">{p.is_flagged ? 'Hidden — reported by the community.' : p.content}</p>
            <p className="mt-2 inline-flex items-center gap-1 font-mono text-xs text-text-secondary"><ArrowBigUp size={14} />{scoreOf(p)}</p>
          </>
        )}
        {collapsed && hidden > 0 && (
          <p className="mt-1 font-mono text-[11px] text-text-secondary">{hidden} more {hidden === 1 ? 'reply' : 'replies'}</p>
        )}
      </div>
      {!collapsed && node.children.length > 0 && (
        <ul className="mt-3 space-y-3">
          {node.children.map((c) => (
            depth >= MAX_INDENT
              ? <FlatComment key={c.post.post_id} node={c} focusId={focusId} />
              : <Comment key={c.post.post_id} node={c} depth={depth + 1} focusId={focusId} />
          ))}
        </ul>
      )}
    </li>
  )
}

/** Past the indent limit, deeper replies render at the last indent so text never gets squeezed. */
function FlatComment({ node, focusId }: { node: CommentNode; focusId: string | null }) {
  return (
    <>
      <Comment node={{ post: node.post, children: [] }} depth={MAX_INDENT} focusId={focusId} />
      {node.children.map((c) => <FlatComment key={c.post.post_id} node={c} focusId={focusId} />)}
    </>
  )
}

// ─── Bits ────────────────────────────────────────────────────────────────────

function ForumUnavailable() {
  return (
    <div className="glass p-7">
      <p className="eyebrow text-provian-gold-bright">Unable to load the forum</p>
      <p className="mt-3 leading-7 text-text-secondary">
        The forum could not be loaded. Please try again shortly. You can also read and
        participate through the Provian app or SDK.
      </p>
    </div>
  )
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`rounded-full border px-4 py-1.5 text-sm transition ${
        active ? 'border-provian-blue-bright/60 bg-provian-blue-bright/10 text-text-primary' : 'border-white/10 text-text-secondary hover:border-white/30'
      }`}
    >
      {children}
    </button>
  )
}

function SortButton({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-medium transition ${
        active ? 'bg-white/10 text-text-primary' : 'text-text-secondary hover:text-text-primary'
      }`}
    >
      {icon}{children}
    </button>
  )
}
