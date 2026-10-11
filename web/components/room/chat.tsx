import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, animate, motion, useMotionValue, useTransform } from "motion/react";
import { ArrowBendUpLeftIcon, ArrowDownIcon, ArrowUpIcon, XIcon } from "@phosphor-icons/react";
import { MENTION_RE, forMe, type ChatItem, type ChatQuote, type RoomConnection, type RoomView, type Typist } from "@/lib/room";
import { Avatar } from "@/components/ui/avatar";

const GROUP_MS = 3 * 60 * 1000;
// Stop saying we're typing after this long without a keystroke.
const TYPING_IDLE_MS = 4000;
// How far a message is swiped before letting go replies to it.
const SWIPE_REPLY = 64;
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

type Msg = Extract<ChatItem, { kind: "msg" }>;

type Props = {
  view: RoomView;
  conn: RoomConnection;
  /** Between the messages and the composer (the reaction row on phones). */
  above?: React.ReactNode;
  /** Before the input (mic and camera on phones); tucked away while typing. */
  lead?: React.ReactNode;
  className?: string;
};

export function Chat({ view, conn, above, lead, className = "" }: Props) {
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const [replyTo, setReplyTo] = useState<Msg | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const nearBottom = useRef(true);
  const [unseen, setUnseen] = useState(false);
  const canSend = view.status === "open" && view.joined;
  const typing = focused || draft.length > 0;
  const myName = view.members.find((m) => m.user_id === view.me)?.username;

  // Everyone an @name can mean: who's in the room, then whoever has spoken.
  const people = useMemo(() => {
    const seen = new Map<string, { name: string; away: boolean }>();
    const online = [...view.members].sort((a, b) => Number(a.status === "away") - Number(b.status === "away"));
    for (const m of online) seen.set(m.username.toLowerCase(), { name: m.username, away: m.status === "away" });
    for (let i = view.chat.length - 1; i >= 0; i--) {
      const c = view.chat[i];
      if (c.kind === "msg" && !seen.has(c.sender.toLowerCase())) seen.set(c.sender.toLowerCase(), { name: c.sender, away: true });
    }
    return seen;
  }, [view.members, view.chat]);
  const shownIds = useMemo(() => new Set(view.chat.flatMap((c) => (c.kind === "msg" && c.id !== undefined ? [c.id] : []))), [view.chat]);

  // Follow new messages only while the reader is at the bottom; otherwise offer a jump.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (nearBottom.current) el.scrollTop = el.scrollHeight;
    else setUnseen(true);
  }, [view.chat.length]);

  // Someone starting to type shows at the bottom too; keep it in view if we're following.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && nearBottom.current) el.scrollTop = el.scrollHeight;
  }, [view.typing.length]);

  // Tell the room we're typing while the box has text, and that we've stopped after a pause,
  // when it's emptied, or when we leave.
  const idle = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(
    () => () => {
      clearTimeout(idle.current);
      conn.typing(false);
    },
    [conn],
  );
  function onDraft(text: string) {
    setDraft(text);
    clearTimeout(idle.current);
    if (!text.trim()) return conn.typing(false);
    conn.typing(true);
    idle.current = setTimeout(() => conn.typing(false), TYPING_IDLE_MS);
  }

  // Keep the newest message in view when the list shrinks (keyboard opening, phone rotating,
  // the reply strip appearing).
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (nearBottom.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  function onScroll() {
    const el = listRef.current!;
    nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom.current) setUnseen(false);
  }

  const smooth = () => (matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");

  function jumpDown() {
    const el = listRef.current!;
    nearBottom.current = true;
    setUnseen(false);
    el.scrollTo({ top: el.scrollHeight, behavior: smooth() });
  }

  // A quote's original, scrolled into view with a brief ring so the eye finds it.
  function jumpTo(id: number) {
    const bubble = listRef.current?.querySelector<HTMLElement>(`[data-msg="${id}"] [data-bubble]`);
    if (!bubble) return;
    bubble.scrollIntoView({ block: "center", behavior: smooth() });
    bubble.animate([{ boxShadow: "0 0 0 2px var(--color-plum-400)" }, { boxShadow: "0 0 0 2px transparent" }], {
      duration: 1400,
      delay: 250,
      easing: "ease-out",
    });
  }

  function startReply(item: Msg) {
    if (!canSend || item.id === undefined) return;
    setReplyTo(item);
    inputRef.current?.focus();
  }

  // @name suggestions for the word at the caret.
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = useState(0);
  const dismissed = useRef(-1); // Escape closes the list until another @ is typed
  const suggestions = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    return [...people.entries()]
      .filter(([key, p]) => key.startsWith(q) && p.name !== myName)
      .slice(0, 5)
      .map(([, p]) => p);
  }, [mention, people, myName]);
  const picking = suggestions.length > 0;

  function findMention() {
    const el = inputRef.current;
    if (!el) return;
    const caret = el.selectionStart ?? el.value.length;
    const m = /(?:^|\s)@([A-Za-z0-9_]{0,20})$/.exec(el.value.slice(0, caret));
    const start = m ? caret - m[1].length - 1 : -1;
    if (!m || start === dismissed.current) return setMention(null);
    dismissed.current = -1;
    setMention((cur) => (cur?.start === start && cur.query === m[1] ? cur : { start, query: m[1] }));
    if (mention?.start !== start) setActive(0);
  }

  function pick(name: string) {
    const el = inputRef.current;
    if (!el || !mention) return;
    const caret = el.selectionStart ?? el.value.length;
    const text = `${draft.slice(0, mention.start)}@${name} ${draft.slice(caret)}`;
    const at = mention.start + name.length + 2;
    onDraft(text);
    setMention(null);
    requestAnimationFrame(() => el.setSelectionRange(at, at));
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (picking) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = suggestions.length;
        setActive((i) => (i + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pick(suggestions[Math.min(active, suggestions.length - 1)].name);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        dismissed.current = mention!.start;
        setMention(null);
        return;
      }
    }
    if (e.key === "Escape" && replyTo) {
      e.preventDefault();
      setReplyTo(null);
    }
  }

  function submit(e: React.SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    if (conn.sendChat(draft, replyTo ?? undefined)) {
      setDraft("");
      setReplyTo(null);
      setMention(null);
      clearTimeout(idle.current);
      nearBottom.current = true;
    }
    inputRef.current?.focus(); // keep the keyboard up for the next line
  }

  const empty = view.joined && view.chat.length === 0;

  return (
    <div className={`relative flex min-h-0 flex-1 flex-col ${className}`}>
      <div ref={listRef} onScroll={onScroll} className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto overscroll-contain px-4">
        {empty ? (
          <p className="enter m-auto py-10 text-[15px] text-fog-500">No messages yet</p>
        ) : (
          // mt-auto keeps short conversations anchored to the bottom, next to the composer
          <ol className="mt-auto flex flex-col pt-3 pb-3" aria-live="polite" aria-label="Messages">
            {!view.joined ? (
              <ChatSkeleton />
            ) : (
              view.chat.map((item, i) => (
                <Row
                  key={item.key}
                  item={item}
                  prev={view.chat[i - 1]}
                  next={view.chat[i + 1]}
                  me={view.me}
                  myName={myName}
                  people={people}
                  shownIds={shownIds}
                  onReply={canSend ? startReply : undefined}
                  onJump={jumpTo}
                />
              ))
            )}
          </ol>
        )}
        <AnimatePresence initial={false}>{view.typing.length > 0 && <TypingBubble key="typing" typing={view.typing} />}</AnimatePresence>
      </div>

      <AnimatePresence>
        {unseen && (
          <motion.button
            initial={{ opacity: 0, y: 8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.96 }}
            transition={{ type: "spring", bounce: 0, duration: 0.3 }}
            onClick={jumpDown}
            className="glass press absolute left-1/2 z-10 -ml-[70px] flex h-9 w-[140px] items-center justify-center gap-1.5 rounded-full text-[13px] font-semibold text-fog-50"
            style={{ bottom: (above ? 132 : 84) + (replyTo ? 64 : 0) }}
          >
            <ArrowDownIcon size={15} weight="bold" /> New messages
          </motion.button>
        )}
      </AnimatePresence>

      <div aria-live="polite" className="px-4">
        {view.notice && <p className="enter pb-2 text-[13px] text-danger">{view.notice}</p>}
      </div>

      {above}

      <div className="relative">
        <AnimatePresence>
          {picking && (
            <motion.ul
              key="mentions"
              id="mention-list"
              role="listbox"
              aria-label="People"
              initial={{ opacity: 0, y: 6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.12 } }}
              transition={{ type: "spring", bounce: 0, duration: 0.25 }}
              style={{ transformOrigin: "20% 100%" }}
              // Solid, not glass: it sits over chat text, where a see-through surface muddies both.
              className="absolute right-3 bottom-full left-3 z-20 mb-2 flex flex-col rounded-[22px] bg-ink-850 p-1.5 shadow-[inset_0_1px_0_rgb(255_255_255/0.07),inset_0_0_0_1px_rgb(255_255_255/0.06),0_16px_48px_rgb(7_6_5/0.6)]"
            >
              {suggestions.map((p, i) => (
                <li
                  key={p.name}
                  id={`mention-${p.name}`}
                  role="option"
                  aria-selected={i === active}
                  // Keep focus (and the keyboard) in the input.
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => pick(p.name)}
                  onPointerEnter={(e) => e.pointerType === "mouse" && setActive(i)}
                  className={`press flex h-11 cursor-pointer items-center gap-2.5 rounded-[16px] px-2.5 select-none ${i === active ? "bg-white/10" : ""}`}
                >
                  <Avatar name={p.name} size={26} />
                  <span className="min-w-0 flex-1 truncate text-[15px] text-fog-50">
                    <span className="font-semibold text-plum-200">{p.name.slice(0, mention!.query.length)}</span>
                    {p.name.slice(mention!.query.length)}
                  </span>
                  {p.away && <span className="text-[12px] text-fog-500">not here</span>}
                </li>
              ))}
            </motion.ul>
          )}
        </AnimatePresence>

        <AnimatePresence initial={false}>
          {replyTo && (
            <motion.div
              key="reply"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8, transition: { duration: 0.12 } }}
              transition={{ type: "spring", bounce: 0, duration: 0.3 }}
              className="mx-3 mb-1.5 flex items-center gap-3 rounded-[18px] bg-ink-800 py-2 pr-1.5 pl-3"
            >
              <span className="w-[3px] self-stretch rounded-full bg-plum-400" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-[12px] text-fog-500">
                  Replying to <span className="font-semibold text-fog-100">{replyTo.senderId === view.me ? "yourself" : replyTo.sender}</span>
                </p>
                <p className="truncate text-[13px] text-fog-300">{replyTo.text}</p>
              </div>
              <button
                type="button"
                aria-label="Cancel reply"
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => setReplyTo(null)}
                className="press grid size-9 shrink-0 place-items-center rounded-full text-fog-300 hover:bg-white/10"
              >
                <XIcon size={16} weight="bold" />
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        <form onSubmit={submit} className="flex items-center gap-2 px-3 pt-1 pb-[max(12px,env(safe-area-inset-bottom))]">
          {lead && !typing && <div className="flex shrink-0 gap-2">{lead}</div>}
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => {
              onDraft(e.target.value);
              findMention();
            }}
            onSelect={findMention}
            onKeyDown={onKeyDown}
            onFocus={() => setFocused(true)}
            // Let a tap on Send land before the button disappears.
            onBlur={() =>
              setTimeout(() => {
                setFocused(false);
                setMention(null);
              }, 120)
            }
            placeholder={canSend ? (replyTo ? `Reply to ${replyTo.senderId === view.me ? "yourself" : replyTo.sender}` : "Say something to the room") : "Connecting…"}
            aria-label="Message"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={picking}
            aria-controls={picking ? "mention-list" : undefined}
            aria-activedescendant={picking ? `mention-${suggestions[Math.min(active, suggestions.length - 1)].name}` : undefined}
            maxLength={1000}
            autoComplete="off"
            enterKeyHint="send"
            disabled={!canSend}
            className="h-[52px] min-w-0 flex-1 rounded-full bg-ink-800 px-5 text-base text-fog-50 transition-shadow duration-150 outline-none placeholder:text-fog-600 focus:shadow-[0_0_0_2px_var(--color-plum-600)]"
          />
          {typing && (
            <button
              disabled={!canSend || !draft.trim()}
              aria-label="Send"
              onPointerDown={(e) => e.preventDefault()} // keep focus in the input
              className="press grid size-[52px] shrink-0 place-items-center rounded-full bg-plum-700 text-fog-50 transition-opacity duration-150 disabled:opacity-40"
            >
              <ArrowUpIcon size={20} weight="bold" />
            </button>
          )}
        </form>
      </div>
    </div>
  );
}

