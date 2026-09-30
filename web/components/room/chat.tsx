import { useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowDownIcon,
  ChatCircleDotsIcon,
  CrownSimpleIcon,
  PaperPlaneRightIcon,
  SignInIcon,
  SignOutIcon,
} from "@phosphor-icons/react";
import type { ChatItem, RoomConnection, RoomView } from "@/lib/room";
import { Avatar, hue } from "@/components/ui/avatar";

const GROUP_MS = 3 * 60 * 1000;
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

type Props = {
  view: RoomView;
  conn: RoomConnection;
  /** Space kept clear at the top of the list (the sheet's handle sits there). */
  topInset?: number;
  onComposerFocus?: () => void;
};

export function Chat({ view, conn, topInset = 0, onComposerFocus }: Props) {
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const [unseen, setUnseen] = useState(false);
  const canSend = view.status === "open" && view.joined;

  // Follow new messages only while the reader is at the bottom; otherwise offer a jump.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (nearBottom.current) el.scrollTop = el.scrollHeight;
    else setUnseen(true);
  }, [view.chat.length]);

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
      nearBottom.current = true;
    }
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={listRef}
        onScroll={onScroll}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-4"
        style={{ paddingTop: topInset }}
      >
        {/* mt-auto keeps short conversations anchored to the bottom, next to the composer */}
        <ol className="mt-auto flex flex-col pt-3 pb-2" aria-live="polite" aria-label="Messages">
          {!view.joined ? (
            <ChatSkeleton />
          ) : view.chat.length === 0 ? (
            <EmptyChat />
          ) : (
            view.chat.map((item, i) => <Row key={item.key} item={item} prev={view.chat[i - 1]} me={view.me} />)
          )}
        </ol>
      </div>

      <AnimatePresence>
        {unseen && (
          <motion.button
            initial={{ opacity: 0, y: 8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.96 }}
            transition={{ type: "spring", bounce: 0, duration: 0.3 }}
            onClick={jumpDown}
            className="glass press absolute bottom-[76px] left-1/2 z-10 -ml-[70px] flex h-9 w-[140px] items-center justify-center gap-1.5 rounded-full text-[13px] font-semibold text-fog-50"
          >
            <ArrowDownIcon size={15} weight="bold" /> New messages
          </motion.button>
        )}
      </AnimatePresence>

      <div aria-live="polite" className="px-4">
        {view.notice && <p className="enter pb-2 text-[13px] text-danger">{view.notice}</p>}
      </div>

      <form onSubmit={submit} className="px-3 pt-1 pb-[max(12px,env(safe-area-inset-bottom))]">
        <div className="flex items-center gap-2 rounded-2xl bg-ink-800/80 p-1.5 pl-4 ring-1 ring-white/6 transition-shadow duration-150 focus-within:ring-ember-500/70">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={onComposerFocus}
            placeholder={canSend ? "Say something to the room" : "Connecting…"}
            aria-label="Message"
            maxLength={1000}
            autoComplete="off"
            enterKeyHint="send"
            disabled={!canSend}
            className="h-10 min-w-0 flex-1 bg-transparent text-base text-fog-50 outline-none placeholder:text-fog-600"
          />
          <button
            disabled={!canSend || !draft.trim()}
            aria-label="Send"
            className="press grid size-10 shrink-0 place-items-center rounded-xl bg-ember-500 text-ink-950 hover:bg-ember-400 disabled:bg-transparent disabled:text-fog-600"
          >
            <PaperPlaneRightIcon size={19} weight="fill" />
          </button>
        </div>
      </form>
    </div>
  );
}

function Row({ item, prev, me }: { item: ChatItem; prev?: ChatItem; me: number | null }) {
  const enter = item.live ? "enter" : "";
  if (item.kind === "system") {
    const Icon = item.text.endsWith("joined") ? SignInIcon : item.text.endsWith("left") ? SignOutIcon : CrownSimpleIcon;
    return (
      <li className={`my-3 flex justify-center ${enter}`}>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-white/4 px-2.5 py-1 text-[12px] font-medium text-fog-500">
          <Icon size={13} weight="bold" />
          {item.text}
        </span>
      </li>
    );
  }
  const grouped = prev?.kind === "msg" && prev.senderId === item.senderId && item.time - prev.time < GROUP_MS;
  const mine = item.senderId === me;
  return (
    <li className={`${grouped ? "mt-0.5" : "mt-4"} ${item.pending ? "opacity-50" : "transition-opacity duration-200"} ${enter}`}>
      {!grouped && (
        <div className="mb-0.5 flex items-center gap-2.5">
          <Avatar name={item.sender} size={24} />
          <span
            className="text-[14px] font-semibold tracking-[-0.01em]"
            style={{ color: mine ? "var(--color-ember-400)" : `oklch(0.84 0.07 ${hue(item.sender)})` }}
          >
            {item.sender}
          </span>
          <time className="font-mono text-[11px] text-fog-600" dateTime={new Date(item.time).toISOString()}>
            {timeFmt.format(item.time)}
          </time>
        </div>
      )}
      <p className="pl-[34px] text-[15px] leading-[1.45] break-words whitespace-pre-wrap text-fog-100">{item.text}</p>
    </li>
  );
}

function EmptyChat() {
  return (
    <li className="enter flex flex-col items-center gap-3 px-6 py-10 text-center">
      <span className="grid size-12 place-items-center rounded-2xl bg-ember-500/10 text-ember-400 ring-1 ring-ember-500/20">
        <ChatCircleDotsIcon size={24} weight="duotone" />
      </span>
      <p className="text-[15px] font-semibold text-fog-100">No messages yet</p>
      <p className="max-w-[26ch] text-[14px] leading-relaxed text-fog-500">
        Say hi. Everyone in the room sees it the moment you send it.
      </p>
    </li>
  );
}

function ChatSkeleton() {
  return (
    <>
      {[70, 45, 85, 55].map((w, i) => (
        <li key={i} className="mt-4 flex gap-2.5" aria-hidden>
          <span className="skeleton size-6 shrink-0 rounded-full" />
          <div className="flex flex-1 flex-col gap-1.5">
            <span className="skeleton h-3.5 w-20 rounded" />
            <span className="skeleton h-3.5 rounded" style={{ width: `${w}%` }} />
          </div>
        </li>
      ))}
    </>
  );
}
