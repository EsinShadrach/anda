import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { CaretLeftIcon, ChatCircleIcon, CheckIcon, CopyIcon, CrownSimpleIcon, MicrophoneIcon } from "@phosphor-icons/react";
import type { Connection, Member, RoomConnection, RoomView } from "@/lib/room";
import { Avatar } from "@/components/ui/avatar";
import { Spinner } from "@/components/ui/spinner";

// Floating glass bar over the stage: out, the room code (tap to invite), who's here.
export function RoomHeader({
  view,
  conn,
  chat,
  voice,
  speaking,
  className = "",
}: {
  view: RoomView;
  conn: RoomConnection;
  voice?: React.ReactNode; // mic and camera buttons
  speaking?: Set<number>; // user IDs talking on voice right now
  chat?: { unread: number; onOpen: () => void }; // phones, while chat is closed
  className?: string;
}) {
  const router = useRouter();
  return (
    <header className={`flex items-center gap-2 ${className}`}>
      <button
        onClick={() => router.push("/")}
        aria-label="Leave room"
        title="Leave room"
        className="glass press grid size-11 shrink-0 place-items-center rounded-2xl text-fog-100 hover:text-fog-50"
      >
        <CaretLeftIcon size={20} weight="bold" />
      </button>
      <InviteChip code={view.code} />
      <div className="flex-1" />
      <Reconnecting visible={view.status === "reconnecting"} />
      {voice}
      <AnimatePresence initial={false}>{chat && <ChatButton key="chat" {...chat} />}</AnimatePresence>
      <MembersButton view={view} conn={conn} speaking={speaking} />
    </header>
  );
}