type RowProps = {
  item: ChatItem;
  prev?: ChatItem;
  next?: ChatItem;
  me: number | null;
  myName?: string;
  people: Map<string, { name: string }>;
  shownIds: Set<number>;
  onReply?: (item: Msg) => void;
  onJump: (id: number) => void;
};

function Row({ item, prev, next, me, myName, people, shownIds, onReply, onJump }: RowProps) {
  const enter = item.live ? "enter" : "";
  if (item.kind === "system") {
    return <li className={`my-3 text-center text-[13px] text-fog-500 ${enter}`}>{item.text}</li>;
  }
  const joins = (a?: ChatItem, b?: ChatItem) =>
    a?.kind === "msg" && b?.kind === "msg" && a.senderId === b.senderId && b.time - a.time < GROUP_MS && !b.reply;
  const first = !joins(prev, item);
  const last = !joins(item, next);
  const mine = item.senderId === me;
  const time = timeFmt.format(item.time);
  const reply = onReply && item.id !== undefined ? () => onReply(item) : undefined;
  const forYou = forMe(item, me, myName);

  const bubble = (
    <div
      data-bubble
      title={time}
      className={`min-w-0 px-3.5 py-2 text-[15px] leading-[1.4] break-words whitespace-pre-wrap ${
        mine
          ? "rounded-[18px_18px_6px_18px] bg-plum-700 text-fog-50"
          : `rounded-[18px_18px_18px_6px] text-fog-100 ${forYou ? "bg-[color-mix(in_oklab,var(--color-plum-800)_45%,var(--color-ink-700))] shadow-[inset_0_0_0_1.5px_var(--color-plum-400)]" : "bg-ink-700"}`
      }`}
    >
      {item.reply && <Quote quote={item.reply} me={me} mine={mine} onJump={shownIds.has(item.reply.id) ? onJump : undefined} />}
      <MessageText text={item.text} people={people} />
    </div>
  );
  const replyButton = reply && (
    <button
      type="button"
      onClick={reply}
      aria-label={`Reply to ${mine ? "your message" : item.sender}`}
      className="press grid size-8 shrink-0 place-items-center self-center rounded-full text-fog-500 opacity-0 transition-opacity duration-150 group-hover:opacity-100 hover:bg-white/10 hover:text-fog-100 focus-visible:opacity-100 pointer-coarse:hidden"
    >
      <ArrowBendUpLeftIcon size={16} weight="bold" />
    </button>
  );

  return (
    <SwipeToReply
      onReply={reply}
      data-msg={item.id}
      className={`group ${first ? "mt-3" : "mt-1"} ${item.pending ? "opacity-50" : "transition-opacity duration-200"} ${enter}`}
    >
      {mine ? (
        <div className="flex items-center justify-end gap-1.5">
          {replyButton}
          <div className="flex max-w-[78%] min-w-0">{bubble}</div>
        </div>
      ) : (
        <div className="flex items-end gap-2">
          <span className="w-7 shrink-0">{last && <Avatar name={item.sender} size={28} />}</span>
          <div className="flex max-w-[78%] min-w-0 flex-col items-start gap-1">
            {first && <span className="pl-3 text-[12px] font-medium text-fog-500">{item.sender}</span>}
            {bubble}
          </div>
          {replyButton}
        </div>
      )}
    </SwipeToReply>
  );
}

