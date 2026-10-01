import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  CaretDownIcon,
  CaretUpIcon,
  ChatCircleIcon,
  CrownSimpleIcon,
  EyeIcon,
  EyeSlashIcon,
  HourglassIcon,
  VideoCameraIcon,
  WaveformIcon,
} from "@phosphor-icons/react";
import type { Connection, Member, RoomConnection, RoomView } from "@/lib/room";
import type { VoicePeer, VoiceSession, VoiceState } from "@/lib/voice";
import { Avatar } from "@/components/ui/avatar";
import { MenuItem, Popover } from "@/components/ui/popover";
import { TrackVideo } from "./voice";

// The couch: everyone in the room as a seat. A seat is a camera tile when that person's
// camera is on (and we're watching it), otherwise their initial. Rings say what's going on:
// amber while they're catching up, green while they talk, plum for you.

type Seat = {
  member: Member;
  me: boolean;
  host: boolean;
  peer?: VoicePeer;
  waiting?: "buffering" | "getting_ready"; // the room is waiting for them
  video: VoicePeer["video"]; // what to show, after hiding
};

export function useSeats(view: RoomView, vs: VoiceState): Seat[] {
  const peers = new Map(vs.peers.map((p) => [p.id, p]));
  const waiting = new Map(view.blockers.map((b) => [b.user_id, b.reason]));
  const seats = view.members.map((m) => {
    const peer = peers.get(m.user_id);
    return {
      member: m,
      me: m.user_id === view.me,
      host: m.user_id === view.host,
      peer,
      waiting: view.playback?.want === "playing" ? waiting.get(m.user_id) : undefined,
      video: !vs.tilesHidden && peer?.camOn ? peer.video : null,
    };
  });
  // You first, then whoever's here, then whoever's away.
  const rank = (s: Seat) => (s.me ? 0 : s.member.status === "online" ? 1 : 2);
  return seats.sort((a, b) => rank(a) - rank(b));
}

type Size = "lg" | "md";

const DIM = {
  lg: { tileW: 112, tileH: 68, avatar: 68, label: "text-[14px]", gap: "gap-5" },
  md: { tileW: 72, tileH: 52, avatar: 52, label: "text-[12px]", gap: "gap-3" },
};

function ringColour(s: Seat): string | null {
  if (s.waiting) return "var(--color-away)";
  if (s.peer?.speaking) return "var(--color-live)";
  if (s.me) return "var(--color-plum-400)";
  return null;
}

/** A row of seats that scrolls sideways when the room is bigger than the couch. */
export function SeatRow({
  view,
  conn,
  voice,
  vs,
  size,
  camerasToggle,
  className = "",
}: {
  view: RoomView;
  conn: RoomConnection;
  voice: VoiceSession;
  vs: VoiceState;
  size: Size;
  camerasToggle?: boolean;
  className?: string;
}) {
  const seats = useSeats(view, vs);
  const anyCamera = vs.peers.some((p) => p.camOn);
  return (
    <div
      className={`no-scrollbar min-w-0 overflow-x-auto overscroll-x-contain [mask-image:linear-gradient(90deg,transparent,#000_14px,#000_calc(100%-14px),transparent)] ${className}`}
    >
      <ul className={`mx-auto flex w-max items-start px-4 py-2 ${DIM[size].gap}`} aria-label="In the room">
        {seats.length === 0
          ? [0, 1, 2].map((i) => (
              <li key={i} className="flex flex-col items-center gap-2" aria-hidden>
                <span className="skeleton rounded-full" style={{ width: DIM[size].avatar, height: DIM[size].avatar }} />
                <span className="skeleton h-3 w-10 rounded-full" />
              </li>
            ))
          : seats.map((s) => <SeatView key={s.member.user_id} seat={s} size={size} view={view} conn={conn} voice={voice} vs={vs} />)}
        {camerasToggle && anyCamera && (
          <li className="flex h-[68px] items-center self-start" style={{ height: DIM[size].avatar }}>
            <button
              onClick={() => voice.setTilesHidden(!vs.tilesHidden)}
              aria-label={vs.tilesHidden ? "Show cameras" : "Hide cameras"}
              title={vs.tilesHidden ? "Show cameras" : "Hide cameras (stops receiving them)"}
              className="press grid size-10 place-items-center rounded-full text-fog-500 hover:bg-white/8 hover:text-fog-100"
            >
              {vs.tilesHidden ? <EyeIcon size={20} /> : <EyeSlashIcon size={20} />}
            </button>
          </li>
        )}
      </ul>
    </div>
  );
}

