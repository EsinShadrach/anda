import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowDownIcon, ArrowUpIcon } from "@phosphor-icons/react";
import type { ChatItem, RoomConnection, RoomView, Typist } from "@/lib/room";
import { Avatar } from "@/components/ui/avatar";

const GROUP_MS = 3 * 60 * 1000;
// Stop saying we're typing after this long without a keystroke.
const TYPING_IDLE_MS = 4000;
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

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
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const nearBottom = useRef(true);
  const [unseen, setUnseen] = useState(false);
  const canSend = view.status === "open" && view.joined;
  const typing = focused || draft.length > 0;

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

  // Keep the newest message in view when the list shrinks (keyboard opening, phone rotating).
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

  function jumpDown() {
    const el = listRef.current!;
    nearBottom.current = true;
    setUnseen(false);
    el.scrollTo({ top: el.scrollHeight, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }

  function submit(e: React.SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    if (conn.sendChat(draft)) {
      setDraft("");
      clearTimeout(idle.current);
      nearBottom.current = true;
    }
    inputRef.current?.focus(); // keep the keyboard up for the next line
  }

  const empty = view.joined && view.chat.length === 0;

  return (
    <div className={`relative flex min-h-0 flex-1 flex-col ${className}`}>
      <div ref={listRef} onScroll={onScroll} className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-4">
        {empty ? (
          <p className="enter m-auto py-10 text-[15px] text-fog-500">No messages yet</p>
        ) : (
          // mt-auto keeps short conversations anchored to the bottom, next to the composer
          <ol className="mt-auto flex flex-col pt-3 pb-3" aria-live="polite" aria-label="Messages">
            {!view.joined ? <ChatSkeleton /> : view.chat.map((item, i) => <Row key={item.key} item={item} prev={view.chat[i - 1]} next={view.chat[i + 1]} me={view.me} />)}
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
            style={{ bottom: above ? 132 : 84 }}
          >
            <ArrowDownIcon size={15} weight="bold" /> New messages
          </motion.button>
        )}
      </AnimatePresence>

      <div aria-live="polite" className="px-4">
        {view.notice && <p className="enter pb-2 text-[13px] text-danger">{view.notice}</p>}
      </div>

      {above}

      <form onSubmit={submit} className="flex items-center gap-2 px-3 pt-1 pb-[max(12px,env(safe-area-inset-bottom))]">
        {lead && !typing && <div className="flex shrink-0 gap-2">{lead}</div>}
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          onFocus={() => setFocused(true)}
          // Let a tap on Send land before the button disappears.
          onBlur={() => setTimeout(() => setFocused(false), 120)}
          placeholder={canSend ? "Say something to the room" : "Connecting…"}
          aria-label="Message"
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
  );
}

function Row({ item, prev, next, me }: { item: ChatItem; prev?: ChatItem; next?: ChatItem; me: number | null }) {
  const enter = item.live ? "enter" : "";
  if (item.kind === "system") {
    return <li className={`my-3 text-center text-[13px] text-fog-500 ${enter}`}>{item.text}</li>;
  }
  const joins = (a?: ChatItem, b?: ChatItem) => a?.kind === "msg" && b?.kind === "msg" && a.senderId === b.senderId && b.time - a.time < GROUP_MS;
  const first = !joins(prev, item);
  const last = !joins(item, next);
  const mine = item.senderId === me;
  const time = timeFmt.format(item.time);

  if (mine) {
    return (
      <li className={`flex justify-end ${first ? "mt-3" : "mt-1"} ${item.pending ? "opacity-50" : "transition-opacity duration-200"} ${enter}`}>
        <p
          title={time}
          className="max-w-[78%] rounded-[18px_18px_6px_18px] bg-plum-700 px-3.5 py-2 text-[15px] leading-[1.4] break-words whitespace-pre-wrap text-fog-50"
        >
          {item.text}
        </p>
      </li>
    );
  }
  return (
    <li className={`flex items-end gap-2 ${first ? "mt-3" : "mt-1"} ${enter}`}>
      <span className="w-7 shrink-0">{last && <Avatar name={item.sender} size={28} />}</span>
      <div className="flex max-w-[78%] min-w-0 flex-col items-start gap-1">
        {first && <span className="pl-3 text-[12px] font-medium text-fog-500">{item.sender}</span>}
        <p
          title={time}
          className="rounded-[18px_18px_18px_6px] bg-ink-700 px-3.5 py-2 text-[15px] leading-[1.4] break-words whitespace-pre-wrap text-fog-100"
        >
          {item.text}
        </p>
      </div>
    </li>
  );
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