/** The message a reply answers, at the top of its bubble; tap to see the original. */
function Quote({ quote, me, mine, onJump }: { quote: ChatQuote; me: number | null; mine: boolean; onJump?: (id: number) => void }) {
  const body = (
    <>
      <span className={`w-[3px] self-stretch rounded-full ${mine ? "bg-fog-50/60" : "bg-plum-400"}`} aria-hidden />
      <span className="flex min-w-0 flex-col">
        <span className={`text-[12px] font-semibold ${mine ? "text-fog-50" : "text-plum-200"}`}>{quote.senderId === me ? "You" : quote.sender}</span>
        <span className={`line-clamp-2 text-[13px] leading-[1.35] whitespace-normal ${mine ? "text-fog-100/80" : "text-fog-300"}`}>{quote.text}</span>
      </span>
    </>
  );
  const cls = `-mx-1.5 mb-1.5 flex gap-2 rounded-[12px] bg-ink-975/30 px-2 py-1.5 text-left`;
  return onJump ? (
    <button type="button" onClick={() => onJump(quote.id)} aria-label={`Show ${quote.sender}'s message`} className={`press ${cls} w-[calc(100%+12px)]`}>
      {body}
    </button>
  ) : (
    <span className={`${cls} w-[calc(100%+12px)]`}>{body}</span>
  );
}