function SeatView({
  seat: s,
  size,
  view,
  conn,
  voice,
  vs,
}: {
  seat: Seat;
  size: Size;
  view: RoomView;
  conn: RoomConnection;
  voice: VoiceSession;
  vs: VoiceState;
}) {
  const d = DIM[size];
  const ref = useRef<HTMLLIElement>(null); // the menu opens off the whole seat, label included
  const [open, setOpen] = useState(false);
  const away = s.member.status === "away";
  const ring = ringColour(s);
  const name = s.me ? "You" : s.member.username;
  const status = s.waiting ? (s.waiting === "buffering" ? "catching up" : "getting ready") : away ? "away" : null;
  const hiddenCam = !!s.peer?.camOn && !s.video;
  const shape = s.video ? { width: d.tileW, height: d.tileH } : { width: d.avatar, height: d.avatar };

  return (
    <li ref={ref} className={`flex flex-col items-center gap-2 transition-opacity duration-300 ${away ? "opacity-55" : ""}`}>
      <div
        className="group relative shrink-0 rounded-full"
        style={{
          ...shape,
          boxShadow: ring ? `0 0 0 3px var(--color-ink-800), 0 0 0 5px ${ring}` : undefined,
          transition: "box-shadow 200ms, width 300ms var(--ease-out-strong), height 300ms var(--ease-out-strong)",
        }}
      >
        <button
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={`${s.member.username}${s.me ? " (you)" : ""}${s.host ? ", host" : ""}${status ? `, ${status}` : ""}`}
          className="press absolute inset-0 overflow-hidden rounded-full bg-ink-700"
        >
          {s.video ? <TrackVideo track={s.video} mirror={s.me} /> : <Avatar name={s.member.username} size={d.avatar} self={s.me} />}
        </button>
        {s.host && (
          <Badge className="-top-1 -right-1 bg-plum-700 text-fog-50" label="Host">
            <CrownSimpleIcon size={12} weight="fill" />
          </Badge>
        )}
        {s.peer?.speaking && (
          <Badge className="-right-1 -bottom-1 bg-live text-ink-950" label="Talking">
            <WaveformIcon size={12} weight="bold" />
          </Badge>
        )}
        {hiddenCam && !s.peer?.speaking && (
          <Badge className="-right-1 -bottom-1 bg-ink-600 text-fog-300" label="Camera on, hidden">
            <VideoCameraIcon size={11} weight="fill" />
          </Badge>
        )}
        {s.video && (
          <button
            onClick={() => voice.setVideoHidden(s.member.user_id, true)}
            aria-label={s.me ? "Hide your self-view" : `Hide ${s.member.username}\u2019s video`}
            title={s.me ? "Hide your self-view (others still see you)" : `Hide ${s.member.username}\u2019s video`}
            className={`press absolute -top-1 -left-1 grid size-6 place-items-center rounded-full bg-ink-850/90 text-fog-300 backdrop-blur-md transition-opacity duration-150 hover:text-fog-50 ${
              s.me ? "" : "pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:focus-visible:opacity-100"
            }`}
          >
            <EyeSlashIcon size={13} />
          </button>
        )}
      </div>
      <span className={`flex max-w-[16ch] items-center gap-1.5 font-medium whitespace-nowrap ${d.label}`}>
        {size === "lg" || !status ? (
          <span className={`truncate ${away ? "text-fog-500" : s.waiting ? "text-away" : "text-fog-100"}`}>{name}</span>
        ) : null}
        {status && (
          <span className={s.waiting ? "text-away" : "text-fog-500"}>
            {size === "lg" && "· "}
            {status}
          </span>
        )}
        {!status && s.member.status === "online" && s.member.connection && s.member.connection !== "good" && (
          <ConnectionDot connection={s.member.connection} />
        )}
      </span>
      <Popover
        anchor={ref.current}
        open={open}
        onClose={() => setOpen(false)}
        placement={size === "lg" ? "top" : "bottom"}
        label={s.member.username}
        className="w-[248px]"
      >
        <SeatMenu seat={s} view={view} conn={conn} voice={voice} vs={vs} close={() => setOpen(false)} />
      </Popover>
    </li>
  );
}

