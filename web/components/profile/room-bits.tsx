import { useState } from "react";
import { FilmReelIcon } from "@phosphor-icons/react";
import type { VisitedRoom } from "@/lib/api";
import { Avatar } from "@/components/ui/avatar";

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

export function ago(ms: number): string {
  const s = (ms - Date.now()) / 1000;
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31536000],
    ["month", 2592000],
    ["week", 604800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, size] of steps) if (Math.abs(s) >= size) return rtf.format(Math.round(s / size), unit);
  return "just now";
}

/** The card's title: the film if there is one, else whose room it is. */
export function roomTitle(r: VisitedRoom) {
  return r.film || (r.mine ? "Your room" : `${r.owner}’s room`);
}

const list = new Intl.ListFormat(undefined, { style: "long", type: "conjunction" });

/**
 * "Juno and Mika are here", "Juno, Mika and 3 more are here", "Nobody here". You don't
 * count: from the lobby you're not in it (a tab you just left lingers for a few seconds).
 */
export function Presence({ room, me, className = "" }: { room: VisitedRoom; me?: string; className?: string }) {
  const all = room.here ?? [];
  const names = all.filter((n) => n !== me);
  const online = room.online - (all.length - names.length);
  if (online <= 0) return <p className={`text-[14px] text-fog-500 ${className}`}>Nobody here &middot; {ago(room.last_joined_at)}</p>;
  const extra = online - names.length;
  const who = names.length ? list.format(extra > 0 ? [...names, `${extra} more`] : names) : `${online}`;
  const verb = online === 1 ? "is" : "are";
  return (
    <p className={`flex min-w-0 items-center gap-2 text-[14px] text-fog-300 ${className}`}>
      <span className="flex shrink-0 -space-x-1.5">
        {names.slice(0, 3).map((n) => (
          <Avatar key={n} name={n} size={24} ring />
        ))}
      </span>
      <span className="truncate">
        {names.length ? `${who} ${verb} here` : `${who} here now`}
      </span>
    </p>
  );
}

/** A room's film poster, or a quiet placeholder with the code. */
export function Poster({ room, className = "" }: { room: VisitedRoom; className?: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className={`relative block overflow-hidden bg-gradient-to-br from-plum-700/45 via-ink-700 to-ink-800 ${className}`}>
      {room.poster && !failed ? (
        <img src={room.poster} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} className="size-full object-cover" />
      ) : (
        <span className="grid size-full place-items-center">
          <FilmReelIcon size={26} weight="duotone" className="text-plum-200/60" />
        </span>
      )}
    </span>
  );
}

/** Wide variant for the profile: the poster blurred into a backdrop with the sharp one on it. */
export function Marquee({ room, className = "" }: { room: VisitedRoom; className?: string }) {
  const [failed, setFailed] = useState(false);
  const art = room.poster && !failed;
  return (
    <span className={`relative flex items-center justify-center overflow-hidden bg-gradient-to-br from-plum-700/45 via-ink-700 to-ink-800 ${className}`}>
      {art ? (
        <>
          <img src={room.poster} alt="" aria-hidden className="absolute inset-0 size-full scale-125 object-cover opacity-45 blur-2xl" />
          <img
            src={room.poster}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setFailed(true)}
            className="relative h-[82%] rounded-[12px] object-cover shadow-[0_12px_32px_rgb(0_0_0/0.5)]"
          />
        </>
      ) : (
        <FilmReelIcon size={32} weight="duotone" className="text-plum-200/60" />
      )}
    </span>
  );
}