/** A message's text, with @names of people in the room picked out. */
function MessageText({ text, people }: { text: string; people: Map<string, { name: string }> }) {
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(MENTION_RE)) {
    if (!people.has(m[1].toLowerCase())) continue;
    if (m.index > at) parts.push(text.slice(at, m.index));
    parts.push(
      <span key={m.index} className="font-semibold text-plum-200">
        {m[0]}
      </span>,
    );
    at = m.index + m[0].length;
  }
  if (parts.length === 0) return <>{text}</>;
  parts.push(text.slice(at));
  return <>{parts}</>;
}

/**
 * Swipe a message right to answer it (touch and pen; a mouse uses the reply button). The row
 * follows the finger 1:1 once the drag is clearly sideways, resists past the point where
 * letting go replies, ticks when it gets there, and springs home from wherever it is.
 */
function SwipeToReply({
  onReply,
  className,
  children,
  ...rest
}: { onReply?: () => void; className: string; children: React.ReactNode; "data-msg"?: number }) {
  const x = useMotionValue(0);
  const iconOpacity = useTransform(x, [16, SWIPE_REPLY], [0, 1]);
  const iconScale = useTransform(x, [16, SWIPE_REPLY], [0.5, 1]);
  const g = useRef<{ id: number; x0: number; y0: number; state: "pending" | "drag" | "off"; armed: boolean } | null>(null);

  function settle(velocity = 0) {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return x.set(0);
    animate(x, 0, { type: "spring", bounce: 0, duration: 0.35, velocity });
  }

  return (
    <motion.li
      {...rest}
      className={`relative touch-pan-y ${className}`}
      onPointerDown={(e) => {
        if (!onReply || e.pointerType === "mouse" || !e.isPrimary) return;
        x.stop();
        g.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, state: "pending", armed: false };
      }}
      onPointerMove={(e) => {
        const st = g.current;
        if (!st || st.id !== e.pointerId || st.state === "off") return;
        const dx = e.clientX - st.x0;
        const dy = e.clientY - st.y0;
        if (st.state === "pending") {
          // Wait for a clear direction: vertical stays a scroll, sideways becomes ours.
          if (Math.abs(dy) > 10 && Math.abs(dy) >= Math.abs(dx)) st.state = "off";
          else if (dx > 10 && dx > Math.abs(dy) * 1.2) {
            st.state = "drag";
            st.x0 = e.clientX; // start from here, so nothing jumps by the 10px of slop
            e.currentTarget.setPointerCapture(e.pointerId);
          }
          return;
        }
        const d = Math.max(0, dx);
        x.set(d <= SWIPE_REPLY ? d : SWIPE_REPLY + rubberband(d - SWIPE_REPLY, 240));
        const armed = d >= SWIPE_REPLY;
        if (armed && !st.armed) navigator.vibrate?.(8);
        st.armed = armed;
      }}
      onPointerUp={(e) => {
        const st = g.current;
        g.current = null;
        if (st?.state !== "drag" || st.id !== e.pointerId) return;
        if (st.armed) onReply?.();
        settle(x.getVelocity());
      }}
      onPointerCancel={() => {
        if (g.current?.state === "drag") settle();
        g.current = null;
      }}
    >
      {onReply && (
        <motion.span
          aria-hidden
          style={{ opacity: iconOpacity, scale: iconScale }}
          className="absolute top-1/2 left-0 -mt-4 grid size-8 place-items-center rounded-full bg-ink-800 text-plum-200"
        >
          <ArrowBendUpLeftIcon size={16} weight="bold" />
        </motion.span>
      )}
      <motion.div style={{ x }}>{children}</motion.div>
    </motion.li>
  );
}