function Badge({ className, label, children }: { className: string; label: string; children: React.ReactNode }) {
  return (
    <span title={label} className={`absolute grid size-[22px] place-items-center rounded-full shadow-[0_0_0_2px_var(--color-ink-800)] ${className}`}>
      {children}
    </span>
  );
}

const CONNECTION_LABEL: Record<Connection, string> = {
  good: "Smooth playback",
  fair: "Some buffering",
  poor: "Struggling to keep up",
};

function ConnectionDot({ connection }: { connection: Connection }) {
  return (
    <span
      title={CONNECTION_LABEL[connection]}
      aria-label={CONNECTION_LABEL[connection]}
      className={`size-2 shrink-0 rounded-full ${connection === "fair" ? "bg-away" : connection === "poor" ? "bg-danger" : "bg-live"}`}
    />
  );
}

// What you can do about a seat: watch or hide their camera, hand over the remote, stop
// waiting for them.
function SeatMenu({
  seat: s,
  view,
  conn,
  voice,
  vs,
  close,
}: {
  seat: Seat;
  view: RoomView;
  conn: RoomConnection;
  voice: VoiceSession;
  vs: VoiceState;
  close: () => void;
}) {
  const iAmHost = view.me === view.host;
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 3000);
    return () => clearTimeout(t);
  }, [confirming]);

  const detail = [
    s.host ? "Host" : null,
    s.member.status === "away" ? "Away" : s.member.connection ? CONNECTION_LABEL[s.member.connection] : "Here",
    s.peer?.micOn ? "on voice" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-3 px-2 pt-1.5 pb-2.5">
        <Avatar name={s.member.username} size={36} self={s.me} />
        <div className="min-w-0">
          <p className="truncate text-[15px] font-semibold text-fog-50">
            {s.member.username}
            {s.me && <span className="font-normal text-fog-500"> (you)</span>}
          </p>
          <p className="truncate text-[12px] text-fog-500">{detail}</p>
        </div>
      </div>
      {s.peer?.camOn && (
        <MenuItem
          icon={s.video ? <EyeSlashIcon size={18} /> : <EyeIcon size={18} />}
          onClick={() => {
            if (!s.video && vs.tilesHidden) voice.setTilesHidden(false);
            voice.setVideoHidden(s.member.user_id, !!s.video);
            close();
          }}
        >
          {s.me ? (s.video ? "Hide your self-view" : "Show your self-view") : s.video ? "Hide their video" : "Show their video"}
        </MenuItem>
      )}
      {iAmHost && s.waiting === "buffering" && !s.me && (
        <MenuItem
          icon={<HourglassIcon size={18} />}
          onClick={() => {
            conn.skipWait(s.member.user_id);
            close();
          }}
        >
          Don&rsquo;t wait for them
        </MenuItem>
      )}
      {iAmHost && !s.me && (
        <MenuItem
          icon={<CrownSimpleIcon size={18} weight={confirming ? "fill" : "regular"} />}
          tone={confirming ? "accent" : undefined}
          onClick={() => {
            if (!confirming) return setConfirming(true);
            conn.hostTransfer(s.member.user_id);
            close();
          }}
        >
          {confirming ? "Tap again to hand over" : "Make host"}
        </MenuItem>
      )}
    </div>
  );
}