function InviteChip({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function invite() {
    const url = `${location.origin}/room?code=${code}`;
    try {
      // Phones get the share sheet; everything else copies the link.
      if (navigator.share && matchMedia("(pointer: coarse)").matches) {
        await navigator.share({ title: "Join my room on Anda", url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      // Share sheet dismissed or clipboard blocked.
    }
  }

  return (
    <button
      onClick={invite}
      aria-label={`Room code ${code}. Copy invite link`}
      className="glass press group flex h-11 items-center gap-2.5 rounded-2xl pr-3 pl-4 text-fog-50"
    >
      <span className="font-mono text-[15px] font-medium tracking-[0.14em]">{code}</span>
      <span className="grid size-5 place-items-center text-fog-500 group-hover:text-fog-100" aria-hidden>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={copied ? "done" : "copy"}
            initial={{ opacity: 0, scale: 0.6, filter: "blur(3px)" }}
            animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
            exit={{ opacity: 0, scale: 0.6, filter: "blur(3px)" }}
            transition={{ type: "spring", bounce: 0, duration: 0.25 }}
            className={copied ? "text-live" : ""}
          >
            {copied ? <CheckIcon size={17} weight="bold" /> : <CopyIcon size={17} />}
          </motion.span>
        </AnimatePresence>
      </span>
      <span className="sr-only" aria-live="polite">
        {copied ? "Invite link copied" : ""}
      </span>
    </button>
  );
}

// Brings a closed chat back; the badge counts messages that came in meanwhile.
function ChatButton({ unread, onOpen }: { unread: number; onOpen: () => void }) {
  return (
    <motion.button
      initial={{ opacity: 0, scale: 0.8, filter: "blur(4px)" }}
      animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
      exit={{ opacity: 0, scale: 0.8, filter: "blur(4px)", transition: { duration: 0.12 } }}
      transition={{ type: "spring", bounce: 0, duration: 0.3 }}
      onClick={onOpen}
      aria-label={unread ? `Show chat, ${unread} new` : "Show chat"}
      className="glass press relative grid size-11 shrink-0 place-items-center rounded-2xl text-fog-100"
    >
      <ChatCircleIcon size={21} />
      <AnimatePresence>
        {unread > 0 && (
          <motion.span
            key="badge"
            initial={{ scale: 0.4, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.4, opacity: 0 }}
            transition={{ type: "spring", bounce: 0.3, duration: 0.3 }}
            className="absolute -top-1 -right-1 grid h-5 min-w-5 place-items-center rounded-full bg-ember-500 px-1 text-[11px] font-bold text-ink-950 tabular-nums"
          >
            {unread > 9 ? "9+" : unread}
          </motion.span>
        )}
      </AnimatePresence>
    </motion.button>
  );
}

// Appears only if reconnecting lasts past 600ms, so a quick resume never flashes it.
function Reconnecting({ visible }: { visible: boolean }) {
  return (
    <div
      role="status"
      data-visible={visible}
      className="glass pointer-events-none flex h-9 items-center gap-2 rounded-full px-3 text-[13px] font-medium text-fog-100 opacity-0 transition-opacity duration-200 data-[visible=true]:opacity-100 data-[visible=true]:delay-600"
    >
      <Spinner size={14} className="text-ember-400" />
      <span className="max-sm:sr-only">Reconnecting</span>
    </div>
  );
}

function MembersButton({ view, conn, speaking }: { view: RoomView; conn: RoomConnection; speaking?: Set<number> }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const shown = view.members.slice(0, 3);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`${view.members.length} in the room`}
        className="glass press flex h-11 items-center gap-2 rounded-2xl pr-3.5 pl-2"
      >
        <span className="flex -space-x-2">
          {shown.length === 0 ? (
            <span className="skeleton size-7 rounded-full" />
          ) : (
            shown.map((m) => <Avatar key={m.user_id} name={m.username} size={28} ring />)
          )}
        </span>
        <span className="text-[14px] font-semibold text-fog-100 tabular-nums">{view.members.length || ""}</span>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -4, transition: { duration: 0.12 } }}
            transition={{ type: "spring", bounce: 0, duration: 0.25 }}
            style={{ transformOrigin: "top right" }}
            className="glass-thick absolute top-[calc(100%+8px)] right-0 z-30 w-[288px] rounded-2xl p-2"
          >
            <p className="px-2.5 pt-1.5 pb-2 text-[12px] font-semibold tracking-[0.06em] text-fog-500 uppercase">
              In the room
            </p>
            <ul className="flex flex-col">
              {view.members.map((m) => (
                <MemberRow
                  key={m.user_id}
                  m={m}
                  me={m.user_id === view.me}
                  host={m.user_id === view.host}
                  speaking={!!speaking?.has(m.user_id)}
                  onMakeHost={view.me === view.host && m.user_id !== view.me ? () => conn.hostTransfer(m.user_id) : undefined}
                />
              ))}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function MemberRow({
  m,
  me,
  host,
  speaking,
  onMakeHost,
}: {
  m: Member;
  me: boolean;
  host: boolean;
  speaking: boolean;
  onMakeHost?: () => void;
}) {
  // Handing over can't be undone by us, so it takes a second tap to confirm.
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 3000);
    return () => clearTimeout(t);
  }, [confirming]);

  return (
    <li className="group flex h-11 items-center gap-3 rounded-xl px-2.5">
      <Avatar name={m.username} status={m.status} size={28} />
      <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[14px] font-medium text-fog-100">
        <span className="truncate">
          {m.username}
          {me && <span className="font-normal text-fog-500"> (you)</span>}
        </span>
        {speaking && <MicrophoneIcon size={13} weight="fill" className="shrink-0 text-live" aria-label="talking" />}
        {m.status === "online" && m.connection && <ConnectionDot connection={m.connection} />}
      </span>
      {host && (
        <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-ember-400">
          <CrownSimpleIcon size={13} weight="fill" /> Host
        </span>
      )}
      {m.status === "away" && !host && <span className="text-[12px] text-fog-500 group-hover:hidden">Away</span>}
      {onMakeHost && (
        <button
          onClick={() => (confirming ? onMakeHost() : setConfirming(true))}
          className={`press h-7 rounded-lg px-2.5 text-[12px] font-semibold transition-colors ${
            confirming
              ? "bg-ember-500 text-ink-950"
              : "bg-white/8 text-fog-300 hover:bg-white/12 hover:text-fog-50 pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:focus-visible:opacity-100"
          } ${m.status === "away" ? "pointer-fine:hidden pointer-fine:group-hover:block" : ""}`}
        >
          {confirming ? "Hand over" : "Make host"}
        </button>
      )}
    </li>
  );
}

// The plan's connection indicator: green, amber or red from their film buffering, so
// people can see why the room is waiting.
function ConnectionDot({ connection }: { connection: Connection }) {
  const label = connection === "good" ? "Smooth playback" : connection === "fair" ? "Some buffering" : "Struggling to keep up";
  return (
    <span title={label} aria-label={label} className="grid size-3 shrink-0 place-items-center">
      <span className={`size-2 rounded-full ${connection === "good" ? "bg-live" : connection === "fair" ? "bg-away" : "bg-danger"}`} />
    </span>
  );
}