// Past a boundary, follow less and less the further it goes: resistance rather than a wall.
function rubberband(overshoot: number, dimension: number, constant = 0.55) {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

/** "juno is typing", with the dots, where their message is about to appear. */
function TypingBubble({ typing }: { typing: Typist[] }) {
  const [first, second] = typing;
  const who =
    typing.length === 1
      ? `${first.name} is typing`
      : typing.length === 2
        ? `${first.name} and ${second.name} are typing`
        : `${first.name} and ${typing.length - 1} others are typing`;
  return (
    <motion.div
      initial={{ opacity: 0, y: 6, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.15 } }}
      transition={{ type: "spring", bounce: 0, duration: 0.3 }}
      style={{ transformOrigin: "0% 100%" }}
      className="mt-3 mb-3 flex items-end gap-2"
      role="status"
    >
      <Avatar name={first.name} size={28} />
      <div className="flex flex-col items-start gap-1">
        <span className="pl-3 text-[12px] font-medium text-fog-500">{who}</span>
        <TypingDots />
      </div>
    </motion.div>
  );
}

// Perpetual motion: a leaf of its own, so the dots never re-render the chat.
const TypingDots = memo(function TypingDots() {
  return (
    <span className="flex h-9 items-center gap-1 rounded-[18px_18px_18px_6px] bg-ink-700 px-3.5" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span key={i} className="size-[7px] rounded-full bg-fog-300 animate-typing-dot" style={{ animationDelay: `${i * 160}ms` }} />
      ))}
    </span>
  );
});

function ChatSkeleton() {
  return (
    <>
      {[62, 40, 75].map((w, i) => (
        <li key={i} className={`mt-3 flex items-end gap-2 ${i === 1 ? "justify-end" : ""}`} aria-hidden>
          {i !== 1 && <span className="skeleton size-7 shrink-0 rounded-full" />}
          <span className="skeleton h-9 rounded-[18px]" style={{ width: `${w}%` }} />
        </li>
      ))}
    </>
  );
}