// --- Video mode (phone in landscape) --------------------------------------------------------

/** Camera tiles over the film, top right, with a caret to fold them away. */
export function FilmTiles({ view, voice, vs }: { view: RoomView; voice: VoiceSession; vs: VoiceState }) {
  const seats = useSeats(view, vs).filter((s) => s.peer?.camOn);
  if (seats.length === 0) return null;
  return (
    <div className="pointer-events-auto relative flex items-start gap-2">
      <AnimatePresence initial={false}>
        {!vs.tilesHidden &&
          seats
            .filter((s) => s.video)
            .map((s) => {
              const ring = ringColour(s);
              return (
                <motion.span
                  key={s.member.user_id}
                  layout
                  initial={{ opacity: 0, scale: 0.9, filter: "blur(6px)" }}
                  animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
                  exit={{ opacity: 0, scale: 0.9, filter: "blur(4px)", transition: { duration: 0.15 } }}
                  transition={{ type: "spring", bounce: 0, duration: 0.35 }}
                  className="relative block h-14 w-[88px] overflow-hidden rounded-full bg-ink-700"
                  style={{ boxShadow: ring ? `0 0 0 2px ${ring}` : "0 0 0 1px rgb(255 255 255 / 0.1)" }}
                  title={s.me ? "You" : s.member.username}
                >
                  <TrackVideo track={s.video!} mirror={s.me} />
                </motion.span>
              );
            })}
      </AnimatePresence>
      <button
        onClick={() => voice.setTilesHidden(!vs.tilesHidden)}
        aria-label={vs.tilesHidden ? "Show cameras" : "Hide cameras"}
        className={`press grid size-6 shrink-0 place-items-center rounded-full bg-ink-850/80 text-fog-300 backdrop-blur-md ${
          vs.tilesHidden ? "" : "absolute -top-2 -right-2"
        }`}
      >
        {vs.tilesHidden ? <CaretDownIcon size={12} weight="bold" /> : <CaretUpIcon size={12} weight="bold" />}
      </button>
    </div>
  );
}

/** Top right in video mode: what the room is waiting on, who's here, and the chat. */
export function PresencePill({
  view,
  vs,
  unread,
  onChat,
}: {
  view: RoomView;
  vs: VoiceState;
  unread: number;
  onChat: () => void;
}) {
  const seats = useSeats(view, vs).filter((s) => s.member.status === "online");
  const waiting = seats.find((s) => s.waiting);
  const shown = seats.slice(0, 3);
  return (
    <div className="glass pointer-events-auto flex h-11 items-center gap-2.5 rounded-full py-1 pr-1 pl-4">
      <span className={`text-[12px] font-medium whitespace-nowrap ${waiting ? "text-away" : "text-fog-300"}`}>
        {waiting ? `${waiting.me ? "You" : waiting.member.username} · catching up` : `${seats.length} here`}
      </span>
      <span className="flex -space-x-2">
        {shown.map((s) => {
          const ring = ringColour(s);
          return (
            <span key={s.member.user_id} className="rounded-full" style={{ boxShadow: `0 0 0 2px ${ring ?? "var(--color-ink-850)"}` }}>
              <Avatar name={s.member.username} size={28} self={s.me} />
            </span>
          );
        })}
      </span>
      <button
        onClick={onChat}
        aria-label={unread ? `Chat, ${unread} new` : "Chat"}
        className="press relative grid size-9 place-items-center rounded-full text-fog-100 hover:bg-white/10"
      >
        <ChatCircleIcon size={19} weight="fill" />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-plum-700 px-1 text-[10px] font-bold text-fog-50 tabular-nums">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
    </div>
  );
}
